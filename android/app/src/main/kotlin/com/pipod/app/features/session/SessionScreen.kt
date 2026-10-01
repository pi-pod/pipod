package com.pipod.app.features.session

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.format.MessageChrome
import com.pipod.app.features.common.WorkstationWaitCard
import com.pipod.app.core.format.TranscriptPresentation
import com.pipod.app.core.format.TranscriptRow
import com.pipod.app.core.push.PushController
import com.pipod.app.core.session.RemoteUiPlacement
import com.pipod.app.core.session.RemoteUiRole
import com.pipod.app.core.session.RemoteUiSurface
import com.pipod.app.core.session.SessionStream
import com.pipod.app.core.session.StreamItem
import com.pipod.app.features.pods.ModelPickerButton
import com.pipod.app.features.pods.ModelPickerState
import com.pipod.app.shell.ContentPane
import com.pipod.app.shell.centeredIn
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppButtonSize
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.rememberAnsiCellMetrics
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/**
 * Every callback the session screen needs, in one place.
 *
 * A bundle rather than fifteen parameters: the screen is meant to be built by
 * hand in a UI test, and a test that only cares about Send should not have to
 * name the other fourteen.
 */
data class SessionScreenActions(
    val onDraftChange: (String) -> Unit = {},
    val onSend: () -> Unit = {},
    val onInterrupt: () -> Unit = {},
    val onAttach: () -> Unit = {},
    val onRemoveAttachment: (String) -> Unit = {},
    val onRetrySend: (String) -> Unit = {},
    val onDiscardOutgoing: (StreamItem) -> Unit = {},
    val onRetryConnection: () -> Unit = {},
    val onWake: () -> Unit = {},
    val onCancelWorkstationWait: () -> Unit = {},
    val onRetryWorkstation: () -> Unit = {},
    val isToolExpanded: (String) -> Boolean = { false },
    val onToolExpandedChanged: (String, Boolean) -> Unit = { _, _ -> },
    val onDismissStaleInteraction: (String) -> Unit = {},
    val isInteractionStale: (PendingInteraction) -> Boolean = { false },
    val onOpenPodDetails: (Pod) -> Unit = {},
    val onOpenModelPicker: () -> Unit = {},
    val onNavigateBack: (() -> Unit)? = null,
)

/** Test handles the acceptance pass addresses the session screen by. */
object SessionTestTags {
    const val SCREEN = "session-screen"
    const val TRANSCRIPT = "session-transcript"
    const val CONNECTION_BANNER = "connection-banner"
    const val CONNECTION_BANNER_ACTION = "connection-banner-action"
    const val TRANSCRIPT_NOTICE = "transcript-notice"
    const val TRANSCRIPT_LOADING = "transcript-loading"
    const val POD_DETAILS = "session-pod-details"
}

/** The screen, driven by a live [SessionViewModel]. */
@Composable
fun SessionScreen(
    viewModel: SessionViewModel,
    modifier: Modifier = Modifier,
    onOpenPodDetails: (Pod) -> Unit = {},
    onOpenModelPicker: (SessionStream) -> Unit = {},
    onNavigateBack: (() -> Unit)? = null,
    push: PushController? = null,
    approvalControls: @Composable (PendingInteraction) -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val podId = state.livePod.id

    // The socket is torn down in the background; coming back should not cost the
    // user a three-second stare at a dead screen.
    //
    // The same observer reports which pod is on screen, so an approval raised by
    // the conversation the reader is looking at does not also arrive as a
    // notification. It is cleared on pause and on dispose — a stale id there
    // would silence the banners for a pod nobody is watching.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, viewModel, push, podId) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> {
                    viewModel.onForeground()
                    push?.visiblePodId = podId
                }

                Lifecycle.Event.ON_PAUSE -> {
                    if (push?.visiblePodId == podId) push.visiblePodId = null
                }

                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            if (push?.visiblePodId == podId) push.visiblePodId = null
        }
    }

    val pickImages = rememberAttachmentPicker(
        existing = { viewModel.state.value.attachments },
        onPicked = viewModel::onImagesPicked,
        onError = viewModel::onAttachFailed,
        onPickingChanged = viewModel::setPickingImages,
    )

    SessionScreen(
        state = state,
        actions = SessionScreenActions(
            onDraftChange = viewModel::onDraftChange,
            onSend = viewModel::send,
            onInterrupt = viewModel::interrupt,
            onAttach = pickImages,
            onRemoveAttachment = viewModel::removeAttachment,
            onRetrySend = viewModel::retrySend,
            onDiscardOutgoing = viewModel::discardOutgoing,
            onRetryConnection = viewModel::retryConnection,
            onWake = viewModel::wake,
            onCancelWorkstationWait = viewModel::cancelWorkstationWait,
            onRetryWorkstation = viewModel::retryWorkstationWait,
            isToolExpanded = viewModel.stream::isToolExpanded,
            onToolExpandedChanged = viewModel::setToolExpanded,
            onDismissStaleInteraction = viewModel::dismissStaleInteraction,
            isInteractionStale = viewModel.stream::isInteractionStale,
            onOpenPodDetails = onOpenPodDetails,
            onOpenModelPicker = { onOpenModelPicker(viewModel.stream) },
            onNavigateBack = onNavigateBack,
        ),
        modifier = modifier,
        approvalControls = approvalControls,
    )
}


