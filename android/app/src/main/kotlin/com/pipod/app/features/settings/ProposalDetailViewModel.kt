package com.pipod.app.features.settings

import androidx.compose.runtime.Composable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.SettingsLayer
import com.pipod.app.core.api.model.SettingsProposal
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Everything the proposal detail draws. */
data class ProposalDetailState(
    /** The layer the proposal would replace, for the current-beside-proposed view. */
    val current: SettingsLayer? = null,
    val isLoadingCurrent: Boolean = true,
    /**
     * Why the current settings could not be read. Its own field rather than
     * [errorMessage]: the recovery is Try again, and it belongs beside the
     * comparison that is missing rather than beside the actions.
     */
    val currentError: String? = null,
    val isWorking: Boolean = false,
    val errorMessage: String? = null,
    /** Non-null once applied: the names the reader now owes values for. */
    val appliedSecretNames: List<String>? = null,
) {
    /**
     * Applying replaces the current settings, so there is nothing to approve
     * until the reader can see what is being replaced.
     */
    val canApply: Boolean get() = !isWorking && current != null
}

/** What the screen does rather than draws once a proposal is resolved. */
sealed interface ProposalDetailEvent {
    data object Applied : ProposalDetailEvent
    data object Rejected : ProposalDetailEvent

    /**
     * Somebody else answered this proposal first. There is nothing left to do
     * here, so the screen says so and leaves rather than offering an Apply that
     * will fail the same way again.
     */
    data class AlreadyResolved(val message: String) : ProposalDetailEvent
}

/**
 * The proposal detail's state machine, ported from `ProposalDetailView` in
 * `pi-pod-flutter/lib/features/settings/settings_proposals_view.dart`.
 */
class ProposalDetailViewModel(
    val proposal: SettingsProposal,
    private val repository: SettingsRepository,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(ProposalDetailState())
    val state: StateFlow<ProposalDetailState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<ProposalDetailEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<ProposalDetailEvent> = _events.asSharedFlow()

    init {
        viewModelScope.launch { loadCurrent() }
    }

    fun loadCurrent() {
        viewModelScope.launch { loadCurrentNow() }
    }

    private suspend fun loadCurrentNow() {
        _state.update { it.copy(isLoadingCurrent = true, currentError = null) }
        try {
            _state.update { it.copy(current = repository.currentSettings(proposal)) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            _state.update {
                it.copy(
                    currentError = "Could not load current settings: " +
                        FriendlyError.message(error, serverHost),
                )
            }
        } finally {
            _state.update { it.copy(isLoadingCurrent = false) }
        }
    }

    /**
     * Applies the proposal and stays put.
     *
     * The reader is not returned to the list, because applying is only half the
     * job: the secret names the server hands back are values only they can
     * supply, and popping would take the list of them off screen.
     */
    fun applyProposal() {
        viewModelScope.launch {
            _state.update { it.copy(isWorking = true, errorMessage = null) }
            try {
                val names = repository.applyProposal(proposal.id)
                _state.update { it.copy(appliedSecretNames = names) }
                _events.tryEmit(ProposalDetailEvent.Applied)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                reportFailure(error, APPLY_CONFLICT)
            } finally {
                _state.update { it.copy(isWorking = false) }
            }
        }
    }

    fun rejectProposal() {
        viewModelScope.launch {
            _state.update { it.copy(isWorking = true, errorMessage = null) }
            try {
                repository.rejectProposal(proposal.id)
                _events.tryEmit(ProposalDetailEvent.Rejected)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                reportFailure(error, REJECT_CONFLICT)
            } finally {
                _state.update { it.copy(isWorking = false) }
            }
        }
    }

    /**
     * A 409 is not a failure to retry: the proposal is no longer pending, so
     * this screen has nothing left to offer. The list behind it is stale too,
     * which is what [ProposalDetailEvent.AlreadyResolved] tells the caller.
     */
    private fun reportFailure(error: Throwable, conflictMessage: String) {
        if (error is ApiError && error.transportStatus == 409) {
            _state.update { it.copy(errorMessage = conflictMessage) }
            _events.tryEmit(ProposalDetailEvent.AlreadyResolved(conflictMessage))
            return
        }
        _state.update { it.copy(errorMessage = FriendlyError.message(error, serverHost)) }
    }

    companion object {
        const val APPLY_CONFLICT: String =
            "This proposal was already answered somewhere else, so nothing was applied. " +
                "The proposals list has been refreshed."

        const val REJECT_CONFLICT: String =
            "This proposal was already answered somewhere else, so nothing was rejected. " +
                "The proposals list has been refreshed."
    }
}

/**
 * One view model per proposal, kept across recompositions of the settings
 * screen that opened it.
 *
 * Keyed by the proposal id so opening a second proposal is a second state
 * machine rather than the first one silently pointed at new data.
 */
@Composable
fun rememberProposalDetailViewModel(
    proposal: SettingsProposal,
    repository: SettingsRepository,
    serverHost: String? = RuntimeConfig.serverUrl,
): ProposalDetailViewModel = viewModel(
    key = "proposal-${proposal.id}",
    factory = viewModelFactory {
        initializer {
            ProposalDetailViewModel(
                proposal = proposal,
                repository = repository,
                serverHost = serverHost,
            )
        }
    },
)
