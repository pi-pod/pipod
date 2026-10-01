import SwiftUI

/// The plan-change flow: preview a priced quote, review it, and confirm it.
///
/// The controller owns the quote lifecycle so the rules cannot drift between
/// call sites: confirming sends the reviewed quote's id and nothing else, a
/// network loss or an unknown outcome retries that same id even past its
/// expiry, and a stale, expired or failed (402) quote is dropped — the user
/// reviews a fresh preview and consents again, never auto-confirming a price
/// they did not see and never replaying a failed id. A 200 is not success on
/// its own: the grant is `applied == true` AND the account showing the target
/// (active or pending) — a missing `applied` never grants. After a process
/// death the account's open `applying` quote resumes by the same id.
@MainActor
@Observable
final class PlanChangeController {
    private let api: APIClient

    /// The account truth the entry row was gated on, re-read after every
    /// confirm: pending and cancellation state come from here, authoritatively.
    var eligibility: PlanChangeEligibility?
    var didLoad = false

    var target: PlanChangePlan = .pro
    /// The quote under review. Confirming is only possible while this is set,
    /// which is what makes the consent explicit: no quote, no confirm.
    var quote: PlanChangeQuote?
    var isWorking = false
    var status: StatusMessage?
    var succeeded = false
    /// A confirm with an unknown outcome (network loss, 5xx, a 200 without
    /// `applied` or whose account still shows the old plan, or a 409
    /// `plan_change_effect_unknown`) may be retried with the same quote id —
    /// the quote is kept across the re-read even when eligibility reads off.
    /// Anything refused or failed needs a new preview instead.
    var canRetrySameQuote = false

    init(api: APIClient) {
        self.api = api
    }

    var canChangePlan: Bool { eligibility?.canChangePlan == true }

    /// The account's open quote, if any. While it is `applying`, the picker
    /// stays shut: only confirming this same id may proceed, never a fresh
    /// preview — this is the authoritative resume after a process death.
    var openQuote: PlanChangeOpenQuote? { eligibility?.openPlanChange }
    /// Resume when the server says so (`canResumePlanChange`) or when the open
    /// quote itself is applying — the two agree on current servers, and either
    /// alone resumes on older ones.
    var needsResume: Bool { eligibility?.needsResume == true }

    /// Whether the picked target differs from the current plan. Previewing a
    /// move to the plan already held is meaningless, so the review button stays
    /// off rather than fetching a quote that changes nothing.
    var targetDiffersFromCurrent: Bool {
        guard let current = eligibility?.currentPlanKey?.lowercased() else { return true }
        return current != target.rawValue
    }

    func load() async {
        defer { didLoad = true }
        do {
            eligibility = PlanChangeEligibility.parse(try await api.billingAccount())
        } catch {
            // 404 is the static backend answering "there is no billing here";
            // any other failure just means the flag is unknown right now. Both
            // omit the surface rather than guessing it into existence.
            eligibility = PlanChangeEligibility(canChangePlan: false)
        }
    }

    /// Fetches a fresh quote for the picked target, dropping whatever was
    /// under review: a review always names the newest price, never an older one.
    /// Refused while an earlier quote is still applying — that id must be
    /// confirmed, not replaced by a new price. A 409 `plan_change_in_flight`
    /// from the server means the same thing: the account is re-read so the
    /// resume section appears with the authoritative open id.
    func preview() async {
        guard !isWorking else { return }
        if needsResume {
            status = .failure(
                "A plan change is still being applied — resume that confirmation "
                    + "instead of starting a new price."
            )
            return
        }
        isWorking = true
        status = nil
        succeeded = false
        quote = nil
        canRetrySameQuote = false
        defer { isWorking = false }
        do {
            quote = try await api.previewPlanChange(plan: target)
        } catch let error as APIError {
            if PlanChangeFailure.classify(error) == .inFlight {
                // An earlier confirm is still applying: re-read the account so
                // the open quote (the id to resume) is authoritative, then
                // point at it instead of the refused preview.
                await refreshAccount()
                status = .failure(PlanChangeFailure.inFlight.message)
            } else {
                status = .failure(FriendlyError.planChangeMessage(error) ?? FriendlyError.message(error))
            }
        } catch {
            status = .failure(FriendlyError.message(error))
        }
    }

