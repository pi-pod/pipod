package com.pipod.app.features.templates

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.features.common.RefreshJob
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Everything the environments list draws. */
data class TemplateListState(
    val templates: List<PodTemplate> = emptyList(),
    val unsupportedTemplateCount: Int = 0,
    val isLoading: Boolean = true,
    val loadError: String? = null,
) {
    val showsInitialSpinner: Boolean get() = isLoading && templates.isEmpty()

    val showsEmptyState: Boolean get() = templates.isEmpty() && unsupportedTemplateCount == 0
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
}
