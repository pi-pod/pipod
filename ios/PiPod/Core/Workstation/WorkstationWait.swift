import Foundation
import Observation

/// What a caller learned by waiting.
public enum WorkstationWaitOutcome<Value>: Sendable where Value: Sendable {
    /// The original request finally succeeded. This is the only proof of
    /// readiness: the server's admission is authoritative, and a poll reporting
    /// `state: "running"` is a hint, not a guarantee.
    case succeeded(Value)
    /// The reason will not clear on its own. Nothing was polled.
    case terminal(WorkstationDemandDetail)
    /// The client's budget ran out. The workstation is still starting on the
    /// server; this is not a failure of the workstation.
    case budgetExhausted(WorkstationDemandDetail)
    /// The person ended the wait, or the screen went away. The workstation keeps
    /// starting and its files are retained.
    case cancelled
    /// The connection failed with the request already sent, and the request was
    /// not one that may be re-issued blindly (`WorkstationWaitPolicy.create`).
    /// The server may or may not have acted on it, so the wait stops and says
    /// so rather than risking a second create.
    case unconfirmed(Error)
    /// Something other than a workstation refusal came back.
    case failed(Error)
}

extension WorkstationWaitOutcome {
    /// The sentence a finished wait leaves on screen. Nil when it succeeded
    /// (there is nothing left to say) or failed (the error owns the copy).
    public var endingMessage: String? {
        switch self {
        case .succeeded, .failed:
            return nil
        case .cancelled:
            return FriendlyError.workstationWaitCancelled
        case .budgetExhausted:
            return FriendlyError.workstationStillStarting
        case .terminal(let detail):
            return FriendlyError.workstationMessage(detail)
        case .unconfirmed:
            return WorkstationWaitCopy.unconfirmed
        }
    }

    /// Whether waiting again is worth offering. A terminal reason is not, and
    /// neither is an outcome nobody can describe yet.
    public var canKeepWaiting: Bool {
        switch self {
        case .cancelled, .budgetExhausted: return true
        case .succeeded, .failed, .terminal, .unconfirmed: return false
        }
    }
}

/// Sentences that belong to the wait itself rather than to any one screen.
///
/// Not on `WorkstationWaitOutcome`: that type is generic, and a generic type
/// cannot hold a stored static.
public enum WorkstationWaitCopy {
    /// The connection dropped with a create already on the wire. Never "try
    /// again": the honest instruction is to look before acting, because the
    /// server may have done the work and only the answer was lost.
    public static let unconfirmed = """
        The connection dropped before the server answered, so this may or may not have gone \
        through. Check its current state before trying again — your workstation keeps \
        starting and your files are kept.
        """
}

/// Whether the request a wait re-issues may be sent again after the connection
/// failed with it already on the wire.
///
/// The wait's whole method is re-issuing the refused request, so this is the one
/// thing it has to be told about that request. A transport failure is not an
/// answer — the server may have committed the work and only the reply was lost —
/// so it is safe to repeat only when repeating is free.
public enum WorkstationWaitPolicy: Sendable, Hashable {
    /// A read, a poll, or a re-attach. Re-issuing it costs nothing, so a network
    /// hiccup during a multi-minute wait is ridden out.
    case idempotent
    /// A create or lifecycle mutation whose ambiguous result requires explicit
    /// reconciliation. Even when the caller has a stable operation ID, this wait
    /// stops instead of replaying until the caller checks that operation.
    case create
}

/// Thrown by an attempt that could not prove readiness but is not a failure —
/// a socket re-attach, whose answer arrives on the socket rather than as a
/// return value. The wait treats it as another unfinished cycle.
public struct WorkstationWaitPending: Error, Sendable {
    public init() {}
}

/// A live snapshot of the wait, for whatever is drawing it.
public struct WorkstationWaitProgress: Sendable, Hashable {
    public var detail: WorkstationDemandDetail
    public var elapsed: TimeInterval
    public var attempts: Int
    public var isCancelled: Bool

    public init(
        detail: WorkstationDemandDetail,
        elapsed: TimeInterval = 0,
        attempts: Int = 0,
        isCancelled: Bool = false
    ) {
        self.detail = detail
        self.elapsed = elapsed
        self.attempts = attempts
        self.isCancelled = isCancelled
    }

    /// The one sentence the wait is allowed to claim.
    public var message: String { detail.message }

    public var state: WorkstationState? { detail.state }
    public var operation: WorkstationOperation? { detail.operation }