    func cancelReview() {
        quote = nil
        canRetrySameQuote = false
        status = nil
    }

    /// Returns to the picker after a confirmation, keeping the re-read account.
    func startOver() {
        quote = nil
        succeeded = false
        canRetrySameQuote = false
        status = nil
    }

    /// Confirms the quote under review. A missing quote is a missing consent
    /// and does nothing — notably after a stale refusal cleared it.
    func confirm() async {
        guard !isWorking, let reviewed = quote else { return }
        await runConfirm(quoteId: reviewed.quoteId, expectedTargetPlan: reviewed.targetPlan)
    }

    /// Resumes the account's applying quote after an interruption: the same
    /// quote id the server reports, never a fresh preview.
    func confirmResume() async {
        guard !isWorking, let open = openQuote, open.isApplying else { return }
        await runConfirm(quoteId: open.quoteId, expectedTargetPlan: open.targetPlan)
    }

    private func runConfirm(quoteId: String, expectedTargetPlan: String?) async {
        isWorking = true
        status = nil
        canRetrySameQuote = false
        defer { isWorking = false }
        do {
            let result = try await api.confirmPlanChange(quoteId: quoteId)
            await refreshAccount()
            // The wire sends `{ applied, ...quote, account }`: success is
            // `applied == true` AND the account showing the target — the
            // active plan for an immediate change, the pending plan for a
            // period-end one. A 200 with a missing/false `applied`, or one
            // that leaves the old plan with nothing pending, is
            // plan_change_not_applied, never a grant.
            let target = expectedTargetPlan ?? result.quote.targetPlan
            if result.applied, isCorroborated(targetPlan: target, snapshot: result.eligibility) {
                succeeded = true
                status = .success(
                    "Change confirmed. The server is the source of truth — your plan "
                        + "updates once the change applies."
                )
            } else {
                canRetrySameQuote = true
                status = .failure(PlanChangeFailure.notApplied.message)
            }
        } catch let error as APIError {
            await refreshAccount()
            if let failure = PlanChangeFailure.classify(error) {
                if failure.requiresNewPreview {
                    // The price moved or the quote failed: the old id is dead
                    // and must not be confirmed at any price, so it is
                    // dropped. Only a fresh preview plus a fresh tap on
                    // Confirm may proceed — a failed id is never replayed.
                    // `plan_change_effect_unknown` never lands here: its
                    // effect is unknown (a possible paid effect), so the quote
                    // stays for a same-id retry even when the re-read
                    // eligibility reads off.
                    quote = nil
                } else if failure.retrySameQuoteAllowed {
                    canRetrySameQuote = true
                }
                status = .failure(failure.message)
            } else {
                // 5xx / unknown: the quote stays applying. Retrying replays
                // the same id even if expiresAt passed — a retry never mints
                // a new price.
                canRetrySameQuote = true
                status = .failure(FriendlyError.message(error))
            }
        } catch {
            // A transport failure leaves the quote alive: retrying replays the
            // same quote id rather than minting a new price.
            canRetrySameQuote = true
            status = .failure(FriendlyError.message(error))
        }
    }

    /// Whether the account corroborates the confirmed target: the active plan
    /// for an immediate change, the pending plan for a period-end one. The
    /// re-read is authoritative; the snapshot that rode the confirm response
    /// covers a re-read that failed and kept last-known truth.
    private func isCorroborated(targetPlan: String, snapshot: PlanChangeEligibility?) -> Bool {
        let want = targetPlan.lowercased()
        for account in [eligibility, snapshot] {
            guard let account else { continue }
            if account.currentPlanKey?.lowercased() == want { return true }
            if account.pendingPlanKey?.lowercased() == want { return true }
        }
        return false
    }

    private func refreshAccount() async {
        do {
            eligibility = PlanChangeEligibility.parse(try await api.billingAccount())
        } catch {
            // The confirm already answered; a failed re-read keeps the last
            // known account rather than blanking pending truth.
        }
    }
}

