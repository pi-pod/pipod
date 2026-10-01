package com.pipod.app.core.workstation

import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.WorkstationDemand
import com.pipod.app.core.api.model.WorkstationStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** `GET /v1/workstations/{hostId}` — the durable truth, or null on an older server. */
fun interface WorkstationStatusSource {
    suspend fun workstation(hostId: String): WorkstationStatus?
}

/**
 * Whether the request a wait re-issues may be safely repeated.
 *
 * A wait exists to send the same request again, which is only harmless when
 * sending it twice means the same thing as sending it once. `GET /v1/pods` is
 * such a request; `POST /v1/pods` is not — it has no idempotency key, so a POST
 * that timed out may very well have created a pod whose answer was simply lost,
 * and re-issuing it creates a second one.
 *
 * The wait therefore never repeats an attempt that failed for a reason other
 * than a host-demand refusal, whatever the policy. A host-demand 503 *is* proof
 * the server did nothing, so it is always safe to retry. What the policy adds is
 * the honest reading of every other failure: under [CreatesSomething] the
 * outcome of the attempt is unknown, and the copy has to say so instead of
 * inviting a second launch.
 */
enum class WorkstationAttemptPolicy {
    /** A read, or anything else whose repetition changes nothing. */
    Repeatable,

    /** Creates or moves something: a pod launch, a lifecycle command. */
    CreatesSomething,
    ;

    /**
     * Whether a failed attempt under this policy may still have taken effect on
     * the server — the case a caller has to word as "check before retrying".
     *
     * A refusal the server sent (a host-demand 503, a 4xx, or any answer it
     * put into words) is proof it did not act. A request that never came back —
     * a timeout, a dropped connection — or a 5xx raised somewhere inside the
     * handler is not.
     */
    fun outcomeUnknown(error: Throwable): Boolean {
        if (this == Repeatable) return false
        if (WorkstationDemand.fromThrowable(error) != null) return false
        // Only a transport failure leaves no answer at all; an [ApiError] is one.
        val answer = error as? ApiError ?: return true
        val status = answer.transportStatus ?: return false
        return status >= 500
    }
}

/** Where a wait ended up, as one thing a screen can render. */
enum class WorkstationWaitStatus {
    /** Still starting; the poll and the retry are both running. */
    Waiting,

    /** `retryable: false`. Nothing to poll for; the reason's copy is final. */
    Terminal,

    /** The client's budget ran out. The workstation is still starting on the server. */
    Expired,

    /** The person ended *this app's* wait. The workstation keeps starting. */
    Cancelled,
}

/**
 * One workstation wait, as a value a screen draws.
 *
 * There is deliberately no "progress fraction" here: the server sends a
 * deadline, not an estimate, and a bar that fills toward a number nobody
 * promised is exactly the dishonesty this whole state exists to remove.
 */
data class WorkstationWaitState(
    val demand: WorkstationDemand,
    val elapsedMs: Long = 0,
    val attempts: Int = 0,
    val status: WorkstationWaitStatus = WorkstationWaitStatus.Waiting,
) {
    val isWaiting: Boolean get() = status == WorkstationWaitStatus.Waiting
}

/** What a wait produced. [Ready] is the only outcome that carries the request's value. */
sealed interface WorkstationWaitOutcome<out T> {
    /** The re-issued request finally succeeded. */
    data class Ready<T>(val value: T) : WorkstationWaitOutcome<T>

    /** `retryable: false` — deleted or retired. Do not poll. */
    data class Terminal(val demand: WorkstationDemand) : WorkstationWaitOutcome<Nothing>

    /** The client's budget ran out. Not a failure of the workstation. */
    data class Expired(val demand: WorkstationDemand, val elapsedMs: Long) :
        WorkstationWaitOutcome<Nothing>

    /** [WorkstationWait.cancel] was called. Only the client's wait ended. */
    data class Cancelled(val demand: WorkstationDemand, val elapsedMs: Long) :
        WorkstationWaitOutcome<Nothing>

    /** The retry failed for a reason that is not a workstation wait at all. */
    data class Failed(val error: Throwable) : WorkstationWaitOutcome<Nothing>
}

/**
 * The one workstation-wait routine every call site shares — launch, pod detail,
 * file/send, and session attach.
 *
 * It is a plain class with an injected clock and sleep rather than a coroutine
 * inside a composable or a view-model side effect, because a 700-second wait has
 * to survive a recomposition and has to be testable without one.
 *
 * The algorithm is the client contract, in order:
 *
 * 1. A non-retryable demand is terminal immediately; it is never polled.
 * 2. Otherwise poll `GET /v1/workstations/:hostId` on the clamped interval when
 *    a validated host id is known, and **re-issue the original request every
 *    cycle** — the server's admission is the only authority on readiness, so a
 *    poll reporting `running` is a hint, not proof.
 * 3. Progress is emitted at least every [progressTickMs] so a wait of minutes is
 *    visibly alive, and never as a countdown to a number the server did not send.
 * 4. The budget is `operation.deadlineAt` when it parses (clamped to
 *    [WorkstationDemand.MIN_BUDGET_MS]…[WorkstationDemand.MAX_BUDGET_MS] from
 *    now), else 20 minutes; 30 minutes from the start is the outer bound either
 *    way.
 * 5. [cancel] ends this app's wait only. The workstation keeps starting on the
 *    server, files are retained, and the same action later attaches to it.
 *
 * One instance per wait: [cancel] is about *this* wait and nothing else.
 */
