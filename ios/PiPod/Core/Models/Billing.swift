import Foundation

/// How the spend cap for the current period stands, as `/v1/me` sends it.
public enum SpendCapState: String, Sendable, Hashable, CaseIterable {
    case ok
    case warning
    case reached
}

/// The account-level billing state the server reports on the workstation block.
public enum BillingStatus: String, Sendable, Hashable, CaseIterable {
    case none
    case trialing
    case active
    case pastDue = "past_due"
    case canceled
}

/// Why the server will refuse to start this account's machines.
///
/// The five values are contract (`StartBlockedReason`, `billing/entitlements.ts`).
/// They arrive on the `workstation` block *before* anything is attempted, which
/// is the whole point: the same five reasons come back as a 402 on the launch
/// itself, and learning them from a failed launch is learning them too late.
public enum StartBlockedReason: String, Sendable, Hashable, CaseIterable {
    case subscriptionRequired = "subscription_required"
    case trialExpired = "trial_expired"
    case trialHoursExhausted = "trial_hours_exhausted"
    case paymentPastDue = "payment_past_due"
    case spendCapReached = "spend_cap_reached"

    /// The chip: three or four words, the state itself, never the remedy.
    public var chipLabel: String {
        switch self {
        case .subscriptionRequired: return "Subscription required"
        case .trialExpired: return "Trial ended"
        case .trialHoursExhausted: return "Trial hours used up"
        case .paymentPastDue: return "Payment failed"
        case .spendCapReached: return "Spend cap reached"
        }
    }
}

/// The optional workstation block from `GET /v1/me` (and, when present, the
/// `GET /v1/pods` envelope — one parser owns both shapes).
///
/// **This is the edition boundary.** The box backend sends this flat object
/// under the `workstation` key; the static backend omits the key entirely, and
/// then the whole surface is hidden silently — no placeholder, no "unknown",
/// no zeroes, no empty header. Every field is independently optional, so a
/// partial object renders its parts and omits the rest.
///
/// Nothing here is computed. A projection or a price the server did not send
/// would be a number this client invented, and no client may invent a number.
/// Cent amounts are scaled to dollars for display only.
public struct BillingSummary: Sendable, Hashable {
    public let planName: String?
    public let activeHoursUsed: Double?
    public let activeHoursIncluded: Double?
    public let spendLimitUsd: Double?
    public let spendCapState: SpendCapState?
    public let status: BillingStatus?
    public let trialEndsAt: Date?
    public let periodEnd: Date?
    /// The server's own verdict on whether machines may start. Authoritative:
    /// it is `startBlockedReason != null` computed server-side, and the client
    /// never re-derives it from the numbers beside it.
    public let startsBlocked: Bool
    /// Why, when the server named a reason this build knows. A blocked account
    /// whose reason is unrecognised still reads as blocked — the boolean is the
    /// contract, the reason only refines the copy.
    public let startBlockedReason: StartBlockedReason?
    /// Vendor-vouched seconds from `/v1/me.workstation`. Converted to hours for display.
    public let billableActiveSeconds: Double?
    /// Unvouched/UNKNOWN seconds. Shown separately; never added into confirmed hours.
    public let unknownActiveSeconds: Double?

    public init(
        planName: String? = nil,
        activeHoursUsed: Double? = nil,
        activeHoursIncluded: Double? = nil,
        spendLimitUsd: Double? = nil,
        spendCapState: SpendCapState? = nil,
        status: BillingStatus? = nil,
        trialEndsAt: Date? = nil,
        periodEnd: Date? = nil,
        startsBlocked: Bool = false,
        startBlockedReason: StartBlockedReason? = nil,
        billableActiveSeconds: Double? = nil,
        unknownActiveSeconds: Double? = nil
    ) {
        self.planName = planName
        self.activeHoursUsed = activeHoursUsed
        self.activeHoursIncluded = activeHoursIncluded
        self.spendLimitUsd = spendLimitUsd
        self.spendCapState = spendCapState
        self.status = status
        self.trialEndsAt = trialEndsAt
        self.periodEnd = periodEnd
        self.startsBlocked = startsBlocked
        self.startBlockedReason = startBlockedReason
        self.billableActiveSeconds = billableActiveSeconds
        self.unknownActiveSeconds = unknownActiveSeconds
    }

