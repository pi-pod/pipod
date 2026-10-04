package com.pipod.app.features.templates

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
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
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListScaffold
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppSectionStyle

/**
 * The environments list, wired to its view model.
 *
 * Port of `TemplateListView` in
 * `pi-pod-flutter/lib/features/templates/template_list_view.dart`. The list only
 * reads: environments are created, changed and deleted in the web dashboard,
 * which Settings links to.
 */
@Composable
fun TemplateListScreen(
    viewModel: TemplateListViewModel,
    onOpenTemplate: (PodTemplate) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    TemplateListScreen(
        state = state,
        onRefresh = viewModel::refresh,
        onOpenTemplate = onOpenTemplate,
        modifier = modifier,
    )
}

/** The environments list as a pure function of [state]. */
@Composable
fun TemplateListScreen(
    state: TemplateListState,
    onRefresh: () -> Unit,
    onOpenTemplate: (PodTemplate) -> Unit,
    modifier: Modifier = Modifier,
) {
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
        },
    ) {
        templateListRows(state = state, onRefresh = onRefresh, onOpenTemplate = onOpenTemplate)
    }
}

private fun LazyListScope.templateListRows(
    state: TemplateListState,
    onRefresh: () -> Unit,
    onOpenTemplate: (PodTemplate) -> Unit,
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
                    ?: "An environment is a setup script your pods start from. Write one in " +
                    "the web dashboard, which Settings opens, or ask pi inside a pod to build " +
                    "one — it appears here as soon as it is created.",
                actionLabel = if (failed) "Try again" else null,
                actionSemanticsLabel = if (failed) "Try loading environments again" else null,
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
                footer = "Environments are created and changed in the web dashboard.",
                style = AppSectionStyle.Separated,
            ) {
                items(state.templates) { template ->
                    TemplateRow(template = template, onOpen = { onOpenTemplate(template) })
                }
            }
        }
    }
}

@Composable
private fun TemplateRow(template: PodTemplate, onOpen: () -> Unit) {
    AppListTile(
        modifier = Modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) { }
            .testTag(TemplateListTestTags.row(template.id)),
        onClick = onOpen,
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
}

/** The handles a UI test finds this screen's parts by. */
object TemplateListTestTags {
    const val SCREEN = "environment-list-screen"
    const val ACTIVE_SECTION = "environment-list-active"

    fun row(id: String) = "environment-row-$id"
}
