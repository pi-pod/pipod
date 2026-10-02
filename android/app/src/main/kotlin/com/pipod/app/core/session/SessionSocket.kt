package com.pipod.app.core.session

import android.util.Log
import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.ApiJson
import com.pipod.app.core.config.RuntimeConfig
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Server close codes from the session WebSocket contract. */
enum class SessionCloseCode(val value: Int) {
    GOING_AWAY(1012),
    UNAUTHORIZED(4001),
    BAD_REQUEST(4400),
    POD_NOT_FOUND(4404),
    POD_UNAVAILABLE(4409),

    /**
     * "The pod is asleep" **and** "the reader's own workstation is not ready"
     * share this code, so the code alone is not enough to decide what to draw:
     * a client that only looks here silently tells someone their pod dozed off
     * when in fact a whole VM is booting for the next several minutes. The close
     * *reason* (or the `error` frame that precedes it) is what separates them —
     * see `WorkstationDemand.CLOSE_FRAME_REASONS`.
     */
    ASLEEP(4420),
    PI_EXITED(4421),
    TRANSIENT(4500),
    ;

    companion object {
        fun fromValue(value: Int?): SessionCloseCode? = entries.firstOrNull { it.value == value }
    }
}

/**
 * One image block inside an outgoing `prompt` client message. Mirrors pi's
 * `ImageContent` (`{type: 'image', data: <base64>, mimeType}`), which the
 * gateway forwards to pi's RPC `prompt` verbatim.
 */
data class SessionImage(val mimeType: String, val base64Data: String) {
    fun toJson(): JsonObject = buildJsonObject {
        put("type", "image")
        put("data", base64Data)
        put("mimeType", mimeType)
    }
}

/** A decoded message from `/v1/pods/:podId/session`. */
sealed interface SessionServerMessage {

    data class Hello(
        val sessionId: String,
        val latestSeq: Long,
        val firstReplayedSeq: Long?,
        val state: JsonObject?,
    ) : SessionServerMessage

    data class Event(
        val seq: Long,
        val kind: String,
        val ts: String?,
        val payload: JsonObject,
    ) : SessionServerMessage

    data class Ephemeral(val kind: String, val payload: JsonObject) : SessionServerMessage

    /** Some client answered the dialog with this pi request id. */
    data class DialogClosed(val id: String) : SessionServerMessage

    data class ReplayGap(val fromSeq: Long, val toSeq: Long) : SessionServerMessage

    data class PodState(val state: String, val reason: String?) : SessionServerMessage

    data class PodUpdated(val id: String, val name: String) : SessionServerMessage

    data class Ended(val reason: String, val kind: String, val recoverable: Boolean) :
        SessionServerMessage

    data class Models(
        val models: List<JsonObject>,
        val current: JsonObject?,
        val thinkingLevel: String?,
        val thinkingLevels: List<String>,
    ) : SessionServerMessage

    data object Pong : SessionServerMessage

    /**
     * [detail] is kept because the gateway attaches the typed host-demand object
     * to the `error` frame it sends immediately before closing with 4420. It is
     * never rendered as text; only the validated parse of it is used.
     */
    data class Error(
        val code: String?,
        val message: String,
        val detail: JsonObject? = null,
    ) : SessionServerMessage
}

interface SessionTransport {
    val isConnected: Boolean
    val latestSeq: Long
    val sessionId: String?

    var onMessage: ((SessionServerMessage) -> Unit)?

    /**
     * [closeReason] is the server's own close reason — the gateway puts its
     * `errCode` there, which is the only thing that separates a 4420 for an
     * asleep pod from a 4420 for a workstation that is still starting.
     */
    var onDisconnect: ((error: Throwable?, closeCode: SessionCloseCode?, closeReason: String?) -> Unit)?

    /** Consumes a freshly minted one-shot ticket for this connection attempt. */
    fun connect(ticket: String)
    fun disconnect(notify: Boolean = true)

    /**
     * Releases everything the transport owns; it is unusable afterwards. A
     * reconnect replaces its transport, and an implementation holding a
     * coroutine scope or a thread pool leaks one per attempt without this.
     */
    fun dispose() = disconnect(notify = false)

    fun prompt(text: String, images: List<SessionImage>? = null): Boolean
    fun interrupt(): Boolean
    fun requestModels(): Boolean
    fun uiResponse(response: JsonObject): Boolean
    fun set(model: Map<String, String>? = null, thinkingLevel: String? = null): Boolean
}

