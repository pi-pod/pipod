import Foundation

/// A paid plan this account can change between. The wire sends lowercase keys.
public enum PlanChangePlan: String, Sendable, Hashable, CaseIterable {
    case standard
    case pro

    public var displayName: String {
        switch self {
        case .standard: return "Standard"
        case .pro: return "Pro"
        }
    }
}

/// When the quoted change takes effect. The contract fixes the mapping:
/// upgrades apply immediately, downgrades at the end of the current period.
public enum PlanChangeTiming: String, Sendable, Hashable {
    case immediate
    case periodEnd = "period_end"
}

/// One priced line on a quote. The ids are opaque vendor references: they are
/// kept for fidelity and never shown, and no amount is ever derived from them.
public struct PlanChangeQuoteItem: Sendable, Hashable {
    public let priceId: String
    /// `base` or `overage`. Anything else is kept verbatim, never guessed at.
    public let kind: String

    public init(priceId: String, kind: String) {
        self.priceId = priceId
        self.kind = kind
    }

    static func parse(_ value: JSONValue?) -> PlanChangeQuoteItem? {
        guard let priceId = value?["priceId"]?.stringValue,
              !priceId.isEmpty,
              let kind = value?["kind"]?.stringValue,
              !kind.isEmpty
        else { return nil }
        return PlanChangeQuoteItem(priceId: priceId, kind: kind)
    }
}

/// The server's price for one plan change: `POST
/// /v1/billing/plan-change/preview`. Nothing here is computed — every amount is
/// a cent figure the server sent, and a quote the user has not explicitly
/// confirmed changes nothing.
public struct PlanChangeQuote: Sendable, Hashable {
    public let quoteId: String
    public let currentPlan: String
    public let targetPlan: String
    public let timing: PlanChangeTiming
    public let amountDueNowCents: Int
    /// What the month after this one costs. On an immediate upgrade this
    /// equals the recurring base (e.g. 5000) — never 0, never "next month
    /// free". A 0 here is a missing price, not a free month.
    public let nextPeriodAmountCents: Int
    /// The plan's licensed base for the coming period (e.g. 5000 for Pro).
    /// Immediate upgrades price the ongoing month at this figure.
    public let recurringAmountCents: Int?
    public let currency: String
    public let currentPeriodEnd: Date?
    public let effectiveAt: Date?
    public let expiresAt: Date?
    /// `quoted` on preview; `applying` while a confirm is in flight. Kept so
    /// a resumed quote reads as the same quote, not a new price.
    public let state: String?
    /// Legacy applying rows only: the atomic confirm path creates no
    /// pendings, so this is retained for fidelity and never treated as
    /// pending truth.
    public let pendingUpdateExpiresAt: Date?
    public let pendingInvoiceId: String?
    public let items: [PlanChangeQuoteItem]

    public init(
        quoteId: String,
        currentPlan: String,
        targetPlan: String,
        timing: PlanChangeTiming,
        amountDueNowCents: Int,
        nextPeriodAmountCents: Int,
        currency: String,
        recurringAmountCents: Int? = nil,
        currentPeriodEnd: Date? = nil,
        effectiveAt: Date? = nil,
        expiresAt: Date? = nil,
        state: String? = nil,
        pendingUpdateExpiresAt: Date? = nil,
        pendingInvoiceId: String? = nil,
        items: [PlanChangeQuoteItem] = []
    ) {
        self.quoteId = quoteId
        self.currentPlan = currentPlan
        self.targetPlan = targetPlan
        self.timing = timing
        self.amountDueNowCents = amountDueNowCents
        self.nextPeriodAmountCents = nextPeriodAmountCents
        self.recurringAmountCents = recurringAmountCents
        self.currency = currency
        self.currentPeriodEnd = currentPeriodEnd
        self.effectiveAt = effectiveAt
        self.expiresAt = expiresAt
        self.state = state
        self.pendingUpdateExpiresAt = pendingUpdateExpiresAt
        self.pendingInvoiceId = pendingInvoiceId
        self.items = items
    }

    // MARK: - Parsing

