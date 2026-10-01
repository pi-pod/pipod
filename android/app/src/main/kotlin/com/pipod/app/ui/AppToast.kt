package com.pipod.app.ui

import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics

/**
 * Confirms something small that already happened, such as a copy.
 *
 * Ported from `pi-pod-flutter/lib/ui/app_toast.dart`. Nothing shown here is
 * undoable, so the bar carries no action and leaves on its own; it is
 * announced as a live region so the confirmation reaches a reader who is not
 * looking at the bottom of the screen.
 */
@Composable
fun AppToastHost(hostState: SnackbarHostState, modifier: Modifier = Modifier) {
    SnackbarHost(
        hostState = hostState,
        modifier = modifier.semantics { liveRegion = LiveRegionMode.Polite },
    ) { data ->
        Snackbar(snackbarData = data)
    }
}

/** Remembers the toast host for one screen. */
@Composable
fun rememberAppToastHostState(): SnackbarHostState = remember { SnackbarHostState() }

/**
 * The screen's toast host, so a deeply nested control can confirm a copy
 * without every layer between it and the scaffold passing the host down.
 *
 * The fallback is a live host nobody renders, which drops the message rather
 * than crashing — the Flutter original's `ScaffoldMessenger.maybeOf` has the
 * same shape, and a missed confirmation is never worth a crash.
 */
val LocalAppToastHost = compositionLocalOf { SnackbarHostState() }

/**
 * Shows [message] and returns once it has been dismissed.
 *
 * Suspends by design: a toast belongs to the coroutine that did the thing it
 * is confirming, so leaving that screen cancels the toast with it.
 */
suspend fun showAppToast(host: SnackbarHostState, message: String) {
    host.showSnackbar(message = message, duration = SnackbarDuration.Short)
}
