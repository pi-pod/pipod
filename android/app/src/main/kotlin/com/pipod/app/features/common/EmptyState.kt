package com.pipod.app.features.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.theme.appColors

/**
 * The centred first-run or error column every list falls back to.
 *
 * Ported from `pi-pod-flutter/lib/features/common/empty_state.dart`. A bare
 * glyph sitting on the scaffold reads as an unfinished screen, so the circular
 * well gives the state a destination; the action, when there is one, is a full
 * 48dp control rather than a link.
 */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    actionLabel: String? = null,
    actionSemanticsLabel: String? = null,
    onAction: (() -> Unit)? = null,
    footer: (@Composable () -> Unit)? = null,
) {
    val colors = appColors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(32.dp)
            .testTag("empty-state"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(64.dp))
        Box(
            modifier = Modifier
                .size(88.dp)
                .background(colors.fill.copy(alpha = 0.7f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                modifier = Modifier.size(40.dp),
                tint = colors.secondaryLabel,
            )
        }
        Spacer(Modifier.height(20.dp))
        Text(
            text = title,
            style = MaterialTheme.typography.titleLarge,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = colors.secondaryLabel,
            textAlign = TextAlign.Center,
        )
        if (onAction != null && actionLabel != null) {
            Spacer(Modifier.height(20.dp))
            AppButton(
                text = actionLabel,
                onClick = onAction,
                semanticsLabel = actionSemanticsLabel ?: actionLabel,
            )
        }
        if (footer != null) {
            Spacer(Modifier.height(8.dp))
            footer()
        }
    }
}