class WorkstationWait(
    private val status: WorkstationStatusSource? = null,
    private val now: () -> Long = System::currentTimeMillis,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val progressTickMs: Long = PROGRESS_TICK_MS,
    /** What re-issuing [await]'s request costs. See [WorkstationAttemptPolicy]. */
    val policy: WorkstationAttemptPolicy = WorkstationAttemptPolicy.Repeatable,
) {

    @Volatile
    private var cancelled = false

    val isCancelled: Boolean get() = cancelled

    /** Ends this app's wait. Never touches the workstation. */
    fun cancel() {
        cancelled = true
    }

    suspend fun <T> await(
        initial: WorkstationDemand,
        onProgress: (WorkstationWaitState) -> Unit = {},
        request: suspend () -> T,
    ): WorkstationWaitOutcome<T> {
        val start = now()
        var demand = initial
        var attempts = 0

        // The anchor sentence goes up immediately: a silent gap in front of a
        // multi-minute wait reads as a hung app. Only `Waiting` is published from
        // here; how a finished wait reads is the caller's to decide from the
        // outcome, so there is one owner of the resting state.
        onProgress(WorkstationWaitState(demand, 0, attempts, WorkstationWaitStatus.Waiting))
        if (!demand.retryable) return WorkstationWaitOutcome.Terminal(demand)

        val outerBound = start + WorkstationDemand.MAX_BUDGET_MS
        var deadline = minOf(
            start + (demand.budgetMsFrom(start) ?: WorkstationDemand.DEFAULT_BUDGET_MS),
            outerBound,
        )

        while (true) {
            // 1. Wait the clamped interval, in slices small enough to keep the
            //    elapsed reading alive and cancellation responsive.
            var waited = 0L
            val interval = demand.pollIntervalMs
            while (waited < interval) {
                stopping(demand, start)?.let { return it }
                if (now() >= deadline) return expired(demand, start)
                val slice = minOf(progressTickMs, interval - waited)
                sleep(slice)
                waited += slice
                onProgress(state(demand, start, attempts))
            }
            stopping(demand, start)?.let { return it }
            if (now() >= deadline) return expired(demand, start)

            // 2. The durable status, when the demand named a host we validated.
            //    A failed poll is not a failed wait: the retry below is what
            //    actually decides.
            val hostId = demand.hostId
            if (hostId != null && status != null) {
                val snapshot = try {
                    status.workstation(hostId)
                } catch (cancelledCall: CancellationException) {
                    throw cancelledCall
                } catch (_: Throwable) {
                    null
                }
                if (snapshot != null) {
                    demand = demand.withStatus(snapshot)
                    onProgress(state(demand, start, attempts))
                }
            }
            stopping(demand, start)?.let { return it }

            // 3. Re-issue the original request. Admission is the only authority.
            attempts += 1
            try {
                return WorkstationWaitOutcome.Ready(request())
            } catch (cancelledCall: CancellationException) {
                throw cancelledCall
            } catch (error: Throwable) {
                // Anything that is not a host-demand refusal ends the wait here,
                // under every policy. A timed-out POST may already have created
                // the pod, and a loop that cannot tell must not send it again;
                // [WorkstationAttemptPolicy.outcomeUnknown] is how the caller
                // words that for the reader.
                val next = WorkstationDemand.fromThrowable(error)
                    ?: return WorkstationWaitOutcome.Failed(error)
                demand = next
                if (!next.retryable) return WorkstationWaitOutcome.Terminal(next)
                onProgress(state(demand, start, attempts))
                next.budgetMsFrom(now())?.let { budget ->
                    deadline = minOf(now() + budget, outerBound)
                }
                if (now() >= deadline) return expired(demand, start)
            }
        }
    }

    private fun stopping(
        demand: WorkstationDemand,
        start: Long,
    ): WorkstationWaitOutcome<Nothing>? {
        if (!cancelled) return null
        return WorkstationWaitOutcome.Cancelled(demand, now() - start)
    }

    private fun expired(demand: WorkstationDemand, start: Long): WorkstationWaitOutcome<Nothing> =
        WorkstationWaitOutcome.Expired(demand, now() - start)

    private fun state(
        demand: WorkstationDemand,
        start: Long,
        attempts: Int,
    ) = WorkstationWaitState(demand, now() - start, attempts, WorkstationWaitStatus.Waiting)

    companion object {
        /**
         * The contract asks for visible progress at least every 15 s. One second
         * costs a single text row and makes the elapsed reading tick the way a
         * person expects, so a 700-second wait never looks frozen.
         */
        const val PROGRESS_TICK_MS = 1_000L
    }
}
