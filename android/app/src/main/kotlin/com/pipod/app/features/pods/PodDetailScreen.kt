package com.pipod.app.features.pods

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.PodResolvedConfig
import com.pipod.app.core.api.model.PolicyClamp
import com.pipod.app.core.format.PodLifecycle
import com.pipod.app.core.format.PodPresentation
import com.pipod.app.features.common.WorkstationWaitCard
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppActionSheet
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonContent
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.AppSeparator
import com.pipod.app.ui.AppSheetAction
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.rememberAppToastHostState
import com.pipod.app.ui.showAppToast
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** The lifecycle actions the overflow menu offers. */
private enum class PodAction { Refresh, Stop, Archive, Delete }

/**
 * The pod detail, wired to its view model.
 *
 * Port of `pi-pod-flutter/lib/features/pods/pod_detail_view.dart`.
 *
 * @param onEditAndRetry receives the failed pod's environment id, or null for a
 *   pod launched without one. Retry mode travels explicitly rather than being
 *   inferred from that id: an empty pod carries no environment, and inferring
 *   would title its retry "New pod".
 */
@Composable
fun PodDetailScreen(
    viewModel: PodDetailViewModel,
    onBack: () -> Unit,
    onOpenSession: () -> Unit,
    onEditAndRetry: (templateId: String?) -> Unit,
    onOpenHostPod: (hostPodId: String) -> Unit,
    onBackToPods: () -> Unit,
    modifier: Modifier = Modifier,
    showsOpenSession: Boolean = false,
    onDeleted: () -> Unit = onBack,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    // The screen owns the host rather than reading the ambient one: AppScaffold
    // provides its own only *inside* its content, so a toast raised from out
    // here would go to a host nobody renders.
    val toasts = rememberAppToastHostState()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is PodDetailEvent.Toast -> showAppToast(toasts, event.message)
                PodDetailEvent.Deleted -> onDeleted()
            }
        }
    }

    LaunchedEffect(viewModel) {
        while (true) {
            delay(POD_DETAIL_POLL_INTERVAL_MS)
            viewModel.pollIfInitializing()
        }
    }

    PodDetailScreen(
        state = state,
        onBack = onBack,
        onRefresh = viewModel::refresh,
        onRunCommand = viewModel::runCommand,
        onCancelWait = viewModel::cancelCapacityWait,
        onCancelWorkstationWait = viewModel::cancelWorkstationWait,
        onRetryWorkstation = viewModel::retryAfterWorkstationWait,
        onDelete = viewModel::delete,
        onDismissCascadePrompt = viewModel::dismissCascadePrompt,
        onOpenSession = onOpenSession,
        onEditAndRetry = { onEditAndRetry(state.pod?.templateId) },
        onOpenHostPod = onOpenHostPod,
        onBackToPods = onBackToPods,
        modifier = modifier,
        showsOpenSession = showsOpenSession,
        toastHostState = toasts,
    )
}

