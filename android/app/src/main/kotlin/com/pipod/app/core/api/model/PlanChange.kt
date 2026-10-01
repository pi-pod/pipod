package com.pipod.app.core.api.model

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * The M5 plan-change slice (`POST /v1/billing/plan-change/preview|confirm`).
 *
 * Source: `CONTRACT-NOTES.md` (the current M4 `plan-change.ts` view).
 * `BILLING_PLAN_CHANGE_ENABLED` defaults false and the static backend registers
 * none of `/v1/billing`, so every surface here omits itself rather than
 * erroring when the server answers 404.
 *
 * The current API defines **no** hosted payment URL — no
 * `hostedPaymentUrl|paymentUrl|checkoutUrl|url` is read anywhere here, and a
 * 402 grants nothing: the card is fixed in the portal and a new preview
 * follows. Nothing here computes a price. Only numbers the server sent are
 * shown (cents are divided by 100 for display, which is formatting, not a
 * projection).
 */
enum class PlanKey(val wire: String) {
    Standard("standard"),
    Pro("pro"),
    ;

    /** The plan's own word for itself, for buttons and titles. */
    val displayName: String get() = when (this) {
        Standard -> "Standard"
        Pro -> "Pro"
    }

    companion object {
        fun fromWire(value: String?): PlanKey? = entries.firstOrNull { it.wire == value }

        /**
         * The plans worth offering beside [current].
         *
         * The server only sells standard and pro, so the other one is the
         * change; when the current plan is unreadable both are offered rather
         * than offering nothing.
         */
        fun optionsBesides(current: String?): List<PlanKey> {
            val known = fromWire(current)
            return if (known == null) entries.toList() else entries.filter { it != known }
        }
    }
}

/** When a quoted change takes effect. Unknown values read as absent. */
enum class PlanChangeTiming(val wire: String) {
    Immediate("immediate"),
    PeriodEnd("period_end"),
    ;

    companion object {
        fun fromWire(value: String?): PlanChangeTiming? = entries.firstOrNull { it.wire == value }
    }
}

/** The states an open quote can sit in. Only `applying` resumes. */
object PlanChangeQuoteState {
    const val QUOTED = "quoted"
    const val APPLYING = "applying"
}

/**
 * The `openPlanChange` view: the open quote or null (`quoted`|`applying`).
 *
 * This is the authoritative resume after process death. When `canChangePlan`
 * is false **because** the open quote is `applying`, the client confirms the
 * same [quoteId] — it never mints a fresh preview.
 */
data class PlanChangeOpenQuote(
    val quoteId: String,
    val state: String,
    val targetPlan: PlanKey? = null,
) {
    /** True while the quote is mid-apply: the only state that resumes. */
    val isApplying: Boolean get() = state == PlanChangeQuoteState.APPLYING

    companion object {
        /**
         * Reads the open-quote view. Null when there is none (JSON null or
         * absent) or when it names no resumable quote: a blank id or a blank
         * state. An unknown target reads as absent rather than failing the
         * resume — the quote id is what the confirm sends.
         */
        fun parse(body: JsonElement?): PlanChangeOpenQuote? {
            val record = body as? JsonObject ?: return null
            val quoteId = (record["quoteId"] as? JsonPrimitive)
                ?.takeIf { it.isString }?.content?.trim().orEmpty()
            if (quoteId.isEmpty()) return null
            val state = record.token("state")?.trim().orEmpty()
            if (state.isEmpty()) return null
            return PlanChangeOpenQuote(
                quoteId = quoteId,
                state = state,
                targetPlan = PlanKey.fromWire(record.token("targetPlan") ?: record.token("plan")),
            )
        }
    }
}

/**
 * The account fields the change-plan surface gates on, from
 * `GET /v1/billing/account`.
 *
 * The body carries the same flat block `/v1/me` sends under `workstation`
 * plus these fields; there is no wrapper object. `canChangePlan` is the
 * server's whole answer (flag && stripe && subscription && status in
 * `active`|`past_due`, never trialing, and no quote sitting in `applying`) —
 * the client never recomputes it.
 */
