package com.pipod.app.features.pods

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.format.Format
import com.pipod.app.core.format.PodFilter
import com.pipod.app.core.format.PodFilterEnvironment
import com.pipod.app.core.format.PodFilterProject
import com.pipod.app.core.format.PodFilterStatus
import com.pipod.app.core.format.PodGroup
import com.pipod.app.core.format.PodPresentation
import com.pipod.app.features.common.AdaptiveRefreshButton
import com.pipod.app.features.common.BillingSummaryRow
import com.pipod.app.features.common.EmptyState
import com.pipod.app.features.common.RefreshErrorTile
import com.pipod.app.features.common.StatusChip
import com.pipod.app.features.common.UnsupportedListItemCard
import com.pipod.app.features.common.WorkstationWaitCard
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppBadge
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonContent
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppButtonSize
import com.pipod.app.ui.AppFloatingAction
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppOption
import com.pipod.app.ui.AppOptionPicker
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.AppSheet
import com.pipod.app.ui.AppSwitchRow
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.appListTestTag
import com.pipod.app.ui.appScaffoldBackground
import com.pipod.app.ui.currentWindowWidth
import com.pipod.app.ui.isCompactWidth
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.delay

/** How often a list with a moving pod re-asks the server, as in the Dart. */
private const val POLL_INTERVAL_MS = 4_000L

/**
 * Widest a single column of pod cards is worth keeping. Above this the cards
 * pair up, which is the seam a tablet layout grows into.
 */
private val TwoColumnPodBreakpoint: Dp = 1050.dp

/**
 * The pod list, wired to its view model.
 *
 * Port of `pi-pod-flutter/lib/features/pods/pod_list_view.dart`. The Flutter
 * view owns a `Timer.periodic` and a `WidgetsBindingObserver`; both belong to
 * the screen in Compose, so the poll stops when the list leaves the composition
 * instead of outliving it.
 */
@Composable
fun PodListScreen(
    viewModel: PodListViewModel,
    onOpenPod: (Pod) -> Unit,
    onOpenApprovals: () -> Unit,
    onLaunchNewPod: () -> Unit,
    modifier: Modifier = Modifier,
    pendingApprovalsCount: Int = 0,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // Sleep/wake transitions that happened in the background show stale statuses
    // until a manual pull; re-fetch on return to the foreground. The view model's
    // own in-flight guard is what keeps this from stacking with the first load.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        viewModel.refreshPods()
        // Hours accrue and a spend cap trips while the app is away. Read at
        // sign-in only, the account line — and the warning that starts are about
        // to be refused — would still be reporting yesterday.
        viewModel.refreshBilling()
    }

    LaunchedPoll { viewModel.pollIfInitializing() }

    PodListScreen(
        state = state,
        onRefresh = viewModel::refresh,
        onSearchChange = viewModel::setSearch,
        onApplyFilter = viewModel::applyFilter,
        onClearFilters = viewModel::clearFilters,
        onShowAllStatuses = viewModel::showAllStatuses,
        onOpenPod = onOpenPod,
        onOpenApprovals = onOpenApprovals,
        onLaunchNewPod = onLaunchNewPod,
        onCancelWorkstationWait = viewModel::cancelWorkstationWait,
        onRetryWorkstation = viewModel::retryAfterWorkstationWait,
        modifier = modifier,
        pendingApprovalsCount = pendingApprovalsCount,
        isRefreshing = state.isLoading && state.pods.isNotEmpty(),
    )
}

/** The 4-second tick, held here so it dies with the screen. */
@Composable
private fun LaunchedPoll(onTick: () -> Unit) {
    LaunchedEffect(Unit) {
        while (true) {
            delay(POLL_INTERVAL_MS)
            onTick()
        }
    }
}