/** The pod detail as a pure function of [state]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PodDetailScreen(
    state: PodDetailState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onRunCommand: (String) -> Unit,
    onCancelWait: () -> Unit,
    onDelete: (cascade: Boolean) -> Unit,
    onOpenSession: () -> Unit,
    onEditAndRetry: () -> Unit,
    onOpenHostPod: (hostPodId: String) -> Unit,
    onBackToPods: () -> Unit,
    onCancelWorkstationWait: () -> Unit = {},
    onRetryWorkstation: () -> Unit = {},
    modifier: Modifier = Modifier,
    showsOpenSession: Boolean = false,
    onDismissCascadePrompt: () -> Unit = {},
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
    toastHostState: SnackbarHostState = rememberAppToastHostState(),
) {
    if (state.notFound) {
        PodNotFound(
            message = "This pod no longer exists, or you don’t have access",
            onBackToPods = onBackToPods,
            modifier = modifier,
        )
        return
    }

    val pod = state.pod
    if (pod == null) {
        AppScaffold(
            modifier = modifier.testTag(PodDetailTestTags.SCREEN),
            title = "Pod",
            onNavigateBack = onBack,
            grouped = true,
            toastHostState = toastHostState,
        ) { insets ->
            Box(Modifier.fillMaxSize().padding(insets), Alignment.Center) {
                val error = state.error
                if (error == null) {
                    AppActivityIndicator(
                        modifier = Modifier.semantics {
                            contentDescription = "Loading pod details"
                            liveRegion = LiveRegionMode.Polite
                        },
                    )
                } else {
                    DetailLoadError(message = error, onRetry = onRefresh)
                }
            }
        }
        return
    }

    var showingActions by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    AppScaffold(
        modifier = modifier.testTag(PodDetailTestTags.SCREEN),
        title = pod.name,
        onNavigateBack = onBack,
        grouped = true,
        toastHostState = toastHostState,
        actions = {
            if (state.isDeleting) {
                Box(
                    Modifier
                        .size(AppButtonDefaults.MinTouchTarget)
                        .semantics { contentDescription = "Pod actions" },
                    contentAlignment = Alignment.Center,
                ) {
                    AppActivityIndicator(size = 18.dp)
                }
            } else {
                AppIconButton(
                    icon = AppIcons.more,
                    onClick = { showingActions = true },
                    semanticsLabel = "Pod actions",
                    enabled = state.workingCommand == null,
                    modifier = Modifier.testTag(PodDetailTestTags.ACTIONS_BUTTON),
                )
            }
        },
    ) { insets ->
        PullToRefreshBox(
            // The explicit refresh only. The 4-second poll behind a starting
            // pod must not spin this: an indicator that appears on its own
            // reads as the screen having hung.
            isRefreshing = state.isRefreshing,
            onRefresh = onRefresh,
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .semantics {
                    customActions = listOf(
                        CustomAccessibilityAction("Refresh pod details") {
                            onRefresh()
                            true
                        },
                    )
                },
        ) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 32.dp),
            ) {
                // A named marker for the screen as a whole: the bar title is just
                // the pod's name, which says nothing about what is being shown.
                Spacer(
                    Modifier
                        .height(1.dp)
                        .fillMaxWidth()
                        .testTag(PodDetailTestTags.MARKER)
                        .semantics { contentDescription = "Pod detail: ${pod.name}" },
                )
                // The reader's own workstation comes first: while it is starting,
                // every other row on this screen is describing a pod that cannot
                // move until it finishes.
                val workstationWait = state.workstationWait
                if (workstationWait != null) {
                    WorkstationWaitCard(
                        state = workstationWait,
                        onCancel = onCancelWorkstationWait,
                        onRetry = onRetryWorkstation,
                    )
                    Spacer(Modifier.height(12.dp))
                }
                StatusCard(
                    pod = pod,
                    workingCommand = state.workingCommand,
                    workstationWaiting = workstationWait != null,
                    showsOpenSession = showsOpenSession,
                    onOpenSession = onOpenSession,
                    onRestore = { onRunCommand("restore") },
                    onCancelWait = onCancelWait,
                    onEditAndRetry = onEditAndRetry,
                )
                Spacer(Modifier.height(12.dp))
                InfoCard(
                    pod = pod,
                    templateLabel = state.templateLabel,
                    onOpenHostPod = onOpenHostPod,
                )
                Spacer(Modifier.height(12.dp))
                LaunchReportCard(pod = pod)
                val error = state.error
                if (error != null) {
                    Spacer(Modifier.height(12.dp))
                    AppListSection(modifier = Modifier.testTag(PodDetailTestTags.ERROR_CARD)) {
                        row {
                            Column(
                                Modifier
                                    .fillMaxWidth()
                                    .background(appColors.destructiveFill)
                                    .padding(16.dp),
                            ) {
                                Text(error)
                                Spacer(Modifier.height(8.dp))
                                AppButton(
                                    text = "Try refreshing",
                                    onClick = onRefresh,
                                    kind = AppButtonKind.Plain,
                                    semanticsLabel = "Try refreshing pod details",
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showingActions) {
        AppActionSheet(
            actions = buildList {
                add(AppSheetAction(PodAction.Refresh, "Refresh status", AppIcons.refresh))
                if (state.canStopSandbox) {
                    add(AppSheetAction(PodAction.Stop, "Stop sandbox", AppIcons.stop))
                }
                if (pod.isLive) {
                    add(AppSheetAction(PodAction.Archive, "Archive", AppIcons.archive))
                }
                add(
                    AppSheetAction(
                        PodAction.Delete,
                        "Delete pod",
                        AppIcons.delete,
                        destructive = true,
                    ),
                )
            },
            onSelected = { action ->
                showingActions = false
                when (action) {
                    null -> Unit
                    PodAction.Refresh -> onRefresh()
                    // Stop and Archive are not two words for one thing, and the
                    // copy says which is which: Stop gives the machine back
                    // now and leaves the pod where it is; Archive hides the row
                    // and only releases compute when the reaper gets to it.
                    PodAction.Stop -> scope.launch {
                        val confirmed = dialogs.confirm(
                            title = "Stop this pod’s sandbox?",
                            message = "Compute is released now and the running session ends. " +
                                "The pod stays in the list with its disk intact and restarts " +
                                "in seconds. Archive is different: it hides the pod and keeps " +
                                "the disk, but does not free the machine now.",
                            confirmLabel = "Stop sandbox",
                            confirmSemanticsLabel = "Stop sandbox for ${pod.name}",
                            cancelSemanticsLabel = "Cancel stopping the sandbox",
                        )
                        if (confirmed) onRunCommand(PodDetailViewModel.STOP)
                    }

                    PodAction.Archive -> scope.launch {
                        val confirmed = dialogs.confirm(
                            title = "Archive this pod?",
                            message = "This stops the pod and hides it from your list. Its files " +
                                "are kept: restore it from the Archived filter whenever you need it.",
                            confirmLabel = "Archive pod",
                            confirmSemanticsLabel = "Archive pod",
                            cancelSemanticsLabel = "Cancel archiving pod",
                        )
                        if (confirmed) onRunCommand("archive")
                    }

                    PodAction.Delete -> scope.launch {
                        val confirmed = dialogs.confirm(
                            title = "Delete ${pod.name}?",
                            message = "This removes the remote sandbox and its uncommitted work. " +
                                "This can’t be undone.",
                            confirmLabel = "Delete pod permanently",
                            confirmSemanticsLabel = "Delete pod permanently",
                            // Cancel stays a lone node: its name never embeds the
                            // confirm name ("Cancel Delete pod permanently" read
                            // as one merged instruction).
                            cancelSemanticsLabel = "Cancel deleting ${pod.name}",
                            destructive = true,
                        )
                        if (confirmed) onDelete(false)
                    }
                }
            },
        )
    }

    // The server refuses to orphan co-located children and names them. That is
    // a second question, not a failure, so it is asked rather than reported.
    val blockers = state.cascadeBlockers
    LaunchedEffect(blockers) {
        if (blockers.isEmpty()) return@LaunchedEffect
        val confirmed = dialogs.confirm(
            title = "Delete ${pod.name} and its ${podCount(blockers.size)}?",
            message = "${pod.name} still hosts ${childList(blockers)}. " +
                "Deleting it removes the machine those run on, so they go too. " +
                "This can’t be undone.",
            confirmLabel = "Delete all ${blockers.size + 1}",
            confirmSemanticsLabel = "Delete ${pod.name} and every pod it hosts",
            cancelSemanticsLabel = "Keep ${pod.name} and the pods it hosts",
            destructive = true,
        )
        onDismissCascadePrompt()
        if (confirmed) onDelete(true)
    }

    AppDialogHost(dialogs)
}

private fun podCount(count: Int): String = if (count == 1) "1 hosted pod" else "$count hosted pods"

/** The children by name, capped so the dialog stays a dialog. */
private fun childList(children: List<CascadeChild>): String {
    val names = children.take(4).map { it.name }
    val rest = children.size - names.size
    val listed = when (names.size) {
        1 -> names[0]
        else -> names.dropLast(1).joinToString(", ") + " and " + names.last()
    }
    return if (rest <= 0) listed else "$listed, and $rest more"
}

