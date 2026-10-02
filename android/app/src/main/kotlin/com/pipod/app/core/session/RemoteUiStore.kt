package com.pipod.app.core.session

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Sends a `ui_response` client message. Returns false when the socket is down;
 * the gateway replays the still-outstanding input request on reattach, so a
 * dropped send costs one round trip rather than the surface.
 */
typealias RemoteUiResponder = (JsonObject) -> Boolean

/**
 * One pod-side extension surface as the app knows it: the newest rendered
 * lines, the metadata accumulated across frames, and the input request the pod
 * is currently waiting on.
 *
 * Behaviour mirrors `RemoteSurface` in pi-pod's `client/runtime/remote-ui.ts`,
 * which is the contract of record: revision monotonicity, resize-before-input
 * flush ordering, ≤64 batched key events per send, and newest-wins `setText`.
 *
 * Every entry point runs under [RemoteUiStore.lock]: frames arrive on OkHttp's
 * reader thread while keystrokes and resizes arrive on the main thread, and
 * `pendingRequestId` is the token that decides whether an input is sent now or
 * queued. Two threads reading it at once answer one request twice — the gateway
 * drops the second and the surface stops being fed frames.
 */
class RemoteUiSurface internal constructor(
    val id: String,
    private val store: RemoteUiStore,
    initialJson: JsonObject,
) {
    private val lock: Any get() = store.lock

    private var merged: JsonObject = initialJson

    /** Metadata merged across every frame this surface has received. */
    var frame: RemoteUiSurfaceFrame = remoteUiFrameFromJson(initialJson) as RemoteUiSurfaceFrame
    var lines: List<String> = emptyList()
    var editorText: String = ""
    var revision: Int = -1

    /**
     * Set when another attached client claimed this surface first. It keeps
     * rendering; only input is refused.
     */
    var readOnly: Boolean = false

    private var pendingRequestId: String? = null
    private var sequence = 0
    private var lastEditorSubmitId = 0
    private var width = 0
    private var height = 0
    private var queuedWidth = 0
    private var queuedHeight = 0
    private val queued = ArrayDeque<QueuedInput>()

    val role: RemoteUiRole get() = frame.role
    val isOverlay: Boolean get() = frame.overlay
    val overlayOptions: RemoteUiOverlayOptions? get() = frame.overlayOptions
    val focused: Boolean get() = frame.focused ?: !(overlayOptions?.nonCapturing ?: false)
    val widgetKey: String? get() = frame.widgetKey
    val placement: RemoteUiPlacement get() = frame.placement ?: RemoteUiPlacement.ABOVE_EDITOR

    /** True while the pod is waiting for this client to answer. */
    val isAwaitingInput: Boolean get() = pendingRequestId != null

    internal fun apply(json: JsonObject, incoming: RemoteUiSurfaceFrame, requestId: String?) {
        synchronized(lock) {
            if (incoming.revision >= revision) {
                revision = incoming.revision
                lines = incoming.lines ?: emptyList()
                merged = JsonObject(merged + json)
                frame = remoteUiFrameFromJson(merged) as RemoteUiSurfaceFrame
                applyEditorFrame(incoming.editorText, incoming.editorSubmit, incoming.editorSubmitId)
            }
            if (requestId != null) {
                pendingRequestId = requestId
                flush()
            }
        }
    }

    private fun applyEditorFrame(text: String?, submit: String?, submitId: Int?) {
        if (text != null && text != editorText) {
            editorText = text
            store.onEditorTextChanged?.invoke(this)
        }
        if (submit != null && submitId != null && submitId > lastEditorSubmitId) {
            lastEditorSubmitId = submitId
            store.onEditorSubmit?.invoke(this, submit)
        }
    }

    /**
     * Reports the host's measured cell grid. A pending resize is always flushed
     * before queued input so the pod renders the next frame at the real width.
     */
    fun resize(width: Int, height: Int) {
        synchronized(lock) {
            if (width <= 0 || height <= 0) return
            if (width == this.width && height == this.height) return
            this.width = width
            this.height = height
            if (readOnly) return
            if (pendingRequestId == null) {
                queuedWidth = width
                queuedHeight = height
                return
            }
            send(RemoteUiInputKind.RESIZE, width, height)
        }
    }

    /** Raw terminal data, exactly as pi-tui would have read it from stdin. */
    fun input(data: String) {
        synchronized(lock) {
            if (readOnly) return
            val chunks = ArrayDeque<String>()
            if (data.isEmpty()) chunks.add("")
            var offset = 0
            while (offset < data.length) {
                chunks.add(data.substring(offset, minOf(offset + REMOTE_UI_MAX_LINE_LENGTH, data.length)))
                offset += REMOTE_UI_MAX_LINE_LENGTH
            }
            if (pendingRequestId == null) {
                for (chunk in chunks) queue(QueuedInput(RemoteUiInputKind.INPUT, chunk))
                return
            }
            send(RemoteUiInputKind.INPUT, sendWidth, sendHeight, data = chunks.removeFirst())
            for (chunk in chunks) queue(QueuedInput(RemoteUiInputKind.INPUT, chunk))
        }
    }

    /** Absolute replacement of an editor-role surface's text. */
    fun setText(text: String) {
        synchronized(lock) {
            if (readOnly) return
            editorText = text
            if (pendingRequestId == null) {
                // Only the newest unsent replacement matters; raw key events keep order.
                queued.removeAll { it.kind == RemoteUiInputKind.SET_TEXT }
                queue(QueuedInput(RemoteUiInputKind.SET_TEXT, text))
                return
            }
            send(RemoteUiInputKind.SET_TEXT, sendWidth, sendHeight, data = text)
        }
    }

    /** The user dismissed the surface locally; the pod tears its component down. */
    fun close() {
        synchronized(lock) {
            val pending = pendingRequestId != null
            if (!readOnly && pending) send(RemoteUiInputKind.CLOSE, sendWidth, sendHeight)
            store.forget(id, awaitingClose = !pending)
        }
    }

    private fun queue(input: QueuedInput) {
        // A bounded FIFO survives normal typing across a round trip without growing
        // without limit if the surface stops answering entirely.
        if (queued.size >= MAX_QUEUED_INPUT) queued.removeFirst()
        queued.add(input)
    }

    private fun flush() {
        if (pendingRequestId == null || readOnly) return
        if (queuedWidth > 0) {
            val width = queuedWidth
            val height = queuedHeight
            queuedWidth = 0
            queuedHeight = 0
            send(RemoteUiInputKind.RESIZE, width, height)
            return
        }
        if (queued.isEmpty()) return
        val first = queued.removeFirst()
        if (first.kind != RemoteUiInputKind.INPUT) {
            send(first.kind, sendWidth, sendHeight, data = first.data)
            return
        }
        val events = mutableListOf(first.data)
        while (events.size < REMOTE_UI_MAX_INPUT_EVENTS &&
            queued.isNotEmpty() &&
            queued.first().kind == RemoteUiInputKind.INPUT
        ) {
            events.add(queued.removeFirst().data)
        }
        send(RemoteUiInputKind.INPUT, sendWidth, sendHeight, events = events)
    }

    private val sendWidth: Int get() = if (width > 0) width else 80
    private val sendHeight: Int get() = if (height > 0) height else 24

    private fun send(
        kind: RemoteUiInputKind,
        width: Int,
        height: Int,
        data: String? = null,
        events: List<String>? = null,
    ) {
        val requestId = pendingRequestId ?: return
        pendingRequestId = null
        sequence += 1
        store.respond(
            this,
            requestId,
            RemoteUiInput(
                kind = kind,
                surfaceId = id,
                sequence = sequence,
                width = width.coerceIn(1, REMOTE_UI_MAX_DIMENSION),
                height = height.coerceIn(1, REMOTE_UI_MAX_DIMENSION),
                data = data,
                events = events,
            ),
        )
    }

    internal fun dropQueuedInput() {
        synchronized(lock) {
            queued.clear()
            queuedWidth = 0
            queuedHeight = 0
        }
    }

    private companion object {
        const val MAX_QUEUED_INPUT = 1024
    }
}

