package com.pipod.app.features.session

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.session.ApiClientSessionApi
import com.pipod.app.core.session.ChatAttachment
import com.pipod.app.core.session.PiDialog
import com.pipod.app.core.session.RemoteUiSnapshot
import com.pipod.app.core.session.SessionApi
import com.pipod.app.core.session.SessionStream
import com.pipod.app.core.session.SessionStreamState
import com.pipod.app.core.session.StreamItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

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
            stream.isRunning && stream.items.isEmpty() && stream.openDialogs.isEmpty() ->
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
    private val drafts: SessionDraftStore,
    initialPod: Pod,
    /** Null in a test that drives [stream] directly instead of opening a socket. */
    private val api: SessionApi? = null,
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

    init {
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

    /** Answers a dialog pi is waiting on. False while disconnected; pi keeps waiting. */
    fun answer(dialog: PiDialog, response: JsonObject): Boolean = stream.answer(dialog, response)

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
                drafts = drafts,
                initialPod = pod,
                api = ApiClientSessionApi(client),
            )
        }
    }
}
