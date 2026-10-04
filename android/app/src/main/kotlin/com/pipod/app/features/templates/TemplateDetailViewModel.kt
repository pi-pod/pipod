package com.pipod.app.features.templates

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.api.model.SecretMeta
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.format.SecretName
import com.pipod.app.features.common.RefreshJob
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Everything the environment detail draws, including the secret being typed. */
data class TemplateDetailState(
    val template: PodTemplate,
    val secrets: List<SecretMeta> = emptyList(),
    val unsupportedSecretCount: Int = 0,
    val secretName: String = "",
    val secretValue: String = "",
    val isSavingSecret: Boolean = false,
    /** A refresh the reader pulled for, which is the only kind that may spin. */
    val isRefreshing: Boolean = false,
    val message: String? = null,
    val messageIsError: Boolean = false,
) {
    /** An unsaved secret draft: leaving the screen would silently destroy it. */
    val hasSecretDraft: Boolean get() = secretName.isNotEmpty() || secretValue.isNotEmpty()

    /**
     * Every environment the server returns is active; there is no draft status
     * for it to be waiting in.
     */
    val statusLabel: String get() = "Active"

    val setupScriptFooter: String
        get() = "This runs with your secrets in every pod launched from this environment."
}

/**
 * The environment detail's state machine, ported from `TemplateDetailView` in
 * `pi-pod-flutter/lib/features/templates/template_list_view.dart`.
 *
 * The environment is only read; its secrets are the one thing written here.
 */
class TemplateDetailViewModel(
    private val repository: TemplateRepository,
    template: PodTemplate,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(TemplateDetailState(template = template))
    val state: StateFlow<TemplateDetailState> = _state.asStateFlow()

    /** One read at a time: the environment and its secrets settle together. */
    private val refreshing = RefreshJob(viewModelScope)

    init {
        refresh()
    }

    /**
     * Reloads the environment and its secrets together, so the detail cannot go
     * stale behind a backgrounded app or an edit made in the web dashboard.
     */
    fun refresh() {
        refreshing.start {
            _state.update { it.copy(isRefreshing = true) }
            try {
                coroutineScope {
                    listOf(
                        async { refreshTemplate() },
                        async { refreshSecrets() },
                    ).awaitAll()
                }
            } finally {
                _state.update { it.copy(isRefreshing = false) }
            }
        }
    }

    private suspend fun refreshTemplate() {
        try {
            val template = repository.template(_state.value.template.id)
            _state.update { it.copy(template = template) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            show(FriendlyError.message(error, serverHost), isError = true)
        }
    }

    private suspend fun refreshSecrets() {
        try {
            val secrets = repository.secrets(_state.value.template.id)
            _state.update {
                it.copy(
                    secrets = secrets.items,
                    unsupportedSecretCount = secrets.unparsedRows.size,
                )
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            show(FriendlyError.message(error, serverHost), isError = true)
        }
    }

    fun setSecretName(name: String) {
        _state.update { it.copy(secretName = name) }
    }

    fun setSecretValue(value: String) {
        _state.update { it.copy(secretValue = value) }
    }

    /** Drops the draft, which is what re-arms the leave-the-screen guard. */
    fun clearSecretDraft() {
        _state.update { it.copy(secretName = "", secretValue = "") }
    }

    fun saveSecret() {
        viewModelScope.launch {
            _state.update { it.copy(isSavingSecret = true) }
            try {
                repository.putSecret(
                    templateId = _state.value.template.id,
                    name = SecretName.normalized(_state.value.secretName),
                    value = _state.value.secretValue.trim(),
                )
                _state.update { it.copy(secretName = "", secretValue = "") }
                show("Secret saved. Its value can never be read back.", isError = false)
                refreshSecrets()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                show(FriendlyError.message(error, serverHost), isError = true)
            } finally {
                _state.update { it.copy(isSavingSecret = false) }
            }
        }
    }

    fun deleteSecret(secret: SecretMeta) {
        viewModelScope.launch {
            try {
                repository.deleteSecret(_state.value.template.id, secret.name)
                show("Secret deleted.", isError = false)
                refreshSecrets()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                show(FriendlyError.message(error, serverHost), isError = true)
            }
        }
    }

    private fun show(message: String, isError: Boolean) {
        _state.update { it.copy(message = message, messageIsError = isError) }
    }
}