/**
 * The pod list as a pure function of [state], so a UI test can render every
 * variant — loading, empty, failed, filtered to nothing — without a server.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PodListScreen(
    state: PodListState,
    onRefresh: () -> Unit,
    onSearchChange: (String) -> Unit,
    onApplyFilter: (PodFilter) -> Unit,
    onClearFilters: () -> Unit,
    onShowAllStatuses: () -> Unit,
    onOpenPod: (Pod) -> Unit,
    onOpenApprovals: () -> Unit,
    onLaunchNewPod: () -> Unit,
    onCancelWorkstationWait: () -> Unit = {},
    onRetryWorkstation: () -> Unit = {},
    modifier: Modifier = Modifier,
    pendingApprovalsCount: Int = 0,
    isRefreshing: Boolean = false,
) {
    var showingFilters by rememberSaveable { mutableStateOf(false) }
    // On a phone the top-right corner is the hardest place to reach, so the
    // primary action moves to a reachable button; a wide window keeps it in the
    // bar, where there is room for it.
    val compact = isCompactWidth()
    // Grouping, sorting and the hidden-status arithmetic are pure functions of
    // the pods, the filter and who is reading — but they are *getters*, so every
    // read walked the whole account again, several times per frame. Computed
    // once here instead, and only when one of those three actually changes.
    val rows = remember(state.pods, state.templates, state.filter, state.currentUserId) {
        PodListRowData.from(state)
    }
    val twoColumn = currentWindowWidth() >= TwoColumnPodBreakpoint

    AppScaffold(
        modifier = modifier.testTag(PodListTestTags.SCREEN),
        title = "Pods",
        grouped = true,
        actions = {
            AdaptiveRefreshButton(label = "Refresh pods", onClick = onRefresh)
            Box {
                AppIconButton(
                    icon = AppIcons.filter,
                    onClick = { showingFilters = true },
                    semanticsLabel = if (state.filter.isDefault) {
                        "Filter pods"
                    } else {
                        "Filter pods, showing ${state.filter.summary}"
                    },
                    enabled = state.pods.isNotEmpty(),
                    modifier = Modifier.testTag(PodListTestTags.FILTER_BUTTON),
                )
                if (!state.filter.isDefault) {
                    // The dot repeats what the button's own name already says,
                    // so it stays out of the tree rather than adding a stop.
                    Box(
                        Modifier
                            .align(Alignment.TopEnd)
                            .offset(x = (-2).dp, y = 2.dp)
                            .clearAndSetSemantics { },
                    ) {
                        AppBadge(count = 1)
                    }
                }
            }
            if (!compact) {
                AppIconButton(
                    icon = AppIcons.add,
                    onClick = onLaunchNewPod,
                    semanticsLabel = "New pod",
                )
            }
        },
        floatingActionButton = {
            if (compact) {
                AppFloatingAction(
                    icon = AppIcons.add,
                    label = "New pod",
                    onClick = onLaunchNewPod,
                )
            }
        },
    ) { insets ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(insets)
                .background(appScaffoldBackground(grouped = true)),
        ) {
            // Pinned rather than scrolled away with the rows: the search field
            // and the "showing …" line are how the reader gets back out of a
            // filter, and a long list would otherwise hide both.
            if (state.pods.isNotEmpty()) {
                PodFilterHeader(
                    state = state,
                    onSearchChange = onSearchChange,
                    onClearFilters = onClearFilters,
                )
            }
            PullToRefreshBox(
                isRefreshing = isRefreshing,
                onRefresh = onRefresh,
                // Pull-to-refresh is a gesture a screen-reader user cannot
                // perform, so refresh is also a named custom action.
                modifier = Modifier
                    .fillMaxSize()
                    .semantics {
                        customActions = listOf(
                            CustomAccessibilityAction("Refresh pods") {
                                onRefresh()
                                true
                            },
                        )
                    },
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().appListTestTag(),
                    contentPadding = PaddingValues(
                        start = 12.dp,
                        end = 12.dp,
                        top = 4.dp,
                        // The last row has to clear the New pod button rather
                        // than scroll under it.
                        bottom = if (compact) 96.dp else 24.dp,
                    ),
                ) {
                    podListRows(
                        state = state,
                        rows = rows,
                        twoColumn = twoColumn,
                        pendingApprovalsCount = pendingApprovalsCount,
                        onRefresh = onRefresh,
                        onClearFilters = onClearFilters,
                        onShowAllStatuses = onShowAllStatuses,
                        onOpenPod = onOpenPod,
                        onOpenApprovals = onOpenApprovals,
                        onLaunchNewPod = onLaunchNewPod,
                        onCancelWorkstationWait = onCancelWorkstationWait,
                        onRetryWorkstation = onRetryWorkstation,
                    )
                }
            }
        }
    }

    if (showingFilters) {
        PodFilterSheet(
            initial = state.filter,
            projects = state.projects,
            environments = state.environments,
            hasUnassignedProject = state.hasUnassignedProject,
            hasNoEnvironment = state.hasNoEnvironment,
            showsOwnerFilter = state.showsOwnerFilter,
            onDismiss = { showingFilters = false },
            onApply = {
                showingFilters = false
                onApplyFilter(it)
            },
        )
    }
}

/**
 * The list's derived shape, held as a value so it is computed once per change
 * rather than once per read.
 */