    // MARK: - Rendering

    /// The segments of the summary line, in order, each one omitted when the
    /// data behind it was not sent: the plan, the used/included hours, the cap
    /// in dollars, a trial note while trialing, and the period end.
    public var segments: [String] {
        var parts: [String] = []
        if let planName { parts.append(planName) }
        if let hours = activeHoursSegment { parts.append(hours) }
        if let unknown = unknownHoursSegment { parts.append(unknown) }
        if let spend = spendSegment { parts.append(spend) }
        if let trial = trialSegment { parts.append(trial) }
        if let period = periodSegment { parts.append(period) }
        return parts
    }

    public var summaryLine: String { segments.joined(separator: " · ") }

    /// True when nothing at all is renderable. Treated exactly like an absent
    /// `workstation` object: the surface does not appear.
    public var isEmpty: Bool { segments.isEmpty && stateLabel == nil }

    /// The chip beside the line. A block outranks everything: it is the only
    /// state that stops the reader doing what they came to do.
    public var stateLabel: String? {
        if startsBlocked { return startBlockedReason?.chipLabel ?? "New pods blocked" }
        if spendCapState == .reached { return "Spend cap reached" }
        if status == .pastDue { return "Payment failed" }
        if spendCapState == .warning { return "Spend cap nearly reached" }
        return nil
    }

    public var tone: StatusTone {
        if startsBlocked || spendCapState == .reached || status == .pastDue { return .danger }
        if spendCapState == .warning { return .caution }
        return .neutral
    }

    /// What being blocked means, in one sentence, with the remedy attached.
    ///
    /// Anchored on the server's own `startBlockedMessage` and built only from
    /// fields the server actually sent — no price, tier or projection this
    /// client invented. Nil when nothing is blocked.
    ///
    /// The 402 refusal that arrives *after* a launch has its own copy in
    /// `FriendlyError.billingRefusalMessage`, built from that response's detail;
    /// this one is built from the account summary, which is what lets the app
    /// say it before the launch rather than after.
    public var startBlockedSentence: String? {
        guard startsBlocked else { return nil }
        guard let startBlockedReason else {
            // Blocked for a reason this build does not know. Say the part that
            // is certain and invent nothing about why.
            return "New pods can’t start on this account right now."
        }
        switch startBlockedReason {
        case .subscriptionRequired:
            return "Your workstation needs an active subscription before it can start."
        case .trialExpired:
            return "Your trial has ended; subscribe to start your workstation again."
        case .trialHoursExhausted:
            if let included = activeHoursIncluded {
                return "Your trial includes \(BillingSummary.hours(included)) active hours "
                    + "and they are used up; subscribe to continue."
            }
            return "Your trial hours are used up; subscribe to continue."
        case .paymentPastDue:
            return "Your last payment failed and the grace period has ended; update your "
                + "payment method to start again."
        case .spendCapReached:
            if let spendLimitUsd {
                return "Your monthly spend cap of \(BillingSummary.money(spendLimitUsd)) is "
                    + "reached; raise it to start your workstation again."
            }
            return "Your monthly spend cap is reached; raise it to start your workstation "
                + "again."
        }
    }

    private var confirmedHours: Double? {
        if let seconds = billableActiveSeconds { return seconds / 3600 }
        return activeHoursUsed
    }

    private var confirmedLabel: String {
        billableActiveSeconds != nil ? "confirmed hours this period" : "active hours this period"
    }

    private var activeHoursSegment: String? {
        switch (confirmedHours, activeHoursIncluded) {
        case (let used?, let included?):
            return "\(BillingSummary.hours(used)) of \(BillingSummary.hours(included)) \(confirmedLabel)"
        case (let used?, nil):
            return billableActiveSeconds != nil
                ? "\(BillingSummary.hours(used)) confirmed hours this period"
                : "\(BillingSummary.hours(used)) active hours this period"
        case (nil, let included?):
            return "\(BillingSummary.hours(included)) active hours included"
        default:
            return nil
        }
    }

