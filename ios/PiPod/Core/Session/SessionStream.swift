import Foundation
import Observation

/// The narrow session-only API surface, so lifecycle and replay tests use fakes
/// without a real HTTP server.
public protocol SessionAPI: AnyObject, Sendable {
    func pod(id: String) async throws -> Pod
    func conversationEvents(
        podId: String, before: String?, limit: Int
    ) async throws -> ConversationEventsPage
    func wsTicket(podId: String) async throws -> WsTicket
    func queuePrompt(
        podId: String, text: String, requestID: String, model: String?
    ) async throws -> QueuedPromptReceipt
    func queuedPrompt(podId: String, requestID: String) async throws -> QueuedPromptReceipt?
    /// The durable workstation status, for a wait that knows a host id. A server
    /// without the route answers nil, which is why this has a default.
    func workstationStatus(hostId: String) async throws -> WorkstationStatus?
}

extension SessionAPI {
    public func workstationStatus(hostId: String) async throws -> WorkstationStatus? { nil }
    public func queuedPrompt(podId: String, requestID: String) async throws -> QueuedPromptReceipt? { nil }
}

extension APIClient: SessionAPI {}

public typealias SessionTransportFactory = @MainActor (
    _ podId: String, _ fromSeq: Int?, _ fromSessionId: String?
) -> SessionTransport

/// Owns ticket minting, resumable attach and replay, transcript reduction, and
/// reconnect.
///
/// Session boundaries append a status divider; they never clear the transcript.
/// The reducer is deliberately separate from the view: replay, reconnect and
/// out-of-order delivery are protocol problems, and solving them inside a
/// SwiftUI body would make them untestable.
@MainActor
@Observable
public final class SessionStream: ModelSelecting {
    // MARK: - Identity

    public let podId: String

    /// Extension-owned TUI surfaces rendered in the pod. Empty unless the pod
    /// runs an extension that opens one.
    @ObservationIgnored public let remoteUI = RemoteUIStore()

    /// What pi has spent in this pod's session, refreshed while attached.
    @ObservationIgnored public let usage = SessionUsageTracker()

    // MARK: - Observable state

    public private(set) var items: [StreamItem] = []
    /// Questions pi is waiting on, oldest first.
    public private(set) var openDialogs: [PiDialog] = []
    public private(set) var availableModels: [ModelChoice] = []
    public private(set) var availableThinkingLevels: [String] = []

    public private(set) var isConnected = false
    public private(set) var reconnecting = false
    public private(set) var reconnectAttempt = 0
    public private(set) var isOffline = false
    public private(set) var isRunning = false
    public private(set) var isInterrupting = false

    /// Bumped whenever the transcript changed in a way that should scroll.
    public private(set) var scrollRevision = 0
    /// True when the change was a streaming delta: the view jumps rather than
    /// animating, because animating many times a second judders.
    public private(set) var scrollIsStreamingUpdate = false

    /// The last model and thinking snapshot the server confirmed. Pending
    /// choices stay separate so the composer never sends a prompt under an
    /// unconfirmed model.
    public private(set) var currentModel: ModelChoice?
    public private(set) var pendingModel: ModelChoice?
    public private(set) var currentThinkingLevel: String?
    public private(set) var pendingThinkingLevel: String?
    /// True when a disconnect/error or a mismatching snapshot needs an explicit
    /// status check before the user chooses how to proceed.
    public private(set) var selectionNeedsAttention = false
    /// Set only by the gateway's typed credential-reconnect refusal; a blank
    /// model catalog is not enough to conclude that credentials are missing.
    public private(set) var credentialSettingsNeeded = false
    /// Text submitted by remote editors while model selection was unresolved.
    /// They are surfaced in the normal composer and never auto-sent later.
    public private(set) var blockedPromptDrafts: [String] = []
    /// A cold attach saw a cached editor submit whose execution could not be
    /// established. Recover it for review, never as an automatic send.
    public private(set) var editorSnapshotDrafts: [String] = []

    /// True after the first models catalog. Until then the model and thinking
    /// level are unset — `hello`'s stale defaults are ignored — so the UI shows
    /// a neutral placeholder instead of a wrong model name.
    public private(set) var hasModelSnapshot = false

    public private(set) var preparingPod: Pod?
    public private(set) var podRecord: Pod?
    public private(set) var isLoadingHistory = true
    public private(set) var sessionEnded = false
    public private(set) var sessionEndedMessage = ""
    public private(set) var historyLoadFailed = false
    public private(set) var podUnavailable = false
    /// `"stopped"` or `"archived"` while the pod is asleep, otherwise nil.
    public private(set) var asleep: String?
    public private(set) var waking = false

    /// Live while the caller's own personal workstation is coming up. This is
    /// not an asleep pod: no keystroke wakes it, it takes minutes rather than
    /// seconds, and nothing is lost while it starts.
    public private(set) var workstationWait: WorkstationWait?
    /// What a finished workstation wait left to say — cancelled, out of budget,
    /// or a reason that will not clear.
    public private(set) var workstationNotice: String?
    /// Whether waiting again could still work. False for a terminal reason.
    public private(set) var workstationCanKeepWaiting = false

    public private(set) var error: String?
    /// Raw gateway text, retained only so a banner can apply the same
    /// presentation boundary the stream did.
    public private(set) var gatewayError: String?

    /// Working-state overrides pushed by a pod extension through remote-UI
    /// control frames. They stand in for the app's own defaults while set.
    public private(set) var workingMessage: String?
    public private(set) var workingVisible = false
    public private(set) var workingIndicator: String?
    public private(set) var hiddenThinkingLabel: String?

    /// Tool cards the user has opened, keyed as in `TranscriptPresentation`.
    public private(set) var expandedToolDetails: Set<String> = []

    /// A live rename from a `pod_updated` frame. `Pod` is immutable, so the new
    /// name is held beside the record and a background refresh reconciles it.
    public private(set) var renamedPodName: String?

    public var podName: String? { renamedPodName ?? podRecord?.name }

    // MARK: - Model switches

    @ObservationIgnored private var modelBeforePending: ModelChoice?
    @ObservationIgnored private var thinkingBeforePending: String?
    @ObservationIgnored private var lastPendingModelSnapshot: ModelChoice?
    @ObservationIgnored private var pendingModelMismatchCount = 0
    @ObservationIgnored private var lastPendingThinkingSnapshot: String?
    @ObservationIgnored private var pendingThinkingMismatchCount = 0
    @ObservationIgnored private var pendingSelectionRequestID: String?
    @ObservationIgnored private var allowUncorrelatedSelectionConfirmation = false
    public private(set) var isModelSwitchInFlight = false
    public private(set) var isThinkingSwitchInFlight = false

    // MARK: - Injected collaborators

    @ObservationIgnored private var api: SessionAPI?
    @ObservationIgnored private let socketFactory: SessionTransportFactory
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let reconnectDelay: (Int) -> TimeInterval

    // MARK: - Internal reducer state

    @ObservationIgnored private var socket: SessionTransport?
    @ObservationIgnored private var lastSeq: Int
    @ObservationIgnored private var currentSessionId: String?
    @ObservationIgnored private var connectionGeneration = 0
    @ObservationIgnored private var shouldReconnect = false
    @ObservationIgnored private var syntheticId = -1
    @ObservationIgnored private var seenEventIds: Set<String> = []
    @ObservationIgnored private var activeAssistantItemId: String?
    @ObservationIgnored private var toolItemIds: [String: String] = [:]
    /// Image turns parked while offline or preparing, keyed by item id so a
    /// retry, reconnect flush or discard finds the bytes the bubble shows.
    @ObservationIgnored private var pendingAttachments: [String: [StreamImageAttachment]] = [:]
    /// Text prompts currently awaiting the REST queue response. A disconnect
    /// cannot turn these into retryable failures: the server may already have
    /// inserted the row.
    @ObservationIgnored private var seenQueuedPromptIDs: Set<String> = []
    /// Stable queue UUID -> local/transcript item ID, retained across gateway
    /// session replacement so echoes reconcile by durable identity, not text.
    @ObservationIgnored private var queuedPromptItemIDs: [String: String] = [:]
    @ObservationIgnored private var streaming = false
    @ObservationIgnored private var compacting = false
    @ObservationIgnored private var awaitingReply = false
    @ObservationIgnored private var replayThroughSeq = 0
    @ObservationIgnored private var toolsExpandedByExtension = false
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var workstationTask: Task<Void, Never>?
    /// The typed detail from the `error` frame the gateway sends immediately
    /// before close code 4420, held until that close arrives.
    @ObservationIgnored private var pendingWorkstationDemand: WorkstationDemandDetail?
    @ObservationIgnored private var preparationTask: Task<Void, Never>?
    /// Only clear our own transient poll error; a later gateway failure must win.
    @ObservationIgnored private var preparationRefreshError: String?
    @ObservationIgnored private var openTask: Task<Void, Never>?
    /// When the transport last delivered anything. A socket that stopped
    /// answering looks connected until something notices the silence.
    @ObservationIgnored private var lastInboundAt: Date?
    /// The highest seq already announced as skipped, so a `replay_gap` frame and
    /// a truncated `firstAvailableSeq` do not both report the same hole.
    @ObservationIgnored private var announcedGapThroughSeq = 0
    /// Streamed shell output so far, keyed by `bash_execution_update`'s id.
    @ObservationIgnored private var bashOutput: [String: String] = [:]
    /// Bash ids whose post-attach snapshot has already been taken. The gateway
    /// replays one cumulative snapshot per running command after every hello;
    /// every frame after that is an increment.
    @ObservationIgnored private var bashSnapshotAdopted: Set<String> = []
    /// Outgoing turns the gateway has, or may have, persisted: everything this
    /// client put on a socket, plus everything the durable queue accepted. Their
    /// echo may arrive in a replay rather than live.
    @ObservationIgnored private var serverBoundItemIds: Set<String> = []
    /// Of those, the ones still unconfirmed when the current attach began: the
    /// only bubbles a replayed `user_prompt` is allowed to adopt.
    @ObservationIgnored private var pendingEchoItemIds: Set<String> = []

    public var lastSequence: Int { lastSeq }
    public var sessionId: String? { currentSessionId }

    /// Ephemeral updates carry no durable sequence, so they take a sentinel
    /// larger than any seq a gateway will emit.
    public static let ephemeralSeq = Int.max

    // MARK: - Init