@Immutable
private data class PodListRowData(
    val groups: List<PodGroup>,
    val showsLocation: Boolean,
    val showsOwner: Boolean,
    val hiddenBreakdown: String?,
) {
    /** Nothing matches, but there is something to match against. */
    fun showsNoMatches(state: PodListState): Boolean = state.pods.isNotEmpty() && groups.isEmpty()

    companion object {
        fun from(state: PodListState) = PodListRowData(
            groups = state.visibleGroups,
            showsLocation = state.showsLocation,
            showsOwner = state.showsOwnerMetadata,
            hiddenBreakdown = state.hiddenBreakdown,
        )
    }
}

private fun LazyListScope.podListRows(
    state: PodListState,
    rows: PodListRowData,
    twoColumn: Boolean,
    pendingApprovalsCount: Int,
    onRefresh: () -> Unit,
    onClearFilters: () -> Unit,
    onShowAllStatuses: () -> Unit,
    onOpenPod: (Pod) -> Unit,
    onOpenApprovals: () -> Unit,
    onLaunchNewPod: () -> Unit,
    onCancelWorkstationWait: () -> Unit,
    onRetryWorkstation: () -> Unit,
) {
    // The reader's own machine, above everything it is holding up. It is not a
    // pod row, not the capacity wait, and not an asleep pod.
    val workstationWait = state.workstationWait
    if (workstationWait != null) {
        item(key = "workstation-wait") {
            WorkstationWaitCard(
                state = workstationWait,
                modifier = Modifier.padding(bottom = 8.dp),
                onCancel = onCancelWorkstationWait,
                onRetry = onRetryWorkstation,
            )
        }
    }

    // The SaaS account summary. On the self-hosted backend nothing arrives, so
    // the item is never declared and the surface costs no layout at all.
    val billing = state.billing
    if (billing != null && !billing.isEmpty) {
        item(key = "billing") {
            BillingSummaryRow(summary = billing, modifier = Modifier.padding(bottom = 8.dp))
        }
    }

    if (state.showsInitialSpinner) {
        item(key = "loading") {
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Spacer(Modifier.height(180.dp))
                AppActivityIndicator(
                    modifier = Modifier.semantics {
                        contentDescription = "Loading pods"
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
                icon = if (failed) AppIcons.offline else AppIcons.archived,
                title = if (failed) "Couldn’t load pods" else "No pods yet",
                message = state.loadError ?: "Launch a pod to start a remote pi session.",
                actionLabel = if (failed) "Try again" else "New pod",
                // The floating action is on screen too and now publishes a name
                // of its own, so two buttons would answer to "New pod" and a
                // reader could not tell them apart. Named for where it is, the
                // way the environments list already distinguishes its two.
                actionSemanticsLabel = if (failed) {
                    "Try loading pods again"
                } else {
                    "New pod from empty state"
                },
                onAction = if (failed) onRefresh else onLaunchNewPod,
            )
        }
        return
    }

    if (pendingApprovalsCount > 0) {
        item(key = "approvals") {
            AppListSection(modifier = Modifier.padding(bottom = 8.dp)) {
                row {
                    AppListTile(
                        title = { Text("Waiting for your approval") },
                        leading = { Icon(AppIcons.approval, contentDescription = null) },
                        additionalInfo = { AppBadge(count = pendingApprovalsCount) },
                        onClick = onOpenApprovals,
                        backgroundColor = appColors.noticeFill,
                        semanticsLabel = "Open pending approvals, $pendingApprovalsCount pending",
                        modifier = Modifier
                            .testTag(PodListTestTags.APPROVALS_ROW)
                            .semantics(mergeDescendants = true) { },
                    )
                }
            }
        }
    }

    for (index in 0 until state.unsupportedPodCount) {
        item(key = "unsupported-pod-$index") { UnsupportedListItemCard(itemName = "pod") }
    }

    val loadError = state.loadError
    if (loadError != null) {
        item(key = "refresh-error") {
            RefreshErrorTile(
                message = loadError,
                onRetry = onRefresh,
                retrySemanticsLabel = "Retry refreshing pods",
            )
        }
    }

    if (rows.showsNoMatches(state)) {
        item(key = "no-matches") {
            NoPodMatches(
                filter = state.filter,
                hiddenBreakdown = rows.hiddenBreakdown,
                onShowAllStatuses = onShowAllStatuses,
                onClear = onClearFilters,
            )
        }
    }

    val groups = rows.groups
    if (groups.isNotEmpty()) {
        // One lazy item per group, not one item holding every group: inside a
        // single item the whole account composes, measures and lays out on the
        // first frame and again on every state change, which is what "lazy"
        // exists to avoid. An organization can legitimately have thousands of
        // pods here.
        val card: @Composable (PodGroup, Modifier) -> Unit = { group, modifier ->
            PodGroupCard(
                group = group,
                onOpenPod = onOpenPod,
                showOwner = rows.showsOwner,
                showLocation = rows.showsLocation,
                currentUserId = state.currentUserId,
                // While the workstation card is up, no row may promise the
                // pod's own quick restart beside it saying minutes.
                workstationWaiting = workstationWait != null,
                modifier = modifier,
            )
        }
        if (twoColumn) {
            // The pairing is the seam a tablet layout grows into; on every phone
            // width the single-column branch below is the one that runs.
            val pairs = groups.chunked(2)
            items(
                count = pairs.size,
                key = { index -> "pod-pair-${pairs[index].first().root.id}" },
                contentType = { "pod-group-pair" },
            ) { index ->
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    pairs[index].forEach { group ->
                        Box(Modifier.weight(1f)) { card(group, Modifier) }
                    }
                    if (pairs[index].size == 1) Spacer(Modifier.weight(1f))
                }
            }
        } else {
            items(
                count = groups.size,
                key = { index -> "pod-group-${groups[index].root.id}" },
                contentType = { "pod-group" },
            ) { index ->
                Box(Modifier.padding(vertical = 4.dp)) { card(groups[index], Modifier) }
            }
        }
        val breakdown = rows.hiddenBreakdown
        if (breakdown != null) {
            item(key = "disclose") {
                Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), Alignment.Center) {
                    AppButton(
                        onClick = onShowAllStatuses,
                        kind = AppButtonKind.Plain,
                        semanticsLabel = "Show $breakdown",
                        modifier = Modifier.testTag(PodListTestTags.DISCLOSE_HIDDEN),
                    ) {
                        AppButtonContent(icon = AppIcons.history, label = "Show $breakdown")
                    }
                }
            }
        }
    }
}

