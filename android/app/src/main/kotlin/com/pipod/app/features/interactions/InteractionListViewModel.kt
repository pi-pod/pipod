package com.pipod.app.features.interactions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.session.SessionNotifications
import com.pipod.app.features.common.RefreshJob
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Everything the approvals list draws. */
data class InteractionListState(
    val interactions: List<PendingInteraction> = emptyList(),
    val unsupportedCount: Int = 0,
    val isLoading: Boolean = true,
    val error: String? = null,
) {
    /** The first load, which has nothing to show underneath it yet. */
    val showsInitialSpinner: Boolean get() = isLoading && interactions.isEmpty()

    val showsEmptyState: Boolean get() = interactions.isEmpty() && unsupportedCount == 0
}

/**
 * The approvals list's state machine, ported from `InteractionListView` in
 * `pi-pod-flutter/lib/features/interactions/interaction_list_view.dart`.
 *
 * The Dart view holds two stream subscriptions for the whole time it is
 * mounted; here they live for as long as the view model, so an approval
 * answered inside a session still clears this list while the tab is off screen.
 *
 * @param onPendingCountChanged reports the number of rows still waiting, which
 *   is what drives the launcher badge and the pods tab's approvals chip.
 */
class InteractionListViewModel(
    private val repository: InteractionRepository,
    private val serverHost: String? = RuntimeConfig.serverUrl,
    private val onPendingCountChanged: (Int) -> Unit = {},
) : ViewModel() {

    private val _state = MutableStateFlow(InteractionListState())
    val state: StateFlow<InteractionListState> = _state.asStateFlow()

    // The pull gesture, the Refresh action, ON_RESUME and an arriving
    // `interaction_pending` all ask for the same list; only one of them reads it.
    private val refreshing = RefreshJob(viewModelScope)

    init {
        viewModelScope.launch {
            SessionNotifications.interactionResolved.stream.collect { removeResolved(it.id) }
        }
        viewModelScope.launch {
            // A new request arriving anywhere in the fleet is the one moment the
            // list is certainly stale.
            SessionNotifications.interactionPending.stream.collect {
                refreshing.await { refreshNow() }
            }
        }
        refresh()
    }

    fun refresh() {
        refreshing.start { refreshNow() }
    }

    /**
     * A failure keeps the last good list: what the reader last saw is still the
     * best information available, and blanking it to show an error throws that
     * away for no gain.
     */
    private suspend fun refreshNow() {
        _state.update { it.copy(isLoading = true) }
        try {
            val interactions = repository.interactions()
            _state.update {
                it.copy(
                    interactions = interactions.items,
                    unsupportedCount = interactions.unparsedRows.size,
                    error = null,
                )
            }
            onPendingCountChanged(interactions.items.size)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            _state.update { it.copy(error = FriendlyError.message(error, serverHost)) }
        } finally {
            _state.update { it.copy(isLoading = false) }
        }
    }

    /** Drops a row answered elsewhere — another device, or a live session. */
    fun removeResolved(id: String) {
        val current = _state.value.interactions
        if (current.none { it.id == id }) return
        val remaining = current.filterNot { it.id == id }
        _state.update { it.copy(interactions = remaining) }
        onPendingCountChanged(remaining.size)
    }

    /**
     * Deep link: refresh, then report whether the target is present.
     *
     * Null means the notification outlived the request. The caller only says so
     * out loud when [InteractionListState.error] is null — after a failed
     * refresh "no longer pending" would be a guess, not a fact.
     */
    suspend fun openTarget(id: String): PendingInteraction? {
        // Joins the refresh already running rather than starting a second one:
        // the answer to "is this still pending" is whatever that read returns.
        refreshing.await { refreshNow() }
        return _state.value.interactions.firstOrNull { it.id == id }
    }
}
