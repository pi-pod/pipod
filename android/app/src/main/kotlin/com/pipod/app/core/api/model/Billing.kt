package com.pipod.app.core.api.model

import com.pipod.app.core.format.FriendlyError
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * The account summary the SaaS backend sends and the self-hosted static backend
 * does not send at all.
 *
 * Source: `GET /v1/me`, optional top-level key `workstation` (flat block from
 * `workstationSummary()` in the hosted edition's billing routes).
 * Absent under the static backend. The same parser also reads the key on the
 * `GET /v1/pods` envelope for forward-compat, though the server does not send
 * it there today.
 *
 * **This is the edition boundary.** Absence is the normal case on self-hosted:
 * the whole surface hides silently — no placeholder, no "unknown", no zeroes,
 * no empty section header, no error — when nothing renderable arrived. Every
 * field is independently optional, so a partial object renders its parts and
 * omits the rest.
 *
 * Nothing here computes a projection or a price. Only numbers the server sent
 * are shown (cents are divided by 100 for display, which is formatting, not a
 * projection).
 */
data class BillingSummary(
    val planKey: String? = null,
    val planName: String? = null,
    val status: BillingStatus? = null,
    val activeHoursUsed: Double? = null,
    val includedActiveHours: Double? = null,
    val overageHours: Double? = null,
    val overageUsdCentsPerHour: Double? = null,
    val spendCapUsdCents: Double? = null,
    val projectedSpendUsdCents: Double? = null,
    val uncappedSpendUsdCents: Double? = null,
    val spendCapState: BillingSpendCapState? = null,
    val startsBlocked: Boolean? = null,
    val startBlockedReason: StartBlockedReason? = null,
    val parallelSandboxes: Long? = null,
    val workspaceStorageGb: Long? = null,
    val currentPeriodEnd: Instant? = null,
    val trialEndsAt: Instant? = null,
    val billableActiveSeconds: Double? = null,
    val unknownActiveSeconds: Double? = null,
) {

    /** The plan's own words, never a tier this client decided on. */
    val planLabel: String? get() = planName ?: planKey

    /**
     * The one summary line, split into the segments a row joins with "·".
     * Empty when nothing renderable arrived, which reads exactly like absence.
     *
     * Real fields only: planName · used/included hours · cap $ · period ends;
     * trial note from status/trialEndsAt when trialing.
     */
    fun segments(
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): List<String> = buildList {
        planLabel?.let { add(it) }
        activeHoursLabel?.let { add(it) }
        overageLabel?.let { add(it) }
        unknownHoursLabel?.let { add(it) }
        spendCapLabel?.let { add(it) }
        currentPeriodEnd?.let { add("period ends ${BillingNumbers.date(it, zone, locale)}") }
        trialNote(zone, locale)?.let { add(it) }
    }

    /**
     * The warning the account surfaces carry above the summary line, or null
     * when there is nothing to warn about.
     *
     * The server already decided this — `startsBlocked`, `startBlockedReason`,
     * `spendCapState` and `status` are its answer to "may this account start a
     * machine" — and the client's only job is to say so *before* a launch is
     * refused rather than after. The five blocked sentences are the same
     * constants the 402 refusal uses, so the warning and the refusal cannot
     * drift apart. No price, plan or deadline appears here that the server did
     * not send.
     */
    val alert: BillingAlert?
        get() {
            startBlockedReason?.let { return BillingAlert(blockedSentence(it), BillingAlertTone.Blocked) }
            if (startsBlocked == true) {
                return BillingAlert(STARTS_BLOCKED_MESSAGE, BillingAlertTone.Blocked)
            }
            // `reached` without `startsBlocked` is a deployment that meters the
            // cap without enforcing it; it is still the thing to say first.
            if (spendCapState == BillingSpendCapState.Reached) {
                return BillingAlert(
                    FriendlyError.SPEND_CAP_REACHED_MESSAGE,
                    BillingAlertTone.Blocked,
                )
            }
            if (status == BillingStatus.PastDue) {
                return BillingAlert(PAST_DUE_MESSAGE, BillingAlertTone.Warning)
            }
            if (status == BillingStatus.Canceled) {
                return BillingAlert(CANCELED_MESSAGE, BillingAlertTone.Warning)
            }
            if (spendCapState == BillingSpendCapState.Warning) {
                return BillingAlert(spendCapWarning(), BillingAlertTone.Warning)
            }
            return null
        }

    private fun blockedSentence(reason: StartBlockedReason): String = when (reason) {
        StartBlockedReason.SubscriptionRequired -> FriendlyError.SUBSCRIPTION_REQUIRED_MESSAGE
        StartBlockedReason.TrialExpired -> FriendlyError.TRIAL_EXPIRED_MESSAGE
        StartBlockedReason.TrialHoursExhausted -> FriendlyError.TRIAL_HOURS_EXHAUSTED_MESSAGE
        StartBlockedReason.PaymentPastDue -> FriendlyError.PAYMENT_PAST_DUE_MESSAGE
        StartBlockedReason.SpendCapReached -> FriendlyError.SPEND_CAP_REACHED_MESSAGE
    }

    /** The cap is named only when the server sent the number. */
    private fun spendCapWarning(): String {
        val limit = spendCapUsdCents?.let { BillingNumbers.moneyCents(it) }
        return if (limit == null) {
            "You\u2019re close to your monthly spend cap. New pods stop starting when it is reached."
        } else {
            "You\u2019re close to your $limit monthly spend cap. " +
                "New pods stop starting when it is reached."
        }
    }

    private val activeHoursLabel: String?
        get() {
            val confirmed = billableActiveSeconds?.div(3600.0) ?: activeHoursUsed
            val phrase =
                if (billableActiveSeconds != null) "confirmed hours this period" else "active hours this period"
            return when {
                confirmed != null && includedActiveHours != null ->
                    "${BillingNumbers.hours(confirmed)} of " +
                        "${BillingNumbers.hours(includedActiveHours)} $phrase"
                confirmed != null && billableActiveSeconds != null ->
                    "${BillingNumbers.hours(confirmed)} confirmed hours this period"
                confirmed != null ->
                    "${BillingNumbers.hours(confirmed)} active hours this period"
                includedActiveHours != null ->
                    "${BillingNumbers.hours(includedActiveHours)} active hours included"
                else -> null
            }
        }

    private val unknownHoursLabel: String?
        get() {
            val seconds = unknownActiveSeconds ?: return null
            if (seconds <= 0) return null
            return "unconfirmed ${BillingNumbers.hours(seconds / 3600.0)} h"
        }

    /**
     * Hours past the included allowance, which are the ones that cost money.
     * Shown only when the server says there are some.
     */
    private val overageLabel: String?
        get() {
            val hours = overageHours?.takeIf { it > 0 } ?: return null
            val rate = overageUsdCentsPerHour?.takeIf { it > 0 }
            val label = "${BillingNumbers.hours(hours)} overage hours"
            return if (rate == null) label else "$label at ${BillingNumbers.moneyCents(rate)}/hour"
        }

    private val spendCapLabel: String?
        get() {
            val limit = spendCapUsdCents?.let { BillingNumbers.moneyCents(it) }
            val spent = projectedSpendUsdCents?.let { BillingNumbers.moneyCents(it) }
            return when {
                limit != null && spent != null -> "spend cap $limit (used $spent)"
                limit != null -> "spend cap $limit"
                spent != null -> "$spent spent this period"
                else -> null
            }
        }

    private fun trialNote(zone: ZoneId, locale: Locale): String? {
        if (status != BillingStatus.Trialing) return null
        val ends = trialEndsAt
        return if (ends != null) {
            "trial ends ${BillingNumbers.date(ends, zone, locale)}"
        } else {
            "trial active"
        }
    }

    /**
     * True when this object carries nothing a row could draw.
     *
     * A summary whose only readable content is a refusal state is *not* empty:
     * "starts are blocked" is the most important thing the account surface can
     * say, and dropping it here is what left it unrenderable.
     */
    val isEmpty: Boolean get() = segments().isEmpty() && alert == null

    companion object {
        /**
         * Reads the optional top-level `workstation` key. The same object
         * arrives on `GET /v1/me` today and may arrive on the `GET /v1/pods`
         * envelope later; both go through here so the two can never drift.
         */
        fun parse(envelope: JsonElement?): BillingSummary? {
            val record = (envelope as? JsonObject)?.get("workstation") as? JsonObject ?: return null
            return fromObject(record)
        }

        fun fromObject(record: JsonObject?): BillingSummary? {
            if (record == null) return null
            val summary = BillingSummary(
                planKey = record.boundedString("planKey"),
                planName = record.boundedString("planName"),
                status = BillingStatus.fromWire(record.string("status")),
                activeHoursUsed = record.amount("activeHoursUsed"),
                includedActiveHours = record.amount("includedActiveHours"),
                overageHours = record.amount("overageHours"),
                overageUsdCentsPerHour = record.amount("overageUsdCentsPerHour"),
                spendCapUsdCents = record.amount("spendCapUsdCents"),
                projectedSpendUsdCents = record.amount("projectedSpendUsdCents"),
                uncappedSpendUsdCents = record.amount("uncappedSpendUsdCents"),
                spendCapState = BillingSpendCapState.fromWire(record.string("spendCapState")),
                startsBlocked = (record["startsBlocked"] as? JsonPrimitive)?.booleanOrNull,
                startBlockedReason = StartBlockedReason.fromWire(record.string("startBlockedReason")),
                parallelSandboxes = record.count("parallelSandboxes"),
                workspaceStorageGb = record.count("workspaceStorageGb"),
                currentPeriodEnd = record.timestamp("currentPeriodEnd"),
                trialEndsAt = record.timestamp("trialEndsAt"),
                billableActiveSeconds = record.amount("billableActiveSeconds"),
                unknownActiveSeconds = record.amount("unknownActiveSeconds"),
            )
            // A `workstation` object with nothing renderable is treated exactly
            // like an absent one, so the row never appears empty.
            return if (summary.isEmpty) null else summary
        }
    }
}

/** How loudly an account warning has to be drawn. */
enum class BillingAlertTone {
    /** Something to fix soon; machines still start. */
    Warning,

    /** New machines will be refused until it is fixed. */
    Blocked,
}

/** One account warning, ready to render. */
data class BillingAlert(val message: String, val tone: BillingAlertTone)

/** The generic refusal, for a server that blocked starts without naming a reason. */
private const val STARTS_BLOCKED_MESSAGE =
    "New pods can\u2019t start on this account right now. Your files are retained."

private const val PAST_DUE_MESSAGE =
    "Your last payment failed. Update your payment method to keep starting pods."

private const val CANCELED_MESSAGE =
    "Your subscription is canceled. Subscribe again to start new pods."

/** `billing_accounts.status` mirror. Unknown values read as absent. */
enum class BillingStatus(val wire: String) {
    None("none"),
    Trialing("trialing"),
    Active("active"),
    PastDue("past_due"),
    Canceled("canceled"),
    ;

    companion object {
        fun fromWire(value: String?): BillingStatus? = entries.firstOrNull { it.wire == value }
    }
}

/** `spendCapState` from `workstationSummary()`. Unknown values are ignored. */
enum class BillingSpendCapState(val wire: String) {
    Ok("ok"),
    Warning("warning"),
    Reached("reached"),
    ;

    companion object {
        fun fromWire(value: String?): BillingSpendCapState? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * Why new machine starts are refused. Mirrors `StartBlockedReason` in
 * the hosted edition's billing entitlements; they are contract.
 */
enum class StartBlockedReason(val wire: String) {
    SubscriptionRequired("subscription_required"),
    TrialExpired("trial_expired"),
    TrialHoursExhausted("trial_hours_exhausted"),
    PaymentPastDue("payment_past_due"),
    SpendCapReached("spend_cap_reached"),
    ;

    companion object {
        fun fromWire(value: String?): StartBlockedReason? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * How a validated number becomes text. Nothing here derives a value: an amount
 * is printed exactly as it arrived, at the precision it arrived with. Cents are
 * divided by 100 for display, which is formatting, not a projection.
 */
internal object BillingNumbers {

    /** "12.4", "60" — the trailing ".0" of a whole number is noise. */
    fun hours(value: Double): String = trimmed(value)

    /** "$50", "$3.20" — cents appear only when the amount has them. */
    fun money(value: Double): String {
        if (value == Math.floor(value) && !value.isInfinite()) {
            return "$" + String.format(Locale.ROOT, "%.0f", value)
        }
        return "$" + String.format(Locale.ROOT, "%.2f", value)
    }

    /** Minor units to display: 5000 → "$50", 320 → "$3.20". */
    fun moneyCents(cents: Double): String = money(cents / 100.0)

    fun date(value: Instant, zone: ZoneId, locale: Locale): String =
        DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
            .withLocale(locale)
            .format(value.atZone(zone))

    private fun trimmed(value: Double): String {
        if (value == Math.floor(value)) return String.format(Locale.ROOT, "%.0f", value)
        return String.format(Locale.ROOT, "%.2f", value).trimEnd('0').trimEnd('.')
    }
}

/** A bounded id or name, rendered as data. Control characters never reach a screen. */
private fun JsonObject.boundedString(key: String): String? {
    val raw = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val clean = raw.filter { it.code >= 0x20 && it.code != 0x7f }.trim()
    if (clean.isEmpty() || clean.length > 64) return null
    return clean
}

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A non-negative finite number. NaN, infinity and negatives read as absent. */
private fun JsonObject.amount(key: String): Double? {
    val raw = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull ?: return null
    if (!raw.isFinite() || raw < 0.0) return null
    return raw
}

/** A non-negative integer count. Fractions, negatives and non-finite read as absent. */
private fun JsonObject.count(key: String): Long? {
    val raw = (this[key] as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
    val asLong = raw.longOrNull
    if (asLong != null) return if (asLong < 0) null else asLong
    val asDouble = raw.doubleOrNull ?: return null
    if (!asDouble.isFinite() || asDouble < 0.0) return null
    if (asDouble != Math.floor(asDouble)) return null
    if (asDouble > Long.MAX_VALUE.toDouble()) return null
    return asDouble.toLong()
}

private fun JsonObject.timestamp(key: String): Instant? {
    val raw = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    if (raw.length > 40) return null
    val normalized = raw.replace(' ', 'T')
    return runCatching { Instant.parse(normalized) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(normalized).toInstant() }.getOrNull()
}
