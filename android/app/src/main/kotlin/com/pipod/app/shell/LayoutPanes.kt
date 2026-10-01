package com.pipod.app.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max

/**
 * Widest a reading or form column is allowed to get.
 *
 * From `pi-pod-flutter/lib/shell/layout_constants.dart`. Rows, forms and
 * transcripts stay comfortable to scan instead of stretching edge to edge on a
 * tablet or a foldable.
 */
val ContentMaxWidth: Dp = 840.dp

/**
 * Widest a browsable collection is allowed to get. A collection can use the
 * extra room for more columns without widening reading and form screens.
 */
val CollectionMaxWidth: Dp = 1160.dp

/** Centres a reading or form screen within [ContentMaxWidth]. */
@Composable
fun ContentPane(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Pane(maxWidth = ContentMaxWidth, modifier = modifier, content = content)
}

/** Centres a browsable collection within [CollectionMaxWidth]. */
@Composable
fun CollectionPane(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Pane(maxWidth = CollectionMaxWidth, modifier = modifier, content = content)
}

@Composable
private fun Pane(maxWidth: Dp, modifier: Modifier, content: @Composable () -> Unit) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = maxWidth)) { content() }
    }
}

/**
 * The same width limit expressed as list padding.
 *
 * A `LazyColumn` has to stay viewport-wide for its scrollbar to sit at the
 * window edge and for a fling over the gutter to still scroll, so a wide window
 * gets the limit as horizontal padding rather than as a narrower list.
 */
fun PaddingValues.centeredIn(
    availableWidth: Dp,
    maxWidth: Dp = ContentMaxWidth,
): PaddingValues = PaddingValuesWithGutter(this, max(0.dp, (availableWidth - maxWidth) / 2))

private class PaddingValuesWithGutter(
    private val base: PaddingValues,
    private val gutter: Dp,
) : PaddingValues {
    override fun calculateLeftPadding(layoutDirection: androidx.compose.ui.unit.LayoutDirection) =
        base.calculateStartPadding(layoutDirection) + gutter

    override fun calculateRightPadding(layoutDirection: androidx.compose.ui.unit.LayoutDirection) =
        base.calculateEndPadding(layoutDirection) + gutter

    override fun calculateTopPadding() = base.calculateTopPadding()
    override fun calculateBottomPadding() = base.calculateBottomPadding()
}