/** The search field and the "showing …" line, which stay put while rows scroll. */
@Composable
private fun PodFilterHeader(
    state: PodListState,
    onSearchChange: (String) -> Unit,
    onClearFilters: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().testTag(PodListTestTags.HEADER)) {
        Box(Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 8.dp)) {
            AppTextField(
                value = state.filter.search,
                onValueChange = onSearchChange,
                placeholder = "Search pods and projects",
                semanticsLabel = "Search pods and projects",
                prefixIcon = AppIcons.search,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Search,
                ),
                suffix = if (state.filter.search.isEmpty()) {
                    null
                } else {
                    {
                        AppIconButton(
                            icon = AppIcons.close,
                            onClick = { onSearchChange("") },
                            semanticsLabel = "Clear pod search",
                        )
                    }
                },
            )
        }
        if (!state.filter.isDefault) {
            AppListSection(modifier = Modifier.padding(horizontal = 12.dp)) {
                row {
                    AppListTile(
                        title = { Text("Showing ${state.filter.summary}") },
                        trailing = {
                            AppButton(
                                text = "Clear",
                                onClick = onClearFilters,
                                kind = AppButtonKind.Plain,
                                size = AppButtonSize.Small,
                                minSize = DpSize(AppButtonDefaults.MinTouchTarget, AppButtonDefaults.MinTouchTarget),
                                semanticsLabel = "Clear pod filters",
                            )
                        },
                    )
                }
            }
        }
    }
}

/** A machine and everything co-located on it, as one card. */
@Composable
private fun PodGroupCard(
    group: PodGroup,
    onOpenPod: (Pod) -> Unit,
    showOwner: Boolean,
    showLocation: Boolean,
    currentUserId: String?,
    modifier: Modifier = Modifier,
    workstationWaiting: Boolean = false,
) {
    AppListSection(modifier = modifier) {
        row {
            PodTile(
                pod = group.root,
                depth = 0,
                onClick = { onOpenPod(group.root) },
                showOwner = showOwner,
                showLocation = showLocation,
                currentUserId = currentUserId,
                workstationWaiting = workstationWaiting,
            )
        }
        items(group.children) { child ->
            PodTile(
                pod = child,
                depth = 1,
                onClick = { onOpenPod(child) },
                // A co-located child is only meaningful with its host named.
                showLocation = true,
                showOwner = showOwner,
                currentUserId = currentUserId,
                workstationWaiting = workstationWaiting,
            )
        }
    }
}

