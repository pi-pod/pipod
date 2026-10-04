package com.pipod.app.core.session

import com.pipod.app.core.format.StatusTone
import java.text.NumberFormat
import java.util.Locale
import java.util.UUID
import kotlin.math.roundToLong
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * What pi has spent in a pod's current session: the totals its TUI footer
 * shows, read from pi's own `get_session_stats`.
 *
 * pi is the authority because it sums the whole session log, including history
 * compacted out of the conversation and abandoned branches. The transcript this
 * app holds is neither: replay is bounded and compaction removes messages, so
 * totals summed here would shrink as the session grew.
 */
data class SessionUsage(
    val inputTokens: Long,
    val outputTokens: Long,
    val cacheReadTokens: Long,
    val cacheWriteTokens: Long,
    /**
     * pi's estimate at the model's list price, in US dollars. A provider
     * subscription may cover it; pi's stats do not say whether one does.
     */
    val cost: Double,
    /** Null right after a compaction, until the next reply measures it again. */
    val contextTokens: Long? = null,
    val contextWindow: Long? = null,
    val contextPercent: Double? = null,
    val userMessages: Long = 0,
    val assistantMessages: Long = 0,
    val toolCalls: Long = 0,
) {
    val totalTokens: Long get() = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens

    /** Nothing has been spent yet, so there is nothing worth a line on screen. */
    val isEmpty: Boolean get() = totalTokens == 0L && cost <= 0.0

    /** The token half of the footer line: `↑12k ↓3.4k`, nonzero parts only. */
    val tokenSummary: String?
        get() = buildList {
            if (inputTokens > 0) add("↑${tokens(inputTokens)}")
            if (outputTokens > 0) add("↓${tokens(outputTokens)}")
        }.takeIf { it.isNotEmpty() }?.joinToString(" ")

    /** `$0.042`, with pi's three decimals, or null when nothing was priced. */
    val costSummary: String? get() = if (cost > 0) money(cost) else null

    /** `12.3%/200k`, or `?/200k` while pi cannot measure the context. */
    val contextSummary: String?
        get() {
            val window = contextWindow ?: return null
            val percent = contextPercent?.let { String.format(Locale.ROOT, "%.1f%%", it) } ?: "?"
            return "$percent/${tokens(window)}"
        }

    /**
     * How close the context is to full, with pi's own thresholds: past 70%
     * compaction is coming, past 90% it is imminent.
     */
    val contextTone: StatusTone?
        get() {
            val percent = contextPercent ?: return null
            return when {
                percent > 90 -> StatusTone.Danger
                percent > 70 -> StatusTone.Caution
                else -> null
            }
        }

    /** `12.3% of 200k tokens`, or why it is unknown. */
    val contextDetail: String?
        get() {
            val window = contextWindow ?: return null
            val percent = contextPercent ?: return "Unknown until pi’s next reply"
            return String.format(Locale.ROOT, "%.1f%% of ", percent) + "${tokens(window)} tokens"
        }

    val accessibilitySummary: String
        get() = buildList {
            add("${tokens(inputTokens)} input tokens")
            add("${tokens(outputTokens)} output tokens")
            costSummary?.let { add("estimated cost $it") }
            contextDetail?.let { add("context ${it.lowercase()}") }
        }.joinToString(", ", prefix = "Session usage: ")

    companion object {
        /** What the breakdown's numbers cover, and what the cost is not. */
        const val FOOTNOTE =
            "Totals for this pod’s current pi session, including history compacted out of the " +
                "conversation. Cost is pi’s estimate at the model’s list price; a provider " +
                "subscription may cover it."

        /**
         * Decodes the `data` of a successful `get_session_stats` response; null
         * when it carries no token totals.
         */
        fun fromStats(stats: JsonObject?): SessionUsage? {
            val tokens = stats?.get("tokens") as? JsonObject ?: return null
            val context = stats["contextUsage"] as? JsonObject
            return SessionUsage(
                inputTokens = tokens.integer("input") ?: 0,
                outputTokens = tokens.integer("output") ?: 0,
                cacheReadTokens = tokens.integer("cacheRead") ?: 0,
                cacheWriteTokens = tokens.integer("cacheWrite") ?: 0,
                cost = stats.number("cost") ?: 0.0,
                contextTokens = context?.integer("tokens"),
                contextWindow = context?.integer("contextWindow")?.takeIf { it > 0 },
                contextPercent = context?.number("percent"),
                userMessages = stats.integer("userMessages") ?: 0,
                assistantMessages = stats.integer("assistantMessages") ?: 0,
                toolCalls = stats.integer("toolCalls") ?: 0,
            )
        }

        /** pi's footer spelling: `950`, `1.2k`, `12k`, `1.2M`, `12M`. */
        fun tokens(count: Long): String = when {
            count < 1_000 -> "$count"
            count < 10_000 -> String.format(Locale.ROOT, "%.1fk", count / 1_000.0)
            count < 1_000_000 -> "${(count / 1_000.0).roundToLong()}k"
            count < 10_000_000 -> String.format(Locale.ROOT, "%.1fM", count / 1_000_000.0)
            else -> "${(count / 1_000_000.0).roundToLong()}M"
        }

        /** A count with grouping separators, for the breakdown where precision is the point. */
        fun exact(count: Long): String = NumberFormat.getIntegerInstance().format(count)

        fun money(dollars: Double): String = String.format(Locale.ROOT, "\$%.3f", dollars)
    }
}

/**
 * Keeps a session's [SessionUsage] current while its stream is attached.
 *
 * The stream says when totals may have moved — an attach, a finished reply, a
 * compaction — and this asks pi through the gateway's `rpc` passthrough.
 * Requests are coalesced: while one is unanswered, further refreshes collapse
 * into a single follow-up, so a replayed transcript full of finished replies
 * costs two requests rather than one per reply.
 *
 * Not thread-safe: the owning [SessionStream] calls it under its own lock.
 *
 * @param send sends one `rpc` frame; false when there is no connected transport.
 */
internal class SessionUsageTracker(private val send: (id: String, command: JsonObject) -> Boolean) {
    /**
     * The newest totals pi reported. Kept across disconnects: what was spent
     * does not change while the pod sleeps.
     */
    var latest: SessionUsage? = null
        private set

    private var inFlightId: String? = null
    private var refreshQueued = false

    /** Asks pi for fresh totals, or queues one more ask behind an unanswered one. */
    fun refresh() {
        if (inFlightId != null) {
            refreshQueued = true
            return
        }
        // pi retires every request id once answered, and the gateway shares one
        // pi among every attached client, so each ask needs an id of its own.
        val id = "app-usage-${UUID.randomUUID()}"
        if (!send(id, buildJsonObject { put("type", "get_session_stats") })) return
        inFlightId = id
        refreshQueued = false
    }

    /** A new transport answers only its own requests: forget what the old one owed and ask afresh. */
    fun attached() {
        inFlightId = null
        refreshQueued = false
        refresh()
    }

    /** Takes an `rpc_result`. False when it answers some other request. */
    fun accept(id: String, response: JsonObject?): Boolean {
        if (id != inFlightId) return false
        inFlightId = null
        // A failed ask keeps the last totals; the next boundary asks again.
        val succeeded = (response?.get("success") as? JsonPrimitive)?.booleanOrNull == true
        if (succeeded) SessionUsage.fromStats(response?.get("data") as? JsonObject)?.let { latest = it }
        if (refreshQueued) refresh()
        return true
    }
}

private fun JsonObject.number(key: String): Double? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