private class QueuedInput(val kind: RemoteUiInputKind, val data: String)

/**
 * A conflated snapshot of the store. The surfaces are mutated in place, so
 * [revision] is what makes a repaint of an existing surface observable.
 */
data class RemoteUiSnapshot(
    val surfaces: List<RemoteUiSurface> = emptyList(),
    val revision: Long = 0,
)

/**
 * Holds every live remote extension UI surface for one session and owns the
 * input path back to the pod. Frames are whole-surface repaints, so the store
 * keeps only the newest one per surface.
 *
 * Every public entry point is mutually excluded on [lock]. The Dart original
 * could assume one isolate; here `applyExtensionRequest` runs on OkHttp's
 * reader thread while `input`, `setText`, `resize` and `close` run on the main
 * thread, over a plain `LinkedHashMap` and per-surface queues.
 *
 * [SessionStream] passes **its own** monitor rather than letting the store make
 * one. The two are mutually re-entrant — a frame is applied while the stream's
 * lock is held, and answering an input request calls back into the stream to
 * write to the socket — so two separate locks are two lock orders and a
 * deadlock the first time a keystroke meets a frame. One re-entrant monitor for
 * both has no ordering to get wrong.
 */
class RemoteUiStore(
    responder: RemoteUiResponder? = null,
    internal val lock: Any = Any(),
) {

    var responder: RemoteUiResponder? = responder

    var onControl: ((RemoteUiControlFrame) -> Unit)? = null
    var onEditorSubmit: ((RemoteUiSurface, String) -> Unit)? = null
    var onEditorTextChanged: ((RemoteUiSurface) -> Unit)? = null

    private val liveSurfaces = LinkedHashMap<String, RemoteUiSurface>()

    /**
     * Surfaces dismissed locally while the pod was not waiting on us. The close
     * goes out on the next input request instead of leaving the pod's component
     * blocked forever.
     */
    private val dismissed = LinkedHashSet<String>()
    private var activeContextRevision = 0
    private var lastRespondedSurfaceId: String? = null
    private var disposed = false

    private val _state = MutableStateFlow(RemoteUiSnapshot())
    val state: StateFlow<RemoteUiSnapshot> = _state.asStateFlow()

    /** Insertion-ordered, which is the order the pod opened them in. */
    val surfaces: List<RemoteUiSurface> get() = synchronized(lock) { liveSurfaces.values.toList() }

    val isEmpty: Boolean get() = synchronized(lock) { liveSurfaces.isEmpty() }

    fun surface(id: String): RemoteUiSurface? = synchronized(lock) { liveSurfaces[id] }

    fun withRole(role: RemoteUiRole): List<RemoteUiSurface> =
        synchronized(lock) { liveSurfaces.values.filter { it.role == role } }

    /**
     * Consumes an `extension_ui_request` ephemeral payload. Returns false when it
     * is not remote-UI traffic, leaving it to the dialog path.
     */
    fun applyExtensionRequest(payload: JsonObject): Boolean = synchronized<Boolean>(lock) {
        val json = remoteUiFrameJsonFromExtensionRequest(payload) ?: return false
        val frame = remoteUiFrameFromJson(json)!!
        val requestId = if (payload.text("method") == "input") payload.text("id") else null

        val contextRevision = frame.contextRevision
        if (contextRevision != null) {
            if (contextRevision < activeContextRevision) {
                // A frame from a pod context that has already been replaced. Answering
                // with close lets the pod's abandoned component finish.
                if (requestId != null) {
                    respondClose(
                        requestId,
                        if (frame is RemoteUiSurfaceFrame) frame.surfaceId else "stale",
                    )
                }
                return true
            }
            if (contextRevision > activeContextRevision) {
                clear()
                activeContextRevision = contextRevision
            }
        }

        when (frame) {
            is RemoteUiControlFrame -> onControl?.invoke(frame)
            is RemoteUiSurfaceFrame -> applySurfaceFrame(json, frame, requestId)
        }
        return true
    }

    private fun applySurfaceFrame(
        json: JsonObject,
        frame: RemoteUiSurfaceFrame,
        requestId: String?,
    ) {
        if (frame.kind == RemoteUiSurfaceKind.CLOSE) {
            dismissed.remove(frame.surfaceId)
            if (liveSurfaces.remove(frame.surfaceId) != null) publish()
            return
        }
        if (dismissed.contains(frame.surfaceId)) {
            if (requestId != null) {
                dismissed.remove(frame.surfaceId)
                respondClose(requestId, frame.surfaceId)
            }
            return
        }
        var surface = liveSurfaces[frame.surfaceId]
        if (surface == null) {
            if (liveSurfaces.size >= REMOTE_UI_MAX_SURFACES) {
                liveSurfaces.remove(liveSurfaces.keys.first())
            }
            surface = RemoteUiSurface(frame.surfaceId, this, json)
            liveSurfaces[frame.surfaceId] = surface
        }
        surface.apply(json, frame, requestId)
        publish()
    }

    /**
     * The gateway rejected our input because another attached client owns this
     * surface. It stays visible and read-only until it closes or we reattach.
     */
    fun markOwnedElsewhere() {
        synchronized(lock) {
            val surface = lastRespondedSurfaceId?.let { liveSurfaces[it] }
            if (surface == null || surface.readOnly) return
            surface.readOnly = true
            surface.dropQueuedInput()
            publish()
        }
    }

    /**
     * A fresh attach: the gateway replays the newest frame and the outstanding
     * input request for every live surface, so the old set is discarded first.
     */
    fun resetForAttach() {
        synchronized(lock) {
            activeContextRevision = 0
            clear()
        }
    }

    fun clear() {
        synchronized(lock) {
            dismissed.clear()
            if (liveSurfaces.isEmpty()) return
            liveSurfaces.clear()
            lastRespondedSurfaceId = null
            publish()
        }
    }

    internal fun forget(surfaceId: String, awaitingClose: Boolean = false) {
        synchronized(lock) {
            if (awaitingClose) {
                if (dismissed.size >= REMOTE_UI_MAX_SURFACES) dismissed.remove(dismissed.first())
                dismissed.add(surfaceId)
            }
            if (liveSurfaces.remove(surfaceId) != null) publish()
        }
    }

    internal fun respond(surface: RemoteUiSurface, requestId: String, input: RemoteUiInput) {
        lastRespondedSurfaceId = surface.id
        responder?.invoke(remoteUiResponsePayload(requestId = requestId, input = input))
    }

    private fun respondClose(requestId: String, surfaceId: String) {
        responder?.invoke(
            remoteUiResponsePayload(
                requestId = requestId,
                input = RemoteUiInput(
                    kind = RemoteUiInputKind.CLOSE,
                    surfaceId = surfaceId,
                    sequence = 1,
                    width = 80,
                    height = 24,
                ),
            ),
        )
    }

    /**
     * A surface can repaint on every pod-side timer tick. The Dart original
     * collapsed listener notifications to one per rendered frame; a [StateFlow]
     * conflates on its own, so a burst still costs one recomposition.
     */
    private fun publish() {
        if (disposed) return
        _state.value = RemoteUiSnapshot(surfaces, _state.value.revision + 1)
    }

    fun dispose() {
        synchronized(lock) {
            disposed = true
            liveSurfaces.clear()
            responder = null
        }
    }

    private fun JsonObject.text(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
}
