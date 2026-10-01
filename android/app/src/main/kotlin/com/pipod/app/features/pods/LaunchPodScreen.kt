package com.pipod.app.features.pods

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.workstation.WorkstationWaitState
import com.pipod.app.features.common.UnsupportedListItemCard
import com.pipod.app.features.common.WorkstationWaitCard
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonContent
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppOption
import com.pipod.app.ui.AppOptionPicker
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.appScaffoldBackground
import com.pipod.app.ui.theme.appColors

/** The value the environment picker uses for "no environment at all". */
private const val NO_ENVIRONMENT = ""

/**
 * Chooses an active environment and launches a disposable pod immediately.
 *
 * Port of `pi-pod-flutter/lib/features/pods/launch_pod_view.dart` and
 * `launch_pod_route.dart`. Success navigation belongs to [onLaunched]: the
 * production route replaces this screen with the pod detail, so the screen must
 * not leave by itself — popping would remove the freshly pushed detail.
 */
@Composable
fun LaunchPodScreen(
    viewModel: LaunchPodViewModel,
    onLaunched: (Pod) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is LaunchPodEvent.Launched -> onLaunched(event.pod)
            }
        }
    }

    LaunchPodScreen(
        state = state,
        onSelectTemplate = viewModel::selectTemplate,
        onLaunch = viewModel::launch,
        onRetryLoadTemplates = viewModel::loadTemplates,
        onCancel = onCancel,
        onCancelWorkstationWait = viewModel::cancelWorkstationWait,
        onRetryWorkstation = viewModel::retryAfterWorkstationWait,
        modifier = modifier,
    )
}

/** The launch flow as a pure function of [state]. */
@Composable
fun LaunchPodScreen(
    state: LaunchPodState,
    onSelectTemplate: (String?) -> Unit,
    onLaunch: () -> Unit,
    onRetryLoadTemplates: () -> Unit,
    onCancel: () -> Unit,
    onCancelWorkstationWait: () -> Unit = {},
    onRetryWorkstation: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    // A launch in flight must not be abandoned by the system back gesture: the
    // request would finish on a screen nobody is looking at and leave an orphan
    // pod running on the server.
    BackHandler(enabled = state.isLaunching) { }

    AppScaffold(
        modifier = modifier.testTag(LaunchPodTestTags.SCREEN),
        title = state.title,
        grouped = true,
        navigationIcon = {
            AppButton(
                text = "Cancel",
                onClick = onCancel,
                kind = AppButtonKind.Plain,
                enabled = !state.isLaunching,
                semanticsLabel = if (state.isRetry) "Cancel retry pod" else "Cancel new pod",
                modifier = Modifier.testTag(LaunchPodTestTags.CANCEL),
            )
        },
    ) { insets ->
        Box(Modifier.fillMaxSize().padding(insets)) {
            when {
                state.templatesError != null -> TemplateLoadError(
                    message = state.templatesError,
                    onRetry = onRetryLoadTemplates,
                )

                state.isLoadingTemplates -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    AppActivityIndicator(
                        modifier = Modifier.semantics {
                            contentDescription = "Loading environments"
                        },
                    )
                }

                else -> LaunchPodForm(
                    state = state,
                    onSelectTemplate = onSelectTemplate,
                    onLaunch = onLaunch,
                    onRetryWorkstation = onRetryWorkstation,
                )
            }

            // A workstation that is still coming up replaces the plain spinner:
            // it is minutes rather than seconds, so the overlay has to say what
            // is happening and offer a way to stop waiting.
            val wait = state.workstationWait
            if (wait != null && wait.isWaiting) {
                WorkstationLaunchOverlay(state = wait, onCancel = onCancelWorkstationWait)
            } else if (state.isLaunching) {
                LaunchingOverlay()
            }
        }
    }
}