/**
 * JSON WebSocket client for one pod session.
 *
 * Authentication is carried by the one-shot `ticket` query parameter rather
 * than a header: the same URL has to work from a browser, where a WebSocket
 * cannot attach authorization headers.
 *
 * Port of `pi-pod-flutter/lib/core/session/session_socket.dart`. Callbacks are
 * delivered on OkHttp's reader thread, so a consumer that owns mutable state
 * must marshal them onto its own dispatcher — [SessionStream] does.
 */
class SessionSocket(
    val podId: String,
    val fromSeq: Long?,
    val fromSessionId: String?,
    val serverUrl: String = RuntimeConfig.serverUrl,
    private val webSocketFactory: WebSocket.Factory = defaultWebSocketFactory(),
    val pingInterval: Duration = 25.seconds,
) : SessionTransport {

    @Volatile
    override var isConnected: Boolean = false
        private set

    @Volatile
    override var latestSeq: Long = 0
        private set

    @Volatile
    override var sessionId: String? = null
        private set

    override var onMessage: ((SessionServerMessage) -> Unit)? = null
    override var onDisconnect: (
        (error: Throwable?, closeCode: SessionCloseCode?, closeReason: String?) -> Unit
    )? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val generation = AtomicInteger(0)

    @Volatile
    private var webSocket: WebSocket? = null

    @Volatile
    private var pingJob: Job? = null

    @Volatile
    private var terminated: Boolean = true

    /** The close code the server sent, kept so [disconnect] reporting can name it. */
    @Volatile
    private var lastCloseCode: Int? = null

    /** The close reason beside it. `4420` means nothing without it. */
    @Volatile
    private var lastCloseReason: String? = null

    override fun connect(ticket: String) {
        disconnect(notify = false)
        val attempt = generation.incrementAndGet()
        terminated = false
        lastCloseCode = null
        lastCloseReason = null
        val request = Request.Builder().url(connectionUrl(ticket)).build()
        webSocket = webSocketFactory.newWebSocket(request, Listener(attempt))
    }

    /**
     * The URL handed to OkHttp.
     *
     * OkHttp takes the `http`/`https` form and upgrades it, so unlike the Dart
     * client — which had to hand a browser a `ws`/`wss` URL — the scheme here
     * stays as configured. A fragment is dropped either way: the browser
     * WebSocket constructor rejects any URL carrying one, and the server has
     * never had a use for it.
     */
    fun connectionUrl(ticket: String): HttpUrl {
        val builder = serverUrl.toHttpUrl().newBuilder().fragment(null).query(null)
        builder.addPathSegment("v1").addPathSegment("pods").addPathSegment(podId)
            .addPathSegment("session")
        builder.addQueryParameter("ticket", ticket)
        fromSeq?.let { builder.addQueryParameter("from_seq", "$it") }
        fromSessionId?.let { builder.addQueryParameter("from_session", it) }
        return builder.build()
    }

    override fun disconnect(notify: Boolean) {
        val wasConnected = isConnected
        generation.incrementAndGet()
        terminated = true
        pingJob?.cancel()
        pingJob = null
        val socket = webSocket
        webSocket = null
        if (wasConnected) {
            // An open socket is closed politely, so the gateway sees 1000 and
            // detaches the client rather than waiting out a read timeout.
            socket?.close(NORMAL_CLOSURE, null)
        } else {
            // `close` on a socket that has not finished its handshake is
            // documented to do nothing: OkHttp has no channel to write a close
            // frame to yet. The connect attempt then ran to completion in the
            // background — leaving a session the user had already left mid-open,
            // and, on a slow network, a `detach` that did not detach anything.
            // Only `cancel` aborts it.
            socket?.cancel()
        }
        isConnected = false
        if (notify && wasConnected) onDisconnect?.invoke(null, null, null)
    }

    override fun prompt(text: String, images: List<SessionImage>?): Boolean = send(
        buildJsonObject {
            put("type", "prompt")
            put("text", text)
            if (!images.isNullOrEmpty()) {
                putJsonArray("images") { images.forEach { add(it.toJson()) } }
            }
        },
    )

    override fun interrupt(): Boolean = send(buildJsonObject { put("type", "interrupt") })

    override fun requestModels(): Boolean = send(buildJsonObject { put("type", "get_models") })

    /**
     * Answers an extension UI request the pod is blocking on: a dialog, or a
     * remote-UI surface. The gateway forwards the response to pi verbatim, so it
     * must already be a complete `extension_ui_response` frame.
     */
    override fun uiResponse(response: JsonObject): Boolean = send(
        buildJsonObject {
            put("type", "ui_response")
            put("response", response)
        },
    )

    override fun set(model: Map<String, String>?, thinkingLevel: String?): Boolean = send(
        buildJsonObject {
            put("type", "set")
            model?.let { fields -> put("model", buildJsonObject { fields.forEach { (k, v) -> put(k, v) } }) }
            thinkingLevel?.let { put("thinkingLevel", it) }
        },
    )

    private fun send(message: JsonObject): Boolean {
        val socket = webSocket
        if (socket == null || !isConnected) return false
        return try {
            socket.send(ApiJson.encodeToString(JsonElement.serializer(), message))
        } catch (error: Throwable) {
            fail(error, null)
            false
        }
    }

    /**
     * Public for protocol-focused unit tests. Malformed and unknown frames are
     * ignored, matching the tolerant Swift decoder.
     */
    fun handleText(text: String) {
        val decoded = runCatching { ApiJson.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return
        val type = decoded.string("type") ?: return

        val message = decode(type, decoded) ?: return
        when (message) {
            is SessionServerMessage.Hello -> {
                sessionId = message.sessionId
                latestSeq = message.latestSeq
                isConnected = true
                startPinging()
            }

            is SessionServerMessage.Event -> {
                if (message.seq > latestSeq) latestSeq = message.seq
            }

            else -> Unit
        }
        onMessage?.invoke(message)
    }

    private fun decode(type: String, obj: JsonObject): SessionServerMessage? = when (type) {
        "hello" -> SessionServerMessage.Hello(
            sessionId = obj.string("sessionId") ?: "",
            latestSeq = obj.integer("latestSeq") ?: 0,
            firstReplayedSeq = obj.integer("firstReplayedSeq"),
            state = obj["state"] as? JsonObject,
        )

        "event" -> SessionServerMessage.Event(
            seq = obj.integer("seq") ?: 0,
            kind = obj.string("kind") ?: "event",
            ts = obj.string("ts"),
            payload = obj["payload"] as? JsonObject ?: JsonObject(emptyMap()),
        )

        "ephemeral" -> SessionServerMessage.Ephemeral(
            kind = obj.string("kind") ?: "event",
            payload = obj["payload"] as? JsonObject ?: JsonObject(emptyMap()),
        )

        "dialog_closed" -> SessionServerMessage.DialogClosed(id = obj.string("id") ?: "")

        "replay_gap" -> SessionServerMessage.ReplayGap(
            fromSeq = obj.integer("fromSeq") ?: 0,
            toSeq = obj.integer("toSeq") ?: 0,
        )

        "pod_state" -> SessionServerMessage.PodState(
            state = obj.string("state") ?: "",
            reason = obj.string("reason"),
        )

        "pod_updated" -> SessionServerMessage.PodUpdated(
            id = obj.string("id") ?: "",
            name = obj.string("name") ?: "",
        )

        "session_ended" -> SessionServerMessage.Ended(
            reason = obj.string("reason") ?: "",
            kind = obj.string("kind") ?: "",
            recoverable = (obj["recoverable"] as? JsonPrimitive)?.booleanOrNull ?: true,
        )

        "models" -> SessionServerMessage.Models(
            models = (obj["models"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList(),
            current = obj["current"] as? JsonObject,
            thinkingLevel = obj.string("thinkingLevel"),
            thinkingLevels = (obj["thinkingLevels"] as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                ?: emptyList(),
        )

        "pong" -> SessionServerMessage.Pong

        "error" -> SessionServerMessage.Error(
            code = obj.string("code"),
            message = obj.string("message") ?: "unknown error",
            detail = obj["detail"] as? JsonObject,
        )

        else -> null
    }

    private fun startPinging() {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (isActive) {
                delay(pingInterval)
                send(buildJsonObject { put("type", "ping") })
            }
        }
    }

    private fun fail(error: Throwable?, closeCode: Int?, closeReason: String? = null) {
        if (terminated) return
        terminated = true
        pingJob?.cancel()
        pingJob = null
        webSocket = null
        isConnected = false
        val resolvedCode = closeCode ?: lastCloseCode
        val resolvedReason = closeReason ?: lastCloseReason
        // On-device receipt for the close: logcat is the app's own record of
        // why the socket went away, so a diagnosis never needs a wire capture.
        // The reason is sanitized here only; the raw value still reaches
        // onDisconnect below because a 4420 means nothing without it.
        val codeLog = resolvedCode?.toString() ?: "null"
        val reasonLog = sanitizeSessionCloseReason(resolvedReason) ?: ""
        // Never the throwable's message: failures carry the request URL, and
        // this URL's query string is the one-shot session ticket.
        val errorLog = error?.let { " error=${it.javaClass.name}" } ?: ""
        closeLogSink("session socket closed code=$codeLog reason=$reasonLog$errorLog")
        onDisconnect?.invoke(
            error,
            SessionCloseCode.fromValue(resolvedCode),
            resolvedReason,
        )
    }

    private inner class Listener(private val attempt: Int) : WebSocketListener() {

        private val current: Boolean get() = attempt == generation.get()

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (current) handleText(text)
        }

        /**
         * The server initiated the close, so its code is authoritative. The
         * handshake is completed here rather than left to time out.
         */
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            lastCloseCode = code
            lastCloseReason = reason.takeIf { it.isNotEmpty() }
            webSocket.close(NORMAL_CLOSURE, null)
            if (current) fail(null, code, lastCloseReason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            lastCloseCode = code
            lastCloseReason = reason.takeIf { it.isNotEmpty() } ?: lastCloseReason
            if (current) fail(null, code, lastCloseReason)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (current) fail(t, response?.code)
        }
    }

    /** Releases the ping coroutine's scope; the socket is unusable afterwards. */
    override fun dispose() {
        disconnect(notify = false)
        scope.cancel()
    }

    companion object {
        private const val NORMAL_CLOSURE = 1000

        /**
         * Logcat tag for session socket close receipts. The iOS counterpart
         * logs under `session.socket`; tags stay short by Android convention.
         */
        const val SESSION_LOG_TAG = "pipod.session"

        /**
         * Gateway close-reason codes safe to write to logcat. Exact match only;
         * everything else logs as [REDACTED_CLOSE_REASON] so a bare
         * bearer/API-shaped payload can never reach a device log. The raw
         * reason still reaches `onDisconnect` for the 4420 workstation check.
         */
        internal val SESSION_CLOSE_REASON_ALLOWLIST = setOf(
            "host_starting",
            "host_stopped",
            "host_archived",
            "pod_unavailable",
            "gateway_shutdown",
        )

        internal const val REDACTED_CLOSE_REASON = "<redacted>"

        /**
         * Test seam for the close receipt. Defaults to logcat; unit tests
         * replace it to assert the exact line (`isReturnDefaultValues` keeps
         * the default harmless on the JVM).
         */
        internal var closeLogSink: (String) -> Unit = { message ->
            Log.i(SESSION_LOG_TAG, message)
        }

        /**
         * A dedicated client: the session socket is long-lived and pings itself,
         * so it must not inherit the REST read timeout.
         */
        fun defaultWebSocketFactory(): WebSocket.Factory = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(0, TimeUnit.MILLISECONDS)
            .build()
    }
}

/**
 * The part of a WebSocket close reason that is safe to write to logcat.
 *
 * Allowlist only: a gateway `errCode` in
 * [SessionSocket.SESSION_CLOSE_REASON_ALLOWLIST] passes through on exact match
 * after trim, and anything else — URLs, tickets, long junk, or bare
 * bearer/API-shaped text — logs as `<redacted>`. The raw reason still reaches
 * `onDisconnect` (and the 4420 workstation wait) unchanged; only the log line
 * is scrubbed.
 */
internal fun sanitizeSessionCloseReason(reason: String?): String? {
    val trimmed = reason?.trim() ?: return null
    if (trimmed.isEmpty()) return null
    if (trimmed in SessionSocket.SESSION_CLOSE_REASON_ALLOWLIST) return trimmed
    return SessionSocket.REDACTED_CLOSE_REASON
}

/** The value at [key] when it is a JSON number, otherwise null. */
internal fun JsonObject.integer(key: String): Long? = (this[key] as? JsonPrimitive)
    ?.takeIf { !it.isString }
    ?.let { it.longOrNull ?: it.content.toDoubleOrNull()?.toLong() }