    /// Nil when the quote names no usable id, plans, timing or amounts. A quote
    /// without an amount is not a quote with an amount of zero — the two read
    /// very differently on a confirmation screen — so the cent fields are
    /// required, while the dates and line items stay optional.
    public static func parse(_ value: JSONValue?) -> PlanChangeQuote? {
        guard let value,
              let quoteId = value["quoteId"]?.stringValue, !quoteId.isEmpty,
              let currentPlan = value["currentPlan"]?.stringValue, !currentPlan.isEmpty,
              let targetPlan = value["targetPlan"]?.stringValue, !targetPlan.isEmpty,
              let timingRaw = value["timing"]?.stringValue,
              let timing = PlanChangeTiming(rawValue: timingRaw),
              let dueNow = cents(value["amountDueNowCents"]),
              let nextPeriod = cents(value["nextPeriodAmountCents"]),
              let currency = value["currency"]?.stringValue, !currency.isEmpty
        else { return nil }
        let items = value["items"]?.arrayValue?.compactMap(PlanChangeQuoteItem.parse) ?? []
        let recurring = value["recurringAmountCents"].flatMap { cents($0) }
        return PlanChangeQuote(
            quoteId: quoteId,
            currentPlan: currentPlan,
            targetPlan: targetPlan,
            timing: timing,
            amountDueNowCents: dueNow,
            nextPeriodAmountCents: nextPeriod,
            currency: currency,
            recurringAmountCents: recurring,
            currentPeriodEnd: value["currentPeriodEnd"]?.stringValue.flatMap(Format.date),
            effectiveAt: value["effectiveAt"]?.stringValue.flatMap(Format.date),
            expiresAt: value["expiresAt"]?.stringValue.flatMap(Format.date),
            state: value["state"]?.stringValue,
            pendingUpdateExpiresAt: value["pendingUpdateExpiresAt"]?.stringValue.flatMap(Format.date),
            pendingInvoiceId: value["pendingInvoiceId"]?.stringValue,
            items: items
        )
    }

    /// Non-negative integer cents. A fractional or negative amount is dropped
    /// rather than shown: displaying a mangled price as a real one is worse
    /// than refusing the quote.
    static func cents(_ value: JSONValue?) -> Int? {
        guard let raw = value?.doubleValue, raw.isFinite, raw >= 0,
              raw == raw.rounded(), raw <= Double(Int.max)
        else { return nil }
        return Int(raw)
    }

    // MARK: - Rendering

    public var takesEffectImmediately: Bool { timing == .immediate }

    /// `$30.28` for USD; `<amount> <CODE>` otherwise. The server prices in one
    /// currency per quote and the client converts nothing.
    public func money(cents: Int) -> String {
        let amount = Double(cents) / 100
        if currency.lowercased() == "usd" { return BillingSummary.money(amount) }
        if amount == amount.rounded(), abs(amount) < 1e15 {
            return "\(Int(amount)) \(currency.uppercased())"
        }
        return String(format: "%.2f %@", amount, currency.uppercased())
    }

    /// The charge this confirmation actually makes: "Due now: $30.28", or
    /// "Nothing due now" when the change bills nothing today.
    public var dueNowLine: String {
        amountDueNowCents > 0
            ? "Due now: \(money(cents: amountDueNowCents))"
            : "Nothing due now"
    }

    /// When the change lands. An immediate upgrade says so outright; a
    /// period-end change names the date the server sent, or says period-end
    /// without inventing one when the server sent none.
    public var effectLine: String {
        switch timing {
        case .immediate:
            return "Takes effect immediately."
        case .periodEnd:
            if let currentPeriodEnd {
                return "Takes effect \(Format.shortDay(currentPeriodEnd)), at the end of the current period."
            }
            return "Takes effect at the end of the current period."
        }
    }

    /// What the period after this one costs — always a priced month, never
    /// "free". An immediate upgrade prices it at the recurring base (e.g.
    /// $50 for Pro); a period-end change at the quoted next-period amount.
    /// A 0 is a missing price, not a free month, so a quote with no usable
    /// ongoing figure shows no line rather than inventing one.
    public var nextPeriodLine: String? {
        let priced: Int?
        switch timing {
        case .immediate:
            // The contract fixes next-period to the recurring base: prefer
            // it, and only fall back to a positive next-period figure.
            priced = ((recurringAmountCents ?? 0) > 0) ? recurringAmountCents
                : (nextPeriodAmountCents > 0 ? nextPeriodAmountCents : nil)
        case .periodEnd:
            priced = nextPeriodAmountCents > 0 ? nextPeriodAmountCents
                : (((recurringAmountCents ?? 0) > 0) ? recurringAmountCents : nil)
        }
        guard let priced, priced > 0 else { return nil }
        return "Then \(money(cents: priced)) per month."
    }

    public var expiryLine: String? {
        guard let expiresAt else { return nil }
        return "This quote expires \(Format.shortDay(expiresAt))."
    }
}

/// The account's open plan-change quote, if any: the authoritative resume
/// after a process death or a lost confirm. `quoted` is a priced quote
/// awaiting its first confirm; `applying` is a confirm already in flight —
/// only confirming that same quote id may proceed, never a fresh preview.
public struct PlanChangeOpenQuote: Sendable, Hashable {
    public let quoteId: String
    public let state: String
    public let targetPlan: String?

    public init(quoteId: String, state: String, targetPlan: String? = nil) {
        self.quoteId = quoteId
        self.state = state
        self.targetPlan = targetPlan
    }

