package com.pipod.app.ui

import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Widest a window is still one column of content, from
 * `pi-pod-flutter/lib/shell/layout_constants.dart`.
 *
 * Deliberately not Material's own 600dp compact cut: pi pod's rows carry a
 * title, a status chip and a timestamp, and those stop fitting side by side
 * before Material says the window got wide.
 */
val CompactWidthBreakpoint: Dp = 700.dp

/**
 * The window width a widget should branch on.
 *
 * Reading it through a composition local rather than the configuration
 * directly is what lets a test — or a pane inside a two-pane tablet layout —
 * say how wide it really is, instead of every widget independently asking the
 * device how big its screen is.
 */
val LocalWindowWidth = compositionLocalOf<Dp?> { null }

/** The current window width, falling back to the device's own screen width. */
@Composable
@ReadOnlyComposable
fun currentWindowWidth(): Dp =
    LocalWindowWidth.current ?: LocalConfiguration.current.screenWidthDp.dp

/**
 * Whether the layout is the single-column phone one.
 *
 * The Flutter app is adaptive across phone, tablet and desktop; this port only
 * renders the compact branch, so the seam stays here rather than disappearing —
 * a tablet layout later reads [currentWindowWidth] or [windowWidthSizeClass]
 * instead of re-deriving a breakpoint.
 */
@Composable
@ReadOnlyComposable
fun isCompactWidth(): Boolean = currentWindowWidth() < CompactWidthBreakpoint

/** Material's own width buckets, for a layout that wants three steps, not two. */
@OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
@Composable
@ReadOnlyComposable
fun windowWidthSizeClass(): WindowWidthSizeClass {
    val width = currentWindowWidth()
    return when {
        width < 600.dp -> WindowWidthSizeClass.Compact
        width < 840.dp -> WindowWidthSizeClass.Medium
        else -> WindowWidthSizeClass.Expanded
    }
}