/// The Change-plan screen, pushed from Settings. Gated on `canChangePlan`,
/// except while an earlier quote is still applying: then the screen resumes
/// that same quote id instead of vanishing.
public struct PlanChangeView: View {
    @Environment(\.apiClient) private var api

    @State private var controller: PlanChangeController?

    public init() {}

    public var body: some View {
        Group {
            if let controller {
                PlanChangeBody(controller: controller)
            } else {
                LoadingView(label: "Loading billing account…")
                    .task {
                        let created = PlanChangeController(api: api)
                        controller = created
                        await created.load()
                    }
            }
        }
        .navigationTitle("Change plan")
    }
}

private struct PlanChangeBody: View {
    let controller: PlanChangeController

    var body: some View {
        List {
            if !controller.didLoad {
                Section {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Loading billing account…")
                            .font(.subheadline)
                            .foregroundStyle(AppColors.secondaryLabel)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            } else if controller.succeeded {
                successSection
            } else if controller.needsResume {
                // An applying open quote: confirm this same id, never a new
                // preview — even though canChangePlan reads false. This is
                // the authoritative resume after an interrupted confirmation.
                resumeSection
            } else if !controller.canChangePlan {
                Section {
                    EmptyStateView(
                        title: "Plan changes unavailable",
                        message: "Plan changes are not available on this account right now.",
                        systemImage: "creditcard"
                    )
                }
            } else if controller.succeeded {
                successSection
            } else if controller.quote == nil {
                pickerSection
            } else {
                reviewSection
            }

            if let status = controller.status {
                Section { StatusBanner(status) }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await controller.load() }
    }

    // MARK: - Resume an applying quote

    @ViewBuilder
    private var resumeSection: some View {
        Section {
            Label("A change is still being applied", systemImage: "hourglass")
                .font(.headline)
                .foregroundStyle(AppColors.label)
            if let target = controller.openQuote?.targetPlan, !target.isEmpty {
                DetailRow("To", value: target.capitalized)
            }
            Text(
                "Confirming resumes this same quote — it never starts a new "
                    + "price, even if the quote's expiry passed."
            )
            .font(.footnote)
            .foregroundStyle(AppColors.secondaryLabel)
            Button {
                Task { await controller.confirmResume() }
            } label: {
                if controller.isWorking {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Resuming…").frame(maxWidth: .infinity)
                    }
                } else {
                    Text("Resume confirmation").frame(maxWidth: .infinity)
                }
            }
            .brandProminent()
            .disabled(controller.isWorking)
            .accessibilityLabel("Resume plan change confirmation")
            .accessibilityIdentifier("Resume plan change")
            Button {
                Task { await controller.load() }
            } label: {
                Text("Refresh status").frame(maxWidth: .infinity)
            }
            .disabled(controller.isWorking)
            .accessibilityIdentifier("Refresh plan change status")
            if controller.canRetrySameQuote {
                Text(
                    "The last attempt did not go through, so this quote is still "
                        + "open. Retrying confirms this same quote — never a new price."
                )
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)
            }
        } footer: {
            Text("This is the account's open quote — the authoritative resume after an interrupted confirmation.")
        }
    }

    // MARK: - Pick a target

