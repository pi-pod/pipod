package com.pipod.app.core.format

import com.pipod.app.core.api.model.WorkstationDemand
import com.pipod.app.core.api.model.WorkstationDemandReason
import com.pipod.app.core.workstation.WorkstationWaitState
import com.pipod.app.core.workstation.WorkstationWaitStatus

/**
 * Every user-visible word about a personal workstation, in one place so the set
 * can be audited against the client contract rather than hunted for.
 *
 * A workstation is a whole VM per user. Production-measured spans from intent to
 * authenticated readiness are **minutes**: 407 s and 708 s for a cold create,
 * 243–690 s for a resume. So nothing here promises a duration, offers a
 * countdown, or borrows the fleet-capacity vocabulary — a workstation wait is
 * not fleet pressure and is never the reader's own concurrency limit.
 *
 * Nothing here says anything was lost either. A stopped, starting or asleep
 * workstation keeps every workspace; there is never a reason to launch a
 * duplicate, and no copy may suggest one.
 */
object WorkstationCopy {

    /**
     * The server's own sentence, and the anchor every other line hangs off.
     * Kept verbatim (with the full stop the server's bounded copy omits).
     */
    const val STARTING = "Your workstation is starting. This may take several minutes."

    const val STOPPED =
        "Your workstation is asleep. Starting it now — this may take several minutes."

    const val RECONCILING = "Your workstation is being checked. Retrying shortly."

    const val STARTS_PAUSED =
        "Workstation starts are paused right now. Your files are safe; try again shortly."

    /**
     * The gateway's third close reason. The contract names no copy for it, so it
     * takes the neutral form of the others: no archive wording, no lost data, no
     * suggestion to make a second workstation.
     */
    const val ARCHIVED =
        "Your workstation isn’t running right now. Starting it may take several minutes."

    const val DELETED = "Your workstation was deleted. A new one is created on your next launch."

    const val RETIRED = "Your workstation was retired. A new one is created on your next launch."

    /** A retryable reason this build does not know, and no server sentence to quote. */
    const val NOT_READY = "Your workstation isn’t ready yet. This may take several minutes."

    /** What Cancel actually does — and, just as importantly, what it does not. */
    const val CANCEL_EXPLANATION =
        "Waiting stops here only. The workstation keeps starting on the server and your files " +
            "are retained, so the same action later attaches to the same workstation."

    const val CANCELLED =
        "Stopped waiting. The workstation keeps starting on the server and your files are " +
            "retained — try the same action again whenever you like."

    const val CANCEL_ACTION = "Stop waiting"

    const val RETRY_ACTION = "Try again now"

    const val TITLE = "Personal workstation"

    /** The sentence for a demand, chosen by reason and never by guesswork. */
    fun message(demand: WorkstationDemand): String = when (demand.knownReason) {
        WorkstationDemandReason.HostStarting -> STARTING
        WorkstationDemandReason.HostStopped -> STOPPED
        WorkstationDemandReason.HostRequiresReconciliation -> RECONCILING
        WorkstationDemandReason.BoxStartsDisabled -> STARTS_PAUSED
        WorkstationDemandReason.HostArchived -> ARCHIVED
        WorkstationDemandReason.HostDeleted -> DELETED
        WorkstationDemandReason.HostRetired -> RETIRED
        // A reason this build does not know falls back to the server's own
        // sentence, which is static per reason there. Never an invented one.
        null -> demand.serverMessage
            ?.takeIf { FriendlyText.readsAsProse(it) }
            ?.let { FriendlyText.withoutOperatorInstructions(it) }
            ?.takeIf { it.isNotEmpty() }
            ?: NOT_READY
    }

    /**
     * The budget ran out. That is this app giving up on waiting, not the
     * workstation failing, so the copy says to retry the same action — never to
     * create a second one.
     */
    fun expired(elapsedMs: Long): String =
        "Still starting after ${elapsed(elapsedMs)}. It keeps starting on the server and your " +
            "files are retained — try the same action again. Don’t create a duplicate."

    /** The whole state as one sentence, for a banner or a screen-reader label. */
    fun headline(state: WorkstationWaitState): String = when (state.status) {
        WorkstationWaitStatus.Waiting -> message(state.demand)
        WorkstationWaitStatus.Terminal -> message(state.demand)
        WorkstationWaitStatus.Expired -> expired(state.elapsedMs)
        WorkstationWaitStatus.Cancelled -> CANCELLED
    }

    /** "Waiting 2m 14s" — measured, not predicted. Null before the first second. */
    fun waiting(elapsedMs: Long): String? {
        if (elapsedMs < 1_000) return null
        return "Waiting ${elapsed(elapsedMs)}"
    }

    /**
     * The server's own words for where the operation is, as a lowercase
     * technical line. `starting · resume · command:activate`. Never a promise,
     * and never rendered when the server sent nothing.
     */
    fun technicalDetail(demand: WorkstationDemand): String? {
        val parts = buildList {
            demand.state?.let { add(it.wire) }
            demand.operation?.let {
                add(it.kind.wire)
                add(it.phase)
            }
        }
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    /** "45s", "2m 14s", "1h 3m". */
    fun elapsed(ms: Long): String {
        val seconds = (ms / 1_000).coerceAtLeast(0)
        if (seconds < 60) return "${seconds}s"
        val minutes = seconds / 60
        if (minutes < 60) {
            val rest = seconds % 60
            return if (rest == 0L) "${minutes}m" else "${minutes}m ${rest}s"
        }
        val hours = minutes / 60
        val rest = minutes % 60
        return if (rest == 0L) "${hours}h" else "${hours}h ${rest}m"
    }
}
