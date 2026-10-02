package com.pipod.app.features.jobs

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.Job
import com.pipod.app.core.api.model.JobRun
import com.pipod.app.core.api.model.JobTrigger
import com.pipod.app.core.format.Format
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.format.JobSchedule
import com.pipod.app.features.common.UnsupportedListItemCard
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListScaffold
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.AppSelectableText
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import java.time.Instant
import kotlinx.coroutines.launch

/**
 * The job detail, wired to its view model.
 *
 * Port of `JobDetailView` and `JobDetailRoute` in
 * `pi-pod-flutter/lib/features/jobs/`.
 */
@Composable
fun JobDetailScreen(
    viewModel: JobDetailViewModel,
    onBack: () -> Unit,
    onOpenPod: (String) -> Unit,
    modifier: Modifier = Modifier,
    onDeleted: (() -> Unit)? = null,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                JobDetailEvent.Deleted -> (onDeleted ?: onBack).invoke()
            }
        }
    }

    JobDetailScreen(
        state = state,
        onBack = onBack,
        onRefresh = viewModel::refresh,
        onCommand = viewModel::command,
        onDelete = viewModel::delete,
        onOpenPod = onOpenPod,
        modifier = modifier,
        dialogs = dialogs,
    )
}

/** The job detail as a pure function of [state]. */
@Composable
fun JobDetailScreen(
    state: JobDetailState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onCommand: (String) -> Unit,
    onDelete: () -> Unit,
    onOpenPod: (String) -> Unit,
    modifier: Modifier = Modifier,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val job = state.job
    if (job == null) {
        JobDetailPlaceholder(
            error = state.resolveError,
            onBack = onBack,
            modifier = modifier,
        )
        return
    }

    val scope = rememberCoroutineScope()

    val confirmDelete: () -> Unit = {
        scope.launch {
            val confirmed = dialogs.confirm(
                title = "Delete “${job.name}”?",
                // Deleting a shared job takes it away from the whole
                // organization, which the question has to say before it is
                // answered rather than after.
                message = if (job.isOrgScoped) {
                    JobScopeCopy.DELETE_WARNING
                } else {
                    "Its schedule stops firing. Pods it already launched are unaffected."
                },
                confirmLabel = "Delete job",
                destructive = true,
                confirmSemanticsLabel = "Confirm delete job ${job.name}",
                cancelSemanticsLabel = "Cancel deleting ${job.name}",
            )
            if (confirmed) onDelete()
        }
    }

    // Pausing your own job is undone by one tap; pausing the organization's
    // stops it for everybody, so that one is asked first.
    val runCommand: (String) -> Unit = { command ->
        if (command == "pause" && job.isOrgScoped) {
            scope.launch {
                val confirmed = dialogs.confirm(
                    title = "Pause “${job.name}”?",
                    message = JobScopeCopy.PAUSE_WARNING,
                    confirmLabel = "Pause job",
                    confirmSemanticsLabel = "Confirm pause job ${job.name}",
                    cancelSemanticsLabel = "Keep running ${job.name}",
                )
                if (confirmed) onCommand(command)
            }
        } else {
            onCommand(command)
        }
    }

    AppListScaffold(
        title = job.name,
        modifier = modifier.testTag(JobDetailTestTags.SCREEN),
        // The title carries the screen's context as a header ('Job detail: X')
        // instead of wrapping the whole viewport in a labelled container node,
        // whose full-screen bounds swallowed the screen for screen readers.
        titleSemanticsLabel = "Job detail: ${job.name}",
        onNavigateBack = onBack,
        grouped = true,
        onRefresh = onRefresh,
        isRefreshing = state.isRefreshing,
        refreshSemanticsLabel = "Refresh job ${job.name}",
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 32.dp),
    ) {
        jobDetailRows(
            state = state,
            job = job,
            onCommand = runCommand,
            onDelete = confirmDelete,
            onOpenPod = onOpenPod,
        )
    }

    AppDialogHost(dialogs)
}

