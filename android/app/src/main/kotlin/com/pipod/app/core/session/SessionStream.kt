package com.pipod.app.core.session

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.ConversationEventRecord
import com.pipod.app.core.api.model.ConversationEventsPage
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.QueuedPromptReceipt
import com.pipod.app.core.api.model.WorkstationDemand
import com.pipod.app.core.api.model.WorkstationNotReadyException
import com.pipod.app.core.api.model.WorkstationStatus
import com.pipod.app.core.api.model.WsTicket
import com.pipod.app.core.auth.OidcSessionExpiredException
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.workstation.WorkstationStatusSource
import com.pipod.app.core.workstation.WorkstationWaitOutcome
import com.pipod.app.core.workstation.WorkstationWaitSession
import com.pipod.app.core.workstation.WorkstationWaitState
import java.io.IOException
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeParseException
import java.util.Base64
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Narrow session-only API surface, so lifecycle and replay tests can use fakes
 * without an HTTP server.
 */
interface SessionApi {
    suspend fun pod(id: String): Pod
    suspend fun conversationEvents(podId: String, before: String? = null, limit: Int = 200): ConversationEventsPage
    suspend fun wsTicket(podId: String): WsTicket
    suspend fun queuePrompt(podId: String, text: String): QueuedPromptReceipt

    /**
     * The durable state of the reader's own workstation. Defaulted so a fake
     * that predates the route keeps compiling and simply reports nothing, which
     * makes the wait fall back to re-attaching on its own schedule.
     */
    suspend fun workstation(hostId: String): WorkstationStatus? = null
}

class ApiClientSessionApi(private val client: ApiClient) : SessionApi {
    override suspend fun pod(id: String): Pod = client.pod(id)

    override suspend fun conversationEvents(podId: String, before: String?, limit: Int): ConversationEventsPage =
        client.conversationEvents(podId = podId, before = before, limit = limit)

    override suspend fun wsTicket(podId: String): WsTicket = client.wsTicket(podId)

    override suspend fun queuePrompt(podId: String, text: String): QueuedPromptReceipt =
        client.queuePrompt(podId = podId, text = text)

    override suspend fun workstation(hostId: String): WorkstationStatus? = client.workstation(hostId)
}

fun interface SessionTransportFactory {
    fun create(podId: String, fromSeq: Long?, fromSessionId: String?): SessionTransport
}

/**
 * Everything a session screen renders, as one conflated snapshot.
 *
 * The Dart original is a `ChangeNotifier` with mutable public fields; a single
 * immutable state object is the Compose-shaped equivalent and gives the
 * "writing the same value does not repaint" property for free, because
 * [StateFlow] drops an equal value.
 */
data class SessionStreamState(
    val items: List<StreamItem> = emptyList(),
    val pendingInteractions: List<PendingInteraction> = emptyList(),
    val availableModels: List<ModelChoice> = emptyList(),
    val availableThinkingLevels: List<String> = emptyList(),
    val isConnected: Boolean = false,
    val reconnecting: Boolean = false,
    val reconnectAttempt: Int = 0,
    val isOffline: Boolean = false,
    val isRunning: Boolean = false,
    val isInterrupting: Boolean = false,
    /** Bumped for every transcript mutation; a screen watches it to decide when to scroll. */
    val scrollRevision: Int = 0,
    val scrollIsStreamingUpdate: Boolean = false,
    val currentModel: ModelChoice? = null,
    val currentThinkingLevel: String? = null,
    /**
     * True after the first models catalog. Until then [currentModel] and
     * [currentThinkingLevel] are unset — hello's stale defaults are ignored — so
     * the UI shows a neutral placeholder instead of a wrong model name.
     */
    val hasModelSnapshot: Boolean = false,
    val isModelSwitchInFlight: Boolean = false,
    val isThinkingSwitchInFlight: Boolean = false,
    /**
     * Two catalogs can be equal in selection yet differ in content. The counter
     * makes every refresh observable, which the Dart original achieved with a
     * bare `notifyListeners()`.
     */
    val modelCatalogRevision: Int = 0,
    val preparingPod: Pod? = null,
    val podRecord: Pod? = null,
    val isLoadingHistory: Boolean = true,
    val sessionEnded: Boolean = false,
    val sessionEndedMessage: String = "",
    val historyLoadFailed: Boolean = false,
    val podUnavailable: Boolean = false,
    val asleep: String? = null,
    val waking: Boolean = false,
    /**
     * The reader's own personal workstation, when the gateway refused the attach
     * because it is not running. This is **not** [asleep]: an asleep pod wakes on
     * the next keystroke, while a workstation is a whole VM whose measured start
     * is minutes. The two never both apply.
     */
    val workstationWait: WorkstationWaitState? = null,
    val error: String? = null,
    /**
     * Raw gateway text, retained only so a banner can independently apply the
     * same presentation boundary the transcript does.
     */
    val gatewayError: String? = null,
    /** Working-state overrides a pod extension pushed through remote-UI control frames. */
    val workingMessage: String? = null,
    val workingVisible: Boolean = false,
    val workingIndicator: String? = null,
    val hiddenThinkingLabel: String? = null,
    val expandedToolDetails: Set<String> = emptySet(),
    val toolsExpandedByExtension: Boolean = false,
) {
    /** Tool cards the user has opened, keyed as the transcript presentation keys them. */
    fun isToolExpanded(key: String): Boolean = toolsExpandedByExtension || key in expandedToolDetails
}

/**
 * Owns ticket minting, resumable attach/replay, transcript reduction, and
 * reconnect. Session boundaries append status dividers; they never clear the
 * transcript.
 *
 * Port of `pi-pod-flutter/lib/core/session/session_stream.dart`.
 *
 * Reducer entry points are mutually excluded: transport callbacks arrive on
 * OkHttp's reader thread while the user's taps arrive on the main thread, and
 * the Dart original could assume one isolate.
 */