    /// `starting · resume · command:activate` — the machine's own words, shown
    /// as a technical detail. Never a promise, never a countdown.
    public var technicalDetail: String? {
        var parts: [String] = []
        if let state { parts.append(state.label) }
        if let kind = operation?.kind { parts.append(kind.rawValue) }
        if let phase = operation?.phase { parts.append(phase) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    public var elapsedLabel: String { Format.elapsed(elapsed) }
}

/// One shared workstation wait, used by every call site that can be refused
/// because the caller's own workstation is not up yet: pod launch, the pods
/// list, pod detail, file and send paths, and the session attach.
///
/// The logic lives here rather than in a view so the clock, the sleeper and the
/// status endpoint can all be substituted, and so a ten-minute wait can be
/// tested in milliseconds.
@MainActor
@Observable
public final class WorkstationWait {
    /// Clamps from the client contract. `retryAfterMs` is the server's
    /// suggestion; these are the bounds a client is allowed to honour it within.
    public static let minimumInterval: TimeInterval = 5
    public static let maximumInterval: TimeInterval = 60
    public static let defaultInterval: TimeInterval = 10
    /// The default budget matches the server's own operation deadline.
    public static let defaultBudget: TimeInterval = 20 * 60
    public static let minimumBudget: TimeInterval = 60
    public static let maximumBudget: TimeInterval = 30 * 60

    public typealias StatusFetcher = @Sendable (String) async throws -> WorkstationStatus?
    public typealias Sleeper = @Sendable (TimeInterval) async throws -> Void

    public private(set) var progress: WorkstationWaitProgress
    public private(set) var isFinished = false

    private let statusFetcher: StatusFetcher?
    private let now: () -> Date
    private let sleeper: Sleeper
    private let budget: TimeInterval
    /// How often the wait re-renders while it is sleeping. A 700-second wait has
    /// to look alive, so a long interval is slept in slices rather than in one
    /// go — which is also what lets Cancel and "Check now" land promptly.
    private let progressTick: TimeInterval

    private let startedAt: Date
    private var cancelled = false
    private var checkNowRequested = false
    /// The task driving `run`, when the wait was started through `start`. Owned
    /// here so that one object ends both the loop and the work behind it: a
    /// screen that goes away has one thing to call, and cannot leave half of a
    /// wait running behind it.
    @ObservationIgnored private var task: Task<Void, Never>?

    public init(
        detail: WorkstationDemandDetail,
        status: StatusFetcher? = nil,
        now: @escaping () -> Date = Date.init,
        sleep: Sleeper? = nil,
        budget: TimeInterval = WorkstationWait.defaultBudget,
        progressTick: TimeInterval = 1
    ) {
        self.statusFetcher = status
        self.now = now
        self.sleeper = sleep ?? WorkstationWait.defaultSleeper
        self.budget = budget
        self.progressTick = max(0.01, progressTick)
        self.startedAt = now()
        self.progress = WorkstationWaitProgress(detail: detail)
    }

    private static let defaultSleeper: Sleeper = { seconds in
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }

    public var detail: WorkstationDemandDetail { progress.detail }

    /// Ends this client's wait only. The workstation keeps starting on the
    /// server, its files are retained, and the same action later attaches to the
    /// same workstation.
    ///
    /// Cooperative on purpose: the loop finishes its cycle and reports
    /// `.cancelled`, so the screen that asked can say what happened.
    public func cancel() {
        guard !cancelled else { return }
        cancelled = true
        progress.isCancelled = true
    }

    /// Ends the wait *and* the work driving it, with nobody left to tell.
    ///
    /// For a screen that went away or an answer that arrived another way: unlike
    /// `cancel()`, the completion handed to `start` never runs, so a finished
    /// wait cannot navigate or write state on behalf of a screen the reader has
    /// already left.
    public func abandon() {
        cancel()
        task?.cancel()
        task = nil
    }

    /// Runs the wait on a task the wait itself owns and reports the outcome on
    /// the main actor.
    ///
    /// The alternative — every screen spawning its own `Task` — is how a wait
    /// ends up outliving the screen that started it, still re-issuing the
    /// request behind the reader's back. One object owns the loop, the task and
    /// the cancellation.
    public func start<Value: Sendable>(
        policy: WorkstationWaitPolicy = .idempotent,
        attempt: @escaping () async throws -> Value,
        completion: @escaping (WorkstationWaitOutcome<Value>) -> Void
    ) {
        guard task == nil else { return }
        task = Task { [weak self] in
            guard let self else { return }
            let outcome = await self.run(policy: policy, attempt: attempt)
            guard !Task.isCancelled else { return }
            completion(outcome)
        }
    }

    /// Skips the rest of the current interval. The next cycle runs immediately.
    public func checkNow() { checkNowRequested = true }

    /// Adopts a fresher refusal for a wait already in flight — a second 503, or
    /// a second 4420 — without restarting the clock or the attempt count.
    public func adopt(_ detail: WorkstationDemandDetail) {
        progress.detail = detail
    }

    /// Runs the wait: poll the durable status when a host id is known, and
    /// re-issue the original request every cycle, because only the server's
    /// admission proves the workstation is usable.
    public func run<Value: Sendable>(
        policy: WorkstationWaitPolicy = .idempotent,
        attempt: @escaping () async throws -> Value
    ) async -> WorkstationWaitOutcome<Value> {
        defer { isFinished = true }

        guard progress.detail.retryable else { return .terminal(progress.detail) }
        // Computed once, from the first refusal: re-adopting a refreshed
        // deadlineAt every cycle would let a stale value re-arm the budget
        // forever, and the wait must stay bounded. A budget that runs out is
        // honest about it — the workstation keeps starting, and the same
        // action later attaches to it.
        let deadline = self.deadline()

        while true {
            if cancelled || Task.isCancelled { return .cancelled }
            if now() >= deadline { return .budgetExhausted(progress.detail) }

            do {
                try await waitOneInterval(until: deadline)
            } catch {
                return .cancelled
            }
            if cancelled || Task.isCancelled { return .cancelled }

            await pollStatus()
            // Cancellation or budget expiry can happen while the status request
            // is in flight. Never admit a create after either boundary.
            if cancelled || Task.isCancelled { return .cancelled }
            if now() >= deadline { return .budgetExhausted(progress.detail) }

            progress.attempts += 1
            refreshElapsed()
            do {
                return .succeeded(try await attempt())
            } catch let pending as WorkstationWaitPending {
                _ = pending
            } catch let apiError as APIError {
                guard let refreshed = WorkstationDemandDetail.parse(apiError) else {
                    if policy == .create, Self.isAmbiguousCreateError(apiError) {
                        return .unconfirmed(apiError)
                    }
                    return .failed(apiError)
                }
                progress.detail = refreshed
                if !refreshed.retryable { return .terminal(refreshed) }
            } catch {
                if Task.isCancelled { return .cancelled }
                if policy == .create, Self.isAmbiguousCreateError(error) {
                    return .unconfirmed(error)
                }
                // A dropped connection during a multi-minute wait is a network
                // hiccup, not an answer about the workstation, so the wait keeps
                // its schedule; the budget still bounds it. Anything that is not
                // a transport failure is a real answer and ends the wait.
                guard let transport = NetworkFailure.tryParse(error) else {
                    return .failed(error)
                }
                if transport == .cancelled { return .cancelled }
                // …unless the request cannot be repeated. The server may have
                // committed a create whose answer was lost, and a second one is
                // a second pod — worse than stopping and saying so.
                if policy == .create { return .unconfirmed(error) }
            }
        }
    }

    // MARK: - Schedule

    /// A create response without a trustworthy refusal may have committed the
    /// pod before the phone lost its answer. Stop instead of reissuing it.
    static func isAmbiguousCreateError(_ error: Error) -> Bool {
        if error is AuthContextChangedError { return true }
        if let apiError = error as? APIError {
            guard let status = apiError.transportStatus else { return true }
            return status == 408 || status >= 500
        }
        if error is DecodingError { return true }
        if error is URLError { return true }
        return (error as NSError).domain == NSURLErrorDomain
    }

    /// The server's own operation deadline when it sent one, clamped so a stale
    /// or absurd value cannot make the wait instant or endless.
    func deadline() -> Date {
        let start = now()
        guard let operationDeadline = progress.detail.operation?.deadlineAt else {
            return start.addingTimeInterval(budget)
        }
        let remaining = operationDeadline.timeIntervalSince(start)
        let clamped = min(
            max(remaining, WorkstationWait.minimumBudget), WorkstationWait.maximumBudget
        )
        return start.addingTimeInterval(clamped)
    }

    /// `retryAfterMs` when the server sent one, clamped to [5 s, 60 s]; 10 s
    /// otherwise.
    var interval: TimeInterval {
        guard let milliseconds = progress.detail.retryAfterMs else {
            return WorkstationWait.defaultInterval
        }
        let seconds = TimeInterval(milliseconds) / 1000
        return min(max(seconds, WorkstationWait.minimumInterval), WorkstationWait.maximumInterval)
    }

    private func waitOneInterval(until deadline: Date) async throws {
        checkNowRequested = false
        var remaining = interval
        while remaining > 0 {
            if cancelled || Task.isCancelled { throw CancellationError() }
            if checkNowRequested { return }
            let slice = min(remaining, progressTick)
            try await sleeper(slice)
            remaining -= slice
            refreshElapsed()
            if now() >= deadline { return }
        }
    }

    private func refreshElapsed() {
        progress.elapsed = max(0, now().timeIntervalSince(startedAt))
    }

    /// The durable status, when a validated host id is known. Its answer only
    /// refines what is on screen — the attempt that follows is what decides.
    private func pollStatus() async {
        guard let statusFetcher, let hostId = progress.detail.hostId else { return }
        guard let status = try? await statusFetcher(hostId) else { return }
        progress.detail = WorkstationDemandDetail(
            serverMessage: progress.detail.serverMessage,
            reason: progress.detail.reason,
            retryable: progress.detail.retryable,
            hostId: progress.detail.hostId,
            state: status.state ?? progress.detail.state,
            retryAfterMs: progress.detail.retryAfterMs,
            operation: status.operation ?? progress.detail.operation
        )
    }
}