/** The screen while the job a link named is still being resolved, or was not. */
@Composable
private fun JobDetailPlaceholder(error: String?, onBack: () -> Unit, modifier: Modifier = Modifier) {
    AppScaffold(
        modifier = modifier.testTag(JobDetailTestTags.SCREEN),
        // No title until the job is resolved: the bar keeps the back control
        // and stays otherwise empty rather than carrying a blank word.
        onNavigateBack = onBack,
        grouped = true,
    ) { insets ->
        Box(
            Modifier.fillMaxSize().padding(insets).padding(24.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (error == null) {
                AppActivityIndicator(
                    modifier = Modifier.semantics { contentDescription = "Loading job" },
                )
            } else {
                Text(text = error, textAlign = TextAlign.Center)
            }
        }
    }
}

private fun LazyListScope.jobDetailRows(
    state: JobDetailState,
    job: Job,
    onCommand: (String) -> Unit,
    onDelete: () -> Unit,
    onOpenPod: (String) -> Unit,
) {
    val message = state.message
    if (message != null) {
        item(key = "message") {
            JobActionMessage(message = message, isError = state.isError)
            Spacer(Modifier.height(12.dp))
        }
    }

    item(key = "status") {
        JobStatusCard(state = state, job = job)
        Spacer(Modifier.height(12.dp))
    }

    item(key = "schedule") {
        JobScheduleCard(job.trigger, nextRunAt = job.nextRunAt)
        Spacer(Modifier.height(12.dp))
    }

    item(key = "prompt") {
        JobSectionCard(
            title = "Prompt",
            footer = "pi receives exactly this text in a fresh pod at every run.",
            modifier = Modifier.testTag(JobDetailTestTags.PROMPT_CARD),
        ) {
            AppSelectableText(
                text = job.prompt,
                style = MonospaceTextStyle,
                semanticsLabel = "Prompt: ${job.prompt}",
            )
        }
        Spacer(Modifier.height(12.dp))
    }

    item(key = "runs-with") {
        JobSectionCard(title = "Runs with", modifier = Modifier.testTag(JobDetailTestTags.CONFIG_CARD)) {
            JobLabeledValue(label = "Environment", value = state.environmentLabel)
            JobLabeledValue(label = "Model", value = job.model)
        }
        Spacer(Modifier.height(12.dp))
    }

    if (state.showsRuns) {
        item(key = "runs") {
            AppListSection(
                modifier = Modifier.testTag(JobDetailTestTags.RUNS_SECTION),
                header = "Recent runs",
            ) {
                items(state.runs) { run ->
                    JobRunRow(
                        run = run,
                        onOpenPod = run.podId?.let { podId -> { onOpenPod(podId) } },
                    )
                }
            }
        }
        // A card cannot sit inside a card: the placeholder for a run this build
        // could not read is its own row below the section rather than a nested
        // one inside it.
        for (index in 0 until state.unsupportedRunCount) {
            item(key = "unsupported-run-$index") { UnsupportedListItemCard(itemName = "job run") }
        }
        item(key = "runs-gap") { Spacer(Modifier.height(12.dp)) }
    }

    item(key = "actions") {
        JobActionsCard(state = state, job = job, onCommand = onCommand, onDelete = onDelete)
    }
}

@Composable
private fun JobActionMessage(message: String, isError: Boolean) {
    val colors = appColors
    AppListSection(modifier = Modifier.testTag(JobDetailTestTags.MESSAGE)) {
        row {
            AppListTile(
                modifier = Modifier.semantics(mergeDescendants = true) {
                    liveRegion = LiveRegionMode.Polite
                },
                backgroundColor = if (isError) {
                    colors.destructiveFill
                } else {
                    colors.success.copy(alpha = 0.12f)
                },
                leading = {
                    Icon(
                        imageVector = if (isError) AppIcons.warning else AppIcons.success,
                        contentDescription = null,
                        tint = if (isError) colors.destructive else colors.success,
                    )
                },
                title = { Text(message) },
                semanticsLabel =
                "${if (isError) "Job action error" else "Job action succeeded"}: $message",
            )
        }
    }
}

@Composable
private fun JobStatusCard(state: JobDetailState, job: Job) {
    JobSectionCard(modifier = Modifier.testTag(JobDetailTestTags.STATUS_CARD)) {
        JobLabeledValue(label = "Status", value = state.statusLabel)
        // Whose job this is. Said only when it is not simply yours: every job
        // the list can show is either yours or the organization's.
        if (job.isOrgScoped) {
            Box(Modifier.testTag(JobDetailTestTags.SCOPE)) {
                JobLabeledValue(label = "Scope", value = JobScopeCopy.SHARED_LABEL)
            }
        }
        if (job.isActive) {
            job.nextRunAt?.let { next ->
                JobLabeledValue(label = "Next run", value = jobNextRunLabel(next))
            }
        }
        Format.relative(job.lastRunAt)?.let { last ->
            JobLabeledValue(label = "Last run", value = last)
        }
        job.description?.takeIf { it.isNotEmpty() }?.let { description ->
            Spacer(Modifier.height(4.dp))
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = appColors.secondaryLabel,
            )
        }
        if (job.createdFromPod != null) {
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = AppIcons.resources,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "Created by an agent inside a pod",
                    style = MaterialTheme.typography.bodySmall,
                    color = appColors.secondaryLabel,
                )
            }
        }
    }
}

