package com.pipod.app.ui

import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically

/**
 * The transitions a screen uses for going deeper and coming back, ported from
 * `pi-pod-flutter/lib/ui/app_route.dart`.
 *
 * Flutter picks a route class per platform; Compose navigation takes the
 * transitions as arguments to `composable(...)`, so the choice lives here as
 * four values a `NavHost` passes through rather than a route factory.
 */
object AppRouteTransitions {

    private const val DURATION_MS = 300

    /** A pushed screen arrives from the trailing edge, over the one it covers. */
    val enter: EnterTransition =
        slideInHorizontally(animationSpec = tween(DURATION_MS)) { width -> width } +
            fadeIn(animationSpec = tween(DURATION_MS))

    /** The covered screen slides a short way in the same direction, not out. */
    val exit: ExitTransition =
        slideOutHorizontally(animationSpec = tween(DURATION_MS)) { width -> -width / 4 } +
            fadeOut(animationSpec = tween(DURATION_MS))

    val popEnter: EnterTransition =
        slideInHorizontally(animationSpec = tween(DURATION_MS)) { width -> -width / 4 } +
            fadeIn(animationSpec = tween(DURATION_MS))

    val popExit: ExitTransition =
        slideOutHorizontally(animationSpec = tween(DURATION_MS)) { width -> width } +
            fadeOut(animationSpec = tween(DURATION_MS))

    /**
     * A screen presented as a task rather than as a place, such as a launch
     * form. It comes up from the bottom, which is what says "finish or cancel
     * this" instead of "you have gone one level deeper".
     */
    val modalEnter: EnterTransition =
        slideInVertically(animationSpec = tween(DURATION_MS)) { height -> height }

    val modalExit: ExitTransition =
        slideOutVertically(animationSpec = tween(DURATION_MS)) { height -> height }
}
