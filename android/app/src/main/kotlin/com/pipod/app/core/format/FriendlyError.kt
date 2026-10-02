package com.pipod.app.core.format

import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.BillingNumbers
import com.pipod.app.core.api.model.WorkstationDemand
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URI
import java.net.UnknownHostException
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.util.Locale
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeoutException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * One place that turns transport and server errors into copy a person can act
 * on, so raw socket text and HTTP status strings never reach a screen.
 *
 * Port of `pi-pod-flutter/lib/core/format/friendly_error.dart`.
 */
object FriendlyError {

    const val FALLBACK_MESSAGE =
        "Something went wrong talking to the server. Check your connection and try again."

    /**
     * A failure the server owns: telling the person to check their connection
     * would send them after the wrong problem.
     */
    const val SERVER_FALLBACK_MESSAGE = "Something went wrong on the server. Try again in a moment."

    const val FLEET_PRESSURE_MESSAGE =
        "The fleet is at capacity and has no room for a new sandbox right now. " +
            "Retry shortly — stopped pods keep their files and archived pods restore later, " +
            "so do not create duplicates. If this persists, ask an owner to register capacity."

    const val UNSUPPORTED_SHAPE_MESSAGE =
        "That sandbox shape is not available on a qualified host " +
            "(8 GiB is gated opt-in; standard is 4 GiB). " +
            "The request was not silently clamped — retry at the standard shape (4 GiB) " +
            "or wait for qualified capacity."

    const val TEMPORARILY_UNAVAILABLE_MESSAGE =
        "The pod is mid-transition (starting, stopping, or restoring). " +
            "Retry shortly without creating a duplicate pod."

    const val FAIRNESS_DEGRADED_MESSAGE =
        "CPU fairness is temporarily degraded. Existing sandboxes keep " +
            "running — retry shortly without creating duplicates."

    const val PRODUCT_CONCURRENCY_POLICY = 20

    /**
     * Billing refusals: the five real HTTP 402 `StartBlockedReason` values from
     * the hosted edition's billing entitlements.
     *
     * These are **not** retryable waits: nothing here polls, enters the
     * workstation wait, or suggests retrying in a loop. Each sentence says what
     * happened, what it costs and what to do — and names no price, plan tier,
     * URL or policy the server did not send. Numbers come only from the
     * allowlisted 402 detail fields (`activeHoursUsed`, `includedActiveHours`,
     * `spendCapUsdCents`, `projectedSpendUsdCents`, `currentPeriodEnd`), so the
     * copy still reads correctly when the server sends none of them.
     *
     * The base copy is anchored on the server's own `error` sentence
     * (`startBlockedMessage()`), which is static per reason on the server.
     * Every message ends with files-retained copy: a blocked start never loses
     * work.
     */
    const val SUBSCRIPTION_REQUIRED_MESSAGE =
        "Your workstation needs an active subscription before it can start. " +
            "Your files are retained."

    const val TRIAL_EXPIRED_MESSAGE =
        "Your trial has ended; subscribe to start your workstation again. " +
            "Your files are retained."

    const val TRIAL_HOURS_EXHAUSTED_MESSAGE =
        "Your trial hours are used up; subscribe to continue. " +
            "Your files are retained."

    const val PAYMENT_PAST_DUE_MESSAGE =
        "Your last payment failed and the grace period has ended; update your " +
            "payment method to start again. Your files are retained."

    const val SPEND_CAP_REACHED_MESSAGE =
        "Your monthly spend cap is reached; raise it to start your workstation again. " +
            "Your files are retained."

    fun message(error: Any, serverHost: String? = null): String = when (error) {
        is ApiError -> apiMessage(error)
        is String -> serverText(error)
        else -> transportOrFallback(error, serverHost)
    }

    private fun apiMessage(error: ApiError): String {
        if (error.error == "not signed in") return "You’re signed out. Sign in again to continue."

        credentialMessage(error)?.let { return it }
        // A personal workstation is a whole VM, not a fleet slot: it must reach
        // the workstation copy before anything can read it as fleet pressure.
        workstationMessage(error)?.let { return it }
        billingRefusalMessage(error)?.let { return it }
        typedCapacityMessage(error)?.let { return it }

        // A bare HTTP 5xx without a typed reason or a known fleet sentence is not
        // fleet pressure (database, auth, and upstream trouble all share the code).
        if (error.error.startsWith("HTTP 5")) {
            return "The server ran into a problem (${error.error}). Try again in a moment."
        }

        capacitySentence(error.error, error.detailText)?.let { return it }
        FriendlyText.knownServerFailure(error.error)?.let { return it }

        val detail = error.detailText
        val friendlyDetail = detail?.takeIf { FriendlyText.readsAsProse(it) }
        return if (FriendlyText.readsAsProse(error.error)) {
            FriendlyText.failure(error.error, friendlyDetail)
        } else {
            SERVER_FALLBACK_MESSAGE
        }
    }