@Composable
private fun PodTile(
    pod: Pod,
    depth: Int,
    onClick: () -> Unit,
    showOwner: Boolean,
    showLocation: Boolean,
    currentUserId: String?,
    workstationWaiting: Boolean = false,
) {
    val presentation = PodPresentation.fromPod(pod)
    val statusColor = appColors.tone(presentation.tone)
    val relative = Format.relative(pod.lastActivityAt ?: pod.createdAt)
    val activity = if (relative == null) "no activity yet" else "last used $relative"
    val location = pod.displayLocation
    val subtitleHasLocation = showLocation || pod.isHostChild
    val subtitle = buildList {
        pod.projectName?.let { add(it) }
        add(activity)
        if (subtitleHasLocation) add(location)
    }.joinToString(" · ")
    val reason = presentation.userFacingReason
    val isStoppedOrProviderArchived = pod.state == "active" &&
        (pod.sandboxState == "stopped" || pod.sandboxState == "archived")
    // Ownership is only worth a row when it is not the reader's own pod.
    val showsOwner = showOwner && pod.userId != currentUserId
    // The tile label keeps one fixed order in every state (name, status,
    // location, provider, project, activity): the location used to ride inside
    // the subtitle when shown and after the status when hidden, so the provider
    // sat before the status in one path and after it in another.
    val label = buildList {
        add("Open pod ${pod.name}")
        add(presentation.statusLabel)
        add(location)
        if (pod.provider != location) add(pod.provider)
        pod.projectName?.let { add(it) }
        add(activity)
        if (showsOwner) add("Owned by another organization member")
        reason?.let { add(it) }
    }.joinToString(", ")

    AppListTile(
        modifier = Modifier
            .testTag(PodListTestTags.podRow(pod.id))
            .semantics(mergeDescendants = true) { },
        onClick = onClick,
        semanticsLabel = label,
        leading = {
            Box(Modifier.padding(start = (depth * 16).dp)) {
                PodStateIcon(presentation = presentation)
            }
        },
        title = {
            Row(verticalAlignment = Alignment.Top) {
                // The name truncates before the chip instead of running beneath
                // it at large text sizes.
                Text(
                    text = pod.name,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                StatusChip(label = presentation.statusLabel, color = statusColor)
            }
        },
        subtitle = {
            Column {
                Text(subtitle)
                val detail = presentation.statusDetail
                // The pod's own restart is quick — but not while the machine
                // under it is still coming up, which the card above is saying
                // in minutes. Same suppression as the detail screen.
                if (isStoppedOrProviderArchived && detail != null && !workstationWaiting) {
                    Text(
                        text = detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = appColors.secondaryLabel,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
                if (showsOwner) {
                    Row(
                        modifier = Modifier.padding(top = 4.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Box(
                            Modifier.size(20.dp).background(appColors.fill, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                AppIcons.person,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                            )
                        }
                        Spacer(Modifier.width(6.dp))
                        Text("Another organization member")
                    }
                }
                if (reason != null) {
                    Text(
                        text = reason,
                        color = appColors.destructive,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
        },
    )
}

/** Something is loaded, but the filter matches none of it. */
@Composable
private fun NoPodMatches(
    filter: PodFilter,
    hiddenBreakdown: String?,
    onShowAllStatuses: () -> Unit,
    onClear: () -> Unit,
) {
    val showBreakdown = hiddenBreakdown != null
    val showClear = !filter.isDefault
    EmptyState(
        icon = AppIcons.noResults,
        title = "No pods match",
        message = if (filter.search.isEmpty()) {
            "No pods match “${filter.summary}”."
        } else {
            "Nothing matches “${filter.search}”."
        },
        actionLabel = when {
            showClear -> "Clear filters"
            showBreakdown -> "Show $hiddenBreakdown"
            else -> null
        },
        actionSemanticsLabel = when {
            showClear -> "Clear pod filters from empty result"
            showBreakdown -> "Show $hiddenBreakdown"
            else -> null
        },
        onAction = when {
            showClear -> onClear
            showBreakdown -> onShowAllStatuses
            else -> null
        },
        footer = if (showClear && showBreakdown) {
            {
                Box(Modifier.fillMaxWidth(), Alignment.Center) {
                    AppButton(
                        text = "Show $hiddenBreakdown",
                        onClick = onShowAllStatuses,
                        kind = AppButtonKind.Plain,
                        semanticsLabel = "Show $hiddenBreakdown",
                    )
                }
            }
        } else {
            null
        },
    )
}

/**
 * The filter panel.
 *
 * It edits a copy and only hands it back on Apply, so backing out of the sheet
 * leaves the list exactly as it was found.
 */
@Composable
private fun PodFilterSheet(
    initial: PodFilter,
    projects: List<String>,
    environments: List<PodFilterEnvironment>,
    hasUnassignedProject: Boolean,
    hasNoEnvironment: Boolean,
    showsOwnerFilter: Boolean,
    onDismiss: () -> Unit,
    onApply: (PodFilter) -> Unit,
) {
    var draft by remember { mutableStateOf(initial.copy()) }

    AppSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .padding(start = 24.dp, end = 24.dp, bottom = 24.dp)
                .testTag(PodListTestTags.FILTER_SHEET),
        ) {
            Text("Filter pods", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(20.dp))

            Box(Modifier.semantics { contentDescription = "Filter status" }) {
                AppOptionPicker(
                    label = "Show",
                    value = draft.status,
                    options = PodFilterStatus.entries.map { AppOption(it, it.label) },
                    onValueChange = { draft = draft.copy(status = it) },
                )
            }

            if (projects.isNotEmpty() || hasUnassignedProject) {
                Spacer(Modifier.height(16.dp))
                Box(Modifier.semantics { contentDescription = "Filter project" }) {
                    AppOptionPicker(
                        label = "Project",
                        value = draft.project,
                        options = buildList {
                            add(AppOption<PodFilterProject>(PodFilterProject.Any, "All projects"))
                            projects.forEach { add(AppOption(PodFilterProject.Named(it), it)) }
                            if (hasUnassignedProject) {
                                add(AppOption<PodFilterProject>(PodFilterProject.Unassigned, "No project"))
                            }
                        },
                        onValueChange = { draft = draft.copy(project = it) },
                    )
                }
            }

            if (environments.isNotEmpty() || hasNoEnvironment) {
                Spacer(Modifier.height(16.dp))
                Box(Modifier.semantics { contentDescription = "Filter environment" }) {
                    AppOptionPicker(
                        label = "Environment",
                        value = draft.environment,
                        options = buildList {
                            add(
                                AppOption<PodFilterEnvironment>(
                                    PodFilterEnvironment.Any,
                                    "All environments",
                                ),
                            )
                            environments.forEach { add(AppOption(it, it.label)) }
                            if (hasNoEnvironment) {
                                add(
                                    AppOption<PodFilterEnvironment>(
                                        PodFilterEnvironment.None,
                                        "No environment",
                                    ),
                                )
                            }
                        },
                        onValueChange = { draft = draft.copy(environment = it) },
                    )
                }
            }

            if (showsOwnerFilter) {
                Spacer(Modifier.height(8.dp))
                AppSwitchRow(
                    checked = draft.onlyMine,
                    onCheckedChange = { draft = draft.copy(onlyMine = it) },
                    modifier = Modifier.semantics { contentDescription = "Only my pods filter" },
                    title = { Text("Only my pods") },
                )
            }

            Spacer(Modifier.height(24.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                AppButton(
                    text = "Cancel",
                    onClick = onDismiss,
                    kind = AppButtonKind.Plain,
                    semanticsLabel = "Cancel pod filters",
                )
                Spacer(Modifier.width(8.dp))
                AppButton(
                    text = "Apply",
                    onClick = { onApply(draft) },
                    semanticsLabel = "Apply pod filters",
                )
            }
        }
    }
}

/** The handles a UI test finds this screen's parts by. */
object PodListTestTags {
    const val SCREEN = "pod-list-screen"
    const val HEADER = "pod-list-header"
    const val FILTER_BUTTON = "pod-list-filter"
    const val FILTER_SHEET = "pod-filter-sheet"
    const val APPROVALS_ROW = "pod-list-approvals"
    const val DISCLOSE_HIDDEN = "pod-list-disclose-hidden"

    fun podRow(id: String) = "pod-row-$id"
}
