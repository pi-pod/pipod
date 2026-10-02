package com.pipod.app.features.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.ResolveOutcome
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.session.ApiClientSessionApi
import com.pipod.app.core.session.ChatAttachment
import com.pipod.app.core.session.RemoteUiSnapshot
import com.pipod.app.core.session.SessionApi
import com.pipod.app.core.session.SessionStream
import com.pipod.app.core.session.SessionStreamState
import com.pipod.app.core.session.StreamItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * The one server call an open session makes on its own behalf.
 *
 * A named seam rather than an [ApiClient] parameter, because the gateway
 * contract lives on the other side of it: `resolveInteraction` is what wraps an
 * object answer in `{"type": "extension_ui_response", …}`, and the agent
 * releases its blocked prompt only on a frame carrying that key. A screen that
 * built the request itself would answer the approval, clear the card, and leave
 * the turn hanging until the agent's own 120-second ask timeout.
 */
fun interface InteractionResolver {
    suspend fun resolve(id: String, response: JsonObject): ResolveOutcome
}

/** The production resolver: straight through [ApiClient.resolveInteraction]. */
class ApiInteractionResolver(private val api: ApiClient) : InteractionResolver {
    override suspend fun resolve(id: String, response: JsonObject): ResolveOutcome =
        api.resolveInteraction(id = id, response = response)
}

/** Everything the session screen draws. */
data class SessionState(
    /** The pod the route opened with; [livePod] prefers the stream's own record. */
    val pod: Pod,
    val stream: SessionStreamState = SessionStreamState(),
    val remoteUi: RemoteUiSnapshot = RemoteUiSnapshot(),
    val draft: String = "",
    val attachments: List<ChatAttachment> = emptyList(),
    val attachError: String? = null,
    val isPickingImages: Boolean = false,
) {
    val livePod: Pod get() = stream.podRecord ?: pod

    val composer: ComposerState
        get() = ComposerState(
            text = draft,
            placeholder = composerPlaceholder,
            attachments = attachments,
            attachError = attachError,
            isRunning = stream.isRunning,
            isInterrupting = stream.isInterrupting,
            isConnected = stream.isConnected,
            canAttach = !isPickingImages && !launchFailed,
            isDisabled = launchFailed,
        )

    /** The pod's launch failed, so it will never hold a conversation; the error says why. */
    val launchFailed: Boolean get() = stream.podRecord?.didFail == true

    /** What the field hints at, which is also where a message will go. */
    val composerPlaceholder: String
        get() = when {
            launchFailed -> "This pod couldn’t start"
            stream.isConnected -> "Message pi…"
            stream.preparingPod != null -> "Message pi (sends when ready)…"
            // A workstation wait is minutes, not a keystroke: never present it
            // as a pod that wakes on send.
            stream.workstationWait != null -> "Message pi (sends when ready)…"
            stream.asleep != null -> "Message pi (wakes the pod)…"
            else -> "Message pi (sends on reconnect)…"
        }

    /**
     * Only non-happy states. A persistent "Connected" subtitle next to the pod
     * name is noise once the conversation is usable.
     */
    val statusSubtitle: String?
        get() = when {
            stream.preparingPod != null -> "Preparing sandbox"
            stream.podUnavailable -> "Unavailable"
            stream.workstationWait != null -> "Starting workstation…"
            stream.error != null -> "Couldn’t connect"
            stream.isOffline && !stream.isConnected -> "Offline"
            stream.waking -> if (stream.asleep == "archived") "Waking from storage…" else "Waking…"
            stream.asleep != null && !stream.isConnected -> "Asleep"
            !stream.isConnected -> if (stream.reconnecting) "Reconnecting…" else "Connecting…"
            // The inline typing indicator already says this next to the latest
            // turn; the title repeats it only while the transcript is empty.
            stream.isRunning && stream.items.isEmpty() && stream.pendingInteractions.isEmpty() ->
                "pi is working"

            else -> null
        }

    /**
     * The pod name and its status read as one announcement rather than two
     * unrelated fragments.
     */
    val titleSemanticsLabel: String
        get() = statusSubtitle?.let { "${livePod.name}, $it" } ?: livePod.name
}

/**
 * The chat screen's state machine, ported from `SessionView` and `SessionRoute`
 * in `pi-pod-flutter/lib/features/session/`.
 *
 * It owns the live [SessionStream], the composer draft (persisted per pod) and
 * the images staged for the next turn. Scroll position is deliberately not
 * here: it belongs to the list the reader is looking at, and the stream already
 * publishes a `scrollRevision` for the screen to react to.
 */
