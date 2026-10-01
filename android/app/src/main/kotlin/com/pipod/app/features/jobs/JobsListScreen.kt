package com.pipod.app.features.jobs

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.Job
import com.pipod.app.core.format.JobSchedule
import com.pipod.app.features.common.AdaptiveRefreshButton
import com.pipod.app.features.common.EmptyState
import com.pipod.app.features.common.RefreshErrorTile
import com.pipod.app.features.common.StatusChip
import com.pipod.app.features.common.UnsupportedListItemCard
import com.pipod.app.ui.AppActionSheet
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListScaffold
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppSectionStyle
import com.pipod.app.ui.AppSheetAction
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.rememberAppToastHostState
import com.pipod.app.ui.showAppToast
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/**
 * The jobs list, wired to its view model.
 *
 * Port of `JobsListView` in
 * `pi-pod-flutter/lib/features/jobs/jobs_list_view.dart`.
 */
@Composable
fun JobsListScreen(
    viewModel: JobListViewModel,
    onOpenJob: (Job) -> Unit,
    modifier: Modifier = Modifier,
    selectedJobId: String? = null,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    // The screen owns the host rather than reading the ambient one: AppScaffold
    // provides its own only *inside* its content, so a toast raised from out
    // here would go to a host nobody renders.
    val toasts = rememberAppToastHostState()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is JobListEvent.Toast -> showAppToast(toasts, event.message)
                is JobListEvent.Notice -> dialogs.notice(
                    title = event.title,
                    message = event.message,
                    dismissLabel = "OK",
                    dismissSemanticsLabel = "Dismiss jobs error",
                )
            }
        }
    }

    JobsListScreen(
        state = state,
        onRefresh = viewModel::refresh,
        onOpenJob = onOpenJob,
        onDelete = viewModel::delete,
        modifier = modifier,
        selectedJobId = selectedJobId,
        dialogs = dialogs,
        toastHostState = toasts,
    )
}

/** The jobs list as a pure function of [state]. */
@Composable
fun JobsListScreen(
    state: JobListState,
    onRefresh: () -> Unit,
    onOpenJob: (Job) -> Unit,
    onDelete: (Job) -> Unit,
    modifier: Modifier = Modifier,
    selectedJobId: String? = null,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
    toastHostState: SnackbarHostState = rememberAppToastHostState(),
) {
    val scope = rememberCoroutineScope()
    var actionsFor by remember { mutableStateOf<Job?>(null) }

    val confirmDelete: (Job) -> Unit = { job ->
        scope.launch {
            val confirmed = dialogs.confirm(
                title = "Delete ${job.name}?",
                // A shared job belongs to the organization: deleting it takes it
                // away from everyone, which the question has to say out loud.
                message = if (job.isOrgScoped) {
                    "This job is shared with your organization; deleting it removes it " +
                        "for everyone. Its schedule stops firing. Pods it already " +
                        "launched are unaffected."
                } else {
                    "Its schedule stops firing. Pods it already launched are unaffected."
                },
                confirmLabel = "Delete job",
                destructive = true,
                confirmSemanticsLabel = "Confirm delete job ${job.name}",
                // Cancel stays a lone node: its name never embeds the confirm name.
                cancelSemanticsLabel = "Cancel deleting job ${job.name}",
            )
            if (confirmed) onDelete(job)
        }
    }

    AppListScaffold(
        title = "Jobs",
        modifier = modifier.testTag(JobListTestTags.SCREEN),
        grouped = true,
        isRefreshing = state.isLoading && state.jobs.isNotEmpty(),
        onRefresh = onRefresh,
        refreshSemanticsLabel = "Refresh jobs",
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 24.dp),
        toastHostState = toastHostState,
        actions = {
            AdaptiveRefreshButton(label = "Refresh jobs", onClick = onRefresh)
        },
    ) {
        jobListRows(
            state = state,
            selectedJobId = selectedJobId,
            onRefresh = onRefresh,
            onOpenJob = onOpenJob,
            onShowActions = { actionsFor = it },
        )
    }

    actionsFor?.let { job ->
        AppActionSheet(
            actions = listOf(
                AppSheetAction(
                    value = JobRowAction.Delete,
                    label = "Delete job",
                    icon = AppIcons.delete,
                    destructive = true,
                ),
            ),
            onSelected = { action ->
                actionsFor = null
                if (action == JobRowAction.Delete) confirmDelete(job)
            },
        )
    }

    AppDialogHost(dialogs)
}