    /**
     * The typed host-demand 503 for the caller's own workstation.
     *
     * Every REST call that needs the workstation can answer this, so it is
     * mapped here rather than at each call site: a screen that only shows
     * `FriendlyError.message` still gets honest copy instead of the raw server
     * sentence, and never the fleet-capacity hint.
     */
    fun workstationMessage(error: Throwable): String? {
        val demand = WorkstationDemand.fromThrowable(error) ?: return null
        return WorkstationCopy.message(demand)
    }

    /**
     * A billing 402 refusal. Only the allowlisted 402 detail fields are read;
     * anything else in the detail is ignored. The `error` sentence is the
     * server's own `startBlockedMessage()` and is used as the base copy when
     * it reads as prose; otherwise the per-reason fallback carries the same
     * claim.
     */
    fun billingRefusalMessage(
        error: ApiError,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String? {
        val detail = error.detail as? JsonObject
        val reason = (detail?.get("reason") as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: error.detailCode
            ?: error.error
        val fallback = when (reason) {
            "subscription_required" -> SUBSCRIPTION_REQUIRED_MESSAGE
            "trial_expired" -> TRIAL_EXPIRED_MESSAGE
            "trial_hours_exhausted" -> TRIAL_HOURS_EXHAUSTED_MESSAGE
            "payment_past_due" -> PAYMENT_PAST_DUE_MESSAGE
            "spend_cap_reached" -> SPEND_CAP_REACHED_MESSAGE
            else -> return null
        }
        // Anchor on the server's own sentence when it is actually the sentence
        // for this reason (it carries dynamic numbers like the trial grant or
        // the cap dollars). A foreign sentence — e.g. a workstation anchor in
        // a test envelope carrying a billing reason — must not become billing
        // copy, so it falls back to the per-reason constant.
        val keyword = when (reason) {
            "subscription_required" -> "subscription"
            "trial_expired" -> "trial"
            "trial_hours_exhausted" -> "trial"
            "payment_past_due" -> "payment"
            else -> "spend cap"
        }
        val base = if (FriendlyText.readsAsProse(error.error) &&
            error.error.contains(keyword, ignoreCase = true)
        ) {
            val server = error.error.trim().replaceFirstChar { it.uppercaseChar() }
            val withPeriod = if (server.endsWith(".")) server else "$server."
            if (withPeriod.contains("files are retained", ignoreCase = true)) withPeriod
            else "$withPeriod Your files are retained."
        } else {
            fallback
        }
        val facts = buildList {
            billingHoursFact(detail)?.let { add(it) }
            billingCapFact(detail)?.let { add(it) }
            detail.instantField("currentPeriodEnd")?.let {
                add("The period resets on ${BillingNumbers.date(it, zone, locale)}.")
            }
        }
        return (listOf(base) + facts).joinToString(" ")
    }

    private fun billingHoursFact(detail: JsonObject?): String? {
        val used = detail.amount("activeHoursUsed")
        val included = detail.amount("includedActiveHours")
        return when {
            used != null && included != null ->
                "${BillingNumbers.hours(used)} of ${BillingNumbers.hours(included)} active hours used this period."
            used != null -> "${BillingNumbers.hours(used)} active hours used this period."
            included != null -> "${BillingNumbers.hours(included)} active hours included."
            else -> null
        }
    }

    private fun billingCapFact(detail: JsonObject?): String? {
        val limit = detail.amount("spendCapUsdCents")?.let { BillingNumbers.moneyCents(it) }
        val spent = detail.amount("projectedSpendUsdCents")?.let { BillingNumbers.moneyCents(it) }
        return when {
            limit != null && spent != null -> "Cap $limit, $spent used."
            limit != null -> "Cap $limit."
            spent != null -> "$spent used."
            else -> null
        }
    }

    private fun typedCapacityMessage(error: ApiError): String? {
        val detailMap = error.detail as? JsonObject
        val reason = (detailMap?.get("reason") as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: error.detailString("reason")
            ?: return null
        return when (reason) {
            // Capacity contract §1–2: every fleet-side pressure reason maps to the
            // fleet copy, except degraded fairness which names itself so a retry
            // pause reads as temporary rather than broken. Allowlisted amounts
            // (required / available / budget) are appended when present; the
            // unbounded `error` sentence is never copied.
            "disk_capacity",
            "memory_capacity",
            "transition_capacity",
            "cpu_capacity",
            "network_capacity",
            "memory_debt",
            "fleet_capacity",
            -> fleetPressureWithAmounts(detailMap)

            "fairness_degraded" -> FAIRNESS_DEGRADED_MESSAGE
            "unsupported_shape" -> UNSUPPORTED_SHAPE_MESSAGE
            else -> null
        }
    }

    private fun fleetPressureWithAmounts(detail: JsonObject?): String {
        val clause = capacityAmountsClause(detail) ?: return FLEET_PRESSURE_MESSAGE
        return "$FLEET_PRESSURE_MESSAGE $clause"
    }

    /**
     * Validated 507 admission numbers only. Bytes become GiB via 1024³; unknown
     * units and missing amounts produce no clause, so the fleet sentence stands.
     */
    private fun capacityAmountsClause(detail: JsonObject?): String? {
        val unit = (detail?.get("unit") as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: return null
        val required = detail.amount("required")
        val available = detail.amount("available")
        val budget = detail.amount("budget")
        if (required == null && available == null && budget == null) return null

        fun labeled(value: Double, label: String): String? {
            val formatted = formatCapacityAmount(value, unit) ?: return null
            return "$formatted $label"
        }

        val requiredText = required?.let { labeled(it, "required") }
        val availableText = available?.let { labeled(it, "available") }
        val budgetText = budget?.let { labeled(it, "budget") }
        if (requiredText == null && availableText == null && budgetText == null) return null

        val clause = buildList {
            if (requiredText != null) add(requiredText)
            when {
                availableText != null && budgetText != null ->
                    add("$availableText of $budgetText")
                availableText != null -> add(availableText)
                budgetText != null -> add(budgetText)
            }
        }.joinToString(", ")
        return "$clause."
    }

    private fun formatCapacityAmount(value: Double, unit: String): String? {
        val scaled = when (unit) {
            "bytes" -> value / GIB_BYTES
            "gb", "cores" -> value
            else -> return null
        }
        val number = String.format(Locale.ROOT, "%.2f", scaled)
        val suffix = when (unit) {
            "bytes" -> "GiB"
            "gb" -> "GB"
            "cores" -> "cores"
            else -> return null
        }
        return "$number $suffix"
    }

    internal fun capacitySentence(error: String, detail: String? = null): String? {
        val text = if (detail.isNullOrEmpty()) error else "$error $detail"
        val lower = text.lowercase()

        // 1. Per-user limit: 'caps concurrent pods per user at N'
        USER_CAP.find(text)?.let { match ->
            val cap = match.groupValues[1]
            return "You are at the concurrent pod limit of $cap. " +
                "Product policy allows up to $PRODUCT_CONCURRENCY_POLICY concurrent pods per user, " +
                "with the server limit authoritative. " +
                "Stop a running pod or wait for idle sleep under your idle policy, then retry."
        }

        // 2. Org limit: 'org policy caps concurrent pods at N'
        ORG_CAP.find(text)?.let { match ->
            val cap = match.groupValues[1]
            return "Your organization is at its concurrent pod limit ($cap). " +
                "Stop a running pod or wait for idle sleep under your idle policy, then retry — " +
                "or ask an owner to raise the org policy."
        }
        if (lower.contains("org policy caps concurrent pods")) {
            return "Your organization is at its concurrent pod limit. " +
                "Stop a running pod or wait for idle sleep under your idle policy, then retry — " +
                "or ask an owner to raise the org policy."
        }

        // 3. Restore required: 'restore the pod'
        if (lower.contains("restore the pod")) {
            return "This pod is archived. Restore it from the pod screen to continue."
        }

        // 4. Fleet pressure.
        if (lower.contains("fleet is at capacity") ||
            NO_SANDBOX_HOST.containsMatchIn(text) ||
            lower.contains("every active sandbox host refused")
        ) {
            return FLEET_PRESSURE_MESSAGE
        }

        // 5. Mid-transition.
        if (lower.contains("pod is temporarily unavailable")) return TEMPORARILY_UNAVAILABLE_MESSAGE

        // A genuine shape refusal names itself unsupported. A "supports at most …
        // — using …" message is the opposite — a clamp the server applied — and
        // must never map to the not-clamped refusal.
        if (lower.contains("unsupported") && SHAPE_WORDS.containsMatchIn(text)) {
            return UNSUPPORTED_SHAPE_MESSAGE
        }

        return null
    }

    private fun credentialMessage(error: ApiError): String? {
        val code = error.detailCode ?: error.error
        val provider = error.detailString("provider") ?: "model provider"
        return when (code) {
            "credential_reconnect_required" -> reconnectMessage(error, provider)
            "credential_temporarily_unavailable" ->
                "The $provider sign-in is temporarily unavailable. Retry shortly."

            "credential_provider_unsupported" ->
                "This provider can't be connected from the app. " +
                    "Store an API key as a user secret if it has one."

            "client_upgrade_required" -> "This app is too old for the server. Update pi pod."
            else -> null
        }
    }

    private fun reconnectMessage(error: ApiError, provider: String): String {
        val detail = error.detailString("message")?.trim()
        if (!detail.isNullOrEmpty() && !detail.lowercase().contains("/login")) return detail
        return "Reconnect $provider in Settings, then retry."
    }

    private fun serverText(error: String): String {
        // A bare 5xx string names no cause; claiming fleet pressure would misdirect.
        if (error.startsWith("HTTP 5")) return SERVER_FALLBACK_MESSAGE
        FriendlyText.knownServerFailure(error)?.let { return it }
        return if (FriendlyText.readsAsProse(error)) FriendlyText.failure(error) else SERVER_FALLBACK_MESSAGE
    }

    /**
     * Port of the Foundation `URLError` cases. An unknown thrown value uses the
     * terminal fallback rather than exposing its implementation text.
     */
    private fun transportOrFallback(error: Any, serverHost: String?): String {
        val kind = NetworkFailure.tryParse(error) ?: return FALLBACK_MESSAGE
        val parsedHost = serverHost?.let { runCatching { URI(it).host }.getOrNull() }
        val destination = if (parsedHost.isNullOrEmpty()) {
            "the pi pod server"
        } else {
            "the pi pod server at $parsedHost"
        }
        return when (kind) {
            NetworkFailure.Offline -> "You appear to be offline. Check your connection and try again."
            NetworkFailure.TimedOut -> "The server took too long to respond. Try again."
            NetworkFailure.CannotReachHost -> "Couldn’t reach $destination. Try again in a moment."
            NetworkFailure.Cancelled -> "The request was cancelled."
            NetworkFailure.Other -> "A network problem kept that from finishing. Try again."
        }
    }

    private const val GIB_BYTES = 1024.0 * 1024.0 * 1024.0

    /** A non-negative finite number, or absent. Never NaN, infinity or a negative. */
    private fun JsonObject?.amount(key: String): Double? {
        val raw = (this?.get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            ?: return null
        if (!raw.isFinite() || raw < 0.0) return null
        return raw
    }

    private fun JsonObject?.instantField(key: String): Instant? {
        val raw = (this?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        if (raw.length > 40) return null
        val normalized = raw.replace(' ', 'T')
        return runCatching { Instant.parse(normalized) }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(normalized).toInstant() }.getOrNull()
    }

    private val USER_CAP = Regex("caps concurrent pods per user at (\\d+)", RegexOption.IGNORE_CASE)
    private val ORG_CAP = Regex("org policy caps concurrent pods at (\\d+)", RegexOption.IGNORE_CASE)
    private val NO_SANDBOX_HOST =
        Regex("no sandbox host .*room for a sandbox", RegexOption.IGNORE_CASE)
    private val SHAPE_WORDS = Regex("shape|memory|disk|cpu|8\\s*gi?b", RegexOption.IGNORE_CASE)
}

/**
 * Server and provider messages are written for whoever runs the control plane:
 * they name permission slugs, vendor dashboards and internal identifiers. This
 * turns them into sentences the person holding the phone can act on.
 */
object FriendlyText {

    /**
     * Our server answers anticipated failures with a sentence written for the
     * person holding the phone, and those are worth showing. What must never
     * reach a screen is machine output that escaped: a runtime exception from
     * the server process, or a validator's field path.
     */
    fun readsAsProse(error: String): Boolean {
        val text = error.trim()
        if (text.isEmpty() || text.length > 240) return false
        if (text.contains('\n')) return false
        val lower = text.lowercase()
        if (LEAKS.any { lower.contains(it) }) return false
        // Zod reports `body/templateId Expected string, received null`.
        if (VALIDATOR_PATH.containsMatchIn(text)) return false
        return true
    }

    fun knownServerFailure(error: String): String? {
        FriendlyError.capacitySentence(error)?.let { return it }
        missingPermission(error)?.let { return it }
        liveChildPods(error)?.let { return it }
        unavailableImage(error)?.let { return it }
        abandonedProvisioning(error)?.let { return it }
        if (isSignInFailure(error)) return "Sign-in couldn’t be completed. Try signing in again."

        MISSING_CREDENTIAL.find(error.trim())?.let { match ->
            val provider = match.groupValues[1]
            // There is a single sandbox backend, so its missing credential reads
            // without a vendor name. Anything else is a retired provider name
            // surviving in an old row — still actionable, never raw.
            if (provider.lowercase() == "sandbox") {
                return "This organization doesn’t have a sandbox credential. " +
                    "Ask an owner to add it in Settings, then try again."
            }
            val displayName = if (provider.lowercase() == "boat") "Boat" else provider
            return "This organization doesn’t have a $displayName sandbox credential. " +
                "Ask an owner to add it in Settings, then try again."
        }
        return null
    }

    /**
     * A delete refused because the pod still hosts others.
     *
     * The server's sentence names a query parameter (`pass ?cascade=true`),
     * which is an instruction to a program, not to a reader. The screen turns
     * this into a cascade confirmation; this sentence is the fallback for
     * anywhere that only has room for a line of text.
     */
    fun liveChildPods(error: String): String? {
        val match = LIVE_CHILD_PODS.find(error) ?: return null
        val count = match.groupValues[1].toIntOrNull()
        val subject = when (count) {
            null -> "other pods"
            1 -> "1 other pod"
            else -> "$count other pods"
        }
        return "This pod is hosting $subject. Delete those together with it, " +
            "or delete them first."
    }

    /** `requires pods:launch` and friends — the slug means nothing to the person refused. */
    fun missingPermission(error: String): String? {
        if (!error.startsWith("requires ")) return null
        val action = when (error.removePrefix("requires ").trim()) {
            "pods:launch" -> "launch pods"
            "pods:manage_any" -> "manage other people’s pods"
            "templates:write" -> "create or change environments"
            "secrets:org:write" -> "change organization secrets"
            "secrets:own:write", "settings:own:write" -> "change your saved settings"
            "policy:write", "org:manage", "members:manage" -> "administer this organization"
            "audit:read" -> "read the audit log"
            else -> return null
        }
        return "Your account isn’t allowed to $action in this organization. Ask an owner for access."
    }

    fun isSignInFailure(error: String): Boolean {
        val lower = error.lowercase()
        return lower.contains("code exchange") || lower.contains("authorization code")
    }

    /**
     * The server reaps a launch whose provisioning process died before it
     * recorded a sandbox. Its sentence names the internal owner heartbeat, which
     * describes pi pod's bookkeeping rather than anything the reader can act on.
     */
    fun abandonedProvisioning(error: String): String? {
        if (!error.lowercase().contains("provisioning stopped before the sandbox")) return null
        return "This pod stopped while it was starting up and never got a sandbox. Launch it again."
    }

    /**
     * The launch preflight for an image the provider does not have. The server
     * answers this one with control-plane advice — pin a different image — and
     * neither the image ref nor the provider it is missing from means anything
     * to the person holding the phone.
     */
    fun unavailableImage(error: String): String? {
        val lower = error.lowercase()
        if (lower.contains("cannot build managed image")) {
            return "Your sandbox host can’t build pi pod’s runtime image, so the pod can’t " +
                "start. Ask an owner to check the runtime image configuration."
        }
        if (!lower.startsWith("image \"") || !lower.contains("not found in the")) return null
        return "The container image this environment pins doesn’t exist on your sandbox provider, " +
            "so the pod can’t start. Remove the image pin from the environment or organization " +
            "settings and try again."
    }

    /**
     * The failure, then the fix — each stripped of operator instructions. The
     * pair gets a longer budget than a lone message: cutting the remedy is
     * better than losing the failure.
     */
    fun failure(error: String, detail: String? = null): String {
        val failure = withoutOperatorInstructions(error)
        val advice = withoutOperatorInstructions(detail ?: "")
        if (failure.isEmpty()) return advice.ifEmpty { FriendlyError.SERVER_FALLBACK_MESSAGE }
        if (advice.isEmpty() || failure.lowercase().contains(advice.lowercase())) return failure
        val joined = if (failure.endsWith(".")) "$failure $advice" else "$failure — $advice"
        return truncated(joined, 280)
    }

    /**
     * Provider failures append a support URL and dashboard directions the user
     * cannot follow from a phone, and reading them as part of the failure makes
     * a recoverable state look like a broken account.
     */
    fun withoutOperatorInstructions(raw: String): String {
        var text = raw
        val urlIndex = text.lowercase().indexOf("http")
        if (urlIndex >= 0) {
            text = text.substring(0, urlIndex)
            // The sentence introducing the link ("Visit the API Keys tab at") goes with it.
            val sentenceEnd = text.lastIndexOf('.')
            text = if (sentenceEnd >= 0) {
                text.substring(0, sentenceEnd + 1)
            } else {
                // No sentence before the link: the whole string was directions to
                // it, and the dangling "check the key at" left behind says less
                // than nothing.
                ""
            }
        }
        text = text.replace("\n", " ").split(SPACES).joinToString(" ").trim()
        return truncated(text, 200)
    }

    private fun truncated(text: String, limit: Int): String =
        if (text.length <= limit) text else text.substring(0, limit).trim() + "…"

    private val SPACES = Regex(" +")
    private val VALIDATOR_PATH = Regex("^(body|params|query|headers)/")
    private val LIVE_CHILD_PODS =
        Regex("has\\s+(\\d+)\\s+live child pod\\(s\\)", RegexOption.IGNORE_CASE)
    private val MISSING_CREDENTIAL =
        Regex("^no ([a-z0-9_-]+) credential(?:\\b|$)", RegexOption.IGNORE_CASE)
    private val LEAKS = listOf(
        "cannot read propert",
        "typeerror",
        "referenceerror",
        "syntaxerror",
        "undefined",
        "null pointer",
        "exception:",
        "stack trace",
        "at object.",
        "_$",
        "solved by the library",
    )
}

/**
 * Cases the Foundation `URLError` switch answers. A caller with an OkHttp or
 * `java.net` failure maps into one of these; the rest stay generic.
 */
enum class NetworkFailure {
    Offline,
    TimedOut,
    CannotReachHost,
    Cancelled,
    Other,
    ;

    companion object {
        /**
         * The exception class is authoritative. Message matching is only a
         * secondary net for wrapped failures whose type has been erased.
         */
        fun tryParse(error: Any): NetworkFailure? {
            val lower = error.toString().lowercase()
            return when (error) {
                is CancellationException -> Cancelled
                is UnknownHostException ->
                    if (lower.contains("no address associated")) Offline else CannotReachHost

                is SSLHandshakeException -> CannotReachHost
                is SocketTimeoutException -> TimedOut
                is TimeoutException -> TimedOut
                is ConnectException, is NoRouteToHostException ->
                    if (NETWORK_DOWN.any { lower.contains(it) }) Offline else CannotReachHost

                is SSLException -> CannotReachHost
                is SocketException ->
                    if (NETWORK_DOWN.any { lower.contains(it) }) Offline else CannotReachHost

                // OkHttp reports a cancelled call as a plain `IOException("Canceled")`.
                is InterruptedIOException -> if (lower.contains("cancel")) Cancelled else TimedOut
                is IOException -> when {
                    lower.contains("cancel") -> Cancelled
                    lower.contains("certificate") -> CannotReachHost
                    lower.contains("timed out") || lower.contains("timeout") -> TimedOut
                    lower.contains("connection refused") || lower.contains("connection reset") ->
                        CannotReachHost

                    NETWORK_DOWN.any { lower.contains(it) } -> Offline
                    else -> Other
                }

                else -> null
            }
        }

        private val NETWORK_DOWN = listOf(
            "network is unreachable",
            "network is down",
            "no address associated",
        )
    }
}
