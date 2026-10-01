package com.pipod.app.core.credentials

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.ApiJson
import com.pipod.app.core.api.model.CredentialStatus
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.session.SessionEnvironment
import java.net.URI
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** A choice offered by a login `select` prompt. */
data class LoginPromptOption(val id: String, val label: String, val description: String? = null)

/** One provider-auth question that must be answered before login can continue. */
data class LoginPrompt(
    val id: String,
    val type: String,
    val message: String,
    val options: List<LoginPromptOption>,
    val placeholder: String? = null,
)

data class LoginLink(val url: String, val label: String)

sealed interface LoginEvent {
    data class Info(val message: String, val links: List<LoginLink>) : LoginEvent
    data class AuthUrl(val url: String, val instructions: String) : LoginEvent
    data class DeviceCode(
        val userCode: String,
        val verificationUri: String,
        val intervalSeconds: Long,
        val expiresInSeconds: Long,
    ) : LoginEvent

    data class Progress(val message: String) : LoginEvent
}

data class LoginFailure(val code: String, val message: String)

sealed interface LoginServerMessage {
    data class Prompt(val prompt: LoginPrompt) : LoginServerMessage
    data class Event(val event: LoginEvent) : LoginServerMessage
    data class Done(
        val ok: Boolean,
        val status: CredentialStatus? = null,
        val error: LoginFailure? = null,
    ) : LoginServerMessage
}

/**
 * Dedicated account-login WebSocket.
 *
 * Tickets are minted over the normal REST client and then carried in the query
 * string, so no account JWT ever enters the URL.
 *
 * Port of `pi-pod-flutter/lib/core/credentials/login_socket.dart`. Callbacks
 * arrive on OkHttp's reader thread; a consumer that touches UI state has to
 * marshal them itself.
 */