    public init(
        podId: String,
        fromSeq: Int?,
        sessionId: String? = nil,
        api: SessionAPI? = nil,
        socketFactory: SessionTransportFactory? = nil,
        now: @escaping () -> Date = Date.init,
        reconnectDelay: ((Int) -> TimeInterval)? = nil
    ) {
        self.podId = podId
        self.lastSeq = fromSeq ?? 0
        self.currentSessionId = sessionId
        self.api = api
        self.socketFactory = socketFactory ?? SessionStream.defaultSocketFactory
        self.now = now
        self.reconnectDelay = reconnectDelay ?? SessionStream.defaultReconnectDelay

        remoteUI.responder = { [weak self] response in
            guard let self, self.isConnected, let socket = self.socket else { return false }
            return socket.uiResponse(response)
        }
        remoteUI.onControl = { [weak self] frame in
            self?.applyRemoteUIControl(frame)
        }
        usage.sender = { [weak self] id, command in
            guard let self, self.isConnected, let socket = self.socket else { return false }
            return socket.rpc(id: id, command: command)
        }
        // An extension-owned editor submits the same way pi's own does: the text
        // becomes a user prompt.
        remoteUI.onEditorSubmit = { [weak self] _, text in
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return true }
            return self?.send(text) ?? false
        }
        remoteUI.onEditorSnapshotSubmit = { [weak self] _, text in
            self?.recoverEditorSnapshot(text) ?? false
        }
        restoreQueuedPromptAdmissions()
    }

    private func restoreQueuedPromptAdmissions() {
        for admission in QueuedPromptAdmissionStore.read(podID: podId) {
            let itemID = "queued:\(admission.requestID)"
            guard !items.contains(where: { $0.id == itemID }) else { continue }
            queuedPromptItemIDs[admission.requestID] = itemID
            serverBoundItemIds.insert(itemID)
            append(
                StreamItem(
                    id: itemID, style: .user, title: "You", text: admission.text,
                    delivery: .unknown
                )
            )
        }
    }

    private func refreshRestoredQueueStatuses() async {
        guard let api else { return }
        for admission in QueuedPromptAdmissionStore.read(podID: podId) {
            guard queuedPromptItemIDs[admission.requestID] != nil else { continue }
            do {
                if let receipt = try await api.queuedPrompt(
                    podId: podId, requestID: admission.requestID
                ) {
                    applyQueuedPromptStatus(admission.requestID, status: receipt.status)
                }
            } catch {
                // Keep the unconfirmed bubble. A status read is idempotent, and
                // nothing is reposted just because this check failed.
            }
        }
    }

    private static let defaultSocketFactory: SessionTransportFactory = { podId, fromSeq, fromSession in
        SessionSocket(podId: podId, fromSeq: fromSeq, fromSessionId: fromSession)
    }

    deinit {
        // A stream dropped without `detach()` — the screen was popped while a
        // reconnect was in flight — still owns a socket, and `URLSession` keeps
        // the task alive until someone cancels it. `deinit` is nonisolated (the
        // last reference can be released anywhere), so the close is handed to
        // the main actor instead of being assumed to be on it.
        reconnectTask?.cancel()
        preparationTask?.cancel()
        openTask?.cancel()
        if let socket {
            Task { @MainActor in socket.disconnect(notify: false) }
        }
    }

    private static func defaultReconnectDelay(_ attempt: Int) -> TimeInterval {
        var seconds = 1
        var index = 1
        while index < attempt, seconds < 30 {
            seconds *= 2
            index += 1
        }
        return TimeInterval(min(seconds, 30))
    }

    // MARK: - Opening

    /// Starts opening the conversation, owned by the stream rather than by
    /// whoever asked for it.
    ///
    /// Opening is a history fetch plus a ticket fetch, and a screen that pushes
    /// another on top of itself disappears — which cancels its `.task`, and with
    /// it any `URLSession` work awaited there. A conversation must not fail to
    /// load because the person tapped through to the model picker while it was
    /// still arriving, so the task lives here and only `detach()` ends it.
    public func startOpening(_ api: SessionAPI) {
        self.api = api
        Task { [weak self] in await self?.refreshRestoredQueueStatuses() }
        openTask?.cancel()
        openTask = Task { [weak self] in
            await self?.open(api)
        }
    }

    public func open(_ api: SessionAPI) async {
        self.api = api
        do {
            let current = try await api.pod(id: podId)
            setPodRecord(current)
            // A launch the server refused after admitting it (a full host, say) is over before
            // the screen opens. Attaching would only fail with a less useful message.
            if current.didFail {
                isLoadingHistory = false
                error = current.friendlyStateReason
                    .map { FriendlyError.message(serverText: $0) }
                    ?? "This pod couldn’t start."
                return
            }
            if current.initializing {
                preparingPod = current
                isLoadingHistory = false
                await waitForPreparation(api)
                return
            }
            if current.isAsleep {
                asleep = current.sandboxState
                await loadHistory(api)
                return
            }
        } catch {
            // The attach path stays authoritative when the pod snapshot is
            // temporarily unreachable.
        }
        await loadHistory(api)
        sessionEnded = false
        sessionEndedMessage = ""
        asleep = nil
        await attach(api)
    }

    private func waitForPreparation(_ api: SessionAPI) async {
        while shouldReconnect || preparingPod != nil {
            do {
                let current = try await api.pod(id: podId)
                if let refreshError = preparationRefreshError {
                    if self.error == refreshError { self.error = nil }
                    preparationRefreshError = nil
                }
                setPodRecord(current)
                preparingPod = current.initializing ? current : nil
                if current.didFail {
                    error = current.friendlyStateReason
                        .map { FriendlyError.message(serverText: $0) }
                        ?? "The sandbox could not be prepared."
                    return
                }
                if !current.initializing {
                    await attach(api)
                    return
                }
            } catch {
                if Task.isCancelled || error is CancellationError { return }
                // The workstation being down is the same wait every other call
                // path enters, not a failure to report: a red "couldn't refresh"
                // banner over a sandbox that is simply waiting for its
                // workstation tells the reader nothing they can act on, and
                // hides the wait card that would.
                if let apiError = error as? APIError,
                   let demand = WorkstationDemandDetail.parse(apiError) {
                    preparationRefreshError = nil
                    enterWorkstationWait(demand, api: api)
                    return
                }
                let message = "Couldn’t refresh sandbox progress. Retrying… "
                    + FriendlyError.message(error)
                self.error = message
                preparationRefreshError = message
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { return }
        }
    }

    private func loadHistory(_ api: SessionAPI) async {
        historyLoadFailed = false
        do {
            var pages: [ConversationEventsPage] = []
            var before: String?
            for _ in 0..<25 {
                let page = try await api.conversationEvents(
                    podId: podId, before: before, limit: 200
                )
                pages.append(page)
                guard let next = page.nextBefore else { break }
                before = next
            }
            for page in pages.reversed() { ingestHistory(page.events) }
        } catch {
            historyLoadFailed = true
            self.error = "Conversation history couldn’t be loaded. Retry."
        }
        isLoadingHistory = false
    }

    /// Feeds history pages straight into the reducer, newest page last, for
    /// tests that do not stand up an API.
    public func loadHistoryForTesting(_ pages: [ConversationEventsPage]) {
        historyLoadFailed = false
        isLoadingHistory = false
        for page in pages.reversed() { ingestHistory(page.events) }
    }

    /// Preserves the receipt when earlier turns exist but are temporarily unseen.
    public func markHistoryFailedForTesting() {
        isLoadingHistory = false
        historyLoadFailed = true
    }

    private func ingestHistory(_ events: [ConversationEventRecord]) {
        for event in events {
            let id = eventId(event.sessionId, event.seq)
            guard seenEventIds.insert(id).inserted else { continue }
            currentSessionId = event.sessionId
            handleEvent(
                id: id,
                seq: event.seq,
                kind: event.kind,
                timestamp: Format.date(event.createdAt),
                payload: event.payload,
                reason: event.payload["reason"]?.stringValue
            )
            lastSeq = event.seq
        }
        replayThroughSeq = lastSeq
    }

    // MARK: - Attach and reconnect

    /// Every call mints a new ticket. Tickets are one-shot and are never
    /// retained for retries or foreground reconnects.
    public func attach(_ api: SessionAPI? = nil) async {
        guard let activeAPI = api ?? self.api else {
            assertionFailure("A SessionAPI is required before attaching.")
            return
        }
        self.api = activeAPI
        shouldReconnect = true
        connectionGeneration += 1
        let generation = connectionGeneration
        isConnected = false
        hasModelSnapshot = false
        reconnecting = socket != nil || reconnectAttempt > 0
        writeError(nil)
        podUnavailable = false
        reconnectTask?.cancel()
        reconnectTask = nil
        socket?.disconnect(notify: false)
        socket = nil
        do {
            let ticket = try await activeAPI.wsTicket(podId: podId)
            guard shouldReconnect, generation == connectionGeneration else { return }
            let socket = socketFactory(podId, lastSeq, currentSessionId)
            self.socket = socket
            socket.onMessage = { [weak self] message in
                guard let self, generation == self.connectionGeneration else { return }
                self.handle(message)
            }
            // No `shouldReconnect` guard: a close that arrives after the session
            // ended still has to clear `isConnected`, or the screen goes on
            // claiming a live transport that is gone. Whether to reconnect is
            // decided inside `handleDisconnect`.
            socket.onDisconnect = { [weak self] _, closeCode in
                guard let self, generation == self.connectionGeneration else { return }
                self.handleDisconnect(activeAPI, generation: generation, closeCode: closeCode)
            }
            socket.connect(ticket: ticket.ticket)
        } catch {
            guard generation == connectionGeneration, shouldReconnect else { return }
            waking = false
            // Minting the ticket is itself a call the server refuses while the
            // workstation is down. That is the same wait, not a connection error.
            if let apiError = error as? APIError,
               let demand = WorkstationDemandDetail.parse(apiError) {
                enterWorkstationWait(demand, api: activeAPI)
                return
            }
            self.error = FriendlyError.message(error)
            // Minting a ticket is one HTTP request, and it fails for the same
            // ordinary reasons the socket does. Ending the reconnect loop on the
            // first failure left a live session stranded behind a banner with
            // nothing retrying it, so only a fatal answer stops here.
            if SessionStream.isFatalTicketFailure(error) {
                reconnecting = false
                shouldReconnect = false
                return
            }
            scheduleReconnect(activeAPI, generation: generation)
        }
    }

    /// Whether a failed ticket mint says the session cannot come back at all: an
    /// expired sign-in, or a pod the server no longer has.
    static func isFatalTicketFailure(_ error: Error) -> Bool {
        if error is SessionExpiredError || error is AuthContextChangedError { return true }
        if let apiError = error as? APIError, apiError.transportStatus == 404 { return true }
        return false
    }

    /// Call from the app's foreground callback. It reconnects only a live
    /// session that was interrupted, and therefore mints a new ticket.
    ///
    /// "Interrupted" includes a socket that still reads as connected but has
    /// gone quiet past the keepalive deadline: coming back from a long
    /// background is exactly when a half-open connection is left behind, and a
    /// send into one disappears without an error at all.
    public func reattachIfNeeded() {
        guard shouldReconnect, let api, !isConnected || isInboundStalled else { return }
        Task { await attach(api) }
    }

    /// Whether nothing has arrived on the transport for longer than the socket's
    /// own pong deadline.
    var isInboundStalled: Bool {
        guard isConnected, let lastInboundAt else { return false }
        return now().timeIntervalSince(lastInboundAt) > SessionStream.inboundStallDeadline
    }

    /// Matches `SessionSocket`'s own deadline: 2.5 ping intervals of silence.
    public static let inboundStallDeadline: TimeInterval = 62.5

    public func onForeground() { reattachIfNeeded() }

    public func setOffline(_ offline: Bool) {
        let wasOffline = isOffline
        isOffline = offline
        if wasOffline, !offline, shouldReconnect, !isConnected { reattachIfNeeded() }
    }

    public func detach() {
        shouldReconnect = false
        reconnecting = false
        reconnectAttempt = 0
        connectionGeneration += 1
        reconnectTask?.cancel()
        reconnectTask = nil
        // Leaving the screen ends this client's wait only. The workstation keeps
        // starting on the server and its files are retained.
        endWorkstationWait()
        preparationTask?.cancel()
        preparationTask = nil
        openTask?.cancel()
        openTask = nil
        socket?.disconnect(notify: false)
        socket = nil
        isConnected = false
        hasModelSnapshot = false
        waking = false
        // Streamed shell output belongs to the attach that was carrying it. The
        // next one starts from the gateway's own snapshot, so keeping this would
        // only risk appending that snapshot to a stale accumulation.
        bashOutput.removeAll()
        bashSnapshotAdopted.removeAll()
        // An interrupt or a switch in flight is moot once the transport is gone:
        // the confirmed selection stays, while pending choices are discarded so
        // rows do not stay disabled and the stopping spinner does not survive.
        isInterrupting = false
        setPendingModelSwitch(nil)
        setPendingThinkingSwitch(nil)
        selectionNeedsAttention = false
        modelBeforePending = nil
        thinkingBeforePending = nil
        lastPendingModelSnapshot = nil
        pendingModelMismatchCount = 0
        lastPendingThinkingSnapshot = nil
        pendingThinkingMismatchCount = 0
        pendingSelectionRequestID = nil
        allowUncorrelatedSelectionConfirmation = false
    }

    public func wake() {
        // A workstation wait already re-issues the attach on its own schedule,
        // and it is not woken by a keystroke: arming the wake path here would
        // put "Waking pod…" over a wait that takes minutes.
        guard let api, !isConnected, !waking, workstationWait == nil,
              podRecord?.didFail != true else { return }
        waking = true
        Task { await attach(api) }
    }

    /// The one recovery every connection banner's action performs.
    ///
    /// Re-opening cannot recover a sleeping pod. `open` reads the pod, sees it
    /// asleep and deliberately stops short of attaching, because waking costs
    /// minutes of someone's compute and is a decision, not a refresh. That is
    /// right for opening a screen and wrong for a button the reader pressed:
    /// over a sleeping pod, "Retry" re-read the same sleeping pod forever and
    /// the only recovery on offer never recovered anything. Which banner is on
    /// screen is not the reader's problem — an asleep pod whose history failed
    /// to load shows "Retry", not "Wake" — so the action resolves to the wake
    /// whenever the pod is asleep, whatever put the banner there.
    public func retry(_ api: SessionAPI) {
        if asleep != nil, !isConnected {
            wake()
            // An attach is already in flight; re-opening would only re-read
            // the pod it is busy starting.
            if waking { return }
        }
        startOpening(api)
    }

    // MARK: - Workstation wait

    /// Enters (or refreshes) the shared workstation wait.
    ///
    /// The wait polls the durable status when a host id is known and re-issues
    /// the attach every cycle, because the server's admission is the only proof
    /// the workstation is usable. A successful `hello` ends it from the other
    /// side, in `handleHello`.
    private func enterWorkstationWait(_ detail: WorkstationDemandDetail, api: SessionAPI) {
        workstationNotice = nil
        writeError(nil)
        podUnavailable = false
        asleep = nil
        waking = false
        reconnecting = false

        if let existing = workstationWait, !existing.isFinished {
            existing.adopt(detail)
            return
        }

        let wait = WorkstationWait(
            detail: detail,
            status: { [weak api] hostId in try await api?.workstationStatus(hostId: hostId) }
        )
        workstationWait = wait
        workstationTask?.cancel()
        workstationTask = Task { [weak self] in
            let outcome = await wait.run { [weak self] () async throws -> Void in
                guard let self else { throw CancellationError() }
                if self.isConnected { return }
                await self.attach(api)
                // Attaching does not answer synchronously: `hello` or the next
                // close is the answer, and both arrive on the socket.
                throw WorkstationWaitPending()
            }
            guard let self, !Task.isCancelled else { return }
            self.finishWorkstationWait(outcome)
        }
    }

    private func finishWorkstationWait(_ outcome: WorkstationWaitOutcome<Void>) {
        workstationWait = nil
        workstationCanKeepWaiting = outcome.canKeepWaiting
        shouldReconnect = false
        switch outcome {
        case .succeeded:
            shouldReconnect = true
        case .failed(let error):
            writeError(FriendlyError.message(error))
        default:
            workstationNotice = outcome.endingMessage
        }
    }

    /// Ends this client's wait only. Nothing on the server is cancelled.
    public func cancelWorkstationWait() {
        workstationWait?.cancel()
    }

    /// Drops the wait without leaving a notice behind: the session moved on.
    private func endWorkstationWait() {
        workstationTask?.cancel()
        workstationTask = nil
        workstationWait?.cancel()
        workstationWait = nil
        pendingWorkstationDemand = nil
        workstationNotice = nil
        workstationCanKeepWaiting = false
    }

    /// Restarts a wait the reader ended or that ran out of budget.
    public func retryWorkstationWait() {
        guard let api else { return }
        workstationNotice = nil
        Task { await attach(api) }
    }

    /// A `session_ended` or `detached` reason that names the caller's own
    /// workstation (`host_stopped` / `host_starting` / `host_archived`) is the
    /// recoverable workstation wait, not idle sleep. Returns true when the wait
    /// was entered (or adopted into the wait already in flight).
    ///
    /// Idle `idle_stop` is not a host reason and falls through to the asleep
    /// path. The wait keeps re-issuing `attach` (admission); it never polls a
    /// stopped host forever.
    private func enterHostWaitIfNeeded(reason: String?) -> Bool {
        guard let reason,
              let demand = WorkstationDemandDetail.fromCloseReason(reason),
              let api = self.api
        else { return false }
        // The session did not end into idle copy: settle what was mid-flight
        // without appending the "went to sleep" banner, and keep the
        // transport so the 4420 close that follows still arrives.
        streaming = false
        compacting = false
        awaitingReply = false
        remoteUI.clear()
        settleInFlightItems()
        sessionEnded = false
        sessionEndedMessage = ""
        enterWorkstationWait(demand, api: api)
        return true
    }

    private func handleDisconnect(
        _ api: SessionAPI, generation: Int, closeCode: SessionCloseCode?
    ) {
        let closeReason = socket?.lastCloseReason
        let parkedDemand = pendingWorkstationDemand
        isConnected = false
        hasModelSnapshot = false
        socket = nil
        awaitingReply = false
        isInterrupting = false
        if pendingModel != nil || pendingThinkingLevel != nil {
            selectionNeedsAttention = true
        }
        // A disconnect does not prove whether a setter reached the runtime.
        // Keep the intent until a fresh catalog snapshot confirms or rejects it.
        updateRunningState()
        failInFlightSends()
        // 4420 is both "this pod went to sleep" and "your workstation is not
        // up". A vendor/host stop arrives as `session_ended` (reason
        // `host_stopped`, kind asleep) followed by `detached` and then this
        // close with reason `host_stopped` — and that first frame already set
        // `sessionEnded` / `shouldReconnect = false`. The host wait still takes
        // precedence, even then, so it is checked before the ended guard.
        if closeCode == .asleep {
            if workstationWait != nil {
                if let demand = parkedDemand {
                    pendingWorkstationDemand = nil
                    enterWorkstationWait(demand, api: api)
                } else if let reason = closeReason,
                          let demand = WorkstationDemandDetail.fromCloseReason(reason) {
                    enterWorkstationWait(demand, api: api)
                }
                reconnecting = false
                waking = false
                return
            }
            if let demand = parkedDemand {
                pendingWorkstationDemand = nil
                sessionEnded = false
                sessionEndedMessage = ""
                enterWorkstationWait(demand, api: api)
                return
            }
            if let reason = closeReason,
               let demand = WorkstationDemandDetail.fromCloseReason(reason) {
                sessionEnded = false
                sessionEndedMessage = ""
                enterWorkstationWait(demand, api: api)
                return
            }
        } else if parkedDemand != nil {
            // A parked host demand belongs to a 4420 that never came; any other
            // close ends its life so it cannot capture a later idle sleep.
            pendingWorkstationDemand = nil
        }
        // The session already ended — `session_ended`, or a close this stream
        // asked for. The close only confirms it; nothing is reconnected, but the
        // state above still had to be cleared.
        guard shouldReconnect else {
            reconnecting = false
            waking = false
            return
        }
        switch closeCode {
        case .podNotFound:
            shouldReconnect = false
            reconnecting = false
            error = "This pod no longer exists. Its sessions are gone with it."
            waking = false
        case .podUnavailable:
            shouldReconnect = false
            reconnecting = false
            podUnavailable = true
            waking = false
        case .asleep:
            reconnecting = false
            waking = false
            // 4420 is both "this pod went to sleep" and "your workstation is not
            // up". Only the typed detail from the preceding `error` frame tells
            // them apart — the close code cannot, and neither can the reason
            // string, which a co-located host pod's stop cause also uses.
            if let demand = pendingWorkstationDemand {
                pendingWorkstationDemand = nil
                enterWorkstationWait(demand, api: api)
                return
            }
            if let reason = closeReason,
               let demand = WorkstationDemandDetail.fromCloseReason(reason) {
                enterWorkstationWait(demand, api: api)
                return
            }
            shouldReconnect = false
            if !sessionEnded { applySessionEnd(reason: "idle_stop", kind: "asleep") }
        case .piExited:
            shouldReconnect = false
            reconnecting = false
            waking = false
            if !sessionEnded { applySessionEnd(reason: "pi_exit", kind: "exited") }
        case .badRequest:
            shouldReconnect = false
            reconnecting = false
            error = """
                The app sent something this server couldn’t understand. Update the app if \
                this keeps happening.
                """
            waking = false
        case .unauthorized, .transient, .goingAway, nil:
            scheduleReconnect(api, generation: generation)
        }
    }

    private func scheduleReconnect(_ api: SessionAPI, generation: Int) {
        reconnecting = true
        guard !isOffline else { return }
        reconnectAttempt += 1
        let delay = reconnectDelay(reconnectAttempt)
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            guard generation == self.connectionGeneration, self.shouldReconnect,
                  self.reconnecting
            else { return }
            await self.attach(api)
        }
    }

    // MARK: - Sending

    @discardableResult
    public func send(_ text: String, attachments: [ChatAttachment] = []) -> Bool {
        guard pendingModel == nil, pendingThinkingLevel == nil else {
            blockedPromptDrafts.append(text)
            error = "Wait for the model change to finish before sending this message."
            return true
        }
        let id = "local:\(syntheticId)"
        let isTooLong = text.utf16.count > SessionLimits.maxPromptTextChars
        syntheticId -= 1
        let staged = attachments.map {
            StreamImageAttachment(
                id: $0.id, name: $0.name, mimeType: $0.mimeType, bytes: $0.bytes
            )
        }
        if !staged.isEmpty { pendingAttachments[id] = staged }
        append(
            StreamItem(
                id: id,
                style: .user,
                title: "You",
                text: text,
                timestamp: now(),
                delivery: .sending,
                attachments: staged
            )
        )
        // The gateway refuses an oversized prompt with an `error` frame and no
        // event, so sending it would cost a round trip to learn what the limit
        // already says. The bubble keeps the text and offers Retry once it has
        // been shortened, rather than disappearing with it.
        guard !isTooLong else {
            setDelivery(id, .failed)
            writeError(SessionLimits.promptTooLongMessage)
            return true
        }
        deliver(id: id, text: text)
        return true
    }

    public func takeBlockedPromptDrafts() -> [String] {
        defer { blockedPromptDrafts.removeAll() }
        return blockedPromptDrafts
    }

    private func recoverEditorSnapshot(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return true }
        editorSnapshotDrafts.append(value)
        return true
    }

    public func takeEditorSnapshotDrafts() -> [String] {
        defer { editorSnapshotDrafts.removeAll() }
        return editorSnapshotDrafts
    }

    public func retrySend(_ id: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        guard items[index].delivery != .unknown else {
            checkOutgoing(id)
            return
        }
        guard pendingModel == nil, pendingThinkingLevel == nil else {
            error = "Model change is unconfirmed. Check status before retrying this message."
            return
        }
        let text = items[index].text
        let staged = pendingAttachments.removeValue(forKey: id) ?? items[index].attachments
        items.remove(at: index)
        // The retry is a new turn with a new id; the old one can no longer be
        // adopted by anything.
        pendingEchoItemIds.remove(id)
        serverBoundItemIds.remove(id)
        removeQueuedPromptAdmissions(forItemID: id)
        // Reuse the attachments' stable ids: two same-named images keep distinct
        // identities through the retry instead of colliding on `name`.
        let stamp = Int(now().timeIntervalSince1970 * 1_000_000)
        send(
            text,
            attachments: staged.enumerated().map { position, attachment in
                ChatAttachment(
                    id: attachment.id.isEmpty ? "retry-\(stamp)-\(position)" : attachment.id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    bytes: attachment.bytes
                )
            }
        )
    }

    public func discardOutgoing(_ id: String) {
        guard items.contains(where: { $0.id == id }) else { return }
        items.removeAll { $0.id == id }
        pendingAttachments.removeValue(forKey: id)
        pendingEchoItemIds.remove(id)
        serverBoundItemIds.remove(id)
        removeQueuedPromptAdmissions(forItemID: id)
        scrollIsStreamingUpdate = false
        scrollRevision += 1
    }

    private func wireImages(_ id: String) -> [SessionImage] {
        guard let staged = pendingAttachments[id], !staged.isEmpty else { return [] }
        return staged.map {
            SessionImage(mimeType: $0.mimeType, base64Data: $0.bytes.base64EncodedString())
        }
    }

    private func deliver(id: String, text: String) {
        guard pendingModel == nil, pendingThinkingLevel == nil else {
            setDelivery(id, .waitingForConnection)
            error = "Model change is unconfirmed. Check status before sending this message."
            return
        }
        if isConnected {
            // A newly attached session may still be applying a model selected
            // on a replaced client. Park live sends until the ordered get_models
            // response establishes which runtime model is active.
            guard hasModelSnapshot else {
                setDelivery(id, .waitingForConnection)
                return
            }
            guard let socket, socket.prompt(text, images: wireImages(id)) else {
                setDelivery(id, .failed)
                return
            }
            // On the wire: the gateway persists this turn before it echoes it,
            // so a reconnect may find it in the replay rather than never at all.
            serverBoundItemIds.insert(id)
            pendingAttachments.removeValue(forKey: id)
            setDelivery(id, .sending)
            awaitingReply = true
            updateRunningState()
            return
        }
        if preparingPod != nil, pendingAttachments[id] == nil {
            Task { await queueDurably(id: id, text: text) }
            return
        }
        // A pod whose launch failed will never connect: parking the message would leave it
        // "waiting" under the reason it failed, and waking would replace that reason.
        if podRecord?.didFail == true {
            setDelivery(id, .failed)
            return
        }
        // Image turns cannot ride the durable queue endpoint — it only persists
        // text — so they park in memory and flush on the next hello instead of
        // being silently downgraded to a text-only prompt.
        setDelivery(id, .waitingForConnection)
        wake()
    }

    private func queueDurably(id: String, text: String) async {
        guard let api else {
            setDelivery(id, .failed)
            return
        }
        let requestID = UUID().uuidString.lowercased()
        QueuedPromptAdmissionStore.write(
            QueuedPromptAdmission(requestID: requestID, text: text), podID: podId
        )
        queuedPromptItemIDs[requestID] = id
        // The admission may echo on the next session before this POST returns.
        // Mark it eligible for replay adoption from the moment the request is
        // handed to the transport.
        serverBoundItemIds.insert(id)
        do {
            let receipt = try await api.queuePrompt(
                podId: podId, text: text, requestID: requestID,
                model: ModelMemory.startingModel(podID: podId)
            )
            if receipt.id != requestID {
                let itemID = queuedPromptItemIDs.removeValue(forKey: requestID) ?? id
                queuedPromptItemIDs[receipt.id] = itemID
            }
            // The receipt reflects durable admission, not necessarily runtime
            // acceptance. A retry of the same request id may already be unknown.
            serverBoundItemIds.insert(id)
            applyQueuedPromptStatus(receipt.id, status: receipt.status)
            writeError(nil)
        } catch {
            // The workstation being down is a delay, not a refusal of the
            // message: park it for the reconnect the wait drives, instead of
            // failing it. The wait's attach ends on `hello`, which flushes
            // everything still parked.
            if let apiError = error as? APIError,
               let demand = WorkstationDemandDetail.parse(apiError) {
                serverBoundItemIds.remove(id)
                queuedPromptItemIDs = queuedPromptItemIDs.filter { $0.value != id }
                QueuedPromptAdmissionStore.remove(requestID: requestID, podID: podId)
                setDelivery(id, .waitingForConnection)
                enterWorkstationWait(demand, api: api)
                return
            }
            if Self.isAmbiguousRemoteMutationError(error) {
                // The POST may have committed before its response was lost.
                // Mark it as server-bound so a later replay can adopt it, but
                // never resend automatically and risk a duplicate turn.
                serverBoundItemIds.insert(id)
                let queueItemID = queuedPromptItemIDs[requestID] ?? id
                let confirmedDelivery = items.first(where: { $0.id == queueItemID })?.delivery
                if confirmedDelivery != .delivered && confirmedDelivery != .failed {
                    applyQueuedPromptStatus(requestID, status: "unknown")
                    self.error = "Message delivery is unconfirmed. Check the conversation before retrying."
                }
                return
            }
            serverBoundItemIds.remove(id)
            queuedPromptItemIDs = queuedPromptItemIDs.filter { $0.value != id }
            QueuedPromptAdmissionStore.remove(requestID: requestID, podID: podId)
            setDelivery(id, .failed)
            self.error = "Message wasn’t saved: \(FriendlyError.message(error))"
        }
    }

    /// A queue response that did not provide a verdict is checked by replay,
    /// never by posting the same text a second time.
    public func checkOutgoing(_ id: String) {
        guard items.contains(where: { $0.id == id }) else { return }
        serverBoundItemIds.insert(id)
        guard let api else {
            error = "Reconnect to check this message's delivery."
            return
        }
        if let (queueID, _) = queuedPromptItemIDs.first(where: { $0.value == id }) {
            Task { await refreshQueuedPromptStatus(queueID, api: api) }
            return
        }
        guard items.contains(where: { $0.id == id && $0.delivery == .unknown }) else { return }
        Task { await attach(api) }
    }

    private func refreshQueuedPromptStatus(_ queueID: String, api: SessionAPI) async {
        do {
            guard let receipt = try await api.queuedPrompt(podId: podId, requestID: queueID) else {
                // Absence is not proof that an earlier POST did not commit; its
                // row may also have passed the retention window. Never re-POST.
                error = "Queue status is unavailable. This prompt was not sent again."
                return
            }
            applyQueuedPromptStatus(queueID, status: receipt.status)
        } catch {
            self.error = "Couldn’t check this message yet. It was not sent again."
        }
    }

    private func applyQueuedPromptStatus(_ queueID: String, status: String) {
        if status == "delivered" {
            QueuedPromptAdmissionStore.remove(requestID: queueID, podID: podId)
        }
        guard let itemID = queuedPromptItemIDs[queueID],
              items.contains(where: { $0.id == itemID })
        else { return }
        let current = items.first(where: { $0.id == itemID })?.delivery
        switch status {
        case "pending", "delivering":
            guard current != .unknown, current != .delivered, current != .failed else { return }
            setDelivery(itemID, .savedOnServer)
        case "delivered":
            setDelivery(itemID, .delivered)
        case "failed":
            guard current != .delivered else { return }
            setDelivery(itemID, .failed)
        case "unknown":
            guard current != .delivered, current != .failed else { return }
            setDelivery(itemID, .unknown)
            error = "Delivery is unconfirmed. Check status before sending this prompt again."
        default: break
        }
    }

    /// A response-less queue admission is not safe to replay from a Retry
    /// button. The caller must first reconcile it through `checkOutgoing`.
    static func isAmbiguousRemoteMutationError(_ error: Error) -> Bool {
        if let apiError = error as? APIError {
            guard let status = apiError.transportStatus else { return true }
            return status == 408 || status >= 500
        }
        if error is AuthContextChangedError { return true }
        if error is URLError {
            // The request may already have crossed the process boundary when
            // cancellation reached this task; cancellation is not a refusal.
            return true
        }
        return (error as NSError).domain == NSURLErrorDomain
            || error is DecodingError
    }

    private func removeQueuedPromptAdmissions(forItemID itemID: String) {
        let requestIDs = queuedPromptItemIDs.compactMap { key, value in
            value == itemID ? key : nil
        }
        for requestID in requestIDs {
            queuedPromptItemIDs.removeValue(forKey: requestID)
            QueuedPromptAdmissionStore.remove(requestID: requestID, podID: podId)
        }
    }

    private func setDelivery(_ id: String, _ delivery: StreamItemDelivery) {
        guard let index = items.firstIndex(where: { $0.id == id }),
              items[index].delivery != delivery
        else { return }
        items[index].delivery = delivery
        scrollIsStreamingUpdate = false
        scrollRevision += 1
    }

    /// Adopts the locally-sent bubble when the server echoes it back. The image
    /// count must match exactly — a text-only echo must not adopt an image turn,
    /// or the reverse — and the local bytes stay on the item so thumbnails
    /// survive the round trip, since the server only persists descriptors.
    private func adoptQueuedPrompt(
        _ queueID: String, text: String, serverId: String, timestamp: Date?
    ) -> Bool {
        guard let itemID = queuedPromptItemIDs[queueID],
              let index = items.firstIndex(where: { $0.id == itemID || $0.id == serverId })
        else { return false }
        let oldID = items[index].id
        pendingAttachments.removeValue(forKey: oldID)
        pendingEchoItemIds.remove(oldID)
        serverBoundItemIds.remove(oldID)
        let priorDelivery = items[index].delivery
        items[index].id = serverId
        if priorDelivery != .delivered && priorDelivery != .failed && priorDelivery != .unknown {
            items[index].delivery = .savedOnServer
        }
        items[index].text = text
        if let timestamp { items[index].timestamp = timestamp }
        queuedPromptItemIDs[queueID] = serverId
        scrollIsStreamingUpdate = false
        scrollRevision += 1
        return true
    }

    private func adoptOutgoing(
        text: String, serverId: String, timestamp: Date?, imageCount: Int,
        restrictedTo: Set<String>? = nil
    ) -> Bool {
        guard let index = items.firstIndex(where: {
            $0.style == .user && $0.delivery != .delivered
                && !queuedPromptItemIDs.values.contains($0.id) && $0.text == text
                && $0.attachments.count == imageCount
                && (restrictedTo?.contains($0.id) ?? true)
        }) else { return false }
        pendingAttachments.removeValue(forKey: items[index].id)
        pendingEchoItemIds.remove(items[index].id)
        serverBoundItemIds.remove(items[index].id)
        items[index].id = serverId
        items[index].delivery = .delivered
        if let timestamp { items[index].timestamp = timestamp }
        scrollIsStreamingUpdate = false
        scrollRevision += 1
        return true
    }

    private func failInFlightSends() {
        var changed = false
        for index in items.indices where items[index].delivery == .sending {
            // A socket write or queue POST that lost its answer may already be
            // durable. Never turn that uncertainty into a Retry button.
            serverBoundItemIds.insert(items[index].id)
            items[index].delivery = .unknown
            changed = true
        }
        guard changed else { return }
        scrollIsStreamingUpdate = false
        scrollRevision += 1
    }

    private func flushQueuedOffline() {
        guard hasModelSnapshot else { return }
        guard pendingModel == nil, pendingThinkingLevel == nil else {
            error = "Model change is unconfirmed. Saved messages will send after it is checked."
            return
        }
        let parked = items.filter { $0.delivery == .waitingForConnection }
        for row in parked { deliver(id: row.id, text: row.text) }
    }

    // MARK: - Turn control

    public func interrupt() {
        guard isConnected, isRunning, let socket, socket.interrupt() else { return }
        isInterrupting = true
        appendStatus("You stopped this turn.")
    }

    public func refreshModels() {
        if isConnected { _ = socket?.requestModels() }
    }

    public func checkModelStatus() {
        allowUncorrelatedSelectionConfirmation = true
        refreshModels()
    }

    @discardableResult
    public func selectModel(_ model: ModelChoice) -> Bool {
        if model == currentModel, pendingModel == nil { return true }
        guard pendingModel == nil, pendingThinkingLevel == nil else {
            error = "Wait for the current model change to finish before choosing another."
            return false
        }
        return requestModel(model)
    }

    @discardableResult
    public func selectThinkingLevel(_ level: String) -> Bool {
        if level == currentThinkingLevel, pendingThinkingLevel == nil { return true }
        guard pendingModel == nil, pendingThinkingLevel == nil else {
            error = "Wait for the current model change to finish before choosing another."
            return false
        }
        guard availableThinkingLevels.contains(level) else {
            error = "Couldn’t change the thinking level because it is not in the pod’s catalog."
            return false
        }
        return requestThinkingLevel(level)
    }

    @discardableResult
    public func retryPendingSelection() -> Bool {
        if let pending = pendingModel {
            return requestModel(pending)
        }
        if let pending = pendingThinkingLevel {
            return requestThinkingLevel(pending)
        }
        return false
    }

    @discardableResult
    public func useConfirmedSelection() -> Bool {
        if let current = currentModel, pendingModel != nil {
            return requestModel(current)
        }
        if let current = currentThinkingLevel, pendingThinkingLevel != nil {
            return requestThinkingLevel(current)
        }
        return false
    }

    private func requestModel(_ model: ModelChoice) -> Bool {
        let requestID = UUID().uuidString
        guard isConnected, let socket,
              socket.set(
                model: ["provider": model.provider, "id": model.modelId],
                thinkingLevel: nil, requestID: requestID
              )
        else {
            error = """
                Couldn’t switch models because the pod isn’t connected. Reconnect and try again.
                """
            selectionNeedsAttention = true
            return false
        }
        modelBeforePending = currentModel
        pendingSelectionRequestID = requestID
        allowUncorrelatedSelectionConfirmation = false
        lastPendingModelSnapshot = nil
        pendingModelMismatchCount = 0
        selectionNeedsAttention = false
        setPendingModelSwitch(model)
        _ = socket.requestModels()
        return true
    }

    private func requestThinkingLevel(_ level: String) -> Bool {
        let requestID = UUID().uuidString
        guard isConnected, let socket,
              socket.set(
                model: nil, thinkingLevel: level, requestID: requestID
              )
        else {
            error = "Couldn’t change the thinking level because the pod isn’t connected."
            selectionNeedsAttention = true
            return false
        }
        thinkingBeforePending = currentThinkingLevel
        pendingSelectionRequestID = requestID
        allowUncorrelatedSelectionConfirmation = false
        lastPendingThinkingSnapshot = nil
        pendingThinkingMismatchCount = 0
        selectionNeedsAttention = false
        setPendingThinkingSwitch(level)
        _ = socket.requestModels()
        return true
    }

    public func setToolExpanded(_ key: String, _ expanded: Bool) {
        if expanded {
            expandedToolDetails.insert(key)
        } else {
            expandedToolDetails.remove(key)
        }
    }

    public func isToolExpanded(_ key: String) -> Bool {
        toolsExpandedByExtension || expandedToolDetails.contains(key)
    }

    private func setPendingModelSwitch(_ model: ModelChoice?) {
        pendingModel = model
        isModelSwitchInFlight = model != nil
    }

    private func setPendingThinkingSwitch(_ level: String?) {
        pendingThinkingLevel = level
        isThinkingSwitchInFlight = level != nil
    }

    private func applyRemoteUIControl(_ frame: RemoteUIControlFrame) {
        switch frame.action {
        case .setWorkingMessage:
            workingMessage = frame.value?.stringValue
        case .setWorkingVisible:
            workingVisible = frame.value?.boolValue == true
        case .setWorkingIndicator:
            workingIndicator = frame.value?.stringValue
        case .setHiddenThinkingLabel:
            hiddenThinkingLabel = frame.value?.stringValue
        case .setToolsExpanded:
            toolsExpandedByExtension = frame.value?.boolValue == true
        }
    }

    // MARK: - Message handling

    /// Exposed so reducer tests drive the full protocol without a transport.
    public func ingestForTesting(_ message: SessionServerMessage) { handle(message) }

    public func setPodRecordForTesting(_ pod: Pod) { setPodRecord(pod) }

    public func markPromptSentForTesting() {
        awaitingReply = true
        updateRunningState()
    }

    public func markWakingForTesting() { waking = true }

    /// Puts the stream in the "sandbox still building" state without entering the
    /// polling loop, so a test can exercise the durable-queue path directly.
    public func markPreparingForTesting(_ pod: Pod?) {
        preparingPod = pod
        isLoadingHistory = false
    }

    private func handle(_ message: SessionServerMessage) {
        lastInboundAt = now()
        // A host-demand `error` frame is only meaningful as the preamble to the
        // 4420 close the gateway sends in the same breath. If any other frame
        // arrives first, that close is not coming — and a demand left parked on
        // a live transport would route the next ordinary idle-sleep close into a
        // workstation wait, suppressing both the sleep copy and the Wake button.
        if pendingWorkstationDemand != nil, !SessionStream.namesWorkstationDemand(message) {
            pendingWorkstationDemand = nil
        }
        switch message {
        case .hello(let sessionId, let latestSeq, _, let firstAvailableSeq, let state):
            handleHello(
                sessionId: sessionId, latestSeq: latestSeq,
                firstAvailableSeq: firstAvailableSeq, state: state
            )

        case .event(let seq, let kind, let ts, let payload):
            let id = eventId(currentSessionId, seq)
            guard seenEventIds.insert(id).inserted else { return }
            if seq > lastSeq { lastSeq = seq }
            handleEvent(
                id: id, seq: seq, kind: kind,
                timestamp: ts.flatMap(Format.date), payload: payload
            )

        case .ephemeral(let kind, let payload):
            if kind == "extension_ui_request" {
                // Remote-UI surfaces own their frames; anything else is a
                // dialog pi is waiting on, live or re-sent for this attach.
                if !remoteUI.applyExtensionRequest(payload) {
                    showDialog(payload)
                }
                return
            }
            switch kind {
            case "message_update":
                handleEvent(
                    id: activeAssistantItemId
                        ?? eventId(currentSessionId, SessionStream.ephemeralSeq),
                    seq: SessionStream.ephemeralSeq,
                    kind: kind,
                    timestamp: nil,
                    payload: payload
                )
            case "tool_execution_update", "bash_execution_update":
                // The gateway stopped persisting tool updates (one execution
                // wrote hundreds of rows), so a running tool's output arrives
                // only ephemerally — live, and as a snapshot after every attach.
                // Dropping them left every tool card empty until it finished.
                // Both key on their own ids rather than on a seq.
                let callId = (payload["toolCallId"] ?? payload["id"])?.stringValue ?? ""
                handleEvent(
                    id: "ephemeral:\(kind):\(callId)",
                    seq: SessionStream.ephemeralSeq,
                    kind: kind,
                    timestamp: nil,
                    payload: payload
                )
            default:
                return
            }

        case .dialogClosed(let id):
            closeDialog(id)

        case .replayGap(let fromSeq, let toSeq):
            appendReplayGapStatus(fromSeq: fromSeq, toSeq: toSeq)

        case .sessionEnded(let reason, let kind, _):
            // A vendor/host stop ends the session into the recoverable wait,
            // not idle Asleep. A wait already in flight adopts the fresher
            // reason; any other end while waiting is ignored so it cannot
            // erase the wait.
            if workstationWait != nil {
                if WorkstationDemandDetail.fromCloseReason(reason) != nil {
                    _ = enterHostWaitIfNeeded(reason: reason)
                }
                break
            }
            if enterHostWaitIfNeeded(reason: reason) { break }
            applySessionEnd(reason: reason, kind: kind)

        case .podState(let state, let reason):
            if state == "detached" {
                // A later generic `detached` must not erase a host-wait already
                // entered; a host reason enters (or adopts into) the wait.
                if workstationWait != nil { break }
                if enterHostWaitIfNeeded(reason: reason) { break }
                if !sessionEnded { applySessionEnd(reason: reason ?? "detached", kind: nil) }
            } else {
                appendStatus(reason ?? "Pod state changed to \(state).")
            }

        case .podUpdated(let id, let name):
            applyPodUpdated(id: id, name: name)

        case .queuedPromptStatus(let queueID, let status):
            applyQueuedPromptStatus(queueID, status: status)

        case .models(let models, let current, let thinkingLevel, let thinkingLevels):
            applyModels(
                models, current: current,
                thinkingLevel: thinkingLevel, thinkingLevels: thinkingLevels,
                requestID: nil
            )

        case .modelConfirmation(let requestID, let models, let current, let thinkingLevel, let thinkingLevels):
            applyModels(
                models, current: current,
                thinkingLevel: thinkingLevel, thinkingLevels: thinkingLevels,
                requestID: requestID
            )

        case .rpcResult(let id, let response):
            usage.accept(id: id, response: response)

        case .error(let code, let message, let detail):
            if code == "credential_reconnect_required" {
                credentialSettingsNeeded = true
            }
            // Remote-UI errors are scoped to one extension surface: the surface
            // goes read-only and says so itself, rather than banner-ing the
            // whole session.
            if code == "remote_ui_owned" {
                remoteUI.markOwnedElsewhere()
                return
            }
            if code == "invalid_remote_ui" { return }
            // The gateway sends this frame immediately before closing 4420 for a
            // workstation refusal. Keep the typed detail for that close instead
            // of banner-ing a server sentence the wait is about to explain.
            if WorkstationCloseReason.names(code),
               let demand = WorkstationDemandDetail.parse(
                detail: detail, serverMessage: message
               ) {
                pendingWorkstationDemand = demand
                return
            }
            // This frame is not correlated to a particular setter. Keep any
            // pending choice until a fresh catalog snapshot confirms or rejects
            // it; otherwise an unrelated command failure could release Send
            // while the runtime is still applying the model.
            if pendingModel != nil || pendingThinkingLevel != nil {
                // The error is uncorrelated. Keep the uncertainty visible and
                // wait for the user's explicit Check status action instead of
                // recursively turning one failure into a request storm.
                selectionNeedsAttention = true
            }
            // The gateway answers a refused turn with this frame and no
            // `user_prompt`, so nothing else will ever move the bubble off
            // "Sending…". The frame carries no correlation id, so a command
            // failure unrelated to the prompt marks it failed too — which
            // offers Retry, where the alternative is a turn that claims to be
            // sending forever.
            failInFlightSends()
            writeError(friendly(code: code, message: message), gatewayError: message)

        case .pong:
            break
        }
    }

    /// Whether this frame is the host-demand `error` frame itself, which is the
    /// only thing allowed to keep a parked demand alive.
    private static func namesWorkstationDemand(_ message: SessionServerMessage) -> Bool {
        guard case .error(let code, _, _) = message else { return false }
        return WorkstationCloseReason.names(code)
    }

    private func handleHello(
        sessionId: String, latestSeq: Int, firstAvailableSeq: Int? = nil, state: JSONValue?
    ) {
        // The seq this attach asked to resume from, read before a replacement
        // session resets it below.
        let resumedFrom = lastSeq
        // Whether the gateway resumed the session this stream was already
        // reducing. The server replays `seq > fromSeq` for a resumed session and
        // everything it has for a replacement one (`replayFromForSession`), and
        // that difference is exactly what "already seen" means below.
        let isResumedSession = currentSessionId == nil || currentSessionId == sessionId
        if let existing = currentSessionId, existing != sessionId {
            // Keep the in-progress assistant bubble and tool cards: a
            // replacement gateway session is a transport boundary, not a new
            // turn, so live deltas must keep painting the same rows.
            lastSeq = 0
            announcedGapThroughSeq = 0
            appendSessionBoundary()
        }
        currentSessionId = sessionId
        isConnected = true
        // `hello` is not a model confirmation. The first catalog response after
        // this attach is ordered behind any setter left by the replaced client.
        hasModelSnapshot = false
        asleep = nil
        preparingPod = nil
        waking = false
        endWorkstationWait()
        reconnecting = false
        reconnectAttempt = 0
        writeError(nil)
        podUnavailable = false
        sessionEnded = false
        sessionEndedMessage = ""
        // The gateway replays each surface's newest frame and outstanding input
        // request after this hello, so the previous set is dropped first.
        remoteUI.resetForAttach(preservingEditorSubmissions: isResumedSession)
        replayThroughSeq = latestSeq
        // A prompt this client put on the wire and never saw echoed was very
        // likely persisted before the socket dropped — the gateway writes the
        // `user_prompt` row before it fans anything out — so it is inside the
        // replay that follows this hello. Those bubbles, and only those, may be
        // adopted by a replayed echo; without this the replay appended a second
        // "You" bubble beside the failed local one and Retry sent the same
        // instruction to the agent twice. A replacement session replays a
        // different transcript, so nothing carries over into it.
        pendingEchoItemIds = isResumedSession
            ? Set(
                items.filter {
                    $0.style == .user && $0.delivery != .delivered
                        && serverBoundItemIds.contains($0.id)
                }.map(\.id)
            )
            : []
        if !isResumedSession { serverBoundItemIds.removeAll() }
        // Shell output accumulates per bash id, and the gateway re-sends its own
        // snapshot after every attach; the first frame per id below is that
        // snapshot rather than an increment.
        bashSnapshotAdopted.removeAll()
        if !isResumedSession { bashOutput.removeAll() }
        // History below `firstAvailableSeq` was truncated on the server: this
        // attach asked to resume from a point that no longer exists, and the
        // events in between are gone rather than merely unsent.
        if let firstAvailableSeq, firstAvailableSeq > resumedFrom + 1 {
            appendReplayGapStatus(fromSeq: resumedFrom + 1, toSeq: firstAvailableSeq - 1)
        }

        streaming = state?["isStreaming"]?.boolValue ?? false
        compacting = state?["isCompacting"]?.boolValue ?? false
        let pendingCount = state?["pendingMessageCount"]?.doubleValue ?? 0
        if pendingCount > 0 { streaming = true }
        // The snapshot is authoritative: a stale local "awaiting reply" flag
        // from a previous attach must not keep the working indicator and
        // Interrupt alive when the server is idle.
        if !streaming, pendingCount <= 0 { awaitingReply = false }
        updateRunningState()

        // `hello`'s state.model / thinkingLevel is a stale default, not truth.
        // Only the models catalog response confirms a switch; otherwise a prompt
        // could be released while the gateway is still applying it.

        // The gateway re-sends every dialog still open right after hello, so
        // anything answered elsewhere while detached is gone from this list.
        openDialogs.removeAll()
        _ = socket?.requestModels()
        usage.attached()
        flushQueuedOffline()
        Task { await refreshPodRecord() }
    }

    /// A model receipt still matters when prior activity is temporarily unseen.
    /// On a new, empty conversation the confirmed picker label is sufficient.
    private var transcriptHasConversation: Bool {
        items.contains { $0.style != .status }
            || isLoadingHistory || historyLoadFailed || announcedGapThroughSeq > 0
    }

    private func applyModels(
        _ models: [JSONValue], current: JSONValue?,
        thinkingLevel: String?, thinkingLevels: [String], requestID: String?
    ) {
        let choices = models.compactMap { ModelChoice.from($0) }
        availableModels = choices
        let selected = ModelChoice.from(current)
        let confirmsPendingSelection = requestID == pendingSelectionRequestID
            || (requestID == nil && allowUncorrelatedSelectionConfirmation)
        if let pending = pendingModel {
            // A snapshot that still reports the old model is not an
            // acknowledgement. Keep the request pending and keep Send disabled.
            if selected == pending, confirmsPendingSelection {
                currentModel = choices.first { $0 == selected } ?? pending
                ModelMemory.remember(currentModel ?? pending)
                setPendingModelSwitch(nil)
                selectionNeedsAttention = false
                credentialSettingsNeeded = false
                modelBeforePending = nil
                pendingSelectionRequestID = nil
                allowUncorrelatedSelectionConfirmation = false
                lastPendingModelSnapshot = nil
                pendingModelMismatchCount = 0
                if transcriptHasConversation {
                    appendStatus("Model switched to \(currentModel?.name ?? pending.name).")
                }
            } else if let selected {
                currentModel = choices.first { $0 == selected } ?? selected
                if lastPendingModelSnapshot == currentModel {
                    pendingModelMismatchCount += 1
                } else {
                    lastPendingModelSnapshot = currentModel
                    pendingModelMismatchCount = 1
                }
                if let modelBeforePending, currentModel != modelBeforePending {
                    selectionNeedsAttention = true
                } else if pendingModelMismatchCount >= 2 {
                    selectionNeedsAttention = true
                }
            }
        } else if let selected {
            currentModel = choices.first { $0 == selected } ?? selected
        }
        // The catalog is truth for the model snapshot: first arrival flips this
        // so the UI can drop its neutral placeholder.
        hasModelSnapshot = true
        availableThinkingLevels = thinkingLevels
        if let pending = pendingThinkingLevel {
            if thinkingLevel == pending, confirmsPendingSelection {
                currentThinkingLevel = pending
                setPendingThinkingSwitch(nil)
                selectionNeedsAttention = false
                thinkingBeforePending = nil
                pendingSelectionRequestID = nil
                allowUncorrelatedSelectionConfirmation = false
                lastPendingThinkingSnapshot = nil
                pendingThinkingMismatchCount = 0
                if transcriptHasConversation {
                    appendStatus("Thinking level changed to \(ThinkingLevelChoice.label(pending)).")
                }
            } else if let thinkingLevel {
                currentThinkingLevel = thinkingLevel
                if lastPendingThinkingSnapshot == currentThinkingLevel {
                    pendingThinkingMismatchCount += 1
                } else {
                    lastPendingThinkingSnapshot = currentThinkingLevel
                    pendingThinkingMismatchCount = 1
                }
                if let thinkingBeforePending, currentThinkingLevel != thinkingBeforePending {
                    selectionNeedsAttention = true
                } else if pendingThinkingMismatchCount >= 2 {
                    selectionNeedsAttention = true
                }
            }
        } else if let thinkingLevel {
            currentThinkingLevel = thinkingLevel
        }
        startOnRememberedModel(choices)
        // A parked prompt may only cross the socket after the requested model
        // is confirmed on this connection.
        if pendingModel == nil, pendingThinkingLevel == nil {
            flushQueuedOffline()
        }
    }

    /// A pod this app just launched starts on the model last chosen here (see `ModelMemory`),
    /// once its pi offers a catalog to choose from and only while nothing has been said in it.
    private func startOnRememberedModel(_ choices: [ModelChoice]) {
        guard !choices.isEmpty, pendingModel == nil, pendingThinkingLevel == nil,
              let wanted = ModelMemory.startingModel(podID: podId) else { return }
        ModelMemory.settled(podID: podId)
        let id: (ModelChoice?) -> String? = { $0.map { "\($0.provider)/\($0.modelId)" } }
        // Messages, not `transcriptHasConversation`: history is still loading when the first
        // catalog arrives, and a pod this app just launched has none to load.
        guard !items.contains(where: { $0.style != .status }), id(currentModel) != wanted,
              let choice = choices.first(where: { id($0) == wanted }) else { return }
        _ = requestModel(choice)
    }

    // MARK: - Event reduction

    private func handleEvent(
        id: String,
        seq: Int,
        kind: String,
        timestamp: Date?,
        payload: JSONValue,
        reason: String? = nil
    ) {
        switch kind {
        case "user_prompt":
            let historyImages = SessionStream.historyAttachments(payload)
            guard let text = payload["text"]?.stringValue,
                  !text.isEmpty || !historyImages.isEmpty
            else { return }
            let queuedPromptID = payload["queuedPromptId"]?.stringValue
            if let queuedPromptID, !seenQueuedPromptIDs.insert(queuedPromptID).inserted {
                return
            }
            // Extension bridge commands are persisted as ordinary user prompts
            // so replay stays complete, but they are protocol traffic rather
            // than conversation.
            if isInternalPodCommand(text) { return }
            // A live echo adopts whatever local bubble matches it. A *replayed*
            // one is usually an old turn that happens to read the same, and
            // adopting it would swallow a message the user just typed — so it
            // may only adopt a bubble this attach already knew was unconfirmed.
            let adopted: Bool
            if let queuedPromptID {
                adopted = adoptQueuedPrompt(
                    queuedPromptID, text: text, serverId: id, timestamp: timestamp
                )
            } else {
                adopted = adoptOutgoing(
                    text: text, serverId: id, timestamp: timestamp,
                    imageCount: historyImages.count,
                    restrictedTo: seq <= replayThroughSeq ? pendingEchoItemIds : nil
                )
            }
            if !adopted {
                append(
                    StreamItem(
                        id: id, style: .user, title: "You", text: text,
                        timestamp: timestamp,
                        delivery: queuedPromptID == nil ? .delivered : .savedOnServer,
                        attachments: historyImages
                    )
                )
                if let queuedPromptID {
                    queuedPromptItemIDs[queuedPromptID] = id
                }
            } else if let queuedPromptID,
                      let api,
                      queuedPromptItemIDs[queuedPromptID] != nil {
                // The echo is persisted before runtime acceptance. Re-read the
                // queue row for a locally tracked submission rather than
                // treating the transcript event as a delivery receipt.
                Task { await refreshQueuedPromptStatus(queuedPromptID, api: api) }
            }
            sessionEnded = false
            sessionEndedMessage = ""

        case "agent_start", "turn_start", "auto_retry_start":
            streaming = true
            sessionEnded = false
            sessionEndedMessage = ""
            updateRunningState()

        case "agent_settled":
            streaming = false
            awaitingReply = false
            updateRunningState()
            usage.refresh()

        case "compaction_start":
            compacting = true
            updateRunningState()

        case "compaction_end":
            compacting = false
            updateRunningState()
            // Summarizing the history is itself priced usage.
            usage.refresh()

        case "agent_end", "turn_end", "session_info_changed":
            break

        case "message_start":
            guard messageRole(payload) == "assistant" else { return }
            streaming = true
            updateRunningState()
            activeAssistantItemId = id
            append(
                StreamItem(
                    id: id, style: .assistant, title: "pi", text: "",
                    timestamp: timestamp, isInProgress: true
                )
            )

        case "message_update":
            guard messageRole(payload) == "assistant" else { return }
            let itemId = activeAssistantItemId ?? id
            activeAssistantItemId = itemId
            upsertAssistant(
                itemId, visibleMessageText(payload), timestamp, inProgress: true
            )

        case "message_end":
            guard messageRole(payload) == "assistant" else { return }
            let itemId = activeAssistantItemId ?? id
            let text = visibleMessageText(payload)
            if let failure = messageFailure(payload) {
                upsertAssistant(itemId, failure, timestamp, inProgress: false, isError: true)
            } else if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                items.removeAll { $0.id == itemId }
                scrollIsStreamingUpdate = false
                scrollRevision += 1
            } else {
                upsertAssistant(itemId, text, timestamp, inProgress: false)
            }
            activeAssistantItemId = nil
            // Each finished reply is priced, so a long tool-calling turn shows
            // its spend growing instead of jumping once at the end.
            usage.refresh()

        case "tool_execution_start", "tool_execution_update", "tool_execution_end":
            upsertTool(id: id, seq: seq, kind: kind, timestamp: timestamp, payload: payload)

        case "bash_execution_update":
            appendBashOutput(id: id, timestamp: timestamp, payload: payload)

        case "bash_execution_end":
            settleBashOutput(payload)

        case "session_ended":
            let endedReason = reason ?? payload["reason"]?.stringValue
            // Live host stops wait; replayed rows and waits already in flight
            // never erase the wait. Idle reasons fall through to the end copy.
            if workstationWait != nil {
                if endedReason.flatMap(WorkstationDemandDetail.fromCloseReason) != nil {
                    _ = enterHostWaitIfNeeded(reason: endedReason)
                }
                break
            }
            if seq > replayThroughSeq, enterHostWaitIfNeeded(reason: endedReason) { break }
            let endedKind = payload["kind"]?.stringValue
            let resolved = (endedKind?.isEmpty == false)
                ? endedKind! : SessionStream.endKind(endedReason)
            if resolved == "retryable" { return }
            applySessionEnd(
                reason: endedReason, kind: endedKind, itemId: id, timestamp: timestamp,
                // A replayed row says a *previous* session ended. Only an end
                // that is happening now takes the live transport down with it.
                closesTransport: seq > replayThroughSeq
            )

        default:
            break
        }
    }

    private func updateRunningState() {
        isRunning = streaming || compacting || awaitingReply
        if !isRunning { isInterrupting = false }
    }

    /// Drops the transport exactly once, leaving the reducer in the same state a
    /// disconnect would have.
    private func teardownTransport() {
        guard let socket else { return }
        self.socket = nil
        // `onMessage` stays: anything still in flight on the way down is worth
        // reducing, and a fresh prompt reopens the transcript. `onDisconnect`
        // goes, so the close this triggers cannot run the disconnect path a
        // second time.
        socket.onDisconnect = nil
        socket.disconnect(notify: false)
        isConnected = false
        isInterrupting = false
        setPendingModelSwitch(nil)
        setPendingThinkingSwitch(nil)
        selectionNeedsAttention = false
        modelBeforePending = nil
        thinkingBeforePending = nil
        lastPendingModelSnapshot = nil
        pendingModelMismatchCount = 0
        lastPendingThinkingSnapshot = nil
        pendingThinkingMismatchCount = 0
        pendingSelectionRequestID = nil
        allowUncorrelatedSelectionConfirmation = false
        failInFlightSends()
    }

    /// Closes out whatever the ended session left mid-flight.
    ///
    /// A turn still marked in progress renders as a live "Thinking…" spinner, and
    /// on a replayed transcript that is a lie: the session demonstrably stopped.
    /// A partial reply keeps its text and simply stops claiming to be growing; a
    /// turn that never produced a character carries nothing, and the status line
    /// appended right below it already says what happened.
    private func settleInFlightItems() {
        items.removeAll { item in
            item.isInProgress && item.style == .assistant
                && item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        for index in items.indices where items[index].isInProgress {
            items[index].isInProgress = false
        }
        streaming = false
        compacting = false
        awaitingReply = false
    }

    private func upsertAssistant(
        _ id: String, _ text: String, _ timestamp: Date?,
        inProgress: Bool, isError: Bool = false
    ) {
        if let index = items.firstIndex(where: { $0.id == id }) {
            items[index].text = text
            items[index].isInProgress = inProgress
            items[index].isError = isError
            if items[index].timestamp == nil { items[index].timestamp = timestamp }
            scrollIsStreamingUpdate = inProgress
            scrollRevision += 1
            return
        }
        append(
            StreamItem(
                id: id, style: .assistant, title: "pi", text: text,
                timestamp: timestamp, isInProgress: inProgress, isError: isError
            )
        )
    }

    private func upsertTool(
        id: String, seq: Int, kind: String, timestamp: Date?, payload: JSONValue
    ) {
        let callId = payload["toolCallId"]?.stringValue ?? "tool-\(seq)"
        let toolName = payload["toolName"]?.stringValue ?? "tool"
        let itemId = toolItemIds[callId] ?? id
        toolItemIds[callId] = itemId
        let isEnd = kind == "tool_execution_end"
        let isError = payload["isError"]?.boolValue ?? false
        let title = isEnd
            ? (isError ? "\(toolName) failed" : "\(toolName) completed")
            : "Running \(toolName)"
        let text = toolText(payload, ended: isEnd, isError: isError)
        if let index = items.firstIndex(where: { $0.id == itemId }) {
            items[index].title = title
            if !text.isEmpty { items[index].text = text }
            items[index].isInProgress = !isEnd
            items[index].isError = isError
            scrollIsStreamingUpdate = !isEnd
            scrollRevision += 1
            return
        }
        append(
            StreamItem(
                id: itemId, style: .tool, title: title, text: text,
                timestamp: timestamp, isInProgress: !isEnd, isError: isError
            )
        )
    }

    /// `bash_execution_update` streams one shell command's output. The payload
    /// carries `{id, delta}` and nothing else, so the card is keyed on that id
    /// and grows by appending.
    private func appendBashOutput(id: String, timestamp: Date?, payload: JSONValue) {
        guard let bashId = payload["id"]?.stringValue, !bashId.isEmpty,
              let delta = payload["delta"]?.stringValue, !delta.isEmpty
        else { return }
        let previous = bashOutput[bashId] ?? ""
        // Live frames carry an increment; the first frame for a command after an
        // attach is the gateway's own accumulated snapshot (`bashSnapshots`,
        // replayed right after hello). Appending that would print the output
        // twice — and the server keeps only the LAST 64 KiB, so for a long
        // -running command the snapshot does not even start with what is already
        // on screen and a prefix test cannot recognize it. The attach boundary
        // can: the first frame per id replaces, the rest append.
        let isSnapshot = bashSnapshotAdopted.insert(bashId).inserted
        let combined: String
        if isSnapshot || delta.hasPrefix(previous) {
            combined = delta
        } else {
            combined = previous + delta
        }
        // Bounded the way the gateway bounds its own copy, so a command that
        // prints for an hour cannot grow this map without limit.
        bashOutput[bashId] = SessionLimits.tail(combined)
        let itemId = toolItemIds[bashId] ?? id
        toolItemIds[bashId] = itemId
        let text = truncated(SessionStream.redactingSecrets(combined))
        if let index = items.firstIndex(where: { $0.id == itemId }) {
            items[index].text = text
            items[index].isInProgress = true
            scrollIsStreamingUpdate = true
            scrollRevision += 1
            return
        }
        append(
            StreamItem(
                id: itemId, style: .tool, title: "Running bash", text: text,
                timestamp: timestamp, isInProgress: true
            )
        )
    }

    /// The shell command finished; its card stops claiming to be running.
    private func settleBashOutput(_ payload: JSONValue) {
        guard let bashId = payload["id"]?.stringValue, !bashId.isEmpty else { return }
        bashOutput.removeValue(forKey: bashId)
        bashSnapshotAdopted.remove(bashId)
        guard let itemId = toolItemIds[bashId],
              let index = items.firstIndex(where: { $0.id == itemId })
        else { return }
        items[index].title = "bash completed"
        items[index].isInProgress = false
        scrollIsStreamingUpdate = false
        scrollRevision += 1
    }

    private func append(_ item: StreamItem) {
        items.append(item)
        scrollIsStreamingUpdate = false
        scrollRevision += 1
    }

    /// The one place that words a hole in the transcript. A bounded replay and a
    /// truncated history are the same fact to the person reading it, and the
    /// server can report both for one attach — so a range already announced is
    /// not announced again.
    private func appendReplayGapStatus(fromSeq: Int, toSeq: Int) {
        guard toSeq > announcedGapThroughSeq else { return }
        announcedGapThroughSeq = toSeq
        let skipped = toSeq >= fromSeq ? toSeq - fromSeq + 1 : 0
        appendStatus(
            skipped > 0
                ? "Some earlier activity (\(skipped) events) isn’t shown here; it stayed on the pod."
                : "Some earlier activity isn’t shown here; it stayed on the pod."
        )
    }

    private func appendStatus(_ text: String) {
        append(
            StreamItem(id: "local:\(syntheticId)", style: .status, title: "", text: text)
        )
        syntheticId -= 1
    }

    /// A replacement gateway session is a divider, not a new turn. If a reply is
    /// still streaming, the marker goes above that bubble so later deltas
    /// continue it.
    private func appendSessionBoundary() {
        let item = StreamItem(
            id: "local:\(syntheticId)",
            style: .status,
            title: "",
            text: (waking || asleep != nil) ? "Pod woke up." : "Connection restored."
        )
        syntheticId -= 1
        if let index = items.lastIndex(where: { $0.isInProgress }) {
            items.insert(item, at: index)
            scrollIsStreamingUpdate = false
            scrollRevision += 1
            return
        }
        append(item)
    }

    // MARK: - Session end

    private func applySessionEnd(
        reason: String?, kind: String?, itemId: String? = nil, timestamp: Date? = nil,
        closesTransport: Bool = true
    ) {
        let resolvedKind = (kind?.isEmpty == false) ? kind! : SessionStream.endKind(reason)
        streaming = false
        compacting = false
        awaitingReply = false
        if resolvedKind == "retryable" {
            updateRunningState()
            return
        }
        shouldReconnect = false
        // The session is over: this transport cannot carry another turn. Closing
        // it here rather than waiting for a close frame is what lets the screen
        // offer "Wake" — while `isConnected` stayed true the banner never
        // appeared and the next send failed instantly against a dead socket.
        if closesTransport { teardownTransport() }
        // The pod's components died with the session; nothing can answer their
        // outstanding input requests.
        remoteUI.clear()
        settleInFlightItems()
        let message = SessionStream.endMessage(kind: resolvedKind, reason: reason)
        if let itemId {
            append(
                StreamItem(
                    id: itemId, style: .status, title: "", text: message, timestamp: timestamp
                )
            )
        } else {
            appendStatus(message)
        }
        sessionEnded = true
        sessionEndedMessage = message
        reconnecting = false
        if resolvedKind == "asleep" {
            // An archived sandbox comes back in minutes and a stopped one in
            // seconds, so the wake affordance says which. `host_archived` is the
            // co-located case: the machine underneath was archived.
            asleep = ["archived", "archive", "provider_archived", "host_archived"]
                .contains(reason ?? "") ? "archived" : "stopped"
        }
        if resolvedKind == "unavailable" { podUnavailable = true }
        updateRunningState()
    }

    /// The client half of the server's `sessionEndDisposition`
    /// (`gateway/session-state.ts`), for the paths that carry a reason without a
    /// kind — chiefly the `pod_state: detached` frame the gateway fans out right
    /// after `session_ended`. A reason missing from here falls through to
    /// "unavailable", which tells the reader to go and check a pod that is
    /// merely asleep.
    public static func endKind(_ reason: String?) -> String {
        switch reason {
        case "gateway_shutdown", "transport_lost", "handshake_failed", "persist_failed":
            return "retryable"
        case "idle_stop", "archived", "archive", "provider_stopped", "provider_archived",
             "host_stopped", "host_archived":
            return "asleep"
        case "pi_exit": return "exited"
        default: return "unavailable"
        }
    }

    public static func endMessage(kind: String, reason: String?) -> String {
        switch kind {
        case "asleep":
            return "Pod went to sleep. Your conversation and files are preserved."
        case "exited":
            return "Pi exited. Send a message to start it again."
        case "retryable":
            return "Connection restored."
        default:
            if reason == "gone" || reason == "delete" {
                return "This pod is no longer available."
            }
            return "This pod is unavailable. Check its status on the pod screen."
        }
    }

    // MARK: - Pod record

    /// The pod's launch failed, so it will never hold a conversation; the error says why.
    public var launchFailed: Bool { podRecord?.didFail == true }

    private func setPodRecord(_ pod: Pod) {
        guard podRecord != pod else { return }
        podRecord = pod
        if renamedPodName == pod.name { renamedPodName = nil }
    }

    private func refreshPodRecord() async {
        guard let api else { return }
        let knownName = podRecord?.name
        do {
            let current = try await api.pod(id: podId)
            // A rename that landed while this request was in flight wins.
            if let knownName, let recorded = podRecord?.name, recorded != knownName { return }
            setPodRecord(current)
        } catch {
            return
        }
    }

    private func applyPodUpdated(id: String, name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, id == podId || id.isEmpty else { return }
        if podRecord != nil {
            if podRecord?.name != trimmed { renamedPodName = trimmed }
            return
        }
        renamedPodName = trimmed
        Task { await refreshPodRecord() }
    }

    // MARK: - Errors

    private func writeError(_ value: String?, gatewayError: String? = nil) {
        error = value
        self.gatewayError = gatewayError
    }

    private func friendly(code: String?, message: String) -> String {
        switch code {
        case "pod_unavailable":
            return "This pod is unavailable. Check its status on the pod screen, then retry."
        case "pod_not_found":
            return "This pod no longer exists."
        case "unauthorized":
            return "The connection is no longer authorized. Retry to reconnect."
        case "credential_reconnect_required":
            return "Reconnect your model provider in Settings before switching models."
        default:
            break
        }
        let lower = message.lowercased()
        if lower.contains("pod is stopped") || lower.contains("not started") {
            return "This pod is temporarily unavailable. Retry in a moment."
        }
        if lower.contains("network") || lower.contains("not connected") {
            return "Couldn’t connect to the pod. Check your connection and retry."
        }
        return FriendlyError.message(serverText: message)
    }

    // MARK: - Payload readers

    private func eventId(_ sessionId: String?, _ seq: Int) -> String {
        "\(sessionId ?? "pending"):\(seq)"
    }

    private func isInternalPodCommand(_ text: String) -> Bool {
        text.drop(while: { $0.isWhitespace }).hasPrefix("/pod:_")
    }

    private func messageRole(_ payload: JSONValue) -> String? {
        payload["message"]?["role"]?.stringValue
    }

    private func messageFailure(_ payload: JSONValue) -> String? {
        guard let message = payload["message"], message.objectValue != nil else { return nil }
        let stopReason = message["stopReason"]?.stringValue
        let raw = message["errorMessage"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if stopReason != "error", raw.isEmpty { return nil }
        if raw.isEmpty { return "pi could not complete this turn." }
        return SessionStream.readableModelError(raw)
    }

    /// Providers wrap their real message in a JSON blob glued onto a prefix;
    /// showing that raw is how a person ends up reading a stack trace.
    public static func readableModelError(_ raw: String) -> String {
        var detail: String?
        if let start = raw.firstIndex(of: "{"),
           let object = JSONValue.parse(String(raw[start...])) {
            if let nested = object["error"], nested.objectValue != nil,
               let text = nested["message"]?.stringValue {
                detail = text
            } else if let text = object["message"]?.stringValue {
                detail = text
            }
        }
        let message = redactingSecrets(
            (detail ?? raw).trimmingCharacters(in: .whitespacesAndNewlines)
        )
        let friendly = FriendlyError.message(serverText: message)
        if message.lowercased().contains("api key") {
            return friendly + """
                \n\nUpdate the key in Settings, then launch a new pod so it picks up the change.
                """
        }
        return friendly
    }

    private func visibleMessageText(_ payload: JSONValue) -> String {
        SessionStream.redactingSecrets(rawMessageText(payload))
    }

    private func rawMessageText(_ payload: JSONValue) -> String {
        guard let message = payload["message"], message.objectValue != nil else {
            return payload["text"]?.stringValue ?? ""
        }
        guard let content = message["content"] else { return "" }
        if let text = content.stringValue { return text }
        guard let blocks = content.arrayValue else { return "" }
        return blocks.compactMap { block -> String? in
            guard block["type"]?.stringValue == "text" else { return nil }
            return block["text"]?.stringValue
        }.joined()
    }

    private func toolText(_ payload: JSONValue, ended: Bool, isError: Bool) -> String {
        var resultText = ""
        if let result = payload["result"], let blocks = result["content"]?.arrayValue {
            resultText = blocks.compactMap { $0["text"]?.stringValue }.joined(separator: "\n")
        }
        if !resultText.isEmpty {
            // Output the tool has already produced beats the arguments it was
            // called with, finished or not: a `tool_execution_update` carries
            // both, and showing the arguments hid every partial result until the
            // call ended.
            let visible = SessionStream.redactingSecrets(resultText)
            return truncated(ended && isError ? FriendlyError.message(serverText: visible) : visible)
        }
        if let args = payload["args"], args.objectValue != nil {
            return truncated(SessionStream.redactingSecrets(args.prettyPrinted()))
        }
        return truncated(SessionStream.redactingSecrets(resultText))
    }

    /// Hides `NAME=value` assignments whose name looks like a credential, so a
    /// tool that echoes its environment does not paste a token into the
    /// transcript.
    public static func redactingSecrets(_ text: String) -> String {
        guard !text.isEmpty else { return text }
        let markers = ["TOKEN", "SECRET", "KEY", "PASSWORD", "CREDENTIAL"]
        return text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let characters = Array(line)
            guard let equals = characters.firstIndex(of: "=") else { return String(line) }
            var spaced = equals
            while spaced > 0, characters[spaced - 1] == " " { spaced -= 1 }
            var start = spaced
            while start > 0, isNameCharacter(characters[start - 1]) { start -= 1 }
            let name = String(characters[start..<spaced])
            guard !name.isEmpty, name.count <= 64, markers.contains(where: name.contains)
            else { return String(line) }
            return String(characters[0..<start]) + name
                + String(characters[spaced..<equals]) + "=<hidden>"
        }.joined(separator: "\n")
    }

    private static func isNameCharacter(_ character: Character) -> Bool {
        character.isASCII && (character.isUppercase || character.isNumber || character == "_")
    }

    private func truncated(_ text: String, limit: Int = 4000) -> String {
        guard text.count > limit else { return text }
        return String(text.prefix(limit)) + "\n… (truncated)"
    }

    /// Decodes a `user_prompt` payload's `images`. Two shapes exist: descriptors
    /// (`{mimeType, bytes}`), which is what the server persists today and become
    /// size placeholders, and full blocks (`{mimeType, data}` base64), accepted
    /// for forward compatibility.
    ///
    /// Both obey the *replay* budgets, not the narrower composer caps, so a
    /// valid 8-image CLI turn survives intact. Base64 length is checked on the
    /// string before decoding so a hostile row cannot force a huge allocation.
    public static func historyAttachments(_ payload: JSONValue) -> [StreamImageAttachment] {
        guard let raw = payload["images"]?.arrayValue else { return [] }
        var result: [StreamImageAttachment] = []
        var total = 0
        for entry in raw {
            guard entry.objectValue != nil else { continue }
            if result.count >= ChatAttachmentLimits.maxHistoryCount { break }
            guard let mimeType = entry["mimeType"]?.stringValue,
                  ChatAttachmentLimits.supportedMimeTypes.contains(mimeType)
            else { continue }

            if let data = entry["data"]?.stringValue {
                guard !data.isEmpty,
                      data.count <= ChatAttachmentLimits.maxImageBase64Chars,
                      let bytes = Data(base64Encoded: data, options: [.ignoreUnknownCharacters]),
                      !bytes.isEmpty,
                      bytes.count <= ChatAttachmentLimits.maxBytesPerImage
                else { continue }
                if total + bytes.count > ChatAttachmentLimits.maxHistoryTotalBytes { break }
                total += bytes.count
                let name = entry["name"]?.stringValue?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                result.append(
                    StreamImageAttachment(
                        name: name.isEmpty ? "image" : name, mimeType: mimeType, bytes: bytes
                    )
                )
            } else if let declared = entry["bytes"]?.intValue {
                guard declared > 0, declared <= ChatAttachmentLimits.maxBytesPerImage
                else { continue }
                if total + declared > ChatAttachmentLimits.maxHistoryTotalBytes { break }
                total += declared
                result.append(
                    StreamImageAttachment(
                        name: "image.\(ChatAttachmentLimits.fileExtension(forMime: mimeType))",
                        mimeType: mimeType,
                        bytes: Data(),
                        declaredBytes: declared
                    )
                )
            }
            // Entries with neither `data` nor `bytes` carry nothing renderable.
        }
        return result
    }

    // MARK: - Dialogs

    /// A dialog pi raised. Anything that is not one is ignored.
    private func showDialog(_ payload: JSONValue) {
        guard let dialog = PiDialog(request: payload),
              !openDialogs.contains(where: { $0.id == dialog.id })
        else { return }
        openDialogs.append(dialog)
        scrollRevision += 1
    }

    private func closeDialog(_ id: String) {
        guard openDialogs.contains(where: { $0.id == id }) else { return }
        openDialogs.removeAll { $0.id == id }
        scrollRevision += 1
    }

    /// Sends the answer and leaves a line in the transcript saying what it was.
    /// False while disconnected: the card stays, and pi keeps waiting.
    public func answer(_ dialog: PiDialog, with response: JSONValue) -> Bool {
        guard isConnected, let socket, socket.uiResponse(response) else { return false }
        closeDialog(dialog.id)
        appendStatus(dialog.receipt(for: response))
        return true
    }
}
