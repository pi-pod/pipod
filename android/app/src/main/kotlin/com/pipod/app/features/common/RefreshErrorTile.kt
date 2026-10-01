package com.pipod.app.features.common

import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.format.StatusTone
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppButtonSize
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.theme.appColors

/**
 * The inline "the list is still showing last-known data" banner.
 *
 * Ported from `pi-pod-flutter/lib/features/common/refresh_error_tile.dart`. It
 * sits above the stale rows rather than replacing them: what the reader last
 * saw is still the best information available, and blanking the list to show a
 * failure throws that away.
 */
@Composable
fun RefreshErrorTile(
    message: String,
    onRetry: () -> Unit,
    retrySemanticsLabel: String,
    modifier: Modifier = Modifier,
) {
    AppListSection(modifier = modifier.testTag("refresh-error-tile")) {
        row {
            AppListTile(
                title = { Text("Couldn’t refresh: $message") },
                leading = {
                    Icon(
                        imageVector = AppIcons.offline,
                        contentDescription = null,
                        tint = appColors.tone(StatusTone.Caution),
                    )
                },
                trailing = {
                    AppButton(
                        text = "Retry",
                        onClick = onRetry,
                        kind = AppButtonKind.Plain,
                        size = AppButtonSize.Small,
                        minSize = DpSize(AppButtonDefaults.MinTouchTarget, AppButtonDefaults.MinTouchTarget),
                        semanticsLabel = retrySemanticsLabel,
                    )
                },
            )
        }
    }
}

/**
 * The same banner from a thrown failure.
 *
 * Every error surface goes through [FriendlyError] rather than printing an
 * exception: a socket message or an HTTP status line tells the reader nothing
 * they can act on. Prefer this over formatting the message at the call site,
 * so one screen cannot quietly grow its own error copy.
 */
@Composable
fun RefreshErrorTile(
    error: Throwable,
    onRetry: () -> Unit,
    retrySemanticsLabel: String,
    modifier: Modifier = Modifier,
    serverHost: String? = null,
) {
    RefreshErrorTile(
        message = FriendlyError.message(error, serverHost),
        onRetry = onRetry,
        retrySemanticsLabel = retrySemanticsLabel,
        modifier = modifier,
    )
}