@Composable
private fun StatusCard(
    pod: Pod,
    workingCommand: String?,
    workstationWaiting: Boolean,
    showsOpenSession: Boolean,
    onOpenSession: () -> Unit,
    onRestore: () -> Unit,
    onCancelWait: () -> Unit,
    onEditAndRetry: () -> Unit,
) {
    val presentation = PodPresentation.fromPod(pod)
    val statusColor = appColors.tone(presentation.tone)
    val reason = presentation.userFacingReason
    val canRetryLaunch = presentation.lifecycle == PodLifecycle.Failed &&
        (
            pod.sandboxState == "error" ||
                pod.preparationPhase == "failed" ||
                pod.state == "failed"
            )

    AppListSection(modifier = Modifier.testTag(PodDetailTestTags.STATUS_CARD)) {
        row {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                if (workingCommand != null) {
                    val label = PodDetailViewModel.actionLabel(workingCommand)
                    Row(
                        modifier = Modifier.semantics {
                            contentDescription = label
                            liveRegion = LiveRegionMode.Polite
                        },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AppActivityIndicator(size = 20.dp)
                        Spacer(Modifier.width(12.dp))
                        Text(label)
                    }
                } else {
                    val detail = presentation.statusDetail
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .semantics(mergeDescendants = true) {
                                contentDescription = if (detail == null) {
                                    "Status, ${presentation.statusLabel}"
                                } else {
                                    "Status, ${presentation.statusLabel}, $detail"
                                }
                                if (presentation.isTransitional) {
                                    liveRegion = LiveRegionMode.Polite
                                }
                            },
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("Status")
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                PodStateIcon(presentation = presentation, size = 18.dp)
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = presentation.statusLabel,
                                    color = statusColor,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                        }
                        if (detail != null) {
                            Spacer(Modifier.height(6.dp))
                            Text(
                                text = detail,
                                style = MaterialTheme.typography.bodySmall,
                                color = appColors.secondaryLabel,
                            )
                        }
                    }
                }

                if (reason != null) {
                    Spacer(Modifier.height(12.dp))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag(PodDetailTestTags.FAILURE_REASON)
                            .semantics(mergeDescendants = true) {
                                contentDescription = "Pod failure: $reason"
                            },
                        verticalAlignment = Alignment.Top,
                    ) {
                        PodStateIcon(presentation = presentation)
                        Spacer(Modifier.width(8.dp))
                        Text(text = reason, color = statusColor, modifier = Modifier.weight(1f))
                    }
                }

                if (showsOpenSession) {
                    Spacer(Modifier.height(12.dp))
                    AppButton(
                        onClick = onOpenSession,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag(PodDetailTestTags.OPEN_SESSION),
                        enabled = pod.canOpenConversation,
                        semanticsLabel = "Open session for ${pod.name}",
                    ) {
                        AppButtonContent(icon = AppIcons.brand, label = "Open session")
                    }
                }

                // A queued launch/wake holds one concurrency slot but no host
                // reservation. Cancelling ends the wait cooperatively and keeps
                // the pod row; deleting the pod ends it too.
                if (pod.capacityWait?.isWaiting == true) {
                    Spacer(Modifier.height(12.dp))
                    AppButton(
                        onClick = onCancelWait,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag(PodDetailTestTags.CANCEL_WAIT),
                        kind = AppButtonKind.Plain,
                        enabled = workingCommand == null,
                        semanticsLabel = "Cancel capacity wait for ${pod.name}",
                    ) {
                        AppButtonContent(icon = AppIcons.close, label = "Cancel wait")
                    }
                }

                if (canRetryLaunch) {
                    Spacer(Modifier.height(12.dp))
                    AppButton(
                        onClick = onEditAndRetry,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag(PodDetailTestTags.EDIT_AND_RETRY),
                        kind = AppButtonKind.Tinted,
                        enabled = workingCommand == null,
                        semanticsLabel = "Edit and retry pod ${pod.name}",
                    ) {
                        AppButtonContent(icon = AppIcons.edit, label = "Edit & retry")
                    }
                } else if (!pod.isLive) {
                    Spacer(Modifier.height(12.dp))
                    AppButton(
                        onClick = onRestore,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag(PodDetailTestTags.RESTORE),
                        kind = AppButtonKind.Tinted,
                        enabled = workingCommand == null,
                        semanticsLabel = "Restore pod ${pod.name}",
                    ) {
                        AppButtonContent(icon = AppIcons.restore, label = "Restore")
                    }
                    // The pod's own restart is quick — but not while the machine
                    // under it is still coming up, which is minutes. The
                    // workstation card above is saying so; a "restarts in
                    // seconds" promise beside it would contradict it.
                    if (!workstationWaiting) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            text = if (pod.sandboxState == "stopped") {
                                if (pod.provider == "sandbox") {
                                    "Restarts in seconds · local disk retained"
                                } else {
                                    "Restarts in seconds · files retained"
                                }
                            } else {
                                "In cold storage · restores on next use, in seconds to minutes"
                            },
                            textAlign = TextAlign.Center,
                            style = MaterialTheme.typography.bodySmall,
                            color = appColors.secondaryLabel,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun InfoCard(pod: Pod, templateLabel: String, onOpenHostPod: (String) -> Unit) {
    val network = when (pod.resolvedConfig.egress.mode) {
        "open" -> "Open"
        "none", "blocked" -> "Blocked"
        else -> "Restricted"
    }
    val hostName = pod.hostPodName?.trim()?.takeIf { it.isNotEmpty() }

    AppListSection(modifier = Modifier.testTag(PodDetailTestTags.INFO_CARD)) {
        row {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                Text("Pod information", style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.height(12.dp))
                pod.projectName?.let { LabeledValue(label = "Project", value = it) }
                LabeledValue(label = "Environment", value = templateLabel)
                LabeledValue(label = "Location", value = pod.displayLocation)
                if (pod.isHostChild) {
                    val hostPodId = pod.hostPodId
                    LabeledValue(
                        label = "Host",
                        value = hostName ?: hostPodId.orEmpty(),
                        onClick = if (hostPodId == null) null else { { onOpenHostPod(hostPodId) } },
                    )
                }
                LabeledValue(label = "Network", value = network)
                pod.resolvedConfig.idleTimeoutMinutes?.let { minutes ->
                    LabeledValue(label = "Idle timeout", value = "$minutes minutes")
                    clampsFor(pod.resolvedConfig.clamps, "idleTimeoutMinutes")
                        .forEach { PolicyMessage(it) }
                }
                pod.resolvedConfig.archiveAfterMinutes?.let { minutes ->
                    LabeledValue(label = "Cold storage after", value = "$minutes minutes")
                    clampsFor(pod.resolvedConfig.clamps, "archiveAfterMinutes")
                        .forEach { PolicyMessage(it) }
                }
                AppSeparator()
                Spacer(Modifier.height(8.dp))
                val retention = buildList {
                    pod.resolvedConfig.idleTimeoutMinutes?.let { add("$it min idle stop") }
                    pod.resolvedConfig.archiveAfterMinutes?.let { add("$it min to cold storage") }
                }.joinToString(" · ")
                if (retention.isNotEmpty()) {
                    Text(
                        text = retention,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.height(4.dp))
                }
                Text(
                    text = if (pod.isHostChild) {
                        "Shares ${hostName ?: "the host pod"}’s machine. " +
                            "The host’s idle timer governs this pod."
                    } else {
                        "Runs on your organization's sandbox provider. " +
                            "Idle pods sleep and restore automatically."
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

/**
 * One `label: value` line.
 *
 * A link row is a full-height target: 48dp minimum, a chevron affordance, and
 * one node carrying the name and the tap.
 */
@Composable
private fun LabeledValue(label: String, value: String, onClick: (() -> Unit)? = null) {
    val naming = Modifier.semantics(mergeDescendants = true) {
        contentDescription = "$label, $value"
        if (onClick != null) role = Role.Button
    }
    if (onClick == null) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 5.dp)
                .then(naming),
            verticalAlignment = Alignment.Top,
        ) {
            Text(label, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(16.dp))
            Text(
                text = value,
                textAlign = TextAlign.End,
                fontWeight = FontWeight.Medium,
            )
        }
        return
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = AppButtonDefaults.MinTouchTarget)
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp)
            .then(naming),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(16.dp))
        Text(
            text = value,
            textAlign = TextAlign.End,
            fontWeight = FontWeight.Medium,
            color = appColors.accent,
        )
        Spacer(Modifier.width(4.dp))
        Icon(
            imageVector = AppIcons.chevron,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = appColors.tertiaryLabel,
        )
    }
}