/**
 * The phone's window into a pi session, as a pure function of [state]: replay is
 * compacted into a readable conversation while transport details stay out of the
 * user's way.
 *
 * Ported from `pi-pod-flutter/lib/features/session/session_view.dart`.
 *
 * @param approvalControls built by the caller so the transcript does not depend
 *   on the interactions feature; both are wired at the router.
 */
@Composable
fun SessionScreen(
    state: SessionState,
    actions: SessionScreenActions,
    modifier: Modifier = Modifier,
    listState: LazyListState = rememberLazyListState(),
    approvalControls: @Composable (PendingInteraction) -> Unit = {},
) {
    val subtitle = state.statusSubtitle
    val pod = state.livePod
    val keyboard = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope()
    val composerFocus = remember { FocusRequester() }

    // A suggestion chip fills the composer and puts the caret in it. Filling a
    // field the reader cannot see — and whose keyboard never came up — reads as
    // the chip having done nothing at all.
    val chooseSuggestion: (String) -> Unit = { suggestion ->
        actions.onDraftChange(suggestion)
        composerFocus.requestFocus()
    }

    var followsLatest by remember { mutableStateOf(true) }
    var readThroughCount by remember { mutableIntStateOf(0) }
    val isDragged by listState.interactionSource.collectIsDraggedAsState()
    val atBottom by remember { derivedStateOf { !listState.canScrollForward } }

    // Returning to the bottom by drag or fling re-arms follow automatically;
    // dragging away from it while following turns follow off and marks what the
    // reader had already seen.
    LaunchedEffect(atBottom, isDragged) {
        if (atBottom) {
            followsLatest = true
        } else if (isDragged && followsLatest) {
            followsLatest = false
            readThroughCount = state.stream.items.size
        }
    }
    // Dragging the transcript dismisses the soft keyboard, so a half-screen
    // keyboard does not trap the conversation.
    LaunchedEffect(isDragged) {
        if (isDragged) keyboard?.hide()
    }

    AppScaffold(
        modifier = modifier.testTag(SessionTestTags.SCREEN),
        titleSemanticsLabel = state.titleSemanticsLabel,
        onNavigateBack = actions.onNavigateBack,
        titleContent = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = pod.name,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.titleMedium,
                )
                if (subtitle != null) {
                    Text(
                        text = subtitle,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                        color = appColors.secondaryLabel,
                    )
                }
            }
        },
        actions = {
            AppIconButton(
                icon = AppIcons.info,
                onClick = { actions.onOpenPodDetails(pod) },
                semanticsLabel = "Pod details",
                modifier = Modifier.testTag(SessionTestTags.POD_DETAILS),
            )
            ModelPickerButton(
                state = ModelPickerState.from(state.stream),
                onClick = actions.onOpenModelPicker,
            )
        },
    ) { insets ->
        BoxWithConstraints(
            Modifier
                .fillMaxSize()
                .padding(top = insets.calculateTopPadding())
                .background(appColors.background),
        ) {
            // Extension components are laid out in the pod against a terminal
            // grid, so they are told how many rows this session view has.
            val viewportWidth = maxWidth
            val rows = rememberAnsiCellMetrics(MonospaceTextStyle).rowsIn(maxHeight)
            val revision = state.remoteUi.revision
            val surfaces = state.remoteUi.surfaces
            val overlays = surfaces.filter { it.role == RemoteUiRole.CUSTOM }
            // System back closes the topmost extension surface rather than
            // leaving the conversation: an overlay is the frontmost thing on
            // screen, and back is what dismisses the frontmost thing.
            BackHandler(enabled = overlays.isNotEmpty()) { overlays.last().close() }
            val editor = surfaces.lastOrNull { it.role == RemoteUiRole.EDITOR }
            val header = surfaces.lastOrNull { it.role == RemoteUiRole.HEADER }
            val footer = surfaces.lastOrNull { it.role == RemoteUiRole.FOOTER }

            Column(Modifier.fillMaxSize()) {
                ConnectionBanner(
                    state = state,
                    onRetry = actions.onRetryConnection,
                    onWake = actions.onWake,
                )
                // The reader's own workstation, when the gateway refused the
                // attach because it is not running. This is not the asleep pod
                // below it: that wakes on a keystroke, while this is a whole VM
                // measured in minutes, with its own Cancel that says what
                // stopping really does.
                val workstationWait = state.stream.workstationWait
                if (workstationWait != null) {
                    WorkstationWaitCard(
                        state = workstationWait,
                        onCancel = actions.onCancelWorkstationWait,
                        onRetry = actions.onRetryWorkstation,
                    )
                }
                if (header != null) {
                    RemoteUiBand(
                        surface = header,
                        viewportRows = rows,
                        isHeader = true,
                        revision = revision,
                    )
                }
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    Transcript(
                        state = state,
                        actions = actions,
                        listState = listState,
                        viewportWidth = viewportWidth,
                        onChooseSuggestion = chooseSuggestion,
                        approvalControls = approvalControls,
                    )
                    if (!followsLatest) {
                        JumpToLatestButton(
                            newMessageCount = (state.stream.items.size - readThroughCount)
                                .coerceAtLeast(0),
                            onClick = {
                                followsLatest = true
                                scope.launch { listState.scrollToBottom(animated = true) }
                            },
                            modifier = Modifier.align(Alignment.BottomEnd),
                        )
                    }
                    if (overlays.isNotEmpty()) {
                        RemoteUiOverlayLayer(
                            surfaces = overlays,
                            viewportRows = rows,
                            revision = revision,
                        )
                    }
                }
                RemoteUiWidgetStack(
                    surfaces = widgets(surfaces, RemoteUiPlacement.ABOVE_EDITOR),
                    viewportRows = rows,
                    revision = revision,
                )
                if (editor != null) {
                    RemoteUiEditorPanel(surface = editor, viewportRows = rows, revision = revision)
                }
                ComposerBar(
                    state = state.composer,
                    onValueChange = actions.onDraftChange,
                    onSend = {
                        followsLatest = true
                        actions.onSend()
                    },
                    onInterrupt = actions.onInterrupt,
                    onAttach = actions.onAttach,
                    onRemoveAttachment = actions.onRemoveAttachment,
                    focusRequester = composerFocus,
                )
                RemoteUiWidgetStack(
                    surfaces = widgets(surfaces, RemoteUiPlacement.BELOW_EDITOR),
                    viewportRows = rows,
                    revision = revision,
                )
                if (footer != null) {
                    RemoteUiBand(
                        surface = footer,
                        viewportRows = rows,
                        isHeader = false,
                        revision = revision,
                    )
                }
            }

            // Watch the reducer's own revision rather than the item list: a
            // streaming delta mutates the last row without changing its
            // identity, and only the reducer knows that happened.
            LaunchedEffect(state.stream.scrollRevision) {
                if (followsLatest && state.stream.scrollRevision > 0) {
                    // Streaming deltas arrive many times a second; animating
                    // each scroll makes the transcript judder.
                    listState.scrollToBottom(animated = !state.stream.scrollIsStreamingUpdate)
                }
            }
        }
    }
}

