package com.pipod.app.core.api.model

import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.format.FriendlyText
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** One environment, read-only here: environments are written in the web dashboard. */
@Serializable
data class PodTemplate(
    val id: String,
    val name: String,
    val description: String? = null,
    val status: String,
    val initScript: String? = null,
    val bakeScript: String? = null,
    /**
     * What the agent in every pod launched from this environment is told, chiefly
     * the access its pods are meant to have. Null when the server predates the
     * field, which is not the same as "" (none).
     */
    val agentInstructions: String? = null,
    val config: JsonObject = JsonObject(emptyMap()),
    val createdFromPod: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class InitStepStatus(val scope: String, val status: String)

@Serializable
data class PiSettingsStatus(
    val files: List<String> = emptyList(),
    val bytes: Int = 0,
    val packageCount: Int = 0,
    val droppedKeys: List<String> = emptyList(),
    val status: String,
    val installedPackageCount: Int? = null,
    val failedPackageCount: Int? = null,
)

@Serializable
data class ImagePreparationStatus(
    val ref: String,
    val status: String,
    val managed: Boolean,
    val provenance: String,
    val assetDigest: String? = null,
)

@Serializable
data class BakeStatus(val digest: String, val mode: String, val status: String)

/**
 * Bounded capacity-wait view (capacity contract §1).
 *
 * Null when the pod never queued; an older server omits the field, which reads
 * exactly like null.
 */
@Serializable
data class CapacityWaitDetail(
    val kind: String = "admission",
    val reason: String = "",
    val resource: String? = null,
    val unit: String? = null,
    val retryable: Boolean? = null,
    val retryAfterMs: Int? = null,
    val required: Double? = null,
    val available: Double? = null,
    val budget: Double? = null,
    val committed: Double? = null,
)

@Serializable
data class CapacityWaitState(
    val state: String,
    val reason: String? = null,
    val detail: CapacityWaitDetail? = null,
    val attempts: Int = 0,
    val deadlineInMs: Int = 0,
    val cancelRequested: Boolean = false,
    /**
     * Future create/wake discriminator (capacity lead, in progress). Tolerated
     * and unused: cancel must never delete or stop a wake-kind wait — only the
     * cooperative cancel or an explicit delete ends it.
     */
    val kind: String? = null,
) {
    val isWaiting: Boolean get() = state == "waiting"
    val isExpired: Boolean get() = state == "expired"
    val isCancelled: Boolean get() = state == "cancelled"
    val isAdmitted: Boolean get() = state == "admitted"
}

@Serializable
data class EgressInfo(val description: String = "", val mode: String = "unknown")

@Serializable
data class PodResolvedConfig(
    val clamps: List<PolicyClamp> = emptyList(),
    val secretKeys: List<String> = emptyList(),
    val secretScopes: Map<String, String>? = null,
    val initSteps: List<InitStepStatus>? = null,
    val piAuthProviders: List<String>? = null,
    val piSettings: PiSettingsStatus? = null,
    val imagePreparation: ImagePreparationStatus? = null,
    val bake: BakeStatus? = null,
    val egress: EgressInfo = EgressInfo(),
    val warnings: List<String> = emptyList(),
    val idleTimeoutMinutes: Int? = null,
    val archiveAfterMinutes: Int? = null,
    val image: String? = null,
)

@Serializable
data class Pod(
    val id: String,
    val templateId: String? = null,
    val userId: String,
    val parentPodId: String? = null,
    val hostPodId: String? = null,
    val hostPodName: String? = null,
    val location: String? = null,
    val name: String,
    val project: String? = null,
    val provider: String,
    val state: String,
    val ready: Boolean,
    val initializing: Boolean,
    val preparationPhase: String? = null,
    val sandboxState: String? = null,
    val capacityWait: CapacityWaitState? = null,
    /**
     * Whether the gateway currently holds a live session for this pod:
     * `connected`, `reconnecting`, `detached` or `asleep` (`podConnection` in
     * `server/src/server/pods/routes.ts`). Null on a payload that
     * predates the field.
     */
    val connection: String? = null,
    val stateReason: String? = null,
    /**
     * The typed launch-failure code the server's failure recorder classified
     * the outcome with (`capacity_wait_expired` / `capacity_wait_orphaned`);
     * null for every other failure. It is the same code the `launch_failed:`
     * prefix of [stateReason] carries, projected as its own field.
     */
    val stateReasonCode: String? = null,
    val lastActivityAt: String? = null,
    val createdAt: String,
    val resolvedConfig: PodResolvedConfig = PodResolvedConfig(),
) {
    val projectName: String? get() = project?.trim()?.takeIf { it.isNotEmpty() }

    /**
     * Where the pod lives: the provider for a machine-backed pod, `on <host>`
     * for a co-located child. Prefers the server's derived field and falls back
     * so an older payload still has something to print.
     */
    val displayLocation: String
        get() {
            location?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
            if (hostPodId != null) {
                val host = hostPodName?.trim()
                return if (!host.isNullOrEmpty()) "on $host" else "on host"
            }
            return provider
        }

    val isHostChild: Boolean get() = hostPodId != null

    val isLive: Boolean get() = state == "active"
    val isArchived: Boolean get() = state == "archived"
    val isGone: Boolean get() = sandboxState == "gone"
    val didFail: Boolean get() = state == "failed" || preparationPhase == "failed" || isGone

    val isAsleep: Boolean get() = isLive && (sandboxState == "stopped" || sandboxState == "archived")

    val canOpenSession: Boolean get() = isLive && !initializing && !didFail
    val canOpenConversation: Boolean get() = isLive && !didFail

    val friendlyStateReason: String?
        get() {
            val reason = stateReason
            // The failure recorder writes `launch_failed:<code>: <sentence>`.
            // The machine prefix is addressed to whoever reads the pod row, not
            // to the person holding the phone, and the fleet-pressure wording it
            // wraps matches none of FriendlyError's patterns while it is still
            // attached — so the whole machine string used to reach the screen.
            val code = stateReasonCode ?: reason?.let { LAUNCH_FAILED.find(it)?.groupValues?.get(1) }
            // A gone sandbox is usually a tombstone, but an admission refusal
            // that then marks the row gone still carries the host sentence
            // (and its allowlisted GiB amounts). The gone copy would hide it.
            if (isGone && code != "admission_denied") {
                return "This pod\u2019s sandbox no longer exists, so it can\u2019t be opened. " +
                    "Launch a new pod to keep working."
            }
            if (!didFail || reason.isNullOrEmpty()) return null
            if (code != null && FLEET_PRESSURE_CODES.contains(code)) {
                return FriendlyError.FLEET_PRESSURE_MESSAGE
            }
            val stripped = reason.replaceFirst(LAUNCH_FAILED, "")
            if (code == "admission_denied") {
                // "sandbox hosts at capacity (memory_capacity): 4.00 GiB required, 0.12 GiB
                // available of 12.12 GiB budget" — the figures are worth keeping, the jargon is not.
                val figures = ADMISSION_FIGURES.find(stripped)?.groupValues
                val need = figures?.let { " (${gib(it[1])} needed, ${gib(it[2])} free)" } ?: ""
                return "No room to start this pod: the server is full$need. Stop a pod you " +
                    "aren\u2019t using, then launch again."
            }
            val cleaned = FriendlyText.withoutOperatorInstructions(stripped)
            if (cleaned.isEmpty()) return null
            val prefix = "provisioning failed:"
            if (!cleaned.lowercase().startsWith(prefix)) return cleaned
            val detail = cleaned.substring(prefix.length).trim()
            return if (detail.isEmpty()) {
                "This pod\u2019s sandbox couldn\u2019t be created."
            } else {
                "This pod\u2019s sandbox couldn\u2019t be created: $detail"
            }
        }

    // Not private: the serialization plugin puts `serializer()` here, and
    // `Pod.serializer()` is called from `ApiClient` and the paging helper.
    companion object {
        /** `launch_failed:<code>: ` as `formatLaunchFailure` writes it. */
        private val LAUNCH_FAILED = Regex("^launch_failed:([a-z0-9_]+):\\s*")

        private val ADMISSION_FIGURES = Regex("([0-9.]+) GiB required, ([0-9.]+) GiB available")

        private fun gib(raw: String): String {
            val value = raw.toDoubleOrNull() ?: return "$raw GiB"
            return if (value == Math.rint(value)) "${value.toInt()} GiB" else "%.1f GiB".format(value)
        }

        /**
         * A launch that timed out (or was orphaned) waiting for room is fleet
         * pressure, and the REST path already says so — only `state_reason`
         * spelled it out in machine terms.
         */
        private val FLEET_PRESSURE_CODES = setOf("capacity_wait_expired", "capacity_wait_orphaned")
    }
}

@Serializable
data class LaunchReport(
    val clamps: List<PolicyClamp> = emptyList(),
    val secretKeys: List<String> = emptyList(),
    val warnings: List<String> = emptyList(),
)

@Serializable
data class LaunchResponse(val pod: Pod, val report: LaunchReport = LaunchReport())

/**
 * `GET /v1/pods` as a whole: the rows, and the optional account summary the
 * envelope may carry.
 *
 * [billing] is null on the self-hosted static backend, which sends the
 * `workstation` key in neither place — that is the edition boundary, and it
 * is silent. The SaaS backend sends it on `GET /v1/me` today.
 */
data class PodsPage(
    val pods: DecodedList<Pod> = DecodedList(),
    val billing: BillingSummary? = null,
)
