package com.pipod.app.features.settings

import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.ConnectableProvider
import com.pipod.app.core.api.model.CredentialStatus
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.credentials.LoginEvent
import com.pipod.app.core.credentials.LoginPrompt
import com.pipod.app.core.credentials.LoginServerMessage
import com.pipod.app.core.credentials.isSafeLoginUrl
import com.pipod.app.core.format.FriendlyError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Everything the provider-login sheet draws. */
data class CredentialLoginState(
    val events: List<LoginEvent> = emptyList(),
    val prompt: LoginPrompt? = null,
    val error: String? = null,
    val connecting: Boolean = true,
)

/** What the sheet does rather than draws. */
sealed interface CredentialLoginEvent {
    data class Connected(val status: CredentialStatus) : CredentialLoginEvent
    data object Dismissed : CredentialLoginEvent
}

/**
 * Drives the frozen provider-login prompt/event protocol.
 *
 * Port of `CredentialLoginView`'s state in
 * `pi-pod-flutter/lib/features/settings/credential_login_view.dart`. The view is
 * generic on purpose: a provider can ask for an API key, hand back a URL to
 * open, or run a device-code flow, and the client renders whatever the frozen
 * protocol carries rather than knowing any provider by name.
 *
 * Deliberately **not** a `ViewModel`. One login is one socket, and an
 * activity-scoped holder would hand a second attempt at the same provider back
 * the finished first one — a sheet that shows the last sign-in's outcome over a
 * connection that is already closed. This lives exactly as long as the sheet
 * does, and [close] takes the socket with it.
 */
class CredentialLoginViewModel(
    val provider: ConnectableProvider,
    val authType: String,
    socketFactory: LoginSocketFactory,
    podId: String? = null,
    private val openUrl: UrlOpener = NoUrlOpener,
    private val serverHost: String? = RuntimeConfig.serverUrl,
    scope: CoroutineScope? = null,
) {

    private val ownsScope = scope == null
    private val scope = scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _state = MutableStateFlow(CredentialLoginState())
    val state: StateFlow<CredentialLoginState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<CredentialLoginEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<CredentialLoginEvent> = _events.asSharedFlow()

    /** True once a `done` frame arrived: nothing after it changes the outcome. */
    private var finished = false

    /** True once the reader cancelled: the close that follows is expected. */
    private var cancelled = false

    private val socket = socketFactory
        .create(providerId = provider.id, authType = authType, podId = podId)
        .apply {
            // OkHttp delivers on its reader thread, so every callback hops onto
            // this holder's scope before it touches state.
            onMessage = { message -> this@CredentialLoginViewModel.scope.launch { handle(message) } }
            onDisconnect = { error ->
                this@CredentialLoginViewModel.scope.launch { handleDisconnect(error) }
            }
        }

    init {
        this.scope.launch {
            socket.connect()
            if (socket.isConnected) _state.update { it.copy(connecting = false) }
        }
    }

    private fun handle(message: LoginServerMessage) {
        if (finished) return
        when (message) {
            is LoginServerMessage.Prompt -> _state.update {
                it.copy(connecting = false, prompt = message.prompt, error = null)
            }

            is LoginServerMessage.Event -> _state.update { current ->
                current.copy(connecting = false, events = append(current.events, message.event))
            }

            is LoginServerMessage.Done -> {
                val status = message.status
                if (message.ok && status != null) {
                    finished = true
                    _events.tryEmit(CredentialLoginEvent.Connected(status))
                    return
                }
                val failure = message.error ?: return
                val apiError = if (failure.code in CREDENTIAL_CODES) {
                    ApiError(
                        error = failure.code,
                        detail = buildJsonObject {
                            put("code", failure.code)
                            put("message", failure.message)
                            put("provider", provider.name)
                        },
                    )
                } else {
                    ApiError(error = failure.message)
                }
                _state.update {
                    it.copy(
                        connecting = false,
                        prompt = null,
                        error = FriendlyError.message(apiError, serverHost),
                    )
                }
            }
        }
    }

    /**
     * A progress line replaces the last one rather than stacking: the provider
     * reports the same step advancing, and a growing column of near-identical
     * sentences buries the prompt underneath it.
     */
    private fun append(events: List<LoginEvent>, event: LoginEvent): List<LoginEvent> {
        if (event is LoginEvent.Progress && events.lastOrNull() is LoginEvent.Progress) {
            return events.dropLast(1) + event
        }
        return events + event
    }

    private fun handleDisconnect(error: Throwable?) {
        if (finished || cancelled) return
        _state.update {
            it.copy(
                connecting = false,
                prompt = null,
                error = FriendlyError.message(
                    error ?: ApiError(error = "The sign-in connection closed before it finished."),
                    serverHost,
                ),
            )
        }
    }

    fun respond(value: String) {
        val prompt = _state.value.prompt ?: return
        val sent = socket.respond(id = prompt.id, value = value)
        _state.update {
            if (sent) {
                it.copy(prompt = null, error = null)
            } else {
                it.copy(error = "Could not send the sign-in response. Try connecting again.")
            }
        }
    }

    fun cancel() {
        cancelled = true
        socket.cancel()
        _events.tryEmit(CredentialLoginEvent.Dismissed)
    }

    /**
     * Opens a link the provider sent.
     *
     * An unsafe URL is dropped without a word: the socket already refused to
     * decode one, so anything reaching here is a client bug rather than
     * something the reader can act on.
     */
    fun open(url: String) {
        if (!isSafeLoginUrl(url)) return
        scope.launch {
            if (openUrl.open(url)) return@launch
            _state.update {
                it.copy(error = "Could not open that sign-in page. Copy the URL instead.")
            }
        }
    }

    /** Closes the socket, and the scope when this holder created it. */
    fun close() {
        socket.disconnect(notify = false)
        if (ownsScope) scope.cancel()
    }

    private companion object {
        /**
         * Failures the friendly-error mapping has provider-specific copy for.
         * Everything else is already a sentence and travels as one.
         */
        val CREDENTIAL_CODES = setOf(
            "credential_reconnect_required",
            "credential_temporarily_unavailable",
            "credential_provider_unsupported",
            "client_upgrade_required",
        )
    }
}