    public var isApplying: Bool { state.lowercased() == "applying" }

    public static func parse(_ value: JSONValue?) -> PlanChangeOpenQuote? {
        guard let quoteId = value?["quoteId"]?.stringValue, !quoteId.isEmpty,
              let state = value?["state"]?.stringValue, !state.isEmpty
        else { return nil }
        let target = value?["targetPlan"]?.stringValue
        return PlanChangeOpenQuote(
            quoteId: quoteId, state: state,
            targetPlan: (target?.isEmpty == false) ? target : nil
        )
    }
}

/// What `GET /v1/billing/account` says about changing plans. The whole surface
/// is gated on `canChangePlan`; a 404 (static backend, flag off) means there is
/// no plan-change UI at all, not a disabled one. The one exception is an
/// applying open quote: `canChangePlan` is false while it is in flight, and
/// then the screen resumes that same quote id instead of vanishing.
///
/// `canResumePlanChange` is true exactly when `openPlanChange.state` is
/// `applying` — restart confirms that quoteId, never a fresh preview. The
/// server sends the flag explicitly; `needsResume` also treats an applying
/// open quote as resumable so older servers that omit the flag still resume.
public struct PlanChangeEligibility: Sendable, Hashable {
    public let canChangePlan: Bool
    public let canResumePlanChange: Bool
    public let currentPlanKey: String?
    public let pendingPlanKey: String?
    public let pendingScheduleUnreadable: Bool
    public let cancelAtPeriodEnd: Bool
    public let openPlanChange: PlanChangeOpenQuote?

    public init(
        canChangePlan: Bool,
        canResumePlanChange: Bool = false,
        currentPlanKey: String? = nil,
        pendingPlanKey: String? = nil,
        pendingScheduleUnreadable: Bool = false,
        cancelAtPeriodEnd: Bool = false,
        openPlanChange: PlanChangeOpenQuote? = nil
    ) {
        self.canChangePlan = canChangePlan
        self.canResumePlanChange = canResumePlanChange
        self.currentPlanKey = currentPlanKey
        self.pendingPlanKey = pendingPlanKey
        self.pendingScheduleUnreadable = pendingScheduleUnreadable
        self.cancelAtPeriodEnd = cancelAtPeriodEnd
        self.openPlanChange = openPlanChange
    }

    public static func parse(_ account: JSONValue?) -> PlanChangeEligibility {
        let open = PlanChangeOpenQuote.parse(account?["openPlanChange"])
        return PlanChangeEligibility(
            canChangePlan: account?["canChangePlan"]?.boolValue == true,
            canResumePlanChange: account?["canResumePlanChange"]?.boolValue == true,
            currentPlanKey: account?["planKey"]?.stringValue,
            pendingPlanKey: account?["pendingPlanKey"]?.stringValue,
            pendingScheduleUnreadable: account?["pendingScheduleUnreadable"]?.boolValue == true,
            cancelAtPeriodEnd: account?["cancelAtPeriodEnd"]?.boolValue == true,
            openPlanChange: open
        )
    }

    /// True when an interrupted confirm must be resumed by its same quote id:
    /// the server's explicit flag, or an applying open quote on its own.
    public var needsResume: Bool {
        canResumePlanChange || openPlanChange?.isApplying == true
    }

    /// The one-line pending truth under the entry row, refreshed from the
    /// account after every confirm. Nil when there is nothing pending: a clean
    /// account gets no footnote.
    public var pendingNote: String? {
        if let pendingPlanKey, !pendingPlanKey.isEmpty {
            if pendingScheduleUnreadable {
                return "A plan change is pending; its details could not be read. Check the billing portal."
            }
            return "A change to \(pendingPlanKey.capitalized) is pending."
        }
        if cancelAtPeriodEnd {
            return "Cancellation is scheduled for the end of the current period."
        }
        return nil
    }
}