/** The only thing the row's overflow menu offers today. */
private enum class JobRowAction { Delete }

private fun LazyListScope.jobListRows(
    state: JobListState,
    selectedJobId: String?,
    onRefresh: () -> Unit,
    onOpenJob: (Job) -> Unit,
    onShowActions: (Job) -> Unit,
) {
    if (state.showsInitialSpinner) {
        item(key = "loading") {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics(mergeDescendants = true) {
                        contentDescription = "Loading jobs"
                        liveRegion = LiveRegionMode.Polite
                    },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(180.dp))
                AppActivityIndicator()
                Spacer(Modifier.height(12.dp))
                Text("Loading jobs…")
            }
        }
        return
    }

    if (state.showsEmptyState) {
        item(key = "empty") {
            val failed = state.loadError != null
            EmptyState(
                icon = if (failed) AppIcons.offline else AppIcons.jobs,
                title = if (failed) "Couldn’t load jobs" else "No jobs yet",
                message = state.loadError
                    ?: "A job is a prompt on a schedule: at each tick the server launches a pod " +
                    "and hands the prompt to pi. Ask pi inside a pod to schedule one — it " +
                    "appears here as soon as it is created.",
                actionLabel = if (failed) "Try again" else null,
                actionSemanticsLabel = if (failed) "Try loading jobs again" else null,
                onAction = if (failed) onRefresh else null,
            )
        }
        return
    }

    val loadError = state.loadError
    if (loadError != null) {
        item(key = "refresh-error") {
            RefreshErrorTile(
                message = loadError,
                onRetry = onRefresh,
                retrySemanticsLabel = "Retry refreshing jobs",
            )
        }
    }

    for (index in 0 until state.unsupportedJobCount) {
        item(key = "unsupported-job-$index") {
            UnsupportedListItemCard(itemName = "schedule")
        }
    }

    // There is no draft job: the server's status vocabulary is active, paused
    // and completed, so a "waiting for your approval" section never had rows.
    jobSection(
        key = JobListTestTags.ACTIVE_SECTION,
        title = "Active",
        footer = null,
        jobs = state.active,
        state = state,
        selectedJobId = selectedJobId,
        onOpenJob = onOpenJob,
        onShowActions = onShowActions,
    )
    jobSection(
        key = JobListTestTags.PAUSED_SECTION,
        title = "Paused",
        footer = null,
        jobs = state.paused,
        state = state,
        selectedJobId = selectedJobId,
        onOpenJob = onOpenJob,
        onShowActions = onShowActions,
    )
    jobSection(
        key = JobListTestTags.COMPLETED_SECTION,
        title = "Completed",
        footer = null,
        jobs = state.completed,
        state = state,
        selectedJobId = selectedJobId,
        onOpenJob = onOpenJob,
        onShowActions = onShowActions,
    )
}

private fun LazyListScope.jobSection(
    key: String,
    title: String,
    footer: String?,
    jobs: List<Job>,
    state: JobListState,
    selectedJobId: String?,
    onOpenJob: (Job) -> Unit,
    onShowActions: (Job) -> Unit,
) {
    if (jobs.isEmpty()) return
    item(key = key) {
        AppListSection(
            modifier = Modifier.testTag(key),
            header = title,
            footer = footer,
            style = AppSectionStyle.Separated,
        ) {
            items(jobs) { job ->
                JobRow(
                    job = job,
                    isSelected = job.id == selectedJobId,
                    isDeleting = state.isDeleting(job.id),
                    onOpen = { onOpenJob(job) },
                    onShowActions = { onShowActions(job) },
                )
            }
        }
    }
}