data class PlanChangeAccount(
    val canChangePlan: Boolean = false,
    /** True when `openPlanChange.state == applying`: restart confirms that quoteId. */
    val canResumePlanChange: Boolean = false,
    val canSubscribe: Boolean = false,
    val canManageBilling: Boolean = false,
    val currentPlanKey: String? = null,
    /** A scheduled **downgrade** only. */
    val pendingPlanKey: String? = null,
    val pendingScheduleUnreadable: Boolean = false,
    val cancelAtPeriodEnd: Boolean = false,
    /** The open quote (`quoted`|`applying`) or null — the resume authority. */
    val openPlanChange: PlanChangeOpenQuote? = null,
    /**
     * Legacy `applying` rows only. The new atomic path does not create
     * pendings, so this is read and carried, never acted on.
     */
    val pendingUpdateExpiresAt: Instant? = null,
) {
    /** A pending change the reader should be told about, in the plan's own words. */
    val pendingLine: String?
        get() {
            val pending = pendingPlanKey?.let { PlanKey.fromWire(it)?.displayName ?: it } ?: return null
            return if (pendingScheduleUnreadable) {
                "A plan change to $pending is pending; its schedule is temporarily unavailable."
            } else {
                "A plan change to $pending is pending."
            }
        }

    /** A scheduled cancellation, said plainly. */
    val cancelLine: String? get() =
        if (cancelAtPeriodEnd) "Your subscription ends at the end of the current period." else null

    /**
     * Whether an in-progress quote owns the flow: confirming
     * `openPlanChange`'s id is the only way forward, never a fresh preview.
     *
     * The server's whole answer is [canResumePlanChange]; the open quote's
     * `applying` state is read alongside it so a body that carries the state
     * without the flag still resumes the same id rather than minting a new
     * preview at a new price.
     */
    val canResume: Boolean get() = canResumePlanChange || openPlanChange?.isApplying == true

    /**
     * Whether the returned account shows [target] as now current or scheduled
     * (`planKey` for an immediate change, `pendingPlanKey` for a period-end
     * downgrade). This is only the account half of the grant: the confirm is a
     * grant only when the wire also says `applied === true` (see
     * [PlanChangeConfirmResult.isGranted]). A 200 that leaves the account still
     * on the old plan is `plan_change_not_applied`, never success.
     */
    fun isApplied(target: PlanKey): Boolean =
        currentPlanKey == target.wire || pendingPlanKey == target.wire

    companion object {
        /**
         * Reads the flat account view. An absent surface (the empty object a
         * 404 becomes) is null, not an empty account: the whole surface hides.
         */
        fun parse(body: JsonObject?): PlanChangeAccount? {
            if (body == null || body.isEmpty()) return null
            return PlanChangeAccount(
                canChangePlan = body.flag("canChangePlan"),
                canSubscribe = body.flag("canSubscribe"),
                canManageBilling = body.flag("canManageBilling"),
                currentPlanKey = body.planToken("planKey"),
                pendingPlanKey = body.planToken("pendingPlanKey"),
                pendingScheduleUnreadable = body.flag("pendingScheduleUnreadable"),
                cancelAtPeriodEnd = body.flag("cancelAtPeriodEnd"),
                canResumePlanChange = body.flag("canResumePlanChange"),
                openPlanChange = body["openPlanChange"]?.let { PlanChangeOpenQuote.parse(it) },
                pendingUpdateExpiresAt = body.moment("pendingUpdateExpiresAt"),
            )
        }
    }
}

/** One priced line inside a quote. `kind` is `base`|`overage`; both are display only. */
data class PlanChangeQuoteItem(val priceId: String? = null, val kind: String? = null)

/**
 * `PlanChangeQuoteView` from the preview route.
 *
 * An immediate Standard→Pro upgrade quotes `amountDueNowCents` from the
 * proration preview with `recurringAmountCents` the Pro licensed base (e.g.
 * 5000) and `nextPeriodAmountCents` the same as recurring — **never** 0 and
 * never a free month. A period-end Pro→Standard downgrade quotes due-now 0
 * with the `proration_behavior=none` preview next and the Standard base
 * recurring. See [reviewLines], which names the following period from the
 * server-sent amounts and never renders a "$0 next period" line.
 */
