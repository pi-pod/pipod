package com.pipod.app.features.pods

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.WorkstationDemand
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.workstation.WorkstationStatusSource
import com.pipod.app.core.workstation.WorkstationWaitOutcome
import com.pipod.app.core.workstation.WorkstationWaitSession
import com.pipod.app.core.workstation.WorkstationWaitState
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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Everything the pod detail draws. */
data class PodDetailState(
    val pod: Pod? = null,
    val templateName: String? = null,
    val templateChecked: Boolean = false,
    val error: String? = null,
    /** `archive` / `restore` / `stop` / `cancel-wait` while one is in flight. */
    val workingCommand: String? = null,
    val isDeleting: Boolean = false,
    val notFound: Boolean = false,
    /**
     * A refresh the reader asked for, which is the only kind that may spin.
     * The 4-second poll behind a starting pod deliberately does not set it: an
     * indicator that reappears by itself reads as the screen being stuck.
     */
    val isRefreshing: Boolean = false,
    /** Live children a cascade delete would take with this pod. */
    val cascadeBlockers: List<CascadeChild> = emptyList(),
    /**
     * The reader's own personal workstation, when this pod's own request found
     * it not ready. Distinct from [Pod.capacityWait], which is fleet pressure on
     * the self-hosted backend, and from an asleep pod, which wakes in seconds.
     */
    val workstationWait: WorkstationWaitState? = null,
) {

    /**
     * What the Environment row says. A template that could not be read keeps
     * [templateName] null so the row can say it was deleted rather than leaking
     * a raw id at the reader.
     */
    val templateLabel: String
        get() = templateName ?: when {
            pod?.templateId == null -> "None (empty pod)"
            templateChecked -> "Deleted environment"
            else -> "Loading…"
        }

    val isLoading: Boolean get() = pod == null && error == null && !notFound

    /**
     * Whether stopping the sandbox is something this pod can be asked to do.
     * The server refuses anything but a started sandbox on an active pod, so
     * the action is only offered where it would be accepted.
     */
    val canStopSandbox: Boolean
        get() = pod?.isLive == true && pod.sandboxState == "started" && !isDeleting
}

/** One live child pod a delete refuses to orphan. */
data class CascadeChild(val id: String, val name: String)

/** Something that happened once, rather than a state the screen can re-read. */
sealed interface PodDetailEvent {
    data class Toast(val message: String) : PodDetailEvent

    /** The pod is gone; the screen it was pushed onto has to go with it. */
    data object Deleted : PodDetailEvent
}

/**
 * The pod detail's state machine, ported from
 * `pi-pod-flutter/lib/features/pods/pod_detail_view.dart`.
 */