private fun widgets(surfaces: List<RemoteUiSurface>, placement: RemoteUiPlacement) =
    surfaces.filter { it.role == RemoteUiRole.WIDGET && it.placement == placement }

private suspend fun LazyListState.scrollToBottom(animated: Boolean) {
    val last = layoutInfo.totalItemsCount - 1
    if (last < 0) return
    if (animated) animateScrollToItem(last) else scrollToItem(last)
}

@Composable
private fun Transcript(
    state: SessionState,
    actions: SessionScreenActions,
    listState: LazyListState,
    viewportWidth: Dp,
    onChooseSuggestion: (String) -> Unit,
    approvalControls: @Composable (PendingInteraction) -> Unit,
) {
    val session = state.stream
    // Grouping must never blank the conversation: show what arrived as plain
    // rows instead if it throws.
    val rows = remember(session.items) {
        runCatching { TranscriptPresentation.rows(session.items) }.getOrElse {
            session.items.map { item -> TranscriptRow.Item(item, MessageChrome.STANDALONE) }
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag(SessionTestTags.TRANSCRIPT),
        state = listState,
        // The list stays viewport-wide so a fling over the gutter still
        // scrolls; the reading column is a padding, not a narrower list.
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)
            .centeredIn(viewportWidth),
    ) {
        val preparing = session.preparingPod
        when {
            preparing != null -> item(key = "preparing") { SandboxPreparationView(pod = preparing) }

            session.historyLoadFailed && session.items.isEmpty() -> item(key = "history-failed") {
                TranscriptNotice(
                    title = "Conversation history couldn’t be loaded",
                    description = "Retry to load the earlier messages. Sending still works.",
                    actionLabel = "Retry",
                    onAction = actions.onRetryConnection,
                )
            }

            // An existing conversation must never flash "start a conversation"
            // while its history is still in flight.
            session.isLoadingHistory -> item(key = "loading-history") {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 40.dp)
                        .semantics { contentDescription = "Loading conversation" }
                        .testTag(SessionTestTags.TRANSCRIPT_LOADING),
                    contentAlignment = Alignment.Center,
                ) {
                    AppActivityIndicator()
                }
            }

            session.items.isEmpty() && session.pendingInteractions.isEmpty() ->
                item(key = "empty-conversation") {
                    ConversationEmptyState(onChooseSuggestion = onChooseSuggestion)
                }
        }

        // Rows carry stable keys by message/tool-call id so expansion and
        // interaction state survive insertions elsewhere in the transcript.
        items(count = rows.size, key = { index -> rows[index].id }) { index ->
            when (val row = rows[index]) {
                is TranscriptRow.Day -> DaySeparator(title = row.title)
                is TranscriptRow.Tools -> ToolActivityCard(
                    items = row.items,
                    isExpanded = actions.isToolExpanded,
                    onExpandedChanged = actions.onToolExpandedChanged,
                )

                is TranscriptRow.Item -> EventRow(
                    item = row.item,
                    chrome = row.chrome,
                    thinkingLabel = session.hiddenThinkingLabel,
                    onRetry = { actions.onRetrySend(row.item.id) },
                    onDiscard = { actions.onDiscardOutgoing(row.item) },
                )
            }
        }

        items(
            count = session.pendingInteractions.size,
            key = { index -> "approval-${session.pendingInteractions[index].id}" },
        ) { index ->
            val interaction = session.pendingInteractions[index]
            // A card the stream thinks is stale may still be answerable: only a
            // resolution event truly retires a request. Keep the usual actions
            // and add Dismiss, with a caption saying pi moved on.
            val stale = actions.isInteractionStale(interaction)
            Box(Modifier.padding(vertical = 6.dp)) {
                ApprovalCard(
                    interaction = interaction,
                    isStale = stale,
                    onDismissStale = if (stale) {
                        { actions.onDismissStaleInteraction(interaction.id) }
                    } else {
                        null
                    },
                    controls = { approvalControls(interaction) },
                )
            }
        }

        if (session.workingVisible ||
            TranscriptPresentation.showsTypingIndicator(
                isRunning = session.isRunning,
                lastItem = session.items.lastOrNull(),
            )
        ) {
            item(key = "typing") {
                TypingIndicator(label = session.workingMessage ?: session.workingIndicator)
            }
        }

        item(key = "transcript-tail") { Spacer(Modifier.height(28.dp)) }
    }
}