/// Why a plan-change confirm did not apply, read off the refusal the server
/// sent. Anything unrecognized is nil and reads as a generic failure — an
/// unknown reason must never be worded as a known one.
public enum PlanChangeFailure: Sendable, Hashable {
    /// 402 `card_declined` / `authentication_required`: the quote is failed —
    /// no pending invoice, no hosted payment page on this API. The card is
    /// fixed in the billing portal and then a new preview is reviewed; the
    /// failed quote id is never replayed.
    case paymentFailed
    /// A 200 that did not apply: `plan_change_not_applied`. The grant is
    /// `applied == true` AND `account.planKey` (immediate) or
    /// `account.pendingPlanKey` (period-end downgrade) matching the target —
    /// a missing/false `applied`, or an account that still shows the old plan
    /// with nothing pending, grants no Pro. The quote is kept: the outcome is
    /// unknown, so retrying replays the same id rather than minting a new price.
    case notApplied
    /// 409 `plan_change_in_flight`: a confirm is already applying for the
    /// account's open quote. Minting a fresh preview is refused — resume that
    /// same open quote id instead. Handled on the preview path; the account
    /// re-read supplies the id to resume.
    case inFlight
    /// 409 `quote_stale` / `quote_expired`: the price moved. The old quote is
    /// dead — preview again and confirm the new one explicitly, never confirm
    /// the higher price implicitly.
    case quoteStale
    /// 409 `plan_change_effect_unknown`: the confirm may or may not have
    /// applied — a possible paid effect. The quote stays alive: retrying
    /// replays the same id rather than minting a new price, and the quote is
    /// never dropped, not even when the re-read eligibility reads off. This is
    /// never worded as `quote_stale` and never as a grant or a no-change.
    case effectUnknown
    /// 409 `cap_below_new_base`: the custom spend cap sits below the new plan's
    /// base. The cap is never raised implicitly.
    case capBelowNewBase
    /// 409 `trial_plan_change_unavailable`: trials cannot change plans.
    case trialUnavailable
    /// 404: the flag is off or the quote is not owned. The surface is omitted.
    case unavailable

    /// The machine reason, wherever the server put it: some routes answer it as
    /// the `error` string, others under `detail.code`. A 402 is always the
    /// certain payment failure (`card_declined` / `authentication_required`):
    /// only 5xx, transport losses, and 409 `plan_change_effect_unknown` are
    /// unknown outcomes that may retry.
    /// A 409 `plan_change_in_flight` means an earlier confirm is still
    /// applying — resume its id, never a fresh preview.
    /// A 409 `plan_change_effect_unknown` is never `quote_stale`: the price is
    /// not known to have moved, so the same id retries instead of a new preview.
    public static func classify(_ error: APIError) -> PlanChangeFailure? {
        switch error.transportStatus {
        case 402:
            return .paymentFailed
        case 404:
            return .unavailable
        case 409:
            switch (error.detailCode ?? error.error) {
            case "quote_stale", "quote_expired":
                return .quoteStale
            case "plan_change_effect_unknown":
                return .effectUnknown
            case "plan_change_in_flight":
                return .inFlight
            case "cap_below_new_base":
                return .capBelowNewBase
            case "trial_plan_change_unavailable":
                return .trialUnavailable
            default:
                return nil
            }
        default:
            return nil
        }
    }

    /// True when the quoted price can no longer be confirmed at all: only a
    /// fresh preview plus a fresh explicit consent may proceed. An unknown
    /// effect (`effectUnknown`) is still confirmable — the same id retries —
    /// while `quoteStale`/`quoteExpired` always need a new preview.
    public var requiresNewPreview: Bool {
        switch self {
        case .quoteStale, .unavailable, .paymentFailed: return true
        case .inFlight, .effectUnknown: return false
        default: return false
        }
    }

    /// True when confirming again with the same quote id is meaningful: a
    /// network loss, a 5xx, a 200 whose account still shows the old plan, or a
    /// 409 `plan_change_effect_unknown` leaves the outcome unknown, and the
    /// retry replays the id rather than minting a new price.
    /// A failed (402) or refused (409) quote is never replayed — except
    /// `in_flight`, which resumes the open id via the account, not via the
    /// preview that was just refused, and `effect_unknown`, which retries the
    /// same reviewed id because the effect is unknown (a possible paid effect).
    public var retrySameQuoteAllowed: Bool {
        switch self {
        case .notApplied, .effectUnknown: return true
        case .paymentFailed, .quoteStale, .inFlight, .capBelowNewBase, .trialUnavailable, .unavailable:
            return false
        }
    }

    public var message: String {
        switch self {
        case .paymentFailed:
            return "The card was declined or needs authentication, so your plan "
                + "has not changed. Update the card in the billing portal, then "
                + "review a new quote — this quote is closed and confirming it "
                + "again will not apply."
        case .notApplied:
            return "The change did not apply, so your plan has not changed. "
                + "Retrying confirms this same quote — never a new price."
        case .quoteStale:
            return "The price changed while you were reviewing it, so this quote "
                + "is no longer valid. Review the new quote before confirming — it is never confirmed automatically."
        case .capBelowNewBase:
            return "Your custom spend cap is below what the new plan needs, so "
                + "the change was refused. Raise the cap yourself first if you want to proceed — it is never raised for you."
        case .trialUnavailable:
            return "Plans cannot be changed while trialing."
        case .inFlight:
            return "A plan change is still being applied — resume that confirmation "
                + "instead of starting a new price."
        case .effectUnknown:
            return "We could not tell whether the change went through, so it may have applied. "
                + "Retrying confirms this same quote — never a new price. "
                + "Check your plan status before retrying."
        case .unavailable:
            return "Plan changes are not available on this account right now."
        }
    }
}
