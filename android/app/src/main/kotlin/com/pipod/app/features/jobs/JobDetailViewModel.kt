package com.pipod.app.features.jobs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.Job
import com.pipod.app.core.api.model.JobRun
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

/** Everything the job detail draws. */
data class JobDetailState(
    val job: Job? = null,
    val runs: List<JobRun> = emptyList(),
    val unsupportedRunCount: Int = 0,
    val templateName: String? = null,
    /** True once the server has settled whether that environment still exists. */
    val templateChecked: Boolean = false,
    /** True until the job a link named has been resolved. */
    val isResolving: Boolean = true,
    /** A refresh the reader pulled for, which is the only kind that may spin. */
    val isRefreshing: Boolean = false,
    val resolveError: String? = null,
    val isWorking: Boolean = false,
    val message: String? = null,
    val isError: Boolean = false,
) {
    /**
     * A finished job's status word says nothing on its own, so it carries what
     * it means for the schedule.
     */
    val statusLabel: String
        get() {
            val job = job ?: return ""
            if (job.isCompleted) return "Completed — every scheduled time has passed"
            return job.status.replaceFirstChar { it.uppercase() }
        }

    val showsRuns: Boolean get() = runs.isNotEmpty() || unsupportedRunCount > 0

    /**
     * The environment the pod is built from, or what is known about it so far.
     *
     * Never the raw id: a 36-character UUID in the Environment row tells the
     * reader nothing and looks like a rendering bug. The pod detail says
     * "Deleted environment" for the same case, and this says it too.
     */
    val environmentLabel: String
        get() = templateName ?: when {
            job?.templateId == null -> "Default (empty pod)"
            templateChecked -> "Deleted environment"
            else -> "Loading…"
        }
}

/** Something the screen does rather than draws. */
sealed interface JobDetailEvent {
    data object Deleted : JobDetailEvent
}

/**
 * The job detail's state machine, ported from `JobDetailView` and
 * `JobDetailRoute` in `pi-pod-flutter/lib/features/jobs/`.
 *
 * Resolution and detail are one class because the route's only job is to turn
 * an id into a job, and splitting that across two state holders would leave the
 * screen with two loading states to reconcile for one wait.
 */
class JobDetailViewModel(
    private val repository: JobRepository,
    private val jobId: String,
    initialJob: Job? = null,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(
        // A row that was tapped already carries the job, so the detail opens on
        // content instead of on a spinner over data the caller is holding.
        if (initialJob != null && initialJob.id == jobId) {
            JobDetailState(job = initialJob, isResolving = false)
        } else {
            JobDetailState()
        },
    )
    val state: StateFlow<JobDetailState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<JobDetailEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<JobDetailEvent> = _events.asSharedFlow()

    /**
     * One read at a time. The job, its runs and its environment name are three
     * requests; two refreshes in flight together interleave them and the older
     * answers can land last.
     */
    private val refreshing = RefreshJob(viewModelScope)

    init {
        viewModelScope.launch {
            if (_state.value.job == null && !resolve()) return@launch
            refreshNow()
        }
    }

    private suspend fun resolve(): Boolean {
        return try {
            _state.update { it.copy(job = repository.job(jobId), resolveError = null) }
            true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            _state.update { it.copy(resolveError = FriendlyError.message(error, serverHost)) }
            false
        } finally {
            _state.update { it.copy(isResolving = false) }
        }
    }

    fun refresh() {
        refreshing.start {
            _state.update { it.copy(isRefreshing = true) }
            try {
                refreshNow()
            } finally {
                _state.update { it.copy(isRefreshing = false) }
            }
        }
    }

    /**
     * The job, its runs and its environment name are three independent reads.
     * The first failure is what the reader is told about, and a partial refresh
     * still keeps whatever did arrive — but it never passes silently, because a
     * pull that quietly kept stale data reads as fresh.
     */
    private suspend fun refreshNow() {
        var failure: Throwable? = null
        try {
            _state.update { it.copy(job = repository.job(jobId)) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            failure = error
        }
        try {
            val runs = repository.jobRuns(jobId)
            _state.update { it.copy(runs = runs.items, unsupportedRunCount = runs.unparsedRows.size) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            if (failure == null) failure = error
        }

        val templateId = _state.value.job?.templateId
        if (templateId != null && _state.value.templateName == null) {
            try {
                val template = repository.template(templateId)
                _state.update { it.copy(templateName = template.name, templateChecked = true) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                // The environment name is supplementary and never fails the
                // refresh. Only a real 404 settles the question: a dropped
                // connection leaves the row unresolved so the next refresh asks
                // again instead of accusing the server of deleting it.
                if (error is ApiError && error.transportStatus == 404) {
                    _state.update { it.copy(templateChecked = true) }
                }
            }
        }

        if (failure != null) {
            show(
                "Could not refresh this job: ${FriendlyError.message(failure, serverHost)}",
                isError = true,
            )
        } else if (_state.value.isError) {
            _state.update { it.copy(message = null, isError = false) }
        }
    }

    /** `activate`, `pause` or `resume`. */
    fun command(action: String) {
        viewModelScope.launch {
            _state.update { it.copy(isWorking = true, message = null) }
            try {
                val job = repository.command(jobId, action)
                _state.update { it.copy(job = job) }
                when (job.status) {
                    "active" -> {
                        val countdown = JobSchedule.countdown(to = job.nextRunAt)
                        show(
                            "Job is active. ${if (countdown == null) "" else "Next run $countdown."}",
                            isError = false,
                        )
                    }

                    "paused" -> show(
                        "Job paused. Its schedule won’t fire until you resume it.",
                        isError = false,
                    )

                    else -> show("Job is ${job.status}.", isError = false)
                }
                JobNotifications.postChanged()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                show(FriendlyError.message(error, serverHost), isError = true)
            } finally {
                _state.update { it.copy(isWorking = false) }
            }
        }
    }

    fun delete() {
        viewModelScope.launch {
            _state.update { it.copy(isWorking = true) }
            try {
                repository.delete(jobId)
                JobNotifications.postChanged()
                _events.tryEmit(JobDetailEvent.Deleted)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                show(FriendlyError.message(error, serverHost), isError = true)
            } finally {
                _state.update { it.copy(isWorking = false) }
            }
        }
    }

    private fun show(text: String, isError: Boolean) {
        _state.update { it.copy(message = text, isError = isError) }
    }
}

/** An absolute next-run time with the wait to it, when there is one. */
fun jobNextRunLabel(isoString: String, now: Instant = Instant.now()): String {
    val absolute = Format.absolute(isoString) ?: isoString
    val countdown = JobSchedule.countdown(to = isoString, now = now)
    return if (countdown == null) absolute else "$absolute ($countdown)"
}

/**
 * Run statuses arrive as raw server enums. Known values map to Title Case and
 * anything unknown degrades to Title Case too, never raw lowercase.
 */
fun humanizeJobRunStatus(status: String): String {
    val spaced = status
        .replace(CAMEL_BOUNDARY) { match -> "${match.groupValues[1]} ${match.groupValues[2]}" }
        .replace(SEPARATORS, " ")
    val words = spaced.split(" ").filter { it.isNotEmpty() }
    if (words.isEmpty()) return status
    return words.joinToString(" ") { word ->
        word.substring(0, 1).uppercase() + word.substring(1).lowercase()
    }
}

private val CAMEL_BOUNDARY = Regex("([a-z0-9])([A-Z])")
private val SEPARATORS = Regex("[_-]+")
