package com.pipod.app.features.interactions

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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.format.Format
import com.pipod.app.core.session.InteractionPresentation
import com.pipod.app.features.common.AdaptiveRefreshButton
import com.pipod.app.features.common.EmptyState
import com.pipod.app.features.common.RefreshErrorTile
import com.pipod.app.features.common.UnsupportedListItemCard
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListScaffold
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppSectionStyle
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.theme.appColors

/**
 * The standalone approvals inbox, wired to its view model.
 *
 * Port of `InteractionListView` in
 * `pi-pod-flutter/lib/features/interactions/interaction_list_view.dart`.
 *
 * @param targetInteractionId a deep link from a push notification. The row is
 *   opened once the refresh it triggers confirms the request is still pending;
 *   otherwise the reader is told it has already been answered rather than
 *   dropped onto an empty list with no explanation.
 */
@Composable
fun InteractionListScreen(
    viewModel: InteractionListViewModel,
    onOpenInteraction: (PendingInteraction) -> Unit,
    modifier: Modifier = Modifier,
    targetInteractionId: String? = null,
    onTargetHandled: (String) -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val dialogs = rememberAppDialogHostState()

    // NEW-5: an approval answered on another device or inside a session left a
    // stale row here until the tab was revisited. The first ON_RESUME is the
    // one this composition arrived on, and the view model has already loaded
    // for it, so only later returns to the foreground re-fetch.
    var hasResumed by rememberSaveable { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        if (hasResumed) viewModel.refresh() else hasResumed = true
    }

    LaunchedEffect(targetInteractionId) {
        val target = targetInteractionId ?: return@LaunchedEffect
        val match = viewModel.openTarget(target)
        when {
            match != null -> onOpenInteraction(match)
            // After a failed refresh "no longer pending" would be a guess.
            viewModel.state.value.error == null -> dialogs.notice(
                title = "Approval unavailable",
                message = "That approval is no longer pending. " +
                    "It may already have been resolved.",
                dismissSemanticsLabel = "Dismiss unavailable approval message",
            )
        }
        onTargetHandled(target)
    }

    InteractionListScreen(
        state = state,
        onRefresh = viewModel::refresh,
        onOpenInteraction = onOpenInteraction,
        modifier = modifier,
    )

    AppDialogHost(dialogs)
}

/** The approvals inbox as a pure function of [state]. */
@Composable
fun InteractionListScreen(
    state: InteractionListState,
    onRefresh: () -> Unit,
    onOpenInteraction: (PendingInteraction) -> Unit,
    modifier: Modifier = Modifier,
) {
    AppListScaffold(
        title = "Approvals",
        modifier = modifier.testTag(InteractionListTestTags.SCREEN),
        grouped = true,
        isRefreshing = state.isLoading && state.interactions.isNotEmpty(),
        onRefresh = onRefresh,
        refreshSemanticsLabel = "Refresh approvals",
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 24.dp),
        actions = {
            AdaptiveRefreshButton(label = "Refresh approvals", onClick = onRefresh)
        },
    ) {
        approvalRows(state = state, onRefresh = onRefresh, onOpenInteraction = onOpenInteraction)
    }
}

private fun LazyListScope.approvalRows(
    state: InteractionListState,
    onRefresh: () -> Unit,
    onOpenInteraction: (PendingInteraction) -> Unit,
) {
    if (state.showsInitialSpinner) {
        item(key = "loading") { ApprovalsLoading() }
        return
    }

    if (state.showsEmptyState) {
        item(key = "empty") {
            val failed = state.error != null
            EmptyState(
                icon = if (failed) AppIcons.offline else AppIcons.approvalGranted,
                title = if (failed) "Couldn’t load approvals" else "No pending approvals",
                message = state.error ?: "When pi needs an answer, it shows up here.",
                actionLabel = if (failed) "Try again" else null,
                actionSemanticsLabel = if (failed) "Try loading approvals again" else null,
                onAction = if (failed) onRefresh else null,
            )
        }
        return
    }

    val error = state.error
    if (error != null) {
        item(key = "refresh-error") {
            RefreshErrorTile(
                message = error,
                onRetry = onRefresh,
                retrySemanticsLabel = "Retry refreshing approvals",
            )
        }
    }

    for (index in 0 until state.unsupportedCount) {
        item(key = "unsupported-approval-$index") {
            UnsupportedListItemCard(itemName = "approval")
        }
    }

    items(
        count = state.interactions.size,
        key = { index -> state.interactions[index].id },
    ) { index ->
        val interaction = state.interactions[index]
        InteractionRow(interaction = interaction, onClick = { onOpenInteraction(interaction) })
    }
}

@Composable
private fun ApprovalsLoading() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(InteractionListTestTags.LOADING),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(180.dp))
        Column(
            // One node: the label already says what the spinner and the line
            // under it say (ANDROID-20).
            modifier = Modifier.clearAndSetSemantics {
                contentDescription = "Loading approvals"
                liveRegion = LiveRegionMode.Polite
            },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            AppActivityIndicator()
            Spacer(Modifier.height(12.dp))
            Text("Loading approvals…")
        }
    }
}

/**
 * One waiting request.
 *
 * The row reads as a single sentence — pod, request, and what tapping it does —
 * rather than as four fragments a screen reader walks through one at a time.
 */
@Composable
private fun InteractionRow(interaction: PendingInteraction, onClick: () -> Unit) {
    val presentation = remember(interaction) { InteractionPresentation(interaction) }
    val waiting = Format.duration(since = interaction.createdAt)
    val label = remember(interaction, presentation) { interactionRowLabel(interaction, presentation) }

    AppListSection(
        modifier = Modifier.testTag(InteractionListTestTags.row(interaction.id)),
        style = AppSectionStyle.Separated,
    ) {
        row {
            AppListTile(
                modifier = Modifier.semantics(mergeDescendants = true) { },
                onClick = onClick,
                showChevron = true,
                semanticsLabel = label,
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = interaction.podName,
                            modifier = Modifier.weight(1f),
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.width(12.dp))
                        Text(
                            text = presentation.title,
                            modifier = Modifier.weight(1f, fill = false),
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                subtitle = {
                    Column(Modifier.padding(top = 6.dp)) {
                        Text(
                            text = presentation.message,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.height(6.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = AppIcons.inspect,
                                contentDescription = null,
                                modifier = Modifier.size(16.dp),
                                tint = appColors.accent,
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                text = "Review request",
                                color = appColors.accent,
                                fontWeight = FontWeight.Bold,
                            )
                            Spacer(Modifier.weight(1f))
                            if (waiting != null) Text("waiting $waiting")
                        }
                    }
                },
            )
        }
    }
}

/** The handles a UI test finds this screen's parts by. */
object InteractionListTestTags {
    const val SCREEN = "approvals-list"
    const val LOADING = "approvals-loading"

    fun row(id: String) = "approval-row-$id"
}