/**
 * One job.
 *
 * The name and the tap live on one node, so a screen reader announces an
 * actionable row instead of static text beside an unlabeled button.
 */
@Composable
private fun JobRow(
    job: Job,
    isSelected: Boolean,
    isDeleting: Boolean,
    onOpen: () -> Unit,
    onShowActions: () -> Unit,
) {
    val colors = appColors
    val subtitle = JobSchedule.summary(job.trigger)
    val status = jobStatusText(job)
    val statusColor = if (job.isActive) colors.success else colors.secondaryLabel
    val shared = job.isOrgScoped

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (isDeleting) 0.5f else 1f)
            .testTag(JobListTestTags.row(job.id)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AppListTile(
            modifier = Modifier
                .weight(1f)
                .semantics(mergeDescendants = true) { },
            onClick = onOpen,
            enabled = !isDeleting,
            selected = isSelected,
            backgroundColor = if (isSelected) colors.accent.copy(alpha = 0.12f) else null,
            semanticsLabel = listOfNotNull(
                "Open job ${job.name}",
                subtitle,
                status,
                JobScopeCopy.SHARED_LABEL.takeIf { shared },
            ).joinToString(", "),
            title = { Text(text = job.name, fontWeight = FontWeight.SemiBold) },
            subtitle = {
                Column {
                    Text(subtitle)
                    if (shared) {
                        Box(Modifier.padding(top = 4.dp).testTag(JobListTestTags.shared(job.id))) {
                            StatusChip(label = JobScopeCopy.SHARED_CHIP, color = colors.info)
                        }
                    }
                }
            },
            trailing = { StatusChip(label = status, color = statusColor) },
        )
        Box(
            Modifier.size(AppButtonDefaults.MinTouchTarget),
            contentAlignment = Alignment.Center,
        ) {
            if (isDeleting) {
                AppActivityIndicator(
                    size = 18.dp,
                    modifier = Modifier
                        .testTag(JobListTestTags.deleting(job.id))
                        .semantics {
                            contentDescription = "Removing job ${job.name}"
                            liveRegion = LiveRegionMode.Polite
                        },
                )
            } else {
                AppIconButton(
                    icon = AppIcons.more,
                    onClick = onShowActions,
                    semanticsLabel = "More actions for job ${job.name}",
                    modifier = Modifier.testTag(JobListTestTags.more(job.id)),
                )
            }
        }
        Spacer(Modifier.width(4.dp))
    }
}

/**
 * How a job shared with the organization is described, in one place.
 *
 * `GET /v1/jobs` mixes the organization's shared schedules into your own list,
 * and pausing or deleting one of those affects everybody — so the label on the
 * row and the wording of the confirmations have to be the same words.
 */
object JobScopeCopy {
    /** The full phrase: the detail row, and every row's accessible name. */
    const val SHARED_LABEL = "Shared with organization"

    /**
     * The same fact, short enough to fit a chip. [StatusChip] caps itself at
     * 128dp so a label can never push a title off a narrow screen, and the full
     * phrase ellipsises against that cap into "Shared with organiza…".
     */
    const val SHARED_CHIP = "Shared with org"

    const val DELETE_WARNING =
        "This job is shared with your organization; deleting it removes it for " +
            "everyone. Its schedule stops firing. Pods it already launched are unaffected."

    const val PAUSE_WARNING =
        "This job is shared with your organization; pausing it stops the schedule " +
            "for everyone until someone resumes it."
}

/** The handles a UI test finds this screen's parts by. */
object JobListTestTags {
    const val SCREEN = "job-list-screen"
    const val ACTIVE_SECTION = "job-list-active"
    const val PAUSED_SECTION = "job-list-paused"
    const val COMPLETED_SECTION = "job-list-completed"

    fun row(id: String) = "job-row-$id"

    fun shared(id: String) = "job-row-shared-$id"

    fun more(id: String) = "job-row-more-$id"

    fun deleting(id: String) = "job-row-deleting-$id"
}
