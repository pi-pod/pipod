package com.pipod.app.features.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.Job
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.Format
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.format.JobSchedule
import com.pipod.app.features.common.RefreshJob
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Everything the jobs list draws. */
data class JobListState(
    val jobs: List<Job> = emptyList(),
    val unsupportedJobCount: Int = 0,
    val deletingJobIds: Set<String> = emptySet(),
    val isLoading: Boolean = true,
    val loadError: String? = null,
) {
    /**
     * Soonest first. A job with no next run has nothing to be sooner than, so it
     * sorts to the end rather than to the front, where an unparseable or absent
     * timestamp would read as "about to fire".
     */
    val active: List<Job>
        get() = jobs.filter { it.isActive }.sortedWith(NEXT_RUN_FIRST)

    val paused: List<Job> get() = jobs.filter { it.isPaused }

    val completed: List<Job> get() = jobs.filter { it.isCompleted }

    val showsInitialSpinner: Boolean get() = isLoading && jobs.isEmpty()

    val showsEmptyState: Boolean get() = jobs.isEmpty() && unsupportedJobCount == 0

    fun isDeleting(id: String): Boolean = id in deletingJobIds

    private companion object {
        val NEXT_RUN_FIRST = Comparator<Job> { left, right ->
            val leftDate = left.nextRunAt?.let { Format.date(it) }
            val rightDate = right.nextRunAt?.let { Format.date(it) }
            when {
                leftDate == null && rightDate == null -> 0
                leftDate == null -> 1
                rightDate == null -> -1
                else -> leftDate.compareTo(rightDate)
            }
        }
    }
}

/** Something the reader has to acknowledge before carrying on. */
sealed interface JobListEvent {
    data class Notice(val title: String, val message: String) : JobListEvent
    data class Toast(val message: String) : JobListEvent
}

/**
 * The jobs list's state machine, ported from `JobsListView` in
 * `pi-pod-flutter/lib/features/jobs/jobs_list_view.dart`.
 */
class JobListViewModel(
    private val repository: JobRepository,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(JobListState())
    val state: StateFlow<JobListState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<JobListEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<JobListEvent> = _events.asSharedFlow()

    /** The pull gesture and a job changed elsewhere both want the same read. */
    private val refreshing = RefreshJob(viewModelScope)

    init {
        viewModelScope.launch {
            JobNotifications.changed.collect { refreshing.await { refreshNow() } }
        }
        refresh()
    }

    fun refresh() {
        refreshing.start { refreshNow() }
    }

    private suspend fun refreshNow() {
        _state.update { it.copy(isLoading = true) }
        try {
            val jobs = repository.jobs()
            _state.update {
                it.copy(
                    jobs = jobs.items,
                    unsupportedJobCount = jobs.unparsedRows.size,
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
     * Removes the row once the server has accepted the delete, so the list does
     * not wait on a second round trip to reflect it. A refused delete puts the
     * row back by re-reading, rather than by trusting what was on screen.
     */
    fun delete(job: Job) {
        viewModelScope.launch {
            _state.update { it.copy(deletingJobIds = it.deletingJobIds + job.id) }
            try {
                repository.delete(job.id)
                _state.update { current ->
                    current.copy(jobs = current.jobs.filterNot { it.id == job.id })
                }
                _events.tryEmit(JobListEvent.Toast("Job removed."))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _events.tryEmit(
                    JobListEvent.Notice(
                        title = "Something went wrong",
                        message = "Could not delete ${job.name}: " +
                            FriendlyError.message(error, serverHost),
                    ),
                )
                refreshNow()
            } finally {
                _state.update { it.copy(deletingJobIds = it.deletingJobIds - job.id) }
            }
        }
    }

    /**
     * Resolves a job a link names and hands it back, so the list can open the
     * detail for an id that was never on screen.
     */
    fun openLinkedJob(id: String, onOpen: (Job) -> Unit) {
        viewModelScope.launch {
            try {
                onOpen(repository.job(id))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _events.tryEmit(
                    JobListEvent.Notice(
                        title = "Couldn’t open job",
                        message = "Could not open the linked job: " +
                            FriendlyError.message(error, serverHost),
                    ),
                )
            }
        }
    }
}

/**
 * The trailing status a row shows.
 *
 * An active job says when it fires next rather than that it is active — "Active"
 * is already visible from the section it is sitting in, and the next tick is the
 * thing nobody can work out for themselves.
 */
fun jobStatusText(job: Job, now: Instant = Instant.now()): String {
    val countdown = JobSchedule.countdown(to = job.nextRunAt, now = now)
    return when (job.status) {
        "active" -> if (countdown == null) "Active" else "Next $countdown"
        "paused" -> "Paused"
        "completed" -> "Completed"
        else -> "Status unavailable"
    }
}
