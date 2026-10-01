package com.pipod.app.features.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pipod.app.core.format.StatusTone
import com.pipod.app.ui.theme.appColors

/**
 * The compact status pill on a list row.
 *
 * Ported from `pi-pod-flutter/lib/features/common/status_chip.dart`. Trailing
 * chips used to grow with their label, which on a 320dp phone pushed a pod or
 * job name off screen; the chip ellipsizes now rather than competing with the
 * title it is annotating.
 */
@Composable
fun StatusChip(label: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text = label,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold),
        color = color,
        modifier = modifier
            .widthIn(max = 128.dp)
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(999.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

/** The same chip named by lifecycle meaning rather than by a resolved colour. */
@Composable
fun StatusChip(label: String, tone: StatusTone, modifier: Modifier = Modifier) {
    StatusChip(label = label, color = appColors.tone(tone), modifier = modifier)
}
