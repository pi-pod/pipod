package com.pipod.app.core.workstation

import com.pipod.app.core.api.model.WorkstationDemand
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext

/**
 * One screen's live workstation wait: classify a failure, run the wait, publish
 * what it is doing, and expose the Cancel that ends *this app's* wait.
 *
 * View models hold one of these instead of re-implementing the wait, so launch,
 * pod detail, the pod list and the session screen all show the same facts in the
 * same vocabulary. The wait itself lives in [WorkstationWait]; this only owns
 * the resting state a finished wait leaves behind, which [WorkstationWait]
 * deliberately does not publish.
 */
class WorkstationWaitSession(
    private val status: WorkstationStatusSource? = null,
    /** Every state change, including the resting state a finished wait leaves. */
    private val onState: (WorkstationWaitState?) -> Unit,
    /** Whether the request this session re-issues may be safely repeated. */
    private val policy: WorkstationAttemptPolicy = WorkstationAttemptPolicy.Repeatable,
    private val newWait: (WorkstationStatusSource?) -> WorkstationWait =
        { WorkstationWait(it, policy = policy) },
) {

    /** The wait in flight and the coroutine running it, so both can be ended. */
    private class Running(val wait: WorkstationWait, val job: Job?) {
        /** True once the wait was ended by something other than the reader. */
        @Volatile
        var silent = false
    }

    @Volatile
    private var active: Running? = null

    val isWaiting: Boolean get() = active != null

    /** Ends this app's wait. The workstation keeps starting on the server. */
    fun cancel() {
        active?.wait?.cancel()
    }

    /** Drops the resting state, so a screen stops showing a wait that is over. */
    fun clear() {
        onState(null)
    }

    /**
     * Ends the wait because what it was waiting for arrived another way — a
     * manual refresh that succeeded on its own.
     *
     * Unlike [cancel] this leaves no resting card: nothing failed and nobody
     * gave up, so "You stopped waiting" would be a lie printed over a screen
     * that just loaded. Without it the wait keeps polling the workstation and
     * re-issuing its request in the background until its budget runs out.
     */
    fun finish() {
        val running = active ?: return
        active = null
        running.silent = true
        running.wait.cancel()
        running.job?.cancel()
    }

    /**
     * Runs [request] under a workstation wait when [error] was a host-demand
     * refusal, and returns null when it was not one — the caller then handles
     * the failure exactly as it did before.
     */
    suspend fun <T> run(error: Throwable, request: suspend () -> T): WorkstationWaitOutcome<T>? {
        val demand = WorkstationDemand.fromThrowable(error) ?: return null
        return runFor(demand, request)
    }

    /** The same, for a demand that arrived somewhere other than a REST throw. */
    suspend fun <T> runFor(
        demand: WorkstationDemand,
        request: suspend () -> T,
    ): WorkstationWaitOutcome<T> {
        supersede()
        val wait = newWait(status)
        val running = Running(wait, currentCoroutineContext()[Job])
        active = running
        val outcome = try {
            wait.await(demand, onState) { request() }
        } finally {
            // Only the wait that still owns the slot may clear it: a wait that
            // was superseded would otherwise null out its successor and leave
            // Cancel with nothing to cancel — which is how waits used to stack.
            if (active === running) active = null
        }
        if (!running.silent) onState(restingState(outcome))
        return outcome
    }

    /**
     * Ends the wait already running, if any, before a new one starts.
     *
     * A screen has several ways to ask for the same thing — pull-to-refresh, the
     * initializing poll, the card's own Try again — and each failing call would
     * otherwise enter a wait of its own. Every orphan keeps polling the
     * workstation and re-issuing its request for up to the whole budget, and
     * only the newest one answers [cancel]. So the previous wait is stopped and
     * joined here: one wait per session, always the one the reader can see.
     */
    private suspend fun supersede() {
        val previous = active ?: return
        active = null
        previous.wait.cancel()
        val job = previous.job ?: return
        // A sequential second call from the same coroutine would be cancelling
        // itself; the cooperative flag above is all that one needs.
        if (job === currentCoroutineContext()[Job]) return
        job.cancel()
        job.join()
    }

    private fun <T> restingState(outcome: WorkstationWaitOutcome<T>): WorkstationWaitState? =
        when (outcome) {
            // A request that finally succeeded has nothing left to say, and a
            // failure that is not a workstation wait belongs to the caller's own
            // error path rather than to this surface.
            is WorkstationWaitOutcome.Ready, is WorkstationWaitOutcome.Failed -> null

            is WorkstationWaitOutcome.Terminal ->
                WorkstationWaitState(outcome.demand, status = WorkstationWaitStatus.Terminal)

            is WorkstationWaitOutcome.Expired -> WorkstationWaitState(
                demand = outcome.demand,
                elapsedMs = outcome.elapsedMs,
                status = WorkstationWaitStatus.Expired,
            )

            is WorkstationWaitOutcome.Cancelled -> WorkstationWaitState(
                demand = outcome.demand,
                elapsedMs = outcome.elapsedMs,
                status = WorkstationWaitStatus.Cancelled,
            )
        }
}
