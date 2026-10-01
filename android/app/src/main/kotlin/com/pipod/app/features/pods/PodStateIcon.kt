package com.pipod.app.features.pods

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import com.pipod.app.core.format.AppIconToken
import com.pipod.app.core.format.PodPresentation
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.theme.appColors

/**
 * The lifecycle glyph beside a pod, ported from
 * `pi-pod-flutter/lib/features/pods/pod_state_icon.dart`.
 *
 * A transitional lifecycle pulses, which is the only thing on a list row that
 * says "this is still moving" without a second refresh. It is decoration: the
 * row's own accessible name already carries the status word, so a second node
 * announcing the same thing would make one pod two stops.
 */
@Composable
fun PodStateIcon(
    presentation: PodPresentation,
    modifier: Modifier = Modifier,
    size: Dp? = null,
) {
    val glyph = presentation.icon.imageVector
    val tint = appColors.tone(presentation.tone)
    val sized = if (size == null) modifier else modifier.size(size)

    if (!presentation.isTransitional) {
        Icon(imageVector = glyph, contentDescription = null, tint = tint, modifier = sized)
        return
    }

    val transition = rememberInfiniteTransition(label = "pod-state-pulse")
    val opacity by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 850),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "pod-state-opacity",
    )
    Icon(
        imageVector = glyph,
        contentDescription = null,
        tint = tint,
        modifier = sized.alpha(opacity),
    )
}

/**
 * The glyph a presentation token names.
 *
 * `core.format` names the icon by meaning so it can stay free of Compose; the
 * mapping to a drawn vector belongs here, with the rest of the icon set.
 */
val AppIconToken.imageVector: ImageVector
    get() = when (this) {
        AppIconToken.Running -> AppIcons.running
        AppIconToken.Asleep -> AppIcons.asleep
        AppIconToken.Dot -> AppIcons.dot
        AppIconToken.Warning -> AppIcons.warning
        AppIconToken.Archived -> AppIcons.archived
        AppIconToken.Unavailable -> AppIcons.unavailable
    }
