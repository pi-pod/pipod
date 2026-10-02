package com.pipod.app.features.session

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.WorkstationDemand
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.workstation.WorkstationStatusSource
import com.pipod.app.core.workstation.WorkstationWaitOutcome
import com.pipod.app.core.workstation.WorkstationWaitSession
import com.pipod.app.core.workstation.WorkstationWaitState
import com.pipod.app.features.common.WorkstationWaitCard
import com.pipod.app.features.pods.ModelPickerScreen
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.CancellationException

/**
 * Resolves the pod a deep link names before the transcript opens, ported from
 * `pi-pod-flutter/lib/features/session/session_route.dart`.
 *
 * A push notification carries only an id, and the transcript's header needs a
 * real pod to title itself with.
 */
@Composable
fun SessionRoute(
    podId: String,
    client: ApiClient,
    drafts: SessionDraftStore,
    modifier: Modifier = Modifier,
    initialPod: Pod? = null,
    fromSeq: Long? = null,
    sessionId: String? = null,
    onOpenPodDetails: (Pod) -> Unit = {},
    onBack: () -> Unit = {},
) {
    var attempt by remember(podId) { mutableIntStateOf(0) }
    // The reader's own workstation, when resolving the pod found it not ready.
    // Every other entry point — launch, the list, the detail, the socket attach
    // itself — turns that 503 into this card; this route used to be the one
    // place that called a multi-minute wait a dead end with a manual Retry.
    var wait by remember(podId) { mutableStateOf<WorkstationWaitState?>(null) }
    val waitSession = remember(podId, client) {
        WorkstationWaitSession(
            status = WorkstationStatusSource { hostId -> client.workstation(hostId) },
            onState = { state -> wait = state },
        )
    }
    val loaded by produceState<Result<Pod>?>(null, podId, initialPod, attempt) {
        if (initialPod != null) {
            value = Result.success(initialPod)
            return@produceState
        }
        value = null
        // A repository may throw synchronously; normalising it here keeps Retry
        // from throwing back out of the tap handler. The wait runs inside this
        // effect, so leaving the route cancels it with the coroutine.
        value = try {
            Result.success(client.pod(podId))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            resolveUnderWorkstationWait(waitSession, error) { client.pod(podId) }
        }
    }

    val outcome = loaded
    val pendingWait = wait
    when (sessionRoutePhase(outcome, pendingWait)) {
        SessionRoutePhase.Waiting -> WorkstationWaitPending(
            state = pendingWait!!,
            onCancel = waitSession::cancel,
            onRetry = {
                waitSession.clear()
                attempt += 1
            },
            onBack = onBack,
            modifier = modifier,
        )

        SessionRoutePhase.Loading -> LoadingConversation(modifier)

        SessionRoutePhase.Failed -> SessionLoadFailure(
            error = outcome?.exceptionOrNull() ?: IllegalStateException("Unknown error"),
            onRetry = { attempt += 1 },
            onBack = onBack,
            modifier = modifier,
        )

        SessionRoutePhase.Ready -> {
            val pod = outcome!!.getOrThrow()
            val viewModel: SessionViewModel = viewModel(key = "session-${pod.id}") {
                SessionViewModel.create(
                    client = client,
                    drafts = drafts,
                    pod = pod,
                    fromSeq = fromSeq,
                    sessionId = sessionId,
                )
            }
            // The picker lives here rather than in the route table because it
            // acts on the live stream this route owns — which is what lets it be
            // a saved boolean: after process death the stream is rebuilt here
            // and the sheet can be put back over it.
            var isPickingModel by rememberSaveable(pod.id) { mutableStateOf(false) }
            SessionScreen(
                viewModel = viewModel,
                modifier = modifier,
                onOpenPodDetails = onOpenPodDetails,
                onOpenModelPicker = { isPickingModel = true },
                onNavigateBack = onBack,
            )
            // A sheet over the conversation rather than a route: it acts on the
            // live stream, which does not survive a navigation, and the
            // transcript keeps streaming behind it.
            if (isPickingModel) {
                ModelPickerScreen(
                    stream = viewModel.stream,
                    onDone = { isPickingModel = false },
                )
            }
        }
    }
}

