package com.pipod.app.features.templates

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.features.common.RefreshJob
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Everything the environments list draws. */
data class TemplateListState(
    val templates: List<PodTemplate> = emptyList(),
    val unsupportedTemplateCount: Int = 0,
    val deletingIds: Set<String> = emptySet(),
    val isLoading: Boolean = true,
    val loadError: String? = null,
) {
    val showsInitialSpinner: Boolean get() = isLoading && templates.isEmpty()

    val showsEmptyState: Boolean get() = templates.isEmpty() && unsupportedTemplateCount == 0

    fun isDeleting(id: String): Boolean = id in deletingIds
}

/** A failure the reader has to acknowledge before carrying on. */
sealed interface TemplateListEvent {
    data class Notice(val message: String) : TemplateListEvent
}

/**
 * The environments list's state machine, ported from `TemplateListView` in
 * `pi-pod-flutter/lib/features/templates/template_list_view.dart`.
 */
class TemplateListViewModel(
    private val repository: TemplateRepository,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(TemplateListState())
    val state: StateFlow<TemplateListState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<TemplateListEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<TemplateListEvent> = _events.asSharedFlow()

    /** One read at a time: two overlapping ones can settle in either order. */
    private val refreshing = RefreshJob(viewModelScope)

    init {
        refresh()
    }

    fun refresh() {
        refreshing.start { refreshNow() }
    }

    private suspend fun refreshNow() {
        _state.update { it.copy(isLoading = true) }
        try {
            val templates = repository.templates()
            _state.update {
                it.copy(
                    templates = templates.items,
                    unsupportedTemplateCount = templates.unparsedRows.size,
                    loadError = null,
                )
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            _state.update { it.copy(loadError = FriendlyError.message(error, serverHost)) }
        } finally {
            _state.update { it.copy(isLoading = false) }
        }
    }

    /**
     * Removes the row optimistically once the server has accepted the delete,
     * so the list does not wait on a second round trip to reflect it.
     */
    fun delete(template: PodTemplate) {
        viewModelScope.launch {
            _state.update { it.copy(deletingIds = it.deletingIds + template.id) }
            try {
                repository.delete(template.id)
                _state.update { current ->
                    current.copy(templates = current.templates.filterNot { it.id == template.id })
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _events.tryEmit(
                    TemplateListEvent.Notice(
                        "Could not delete ${template.name}: " +
                            FriendlyError.message(error, serverHost),
                    ),
                )
                refreshNow()
            } finally {
                _state.update { it.copy(deletingIds = it.deletingIds - template.id) }
            }
        }
    }
}
