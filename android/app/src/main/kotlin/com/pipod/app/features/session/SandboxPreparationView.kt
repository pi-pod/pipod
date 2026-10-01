package com.pipod.app.features.session

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import com.pipod.app.core.api.model.Pod
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.theme.appColors
import kotlin.math.ceil

/**
 * The staged progress of a sandbox that is still being built, ported from
 * `SandboxPreparationView` in `pi-pod-flutter/lib/features/session/session_view.dart`.
 *
 * A spinner alone leaves the user guessing whether a slow bake script is
 * progress or a hang, so each stage is named and carries its own status.
 */
@Composable
fun SandboxPreparationView(pod: Pod, modifier: Modifier = Modifier) {
    val colors = appColors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.fill.copy(alpha = 0.4f), RoundedCornerShape(12.dp))
            .padding(16.dp)
            .testTag(SandboxPreparationTestTags.ROOT),
    ) {
        Text("Preparing your sandbox", style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(4.dp))
        Text(
            text = "You can send a message now. It is saved on the server and starts " +
                "automatically when setup finishes.",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.secondaryLabel,
        )
        Spacer(Modifier.height(12.dp))
        SandboxPreparation.stages(pod).forEachIndexed { index, stage ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp)
                    // The tag is declared before the clearing modifier: a
                    // semantics property set after one is discarded when the
                    // node's config is collapsed.
                    .testTag(SandboxPreparationTestTags.stage(index))
                    .clearAndSetSemantics {
                        contentDescription = "${stage.label}, ${stage.detail}"
                    },
            ) {
                Box(Modifier.width(20.dp), contentAlignment = Alignment.Center) {
                    StageIcon(stage.status)
                }
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(stage.label, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        text = stage.detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.secondaryLabel,
                    )
                }
            }
        }
    }
}

@Composable
private fun StageIcon(status: String) {
    val colors = appColors
    when {
        status in RUNNING_STATUSES -> AppActivityIndicator(size = 14.dp)

        status in FINISHED_STATUSES -> {
            val degraded = status == "degraded"
            Icon(
                imageVector = if (degraded) AppIcons.errorOutline else AppIcons.success,
                contentDescription = null,
                tint = if (degraded) colors.warning else colors.success,
                modifier = Modifier.size(16.dp),
            )
        }

        status.startsWith("failed") -> Icon(
            imageVector = AppIcons.close,
            contentDescription = null,
            tint = colors.destructive,
            modifier = Modifier.size(16.dp),
        )

        else -> Icon(
            imageVector = AppIcons.dotOutline,
            contentDescription = null,
            tint = colors.separator,
            modifier = Modifier.size(16.dp),
        )
    }
}

private val RUNNING_STATUSES = setOf("running", "preparing", "installing")
private val FINISHED_STATUSES = setOf("ok", "ready", "skipped", "degraded")

/** One named step of a sandbox build, with the phrasing the row shows. */
data class PreparationStage(val label: String, val detail: String, val status: String)

/**
 * Derives the stage list from a pod snapshot.
 *
 * Kept out of the composable so the wording can be tested without a
 * composition — the phrasing is the whole point of this view.
 */
object SandboxPreparation {

    fun stages(pod: Pod): List<PreparationStage> {
        val result = mutableListOf<PreparationStage>()
        val phase = pod.preparationPhase
        val config = pod.resolvedConfig

        val imageStatus = config.imagePreparation?.status
            ?: if (phase == "preparing-image") "preparing" else "ready"
        result.add(
            PreparationStage(
                label = "Runtime image",
                detail = if (imageStatus == "preparing") {
                    "Building the required image"
                } else {
                    stageDetail(imageStatus)
                },
                status = imageStatus,
            ),
        )

        // `waiting-for-capacity` replaces the phase whenever a live wait sits in
        // front of preparing_image/provisioning — which are exactly the states in
        // which no sandbox exists yet. Falling through to the `else` branch
        // painted a green check and the word "Ready" over a pod that is queued.
        val sandboxStatus = when (phase) {
            "preparing-image" -> "pending"
            "provisioning-sandbox", WAITING_FOR_CAPACITY -> "running"
            else -> "ok"
        }
        result.add(
            PreparationStage(
                label = "Sandbox",
                detail = when {
                    phase == WAITING_FOR_CAPACITY -> capacityDetail(pod)
                    sandboxStatus == "running" -> "Creating and starting the sandbox"
                    else -> stageDetail(sandboxStatus)
                },
                status = sandboxStatus,
            ),
        )

        val settings = config.piSettings
        if (settings != null && settings.packageCount > 0) {
            result.add(
                PreparationStage(
                    label = "Pi providers",
                    detail = if (settings.status == "installing") {
                        "Installing Claude Agent SDK and Meta OAuth support"
                    } else {
                        stageDetail(settings.status)
                    },
                    status = settings.status,
                ),
            )
        }

        val bake = config.bake
        if (bake != null) {
            result.add(
                PreparationStage(
                    label = "Bake script",
                    detail = if (bake.status == "running") {
                        "Running the environment bake script"
                    } else {
                        "${stageDetail(bake.status)} · ${bake.mode}"
                    },
                    status = bake.status,
                ),
            )
        }

        config.initSteps.orEmpty().forEach { step ->
            result.add(
                PreparationStage(
                    label = "${initLabel(step.scope)} setup",
                    detail = if (step.status == "running") {
                        "Running the init script"
                    } else {
                        stageDetail(step.status)
                    },
                    status = step.status,
                ),
            )
        }
        return result
    }

    /**
     * The queue, with the server's own deadline when it sent one. Counted the
     * same way the pod status line counts it, so the two never disagree.
     */
    private fun capacityDetail(pod: Pod): String {
        val wait = pod.capacityWait?.takeIf { it.isWaiting } ?: return WAITING_FOR_CAPACITY_DETAIL
        val secondsLeft = ceil(wait.deadlineInMs / 1000.0).toInt().coerceIn(0, 1 shl 30)
        if (secondsLeft <= 0) return WAITING_FOR_CAPACITY_DETAIL
        return "$WAITING_FOR_CAPACITY_DETAIL · ~${secondsLeft}s left"
    }

    fun stageDetail(status: String): String = when (status) {
        "ok", "ready" -> "Ready"
        "skipped" -> "Not needed"
        "pending" -> "Waiting"
        "degraded" -> "Finished with a warning"
        "failed" -> "Failed"
        else -> capitalized(status.replace("_", " "))
    }

    fun initLabel(scope: String): String = when (scope) {
        "org" -> "Organization"
        "template" -> "Environment"
        "project" -> "Project"
        else -> capitalized(scope)
    }

    private fun capitalized(value: String): String =
        if (value.isEmpty()) value else value[0].uppercase() + value.substring(1)

    /** `PodPreparationPhase` from the server, for a pod queued behind the fleet. */
    const val WAITING_FOR_CAPACITY = "waiting-for-capacity"

    private const val WAITING_FOR_CAPACITY_DETAIL = "Waiting for capacity"
}

object SandboxPreparationTestTags {
    const val ROOT = "sandbox-preparation"

    fun stage(index: Int) = "sandbox-stage-$index"
}