data class PlanChangeQuote(
    val quoteId: String,
    val currentPlan: String? = null,
    val targetPlan: PlanKey,
    val timing: PlanChangeTiming,
    val amountDueNowCents: Double = 0.0,
    /** The licensed base of the target plan (e.g. 5000 for Pro). */
    val recurringAmountCents: Double? = null,
    /** Same as recurring on an immediate upgrade; the period preview on a downgrade. */
    val nextPeriodAmountCents: Double? = null,
    val currency: String? = null,
    val currentPeriodEnd: Instant? = null,
    val effectiveAt: Instant? = null,
    val expiresAt: Instant? = null,
    /** Legacy `applying` rows only; the atomic path sets none. Read, never acted on. */
    val pendingUpdateExpiresAt: Instant? = null,
    val pendingInvoiceId: String? = null,
    /** The quote's own state (`quoted`|`applying`|…). */
    val state: String? = null,
    val items: List<PlanChangeQuoteItem> = emptyList(),
) {
    /** An immediate quote charges now; anything else charges nothing now. */
    val isUpgrade: Boolean get() = timing == PlanChangeTiming.Immediate

    /**
     * The review, in the order it is read: what is due now, when it takes
     * effect, and what follows per period.
     *
     * The following amount is the server-sent next-period figure, falling back
     * to the server-sent recurring base — both are the server's numbers, not a
     * projection. A zero or absent figure renders no line at all: "$0 next
     * period" would read as a free month, which an immediate upgrade never is.
     */
    fun reviewLines(
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): List<String> = buildList {
        if (amountDueNowCents > 0) {
            add("Due now: ${money(amountDueNowCents)}.")
        } else {
            add("Nothing due now.")
        }
        when (timing) {
            PlanChangeTiming.Immediate -> {
                add("Takes effect immediately.")
                currentPeriodEnd?.let { add("The current period ends ${date(it, zone, locale)}.") }
            }
            PlanChangeTiming.PeriodEnd -> {
                val whenText = effectiveAt?.let { "Takes effect ${date(it, zone, locale)}." }
                    ?: "Takes effect at the end of the current period."
                add(whenText)
            }
        }
        (nextPeriodAmountCents ?: recurringAmountCents)
            ?.takeIf { it > 0 }
            ?.let { add("Then ${money(it)} per period.") }
    }

    val reviewTitle: String get() = "Change to ${targetPlan.displayName}?"

    /**
     * The confirm button names the exact quote being consented to: consent is
     * per quote, and a stale quote needs a new review, never a silent re-send.
     */
    val confirmLabel: String get() = "Confirm change to ${targetPlan.displayName}"

    private fun money(cents: Double): String {
        val code = currency?.trim()?.uppercase()?.takeIf { it.length == 3 }
        val amount = BillingNumbers.moneyCents(cents)
        return if (code == null || code == "USD") amount else "$amount $code"
    }

    private fun date(value: Instant, zone: ZoneId, locale: Locale): String =
        BillingNumbers.date(value, zone, locale)

    companion object {
        /**
         * Reads a quote view. Null when the body is not a quote the reader
         * could consent to: a blank id, an unknown target or an unknown
         * timing. Amounts that are negative or non-finite read as absent
         * (due now falls back to 0, recurring/next period to nothing) rather
         * than failing the whole quote.
         */
        fun parse(body: JsonElement?): PlanChangeQuote? {
            val record = body as? JsonObject ?: return null
            val quoteId = (record["quoteId"] as? JsonPrimitive)
                ?.takeIf { it.isString }?.content?.trim().orEmpty()
            if (quoteId.isEmpty()) return null
            val target = PlanKey.fromWire(record.token("targetPlan") ?: record.token("plan")) ?: return null
            val timing = PlanChangeTiming.fromWire(record.token("timing")) ?: return null
            return PlanChangeQuote(
                quoteId = quoteId,
                currentPlan = record.token("currentPlan"),
                targetPlan = target,
                timing = timing,
                amountDueNowCents = record.nonNegative("amountDueNowCents") ?: 0.0,
                recurringAmountCents = record.nonNegative("recurringAmountCents"),
                nextPeriodAmountCents = record.nonNegative("nextPeriodAmountCents"),
                currency = record.token("currency"),
                currentPeriodEnd = record.moment("currentPeriodEnd"),
                effectiveAt = record.moment("effectiveAt"),
                expiresAt = record.moment("expiresAt"),
                pendingUpdateExpiresAt = record.moment("pendingUpdateExpiresAt"),
                pendingInvoiceId = record.token("pendingInvoiceId", maxLength = 128),
                state = record.token("state"),
                items = record.items(),
            )
        }
    }
}