    @ViewBuilder
    private var pickerSection: some View {
        Section {
            ForEach(PlanChangePlan.allCases, id: \.self) { plan in
                Button {
                    controller.target = plan
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(plan.displayName)
                                .foregroundStyle(AppColors.label)
                            if controller.eligibility?.currentPlanKey?.lowercased() == plan.rawValue {
                                Text("Your current plan")
                                    .font(.footnote)
                                    .foregroundStyle(AppColors.secondaryLabel)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if controller.target == plan {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(AppColors.accent)
                                .accessibilityHidden(true)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .frame(minHeight: 44)
                .accessibilityLabel("Move to \(plan.displayName)")
                .accessibilityIdentifier("Plan target \(plan.rawValue)")
            }
        } header: {
            Text("New plan")
        } footer: {
            if !controller.targetDiffersFromCurrent {
                Text("This is your current plan — pick the other one to see its price.")
            } else {
                Text("Reviewing fetches the server's priced quote. Nothing changes until you confirm it.")
            }
        }

        Section {
            Button {
                Task { await controller.preview() }
            } label: {
                if controller.isWorking {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Fetching quote…").frame(maxWidth: .infinity)
                    }
                } else {
                    Text("Review change").frame(maxWidth: .infinity)
                }
            }
            .brandProminent()
            .disabled(controller.isWorking || !controller.targetDiffersFromCurrent)
            .accessibilityLabel("Review plan change")
            .accessibilityIdentifier("Review plan change")
        }
    }

    // MARK: - Review the quote

    @ViewBuilder
    private var reviewSection: some View {
        if let quote = controller.quote {
            PlanChangeReviewCard(quote: quote)

            Section {
                Button {
                    Task { await controller.confirm() }
                } label: {
                    if controller.isWorking {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Confirming…").frame(maxWidth: .infinity)
                        }
                    } else {
                        Text("Confirm change to \(quote.targetPlan.capitalized)")
                            .frame(maxWidth: .infinity)
                    }
                }
                .brandProminent()
                .disabled(controller.isWorking)
                .accessibilityLabel("Confirm plan change")
                .accessibilityIdentifier("Confirm plan change")

                Button(role: .cancel) {
                    controller.cancelReview()
                } label: {
                    Text("Cancel").frame(maxWidth: .infinity)
                }
                .disabled(controller.isWorking)
                .accessibilityIdentifier("Cancel plan review")
            }

            if controller.canRetrySameQuote {
                Section {
                    Text(
                        "The last attempt did not go through, so this quote is still open. "
                            + "Retrying confirms this same quote — never a new price."
                    )
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
                }
            }
        }
    }

    // MARK: - Confirmed

    @ViewBuilder
    private var successSection: some View {
        Section {
            Label("Change confirmed", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(AppColors.label)
            if let note = controller.eligibility?.pendingNote {
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
            Button {
                controller.startOver()
            } label: {
                Text("Start another change").frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("Start another plan change")
        } footer: {
            Text("Your plan line updates once the server applies the change.")
        }
    }
}

/// The priced quote under review: what confirming charges and when it lands.
///
/// A standalone view so the two timings preview without networking: the
/// immediate upgrade shows due-now plus immediacy and the recurring monthly
/// price (never "free"), the period-end downgrade shows nothing-due-now plus
/// the dated landing and next period's price.
struct PlanChangeReviewCard: View {
    let quote: PlanChangeQuote

    var body: some View {
        Section {
            DetailRow("From", value: quote.currentPlan.capitalized)
            DetailRow("To", value: quote.targetPlan.capitalized)
            DetailRow("Charge", value: quote.dueNowLine)
            DetailRow("Timing", value: quote.effectLine)
            if let next = quote.nextPeriodLine {
                DetailRow("Next period", value: next)
            }
            if let expiry = quote.expiryLine {
                Text(expiry)
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
        } header: {
            Text("Review this price")
        } footer: {
            // The ongoing month is always a priced month — the recurring base
            // on an upgrade — so confirming can never read as a free month.
            Text("Confirming charges exactly what is shown above — nothing more, and nothing earlier.")
        }
    }
}

#Preview("Upgrade review — due now, immediate, recurring monthly price") {
    List {
        PlanChangeReviewCard(quote: PlanChangeQuote(
            quoteId: "preview",
            currentPlan: "standard",
            targetPlan: "pro",
            timing: .immediate,
            amountDueNowCents: 3028,
            nextPeriodAmountCents: 5000,
            currency: "usd",
            recurringAmountCents: 5000
        ))
    }
}

#Preview("Downgrade review — nothing now, dated period-end, next price") {
    List {
        PlanChangeReviewCard(quote: PlanChangeQuote(
            quoteId: "preview",
            currentPlan: "pro",
            targetPlan: "standard",
            timing: .periodEnd,
            amountDueNowCents: 0,
            nextPeriodAmountCents: 2000,
            currency: "usd",
            currentPeriodEnd: Date(timeIntervalSince1970: 1_759_721_600)
        ))
    }
}