@Composable
private fun JobScheduleCard(trigger: JobTrigger, nextRunAt: String?) {
    when (trigger) {
        is JobTrigger.Cron -> JobSectionCard(
            title = "Schedule",
            footer = "Cron schedules are evaluated in UTC.",
            modifier = Modifier.testTag(JobDetailTestTags.SCHEDULE_CARD),
        ) {
            // The card title already names this section; labelling the summary
            // row 'Schedule' again reads the word twice.
            Text(JobSchedule.detailSummary(trigger, nextRunAt = nextRunAt))
            if (JobSchedule.humanizeCron(trigger.expression) != null) {
                AppSelectableText(text = trigger.expression, style = MonospaceTextStyle)
            }
        }

        is JobTrigger.At -> JobSectionCard(
            title = if (trigger.times.size == 1) "Scheduled time" else "Scheduled times",
            footer = "Shown in your local time zone.",
            modifier = Modifier.testTag(JobDetailTestTags.SCHEDULE_CARD),
        ) {
            trigger.times.forEach { time -> ScheduledTimeRow(time) }
        }
    }
}

@Composable
private fun ScheduledTimeRow(time: String, now: Instant = Instant.now()) {
    val parsed = Format.date(time)
    val isPast = parsed != null && !parsed.isAfter(now)
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = Format.absolute(time) ?: time,
            modifier = Modifier.weight(1f),
            color = if (isPast) appColors.secondaryLabel else Color.Unspecified,
        )
        if (isPast) {
            Icon(
                imageVector = AppIcons.check,
                contentDescription = "Scheduled time already passed",
            )
        }
    }
}

@Composable
private fun JobActionsCard(
    state: JobDetailState,
    job: Job,
    onCommand: (String) -> Unit,
    onDelete: () -> Unit,
) {
    JobSectionCard(modifier = Modifier.testTag(JobDetailTestTags.ACTIONS_CARD)) {
        if (job.isActive) {
            // Trying a job out should not mean waiting for its schedule.
            AppButton(
                text = "Run now",
                onClick = { onCommand("run") },
                modifier = Modifier.fillMaxWidth().testTag("job-detail-run-now"),
                kind = AppButtonKind.Filled,
                enabled = !state.isWorking,
                minSize = DpSize(AppButtonDefaults.MinTouchTarget, AppButtonDefaults.MinTouchTarget),
                semanticsLabel = "Run job ${job.name} now",
            )
            Spacer(Modifier.height(8.dp))
        }
        if (job.isActive || job.isPaused) {
            val pausing = job.isActive
            AppButton(
                text = if (state.isWorking) {
                    "Working…"
                } else if (pausing) {
                    "Pause job"
                } else {
                    "Resume job"
                },
                onClick = { onCommand(if (pausing) "pause" else "resume") },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(if (pausing) JobDetailTestTags.PAUSE else JobDetailTestTags.RESUME),
                kind = AppButtonKind.Tinted,
                enabled = !state.isWorking,
                // Holds the 48dp minimum even when the row stretches full width.
                minSize = DpSize(AppButtonDefaults.MinTouchTarget, AppButtonDefaults.MinTouchTarget),
                semanticsLabel = "${if (pausing) "Pause" else "Resume"} job ${job.name}",
            )
            Spacer(Modifier.height(8.dp))
        }
        AppButton(
            text = "Delete job",
            onClick = onDelete,
            modifier = Modifier
                .fillMaxWidth()
                .testTag(JobDetailTestTags.DELETE),
            kind = AppButtonKind.Plain,
            enabled = !state.isWorking,
            destructive = true,
            semanticsLabel = "Delete job ${job.name}",
        )
    }
}