class LoginSocket(
    private val api: ApiClient,
    val providerId: String,
    val authType: String,
    val podId: String? = null,
    val serverUrl: String = RuntimeConfig.serverUrl,
    private val webSocketFactory: WebSocket.Factory? = null,
) {

    /**
     * The factory this socket dials with: the caller's, else the app's shared
     * pool installed in [SessionEnvironment], else one process-wide client.
     * Never a client per instance — a login socket used to build an
     * `OkHttpClient` of its own on construction, leaking a dispatcher, a
     * thread pool and a connection pool per login attempt.
     */
    private val sockets: WebSocket.Factory
        get() = webSocketFactory ?: SessionEnvironment.loginSocketFactory ?: SharedLoginSockets.client

    internal fun socketFactoryForTesting(): WebSocket.Factory = sockets

    var onMessage: ((LoginServerMessage) -> Unit)? = null
    var onDisconnect: ((error: Throwable?) -> Unit)? = null

    @Volatile
    var isConnected: Boolean = false
        private set

    private val generation = AtomicInteger(0)

    @Volatile
    private var webSocket: WebSocket? = null

    @Volatile
    private var closed = true

    /** True once a `done` frame arrived: the close that follows is expected. */
    @Volatile
    private var completed = false

    suspend fun connect() {
        disconnect(notify = false)
        val attempt = generation.incrementAndGet()
        closed = false
        completed = false

        try {
            val ticket = api.modelCredentialLoginTicket(
                providerId = providerId,
                authType = authType,
                podId = podId,
            )
            if (attempt != generation.get() || closed) return
            val request = Request.Builder().url(connectionUrl(ticket.ticket)).build()
            isConnected = true
            webSocket = sockets.newWebSocket(request, Listener(attempt))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            if (attempt == generation.get()) terminate(error)
        }
    }

    /**
     * The URL handed to OkHttp. OkHttp upgrades the `http`/`https` form itself,
     * so unlike the Dart client — which handed a browser a `ws`/`wss` URL — the
     * scheme stays as configured.
     */
    fun connectionUrl(ticket: String): HttpUrl = serverUrl.toHttpUrl().newBuilder()
        .fragment(null)
        .query(null)
        .addPathSegment("v1")
        .addPathSegment("model-credentials")
        .addPathSegment(providerId)
        .addPathSegment("login")
        .addQueryParameter("ticket", ticket)
        .build()

    fun respond(id: String, value: String): Boolean = send(
        buildJsonObject {
            put("type", "response")
            put("id", id)
            put("value", value)
        },
    )

    fun cancel(): Boolean {
        val sent = send(buildJsonObject { put("type", "cancel") })
        disconnect(notify = false)
        return sent
    }

    fun disconnect(notify: Boolean = true) {
        val wasConnected = isConnected
        generation.incrementAndGet()
        closed = true
        cleanUp()
        if (notify && wasConnected && !completed) onDisconnect?.invoke(null)
    }

    private fun send(message: JsonObject): Boolean {
        val socket = webSocket
        if (socket == null || !isConnected) return false
        return try {
            socket.send(ApiJson.encodeToString(JsonElement.serializer(), message))
        } catch (error: Throwable) {
            terminate(error)
            false
        }
    }

    /**
     * Public for protocol tests. Malformed, unknown, and unsafe-URL frames are
     * deliberately ignored instead of being handed to presentation code.
     */
    fun handleText(text: String) {
        val decoded = runCatching { ApiJson.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return
        val message = decode(decoded) ?: return
        if (message is LoginServerMessage.Done) completed = true
        onMessage?.invoke(message)
    }

    private fun decode(obj: JsonObject): LoginServerMessage? = when (obj.text("type")) {
        "prompt" -> decodePrompt(obj)
        "event" -> decodeEvent(obj)
        "done" -> decodeDone(obj)
        else -> null
    }

    private fun decodePrompt(obj: JsonObject): LoginServerMessage.Prompt? {
        val id = obj.text("id") ?: return null
        val prompt = obj["prompt"] as? JsonObject ?: return null
        val type = prompt.text("type") ?: return null
        val message = prompt.text("message") ?: return null
        if (type !in PROMPT_TYPES) return null
        val options = (prompt["options"] as? JsonArray).orEmpty().mapNotNull { raw ->
            val option = raw as? JsonObject ?: return@mapNotNull null
            val optionId = option.text("id") ?: return@mapNotNull null
            val label = option.text("label") ?: return@mapNotNull null
            LoginPromptOption(id = optionId, label = label, description = option.text("description"))
        }
        if (type == "select" && options.isEmpty()) return null
        return LoginServerMessage.Prompt(
            LoginPrompt(
                id = id,
                type = type,
                message = message,
                placeholder = prompt.text("placeholder"),
                options = options,
            ),
        )
    }

    private fun decodeEvent(obj: JsonObject): LoginServerMessage.Event? {
        val event = obj["event"] as? JsonObject ?: return null
        return when (event.text("type")) {
            "info" -> {
                val message = event.text("message") ?: return null
                val links = (event["links"] as? JsonArray).orEmpty().mapNotNull { raw ->
                    val link = raw as? JsonObject ?: return@mapNotNull null
                    val url = link.text("url") ?: return@mapNotNull null
                    if (!isSafeLoginUrl(url)) return@mapNotNull null
                    // The server omits `label` when the provider gave none
                    // (`serializeEvent` in `model-credentials/routes.ts` makes
                    // the key conditional). Dropping the link for a missing
                    // caption left the reader with prose telling them to open
                    // something and nothing to open.
                    val label = link.text("label")?.takeIf { it.isNotEmpty() } ?: linkHost(url)
                    LoginLink(url = url, label = label)
                }
                LoginServerMessage.Event(LoginEvent.Info(message = message, links = links))
            }

            "auth_url" -> {
                val url = event.text("url") ?: return null
                if (!isSafeLoginUrl(url)) return null
                // `instructions` is optional on the wire and the server only
                // sends it when the provider supplied one
                // (`auth-bridge.ts`: `instructions === undefined ||
                // typeof instructions === "string"`). Requiring it dropped the
                // whole frame, so a provider that emits a bare `auth_url`
                // produced no link, no error, and a login that never finished.
                val instructions = event.text("instructions").orEmpty()
                LoginServerMessage.Event(LoginEvent.AuthUrl(url = url, instructions = instructions))
            }

            "device_code" -> {
                val userCode = event.text("userCode") ?: return null
                val verificationUri = event.text("verificationUri") ?: return null
                if (!isSafeLoginUrl(verificationUri)) return null
                LoginServerMessage.Event(
                    LoginEvent.DeviceCode(
                        userCode = userCode,
                        verificationUri = verificationUri,
                        intervalSeconds = event.number("intervalSeconds"),
                        expiresInSeconds = event.number("expiresInSeconds"),
                    ),
                )
            }

            "progress" -> event.text("message")?.let {
                LoginServerMessage.Event(LoginEvent.Progress(it))
            }

            else -> null
        }
    }

    private fun decodeDone(obj: JsonObject): LoginServerMessage.Done? {
        val ok = (obj["ok"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
        if (ok) {
            val status = obj["status"] as? JsonObject ?: return null
            val decoded = runCatching {
                ApiJson.decodeFromJsonElement(CredentialStatus.serializer(), status)
            }.getOrNull() ?: return null
            return LoginServerMessage.Done(ok = true, status = decoded)
        }
        val error = obj["error"] as? JsonObject ?: return null
        val code = error.text("code") ?: return null
        val message = error.text("message") ?: return null
        return LoginServerMessage.Done(ok = false, error = LoginFailure(code = code, message = message))
    }

    private fun terminate(error: Throwable?) {
        if (closed) return
        closed = true
        generation.incrementAndGet()
        cleanUp()
        onDisconnect?.invoke(error)
    }

    private fun cleanUp() {
        val socket = webSocket
        webSocket = null
        socket?.close(NORMAL_CLOSURE, null)
        isConnected = false
    }

    private inner class Listener(private val attempt: Int) : WebSocketListener() {

        private val current: Boolean get() = attempt == generation.get()

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (current) handleText(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(NORMAL_CLOSURE, null)
            if (!current) return
            // A `done` frame already said how the login ended, so the close that
            // follows it is the protocol working, not a dropped connection.
            if (completed) cleanUp() else terminate(null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!current) return
            if (completed) cleanUp() else terminate(null)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (current) terminate(t)
        }
    }

    private companion object {
        const val NORMAL_CLOSURE = 1000
        val PROMPT_TYPES = setOf("text", "secret", "manual_code", "select")

        fun JsonObject.text(key: String): String? =
            (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

        fun JsonObject.number(key: String): Long =
            (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: 0L

        fun JsonArray?.orEmpty(): List<JsonElement> = this ?: emptyList()
    }
}

/** The host a caption-less link points at — the honest thing to label it with. */
internal fun linkHost(value: String): String =
    runCatching { URI(value).host }.getOrNull()?.takeIf { it.isNotEmpty() } ?: value

/**
 * Login links may use HTTPS anywhere. Plain HTTP is allowed only for a local
 * loopback callback used by provider development flows.
 */
fun isSafeLoginUrl(value: String): Boolean {
    val uri = runCatching { URI(value) }.getOrNull() ?: return false
    val host = uri.host ?: return false
    if (host.isEmpty()) return false
    return when (uri.scheme) {
        "https" -> true
        "http" -> host in LOOPBACK_HOSTS
        else -> false
    }
}

/** `java.net.URI` keeps the brackets on an IPv6 literal; the bare form is here too. */
private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1", "[::1]")

/**
 * The login socket's last-resort dialer: one process-wide client, shared by
 * every login that neither the caller nor `AppContainer` supplied a factory
 * for. A dedicated client rather than [ApiClient.defaultHttpClient] because a
 * login socket is long-lived and must not inherit the REST read timeout.
 */
internal object SharedLoginSockets {
    val client: WebSocket.Factory by lazy {
        OkHttpClient.Builder()
            .readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
            .pingInterval(0, java.util.concurrent.TimeUnit.MILLISECONDS)
            .build()
    }
}