/** What the route is drawing, as one decision a test can read back. */
internal enum class SessionRoutePhase { Waiting, Loading, Failed, Ready }

/**
 * Which of the four the route draws.
 *
 * The workstation card outranks both the spinner and the failure: while a wait
 * is up — running, or resting after being stopped — it is the honest account of
 * why there is no conversation yet, and a “Couldn’t load this pod” underneath
 * would be the same news told worse.
 */
internal fun sessionRoutePhase(
    outcome: Result<Pod>?,
    wait: WorkstationWaitState?,
): SessionRoutePhase = when {
    outcome?.isSuccess == true -> SessionRoutePhase.Ready
    wait != null -> SessionRoutePhase.Waiting
    outcome == null -> SessionRoutePhase.Loading
    else -> SessionRoutePhase.Failed
}

/**
 * Runs the pod read under a workstation wait when that is what the failure was.
 *
 * A wait that ends without the pod — stopped, out of budget, or terminal —
 * returns the original failure: the resting card is already saying what
 * happened, so the caller keeps drawing it rather than replacing it with a
 * second, blunter version of the same news.
 */
internal suspend fun resolveUnderWorkstationWait(
    session: WorkstationWaitSession,
    error: Throwable,
    request: suspend () -> Pod,
): Result<Pod> {
    val demand = WorkstationDemand.fromThrowable(error) ?: return Result.failure(error)
    return when (val outcome = session.runFor(demand) { request() }) {
        is WorkstationWaitOutcome.Ready -> Result.success(outcome.value)
        is WorkstationWaitOutcome.Failed -> Result.failure(outcome.error)
        else -> Result.failure(error)
    }
}

/** The workstation card, standing in for a conversation that cannot open yet. */
@Composable
private fun WorkstationWaitPending(
    state: WorkstationWaitState,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    AppScaffold(modifier = modifier.testTag(SessionRouteTestTags.WORKSTATION_WAIT)) { insets ->
        Box(
            Modifier.fillMaxSize().padding(insets),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()).padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                WorkstationWaitCard(state = state, onCancel = onCancel, onRetry = onRetry)
                Spacer(Modifier.height(12.dp))
                AppButton(
                    text = "Back to pod",
                    onClick = onBack,
                    kind = AppButtonKind.Plain,
                    modifier = Modifier.testTag(SessionRouteTestTags.BACK),
                )
            }
        }
    }
}

@Composable
private fun LoadingConversation(modifier: Modifier = Modifier) {
    AppScaffold(modifier = modifier.testTag(SessionRouteTestTags.LOADING)) { insets ->
        Box(
            Modifier.fillMaxSize().padding(insets),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.semantics { contentDescription = "Loading conversation" }) {
                AppActivityIndicator()
            }
        }
    }
}

@Composable
private fun SessionLoadFailure(
    error: Throwable,
    onRetry: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    AppScaffold(modifier = modifier.testTag(SessionRouteTestTags.FAILURE)) { insets ->
        Box(
            Modifier.fillMaxSize().padding(insets),
            contentAlignment = Alignment.Center,
        ) {
            // Scrollable so Retry and Back stay reachable on short landscape
            // viewports and at large text scales instead of overflowing.
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()).padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(
                    imageVector = AppIcons.errorOutline,
                    contentDescription = null,
                    tint = appColors.secondaryLabel,
                    modifier = Modifier.size(40.dp),
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    text = FriendlyError.message(error, RuntimeConfig.serverUrl),
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(16.dp))
                AppButton(
                    text = "Retry",
                    onClick = onRetry,
                    modifier = Modifier.testTag(SessionRouteTestTags.RETRY),
                )
                Spacer(Modifier.height(8.dp))
                AppButton(
                    text = "Back to pod",
                    onClick = onBack,
                    kind = AppButtonKind.Plain,
                    modifier = Modifier.testTag(SessionRouteTestTags.BACK),
                )
            }
        }
    }
}

object SessionRouteTestTags {
    const val LOADING = "session-route-loading"
    const val WORKSTATION_WAIT = "session-route-workstation-wait"
    const val FAILURE = "session-route-failure"
    const val RETRY = "session-route-retry"
    const val BACK = "session-route-back"
}