/**
 * `POST /v1/billing/plan-change/confirm` answers `{ applied, ...quote, account }`.
 *
 * The current API defines no hosted payment URL, so none is read here — a
 * body that happens to carry URL-shaped keys is parsed for its quote and
 * account only. The grant is `applied === true` AND the returned account
 * showing the target (see [PlanChangeAccount.isApplied]): either signal alone
 * grants nothing. A missing `applied` is never success — it is
 * `plan_change_not_applied`.
 */
data class PlanChangeConfirmResult(
    val quote: PlanChangeQuote? = null,
    val account: PlanChangeAccount? = null,
    /** True only when the wire said `applied === true`. Missing reads as false. */
    val applied: Boolean = false,
) {
    /**
     * Whether this confirm granted [target]: `applied === true` AND the
     * account corroborates it. `applied:true` leaving the old plan, or the
     * target plan without `applied:true`, is `plan_change_not_applied`.
     */
    fun isGranted(target: PlanKey): Boolean =
        applied && (account?.isApplied(target) == true)

    companion object {
        fun parse(body: JsonElement?): PlanChangeConfirmResult? {
            val record = body as? JsonObject ?: return null
            val accountBody = record["account"] as? JsonObject
            val result = PlanChangeConfirmResult(
                quote = PlanChangeQuote.parse(record),
                account = PlanChangeAccount.parse(accountBody),
                applied = (record["applied"] as? JsonPrimitive)?.booleanOrNull == true,
            )
            return if (result.quote == null && result.account == null) {
                null
            } else {
                result
            }
        }
    }
}

/**
 * The plan-change failure codes, and the copy each one earns.
 *
 * Codes arrive beside `error` in the body (folded into `detail` by
 * [ApiError.fromJson]) or as the `error` slug itself; both are read so a
 * server that phrases either way still maps.
 */
object PlanChangeErrors {
    const val QUOTE_STALE = "quote_stale"
    const val QUOTE_EXPIRED = "quote_expired"
    const val CAP_BELOW_NEW_BASE = "cap_below_new_base"
    const val TRIAL_UNAVAILABLE = "trial_plan_change_unavailable"
    const val CARD_DECLINED = "card_declined"
    const val AUTH_REQUIRED = "authentication_required"
    const val NOT_APPLIED = "plan_change_not_applied"
    /** A preview refused while a quote is `applying`: resume that quoteId instead. */
    const val IN_FLIGHT = "plan_change_in_flight"
    /**
     * A confirm answered 409 with an unknown effect
     * (`{ quoteId, retryable }`): the change may or may not have applied.
     * Unknown, never stale, never a 402 — the consented quote is kept for a
     * same-id retry, never dropped for a fresh preview.
     */
    const val EFFECT_UNKNOWN = "plan_change_effect_unknown"

    /**
     * A 402 (`card_declined`/`authentication_required`) fails the quote: no
     * pending invoice, no hosted payment intent, no Pro. The card is fixed in
     * the portal and a new preview follows; the failed quote is never replayed.
     */
    const val PAYMENT_FAILED_COPY =
        "The card was declined or needs authentication, so the plan change failed: " +
            "the quote failed, no pending invoice was created, and your plan hasn't changed. " +
            "Update the card in the billing portal, then start a new preview — " +
            "the failed quote is never retried."

    /** A 200 that leaves the account still on the old plan. No Pro was granted. */
    const val NOT_APPLIED_COPY =
        "The plan change was not applied — your plan hasn't changed and Pro was not granted."

    /**
     * A 409 preview refusal while a quote is `applying` (`{ quoteId, state }`).
     * The in-flight id owns the flow: confirm it instead of starting a new
     * preview at a new price. A 409 never raises the spend cap implicitly.
     */
    const val IN_FLIGHT_COPY =
        "A plan change is already being applied — " +
            "continue it instead of starting a new preview."

    /**
     * A 409 confirm whose effect is unknown (`{ quoteId, retryable }`). The
     * quote was kept: retrying the same id is idempotent, while a fresh
     * preview could double-apply. Says nothing about expiry (it is not
     * stale) and nothing about the card (it is not a 402).
     */
    const val EFFECT_UNKNOWN_COPY =
        "The result of the plan change is unknown — it may or may not have applied. " +
            "The quote was kept: retry the same quote rather than starting a new preview."

    /** The typed code for [error], or null when it is not a plan-change failure. */
    fun codeOf(error: ApiError): String? {
        val candidates = listOfNotNull(error.detailCode, error.detailString("code"), error.error)
        return candidates.firstOrNull { KNOWN.contains(it) }
    }