    private var unknownHoursSegment: String? {
        guard let seconds = unknownActiveSeconds, seconds > 0 else { return nil }
        return "unconfirmed \(BillingSummary.hours(seconds / 3600)) h"
    }

    private var spendSegment: String? {
        guard let spendLimitUsd else { return nil }
        return "spend cap \(BillingSummary.money(spendLimitUsd))"
    }

    /// The trial note belongs to a trial in progress: the status says whether
    /// this workstation is trialing, the date says when that ends. A trial end
    /// date beside any other status is bookkeeping, not news, and renders
    /// nothing.
    private var trialSegment: String? {
        guard status == .trialing else { return nil }
        if let trialEndsAt { return "trial ends \(Format.shortDay(trialEndsAt))" }
        return "trial"
    }

    private var periodSegment: String? {
        guard let periodEnd else { return nil }
        return "period ends \(Format.shortDay(periodEnd))"
    }

    /// `12.4`, `60` — one decimal at most, and never a trailing `.0`.
    static func hours(_ value: Double) -> String {
        if value == value.rounded(), abs(value) < 1e15 { return String(Int(value)) }
        return String(format: "%.1f", value)
    }

    /// `$50`, `$3.20` — the sent value, formatted, never converted or projected.
    static func money(_ value: Double) -> String {
        if value == value.rounded(), abs(value) < 1e15 { return "$\(Int(value))" }
        return String(format: "$%.2f", value)
    }

    /// Integer cents the server sent, as dollars for display. Scaling by 100
    /// is a unit change, not a computation.
    static func usd(cents value: JSONValue?) -> Double? {
        guard let cents = number(value) else { return nil }
        return cents / 100
    }

    // MARK: - Parsing

    /// Parses the flat `workstation` object. Nil when it is absent, is not an
    /// object, or holds nothing this build can render — all three are the same
    /// thing to a reader, and all three hide the surface.
    public static func parse(_ value: JSONValue?) -> BillingSummary? {
        guard let value, case .object = value else { return nil }

        let summary = BillingSummary(
            planName: text(value["planName"]) ?? text(value["planKey"]),
            activeHoursUsed: number(value["activeHoursUsed"]),
            activeHoursIncluded: number(value["includedActiveHours"]),
            spendLimitUsd: usd(cents: value["spendCapUsdCents"]),
            spendCapState: enumValue(value["spendCapState"], SpendCapState.self),
            status: enumValue(value["status"], BillingStatus.self),
            trialEndsAt: timestamp(value["trialEndsAt"]),
            periodEnd: timestamp(value["currentPeriodEnd"]),
            startsBlocked: value["startsBlocked"]?.boolValue ?? false,
            startBlockedReason: enumValue(
                value["startBlockedReason"], StartBlockedReason.self
            ),
            billableActiveSeconds: number(value["billableActiveSeconds"]),
            unknownActiveSeconds: number(value["unknownActiveSeconds"])
        )
        return summary.isEmpty ? nil : summary
    }

    /// Bounded, and rendered as data: never as markup or a format string.
    static func text(_ value: JSONValue?) -> String? {
        guard let raw = value?.stringValue else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 64, !trimmed.contains("\n") else { return nil }
        return trimmed
    }

    /// Non-negative and finite. `used` may exceed `included` — that is overage,
    /// not corruption — but NaN, infinity and negatives are dropped rather
    /// than shown.
    static func number(_ value: JSONValue?) -> Double? {
        guard let raw = value?.doubleValue, raw.isFinite, raw >= 0 else { return nil }
        return raw
    }

    static func timestamp(_ value: JSONValue?) -> Date? {
        guard let text = value?.stringValue else { return nil }
        return Format.date(text)
    }

    /// An enum value this build does not know is ignored; the numbers beside it
    /// still render.
    static func enumValue<T: RawRepresentable>(
        _ value: JSONValue?, _ type: T.Type
    ) -> T? where T.RawValue == String {
        guard let raw = value?.stringValue else { return nil }
        return T(rawValue: raw)
    }
}

/// Checkout and portal answers. `trial` is only on checkout.
public struct BillingURLSession: Codable, Hashable, Sendable {
    public let url: String
    public let trial: Bool?
}