class SessionStream(
    val podId: String,
    fromSeq: Long?,
    sessionId: String? = null,
    api: SessionApi? = null,
    socketFactory: SessionTransportFactory? = null,
    private val now: () -> Instant = Instant::now,
    private val reconnectDelay: (attempt: Int) -> Duration = ::defaultReconnectDelay,
    scope: CoroutineScope? = null,
    /**
     * Fetches the server's still-pending approvals so restored cards that only
     * carry the pi request id can adopt the gateway uuid they resolve with.
     * Wired from the [ApiClient] in production; tests inject a fake. A failure
     * keeps the cards and retries on the next attach — only a submit surfaces
     * an error.
     */
    var pendingInteractionsFetcher: (suspend () -> List<PendingInteraction>)? = null,
    /**
     * True while the device has a network. Collected for as long as the stream
     * is attached, so "Offline" and the reattach on the online edge need no
     * cooperation from the screen. Defaults to whatever `AppContainer`
     * installed in [SessionEnvironment]; null means nothing observes
     * connectivity and [setOffline] is the only way in.
     */
    connectivity: StateFlow<Boolean>? = null,
) {

    private val ownsScope = scope == null

    /**
     * Runs the reducer's own background work — ticket minting, durable queueing,
     * reconciliation. Mutual exclusion comes from [lock], not from the
     * dispatcher, because transport callbacks arrive on OkHttp's thread and
     * never touch this scope at all.
     */
    private val scope = scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Mutual exclusion for every reducer entry point. */
    private val lock = Any()

    /**
     * Extension-owned TUI surfaces rendered in the pod. Empty unless the pod
     * runs an extension that opens one.
     *
     * It shares this reducer's monitor: frames are applied while the lock is
     * held, and answering a surface's input request calls back in to write to
     * the socket, so a lock of its own would be a second lock order.
     */
    val remoteUi: RemoteUiStore = RemoteUiStore(lock = lock)

    private val _state = MutableStateFlow(SessionStreamState())
    val state: StateFlow<SessionStreamState> = _state.asStateFlow()

    private val socketFactory: SessionTransportFactory = socketFactory
        ?: SessionEnvironment.transportFactory
        ?: SessionTransportFactory { podId, seq, session ->
            SessionSocket(podId = podId, fromSeq = seq, fromSessionId = session)
        }

    private val connectivity: StateFlow<Boolean>? = connectivity ?: SessionEnvironment.connectivity

    // --- transcript and protocol state --------------------------------------

    private val transcript = mutableListOf<StreamItem>()
    private val pending = mutableListOf<PendingInteraction>()
    private val availableModels = mutableListOf<ModelChoice>()
    private val availableThinkingLevels = mutableListOf<String>()
    private val expandedToolDetails = mutableSetOf<String>()

    private var isConnected = false
    private var reconnecting = false
    private var reconnectAttempt = 0
    private var isOffline = false
    private var isRunning = false
    private var isInterrupting = false
    private var scrollRevision = 0
    private var scrollIsStreamingUpdate = false
    private var currentModel: ModelChoice? = null
    private var currentThinkingLevel: String? = null
    private var hasModelSnapshot = false
    private var modelCatalogRevision = 0

    /**
     * Optimistic switch targets. While set, server catalog snapshots for that
     * field are ignored so a post-send `requestModels` round trip cannot revert
     * the row the user just tapped. Cleared on the next models/hello snapshot.
     */
    private var pendingModelSwitch: ModelChoice? = null
    private var pendingThinkingSwitch: String? = null

    private var preparingPod: Pod? = null
    private var podRecord: Pod? = null
    private var isLoadingHistory = true
    private var sessionEnded = false
    private var sessionEndedMessage = ""
    private var historyLoadFailed = false
    private var podUnavailable = false
    private var asleep: String? = null
    private var waking = false
    private var error: String? = null
    private var gatewayError: String? = null
    private var workingMessage: String? = null
    private var workingVisible = false
    private var workingIndicator: String? = null
    private var hiddenThinkingLabel: String? = null
    private var toolsExpandedByExtension = false

    private var activeApi: SessionApi? = api
    private var socket: SessionTransport? = null
    private var seqCursor: Long = fromSeq ?: 0
    private var streamSessionId: String? = sessionId
    private var connectionGeneration = 0
    private var shouldReconnect = false
    private var syntheticId = -1
    private val seenEventIds = mutableSetOf<String>()
    private var activeAssistantItemId: String? = null
    private val toolItemIds = mutableMapOf<String, String>()

    /**
     * Image turns parked while offline or preparing, keyed by item id so a
     * retry, reconnect flush or discard finds the bytes the bubble shows.
     */
    private val pendingAttachments = mutableMapOf<String, List<StreamImageAttachment>>()

    /**
     * For each locally-sent bubble, the newest seq the conversation was known to
     * have reached when it was created.
     *
     * The echo of that send is necessarily *above* this mark, because the
     * gateway persists it afterwards; anything at or below is an older row that
     * happens to share its text. Recorded per bubble rather than read from the
     * current hello, which is what makes a reconnect work: by the time the
     * replacement hello arrives the prompt has already been persisted, so the
     * hello's own `latestSeq` is above it and the replay looked like history —
     * a second "You" bubble beside the failed original, and a Retry that sent
     * the same instruction to the agent twice.
     */
    private val sendWatermarks = mutableMapOf<String, Long>()

    private var isStreaming = false
    private var isCompacting = false
    private var awaitingReply = false

    /** The newest seq the server has reported, across hellos and replay. */
    private var serverWatermark: Long = 0
    private var lastSettledSeq: Long = 0
    private var reconnectJob: Job? = null
    private var connectivityJob: Job? = null
    private val resolvedSubscription: Job

    /**
     * Accumulated `!command` bash output per execution id, so a chunk and the
     * whole-output snapshot the gateway replays on attach do not both land.
     *
     * Capped at the same 64 KiB tail the gateway keeps
     * (`gateway/readiness.ts` `bashSnapshotAccumulate`) so the two agree about
     * what "everything so far" is: with a larger local copy the snapshot the
     * gateway replays on reattach is no longer a prefix of it, and the
     * supersede heuristic below would append the tail a second time.
     */
    private val bashOutput = mutableMapOf<String, String>()

    /**
     * One workstation wait, and what it is re-issuing.
     *
     * The attach is callback-driven, so the wait's "re-issue the original
     * request" step connects and then parks on [attachOutcome] until the gateway
     * either says hello (ready) or refuses again with a host reason (keep
     * waiting).
     */
    private class WorkstationWaitSlot {
        var session: WorkstationWaitSession? = null
        var job: Job? = null
        /** The demand the live wait is holding, so Cancel can wake its parked attach. */
        var demand: WorkstationDemand? = null
        var state: WorkstationWaitState? = null
        /**
         * Invalidates late `onState` callbacks from a superseded or
         * hello-cleared wait. Bumped every time the slot is cleared so a
         * racing progress tick or resting card cannot reassert a wait over a
         * live session.
         */
        var generation: Int = 0
    }

    /**
     * The gateway refusing an attach and the durable queue refusing a send are
     * two independent requests against the same workstation, so they get a wait
     * each. Sharing one slot meant whichever started second cancelled the first,
     * and the superseded one's parked message stayed at
     * [StreamItemDelivery.WAITING_FOR_CONNECTION] with nothing left to re-issue
     * it.
     */
    private val attachWait = WorkstationWaitSlot()
    private val sendWait = WorkstationWaitSlot()

    private var attachOutcome: CompletableDeferred<Unit>? = null

    /**
     * The gateway's `error` frame just before a close, when it sent one. The
     * gateway attaches the typed host-demand object to the frame it sends
     * immediately before closing with 4420, so the close reason alone is not
     * always the whole story — and a bare 4420 with no host reason anywhere is
     * still just an asleep pod. Cleared on every hello.
     */
    private var lastGatewayRefusalCode: String? = null
    private var lastGatewayRefusalDetail: JsonObject? = null
    private var lastGatewayRefusalMessage: String? = null

    init {
        // Warms the durable receipt cache so a replayed `interaction_resolved`
        // after a cold restart still finds the specific wording. Fire-and-forget:
        // receipts are a convenience and must not delay attach.
        this.scope.launch { InteractionReceiptStore.load() }
        // UNDISPATCHED so the subscription exists the moment the constructor
        // returns, as Dart's synchronous `listen` did: a resolution posted
        // immediately afterwards must not be missed.
        resolvedSubscription = this.scope.launch(start = CoroutineStart.UNDISPATCHED) {
            SessionNotifications.interactionResolved.stream.collect(::onInteractionResolvedNotification)
        }
        remoteUi.responder = ::sendUiResponse
        remoteUi.onControl = ::applyRemoteUiControl
        // An extension-owned editor submits the same way pi's own does: the text
        // becomes a user prompt.
        remoteUi.onEditorSubmit = { _, text -> if (text.trim().isNotEmpty()) send(text) }
        publish()
    }

    // --- read-through accessors ---------------------------------------------

    /**
     * The current snapshot. Everything the Dart original exposed as a mutable
     * field lives here; only the two collections a caller reaches for on every
     * line get a shorthand of their own.
     */
    val snapshot: SessionStreamState get() = _state.value

    val items: List<StreamItem> get() = _state.value.items
    val pendingInteractions: List<PendingInteraction> get() = _state.value.pendingInteractions
    /** The replay cursor a reconnect resumes from. */
    val lastSeq: Long get() = synchronized(lock) { seqCursor }
    val sessionId: String? get() = synchronized(lock) { streamSessionId }

    // --- lifecycle ----------------------------------------------------------

    suspend fun openWithClient(client: ApiClient) = open(ApiClientSessionApi(client))

    suspend fun open(api: SessionApi) {
        synchronized(lock) { activeApi = api }
        try {
            val current = api.pod(podId)
            val branch = synchronized(lock) {
                setPodRecord(current)
                when {
                    current.initializing -> {
                        preparingPod = current
                        isLoadingHistory = false
                        publish()
                        OpenBranch.PREPARING
                    }

                    current.isAsleep -> {
                        asleep = current.sandboxState
                        publish()
                        OpenBranch.ASLEEP
                    }

                    else -> OpenBranch.ATTACH
                }
            }
            when (branch) {
                OpenBranch.PREPARING -> {
                    waitForPreparation(api)
                    return
                }

                OpenBranch.ASLEEP -> {
                    loadHistory(api)
                    return
                }

                OpenBranch.ATTACH -> Unit
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // The attach path remains authoritative when the pod snapshot is
            // temporarily unreachable.
        }
        loadHistory(api)
        synchronized(lock) {
            sessionEnded = false
            sessionEndedMessage = ""
            asleep = null
            publish()
        }
        attach(api)
    }

    private enum class OpenBranch { PREPARING, ASLEEP, ATTACH }

    private suspend fun waitForPreparation(api: SessionApi) {
        while (synchronized(lock) { shouldReconnect || preparingPod != null }) {
            try {
                val current = api.pod(podId)
                val done = synchronized(lock) {
                    setPodRecord(current)
                    preparingPod = if (current.initializing) current else null
                    if (current.didFail) {
                        val reason = current.friendlyStateReason
                        setError(
                            if (reason == null) "The sandbox could not be prepared." else FriendlyError.message(reason),
                        )
                        publish()
                        return
                    }
                    publish()
                    !current.initializing
                }
                if (done) {
                    attach(api)
                    return
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (caught: Throwable) {
                synchronized(lock) {
                    // A host-demand 503 is not a stalled progress poll: the
                    // reader's own workstation is starting, and this two-second
                    // loop already IS the retry it asks for — so it gets the
                    // workstation's own sentence rather than that sentence
                    // wrapped in one blaming the sandbox. A second polling loop
                    // over the top of this one is what stacks waits.
                    val workstation = FriendlyError.workstationMessage(caught)
                    setError(
                        workstation
                            ?: "Couldn’t refresh sandbox progress. Retrying… ${FriendlyError.message(caught)}",
                    )
                    publish()
                }
            }
            delay(2.seconds)
        }
    }

    private suspend fun loadHistory(api: SessionApi) {
        synchronized(lock) {
            historyLoadFailed = false
            publish()
        }
        try {
            val pages = mutableListOf<ConversationEventsPage>()
            var before: String? = null
            for (count in 0 until MAX_HISTORY_PAGES) {
                val page = api.conversationEvents(podId = podId, before = before, limit = 200)
                pages += page
                before = page.nextBefore ?: break
            }
            synchronized(lock) { pages.asReversed().forEach { ingestHistory(it.events) } }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            synchronized(lock) {
                historyLoadFailed = true
                setError("Conversation history couldn’t be loaded. Retry.")
            }
        } finally {
            synchronized(lock) {
                isLoadingHistory = false
                publish()
            }
        }
    }

    fun loadHistoryForTesting(pages: List<ConversationEventsPage>) = synchronized(lock) {
        historyLoadFailed = false
        isLoadingHistory = false
        pages.asReversed().forEach { ingestHistory(it.events) }
        publish()
    }

    private fun ingestHistory(events: List<ConversationEventRecord>) {
        for (event in events) {
            val id = eventId(event.sessionId, event.seq)
            if (!seenEventIds.add(id)) continue
            val payload = event.payload as? JsonObject ?: JsonObject(emptyMap())
            handleEvent(
                id = id,
                seq = event.seq,
                kind = event.kind,
                timestamp = parseTimestamp(event.createdAt),
                payload = payload,
                reason = payload.string("reason"),
            )
            streamSessionId = event.sessionId
            seqCursor = event.seq
        }
        serverWatermark = maxOf(serverWatermark, seqCursor)
    }

    /**
     * Every call mints a new ticket. Tickets are one-shot and are never retained
     * for retries or foreground reconnects.
     *
     * @param fromWorkstationWait true when the call comes from the wait's own
     * re-issue step. A fresh user intent (retry button, foreground, wake)
     * supersedes any wait in flight, so only those paths cancel one.
     */
    suspend fun attach(api: SessionApi? = null, fromWorkstationWait: Boolean = false) {
        val resolvedApiAndGeneration = synchronized(lock) {
            val next = api ?: activeApi ?: throw IllegalStateException("A SessionApi is required before attaching.")
            activeApi = next
            shouldReconnect = true
            connectionGeneration += 1
            isConnected = false
            reconnecting = socket != null || reconnectAttempt > 0
            setError(null)
            podUnavailable = false
            if (!fromWorkstationWait) {
                // A fresh attach supersedes the attach-path wait and any resting
                // card it left behind; a refusal will raise a new one. A
                // send-path wait is a different request and is left running.
                cancelWaitLocked(attachWait)
                // A refusal frame belongs to the connection that carried it; a
                // fresh attach must not inherit the previous one's.
                lastGatewayRefusalCode = null
                lastGatewayRefusalDetail = null
                lastGatewayRefusalMessage = null
            }
            reconnectJob?.cancel()
            releaseTransport(socket)
            socket = null
            publish()
            next to connectionGeneration
        }
        LiveSessionStreams.register(this)
        startWatchingConnectivity()
        val (resolvedApi, generation) = resolvedApiAndGeneration
        try {
            val ticket = resolvedApi.wsTicket(podId)
            synchronized(lock) {
                if (!shouldReconnect || generation != connectionGeneration) return
                val transport = socketFactory.create(podId, seqCursor, streamSessionId)
                socket = transport
                transport.onMessage = { message ->
                    synchronized(lock) { if (generation == connectionGeneration) handle(message) }
                }
                transport.onDisconnect = { _, closeCode, closeReason ->
                    synchronized(lock) {
                        if (generation != connectionGeneration) return@synchronized
                        if (!shouldReconnect) {
                            // A host 4420 must still reach the wait even after
                            // `session_ended` cleared the reconnect flag — otherwise
                            // the close naming the workstation is swallowed and the
                            // pod renders idle Asleep. Other closes still need a live session.
                            val host = closeCode == SessionCloseCode.ASLEEP &&
                                workstationDemandFromClose(closeReason) != null
                            if (!host) return@synchronized
                        }
                        handleDisconnect(resolvedApi, generation, closeCode, closeReason)
                    }
                }
                transport.connect(ticket.ticket)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (caught: Throwable) {
            // Minting the ticket itself can be refused because the workstation
            // is not ready. Inside a wait that refusal is fuel, not failure:
            // it keeps the wait going instead of banner-ing an error. Outside
            // one — a wake, a retry, an open — it starts the wait, so the same
            // attach is re-issued on the wait's schedule.
            val gate = synchronized(lock) { attachOutcome }
            val demand = WorkstationDemand.fromThrowable(caught)
            if (gate != null && demand != null) {
                gate.completeExceptionally(WorkstationNotReadyException(demand))
                return
            }
            if (gate != null) {
                gate.completeExceptionally(caught)
                return
            }
            if (demand != null) {
                synchronized(lock) {
                    if (generation != connectionGeneration || !shouldReconnect) return
                    reconnecting = false
                    waking = false
                    startWorkstationWaitLocked(attachWait, resolvedApi, demand) {
                        attachAndAwaitReady(resolvedApi)
                    }
                }
                return
            }
            synchronized(lock) {
                if (generation != connectionGeneration || !shouldReconnect) return
                waking = false
                setError(FriendlyError.message(caught))
                // A ticket mint that failed because the network blinked is the
                // ordinary case, and it used to end the session for good: the
                // reconnect ladder only ever ran from a socket that had managed
                // to open once. Keep climbing it, with the same backoff, unless
                // the failure says retrying is pointless.
                if (isRetriableAttachFailure(caught)) {
                    scheduleReconnect(resolvedApi, generation)
                } else {
                    reconnecting = false
                }
                publish()
            }
        }
    }

    /**
     * Whether a failed ticket mint is worth another attempt.
     *
     * An expired session and a pod that no longer exists are answers, not
     * outages: retrying either one produces the same failure every time and
     * spends a request per attempt doing it.
     */
    private fun isRetriableAttachFailure(error: Throwable): Boolean {
        if (error is OidcSessionExpiredException) return false
        val api = error as? ApiError ?: return true
        if (api.httpStatus == 404 || api.httpStatus == 403) return false
        return api.error != "pod_not_found" && api.error != "not_found"
    }

    /**
     * Watches the device's connectivity for as long as this stream is attached.
     *
     * The stream drives it itself rather than waiting to be told: the session
     * screen is one of several things holding a stream, and a banner that only
     * appears when a particular screen happens to be observing is not a status.
     */
    private fun startWatchingConnectivity() {
        val flow = connectivity ?: return
        synchronized(lock) {
            if (connectivityJob?.isActive == true) return
            connectivityJob = scope.launch {
                flow.collect { online -> setOffline(!online) }
            }
        }
    }

    /**
     * Closes a transport for good. [SessionSocket] owns a coroutine scope for
     * its ping loop; a reconnect that only disconnected left one per attempt
     * alive for the life of the process.
     */
    private fun releaseTransport(transport: SessionTransport?) {
        if (transport == null) return
        transport.disconnect(notify = false)
        transport.dispose()
    }

    /**
     * Call from the app lifecycle's foreground callback. It reconnects only a
     * live session that was interrupted, and therefore mints a new ticket.
     */
    fun reattachIfNeeded() {
        val api = synchronized(lock) {
            if (!shouldReconnect || isConnected) null else activeApi
        } ?: return
        scope.launch { attach(api) }
    }

    fun onForeground() = reattachIfNeeded()

    fun setOffline(offline: Boolean) {
        val shouldReattach = synchronized(lock) {
            val wasOffline = isOffline
            isOffline = offline
            publish()
            wasOffline && !offline && shouldReconnect && !isConnected
        }
        if (shouldReattach) reattachIfNeeded()
    }

    fun detach() = synchronized(lock) {
        shouldReconnect = false
        reconnecting = false
        reconnectAttempt = 0
        connectionGeneration += 1
        reconnectJob?.cancel()
        reconnectJob = null
        connectivityJob?.cancel()
        connectivityJob = null
        releaseTransport(socket)
        socket = null
        isConnected = false
        waking = false
        cancelWaitLocked(attachWait)
        cancelWaitLocked(sendWait)
        // Bash output belongs to the attach that streamed it; a later one
        // replays its own snapshot and must not extend a stale accumulation.
        bashOutput.clear()
        // An interrupt or switch in flight is moot once the transport is gone:
        // the optimistic selection stays, but rows must not stay disabled and
        // the stopping spinner must not survive the session.
        isInterrupting = false
        pendingModelSwitch = null
        pendingThinkingSwitch = null
        publish()
    }

    fun dispose() {
        LiveSessionStreams.unregister(this)
        detach()
        remoteUi.dispose()
        resolvedSubscription.cancel()
        if (ownsScope) scope.cancel()
    }

    fun wake() {
        val api = synchronized(lock) {
            if (activeApi == null || isConnected || waking) return
            waking = true
            publish()
            activeApi
        } ?: return
        scope.launch { attach(api) }
    }

    /**
     * Ends this app's wait for the reader's own workstation. The workstation
     * keeps starting on the server and files are retained — only the waiting
     * stops here. Responsive: a wait parked on an attach completes immediately
     * so the resting card replaces the spinner without a round trip.
     */
    fun cancelWorkstationWait() = synchronized(lock) {
        // One card, one Cancel: both waits are for the same workstation, so
        // stopping the visible one must not leave the other polling behind it.
        attachWait.session?.cancel()
        sendWait.session?.cancel()
        val demand = attachWait.demand
        if (demand != null) {
            attachOutcome?.completeExceptionally(WorkstationNotReadyException(demand))
        }
    }

    /**
     * Re-issues the attach now instead of on the wait's next tick. Any wait in
     * flight is superseded first — it never stacks — and a refusal raises a
     * fresh wait. Never creates a duplicate: it is the same attach.
     */
    fun retryWorkstationWait() {
        val api = synchronized(lock) { activeApi } ?: return
        scope.launch { attach(api) }
    }

    /**
     * A workstation wait for the session screen: the gateway refused the attach
     * (or the durable queue refused a send) because the reader's own
     * workstation is not running. [request] is re-issued every cycle; [onReady]
     * runs only when it finally succeeds. A wait in the *same* slot is
     * superseded; the other slot is left alone.
     *
     * Call with [lock] held: every field it touches is also written from the
     * transport's reader thread, and both of the call sites outside
     * [handleDisconnect] used to run this after releasing the monitor.
     */
    private fun startWorkstationWaitLocked(
        slot: WorkstationWaitSlot,
        api: SessionApi,
        demand: WorkstationDemand,
        onReady: () -> Unit = {},
        request: suspend () -> Unit,
    ) {
        cancelWaitLocked(slot)
        if (slot === attachWait) {
            // The attach wait owns reconnecting now: stray reconnect jobs must
            // not attach behind it and double-mint tickets. A send-path wait
            // says nothing whatsoever about the socket — writing these from
            // there erased the "asleep" banner and killed the reconnect ladder
            // for a message typed at a sleeping pod.
            shouldReconnect = true
            reconnecting = false
            reconnectJob?.cancel()
            reconnectJob = null
            waking = false
            asleep = null
            // A host stop is recoverable, not an end: the 4420 close that
            // follows a host `session_ended` must still find a wait, not an
            // idle Asleep banner. `idle_stop` never reaches here.
            sessionEnded = false
            sessionEndedMessage = ""
            setError(null)
        }
        slot.demand = demand
        val generation = slot.generation
        val session = WorkstationWaitSession(
            status = WorkstationStatusSource { hostId -> api.workstation(hostId) },
            onState = { wait ->
                synchronized(lock) {
                    if (generation != slot.generation) return@synchronized
                    // An attach wait is over once the session is live: a late tick
                    // from a hello-cleared slot must not reassert the card. The
                    // demand gate keeps legitimate entries that arrive while still
                    // connected (`session_ended` / `detached` host reasons set the
                    // demand before the first progress tick) working.
                    if (slot === attachWait && isConnected && slot.demand == null) return@synchronized
                    slot.state = wait
                    publish()
                }
            },
        )
        slot.session = session
        slot.job = scope.launch {
            when (val outcome = session.runFor(demand) { request() }) {
                is WorkstationWaitOutcome.Ready -> synchronized(lock) {
                    slot.demand = null
                    if (slot === attachWait) attachOutcome = null
                    onReady()
                    setError(null)
                    publish()
                }

                is WorkstationWaitOutcome.Failed -> synchronized(lock) {
                    slot.demand = null
                    if (slot === attachWait) attachOutcome = null
                    if (!isConnected) setError(FriendlyError.message(outcome.error))
                    publish()
                }

                // Terminal, expired and cancelled all publish their resting card
                // through onState; there is nothing further to draw.
                else -> synchronized(lock) {
                    slot.demand = null
                    if (slot === attachWait) attachOutcome = null
                    publish()
                }
            }
        }
        publish()
    }

    /**
     * The wait's re-issue step for an attach: connect, then park until the
     * gateway either says hello (ready) or refuses again. Must be called with
     * `fromWorkstationWait = true` so the attempt joins the wait instead of
     * superseding it.
     */
    private suspend fun attachAndAwaitReady(api: SessionApi) {
        val gate = CompletableDeferred<Unit>()
        synchronized(lock) { attachOutcome = gate }
        try {
            attach(api, fromWorkstationWait = true)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (caught: Throwable) {
            val demand = WorkstationDemand.fromThrowable(caught)
            if (demand != null) throw WorkstationNotReadyException(demand)
            throw caught
        }
        gate.await()
    }

    /**
     * Reads the close for a workstation wait. 4420 is also the "pod asleep"
     * code, so only a host reason — in the close reason or in the `error` frame
     * that preceded it — identifies one. Anything else is null and the idle
     * path stays byte-identical.
     */
    private fun workstationDemandFromClose(closeReason: String?): WorkstationDemand? {
        val errCode = closeReason?.trim()?.takeIf { it.isNotEmpty() }
            ?: lastGatewayRefusalCode?.trim()?.takeIf { it.isNotEmpty() }
            ?: return null
        return WorkstationDemand.fromCloseFrame(
            errCode = errCode,
            detail = lastGatewayRefusalDetail,
            serverMessage = lastGatewayRefusalMessage,
        )
    }

    /**
     * A host reason carried by `session_ended` or `pod_state detached`
     * (reason-only: those frames carry no typed detail). Only the gateway's
     * own close-frame trio — `host_stopped`, `host_starting`, `host_archived` —
     * identifies a workstation wait; `idle_stop` stays Asleep and everything
     * else falls through to the existing end table.
     */
    private fun hostWaitDemandFromReason(reason: String?): WorkstationDemand? {
        val trimmed = reason?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (trimmed !in WorkstationDemand.CLOSE_FRAME_REASONS) return null
        return WorkstationDemand.fromCloseFrame(errCode = trimmed)
    }

    /** Whether the attach wait was entered (including starting): detached must not erase it. */
    private fun isAttachWaitActive(): Boolean =
        attachWait.demand != null || attachWait.state?.isWaiting == true

    /** Drops a superseded wait without publishing a resting card for it. */
    private fun cancelWaitLocked(slot: WorkstationWaitSlot) {
        // Bump first: an `onState` already in flight from the superseded
        // session captures the old generation and is ignored above.
        slot.generation += 1
        slot.session?.cancel()
        slot.session = null
        slot.job?.cancel()
        slot.job = null
        slot.demand = null
        slot.state = null
        if (slot !== attachWait) return
        attachOutcome?.completeExceptionally(CancellationException("workstation wait superseded"))
        attachOutcome = null
    }

    // --- sending ------------------------------------------------------------

    fun send(text: String, attachments: List<ChatAttachment> = emptyList()) {
        val id = synchronized(lock) {
            val itemId = "local:$syntheticId"
            syntheticId -= 1
            val staged = attachments.map {
                StreamImageAttachment(id = it.id, name = it.name, mimeType = it.mimeType, bytes = it.bytes)
            }
            if (staged.isNotEmpty()) pendingAttachments[itemId] = staged
            // Where the conversation had got to when this was typed: the echo of
            // it lands above this, and nothing at or below it is this send.
            sendWatermarks[itemId] = maxOf(serverWatermark, seqCursor)
            append(
                StreamItem(
                    id = itemId,
                    style = StreamItemStyle.USER,
                    title = "You",
                    text = text,
                    timestamp = now(),
                    delivery = StreamItemDelivery.SENDING,
                    attachments = staged,
                ),
            )
            itemId
        }
        deliver(id, text)
    }

    fun retrySend(id: String) {
        val retry = synchronized(lock) {
            val index = transcript.indexOfFirst { it.id == id }
            if (index < 0) return
            val text = transcript[index].text
            val staged = pendingAttachments.remove(id) ?: transcript[index].attachments
            transcript.removeAt(index)
            sendWatermarks.remove(id)
            // Reuse the attachments' stable ids: two same-named images keep
            // distinct identities through the retry instead of colliding on name.
            val stamp = microsecondsSinceEpoch(now())
            text to staged.mapIndexed { position, attachment ->
                ChatAttachment(
                    id = attachment.id.ifEmpty { "retry-$stamp-$position" },
                    name = attachment.name,
                    mimeType = attachment.mimeType,
                    bytes = attachment.bytes,
                )
            }
        }
        send(retry.first, retry.second)
    }

    fun discardOutgoing(id: String) {
        synchronized(lock) {
            if (transcript.none { it.id == id }) return
            transcript.removeAll { it.id == id }
            pendingAttachments.remove(id)
            sendWatermarks.remove(id)
            bump()
        }
    }

    private fun wireImages(id: String): List<SessionImage>? {
        val staged = pendingAttachments[id]
        if (staged.isNullOrEmpty()) return null
        return staged.map {
            SessionImage(mimeType = it.mimeType, base64Data = Base64.getEncoder().encodeToString(it.bytes))
        }
    }

    private fun deliver(id: String, text: String) {
        val queue = synchronized(lock) {
            if (isConnected) {
                val transport = socket
                if (transport == null || !transport.prompt(text, wireImages(id))) {
                    setDelivery(id, StreamItemDelivery.FAILED)
                    return
                }
                pendingAttachments.remove(id)
                setDelivery(id, StreamItemDelivery.SENDING)
                awaitingReply = true
                updateRunningState()
                publish()
                return
            }
            if (preparingPod != null && pendingAttachments[id] == null) {
                true
            } else {
                // Image turns cannot ride the durable queue endpoint — it only
                // persists text — so they park in memory and flush on the next
                // hello instead of being silently downgraded to text.
                setDelivery(id, StreamItemDelivery.WAITING_FOR_CONNECTION)
                false
            }
        }
        if (queue) {
            scope.launch { queueDurably(id, text) }
            return
        }
        wake()
    }

    private suspend fun queueDurably(id: String, text: String) {
        val api = synchronized(lock) { activeApi }
        if (api == null) {
            synchronized(lock) { setDelivery(id, StreamItemDelivery.FAILED) }
            return
        }
        try {
            api.queuePrompt(podId = podId, text = text)
            synchronized(lock) {
                setDelivery(id, StreamItemDelivery.SAVED_ON_SERVER)
                setError(null)
                publish()
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (caught: Throwable) {
            // The workstation being down is not a failed send: the message parks
            // and the same queuePrompt is re-issued on the wait's schedule until
            // the server admits it. Terminal refusals rest on the card.
            val demand = WorkstationDemand.fromThrowable(caught)
            if (demand != null) {
                synchronized(lock) {
                    setDelivery(id, StreamItemDelivery.WAITING_FOR_CONNECTION)
                    startWorkstationWaitLocked(sendWait, api, demand, request = {
                        api.queuePrompt(podId = podId, text = text)
                    }, onReady = {
                        setDelivery(id, StreamItemDelivery.SAVED_ON_SERVER)
                    })
                }
                return
            }
            synchronized(lock) {
                setDelivery(id, StreamItemDelivery.FAILED)
                setError("Message wasn’t saved: ${FriendlyError.message(caught)}")
                publish()
            }
        }
    }

    private fun setDelivery(id: String, delivery: StreamItemDelivery) {
        val index = transcript.indexOfFirst { it.id == id }
        if (index < 0 || transcript[index].delivery == delivery) return
        transcript[index] = transcript[index].copy(delivery = delivery)
        bump()
    }

    /**
     * Adopts the locally-sent bubble when the server echoes it back.
     *
     * The image count must match exactly: a text-only echo must not adopt an
     * image turn (or vice versa), and the local bytes stay on the item so
     * thumbnails survive the round trip — the server only persists descriptors.
     *
     * [seq] must be above the bubble's own [sendWatermarks] entry. That is what
     * separates this send's echo from an older row that happens to repeat its
     * text, and it is per bubble rather than a single stream-wide line because
     * the line moves: by the time a reconnect's hello arrives, the prompt that
     * was in flight has already been persisted and sits *below* the new
     * `latestSeq`.
     */
    private fun adoptOutgoing(
        text: String,
        serverId: String,
        timestamp: Instant?,
        seq: Long,
        imageCount: Int = 0,
    ): Boolean {
        val index = transcript.indexOfFirst {
            it.style == StreamItemStyle.USER &&
                it.delivery != StreamItemDelivery.DELIVERED &&
                it.text == text &&
                it.attachments.size == imageCount &&
                seq > (sendWatermarks[it.id] ?: 0L)
        }
        if (index < 0) return false
        val local = transcript[index].id
        pendingAttachments.remove(local)
        sendWatermarks.remove(local)
        transcript[index] = transcript[index].copy(
            id = serverId,
            delivery = StreamItemDelivery.DELIVERED,
            timestamp = timestamp ?: transcript[index].timestamp,
        )
        bump()
        return true
    }

    private fun failInFlightSends() {
        var changed = false
        for (index in transcript.indices) {
            if (transcript[index].delivery == StreamItemDelivery.SENDING) {
                transcript[index] = transcript[index].copy(delivery = StreamItemDelivery.FAILED)
                changed = true
            }
        }
        if (changed) bump()
    }

    /**
     * Releases the socket and everything that only makes sense while one is
     * open.
     *
     * Idempotent: on the close-driven path [handleDisconnect] has already nulled
     * `socket`, and [releaseTransport] no-ops on null.
     */
    private fun teardownTransport() {
        isConnected = false
        isInterrupting = false
        pendingModelSwitch = null
        pendingThinkingSwitch = null
        reconnectJob?.cancel()
        reconnectJob = null
        releaseTransport(socket)
        socket = null
        bashOutput.clear()
        failInFlightSends()
    }

    /**
     * Stops every row that was still painting. An assistant bubble that never
     * got any text is dropped rather than left empty; everything else keeps its
     * partial content without the spinner.
     */
    private fun settleInFlightItems() {
        var changed = false
        val settled = mutableListOf<StreamItem>()
        for (item in transcript) {
            if (!item.isInProgress) {
                settled += item
                continue
            }
            changed = true
            if (item.style == StreamItemStyle.ASSISTANT && item.text.isBlank()) continue
            settled += item.copy(isInProgress = false)
        }
        if (!changed) return
        transcript.clear()
        transcript += settled
        activeAssistantItemId = null
        bump()
    }

    // --- turn controls ------------------------------------------------------

    fun interrupt() {
        synchronized(lock) {
            val transport = socket
            if (!isConnected || !isRunning || transport == null || !transport.interrupt()) return
            isInterrupting = true
            appendStatus("You stopped this turn.")
        }
    }

    fun refreshModels() {
        synchronized(lock) { if (isConnected) socket?.requestModels() }
    }

    fun selectModel(model: ModelChoice): Boolean = synchronized(lock) {
        if (model == currentModel) return true
        val transport = socket
        if (!isConnected ||
            transport == null ||
            !transport.set(model = mapOf("provider" to model.provider, "id" to model.modelId))
        ) {
            setError("Couldn’t switch models because the pod isn’t connected. Reconnect and try again.")
            publish()
            return false
        }
        pendingModelSwitch = model
        currentModel = model
        appendStatus("Model switched to ${model.name}.")
        transport.requestModels()
        true
    }

    fun selectThinkingLevel(level: String): Boolean = synchronized(lock) {
        if (level == currentThinkingLevel) return true
        val transport = socket
        if (!isConnected ||
            !availableThinkingLevels.contains(level) ||
            transport == null ||
            !transport.set(thinkingLevel = level)
        ) {
            setError("Couldn’t change the thinking level because the pod isn’t connected.")
            publish()
            return false
        }
        pendingThinkingSwitch = level
        currentThinkingLevel = level
        appendStatus("Thinking level changed to $level.")
        transport.requestModels()
        true
    }

    fun setToolExpanded(key: String, expanded: Boolean) = synchronized(lock) {
        val changed = if (expanded) expandedToolDetails.add(key) else expandedToolDetails.remove(key)
        if (changed) publish()
    }

    fun isToolExpanded(key: String): Boolean = _state.value.isToolExpanded(key)

    // --- approvals ----------------------------------------------------------

    /**
     * The gateway identifies one approval two ways: the durable uuid it mints
     * (`interactionId` on `interaction` frames and `interaction_resolved`
     * payloads, and the only id the resolve endpoints accept) and the pi request
     * id inside the frame payload (`payload['id']`, carried by the durable
     * `extension_ui_request` event and the ephemeral re-send). Both domains
     * alias one card. Resolving with the request id is what the server rejects
     * (`not_found` -> "validation failed"), so the surviving card always carries
     * the uuid.
     */
    private val uuidByRequestId = mutableMapOf<String, String>()
    private val requestIdByUuid = mutableMapOf<String, String>()

    /**
     * Every id (either domain) known to be resolved, by any surface. Restores
     * for these ids create no card; resolutions for them emit no receipt.
     */
    private val resolvedInteractionIds = mutableSetOf<String>()

    /**
     * Ids (either domain) for which a transcript receipt was already emitted, so
     * a replayed `interaction_resolved` after a local resolve stays silent.
     */
    private val receiptedInteractionIds = mutableSetOf<String>()

    /**
     * Intended answers registered via [beginLocalResolve] before the REST call
     * returns, keyed by every alias of the approval. A racing
     * `interaction_resolved` event consumes the entry to phrase the specific
     * receipt; a REST failure clears it via [cancelLocalResolve].
     */
    private val pendingLocalResolves = mutableMapOf<String, JsonObject?>()

    private var reconcileInFlight = false
    private var reconcilePending = false

    /**
     * Registers the intended answer BEFORE awaiting the REST resolve so a racing
     * `interaction_resolved` WebSocket event (which typically arrives before the
     * POST returns) can phrase the specific "You confirmed …" receipt instead of
     * the generic fallback. Pair with [markInteractionResolved] on success or
     * [cancelLocalResolve] on failure.
     */
    fun beginLocalResolve(id: String, response: JsonObject?) = synchronized(lock) {
        for (key in aliasGroup(id)) pendingLocalResolves[key] = response
    }

    /**
     * Rolls back [beginLocalResolve] when the REST call fails: the card stays
     * and no receipt is emitted.
     */
    fun cancelLocalResolve(id: String) = synchronized(lock) {
        for (key in aliasGroup(id)) pendingLocalResolves.remove(key)
        pendingLocalResolves.remove(id)
        Unit
    }

    /**
     * The id the resolve endpoints accept for [id]: the adopted gateway uuid
     * when known, otherwise [id] unchanged. Restored cards carry the pi request
     * id until [reconcilePendingWithServer] adopts the uuid; posting the request
     * id is what the server rejects with "validation failed".
     */
    fun resolvableIdFor(id: String): String = synchronized(lock) {
        uuidByRequestId[id]?.let { return it }
        for (item in pending) {
            val payloadId = payloadRequestId(item.payload)
            if (payloadId == id && isUuid(item.id)) return item.id
            if (item.id == id && isUuid(item.id)) return item.id
        }
        id
    }

    fun markInteractionResolved(
        id: String,
        deliveryPending: Boolean = false,
        response: JsonObject? = null,
    ) {
        synchronized(lock) {
            markResolvedLocked(id, deliveryPending, response)
        }
        SessionNotifications.interactionResolved.post(id = id, response = response)
    }

    private fun markResolvedLocked(id: String, deliveryPending: Boolean, response: JsonObject?) {
        val group = aliasGroup(id)
        // A racing `interaction_resolved` event already left the specific
        // receipt via the beginLocalResolve intent: do not duplicate it.
        if (group.any(receiptedInteractionIds::contains)) {
            removePendingMatching(id)
            recordResolvedFor(id)
            for (key in group) pendingLocalResolves.remove(key)
            pendingLocalResolves.remove(id)
            if (deliveryPending) {
                appendStatus("Response saved — it reaches the agent when the pod reconnects.")
            }
            publish()
            return
        }
        val removed = removePendingMatching(id)
        recordResolvedFor(id)
        if (removed.isNotEmpty()) {
            receiptedInteractionIds.addAll(aliasGroup(id))
            for (victim in removed) {
                receiptedInteractionIds.add(victim.id)
                payloadRequestId(victim.payload)?.let(receiptedInteractionIds::add)
            }
            val receipt = interactionReceiptText(removed.first(), response)
            appendStatus(receipt)
            persistInteractionReceipt(receiptKeys(group, removed), receipt)
        }
        for (key in group) pendingLocalResolves.remove(key)
        pendingLocalResolves.remove(id)
        for (victim in removed) {
            for (key in aliasGroup(victim.id)) pendingLocalResolves.remove(key)
            payloadRequestId(victim.payload)?.let(pendingLocalResolves::remove)
        }
        if (deliveryPending) {
            appendStatus("Response saved — it reaches the agent when the pod reconnects.")
        }
        publish()
    }

    fun removeInteraction(id: String): Boolean = synchronized(lock) {
        if (pending.none { it.id == id }) return false
        pending.removeAll { it.id == id }
        scrollRevision += 1
        publish()
        true
    }

    /**
     * Best-effort stale detection for approvals the turn left behind: when the
     * agent settled after the request without an answer, the row is moot. The
     * server still returns such rows today, so the list should treat them as
     * "No longer needed" rather than actionable. This heuristic never marks a
     * turn that is still blocked (no settle after the request) as stale.
     */
    fun isInteractionStale(interaction: PendingInteraction): Boolean = synchronized(lock) {
        interaction.seq > 0 && lastSettledSeq > interaction.seq
    }

    /**
     * Adopts gateway uuids from a `GET /v1/interactions?pending=true` listing for
     * restored cards that only carry the pi request id. Matches rows by pod id +
     * `payload.id`, falling back to kind + title (+ seq when both carry one).
     * Keeps the request-id alias so either domain still resolves the same card.
     * Returns how many cards adopted a uuid.
     */
    fun adoptUuids(rows: List<PendingInteraction>): Int = synchronized(lock) {
        val candidates = rows.filter { it.id.isNotEmpty() && (it.podId.isEmpty() || it.podId == podId) }
        if (candidates.isEmpty()) return 0
        var adopted = 0
        for (index in pending.indices) {
            val local = pending[index]
            if (isUuid(local.id)) continue
            if (resolvedInteractionIds.contains(local.id)) continue
            val localRequest = canonicalRequestId(local)
            var match: PendingInteraction? = null
            if (localRequest != null) {
                match = candidates.firstOrNull { isUuid(it.id) && payloadRequestId(it.payload) == localRequest }
            }
            if (match == null) {
                val localTitle = interactionTitle(local).trim()
                for (row in candidates) {
                    if (!isUuid(row.id)) continue
                    if (pending.any { it.id == row.id }) continue
                    if (row.kind != local.kind && row.kind != "extension_ui" && local.kind != "extension_ui") continue
                    val rowTitle = interactionTitle(row).trim()
                    val titlesMatch = localTitle.isNotEmpty() && rowTitle == localTitle
                    val seqMatch = local.seq != 0L && row.seq != 0L && row.seq == local.seq
                    if (!titlesMatch && !seqMatch) continue
                    // A bare seq match with empty titles is too weak across kinds.
                    if (!titlesMatch && localTitle.isEmpty() && rowTitle.isEmpty()) continue
                    match = row
                    break
                }
            }
            val resolved = match ?: continue
            val uuid = resolved.id
            val linkRequest = localRequest ?: payloadRequestId(local.payload) ?: local.id
            if (linkRequest != uuid) linkAlias(uuid, linkRequest)
            payloadRequestId(local.payload)?.takeIf { it != uuid }?.let { linkAlias(uuid, it) }
            payloadRequestId(resolved.payload)?.takeIf { it != uuid }?.let { linkAlias(uuid, it) }
            pending[index] = PendingInteraction(
                id = uuid,
                sessionId = local.sessionId.ifEmpty { resolved.sessionId },
                podId = local.podId.ifEmpty { resolved.podId },
                podName = resolved.podName.ifEmpty { local.podName },
                seq = if (resolved.seq != 0L) resolved.seq else local.seq,
                kind = local.kind,
                payload = resolved.payload.takeIf { it != JsonNull } ?: local.payload,
                createdAt = resolved.createdAt.ifEmpty { local.createdAt },
            )
            adopted += 1
        }
        if (adopted > 0) {
            scrollRevision += 1
            publish()
        }
        adopted
    }

    /**
     * Fetches the server's pending approvals and adopts uuids for restored
     * cards. Failures keep the cards for a retry on the next attach; only a
     * submit surfaces an error.
     */
    suspend fun reconcilePendingWithServer() {
        val fetcher = synchronized(lock) {
            val candidate = pendingInteractionsFetcher
            when {
                candidate == null || pending.isEmpty() -> null
                pending.none { !isUuid(it.id) } -> null
                reconcileInFlight -> {
                    reconcilePending = true
                    null
                }

                else -> {
                    reconcileInFlight = true
                    candidate
                }
            }
        } ?: return
        try {
            adoptUuids(fetcher())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // Keep the cards; the next attach retries. Submits surface errors.
        } finally {
            val retry = synchronized(lock) {
                reconcileInFlight = false
                if (reconcilePending) {
                    reconcilePending = false
                    pending.any { !isUuid(it.id) }
                } else {
                    false
                }
            }
            if (retry) reconcilePendingWithServer()
        }
    }

    /**
     * Approvals-tab (REST + notification) resolutions while this session is
     * open. Records the id and its aliases so later replay receipts are
     * suppressed and restores cannot re-create the card. When the resolver
     * carried the answer, the live transcript phrases the same specific receipt
     * an inline resolve would have left, exactly once. A notification without an
     * answer (older callers, replay fan-out) stays silent: the resolver owns the
     * single receipt.
     */
    private fun onInteractionResolvedNotification(event: InteractionResolvedEvent) {
        synchronized(lock) { applyResolvedNotificationLocked(event) }
    }

    private fun applyResolvedNotificationLocked(event: InteractionResolvedEvent) {
        val id = event.id
        val response = event.response
        if (response == null) {
            removePendingMatching(id)
            recordResolvedFor(id)
            publish()
            return
        }
        val group = aliasGroup(id)
        if (group.any(receiptedInteractionIds::contains) || resolvedInteractionIds.contains(id)) {
            removePendingMatching(id)
            recordResolvedFor(id)
            publish()
            return
        }
        val removed = removePendingMatching(id)
        recordResolvedFor(id)
        if (removed.isEmpty()) {
            publish()
            return
        }
        receiptedInteractionIds.addAll(aliasGroup(id))
        for (victim in removed) {
            receiptedInteractionIds.add(victim.id)
            payloadRequestId(victim.payload)?.let(receiptedInteractionIds::add)
        }
        // The notification carried the answer, so this is the specific wording:
        // persist it for later replays.
        val receipt = interactionReceiptText(removed.first(), response)
        appendStatus(receipt)
        persistInteractionReceipt(receiptKeys(group, removed), receipt)
        for (key in group) pendingLocalResolves.remove(key)
        for (victim in removed) {
            pendingLocalResolves.remove(victim.id)
            payloadRequestId(victim.payload)?.let(pendingLocalResolves::remove)
        }
        publish()
    }

    private fun linkAlias(uuid: String, requestId: String) {
        if (uuid == requestId) return
        uuidByRequestId[requestId] = uuid
        requestIdByUuid[uuid] = requestId
    }

    /** An id plus every id known to name the same approval. */
    private fun aliasGroup(id: String): Set<String> {
        val group = mutableSetOf(id)
        uuidByRequestId[id]?.let(group::add)
        requestIdByUuid[id]?.let(group::add)
        for (item in pending) {
            if (item.id == id) continue
            val payloadId = payloadRequestId(item.payload)
            if (payloadId == id || group.contains(item.id)) {
                group.add(item.id)
                payloadId?.let(group::add)
            }
        }
        return group
    }

    private fun pendingIndexFor(id: String): Int {
        val group = aliasGroup(id)
        return pending.indexOfFirst {
            group.contains(it.id) || group.contains(payloadRequestId(it.payload))
        }
    }

    /**
     * Seq-ordered fallback for resolutions that name an unlinked uuid (cold
     * replays carry no `interaction` frames). Removes the oldest pending card
     * raised before [resolveSeq]; durable cards (seq != 0) sort before ephemeral
     * ones. Returns the removed card, if any.
     */
    private fun removeOldestPendingBefore(resolveSeq: Long?): List<PendingInteraction> {
        if (pending.isEmpty()) return emptyList()
        val ordered = pending.sortedBy { if (it.seq == 0L) EPHEMERAL_SORT_KEY else it.seq }
        val victim = ordered.firstOrNull { resolveSeq == null || it.seq == 0L || it.seq < resolveSeq }
        // No card predates the resolution: nothing belongs to this uuid.
            ?: return emptyList()
        pending.remove(victim)
        scrollRevision += 1
        return listOf(victim)
    }

    /**
     * Removes every pending card naming [id] in either domain. Returns the
     * removed cards, oldest first.
     */
    private fun removePendingMatching(id: String): List<PendingInteraction> {
        val group = aliasGroup(id)
        val removed = pending.filter {
            group.contains(it.id) || group.contains(payloadRequestId(it.payload))
        }
        if (removed.isEmpty()) return emptyList()
        pending.removeAll(removed)
        scrollRevision += 1
        return removed
    }

    private fun recordResolvedFor(id: String) {
        resolvedInteractionIds.addAll(aliasGroup(id))
    }

    // --- protocol handling --------------------------------------------------

    fun ingestForTesting(message: SessionServerMessage) = synchronized(lock) { handle(message) }

    fun setPodRecordForTesting(pod: Pod) = synchronized(lock) {
        setPodRecord(pod)
        publish()
    }

    fun markPromptSentForTesting() = synchronized(lock) {
        awaitingReply = true
        updateRunningState()
        publish()
    }

    fun markWakingForTesting() = synchronized(lock) {
        waking = true
        publish()
    }

    private fun handleDisconnect(api: SessionApi, generation: Int, closeCode: SessionCloseCode?, closeReason: String?) {
        isConnected = false
        releaseTransport(socket)
        socket = null
        awaitingReply = false
        isInterrupting = false
        pendingModelSwitch = null
        pendingThinkingSwitch = null
        updateRunningState()
        failInFlightSends()
        when (closeCode) {
            SessionCloseCode.POD_NOT_FOUND -> {
                shouldReconnect = false
                reconnecting = false
                setError("This pod no longer exists. Its sessions are gone with it.")
                waking = false
            }

            SessionCloseCode.POD_UNAVAILABLE -> {
                shouldReconnect = false
                reconnecting = false
                podUnavailable = true
                waking = false
            }

            SessionCloseCode.ASLEEP -> {
                // 4420 is two different facts sharing a code: an idle pod that
                // wakes on the next keystroke, and the reader's own workstation
                // still starting — a whole VM measured in minutes. The reason is
                // what separates them, so it is read before anything here can
                // render idle copy or arm wake-on-keystroke as the fix.
                val demand = workstationDemandFromClose(closeReason)
                val gate = attachOutcome
                if (demand != null && gate != null) {
                    // A re-issue the live wait parked on: keep waiting with the
                    // freshest demand, and say nothing about sleeping pods.
                    // The wait is recoverable even when a host `session_ended`
                    // already marked the session ended.
                    sessionEnded = false
                    sessionEndedMessage = ""
                    asleep = null
                    gate.completeExceptionally(WorkstationNotReadyException(demand))
                    publish()
                    return
                }
                if (demand != null) {
                    startWorkstationWaitLocked(attachWait, api, demand) { attachAndAwaitReady(api) }
                    return
                }
                if (gate != null) {
                    // The wait owned this surface: a close that names no host
                    // reason ends the wait as a plain failure instead of
                    // rewriting it into an idle pod after the fact.
                    gate.completeExceptionally(
                        IOException("The session closed while waiting for the workstation."),
                    )
                    attachOutcome = null
                    publish()
                    return
                }
                shouldReconnect = false
                reconnecting = false
                waking = false
                if (!sessionEnded) applySessionEnd("idle_stop", "asleep")
            }

            SessionCloseCode.PI_EXITED -> {
                shouldReconnect = false
                reconnecting = false
                waking = false
                if (!sessionEnded) applySessionEnd("pi_exit", "exited")
            }

            SessionCloseCode.BAD_REQUEST -> {
                shouldReconnect = false
                reconnecting = false
                setError(
                    "The app sent something this server couldn’t understand. " +
                        "Update the app if this keeps happening.",
                )
                waking = false
            }

            SessionCloseCode.UNAUTHORIZED,
            SessionCloseCode.TRANSIENT,
            SessionCloseCode.GOING_AWAY,
            null,
            -> {
                // A parked wait owns its own re-issue schedule: failing the gate
                // ends the wait as a plain failure instead of leaking a frozen
                // card, while the reconnect path below stays exactly as it was.
                attachOutcome?.let { gate ->
                    gate.completeExceptionally(
                        IOException("The session closed while waiting for the workstation."),
                    )
                    attachOutcome = null
                }
                scheduleReconnect(api, generation)
            }
        }
        // Terminal closes that land mid-wait end it as a plain failure: the
        // branch above already drew their own state, and the wait must not be
        // left parked on an attach that will never answer.
        attachOutcome?.let { gate ->
            gate.completeExceptionally(
                IOException("The session closed while waiting for the workstation."),
            )
            attachOutcome = null
        }
        publish()
    }

    private fun scheduleReconnect(api: SessionApi, generation: Int) {
        reconnecting = true
        if (isOffline) return
        reconnectAttempt += 1
        reconnectJob?.cancel()
        val wait = reconnectDelay(reconnectAttempt)
        reconnectJob = scope.launch {
            delay(wait)
            val go = synchronized(lock) {
                generation == connectionGeneration && shouldReconnect && reconnecting
            }
            if (go) attach(api)
        }
    }

    private fun handle(message: SessionServerMessage) {
        when (message) {
            is SessionServerMessage.Hello -> handleHello(message)

            is SessionServerMessage.Event -> {
                val id = eventId(streamSessionId, message.seq)
                if (!seenEventIds.add(id)) return
                if (message.seq > seqCursor) seqCursor = message.seq
                handleEvent(
                    id = id,
                    seq = message.seq,
                    kind = message.kind,
                    timestamp = message.ts?.let(::parseTimestamp),
                    payload = message.payload,
                )
            }

            is SessionServerMessage.Ephemeral -> {
                if (message.kind == "extension_ui_request") {
                    // Remote-UI surfaces own their frames; anything else is an
                    // approval the gateway is re-sending for this attach.
                    // Restoring it here brings the inline card back after backing
                    // out of the session.
                    if (!remoteUi.applyExtensionRequest(message.payload)) {
                        restoreEphemeralInteraction(message.payload)
                    }
                    publish()
                    return
                }
                when (message.kind) {
                    "message_update" -> handleEvent(
                        id = activeAssistantItemId ?: eventId(streamSessionId, EPHEMERAL_SEQ),
                        seq = EPHEMERAL_SEQ,
                        kind = message.kind,
                        timestamp = null,
                        payload = message.payload,
                    )

                    // The gateway stopped persisting these — 248 rows per tool
                    // execution filled its database volume — so the durable
                    // start/end pair is all replay carries and the live output
                    // arrives only here. Dropping them left every tool card
                    // reading "Running bash" with nothing under it until the
                    // execution ended. Keyed on toolCallId, the same as the
                    // durable frames, so the update lands on the card the
                    // `tool_execution_start` opened.
                    "tool_execution_update" -> handleEvent(
                        id = eventId(streamSessionId, EPHEMERAL_SEQ),
                        seq = EPHEMERAL_SEQ,
                        kind = message.kind,
                        timestamp = null,
                        payload = message.payload,
                    )

                    "bash_execution_update" -> appendBashOutput(message.payload)

                    "bash_execution_end" -> settleBashOutput(message.payload)

                    else -> return
                }
            }

            is SessionServerMessage.Interaction -> addOrMergeInteraction(
                interactionId = message.interactionId,
                seq = message.seq,
                kind = message.kind,
                ts = message.ts,
                payload = message.payload,
            )

            is SessionServerMessage.ReplayGap -> {
                val skipped = if (message.toSeq >= message.fromSeq) message.toSeq - message.fromSeq + 1 else 0
                appendStatus(
                    if (skipped > 0) {
                        "Some earlier activity ($skipped events) isn’t shown here; it stayed on the pod."
                    } else {
                        "Some earlier activity isn’t shown here; it stayed on the pod."
                    },
                )
            }

            is SessionServerMessage.Ended -> {
                val hostDemand = hostWaitDemandFromReason(message.reason)
                val api = activeApi
                if (hostDemand != null && api != null) {
                    // Host stop: recoverable workstation wait, not idle Asleep.
                    startWorkstationWaitLocked(attachWait, api, hostDemand) { attachAndAwaitReady(api) }
                } else {
                    applySessionEnd(message.reason, message.kind)
                }
            }

            is SessionServerMessage.PodState -> {
                if (message.state == "detached") {
                    if (isAttachWaitActive()) {
                        // A host wait already entered (via `session_ended`) owns
                        // this surface; a generic detached must not rewrite it
                        // into idle Asleep.
                    } else {
                        val hostDemand = hostWaitDemandFromReason(message.reason)
                        val api = activeApi
                        if (hostDemand != null && api != null) {
                            startWorkstationWaitLocked(attachWait, api, hostDemand) { attachAndAwaitReady(api) }
                        } else if (!sessionEnded) {
                            applySessionEnd(message.reason ?: "detached", null)
                        }
                    }
                } else {
                    appendStatus(message.reason ?: "Pod state changed to ${message.state}.")
                }
            }

            is SessionServerMessage.PodUpdated -> applyPodUpdated(message.id, message.name)

            is SessionServerMessage.Models -> handleModels(message)

            is SessionServerMessage.Error -> {
                // Remote-UI errors are scoped to one extension surface: the
                // surface goes read-only and says so itself, rather than
                // banner-ing the session.
                if (message.code == "remote_ui_owned") {
                    remoteUi.markOwnedElsewhere()
                    return
                }
                if (message.code == "invalid_remote_ui") return
                // The gateway sends this frame immediately before closing with
                // 4420 for a workstation wait, with the typed host-demand object
                // attached. It is kept for the close that follows — never
                // rendered as text; only the validated parse of it is used.
                lastGatewayRefusalCode = message.code
                lastGatewayRefusalDetail = message.detail
                lastGatewayRefusalMessage = message.message
                // A refused turn produces no `user_prompt` echo, and only that
                // echo ever moves a bubble off SENDING — so a prompt the gateway
                // rejected (over the 64 KiB text cap, say) sat "Sending…"
                // forever with no Retry. Fail it so the row is actionable.
                failInFlightSends()
                setError(friendly(message.code, message.message), gatewayError = message.message)
            }

            SessionServerMessage.Pong -> Unit
        }
        publish()
    }

    private fun handleHello(message: SessionServerMessage.Hello) {
        val state = message.state
        if (streamSessionId != null && streamSessionId != message.sessionId) {
            pending.clear()
            uuidByRequestId.clear()
            requestIdByUuid.clear()
            // Keep the in-progress assistant bubble and tool cards. A replacement
            // gateway session is a transport boundary, not a new turn — live
            // message_update / tool_execution_update frames must keep painting
            // the same transcript rows.
            seqCursor = 0
            // Seqs restart with the session, so a watermark carried over from
            // the previous one would sit above every new event and suppress
            // adoption of the bubble the reader is watching.
            serverWatermark = 0
            sendWatermarks.clear()
            // Bash accumulations are keyed by an id minted by the previous
            // session's client; nothing in this one extends them.
            bashOutput.clear()
            appendSessionBoundary()
        }
        streamSessionId = message.sessionId
        isConnected = true
        asleep = null
        preparingPod = null
        waking = false
        reconnecting = false
        reconnectAttempt = 0
        // A hello answers the wait's parked re-issue: the request succeeded, so
        // the wait is over and its card goes with it. Unrelated hellos leave a
        // send-path wait alone — connecting says nothing about queuePrompt.
        // Authoritative hello always clears the attach wait, even with no parked
        // `attachOutcome` (a fresh Retry mints no gate). The generation bump
        // retires late `onState` ticks from the superseded session so they
        // cannot reassert the card over the live session.
        lastGatewayRefusalCode = null
        lastGatewayRefusalDetail = null
        lastGatewayRefusalMessage = null
        attachOutcome?.complete(Unit)
        attachOutcome = null
        attachWait.state = null
        attachWait.generation += 1
        setError(null)
        podUnavailable = false
        sessionEnded = false
        sessionEndedMessage = ""
        // The gateway replays each surface's newest frame and outstanding input
        // request after this hello, so the previous set is dropped first.
        remoteUi.resetForAttach()
        serverWatermark = maxOf(serverWatermark, message.latestSeq)
        isStreaming = (state?.get("isStreaming") as? JsonPrimitive)?.booleanOrNull ?: false
        isCompacting = (state?.get("isCompacting") as? JsonPrimitive)?.booleanOrNull ?: false
        val pendingMessages = state?.integer("pendingMessageCount")
        if (pendingMessages != null && pendingMessages > 0) isStreaming = true
        // The snapshot is authoritative: a stale local "awaiting reply" flag from
        // a previous attach must not keep the working indicator and Interrupt
        // alive when the server is idle.
        if (!isStreaming && (pendingMessages == null || pendingMessages <= 0)) awaitingReply = false
        updateRunningState()
        // hello's state.model/thinkingLevel is a stale default, not truth — the
        // models catalog owns both. The snapshot below only confirms an in-flight
        // optimistic switch; it never adopts values.
        val stateModel = state?.get("model") as? JsonObject
        if (pendingModelSwitch != null && stateModel != null && ModelChoice.from(stateModel) == pendingModelSwitch) {
            pendingModelSwitch = null
        }
        val snapshotThinking = state?.string("thinkingLevel")
        if (pendingThinkingSwitch != null && snapshotThinking != null && snapshotThinking == pendingThinkingSwitch) {
            pendingThinkingSwitch = null
        }
        restoreSnapshotInteractions(state)
        socket?.requestModels()
        flushQueuedOffline()
        scope.launch { refreshPodRecord() }
        // Restored cards that only carry the pi request id cannot resolve until
        // they adopt the gateway uuid from the pending listing.
        scope.launch { reconcilePendingWithServer() }
    }

    private fun handleModels(message: SessionServerMessage.Models) {
        val choices = message.models.mapNotNull(ModelChoice::from)
        availableModels.clear()
        availableModels.addAll(choices)
        val selected = ModelChoice.from(message.current)
        if (pendingModelSwitch != null) {
            // Keep the optimistic row so the picker never reverts mid-switch; the
            // next snapshot without a pending switch reconciles.
            pendingModelSwitch = null
        } else if (selected != null) {
            currentModel = choices.firstOrNull { it == selected } ?: selected
        }
        // The catalog is truth for the model snapshot: first arrival flips the
        // flag so the UI can drop its neutral placeholder.
        hasModelSnapshot = true
        availableThinkingLevels.clear()
        availableThinkingLevels.addAll(message.thinkingLevels)
        if (pendingThinkingSwitch != null) {
            pendingThinkingSwitch = null
        } else if (message.thinkingLevel != null) {
            currentThinkingLevel = message.thinkingLevel
        }
        modelCatalogRevision += 1
    }

    private fun handleEvent(
        id: String,
        seq: Long,
        kind: String,
        timestamp: Instant?,
        payload: JsonObject,
        reason: String? = null,
    ) {
        when (kind) {
            "user_prompt" -> {
                val text = payload.string("text") ?: return
                val historyImages = historyAttachments(payload)
                if (text.isEmpty() && historyImages.isEmpty()) return
                // Extension bridge commands are persisted as ordinary user
                // prompts so replay stays complete, but they are protocol traffic
                // rather than conversation.
                if (isInternalPodCommand(text)) return
                if (!adoptOutgoing(text, id, timestamp, seq, imageCount = historyImages.size)) {
                    append(
                        StreamItem(
                            id = id,
                            style = StreamItemStyle.USER,
                            title = "You",
                            text = text,
                            timestamp = timestamp,
                            attachments = historyImages,
                        ),
                    )
                }
                sessionEnded = false
                sessionEndedMessage = ""
            }

            "agent_start", "turn_start", "auto_retry_start" -> {
                isStreaming = true
                sessionEnded = false
                sessionEndedMessage = ""
                updateRunningState()
            }

            "agent_settled" -> {
                isStreaming = false
                awaitingReply = false
                if (seq > lastSettledSeq) lastSettledSeq = seq
                // The agent turn boundary says nothing about independent `!`
                // bash (`bash:<id>`): those executions are not agent tools and
                // outlive the turn, so their updates and end frames must keep
                // applying afterwards. Terminal wording comes only from the
                // end events below, never from this boundary.
                updateRunningState()
            }

            "compaction_start" -> {
                isCompacting = true
                updateRunningState()
            }

            "compaction_end" -> {
                isCompacting = false
                updateRunningState()
            }

            "agent_end", "turn_end" -> Unit

            "message_start" -> {
                if (messageRole(payload) != "assistant") return
                isStreaming = true
                updateRunningState()
                activeAssistantItemId = id
                append(
                    StreamItem(
                        id = id,
                        style = StreamItemStyle.ASSISTANT,
                        title = "pi",
                        text = "",
                        timestamp = timestamp,
                        isInProgress = true,
                    ),
                )
            }

            "message_update" -> {
                if (messageRole(payload) != "assistant") return
                val itemId = activeAssistantItemId ?: id
                activeAssistantItemId = itemId
                upsertAssistant(itemId, visibleMessageText(payload), timestamp, inProgress = true)
            }

            "message_end" -> {
                if (messageRole(payload) != "assistant") return
                val itemId = activeAssistantItemId ?: id
                val text = visibleMessageText(payload)
                val failure = messageFailure(payload)
                when {
                    failure != null ->
                        upsertAssistant(itemId, failure, timestamp, inProgress = false, isError = true)

                    text.isBlank() -> {
                        transcript.removeAll { it.id == itemId }
                        bump()
                    }

                    else -> upsertAssistant(itemId, text, timestamp, inProgress = false)
                }
                activeAssistantItemId = null
            }

            "tool_execution_start", "tool_execution_update", "tool_execution_end" ->
                upsertTool(id, seq, kind, timestamp, payload)

            "bash_execution_update" -> appendBashOutput(payload)

            "bash_execution_end" -> settleBashOutput(payload)

            "session_info_changed" -> Unit

            "extension_ui_request" ->
                restoreInteractionFromEvent(seq = seq, timestamp = timestamp, payload = payload)

            "interaction_resolved" -> resolveInteractionFromEvent(payload, seq = seq)

            "extension_ui_response" -> {
                val answered = payload.string("id")
                if (!answered.isNullOrEmpty()) {
                    // A response answers the matching request; the resolved event
                    // that follows carries the transcript receipt.
                    removePendingMatching(answered)
                }
            }

            "session_ended" -> {
                val endedReason = reason ?: payload.string("reason")
                val endedKind = payload.string("kind")
                val hostDemand = hostWaitDemandFromReason(endedReason)
                val api = activeApi
                if (hostDemand != null && api != null) {
                    // Host stop is a recoverable workstation wait, not idle
                    // Asleep: do not tear down. The 4420 close that follows
                    // feeds the wait's parked attach.
                    startWorkstationWaitLocked(attachWait, api, hostDemand) { attachAndAwaitReady(api) }
                    return
                }
                val resolved = if (!endedKind.isNullOrEmpty()) endedKind else endKind(endedReason)
                if (resolved == "retryable") return
                applySessionEnd(endedReason, endedKind, itemId = id, timestamp = timestamp)
            }

            else -> Unit
        }
    }

    private fun updateRunningState() {
        isRunning = isStreaming || isCompacting || awaitingReply
        if (!isRunning) isInterrupting = false
    }

    /**
     * Live `interaction` frame: the same approval the durable
     * `extension_ui_request` event (or an ephemeral re-send) may already have
     * announced under its pi request id. Merge so one approval is one card, and
     * the surviving card carries the resolvable uuid.
     */
    private fun addOrMergeInteraction(
        interactionId: String,
        seq: Long,
        kind: String,
        ts: String?,
        payload: JsonObject,
    ) {
        if (resolvedInteractionIds.contains(interactionId)) return
        val requestId = payloadRequestId(payload)
        if (requestId != null) {
            if (resolvedInteractionIds.contains(requestId)) return
            linkAlias(interactionId, requestId)
        }
        val index = pendingIndexFor(interactionId)
        if (index >= 0) {
            val existing = pending[index]
            pending[index] = PendingInteraction(
                id = interactionId,
                sessionId = existing.sessionId,
                podId = existing.podId,
                podName = existing.podName,
                seq = if (seq != 0L) seq else existing.seq,
                kind = kind,
                payload = payload,
                createdAt = ts ?: existing.createdAt,
            )
            scrollRevision += 1
            SessionNotifications.interactionPending.post(interactionId)
            return
        }
        pending += PendingInteraction(
            id = interactionId,
            sessionId = streamSessionId ?: "",
            podId = podId,
            podName = "",
            seq = seq,
            kind = kind,
            payload = payload,
            createdAt = ts ?: "",
        )
        scrollRevision += 1
        SessionNotifications.interactionPending.post(interactionId)
    }

    /**
     * Best-effort restore of a gateway snapshot that carries its outstanding
     * approvals (future servers may include `pendingInteractions`). Entries that
     * do not decode are ignored so a new server shape can never wedge an old
     * attach.
     */
    private fun restoreSnapshotInteractions(state: JsonObject?) {
        val raw = state?.get("pendingInteractions") as? JsonArray ?: return
        for (entry in raw) {
            val row = entry as? JsonObject ?: continue
            val id = row.string("id")?.takeIf { it.isNotEmpty() } ?: continue
            if (resolvedInteractionIds.contains(id)) continue
            val payload = row["payload"]
            val requestId = payloadRequestId(payload)
            if (requestId != null) {
                if (resolvedInteractionIds.contains(requestId)) continue
                linkAlias(id, requestId)
            }
            if (pendingIndexFor(id) >= 0) continue
            pending += PendingInteraction(
                id = id,
                sessionId = streamSessionId ?: "",
                podId = podId,
                podName = "",
                seq = row.integer("seq") ?: 0,
                kind = row.string("kind") ?: "extension_ui",
                payload = payload ?: JsonObject(emptyMap()),
                createdAt = row.string("createdAt") ?: "",
            )
        }
        if (raw.isNotEmpty()) scrollRevision += 1
    }

    /**
     * An ephemeral `extension_ui_request` that is not remote-UI traffic is an
     * approval the gateway re-sends on every attach. It carries the pi request
     * id (not the REST uuid), so it restores the inline card with that id;
     * [reconcilePendingWithServer] later adopts the uuid the resolve endpoint
     * requires.
     */
    private fun restoreEphemeralInteraction(payload: JsonObject) {
        val method = payload.string("method") ?: return
        if (!isDialogMethod(method)) return
        val requestId = payloadRequestId(payload)
        val id = requestId ?: "ephemeral:$method:${payload.string("title") ?: ""}"
        if (resolvedInteractionIds.contains(id)) return
        if (requestId != null) {
            val uuid = uuidByRequestId[requestId]
            if (uuid != null) {
                if (resolvedInteractionIds.contains(uuid)) return
                // The uuid card already names this approval; the re-send adds nothing.
                if (pendingIndexFor(uuid) >= 0) return
            }
        }
        if (pendingIndexFor(id) >= 0) return
        pending += PendingInteraction(
            id = id,
            sessionId = streamSessionId ?: "",
            podId = podId,
            podName = "",
            seq = 0,
            kind = method,
            payload = payload,
            createdAt = "",
        )
        scrollRevision += 1
        scope.launch { reconcilePendingWithServer() }
    }

    /**
     * A durable replayed `extension_ui_request` (dialog method) restores the
     * inline card when the live `interaction` frame was missed while detached.
     * Fire-and-forget methods (notify/setStatus/…) are never cards.
     */
    private fun restoreInteractionFromEvent(seq: Long, timestamp: Instant?, payload: JsonObject) {
        val methodName = payload.string("method") ?: return
        if (!isDialogMethod(methodName)) return
        val requestId = payloadRequestId(payload)
        val id = requestId ?: "event:$seq"
        if (resolvedInteractionIds.contains(id)) return
        if (requestId != null) {
            val uuid = uuidByRequestId[requestId]
            if (uuid != null) {
                if (resolvedInteractionIds.contains(uuid)) return
                // The uuid card already names this approval; the replay adds nothing.
                if (pendingIndexFor(uuid) >= 0) return
            }
        }
        if (pendingIndexFor(id) >= 0) return
        // The same approval may already be present under its REST uuid with the
        // same sequence; keep one card.
        if (seq != 0L && pending.any { it.seq == seq }) return
        pending += PendingInteraction(
            id = id,
            sessionId = streamSessionId ?: "",
            podId = podId,
            podName = "",
            seq = seq,
            kind = methodName,
            payload = payload,
            createdAt = timestamp?.toString() ?: "",
        )
        scrollRevision += 1
        scope.launch { reconcilePendingWithServer() }
    }

    private fun isDialogMethod(method: String): Boolean =
        method == "select" || method == "confirm" || method == "input" || method == "editor"

    /**
     * A replayed `interaction_resolved` clears the card and leaves the same
     * transcript receipt as a local resolve. When the card was already removed
     * (resolved from the Approvals tab before reopening), there is nothing to do
     * and no duplicate receipt is emitted. When the app registered the intended
     * answer via [beginLocalResolve] before its REST call returned, the racing
     * event phrases that specific receipt instead of the generic fallback,
     * exactly once.
     */
    private fun resolveInteractionFromEvent(payload: JsonObject, seq: Long? = null) {
        val raw = (payload.string("interactionId") ?: payload.string("id"))?.takeIf { it.isNotEmpty() } ?: return
        // The payload names the uuid; the card may sit under the request id.
        val requestId = payloadRequestId(payload)
        if (requestId != null && requestId != raw) linkAlias(raw, requestId)
        val group = aliasGroup(raw)
        // Already handled elsewhere (tab/inline resolve or an earlier delivery):
        // nothing may be claimed for this uuid, especially not an unrelated card.
        val alreadyKnown = resolvedInteractionIds.contains(raw)
        resolvedInteractionIds.addAll(group)
        var removed = removePendingMatching(raw)
        if (removed.isEmpty() && alreadyKnown) return
        if (removed.isEmpty()) {
            // Cold replay carries no `interaction` frames, so no alias links the
            // uuid to its request-id card. Approvals block the turn, so in seq
            // order the oldest still-pending card predating this resolution is it.
            removed = removeOldestPendingBefore(seq)
            for (victim in removed) {
                resolvedInteractionIds.add(victim.id)
                payloadRequestId(victim.payload)?.let {
                    resolvedInteractionIds.add(it)
                    linkAlias(raw, it)
                }
            }
        }
        if (removed.isEmpty()) return
        // A local resolve already left its "You confirmed …" receipt; a replay of
        // that resolution removes any lingering card silently and emits nothing.
        if (group.any(receiptedInteractionIds::contains)) return

        var localResponse: JsonObject? = null
        var hasLocal = false
        for (key in group) {
            if (pendingLocalResolves.containsKey(key)) {
                hasLocal = true
                localResponse = pendingLocalResolves[key]
                break
            }
        }
        if (!hasLocal) {
            for (victim in removed) {
                if (pendingLocalResolves.containsKey(victim.id)) {
                    hasLocal = true
                    localResponse = pendingLocalResolves[victim.id]
                    break
                }
                val victimRequest = payloadRequestId(victim.payload)
                if (victimRequest != null && pendingLocalResolves.containsKey(victimRequest)) {
                    hasLocal = true
                    localResponse = pendingLocalResolves[victimRequest]
                    break
                }
            }
        }
        if (hasLocal) {
            val receipt = interactionReceiptText(removed.first(), localResponse)
            appendStatus(receipt)
            persistInteractionReceipt(receiptKeys(group, removed), receipt)
        } else {
            // The replayed event carries no answer, only the fact of resolution.
            // A receipt stored by the earlier resolve (this launch or a previous
            // one) restores the specific wording; otherwise leave a generic
            // receipt, never a guessed choice.
            val stored = storedInteractionReceipt(group, removed)
            if (stored != null) {
                appendStatus(stored)
            } else {
                val title = InteractionPresentation(removed.first()).title.trim()
                appendStatus(if (title.isEmpty()) "Resolved." else "Resolved $title.")
            }
        }
        receiptedInteractionIds.addAll(group)
        for (victim in removed) {
            receiptedInteractionIds.add(victim.id)
            payloadRequestId(victim.payload)?.let(receiptedInteractionIds::add)
        }
        for (key in group) pendingLocalResolves.remove(key)
        for (victim in removed) {
            pendingLocalResolves.remove(victim.id)
            payloadRequestId(victim.payload)?.let(pendingLocalResolves::remove)
        }
        scrollRevision += 1
        SessionNotifications.interactionResolved.post(id = raw, response = if (hasLocal) localResponse else null)
    }

    private fun flushQueuedOffline() {
        val parked = transcript.filter { it.delivery == StreamItemDelivery.WAITING_FOR_CONNECTION }
        for (row in parked) deliver(row.id, row.text)
    }

    // --- transcript mutation ------------------------------------------------

    private fun upsertAssistant(
        id: String,
        text: String,
        timestamp: Instant?,
        inProgress: Boolean,
        isError: Boolean = false,
    ) {
        val index = transcript.indexOfFirst { it.id == id }
        if (index >= 0) {
            val existing = transcript[index]
            transcript[index] = existing.copy(
                text = text,
                isInProgress = inProgress,
                isError = isError,
                timestamp = existing.timestamp ?: timestamp,
            )
            scrollIsStreamingUpdate = inProgress
            scrollRevision += 1
            return
        }
        append(
            StreamItem(
                id = id,
                style = StreamItemStyle.ASSISTANT,
                title = "pi",
                text = text,
                timestamp = timestamp,
                isInProgress = inProgress,
                isError = isError,
            ),
        )
    }

    private fun upsertTool(id: String, seq: Long, kind: String, timestamp: Instant?, payload: JsonObject) {
        val callId = payload.string("toolCallId") ?: "tool-$seq"
        val isEnd = kind == "tool_execution_end"
        val toolName = payload.string("toolName") ?: "tool"
        val itemId = toolItemIds[callId] ?: id
        toolItemIds[callId] = itemId
        val isError = (payload["isError"] as? JsonPrimitive)?.booleanOrNull ?: false
        val title = if (isEnd) {
            if (isError) "$toolName failed" else "$toolName completed"
        } else {
            "Running $toolName"
        }
        val text = toolText(payload, isEnd, isError)
        val index = transcript.indexOfFirst { it.id == itemId }
        if (index >= 0) {
            val existing = transcript[index]
            transcript[index] = existing.copy(
                title = title,
                text = if (text.isNotEmpty()) text else existing.text,
                isInProgress = !isEnd,
                isError = isError,
            )
            scrollIsStreamingUpdate = !isEnd
            scrollRevision += 1
            return
        }
        append(
            StreamItem(
                id = itemId,
                style = StreamItemStyle.TOOL,
                title = title,
                text = text,
                timestamp = timestamp,
                isInProgress = !isEnd,
                isError = isError,
            ),
        )
    }

    /**
     * Streams `!command` bash output onto its card, opening one when the
     * execution has none.
     *
     * The `id` on these frames is an RPC request id minted by whichever client
     * ran `!command` — not a `toolCallId` — so keying the lookup on the tool
     * card map alone matched nothing the gateway actually sends and the output
     * was dropped in silence. A bash execution IS a transcript row: the card is
     * created here the way the iOS client creates it, and settled by
     * [settleBashOutput] on `bash_execution_end`.
     *
     * The same frame arrives in two shapes and the kind does not distinguish
     * them: live frames carry the next chunk, while the snapshot the gateway
     * sends to a client that attaches mid-command carries everything produced so
     * far (`bashSnapshotAccumulate`). Appending both would print the output twice
     * on every reattach, so the accumulated form is recognised by the prefix it
     * necessarily has and supersedes rather than extends — which is only sound
     * while both sides hold the same 64 KiB tail, hence [BASH_OUTPUT_MAX_CHARS].
     */
    private fun appendBashOutput(payload: JsonObject) {
        val bashId = payload.string("id")?.takeIf { it.isNotEmpty() } ?: return
        val delta = payload.string("delta").orEmpty()
        if (delta.isEmpty()) return
        val combined = accumulateBash(bashOutput[bashId].orEmpty(), delta)
        bashOutput[bashId] = combined
        // Shell output is the likeliest place in the whole transcript for a
        // credential to appear (`!env`, `!cat .env`), and it is the one visible
        // string that used to reach the screen raw.
        val visible = truncated(redactingSecrets(combined))
        val itemId = toolItemIds[bashId] ?: openBashCard(bashId)
        val index = transcript.indexOfFirst { it.id == itemId }
        if (index < 0) return
        val existing = transcript[index]
        if (existing.text == visible && existing.isInProgress) return
        transcript[index] = existing.copy(text = visible, isInProgress = true)
        scrollIsStreamingUpdate = true
        scrollRevision += 1
    }

    /** The card a `!command` writes into, keyed by its RPC request id. */
    private fun openBashCard(bashId: String): String {
        val itemId = "$BASH_ITEM_PREFIX$bashId"
        toolItemIds[bashId] = itemId
        append(
            StreamItem(
                id = itemId,
                style = StreamItemStyle.TOOL,
                title = "Running bash",
                text = "",
                timestamp = now(),
                isInProgress = true,
            ),
        )
        return itemId
    }

    /**
     * `bash_execution_end`: the command is over, so the card stops spinning and
     * the accumulator is released. Without this the row read "Running bash"
     * for the rest of the session.
     *
     * The end frame carries only the execution `id` on the current wire — no
     * authoritative full-output field exists in the parser — so the card keeps
     * whatever the accumulated `bash_execution_update` deltas produced. Only
     * this event completes the card; `agent_settled` and agent-idle hello
     * snapshots never do, because independent `!` bash outlives the agent turn.
     */
    private fun settleBashOutput(payload: JsonObject) {
        val bashId = payload.string("id")?.takeIf { it.isNotEmpty() } ?: return
        bashOutput.remove(bashId)
        val itemId = toolItemIds[bashId] ?: return
        val index = transcript.indexOfFirst { it.id == itemId }
        if (index < 0) return
        val existing = transcript[index]
        // Only a card this reducer opened is retitled; a real tool card sharing
        // the id owns its own "<tool> completed" wording.
        val title = if (itemId.startsWith(BASH_ITEM_PREFIX)) BASH_FINISHED_TITLE else existing.title
        if (!existing.isInProgress && existing.title == title) return
        transcript[index] = existing.copy(title = title, isInProgress = false)
        scrollIsStreamingUpdate = false
        scrollRevision += 1
    }

    private fun append(item: StreamItem) {
        transcript += item
        bump()
    }

    private fun appendStatus(text: String) {
        append(
            StreamItem(
                id = "local:$syntheticId",
                style = StreamItemStyle.STATUS,
                title = "",
                text = text,
            ),
        )
        syntheticId -= 1
    }

    /**
     * A replacement gateway session is a divider, not a new turn. If a reply is
     * still streaming, keep that bubble below the marker so later deltas
     * continue it.
     */
    private fun appendSessionBoundary() {
        val item = StreamItem(
            id = "local:$syntheticId",
            style = StreamItemStyle.STATUS,
            title = "",
            text = sessionBoundaryMessage(waking || asleep != null),
        )
        syntheticId -= 1
        val inProgressIndex = transcript.indexOfLast { it.isInProgress }
        if (inProgressIndex >= 0) {
            transcript.add(inProgressIndex, item)
            bump()
            return
        }
        append(item)
    }

    /** One transcript mutation: a scroll revision, a streaming hint, a repaint. */
    private fun bump(streaming: Boolean = false) {
        scrollIsStreamingUpdate = streaming
        scrollRevision += 1
        publish()
    }

    // --- receipts -----------------------------------------------------------

    /**
     * Transcript receipt for a resolved approval, mirroring the "Model switched
     * to X." status rows. Secret-looking freeform input is never echoed; long
     * values are truncated to one line.
     */
    private fun interactionReceiptText(interaction: PendingInteraction, response: JsonObject?): String {
        val presentation = InteractionPresentation(interaction)
        val title = presentation.title.trim()
        fun withTitle(action: String) = if (title.isEmpty()) "$action." else "$action $title."
        val answer = response ?: JsonObject(emptyMap())
        if ((answer["cancelled"] as? JsonPrimitive)?.booleanOrNull == true) return withTitle("You cancelled")
        when (val style = presentation.responseStyle) {
            is InteractionResponseStyle.Confirmation -> {
                val confirmed = (answer[style.key] as? JsonPrimitive)?.booleanOrNull == true
                val verb = if (style.key == "approved") {
                    if (confirmed) "You approved" else "You denied"
                } else {
                    if (confirmed) "You confirmed" else "You declined"
                }
                return withTitle(verb)
            }

            is InteractionResponseStyle.Selection -> {
                val raw = answer.string("value")?.trim()?.takeIf { it.isNotEmpty() }
                val choice = raw?.let { receiptTruncate(it, 80) } ?: return withTitle("You answered")
                return if (title.isEmpty()) "You chose $choice." else "You chose $choice for $title."
            }

            is InteractionResponseStyle.Input -> {
                val value = answer.string("value")?.trim()?.takeIf { it.isNotEmpty() }
                    ?: return withTitle("You answered")
                // Never echo credentials or assignments back into the transcript.
                if (redactingSecrets(value) != value) return withTitle("You answered")
                return "You answered ${receiptTruncate(value, 80)}."
            }

            InteractionResponseStyle.Unsupported -> return withTitle("Resolved")
        }
    }

    /**
     * Persists the phrased [receipt] under every id naming the approval (gateway
     * uuid and pi request id alike) so a reattach or cold restart replays the
     * same specific wording instead of the generic fallback. Only specific
     * receipts are stored here; the generic "Resolved …" fallback must never
     * overwrite them.
     */
    private fun persistInteractionReceipt(ids: Set<String>, receipt: String) {
        if (receipt.isEmpty()) return
        for (id in ids) InteractionReceiptStore.writeCached(id, receipt)
    }

    /**
     * Every id that may name the resolved approval on a later replay: the alias
     * group plus the removed cards' own ids and payload request ids.
     */
    private fun receiptKeys(group: Set<String>, removed: List<PendingInteraction>): Set<String> {
        val keys = group.toMutableSet()
        for (victim in removed) {
            if (victim.id.isNotEmpty()) keys.add(victim.id)
            payloadRequestId(victim.payload)?.let(keys::add)
        }
        return keys
    }

    /** A receipt stored by an earlier resolve of one of these ids, if any. */
    private fun storedInteractionReceipt(group: Set<String>, removed: List<PendingInteraction>): String? {
        for (id in receiptKeys(group, removed)) {
            val stored = InteractionReceiptStore.readCached(id)
            if (!stored.isNullOrEmpty()) return stored
        }
        return null
    }

    private fun receiptTruncate(value: String, limit: Int): String {
        val singleLine = value.replace(WHITESPACE, " ").trim()
        if (singleLine.length <= limit) return singleLine
        return singleLine.substring(0, limit).trimEnd() + "…"
    }

    // --- session end and pod record -----------------------------------------

    private fun applySessionEnd(
        reason: String?,
        kind: String?,
        itemId: String? = null,
        timestamp: Instant? = null,
    ) {
        val resolvedKind = if (!kind.isNullOrEmpty()) kind else endKind(reason)
        isStreaming = false
        isCompacting = false
        awaitingReply = false
        if (resolvedKind == "retryable") {
            updateRunningState()
            return
        }
        // The gateway fans out `session_ended`, then `pod_state detached`, then
        // closes — and the close is swallowed because this method has already
        // cleared `shouldReconnect`. So nothing else will ever tear the socket
        // down: without this the snapshot kept claiming a live connection, wake()
        // returned immediately because `isConnected` was true, the next send went
        // to a dead socket and failed instantly instead of parking, and the
        // socket's own coroutine scope leaked with every ended session.
        teardownTransport()
        // Whatever was mid-flight when the pod slept is not still running. On a
        // replayed transcript an animated "Thinking…" row under a "Pod went to
        // sleep" divider is simply a lie.
        settleInFlightItems()
        // The pod's components died with the session; nothing can answer their
        // outstanding input requests.
        remoteUi.clear()
        val message = endMessage(resolvedKind, reason)
        if (itemId == null) {
            appendStatus(message)
        } else {
            append(
                StreamItem(
                    id = itemId,
                    style = StreamItemStyle.STATUS,
                    title = "",
                    text = message,
                    timestamp = timestamp,
                ),
            )
        }
        sessionEnded = true
        sessionEndedMessage = message
        shouldReconnect = false
        reconnecting = false
        if (resolvedKind == "asleep") {
            asleep = if (reason != null && reason in ARCHIVED_REASONS) "archived" else "stopped"
        }
        if (resolvedKind == "unavailable") podUnavailable = true
        updateRunningState()
    }

    private fun setPodRecord(pod: Pod) {
        if (podRecord == pod) return
        podRecord = pod
    }

    private suspend fun refreshPodRecord() {
        val api = synchronized(lock) { activeApi } ?: return
        val knownName = synchronized(lock) { podRecord?.name }
        try {
            val current = api.pod(podId)
            synchronized(lock) {
                if (knownName != null && podRecord?.name != null && podRecord!!.name != knownName) return
                setPodRecord(current)
                publish()
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return
        }
    }

    private fun applyPodUpdated(id: String, name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty() || (id != podId && id.isNotEmpty())) return
        val record = podRecord
        if (record != null) {
            if (record.name != trimmed) setPodRecord(record.copy(name = trimmed))
            return
        }
        scope.launch { refreshPodRecord() }
    }

    private fun friendly(code: String?, message: String): String {
        when (code) {
            "pod_unavailable" ->
                return "This pod is unavailable. Check its status on the pod screen, then retry."

            "pod_not_found" -> return "This pod no longer exists."
            "unauthorized" -> return "The connection is no longer authorized. Retry to reconnect."
        }
        val lower = message.lowercase()
        if (lower.contains("pod is stopped") || lower.contains("not started")) {
            return "This pod is temporarily unavailable. Retry in a moment."
        }
        if (lower.contains("network") || lower.contains("not connected")) {
            return "Couldn’t connect to the pod. Check your connection and retry."
        }
        return FriendlyError.message(message)
    }

    // --- remote UI ----------------------------------------------------------

    private fun applyRemoteUiControl(frame: RemoteUiControlFrame) = synchronized(lock) {
        val value = frame.value
        when (frame.action) {
            RemoteUiControlAction.SET_WORKING_MESSAGE -> workingMessage = value.asStringOrNull()
            RemoteUiControlAction.SET_WORKING_VISIBLE -> workingVisible = value.asTrue()
            RemoteUiControlAction.SET_WORKING_INDICATOR -> workingIndicator = value.asStringOrNull()
            RemoteUiControlAction.SET_HIDDEN_THINKING_LABEL -> hiddenThinkingLabel = value.asStringOrNull()
            RemoteUiControlAction.SET_TOOLS_EXPANDED -> toolsExpandedByExtension = value.asTrue()
        }
        publish()
    }

    private fun sendUiResponse(response: JsonObject): Boolean = synchronized(lock) {
        val transport = socket
        isConnected && transport != null && transport.uiResponse(response)
    }

    // --- payload readers ----------------------------------------------------

    private fun messageRole(payload: JsonObject): String? =
        (payload["message"] as? JsonObject)?.string("role")

    private fun messageFailure(payload: JsonObject): String? {
        val message = payload["message"] as? JsonObject ?: return null
        val stopReason = message.string("stopReason")
        val raw = message.string("errorMessage")?.trim().orEmpty()
        if (stopReason != "error" && raw.isEmpty()) return null
        if (raw.isEmpty()) return "pi could not complete this turn."
        return readableModelError(raw)
    }

    private fun visibleMessageText(payload: JsonObject): String = redactingSecrets(rawMessageText(payload))

    private fun rawMessageText(payload: JsonObject): String {
        val message = payload["message"] as? JsonObject ?: return payload.string("text") ?: ""
        val content = message["content"]
        (content as? JsonPrimitive)?.takeIf { it.isString }?.let { return it.content }
        val blocks = content as? JsonArray ?: return ""
        return blocks.filterIsInstance<JsonObject>()
            .mapNotNull { block -> if (block.string("type") == "text") block.string("text") else null }
            .joinToString("")
    }

    private fun toolText(payload: JsonObject, ended: Boolean, isError: Boolean): String {
        var resultText = ""
        val result = payload["result"] as? JsonObject
        val content = result?.get("content") as? JsonArray
        if (content != null) {
            resultText = content.filterIsInstance<JsonObject>()
                .mapNotNull { it.string("text") }
                .joinToString("\n")
        }
        if (ended && resultText.isNotEmpty()) {
            val visible = redactingSecrets(resultText)
            return truncated(if (isError) FriendlyError.message(visible) else visible)
        }
        val args = payload["args"] as? JsonObject
        if (args != null) {
            return truncated(redactingSecrets(PRETTY_JSON.encodeToString(JsonElement.serializer(), args)))
        }
        return truncated(redactingSecrets(resultText))
    }

    private fun truncated(text: String, limit: Int = 4000): String =
        if (text.length <= limit) text else text.substring(0, limit) + "\n… (truncated)"

    private fun isInternalPodCommand(text: String): Boolean = text.trimStart().startsWith("/pod:_")

    private fun eventId(sessionId: String?, seq: Long): String = "${sessionId ?: "pending"}:$seq"

    private fun sessionBoundaryMessage(waking: Boolean): String =
        if (waking) "Pod woke up." else "Connection restored."

    private fun setError(value: String?, gatewayError: String? = null) {
        error = value
        this.gatewayError = gatewayError
    }

    private fun publish() {
        _state.value = SessionStreamState(
            items = transcript.toList(),
            pendingInteractions = pending.toList(),
            availableModels = availableModels.toList(),
            availableThinkingLevels = availableThinkingLevels.toList(),
            isConnected = isConnected,
            reconnecting = reconnecting,
            reconnectAttempt = reconnectAttempt,
            isOffline = isOffline,
            isRunning = isRunning,
            isInterrupting = isInterrupting,
            scrollRevision = scrollRevision,
            scrollIsStreamingUpdate = scrollIsStreamingUpdate,
            currentModel = currentModel,
            currentThinkingLevel = currentThinkingLevel,
            hasModelSnapshot = hasModelSnapshot,
            isModelSwitchInFlight = pendingModelSwitch != null,
            isThinkingSwitchInFlight = pendingThinkingSwitch != null,
            modelCatalogRevision = modelCatalogRevision,
            preparingPod = preparingPod,
            podRecord = podRecord,
            isLoadingHistory = isLoadingHistory,
            sessionEnded = sessionEnded,
            sessionEndedMessage = sessionEndedMessage,
            historyLoadFailed = historyLoadFailed,
            podUnavailable = podUnavailable,
            asleep = asleep,
            waking = waking,
            // One card: the attach wait is the one the reader is being kept
            // from, so it wins when both are running against the same host.
            workstationWait = attachWait.state ?: sendWait.state,
            error = error,
            gatewayError = gatewayError,
            workingMessage = workingMessage,
            workingVisible = workingVisible,
            workingIndicator = workingIndicator,
            hiddenThinkingLabel = hiddenThinkingLabel,
            expandedToolDetails = expandedToolDetails.toSet(),
            toolsExpandedByExtension = toolsExpandedByExtension,
        )
    }

    companion object {

        /**
         * Ephemeral updates carry no durable sequence, so they take a sentinel
         * larger than any seq a gateway will emit. Kept at 2^53-1 rather than
         * `Long.MAX_VALUE` so the same constant is exactly representable in the
         * JavaScript and Dart clients that share this protocol.
         */
        const val EPHEMERAL_SEQ: Long = 9007199254740991L

        /** Durable cards sort before ephemeral ones when a resolution has no alias. */
        private const val EPHEMERAL_SORT_KEY: Long = 1L shl 62

        private const val MAX_HISTORY_PAGES = 25

        private val ARCHIVED_REASONS =
            setOf("archived", "archive", "provider_archived", "host_archived")

        /** Prefix of a card this reducer opened for a bare `!command`. */
        private const val BASH_ITEM_PREFIX = "bash:"

        private const val BASH_FINISHED_TITLE = "bash completed"

        /**
         * The gateway keeps the last 64 KiB of a bash execution
         * (`gateway/readiness.ts` `bashSnapshotAccumulate`). Holding more here
         * would make the reattach snapshot stop being a prefix of the local
         * copy, and the supersede heuristic would then append the whole tail a
         * second time.
         */
        internal const val BASH_OUTPUT_MAX_CHARS: Int = 64 * 1024

        /**
         * Folds one `bash_execution_update` into what is already held.
         *
         * The frame arrives in two shapes the kind cannot tell apart: a live
         * chunk, and the whole-output snapshot the gateway replays to a client
         * attaching mid-command. The snapshot is recognised by the prefix it
         * necessarily has — and holding the same tail the gateway holds is what
         * makes that true past 64 KiB, where the gateway's snapshot is no longer
         * a prefix of an unbounded local copy and would be appended whole.
         */
        internal fun accumulateBash(previous: String, delta: String): String {
            val combined = when {
                previous.isEmpty() -> delta
                delta.startsWith(previous) -> delta
                else -> previous + delta
            }
            if (combined.length <= BASH_OUTPUT_MAX_CHARS) return combined
            return combined.substring(combined.length - BASH_OUTPUT_MAX_CHARS)
        }

        private val WHITESPACE = Regex("\\s+")

        private val PRETTY_JSON = Json {
            prettyPrint = true
            prettyPrintIndent = "  "
        }

        fun defaultReconnectDelay(attempt: Int): Duration {
            var seconds = 1
            var index = 1
            while (index < attempt && seconds < 30) {
                seconds *= 2
                index += 1
            }
            return (if (seconds > 30) 30 else seconds).seconds
        }

        /**
         * Whether [id] looks like the gateway uuid the resolve endpoints accept
         * (as opposed to a pi request id or a synthetic `ephemeral:`/`event:` id
         * a restored card carries before `reconcilePendingWithServer` adopts it).
         */
        fun isGatewayUuid(id: String): Boolean = isUuid(id)

        private val UUID_PATTERN = Regex(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        )

        private fun isUuid(id: String): Boolean = UUID_PATTERN.matches(id)

        internal fun payloadRequestId(payload: JsonElement?): String? =
            (payload as? JsonObject)?.string("id")?.takeIf { it.isNotEmpty() }

        /**
         * The pi request id naming [interaction], or null when it carries none.
         * Restored cards keep the request id in `payload['id']`; the id itself is
         * the request id when it is not a gateway uuid and not a synthetic
         * `ephemeral:`/`event:` fallback.
         */
        private fun canonicalRequestId(interaction: PendingInteraction): String? {
            payloadRequestId(interaction.payload)?.let { return it }
            val id = interaction.id
            if (isUuid(id)) return null
            if (id.startsWith("ephemeral:") || id.startsWith("event:")) return null
            return id.ifEmpty { null }
        }

        private fun interactionTitle(interaction: PendingInteraction): String = try {
            InteractionPresentation(interaction).title
        } catch (_: Throwable) {
            (interaction.payload as? JsonObject)?.string("title") ?: ""
        }

        /**
         * Decodes a `user_prompt` payload's `images`. Two shapes exist:
         *
         *  * descriptors `{mimeType, bytes}` — what the server persists and fans
         *    out today. No pixels cross; these become size placeholders.
         *  * full blocks `{mimeType, data}` (base64) — accepted for forward
         *    compatibility, decoded here.
         *
         * Both shapes obey the *replay* budgets
         * ([ChatAttachmentLimits.maxHistoryCount],
         * [ChatAttachmentLimits.maxHistoryTotalBytes], per-image 8 MiB) — not the
         * narrower composer caps, so a valid 8-image CLI turn survives intact.
         * Base64 length is enforced on the string before decoding.
         */
        fun historyAttachments(payload: JsonObject): List<StreamImageAttachment> {
            val raw = payload["images"] as? JsonArray ?: return emptyList()
            val result = mutableListOf<StreamImageAttachment>()
            var total = 0
            for (element in raw) {
                val entry = element as? JsonObject ?: continue
                if (result.size >= ChatAttachmentLimits.maxHistoryCount) break
                val mimeType = entry.string("mimeType")
                if (mimeType == null || mimeType !in ChatAttachmentLimits.supportedMimeTypes) continue
                val data = entry.string("data")
                val size = entry.integer("bytes")
                if (data != null) {
                    if (data.isEmpty() || data.length > ChatAttachmentLimits.maxImageBase64Chars) continue
                    val bytes = runCatching { Base64.getDecoder().decode(data) }.getOrNull() ?: continue
                    if (bytes.isEmpty() || bytes.size > ChatAttachmentLimits.maxBytesPerImage) continue
                    if (total + bytes.size > ChatAttachmentLimits.maxHistoryTotalBytes) break
                    total += bytes.size
                    val name = entry.string("name")?.trim()?.takeIf { it.isNotEmpty() } ?: "image"
                    result += StreamImageAttachment(name = name, mimeType = mimeType, bytes = bytes)
                } else if (size != null) {
                    val declared = size.toInt()
                    if (declared <= 0 || declared > ChatAttachmentLimits.maxBytesPerImage) continue
                    if (total + declared > ChatAttachmentLimits.maxHistoryTotalBytes) break
                    total += declared
                    result += StreamImageAttachment(
                        name = "image.${ChatAttachmentLimits.extensionForMime(mimeType)}",
                        mimeType = mimeType,
                        bytes = ByteArray(0),
                        declaredBytes = declared,
                    )
                }
                // Entries with neither `data` nor `bytes` carry nothing renderable.
            }
            return result
        }

        /**
         * Mirrors the server's `sessionEndDisposition`
         * (`gateway/session-state.ts`) reason for reason. It is the fallback for
         * an end that carries no `kind` — notably `pod_state: detached`, which
         * the gateway fans out right after every `session_ended`. Three reasons
         * used to fall through to "unavailable" here and put "This pod is
         * unavailable" over a pod that had merely gone to sleep.
         */
        fun endKind(reason: String?): String = when (reason) {
            "gateway_shutdown", "transport_lost", "handshake_failed", "persist_failed" -> "retryable"
            "idle_stop",
            "archived",
            "archive",
            "provider_stopped",
            "provider_archived",
            "host_stopped",
            "host_archived",
            -> "asleep"

            "pi_exit" -> "exited"
            else -> "unavailable"
        }

        fun endMessage(kind: String, reason: String?): String = when {
            kind == "asleep" -> "Pod went to sleep. Your conversation and files are preserved."
            kind == "exited" -> "Pi exited. Send a message to start it again."
            kind == "retryable" -> "Connection restored."
            reason == "gone" || reason == "delete" -> "This pod is no longer available."
            else -> "This pod is unavailable. Check its status on the pod screen."
        }

        /**
         * Turns a provider's raw failure text into something readable: the JSON
         * envelope providers wrap their message in is noise, and a raw runtime
         * exception must never reach the transcript.
         */
        fun readableModelError(raw: String): String {
            var detail: String? = null
            val start = raw.indexOf('{')
            if (start >= 0) {
                val parsed = runCatching { PRETTY_JSON.parseToJsonElement(raw.substring(start)) }.getOrNull()
                if (parsed is JsonObject) {
                    val nested = parsed["error"] as? JsonObject
                    detail = nested?.string("message") ?: parsed.string("message")
                }
            }
            val message = redactingSecrets((detail ?: raw).trim())
            val friendly = FriendlyError.message(message)
            if (message.lowercase().contains("api key")) {
                return "$friendly\n\nUpdate the key in Settings, then launch a new pod so it picks up the change."
            }
            return friendly
        }

        /**
         * Blanks the value of any `NAME=value` assignment whose name reads like a
         * credential. Tool output and assistant prose both carry environment
         * dumps, so the redaction runs on every visible string rather than at one
         * chosen call site.
         */
        fun redactingSecrets(text: String): String {
            if (text.isEmpty()) return text
            return text.split("\n").joinToString("\n") { line ->
                val equals = line.indexOf('=')
                if (equals < 0) return@joinToString line
                val head = line.substring(0, equals)
                var spaced = head.length
                while (spaced > 0 && head[spaced - 1] == ' ') spaced -= 1
                var start = spaced
                while (start > 0 && isNameChar(head[start - 1])) start -= 1
                val name = head.substring(start, spaced)
                if (name.isEmpty() || name.length > 64 || SECRET_MARKERS.none { name.contains(it) }) {
                    return@joinToString line
                }
                head.substring(0, start) + name + head.substring(spaced) + "=<hidden>"
            }
        }

        private val SECRET_MARKERS = listOf("TOKEN", "SECRET", "KEY", "PASSWORD", "CREDENTIAL")

        private fun isNameChar(value: Char): Boolean =
            value in 'A'..'Z' || value in '0'..'9' || value == '_'

        /**
         * Dart's `DateTime.tryParse` accepts an offset-less local timestamp as
         * well as an instant; the server sends UTC, but replayed rows from other
         * writers have carried both.
         */
        internal fun parseTimestamp(value: String?): Instant? {
            if (value.isNullOrEmpty()) return null
            try {
                return Instant.parse(value)
            } catch (_: DateTimeParseException) {
                // Not an instant; try the offset and local forms below.
            }
            try {
                return OffsetDateTime.parse(value).toInstant()
            } catch (_: DateTimeParseException) {
                // Not offset-qualified either.
            }
            return try {
                LocalDateTime.parse(value).toInstant(ZoneOffset.UTC)
            } catch (_: DateTimeParseException) {
                null
            }
        }

        private fun microsecondsSinceEpoch(instant: Instant): Long =
            instant.epochSecond * 1_000_000L + instant.nano / 1_000L
    }
}

private fun JsonElement?.asStringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.asTrue(): Boolean = (this as? JsonPrimitive)?.booleanOrNull == true