/** A value the organization's policy replaced, said beside the value it changed. */
@Composable
private fun PolicyMessage(clamp: PolicyClamp) {
    val reason = clamp.reason.trim()
    val message = if (reason.isEmpty()) {
        "Organization policy changed this value"
    } else {
        reason.replaceFirstChar { it.uppercase() }
    }
    Text(
        text = message,
        color = appColors.noticeText,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.padding(bottom = 6.dp),
    )
}

private fun clampsFor(clamps: List<PolicyClamp>, field: String): List<PolicyClamp> =
    clamps.filter { it.path.substringAfterLast('.') == field }

/** What the launch actually did, folded away until it is asked for. */
@Composable
private fun LaunchReportCard(pod: Pod) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val config = pod.resolvedConfig
    val presentation = PodPresentation.fromPod(pod)
    val userWarnings = remember(config) { userFacingWarnings(config) }
    val attention = remember(config, userWarnings) { attentionFor(config, userWarnings) }
    val verb = if (expanded) "Collapse" else "Expand"

    AppListSection(modifier = Modifier.testTag(PodDetailTestTags.LAUNCH_REPORT)) {
        row {
            Box(Modifier.padding(bottom = if (expanded) 8.dp else 0.dp)) {
                AppListTile(
                    title = { Text("Launch report") },
                    subtitle = if (attention == null) null else { { Text(attention) } },
                    trailing = {
                        Icon(
                            imageVector = AppIcons.expand,
                            contentDescription = null,
                            tint = appColors.secondaryLabel,
                        )
                    },
                    onClick = { expanded = !expanded },
                    modifier = Modifier.testTag(PodDetailTestTags.LAUNCH_REPORT_TOGGLE),
                    semanticsLabel = if (attention == null) {
                        "$verb launch report"
                    } else {
                        "$verb launch report, $attention"
                    },
                    semanticsExpanded = expanded,
                )
            }
        }
        if (expanded) {
            row {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 16.dp),
                ) {
                    config.initSteps.orEmpty().forEach { step ->
                        LabeledValue(
                            label = "${initStepLabel(step.scope)} setup",
                            value = step.status,
                        )
                    }
                    config.piSettings?.let { settings ->
                        LabeledValue(
                            label = "Your pi settings",
                            value = if (settings.files.isEmpty()) {
                                "None"
                            } else {
                                val noun = if (settings.files.size == 1) "file" else "files"
                                val partial = if (settings.status == "degraded") {
                                    ", partly applied"
                                } else {
                                    ""
                                }
                                "${settings.files.size} $noun$partial"
                            },
                        )
                        if (settings.droppedKeys.isNotEmpty()) {
                            LabeledValue(
                                label = "Left out",
                                value = settings.droppedKeys.joinToString(", "),
                            )
                        }
                    }
                    if (config.secretKeys.isNotEmpty()) {
                        LabeledValue(
                            label = "Secrets sent",
                            value = config.secretKeys.joinToString(", ") { key ->
                                val scope = config.secretScopes?.get(key)
                                if (scope == null) key else "$key ($scope)"
                            },
                        )
                    }
                    config.clamps.forEach { PolicyMessage(it) }
                    userWarnings.forEach { warning ->
                        Text(
                            text = warning,
                            color = appColors.warning,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    AppSeparator()
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "Technical details",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    LabeledValue(label = "Provider", value = pod.provider)
                    presentation.image?.let { LabeledValue(label = "Image", value = it) }
                }
            }
        }
    }
}