/** One run of a job, opening the pod it launched when there still is one. */
@Composable
private fun JobRunRow(run: JobRun, onOpenPod: (() -> Unit)?) {
    val colors = appColors
    val when_ = Format.relative(run.startedAt) ?: run.startedAt
    val error = run.error?.takeIf { it.isNotEmpty() }?.let { FriendlyError.message(it) }
    val statusLabel = humanizeJobRunStatus(run.status)
    val visual: Pair<ImageVector, Color> = when (run.status) {
        "running" -> AppIcons.syncing to colors.info
        "completed" -> AppIcons.success to colors.success
        "failed" -> AppIcons.error to colors.destructive
        "interrupted" -> AppIcons.stop to colors.warning
        else -> AppIcons.unknown to colors.neutral
    }
    val label = "Run $when_, $statusLabel${if (error == null) "" else ", $error"}"

    AppListTile(
        modifier = Modifier
            .semantics(mergeDescendants = true) { }
            .testTag(JobDetailTestTags.run(run.id)),
        onClick = onOpenPod,
        semanticsLabel = if (onOpenPod == null) label else "Open pod for $label",
        leading = { Icon(imageVector = visual.first, contentDescription = null, tint = visual.second) },
        title = { Text(when_) },
        subtitle = error?.let {
            {
                Text(
                    text = it,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = colors.destructive,
                )
            }
        },
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(text = statusLabel, color = colors.secondaryLabel)
                if (onOpenPod != null) {
                    Icon(
                        imageVector = AppIcons.chevron,
                        contentDescription = null,
                        tint = colors.tertiaryLabel,
                    )
                }
            }
        },
    )
}

/** A titled block of detail rows on one card. */
@Composable
private fun JobSectionCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    AppListSection(modifier = modifier) {
        row {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                if (title != null) {
                    Text(text = title, style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(12.dp))
                }
                content()
                if (footer != null) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        text = footer,
                        style = MaterialTheme.typography.bodySmall,
                        color = appColors.secondaryLabel,
                    )
                }
            }
        }
    }
}

/**
 * One "label, value" row, announced as a single node: without the boundary the
 * row's texts merge into the surrounding card and announce twice.
 */
@Composable
private fun JobLabeledValue(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp)
            .clearAndSetSemantics { contentDescription = "$label, $value" },
        verticalAlignment = Alignment.Top,
    ) {
        Text(text = label, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(16.dp))
        Text(text = value, textAlign = TextAlign.End, fontWeight = FontWeight.Medium)
    }
}

/** The handles a UI test finds this screen's parts by. */
object JobDetailTestTags {
    const val SCREEN = "job-detail-screen"
    const val MESSAGE = "job-detail-message"
    const val STATUS_CARD = "job-detail-status"
    const val SCHEDULE_CARD = "job-detail-schedule"
    const val PROMPT_CARD = "job-detail-prompt"
    const val CONFIG_CARD = "job-detail-runs-with"
    const val RUNS_SECTION = "job-detail-runs"
    const val ACTIONS_CARD = "job-detail-actions"
    const val SCOPE = "job-detail-scope"
    const val PAUSE = "job-detail-pause"
    const val RESUME = "job-detail-resume"
    const val DELETE = "job-detail-delete"

    fun run(id: String) = "job-run-$id"
}