class PodDetailViewModel(
    private val repository: PodRepository,
    val podId: String,
    initialPod: Pod? = null,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(
        // A malformed id can only ever 404, so it is answered here rather than
        // after a round trip that tells the reader nothing new.
        if (isUuid(podId)) {
            PodDetailState(pod = initialPod)
        } else {
            PodDetailState(notFound = true)
        },
    )
    val state: StateFlow<PodDetailState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<PodDetailEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<PodDetailEvent> = _events.asSharedFlow()

    private val workstationWait = WorkstationWaitSession(
        status = WorkstationStatusSource { repository.workstation(it) },
        onState = { wait -> _state.update { it.copy(workstationWait = wait) } },
    )

    /**
     * One read at a time. The pull gesture, the Refresh action and the
     * 4-second initializing tick all ask for the same thing, and two reads in
     * flight together settle in either order — the slower one wins and the
     * screen shows the older pod.
     */
    private val refreshing = RefreshJob(viewModelScope)

    init {
        if (!_state.value.notFound) load()
    }

    /** The pod, then the name of the environment it was launched from. */
    fun load() {
        viewModelScope.launch {
            refreshing.await { refreshNow() }
            loadTemplateName()
        }
    }

    /**
     * The pull-to-refresh and the Refresh action.
     *
     * It also re-attempts an environment name that never resolved: the first
     * read can fail on a dropped connection, and without a retry the row would
     * claim the environment was deleted for the rest of the screen's life.
     */
    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(isRefreshing = true) }
            try {
                refreshing.await { refreshNow() }
                if (!_state.value.templateChecked) loadTemplateName()
            } finally {
                _state.update { it.copy(isRefreshing = false) }
            }
        }
    }

    /** The 4-second tick, which only costs a request while the pod is starting. */
    fun pollIfInitializing() {
        // A live wait is already re-issuing this exact request on its own
        // schedule and saying so on the card; polling underneath it would start
        // a second wait every four seconds. A finished one was ended by the
        // reader or by the budget, and a tick must not quietly start it again —
        // the card's own Try again is how a stopped wait resumes.
        if (_state.value.workstationWait != null) return
        if (_state.value.pod?.initializing == true) {
            // Not [refresh]: a spinner nobody pulled for reads as a stuck screen.
            refreshing.start { refreshNow() }
        }
    }

    private suspend fun refreshNow() {
        try {
            val pod = repository.pod(podId)
            // The pod arrived on its own, so a wait still polling for it is
            // background noise nobody can see — and would go on re-issuing this
            // request for the rest of its budget.
            workstationWait.finish()
            _state.update { it.copy(pod = pod, error = null, workstationWait = null) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            if (isNotFound(error)) {
                _state.update { it.copy(pod = null, error = null, notFound = true) }
                return
            }
            // The workstation starting is not this pod failing to load: it keeps
            // every workspace, and the same request later reaches the same pod.
            val demand = WorkstationDemand.fromThrowable(error)
            if (demand == null) {
                _state.update {
                    it.copy(
                        error = "Could not refresh pod status: " +
                            FriendlyError.message(error, serverHost),
                    )
                }
                return
            }
            beginWorkstationWait(demand)
        }
    }

    /**
     * Hands the pod read to the wait, which owns the screen from here.
     *
     * Deliberately *not* awaited by the caller: a wait runs for up to 30
     * minutes, and the read that started it holds the pull-to-refresh spinner
     * and, on the command path, the disabled action row. Both would then sit
     * there for the whole budget on top of a card that already explains the
     * situation. The wait publishes its own progress, and
     * [WorkstationWaitSession] supersedes rather than stacks, so a later refresh
     * replaces this wait instead of joining a queue of them.
     */
    private fun beginWorkstationWait(demand: WorkstationDemand) {
        // Published before the coroutine starts so the card is up on this frame
        // and the initializing tick above can already see it.
        _state.update { it.copy(workstationWait = WorkstationWaitState(demand)) }
        viewModelScope.launch {
            when (val outcome = workstationWait.runFor(demand) { repository.pod(podId) }) {
                is WorkstationWaitOutcome.Ready -> _state.update {
                    it.copy(pod = outcome.value, error = null)
                }

                is WorkstationWaitOutcome.Failed -> _state.update {
                    it.copy(
                        error = "Could not refresh pod status: " +
                            FriendlyError.message(outcome.error, serverHost),
                    )
                }

                else -> Unit
            }
        }
    }

    private suspend fun loadTemplateName() {
        val templateId = _state.value.pod?.templateId ?: return
        try {
            val template = repository.template(templateId)
            _state.update { it.copy(templateName = template.name, templateChecked = true) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            // Only a real 404 settles the question. A missing environment keeps
            // templateName null so the row can say it was deleted; a dropped
            // connection leaves the row unresolved so the next refresh asks
            // again rather than accusing the server of deleting it.
            if (error is ApiError && error.transportStatus == 404) {
                _state.update { it.copy(templateChecked = true) }
            }
        }
    }

    /** Ends this app's wait. The workstation keeps starting on the server. */
    fun cancelWorkstationWait() = workstationWait.cancel()

    /** Drops a finished wait's resting card and asks the server again. */
    fun retryAfterWorkstationWait() {
        workstationWait.clear()
        refresh()
    }

    /** `archive`, `restore` or `stop`. */
    fun runCommand(command: String) {
        viewModelScope.launch {
            _state.update { it.copy(workingCommand = command, error = null) }
            try {
                val pod = repository.command(podId, command)
                _state.update { it.copy(pod = pod) }
                // Archive/restore otherwise signals only through the status row
                // changing, which is easy to miss on a slow connection.
                when (command) {
                    "archive" -> emit(PodDetailEvent.Toast("Pod archived."))
                    "restore" -> emit(PodDetailEvent.Toast("Pod restored."))
                    STOP -> emit(PodDetailEvent.Toast("Sandbox stopping. Compute is released."))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                // The action is over the moment it failed: leaving "Archiving
                // pod…" on a disabled row while the re-read waits on the
                // workstation would hold every action for the whole budget.
                _state.update { it.copy(workingCommand = null) }
                refreshing.await { refreshNow() }
                _state.update {
                    it.copy(
                        error = "The pod action failed: " +
                            FriendlyError.message(error, serverHost),
                    )
                }
            } finally {
                _state.update { it.copy(workingCommand = null) }
            }
        }
    }

    /**
     * Ends a bounded capacity wait cooperatively, keeping the pod row.
     *
     * The waiter observes the cancel on its next heartbeat, so the toast reports
     * the request — not the outcome — until a refresh confirms it.
     */
    fun cancelCapacityWait() {
        viewModelScope.launch {
            _state.update { it.copy(workingCommand = CANCEL_WAIT, error = null) }
            try {
                val cancelled = repository.cancelCapacityWait(podId)
                emit(
                    PodDetailEvent.Toast(
                        if (cancelled) "Cancellation requested." else "No capacity wait to cancel.",
                    ),
                )
                _state.update { it.copy(workingCommand = null) }
                refreshing.await { refreshNow() }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update { it.copy(workingCommand = null) }
                refreshing.await { refreshNow() }
                _state.update {
                    it.copy(
                        error = "Could not cancel the capacity wait: " +
                            FriendlyError.message(error, serverHost),
                    )
                }
            } finally {
                _state.update { it.copy(workingCommand = null) }
            }
        }
    }

    /**
     * Deletes the pod, or reports the live children that stand in the way.
     *
     * The server refuses to orphan a co-located child: without [cascade] a pod
     * with live children answers 409 and names them. That is a question for the
     * reader ("take these down too?"), not an error, so it becomes
     * [PodDetailState.cascadeBlockers] rather than a line of raw server prose.
     */
    fun delete(cascade: Boolean = false) {
        viewModelScope.launch {
            _state.update { it.copy(isDeleting = true, error = null, cascadeBlockers = emptyList()) }
            try {
                repository.delete(podId, cascade = cascade)
                emit(PodDetailEvent.Deleted)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                val children = liveChildrenOf(error)
                if (children.isNotEmpty()) {
                    _state.update { it.copy(isDeleting = false, cascadeBlockers = children) }
                    return@launch
                }
                _state.update {
                    it.copy(
                        isDeleting = false,
                        error = "Could not delete this pod: " +
                            FriendlyError.message(error, serverHost),
                    )
                }
            }
        }
    }

    /** The reader answered the cascade question with "no". */
    fun dismissCascadePrompt() {
        _state.update { it.copy(cascadeBlockers = emptyList()) }
    }

    private fun emit(event: PodDetailEvent) {
        _events.tryEmit(event)
    }

    companion object {
        const val CANCEL_WAIT = "cancel-wait"
        const val STOP = "stop"

        /**
         * The children named by a refused delete, or empty for any other
         * failure. Matching on the 409 plus the `detail` array keeps a
         * differently-worded conflict from being read as a cascade offer.
         */
        internal fun liveChildrenOf(error: Throwable): List<CascadeChild> {
            if (error !is ApiError || error.transportStatus != 409) return emptyList()
            val rows = error.detail as? JsonArray ?: return emptyList()
            return rows.mapNotNull { row ->
                val child = row as? JsonObject ?: return@mapNotNull null
                val id = (child["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    ?: return@mapNotNull null
                val name = (child["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                CascadeChild(id = id, name = name?.trim()?.takeIf { it.isNotEmpty() } ?: id)
            }
        }

        private val UUID = Regex(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            RegexOption.IGNORE_CASE,
        )

        internal fun isUuid(value: String): Boolean = UUID.matches(value)

        /**
         * Whether the server said this pod is not this reader's to see.
         *
         * Forbidden and not-found are one answer on purpose: telling somebody a
         * pod exists but is not theirs is itself a disclosure.
         */
        internal fun isNotFound(error: Throwable): Boolean {
            // The status the transport received is the fact; the prose is a
            // guess. A 403 whose body only says "requires pods:manage_any"
            // never matched the words below and landed on the reader raw, and
            // a 500 that happens to mention "not found" is a server fault, not
            // a missing pod — so an ApiError is answered by its status alone.
            if (error is ApiError) {
                error.transportStatus?.let { return it == 403 || it == 404 }
            }
            val description = when (error) {
                is ApiError -> "${error.error} ${error.detailText ?: error.detail ?: ""}"
                else -> error.toString()
            }.lowercase()
            return description.contains("http 403") ||
                description.contains("http 404") ||
                description.contains("forbidden") ||
                description.contains("not found")
        }

        /** The wording for the action currently in flight. */
        fun actionLabel(command: String): String = when (command) {
            "restore" -> "Restoring pod…"
            "archive" -> "Archiving pod…"
            STOP -> "Stopping sandbox…"
            CANCEL_WAIT -> "Cancelling capacity wait…"
            else -> "Updating pod…"
        }
    }
}