/**
 * Warnings written for whoever runs the server are not warnings for whoever
 * launched the pod, and there is nothing the reader could do about them.
 */
private fun userFacingWarnings(config: PodResolvedConfig): List<String> {
    val operatorMarkers = listOf("PUBLIC_URL", "call back to the server", "is not configured")
    return config.warnings.filter { warning ->
        operatorMarkers.none { warning.contains(it, ignoreCase = true) }
    }
}

/** The one line the folded report shows, when something wants looking at. */
private fun attentionFor(config: PodResolvedConfig, userWarnings: List<String>): String? {
    if (userWarnings.isNotEmpty()) {
        return if (userWarnings.size == 1) "1 warning" else "${userWarnings.size} warnings"
    }
    if (config.initSteps?.any { it.status != "ok" } == true) {
        return "A setup script didn’t finish cleanly"
    }
    if (config.piSettings?.status == "degraded") return "Some of your pi settings were left out"
    return null
}

private fun initStepLabel(scope: String): String = when (scope) {
    "org" -> "Organization"
    "template" -> "Environment"
    "repo" -> "Project"
    else -> scope.replaceFirstChar { it.uppercase() }
}

@Composable
private fun DetailLoadError(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = message, textAlign = TextAlign.Center)
        Spacer(Modifier.height(16.dp))
        AppButton(
            text = "Try again",
            onClick = onRetry,
            semanticsLabel = "Retry loading pod details",
        )
    }
}