@Composable
private fun LaunchPodForm(
    state: LaunchPodState,
    onSelectTemplate: (String?) -> Unit,
    onLaunch: () -> Unit,
    onRetryWorkstation: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .dismissKeyboardOnScroll()
            .verticalScroll(rememberScrollState())
            .padding(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 32.dp),
    ) {
        repeat(state.unsupportedTemplateCount) {
            UnsupportedListItemCard(itemName = "environment")
            Spacer(Modifier.height(8.dp))
        }

        Box(Modifier.semantics { contentDescription = "Choose pod environment" }) {
            AppOptionPicker(
                label = "Environment",
                value = state.selectedTemplateId ?: NO_ENVIRONMENT,
                options = buildList {
                    add(AppOption(NO_ENVIRONMENT, "None (empty pod)"))
                    state.launchable.forEach { add(AppOption(it.id, it.name)) }
                },
                onValueChange = { id -> onSelectTemplate(id.takeIf { it != NO_ENVIRONMENT }) },
                enabled = !state.isLaunching,
            )
        }
        Spacer(Modifier.height(8.dp))
        Text(
            text = state.templateFooter,
            style = MaterialTheme.typography.bodySmall,
            color = appColors.secondaryLabel,
        )
        Spacer(Modifier.height(24.dp))
        AppButton(
            onClick = onLaunch,
            modifier = Modifier
                .fillMaxWidth()
                .testTag(LaunchPodTestTags.LAUNCH),
            enabled = !state.isLaunching,
            semanticsLabel = if (state.isRetry) "Retry pod launch" else "Launch new pod",
        ) {
            AppButtonContent(
                icon = if (state.isRetry) AppIcons.edit else AppIcons.add,
                label = if (state.isRetry) "Retry launch" else "Launch pod",
            )
        }

        // A finished wait — stopped, out of budget, or terminal — rests here
        // rather than under a modal nobody can dismiss.
        val wait = state.workstationWait
        if (wait != null && !wait.isWaiting) {
            Spacer(Modifier.height(20.dp))
            WorkstationWaitCard(state = wait, onRetry = onRetryWorkstation)
        }

        val error = state.error
        if (error != null) {
            Spacer(Modifier.height(20.dp))
            AppListSection(
                modifier = Modifier
                    .testTag(LaunchPodTestTags.ERROR)
                    .semantics(mergeDescendants = true) {
                        contentDescription = "Launch pod error"
                        liveRegion = LiveRegionMode.Polite
                    },
            ) {
                row {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(appColors.destructiveFill)
                            .padding(16.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            imageVector = AppIcons.warning,
                            contentDescription = null,
                            tint = appColors.destructive,
                        )
                        Spacer(Modifier.width(12.dp))
                        Text(
                            text = error,
                            color = appColors.destructive,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
}

/**
 * The scrim over a launch that is waiting on the reader's own workstation.
 *
 * Modal for the same reason [LaunchingOverlay] is — the launch is still in
 * flight and a second one must not start behind it — but it carries the wait's
 * own copy and its Cancel, because a multi-minute wait behind a bare spinner is
 * the thing this whole state exists to stop.
 */
@Composable
private fun WorkstationLaunchOverlay(
    state: WorkstationWaitState,
    onCancel: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0x14000000))
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) awaitPointerEvent().changes.forEach { it.consume() }
                }
            }
            .testTag(LaunchPodTestTags.WORKSTATION_WAIT),
        contentAlignment = Alignment.Center,
    ) {
        WorkstationWaitCard(
            state = state,
            modifier = Modifier.padding(16.dp),
            onCancel = onCancel,
        )
    }
}

/**
 * The scrim and card shown while the launch is in flight.
 *
 * It swallows taps, which is what stops a second launch being started behind
 * it — the Flutter original uses a `ModalBarrier` for exactly that.
 */
@Composable
private fun LaunchingOverlay() {
    Box(
        Modifier
            .fillMaxSize()
            .background(Color(0x14000000))
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) awaitPointerEvent().changes.forEach { it.consume() }
                }
            }
            .testTag(LaunchPodTestTags.LAUNCHING),
        contentAlignment = Alignment.Center,
    ) {
        AppListSection(
            modifier = Modifier
                .wrapContentWidth()
                .semantics(mergeDescendants = true) {
                    contentDescription = "Launching pod"
                    liveRegion = LiveRegionMode.Polite
                },
        ) {
            row {
                Row(
                    modifier = Modifier.padding(20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AppActivityIndicator(size = 22.dp)
                    Spacer(Modifier.width(12.dp))
                    Text("Launching pod…")
                }
            }
        }
    }
}

@Composable
private fun TemplateLoadError(message: String, onRetry: () -> Unit) {
    Box(
        Modifier.fillMaxSize().background(appScaffoldBackground(grouped = true)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(text = message, textAlign = TextAlign.Center)
            Spacer(Modifier.height(16.dp))
            AppButton(
                text = "Retry",
                onClick = onRetry,
                semanticsLabel = "Retry loading environments",
                modifier = Modifier.testTag(LaunchPodTestTags.RETRY_TEMPLATES),
            )
        }
    }
}

/**
 * Drops focus as soon as the content is dragged, which puts the keyboard away.
 *
 * The Flutter forms ask for this with
 * `ScrollViewKeyboardDismissBehavior.onDrag`; Compose has no such property, so
 * it is a nested-scroll connection that clears focus before the scroll runs.
 */
@Composable
private fun Modifier.dismissKeyboardOnScroll(): Modifier {
    val focus: FocusManager = LocalFocusManager.current
    val connection = remember(focus) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (available.y != 0f) focus.clearFocus()
                return Offset.Zero
            }
        }
    }
    return nestedScroll(connection)
}

/** The handles a UI test finds this screen's parts by. */
object LaunchPodTestTags {
    const val SCREEN = "launch-pod-screen"
    const val CANCEL = "launch-pod-cancel"

    /** Set by `AppOptionPicker` itself, from its visible label. */
    const val ENVIRONMENT_PICKER = "app-option-picker-Environment"
    const val LAUNCH = "launch-pod-launch"
    const val ERROR = "launch-pod-error"
    const val LAUNCHING = "launch-pod-launching"
    const val WORKSTATION_WAIT = "launch-pod-workstation-wait"
    const val RETRY_TEMPLATES = "launch-pod-retry-templates"
}