class SessionViewModel(
    val stream: SessionStream,
    private val resolver: InteractionResolver,
    private val drafts: SessionDraftStore,
    initialPod: Pod,
    /** Null in a test that drives [stream] directly instead of opening a socket. */
    private val api: SessionApi? = null,
    /**
     * The server's still-pending approvals. Without it a card restored from a
     * replay carries the pi request id and the server rejects a resolve posted
     * with it.
     */
    pendingInteractionsFetcher: (suspend () -> List<PendingInteraction>)? = null,
    private val serverHost: String? = RuntimeConfig.serverUrl,
    /** Set false by a test that owns the stream's lifetime itself. */
    private val ownsStream: Boolean = true,
) : ViewModel() {

    private val local = MutableStateFlow(
        SessionState(pod = initialPod, draft = drafts.read(initialPod.id)),
    )

    val state: StateFlow<SessionState> =
        combine(local, stream.state, stream.remoteUi.state) { own, session, surfaces ->
            own.copy(stream = session, remoteUi = surfaces)
        }.stateIn(
            scope = viewModelScope,
            started = SharingStarted.Eagerly,
            initialValue = local.value,
        )

    /**
     * Approvals whose answer is already in flight. A second tap — or a semantics
     * action slipping past a disabled button — must not post the same answer
     * twice, and the card is only allowed to clear once.
     */
    private val resolving = mutableSetOf<String>()

    init {
        // Restored cards resolve through the gateway uuid from the pending
        // listing; without this the inline Submit posts the pi request id.
        pendingInteractionsFetcher?.let { stream.pendingInteractionsFetcher = it }
        if (api != null) viewModelScope.launch { runCatching { stream.open(api) } }
    }

    // --- composer -----------------------------------------------------------

    fun onDraftChange(text: String) {
        // Editing answers a refusal: the message that was too long is being
        // shortened, and the error must not outlive the text it was about.
        local.update { it.copy(draft = text, attachError = null) }
        drafts.write(state.value.pod.id, text)
    }

    fun send() {
        val current = local.value
        val text = current.draft.trim()
        if (text.isEmpty() && current.attachments.isEmpty()) return
        // Refused here rather than at the gateway: over the limit the send
        // becomes an optimistic bubble that fails on arrival, and every Retry
        // fails again the same way. The draft is left exactly as typed.
        if (text.length > PromptLimits.maxPromptTextChars) {
            local.update { it.copy(attachError = PromptLimits.tooLong(text.length)) }
            return
        }
        val staged = current.attachments.toList()
        local.update { it.copy(draft = "", attachments = emptyList(), attachError = null) }
        drafts.write(current.pod.id, "")
        stream.send(text, staged)
    }

    fun interrupt() = stream.interrupt()

    fun retrySend(id: String) = stream.retrySend(id)

    /**
     * Deleting an undelivered message moves its text back into the composer
     * instead of dropping it, so a mis-tap never destroys a long draft.
     */
    fun discardOutgoing(item: StreamItem) {
        val recovered = item.text
        if (recovered.isNotEmpty()) {
            val current = local.value.draft
            val merged = if (current.isEmpty()) recovered else "$current\n\n$recovered"
            onDraftChange(merged)
        }
        stream.discardOutgoing(item.id)
    }

    fun setPickingImages(picking: Boolean) {
        local.update { it.copy(isPickingImages = picking, attachError = if (picking) null else it.attachError) }
    }

    fun onImagesPicked(picked: List<ChatAttachment>) {
        local.update { it.copy(attachments = it.attachments + picked, attachError = null) }
    }

    fun onAttachFailed(message: String) {
        local.update { it.copy(attachError = message) }
    }

    fun removeAttachment(id: String) {
        local.update { it.copy(attachments = it.attachments.filterNot { item -> item.id == id }, attachError = null) }
    }

    // --- connection ---------------------------------------------------------

    fun retryConnection() {
        val session = api ?: return
        viewModelScope.launch { runCatching { stream.open(session) } }
    }

    fun wake() = stream.wake()

    /** Ends this app's wait. The workstation keeps starting on the server. */
    fun cancelWorkstationWait() = stream.cancelWorkstationWait()

    /** Re-issues the attach now instead of on the wait's next tick. */
    fun retryWorkstationWait() = stream.retryWorkstationWait()

    fun onForeground() = stream.onForeground()

    fun setOffline(offline: Boolean) = stream.setOffline(offline)

    fun setToolExpanded(key: String, expanded: Boolean) = stream.setToolExpanded(key, expanded)

    fun dismissStaleInteraction(id: String) {
        stream.removeInteraction(id)
    }

    // --- approvals ----------------------------------------------------------

    /**
     * Answers one approval, exactly once.
     *
     * The card is registered as locally resolved *before* the POST: the server's
     * `interaction_resolved` fan-out normally beats the POST's own response, and
     * the registered intent is what lets the racing event phrase "You confirmed
     * …" instead of the generic "Resolved …".
     *
     * Restored cards carry the pi request id until the pending listing adopts
     * the gateway uuid. Resolving with a request id is a 404 that surfaces as a
     * bare "validation failed", so one reconcile is attempted first and the
     * failure is re-phrased into something a reader can act on.
     */
    suspend fun resolveInteraction(interaction: PendingInteraction, response: JsonObject) {
        val guard = interaction.id
        synchronized(resolving) { if (!resolving.add(guard)) return }
        try {
            var targetId = stream.resolvableIdFor(interaction.id)
            // The card may already be gone — answered from the Approvals tab,
            // or by another device — in which case the fan-out has cleared it
            // here too. Posting again would answer a request the agent has
            // moved past and emit a second receipt for one decision.
            if (stream.pendingInteractions.none { it.id == interaction.id || it.id == targetId }) {
                return
            }
            if (!SessionStream.isGatewayUuid(targetId)) {
                // Keep the card if this fails; the submit below surfaces the error.
                runCatching { stream.reconcilePendingWithServer() }
                targetId = stream.resolvableIdFor(interaction.id)
            }
            stream.beginLocalResolve(targetId, response)
            if (targetId != interaction.id) stream.beginLocalResolve(interaction.id, response)
            try {
                val outcome = resolver.resolve(targetId, response)
                stream.markInteractionResolved(
                    id = targetId,
                    deliveryPending = outcome.isDeliveryPending,
                    response = response,
                )
            } catch (cancelled: CancellationException) {
                stream.cancelLocalResolve(targetId)
                if (targetId != interaction.id) stream.cancelLocalResolve(interaction.id)
                throw cancelled
            } catch (error: Throwable) {
                stream.cancelLocalResolve(targetId)
                if (targetId != interaction.id) stream.cancelLocalResolve(interaction.id)
                if (!SessionStream.isGatewayUuid(targetId) && looksLikeUnknownInteraction(error, serverHost)) {
                    throw IllegalStateException(UNKNOWN_INTERACTION_MESSAGE)
                }
                throw error
            }
        } finally {
            synchronized(resolving) { resolving.remove(guard) }
        }
    }

    override fun onCleared() {
        if (ownsStream) stream.dispose()
        super.onCleared()
    }

    companion object {
        /** The production wiring: one live socket, one REST client, one draft store. */
        fun create(
            client: ApiClient,
            drafts: SessionDraftStore,
            pod: Pod,
            fromSeq: Long? = null,
            sessionId: String? = null,
        ): SessionViewModel {
            val stream = SessionStream(podId = pod.id, fromSeq = fromSeq, sessionId = sessionId)
            return SessionViewModel(
                stream = stream,
                resolver = ApiInteractionResolver(client),
                drafts = drafts,
                initialPod = pod,
                api = ApiClientSessionApi(client),
                pendingInteractionsFetcher = { client.interactions().items },
            )
        }

        const val UNKNOWN_INTERACTION_MESSAGE: String =
            "Couldn’t find this approval on the server. Reopen the session to refresh, then try again."

        /**
         * The server answers an unknown interaction id — a pi request id posted
         * where only the gateway uuid resolves — with a 404/`not_found` that
         * otherwise surfaces as a bare "validation failed".
         */
        internal fun looksLikeUnknownInteraction(error: Throwable, serverHost: String? = null): Boolean {
            val friendly = FriendlyError.message(error, serverHost).lowercase()
            val raw = error.toString().lowercase()
            return MARKERS.any { friendly.contains(it) || raw.contains(it) }
        }

        private val MARKERS = listOf("validation failed", "not_found", "not found", "404")
    }
}