@Composable
private fun TranscriptNotice(
    title: String,
    description: String,
    actionLabel: String,
    onAction: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 32.dp)
            .testTag(SessionTestTags.TRANSCRIPT_NOTICE),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = AppIcons.syncProblem,
            contentDescription = null,
            tint = appColors.secondaryLabel,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(10.dp))
        Text(title, textAlign = TextAlign.Center, style = MaterialTheme.typography.titleSmall)
        Spacer(Modifier.height(4.dp))
        Text(
            text = description,
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodySmall,
            color = appColors.secondaryLabel,
        )
        Spacer(Modifier.height(12.dp))
        AppButton(
            text = actionLabel,
            onClick = onAction,
            kind = AppButtonKind.Tinted,
            semanticsLabel = actionLabel,
        )
    }
}

/**
 * The one strip that reports how the connection is doing, with the recovery
 * next to the explanation.
 */
@Composable
private fun ConnectionBanner(state: SessionState, onRetry: () -> Unit, onWake: () -> Unit) {
    val banner = connectionBanner(state) ?: return

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(banner.background ?: Color.Transparent)
            .padding(horizontal = 16.dp, vertical = 6.dp)
            // One scoped live-region node: the text is announced once, and the
            // action keeps its own button node.
            .testTag(SessionTestTags.CONNECTION_BANNER),
    ) {
        ContentPane {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Start,
            ) {
                if (banner.spinner) {
                    AppActivityIndicator(size = 14.dp)
                } else if (banner.icon != null) {
                    Icon(
                        imageVector = banner.icon,
                        contentDescription = null,
                        tint = banner.tint,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Spacer(Modifier.width(8.dp))
                Text(
                    text = banner.text,
                    style = MaterialTheme.typography.bodySmall,
                    color = banner.tint,
                    modifier = Modifier
                        .weight(1f)
                        .clearAndSetSemantics {
                            contentDescription = banner.text
                            liveRegion = LiveRegionMode.Polite
                        },
                )
                if (banner.action != null) {
                    AppButton(
                        text = banner.action,
                        onClick = if (banner.action == "Wake") onWake else onRetry,
                        kind = AppButtonKind.Plain,
                        size = AppButtonSize.Small,
                        // Recovery actions stay tappable: a small plain button
                        // would otherwise collapse below the 48dp minimum.
                        minSize = DpSize(AppButtonDefaults.MinTouchTarget, AppButtonDefaults.MinTouchTarget),
                        semanticsLabel = banner.action,
                        modifier = Modifier.testTag(SessionTestTags.CONNECTION_BANNER_ACTION),
                    )
                }
            }
        }
    }
}

