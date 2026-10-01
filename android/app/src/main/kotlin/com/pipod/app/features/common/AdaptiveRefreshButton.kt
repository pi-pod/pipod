package com.pipod.app.features.common

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.isCompactWidth

/**
 * Keeps pull-to-refresh the only way to refresh on a phone, while making
 * refresh discoverable in a top bar that has room for an explicit action.
 *
 * Ported from `pi-pod-flutter/lib/features/common/adaptive_refresh_button.dart`.
 * A phone's bar is already carrying a title and the screen's own actions, and a
 * list that can be pulled does not need a second affordance competing for it.
 */
@Composable
fun AdaptiveRefreshButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (isCompactWidth()) return
    AppIconButton(
        icon = AppIcons.refresh,
        onClick = onClick,
        semanticsLabel = label,
        modifier = modifier,
    )
}
