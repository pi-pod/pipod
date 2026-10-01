package com.pipod.app.features.templates

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.features.common.AdaptiveRefreshButton
import com.pipod.app.features.common.EmptyState
import com.pipod.app.features.common.RefreshErrorTile
import com.pipod.app.features.common.UnsupportedListItemCard
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListScaffold
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppSectionStyle
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/**
 * The environments list, wired to its view model.
 *
 * Port of `TemplateListView` in
 * `pi-pod-flutter/lib/features/templates/template_list_view.dart`.
 */
@Composable
fun TemplateListScreen(
    viewModel: TemplateListViewModel,
    onOpenTemplate: (PodTemplate) -> Unit,
    onNewTemplate: () -> Unit,
    modifier: Modifier = Modifier,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is TemplateListEvent.Notice -> dialogs.notice(
                    title = "Something went wrong",
                    message = event.message,
                    dismissLabel = "OK",
                    dismissSemanticsLabel = "Dismiss environment error",
                )
            }
        }
    }

    TemplateListScreen(
        state = state,
        onRefresh = viewModel::refresh,
        onOpenTemplate = onOpenTemplate,
        onNewTemplate = onNewTemplate,
        onDelete = viewModel::delete,
        modifier = modifier,
        dialogs = dialogs,
    )
}

/** The environments list as a pure function of [state]. */
@Composable
fun TemplateListScreen(
    state: TemplateListState,
    onRefresh: () -> Unit,
    onOpenTemplate: (PodTemplate) -> Unit,
    onNewTemplate: () -> Unit,
    onDelete: (PodTemplate) -> Unit,
    modifier: Modifier = Modifier,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val scope = rememberCoroutineScope()

    val confirmDelete: (PodTemplate) -> Unit = { template ->
        scope.launch {
            val confirmed = dialogs.confirm(
                title = "Delete ${template.name}?",
                message = "New pods can no longer be launched from it. " +
                    "Pods already running are unaffected.",
                confirmLabel = "Delete environment",
                destructive = true,
                confirmSemanticsLabel = "Confirm delete environment ${template.name}",
                // Cancel stays a lone node: its name never embeds the confirm name.
                cancelSemanticsLabel = "Cancel deleting ${template.name}",
            )
            if (confirmed) onDelete(template)
        }
    }

    AppListScaffold(
        title = "Environments",
        modifier = modifier.testTag(TemplateListTestTags.SCREEN),
        grouped = true,
        isRefreshing = state.isLoading && state.templates.isNotEmpty(),
        onRefresh = onRefresh,
        refreshSemanticsLabel = "Refresh environments",
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 24.dp),
        actions = {
            AdaptiveRefreshButton(label = "Refresh environments", onClick = onRefresh)
            AppIconButton(
                icon = AppIcons.add,
                onClick = onNewTemplate,
                semanticsLabel = "New environment from toolbar",
                modifier = Modifier.testTag(TemplateListTestTags.NEW_BUTTON),
            )
        },
    ) {
        templateListRows(
            state = state,
            onRefresh = onRefresh,
            onOpenTemplate = onOpenTemplate,
            onNewTemplate = onNewTemplate,
            onConfirmDelete = confirmDelete,
        )
    }

    AppDialogHost(dialogs)
}

private fun LazyListScope.templateListRows(
    state: TemplateListState,
    onRefresh: () -> Unit,
    onOpenTemplate: (PodTemplate) -> Unit,
    onNewTemplate: () -> Unit,
    onConfirmDelete: (PodTemplate) -> Unit,
) {
    if (state.showsInitialSpinner) {
        item(key = "loading") {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Spacer(Modifier.height(180.dp))
                AppActivityIndicator(
                    modifier = Modifier.semantics {
                        contentDescription = "Loading environments"
                        liveRegion = LiveRegionMode.Polite
                    },
                )
            }
        }
        return
    }

    if (state.showsEmptyState) {
        item(key = "empty") {
            val failed = state.loadError != null
            EmptyState(
                icon = if (failed) AppIcons.offline else AppIcons.environment,
                title = if (failed) "Couldn’t load environments" else "No environments yet",
                message = state.loadError
                    ?: "An environment is a setup script your pods start from. Write one here, " +
                    "or ask pi inside a pod to build one — it appears here as soon as it " +
                    "is created.",
                actionLabel = if (failed) "Try again" else "New environment",
                actionSemanticsLabel = if (failed) {
                    "Try loading environments again"
                } else {
                    "New environment from empty state"
                },
                onAction = if (failed) onRefresh else onNewTemplate,
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
                retrySemanticsLabel = "Retry refreshing environments",
            )
        }
    }

    for (index in 0 until state.unsupportedTemplateCount) {
        item(key = "unsupported-environment-$index") {
            UnsupportedListItemCard(itemName = "environment")
        }
    }

    // There is no draft environment: the server answers `status: "active"` for
    // every template it has, so a "waiting for your approval" section could
    // only ever be empty.
    if (state.templates.isNotEmpty()) {
        item(key = "active") {
            AppListSection(
                modifier = Modifier.testTag(TemplateListTestTags.ACTIVE_SECTION),
                header = "Active",
                style = AppSectionStyle.Separated,
            ) {
                items(state.templates) { template ->
                    TemplateRow(
                        template = template,
                        deleting = state.isDeleting(template.id),
                        onOpen = { onOpenTemplate(template) },
                        onDelete = { onConfirmDelete(template) },
                    )
                }
            }
        }
    }
}

@Composable
private fun TemplateRow(
    template: PodTemplate,
    deleting: Boolean,
    onOpen: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (deleting) 0.5f else 1f)
            .testTag(TemplateListTestTags.row(template.id)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AppListTile(
            modifier = Modifier
                .weight(1f)
                // A row mid-delete says so. `AppListTile` simply drops its click
                // action when disabled, which leaves a frozen row announcing as
                // an ordinary one.
                .semantics(mergeDescendants = true) { if (deleting) disabled() },
            onClick = onOpen,
            enabled = !deleting,
            showChevron = true,
            semanticsLabel = "Open environment ${template.name}",
            title = {
                Text(
                    text = template.name,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            subtitle = template.description
                ?.takeIf { it.isNotEmpty() }
                ?.let { description -> { Text(description) } },
        )
        AppIconButton(
            icon = AppIcons.delete,
            onClick = onDelete,
            enabled = !deleting,
            semanticsLabel = "Delete environment ${template.name}",
        )
        Spacer(Modifier.width(4.dp))
    }
}

/** The handles a UI test finds this screen's parts by. */
object TemplateListTestTags {
    const val SCREEN = "environment-list-screen"
    const val NEW_BUTTON = "environment-list-new"
    const val ACTIVE_SECTION = "environment-list-active"

    fun row(id: String) = "environment-row-$id"
}