/** What the connection banner says, or null when there is nothing to report. */
internal data class ConnectionBannerModel(
    val text: String,
    val tint: Color,
    val icon: ImageVector? = null,
    val spinner: Boolean = false,
    val background: Color? = null,
    val action: String? = null,
)

@Composable
private fun connectionBanner(state: SessionState): ConnectionBannerModel? {
    val colors = appColors
    val session = state.stream
    val muted = colors.secondaryLabel

    // The workstation card above owns this surface: while it is showing, no
    // banner may reframe the wait as an asleep pod, a wake-on-keystroke, or a
    // generic error.
    if (session.workstationWait != null) return null

    if (session.preparingPod != null) {
        return ConnectionBannerModel(
            text = "Sandbox is initializing — messages are saved until it is ready.",
            tint = muted,
            spinner = true,
        )
    }
    if (session.podUnavailable) {
        return ConnectionBannerModel(
            text = "This pod is unavailable. Check its status on the pod screen, then retry.",
            tint = muted,
            icon = AppIcons.errorOutline,
            background = colors.fill.copy(alpha = 0.5f),
            action = "Retry",
        )
    }
    val error = session.gatewayError?.let { FriendlyError.message(it) } ?: session.error
    if (error != null) {
        return ConnectionBannerModel(
            text = error,
            tint = colors.destructive,
            icon = AppIcons.warningOutline,
            background = colors.destructive.copy(alpha = 0.08f),
            action = "Retry",
        )
    }
    if (session.isOffline && !session.isConnected) {
        return ConnectionBannerModel(
            text = "Offline — reconnecting when the network returns",
            tint = muted,
            icon = AppIcons.offline,
            action = "Retry",
        )
    }
    if (session.waking) {
        return ConnectionBannerModel(
            text = if (session.asleep == "archived") {
                "Waking pod from cold storage — seconds-to-minutes depending on workspace size…"
            } else {
                "Waking pod…"
            },
            tint = muted,
            spinner = true,
        )
    }
    if (session.asleep != null && !session.isConnected) {
        return ConnectionBannerModel(
            text = "Pod is asleep — sending a message wakes it.",
            tint = muted,
            icon = AppIcons.asleepOutline,
            background = colors.fill.copy(alpha = 0.5f),
            action = "Wake",
        )
    }
    if (!session.isConnected) {
        return ConnectionBannerModel(
            text = when {
                !session.reconnecting -> "Connecting…"
                session.reconnectAttempt > 1 -> "Reconnecting… (attempt ${session.reconnectAttempt})"
                else -> "Reconnecting…"
            },
            tint = muted,
            spinner = true,
            action = if (session.reconnecting) "Retry now" else null,
        )
    }
    return null
}
