package com.pipod.app.features.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.session.SessionStore
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppScaffold
import kotlinx.coroutines.CancellationException

/**
 * Holds every authenticated screen behind session restoration and sign-in.
 *
 * Port of `pi-pod-flutter/lib/features/auth/auth_gate.dart`. The gate is
 * composed once per destination, so it must not *drive* restoration — that is
 * kicked once from the activity. What it keeps is an idempotent nudge:
 * [SessionStore.restore] latches after the first settled attempt and is a
 * no-op on every navigation afterwards, but an attempt that failed because the
 * provider was unreachable does not latch, and this is what retries it without
 * making the person find a button.
 */
@Composable
fun AuthGate(
    session: SessionStore,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    // Deliberately not `collectAsStateWithLifecycle`: that pauses collection
    // while the app is backgrounded, and a token refresh or a sign-out that
    // lands there must already be reflected when the app comes back rather than
    // repainting a frame later.
    val state by session.state.collectAsState()
    var devTokenAttempted by remember(session) { mutableStateOf(false) }
    var devSignInRunning by remember(session) { mutableStateOf(false) }
    var devSignInError by remember(session) { mutableStateOf<String?>(null) }

    LaunchedEffect(session) { session.restore() }

    // The browser redirect can outlive the process that started the sign-in: the
    // app is killed behind the Custom Tab, and the callback arrives at a cold
    // start with no coroutine waiting for it. It is parked; resuming it here is
    // the difference between finishing that sign-in and asking for the whole
    // dance again.
    var callbackResumed by remember(session) { mutableStateOf(false) }
    var resumeRunning by remember(session) { mutableStateOf(false) }
    LaunchedEffect(session, state.user, state.isRestoringSession) {
        if (state.isRestoringSession || state.user != null) return@LaunchedEffect
        if (callbackResumed || !session.hasPendingAuthCallback) return@LaunchedEffect
        callbackResumed = true
        resumeRunning = true
        try {
            session.signIn()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // The sign-in screen already reports a refused or stale redirect
            // through `authNotice`; a parked callback that cannot be finished
            // simply leaves the person on it.
        } finally {
            resumeRunning = false
        }
    }

    val devToken = RuntimeConfig.devToken
    LaunchedEffect(session, state.user, state.isRestoringSession) {
        if (state.isRestoringSession || state.user != null) return@LaunchedEffect
        if (devToken.isEmpty() || devTokenAttempted) return@LaunchedEffect
        devTokenAttempted = true
        devSignInRunning = true
        try {
            session.signInWithDevToken(devToken)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            devSignInError = "Dev token sign-in failed: ${FriendlyError.message(error)}"
        } finally {
            devSignInRunning = false
        }
    }

    when {
        state.isRestoringSession -> AuthenticationProgress("Restoring session…", modifier)
        resumeRunning -> AuthenticationProgress("Signing in…", modifier)
        devSignInRunning -> AuthenticationProgress("Signing in with development token…", modifier)
        state.user == null -> SignInScreen(
            onSignIn = { session.signIn() },
            modifier = modifier,
            notice = state.authNotice,
            initialError = devSignInError,
        )

        else -> content()
    }
}

@Composable
private fun AuthenticationProgress(label: String, modifier: Modifier = Modifier) {
    AppScaffold(modifier = modifier.testTag("auth-progress")) { padding ->
        Box(
            Modifier.fillMaxSize().padding(padding),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
                modifier = Modifier.semantics {
                    contentDescription = label
                    liveRegion = LiveRegionMode.Polite
                },
            ) {
                AppActivityIndicator()
                Spacer(Modifier.height(16.dp))
                Text(label)
            }
        }
    }
}