    fun isStale(error: ApiError): Boolean =
        codeOf(error) == QUOTE_STALE || codeOf(error) == QUOTE_EXPIRED

    fun isNotFound(error: ApiError): Boolean = error.transportStatus == 404

    fun isPaymentRequired(error: ApiError): Boolean = error.transportStatus == 402

    fun isCapBelowBase(error: ApiError): Boolean = codeOf(error) == CAP_BELOW_NEW_BASE

    fun isInFlight(error: ApiError): Boolean = codeOf(error) == IN_FLIGHT

    /** The in-flight quote id a 409 preview refusal carries, or null. */
    fun inFlightQuoteId(error: ApiError): String? {
        if (!isInFlight(error)) return null
        return error.detailString("quoteId")?.trim()?.takeIf { it.isNotEmpty() }
    }

    /** True for a 409 `plan_change_effect_unknown` confirm. Never stale, never a 402. */
    fun isEffectUnknown(error: ApiError): Boolean = codeOf(error) == EFFECT_UNKNOWN

    /** The quote id a 409 effect-unknown body carries, or null. */
    fun effectUnknownQuoteId(error: ApiError): String? {
        if (!isEffectUnknown(error)) return null
        return error.detailString("quoteId")?.trim()?.takeIf { it.isNotEmpty() }
    }

    /**
     * Copy for a plan-change failure. Null when the error is not one of ours
     * and the caller should fall back to [FriendlyError][com.pipod.app.core.format.FriendlyError].
     */
    fun message(error: ApiError): String? {
        if (isPaymentRequired(error)) return PAYMENT_FAILED_COPY
        return when (codeOf(error)) {
            QUOTE_STALE, QUOTE_EXPIRED ->
                "That quote expired before it could be confirmed. " +
                    "Review the new quote before confirming — the price may have changed."
            CAP_BELOW_NEW_BASE ->
                "Your spend cap is below the new plan's base. " +
                    "Raise the cap first; it won't be raised for you."
            TRIAL_UNAVAILABLE ->
                "Plan changes aren't available during a trial."
            CARD_DECLINED, AUTH_REQUIRED -> PAYMENT_FAILED_COPY
            NOT_APPLIED -> NOT_APPLIED_COPY
            IN_FLIGHT -> IN_FLIGHT_COPY
            EFFECT_UNKNOWN -> EFFECT_UNKNOWN_COPY
            else -> null
        }
    }
}

private fun JsonObject.flag(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.booleanOrNull == true

/** A short bounded token (plan key, timing, currency). Control characters never reach a screen. */
private fun JsonObject.token(key: String, maxLength: Int = 32): String? {
    val raw = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim() ?: return null
    if (raw.isEmpty() || raw.length > maxLength) return null
    if (raw.any { it.code < 0x20 || it.code == 0x7f }) return null
    return raw
}

private fun JsonObject.planToken(key: String): String? = token(key)

/** A non-negative finite amount in minor units. Negatives and non-finite read as absent. */
private fun JsonObject.nonNegative(key: String): Double? {
    val raw = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull ?: return null
    if (!raw.isFinite() || raw < 0.0) return null
    return raw
}

private fun JsonObject.moment(key: String): Instant? {
    val raw = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    if (raw.length > 40) return null
    val normalized = raw.replace(' ', 'T')
    return runCatching { Instant.parse(normalized) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(normalized).toInstant() }.getOrNull()
}

private fun JsonObject.items(): List<PlanChangeQuoteItem> {
    val array = (this["items"] as? kotlinx.serialization.json.JsonArray) ?: return emptyList()
    return array.mapNotNull { element ->
        val row = element as? JsonObject ?: return@mapNotNull null
        PlanChangeQuoteItem(priceId = row.token("priceId"), kind = row.token("kind"))
    }.take(32)
}

private val KNOWN = setOf(
    PlanChangeErrors.QUOTE_STALE,
    PlanChangeErrors.QUOTE_EXPIRED,
    PlanChangeErrors.CAP_BELOW_NEW_BASE,
    PlanChangeErrors.TRIAL_UNAVAILABLE,
    PlanChangeErrors.CARD_DECLINED,
    PlanChangeErrors.AUTH_REQUIRED,
    PlanChangeErrors.NOT_APPLIED,
    PlanChangeErrors.IN_FLIGHT,
    PlanChangeErrors.EFFECT_UNKNOWN,
)
