package com.pipod.app.core.format

import com.pipod.app.core.api.model.Pod
import kotlin.math.ceil

/**
 * A glyph named for what it means rather than what it looks like, so this layer
 * can say which icon a lifecycle wants without importing Compose. The UI maps
 * each token to its own icon set.
 */
enum class AppIconToken {
    Running,
    Asleep,
    Dot,
    Warning,
    Archived,
    Unavailable,
}

enum class PodLifecycle(
    val label: String,
    val tone: StatusTone,
    val isTransitional: Boolean = false,
) {
    Running("Running", StatusTone.Positive),
    Asleep("Asleep", StatusTone.Info),
    Starting("Starting", StatusTone.Caution, isTransitional = true),

    /**
     * Coming down: `stopping`, `archiving` or `deleting`. It shares Starting's
     * pulsing dot and caution tone on purpose — the glyph means "still moving",
     * and which way it is moving is what the label is for. What it must not
     * share is Running: a pod whose sandbox is being torn down is not one you
     * can work in, and saying "Running" invites exactly that.
     */
    Stopping("Stopping", StatusTone.Caution, isTransitional = true),
    Failed("Failed", StatusTone.Danger),
    Archived("Archived", StatusTone.Neutral),
    Unavailable("Unavailable", StatusTone.Unreachable),
    ;

    val icon: AppIconToken
        get() = when (this) {
            Running -> AppIconToken.Running
            Asleep -> AppIconToken.Asleep
            Starting, Stopping -> AppIconToken.Dot
            Failed -> AppIconToken.Warning
            Archived -> AppIconToken.Archived
            Unavailable -> AppIconToken.Unavailable
        }
}

/**
 * The only translation from server lifecycle fields into words and visuals.
 *
 * Stopped workspaces keep their local disk and archived workspaces restore from
 * cold storage. There is a single sandbox backend, so the retained-disk wording
 * is unconditional — no provider gets a weaker variant.
 */
