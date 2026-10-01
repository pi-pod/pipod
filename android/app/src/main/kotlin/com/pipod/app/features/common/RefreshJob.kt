package com.pipod.app.features.common

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * One refresh at a time, per screen.
 *
 * A list screen refreshes from several places at once — the pull gesture, the
 * Refresh action, returning to the foreground, and a push telling it something
 * changed. Each of those used to start its own coroutine, so two reads could be
 * in flight together and finish in either order: the slower one wins and the
 * screen ends up showing the older list, while the first to finish clears the
 * loading flag the second is still under.
 *
 * A second request while one is already running is therefore dropped rather
 * than raced. Dropping is safe because every caller here wants the same thing —
 * "the current server state" — and the request already in flight is fetching
 * exactly that. [await] exists for the caller that needs the answer rather than
 * just the side effect: it joins the running refresh instead of starting a
 * second one.
 */
class RefreshJob(private val scope: CoroutineScope) {

    private var job: Job? = null

    /** The refresh in flight, or a newly started one. */
    fun start(block: suspend () -> Unit): Job {
        job?.takeIf { it.isActive }?.let { return it }
        // Started lazily and then explicitly, so the field is assigned before
        // the body can run: an eager dispatcher would otherwise finish the
        // coroutine before this class knew it existed.
        val started = scope.launch(start = CoroutineStart.LAZY) { block() }
        job = started
        started.start()
        return started
    }

    /** Starts a refresh if none is running, then waits for whichever one is. */
    suspend fun await(block: suspend () -> Unit) = start(block).join()

    /** Whether a refresh is running right now. */
    val isActive: Boolean get() = job?.isActive == true
}
