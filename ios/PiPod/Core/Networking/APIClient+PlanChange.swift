import Foundation

extension APIClient {
    /// The server's priced quote for moving to `plan`.
    ///
    /// The body carries the target plan and nothing else: amounts come back
    /// from Stripe under the preview boundary and the client never sends one.
    public func previewPlanChange(plan: PlanChangePlan) async throws -> PlanChangeQuote {
        let json = try await request(
            "POST", "billing/plan-change/preview",
            body: .object(["plan": .string(plan.rawValue)])
        )
        guard let quote = PlanChangeQuote.parse(json) else {
            throw APIError(error: "Unexpected plan-change preview response", detail: json)
        }
        return quote
    }

    /// Applies a quote the user explicitly confirmed.
    ///
    /// The body is the quote id and nothing else — no caller-selected plan —
    /// so a retry after a network loss replays the same quote id rather than
    /// minting a new price. The response is `{ applied, ...quote, account }`:
    /// `applied` is present on the wire and there is no hosted payment URL on
    /// this API. The grant is `applied == true` AND the account showing the
    /// target — `planKey` for an immediate change, `pendingPlanKey` for a
    /// period-end downgrade — read by the caller, which re-reads the account
    /// to corroborate what is true now. A missing `applied` never grants.
    public func confirmPlanChange(quoteId: String) async throws -> PlanChangeConfirmResult {
        let json = try await request(
            "POST", "billing/plan-change/confirm",
            body: .object(["quoteId": .string(quoteId)])
        )
        guard let quote = PlanChangeQuote.parse(json) else {
            throw APIError(error: "Unexpected plan-change confirm response", detail: json)
        }
        // The wire sends `applied` beside the quote and account. A missing
        // or false `applied` never grants, even when the account already
        // shows the target — the grant needs both.
        let applied = json["applied"]?.boolValue == true
        return PlanChangeConfirmResult(quote: quote, account: json["account"], applied: applied)
    }
}

/// What a confirm answered: the quote and the account snapshot that rode the
/// same response. Pending and cancellation truth still comes from a fresh `GET
/// /v1/billing/account` afterwards — this snapshot is what the server knew at
/// the moment it answered, not the last word.
///
/// `applied` rides the wire (`{ applied, ...quote, account }`) and is
/// required: success is `applied == true` AND the account showing the target
/// — `planKey` for an immediate change, `pendingPlanKey` for a period-end
/// downgrade. A 200 with a missing/false `applied`, or one that leaves the
/// old plan with nothing pending, is `plan_change_not_applied`, never a grant.
public struct PlanChangeConfirmResult: Sendable, Hashable {
    public let quote: PlanChangeQuote
    public let account: JSONValue?
    /// Wire grant flag, required alongside the account. Real 200s send it;
    /// a missing value parses as false and never grants.
    public let applied: Bool

    public init(quote: PlanChangeQuote, account: JSONValue?, applied: Bool = false) {
        self.quote = quote
        self.account = account
        self.applied = applied
    }

    public var eligibility: PlanChangeEligibility? {
        guard let account else { return nil }
        return PlanChangeEligibility.parse(account)
    }

    public static func == (lhs: PlanChangeConfirmResult, rhs: PlanChangeConfirmResult) -> Bool {
        lhs.quote == rhs.quote && lhs.account == rhs.account && lhs.applied == rhs.applied
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(quote)
        hasher.combine(account)
        hasher.combine(applied)
    }
}