class PodPresentation private constructor(
    val lifecycle: PodLifecycle,
    val statusLabel: String,
    val statusDetail: String?,
    val userFacingReason: String?,
    val image: String?,
) {
    val label: String get() = lifecycle.label
    val icon: AppIconToken get() = lifecycle.icon
    val tone: StatusTone get() = lifecycle.tone
    val isTransitional: Boolean get() = lifecycle.isTransitional

    companion object {
        fun fromPod(pod: Pod): PodPresentation {
            val lifecycle = lifecycle(pod)
            val (statusLabel, statusDetail) = statusStorage(pod, lifecycle)
            return PodPresentation(
                lifecycle,
                statusLabel,
                statusDetail,
                reason(pod, lifecycle),
                pod.resolvedConfig.image ?: imageFromReason(pod.stateReason),
            )
        }

        private fun statusStorage(pod: Pod, lifecycle: PodLifecycle): Pair<String, String?> {
            // Bounded capacity wait (capacity contract §1) overrides storage copy: the
            // request is queued, holding one concurrency slot but no host reservation.
            val wait = pod.capacityWait
            // A stale wait snapshot must never override a subsequently successful pod:
            // once the pod is really running, the wait is history, whatever it says.
            val settled = lifecycle == PodLifecycle.Running
            if (wait != null && wait.isWaiting && !settled) {
                val secondsLeft = ceil(wait.deadlineInMs / 1000.0).toInt().coerceIn(0, 1 shl 30)
                return "Waiting for capacity" to
                    "No room for ${waitReasonShort(wait.reason)} yet · ~${secondsLeft}s left"
            }
            // Terminal wait states are final for this wait — but the backend is
            // ambiguous (the server may have admitted late), so no copy may claim
            // nothing was created or tell the user to unconditionally launch again.
            // Every remedy routes through checking THIS pod's status first. Only a
            // wake-kind cancel may call the pre-existing workspace untouched.
            if (wait != null && wait.isExpired && !settled) {
                val wake = wait.kind == "wake"
                return lifecycle.label to if (wake) {
                    "No room before the deadline · check status, then restore or retry this pod " +
                        "— do not create duplicates"
                } else {
                    "No room before the deadline · check this pod's status before retrying " +
                        "— do not duplicate"
                }
            }
            if (wait != null && wait.isCancelled && !settled) {
                val wake = wait.kind == "wake"
                return lifecycle.label to if (wake) {
                    "Capacity wait cancelled · check status before retrying this pod"
                } else {
                    "Cancellation requested · check status before retrying " +
                        "— do not assume no backend was created"
                }
            }
            if (lifecycle == PodLifecycle.Stopping) {
                return when (pod.sandboxState) {
                    "archiving" -> "Archiving" to "Moving to cold storage…"
                    "deleting" -> "Deleting" to "Removing the sandbox…"
                    else -> "Stopping" to "Releasing compute · local disk retained"
                }
            }
            if (lifecycle == PodLifecycle.Archived) {
                val suffix = when (pod.sandboxState) {
                    // A bare logically hidden row claims nothing about storage.
                    "stopped" -> "· disk retained"
                    "archived" -> "· cold storage"
                    else -> null
                }
                return lifecycle.label to suffix
            }
            if (lifecycle == PodLifecycle.Asleep) {
                if (pod.sandboxState == "stopped") {
                    return "Stopped" to "Local disk retained · restarts in seconds"
                }
                if (pod.sandboxState == "archived") {
                    return "Archived" to "Restores on next use · seconds-to-minutes depending on size"
                }
                return lifecycle.label to null
            }
            return lifecycle.label to null
        }

        private fun waitReasonShort(reason: String?): String = when (reason) {
            "memory_capacity", "memory_debt" -> "memory"
            "disk_capacity" -> "disk"
            "cpu_capacity" -> "CPU"
            "transition_capacity" -> "transition"
            "network_capacity" -> "network"
            "fairness_degraded" -> "fair CPU share"
            "fleet_capacity" -> "fleet"
            else -> "capacity"
        }

        private fun lifecycle(pod: Pod): PodLifecycle {
            // A queued launch/wake pulses as transitional until the wait resolves;
            // terminal wait states fall through to the underlying mapping below.
            // A stale waiting snapshot on an already-ready pod is history, not state.
            if (pod.capacityWait?.isWaiting == true && !pod.ready) return PodLifecycle.Starting
            if (pod.state == "archived") return PodLifecycle.Archived
            if (pod.sandboxState == "gone") return PodLifecycle.Unavailable
            if (pod.state == "failed" ||
                pod.preparationPhase == "failed" ||
                pod.sandboxState == "error"
            ) {
                return PodLifecycle.Failed
            }
            if (pod.initializing ||
                pod.preparationPhase in STARTING_PHASES ||
                pod.sandboxState in STARTING_SANDBOX_STATES
            ) {
                return PodLifecycle.Starting
            }
            if (pod.sandboxState in STOPPING_SANDBOX_STATES) return PodLifecycle.Stopping
            if (pod.state == "asleep" ||
                (pod.state == "active" && pod.sandboxState in ASLEEP_SANDBOX_STATES)
            ) {
                return PodLifecycle.Asleep
            }
            // Only a sandbox this build actually recognises may read as Running.
            // A newer server's state word is not a promise that the pod is
            // usable, and "Running" is the one label that would be acted on.
            // An absent field is not an unknown value: a payload from before
            // sandboxState existed still means what `state` says.
            if (pod.state == "active" &&
                (pod.sandboxState == null || pod.sandboxState in RUNNING_SANDBOX_STATES)
            ) {
                return PodLifecycle.Running
            }
            return PodLifecycle.Unavailable
        }

        private fun reason(pod: Pod, lifecycle: PodLifecycle): String? {
            val lower = (pod.stateReason ?: "").lowercase()
            if (lifecycle == PodLifecycle.Failed &&
                lower.contains("image") &&
                (lower.contains("not found") || lower.contains("registry"))
            ) {
                return "This pod’s sandbox couldn’t be created: The selected image could not be " +
                    "found by your organization’s sandbox provider."
            }
            val reason = pod.friendlyStateReason
            if (reason.isNullOrEmpty()) return null
            // Every sink for this text is a screen, and the server can put a runtime
            // exception in stateReason, so it is screened here rather than at each view.
            val screened = FriendlyError.message(reason)
            if (pod.provider.isEmpty()) return screened
            return screened.replace(
                Regex("\\b${Regex.escape(pod.provider)}\\b", RegexOption.IGNORE_CASE),
                "sandbox provider",
            )
        }

        private fun imageFromReason(reason: String?): String? {
            if (reason == null) return null
            return IMAGE_IN_REASON.find(reason)?.groupValues?.get(1)
        }

        // Nullable members so an absent field reads as "not one of these" without a
        // null guard at each site.
        // `waiting-for-capacity` is what GET /v1/pods/:id substitutes while a
        // live wait sits over preparing_image/provisioning (`capacityWaitPhase`
        // in `pi-pod-server` `src/server/pods/capacity-wait.ts`): a pod with no
        // sandbox at all, and so unambiguously still starting.
        private val STARTING_PHASES =
            setOf<String?>(
                "preparing-image",
                "provisioning-sandbox",
                "running-init",
                "waiting-for-capacity",
            )
        private val STARTING_SANDBOX_STATES =
            setOf<String?>("preparing_image", "provisioning", "starting")
        private val STOPPING_SANDBOX_STATES =
            setOf<String?>("stopping", "archiving", "deleting")
        private val ASLEEP_SANDBOX_STATES = setOf<String?>("stopped", "archived")

        /** The sandbox states that really mean "there is a machine, and it is up". */
        private val RUNNING_SANDBOX_STATES = setOf<String?>("started", "running", "active")
        private val IMAGE_IN_REASON =
            Regex("image\\s+[\"\u201C]([^\"\u201D]+)[\"\u201D]", RegexOption.IGNORE_CASE)
    }
}