/**
 * The screen a dead pod link lands on, ported from
 * `pi-pod-flutter/lib/shell/not_found_page.dart` with the pod-specific message.
 */
@Composable
private fun PodNotFound(message: String, onBackToPods: () -> Unit, modifier: Modifier = Modifier) {
    AppScaffold(
        modifier = modifier.testTag(PodDetailTestTags.NOT_FOUND),
        title = "pi pod",
        grouped = true,
    ) { insets ->
        Box(Modifier.fillMaxSize().padding(insets), Alignment.Center) {
            Column(
                modifier = Modifier.padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    imageVector = AppIcons.lost,
                    contentDescription = null,
                    modifier = Modifier.size(56.dp),
                    tint = appColors.secondaryLabel,
                )
                Spacer(Modifier.height(16.dp))
                Text(text = message, textAlign = TextAlign.Center)
                Spacer(Modifier.height(24.dp))
                AppButton(
                    text = "Back to Pods",
                    onClick = onBackToPods,
                    semanticsLabel = "Back to Pods",
                )
            }
        }
    }
}

/** The handles a UI test finds this screen's parts by. */
object PodDetailTestTags {
    const val SCREEN = "pod-detail-screen"
    const val MARKER = "pod-detail-marker"
    const val ACTIONS_BUTTON = "pod-detail-actions"
    const val STATUS_CARD = "pod-detail-status"
    const val INFO_CARD = "pod-detail-info"
    const val LAUNCH_REPORT = "pod-detail-launch-report"
    const val LAUNCH_REPORT_TOGGLE = "pod-detail-launch-report-toggle"
    const val FAILURE_REASON = "pod-detail-failure"
    const val OPEN_SESSION = "pod-detail-open-session"
    const val CANCEL_WAIT = "pod-detail-cancel-wait"
    const val EDIT_AND_RETRY = "pod-detail-edit-retry"
    const val RESTORE = "pod-detail-restore"
    const val ERROR_CARD = "pod-detail-error"
    const val NOT_FOUND = "pod-detail-not-found"
}

/** How often a starting pod re-asks the server, as in the Dart. */
private const val POD_DETAIL_POLL_INTERVAL_MS = 4_000L
