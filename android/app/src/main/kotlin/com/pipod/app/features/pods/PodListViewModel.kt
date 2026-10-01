package com.pipod.app.features.pods

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.BillingSummary
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.api.model.PodsPage
import com.pipod.app.core.api.model.WorkstationDemand
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.format.PodFilter
import com.pipod.app.core.format.PodFilterEnvironment
import com.pipod.app.core.format.PodFilterProject
import com.pipod.app.core.format.PodFilterStatus
import com.pipod.app.core.format.PodGroup
import com.pipod.app.core.format.attentionFirst
import com.pipod.app.core.format.groupPods
import com.pipod.app.core.workstation.WorkstationStatusSource
import com.pipod.app.core.workstation.WorkstationWaitOutcome
import com.pipod.app.core.workstation.WorkstationWaitSession
import com.pipod.app.core.workstation.WorkstationWaitState
import com.pipod.app.features.common.RefreshJob
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Everything the pod list draws, as one immutable snapshot.
 *
 * The grouping, filtering and hidden-status arithmetic are properties rather
 * than stored fields: they are pure functions of the pods and the filter, and
 * storing them would give the screen a second copy that can disagree with the
 * one the tests assert on.
 */
data class PodListState(
    val pods: List<Pod> = emptyList(),
    val templates: List<PodTemplate> = emptyList(),
    val unsupportedPodCount: Int = 0,
    val isLoading: Boolean = true,
    val loadError: String? = null,
    val filter: PodFilter = PodFilter(),
    val currentUserId: String? = null,
    /**
     * The account summary the pods envelope carried. Null on the self-hosted
     * static backend, which sends the key in neither place.
     */
    val envelopeBilling: BillingSummary? = null,
    /** The same object as it arrived on `/v1/me`, when the envelope had none. */
    val accountBilling: BillingSummary? = null,
    /**
     * The reader's own personal workstation, when a refresh found it not ready.
     * Never a fleet-capacity wait and never a pod tombstone.
     */
    val workstationWait: WorkstationWaitState? = null,
) {

    /**
     * What the account row draws. The envelope wins when it carried one, so a
     * server that moves the key does not make the row disagree with itself.
     */
    val billing: BillingSummary? get() = envelopeBilling ?: accountBilling

    val visibleGroups: List<PodGroup>
        get() = attentionFirst(groupPods(filter.apply(pods, currentUserId = currentUserId)))

    val visiblePods: List<Pod> get() = visibleGroups.flatMap { it.members }

    /** Location is noise when every visible pod lives in the same place. */
    val showsLocation: Boolean
        get() {
            val visible = visiblePods
            return visible.mapTo(mutableSetOf()) { it.displayLocation }.size > 1 ||
                visible.any { it.isHostChild }
        }

    /** Pods the status filter is holding back, which the list offers to disclose. */
    val hiddenByStatus: List<Pod>
        get() {
            val shown = visiblePods.mapTo(mutableSetOf()) { it.id }
            return filter.copy(status = PodFilterStatus.All)
                .apply(pods, currentUserId = currentUserId)
                .filter { it.id !in shown }
        }

    val hiddenBreakdown: String? get() = PodFilter.statusBreakdown(hiddenByStatus)

    val projects: List<String> get() = PodFilter.projects(pods)

    val environments: List<PodFilterEnvironment> get() = PodFilter.environments(pods, templates)

    val hasUnassignedProject: Boolean get() = pods.any { it.projectName == null }

    val hasNoEnvironment: Boolean get() = pods.any { it.templateId == null }

    /** Only worth offering when the list actually mixes owners. */
    val showsOwnerFilter: Boolean
        get() {
            val me = currentUserId ?: return false
            return pods.any { it.userId == me } && pods.any { it.userId != me }
        }

    val showsOwnerMetadata: Boolean get() = pods.mapTo(mutableSetOf()) { it.userId }.size > 1

    /**
     * The first-run / load-failure column stands in for the whole list.
     *
     * Never while a workstation wait is up: the card above already says why
     * there is nothing here, and “No pods yet” under it would contradict it.
     */
    val showsEmptyState: Boolean
        get() = pods.isEmpty() && unsupportedPodCount == 0 && workstationWait == null

    val showsInitialSpinner: Boolean get() = isLoading && pods.isEmpty() && workstationWait == null

    /** Something is loaded, but the current filter matches none of it. */
    val showsNoMatches: Boolean get() = pods.isNotEmpty() && visiblePods.isEmpty()

    /** Whether a pod is still moving, which is what the 4-second poll is for. */
    val hasInitializingPod: Boolean get() = pods.any { it.initializing }
}

