package com.pipod.app.features.jobs

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.DecodedList
import com.pipod.app.core.api.model.Job
import com.pipod.app.core.api.model.JobRun
import com.pipod.app.core.api.model.PodTemplate
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * The scheduled-job operations the screens need, ported from
 * `pi-pod-flutter/lib/features/jobs/job_repository.dart`.
 *
 * Narrow enough to replace in a test: everything the two job screens can do to
 * the server is one of these six calls.
 */
interface JobRepository {
    suspend fun jobs(): DecodedList<Job>
    suspend fun job(id: String): Job
    suspend fun jobRuns(id: String): DecodedList<JobRun>
    suspend fun template(id: String): PodTemplate

    /** `activate`, `pause` or `resume`; anything else is refused by the client. */
    suspend fun command(id: String, command: String): Job
    suspend fun delete(id: String)
}

class ApiJobRepository(private val api: ApiClient) : JobRepository {

    override suspend fun jobs(): DecodedList<Job> = api.jobs()

    override suspend fun job(id: String): Job = api.job(id)

    override suspend fun jobRuns(id: String): DecodedList<JobRun> = api.jobRuns(id)

    override suspend fun template(id: String): PodTemplate = api.template(id)

    override suspend fun command(id: String, command: String): Job = api.jobCommand(id, command)

    override suspend fun delete(id: String) = api.deleteJob(id)
}

/**
 * Keeps a mounted jobs list synchronized with actions completed in a detail
 * view.
 *
 * On a wide window both screens are on screen at once, and on a phone the list
 * is still composed behind the pushed detail — so a job paused in the detail has
 * to reach the row without either screen knowing the other exists.
 */
object JobNotifications {

    private val _changed = MutableSharedFlow<Unit>(extraBufferCapacity = 8)

    val changed: SharedFlow<Unit> = _changed.asSharedFlow()

    fun postChanged() {
        _changed.tryEmit(Unit)
    }
}
