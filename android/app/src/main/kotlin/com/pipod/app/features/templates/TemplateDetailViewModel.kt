package com.pipod.app.features.templates

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.EnvironmentEditorData
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
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Everything the environment detail draws, including the secret being typed. */
data class TemplateDetailState(
    val template: PodTemplate,
    val editorData: EnvironmentEditorData? = null,
    val secrets: List<SecretMeta> = emptyList(),
    val unsupportedSecretCount: Int = 0,
    val secretName: String = "",
    val secretValue: String = "",
    val isSavingSecret: Boolean = false,
    val isDeleting: Boolean = false,
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

/** The environment is gone; the screen it was pushed onto has to go with it. */
sealed interface TemplateDetailEvent {
    data object Deleted : TemplateDetailEvent

    /** The environment changed, so a list behind this screen is now stale. */
    data object Changed : TemplateDetailEvent
}

/**
 * The environment detail's state machine, ported from `TemplateDetailView` in
 * `pi-pod-flutter/lib/features/templates/template_list_view.dart`.
 */
class TemplateDetailViewModel(
    private val repository: TemplateRepository,
    template: PodTemplate,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(TemplateDetailState(template = template))
    val state: StateFlow<TemplateDetailState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<TemplateDetailEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<TemplateDetailEvent> = _events.asSharedFlow()

    /** One read at a time: the secrets and the editor data settle together. */
    private val refreshing = RefreshJob(viewModelScope)

    init {
        refresh()
    }

    /**
     * Reloads the secrets and the editor data together, so the detail cannot go
     * stale behind a backgrounded app.
     */
    fun refresh() {
        refreshing.start {
            _state.update { it.copy(isRefreshing = true) }
            try {
                coroutineScope {
                    listOf(
                        async { refreshSecrets() },
                        async { refreshEditorData() },
                    ).awaitAll()
                }
            } finally {
                _state.update { it.copy(isRefreshing = false) }
            }
        }
    }

    /**
     * Adopts a fresher copy of the same environment and re-reads its detail.
     *
     * The route used to force this by putting a revision counter in the
     * `viewModel` key, which minted a new view model — and retained the old one,
     * with its scope, for the life of the tab — on every save. Saying "reload"
     * out loud is both cheaper and clearer about what is meant.
     */
    fun reload(template: PodTemplate) {
        if (_state.value.template == template) return
        _state.update { it.copy(template = template) }
        refresh()
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

    private suspend fun refreshEditorData(): EnvironmentEditorData? {
        return try {
            val data = repository.editorData(_state.value.template.id)
            _state.update { it.copy(editorData = data) }
            data
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            show(FriendlyError.message(error, serverHost), isError = true)
            null
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

    fun deleteTemplate() {
        viewModelScope.launch {
            _state.update { it.copy(isDeleting = true) }
            try {
                repository.delete(_state.value.template.id)
                _events.tryEmit(TemplateDetailEvent.Changed)
                _events.tryEmit(TemplateDetailEvent.Deleted)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                show(FriendlyError.message(error, serverHost), isError = true)
                _state.update { it.copy(isDeleting = false) }
            }
        }
    }

    /** Folds an edit made in the editor back into this screen. */
    fun onSaved(template: PodTemplate, editorData: EnvironmentEditorData) {
        _state.update { it.copy(template = template, editorData = editorData) }
        show("Environment updated.", isError = false)
        _events.tryEmit(TemplateDetailEvent.Changed)
    }

    /** The editor data the editor needs, fetched now if the first load failed. */
    suspend fun editorDataForEditing(): EnvironmentEditorData? =
        _state.value.editorData ?: refreshEditorData()


    private fun show(message: String, isError: Boolean) {
        _state.update { it.copy(message = message, messageIsError = isError) }
    }
}