/**
 * The pod list's state machine, ported from the stateful half of
 * `pi-pod-flutter/lib/features/pods/pod_list_view.dart`.
 *
 * The Flutter view owns a `Timer.periodic` and an app-lifecycle observer. Both
 * are the screen's business in Compose — a poll should stop when the screen
 * leaves — so this class exposes [pollIfInitializing] and [refreshPods] and the
 * composable decides when to call them.
 */
class PodListViewModel(
    private val repository: PodRepository,
    currentUserId: String? = null,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(PodListState(currentUserId = currentUserId))
    val state: StateFlow<PodListState> = _state.asStateFlow()

    /**
     * The reader's own workstation, when listing pods found it not ready. The
     * wait re-issues the list request itself; the screen only draws what it says.
     */
    private val workstationWait = WorkstationWaitSession(
        status = WorkstationStatusSource { repository.workstation(it) },
        onState = { wait -> _state.update { it.copy(workstationWait = wait) } },
    )

    /**
     * Pull-to-refresh during the initializing poll — or two refresh taps — must
     * not stack requests: last-writer-wins ordering can briefly show older data
     * over newer.
     */
    private var refreshing = false

    /** One account read at a time, however many refreshes ask for one. */
    private val billingRefresh = RefreshJob(viewModelScope)

    init {
        refresh()
    }

    /** The full load: pods first, then the environment names the filter needs. */
    fun refresh() {
        refreshBilling()
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                refreshPodsNow()
                try {
                    val templates = repository.templates()
                    _state.update { it.copy(templates = templates.items) }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    // Environment loading must not hide a healthy pod list.
                }
            } finally {
                _state.update { it.copy(isLoading = false) }
            }
        }
    }

    /** Just the pods, for a poll tick or a return to the foreground. */
    fun refreshPods() {
        viewModelScope.launch { refreshPodsNow() }
    }

    /** The 4-second tick, which only costs a request while something is moving. */
    fun pollIfInitializing() {
        // A live wait re-issues this request on its own schedule; a finished one
        // was ended by the reader or by the budget. Neither may be restarted by
        // a timer behind the card that is saying so.
        if (_state.value.workstationWait != null) return
        if (_state.value.hasInitializingPod) refreshPods()
    }

    private suspend fun refreshPodsNow() {
        if (refreshing) return
        refreshing = true
        try {
            val page = repository.podsPage()
            // The list arrived on its own: a wait still polling for it would
            // keep re-issuing this request behind a screen that already has it.
            workstationWait.finish()
            apply(page)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            // A workstation that is not ready is the reader's own machine
            // starting, not a list that failed: it gets the wait, not a red tile.
            val demand = WorkstationDemand.fromThrowable(error)
            if (demand == null) {
                _state.update { it.copy(loadError = FriendlyError.message(error, serverHost)) }
                return
            }
            beginWorkstationWait(demand)
        } finally {
            refreshing = false
        }
    }

    /**
     * Hands the list read to the wait, which owns the top of the screen now.
     *
     * Not awaited by the caller on purpose: a wait can run for half an hour, and
     * holding [PodListState.isLoading] and the in-flight guard for that long is
     * what made pull-to-refresh and the card's own Try again silent no-ops — the
     * gesture flipped the spinner on and straight back off and nothing was
     * requested. Released, a later refresh reaches the session, which supersedes
     * this wait instead of stacking a second one behind it.
     */
    private fun beginWorkstationWait(demand: WorkstationDemand) {
        // Published before the coroutine starts so the card is up on this frame
        // and the initializing tick above can already see it.
        _state.update { it.copy(workstationWait = WorkstationWaitState(demand)) }
        viewModelScope.launch {
            when (val outcome = workstationWait.runFor(demand) { repository.podsPage() }) {
                is WorkstationWaitOutcome.Ready -> apply(outcome.value)
                is WorkstationWaitOutcome.Failed -> _state.update {
                    it.copy(loadError = FriendlyError.message(outcome.error, serverHost))
                }
                // Terminal, expired and cancelled all say so on the workstation
                // card, which is the only honest place for them.
                else -> Unit
            }
        }
    }

    private fun apply(page: PodsPage) {
        _state.update { current ->
            reconcileFilters(
                current.copy(
                    pods = page.pods.items,
                    unsupportedPodCount = page.pods.unparsedRows.size,
                    loadError = null,
                    envelopeBilling = page.billing,
                    workstationWait = null,
                ),
            )
        }
    }

    /** Ends this app's wait. The workstation keeps starting on the server. */
    fun cancelWorkstationWait() = workstationWait.cancel()

    /** Drops a finished wait's resting card and asks again. */
    fun retryAfterWorkstationWait() {
        workstationWait.clear()
        refreshPods()
    }

    fun setCurrentUserId(userId: String?) {
        if (_state.value.currentUserId == userId) return
        _state.update { it.copy(currentUserId = userId) }
    }

    /**
     * The account summary `/v1/me` carried, used when the pods envelope had
     * none. Absent on the self-hosted backend, where the row never appears.
     */
    fun setAccountBilling(billing: BillingSummary?) {
        if (_state.value.accountBilling == billing) return
        _state.update { it.copy(accountBilling = billing) }
    }

    /**
     * Re-reads `GET /v1/billing/account`.
     *
     * `/v1/me` is read at sign-in and at an organization switch, so without this
     * the hours, the cap and — the part that matters — whether starts are
     * blocked were frozen for the whole life of the app process. A cap that
     * tripped an hour ago would still read “ok” until the next launch 402'd.
     *
     * Absence stays absence: the self-hosted backend has no `/v1/billing` at
     * all, which answers 404, and a failed read leaves the last known summary
     * alone rather than blanking the row.
     */
    fun refreshBilling() {
        billingRefresh.start {
            val summary = try {
                repository.billingSummary()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                return@start
            } ?: return@start
            _state.update { it.copy(accountBilling = summary) }
        }
    }

    fun setSearch(search: String) {
        _state.update { it.copy(filter = it.filter.copy(search = search)) }
    }

    /** Applies what the filter sheet came back with. Search is not part of it. */
    fun applyFilter(filter: PodFilter) {
        _state.update {
            it.copy(
                filter = it.filter.copy(
                    status = filter.status,
                    project = filter.project,
                    environment = filter.environment,
                    onlyMine = filter.onlyMine,
                ),
            )
        }
    }

    /**
     * Back to the resting state. The search field shows and clears its own text,
     * so it is deliberately left alone.
     */
    fun clearFilters() {
        _state.update {
            it.copy(
                filter = it.filter.copy(
                    status = PodFilterStatus.Active,
                    project = PodFilterProject.Any,
                    environment = PodFilterEnvironment.Any,
                    onlyMine = false,
                ),
            )
        }
    }

    fun showAllStatuses() {
        _state.update { it.copy(filter = it.filter.copy(status = PodFilterStatus.All)) }
    }

    /**
     * Drops a filter whose subject the latest fetch no longer contains, so the
     * list cannot get stuck showing nothing because of a project that was
     * deleted while the screen was open.
     */
    private fun reconcileFilters(state: PodListState): PodListState {
        var filter = state.filter
        when (val project = filter.project) {
            PodFilterProject.Any -> Unit
            is PodFilterProject.Named ->
                if (project.name !in state.projects) {
                    filter = filter.copy(project = PodFilterProject.Any)
                }

            PodFilterProject.Unassigned ->
                if (!state.hasUnassignedProject) {
                    filter = filter.copy(project = PodFilterProject.Any)
                }
        }
        when (val environment = filter.environment) {
            PodFilterEnvironment.Any -> Unit
            // Re-resolved rather than kept: the environment list learns the real
            // name once the templates arrive, and the filter chip has to say it.
            is PodFilterEnvironment.Named -> filter = filter.copy(
                environment = state.environments.firstOrNull { it.templateId == environment.id }
                    ?: PodFilterEnvironment.Any,
            )

            PodFilterEnvironment.None ->
                if (!state.hasNoEnvironment) {
                    filter = filter.copy(environment = PodFilterEnvironment.Any)
                }
        }
        return if (filter == state.filter) state else state.copy(filter = filter)
    }
}
