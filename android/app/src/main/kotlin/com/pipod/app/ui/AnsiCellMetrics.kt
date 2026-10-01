package com.pipod.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The advance width and line height of one terminal cell.
 *
 * Ported from `pi-pod-flutter/lib/ui/ansi_text.dart`. Surfaces derive their
 * column and row count from this, and the pod truncates against terminal
 * cells, so counts always round **down**: a pod that was told about one more
 * column than fits would paint a line that overflows the box.
 */
@Immutable
data class AnsiCellMetrics(val width: Dp, val height: Dp) {

    fun columnsIn(available: Dp): Int =
        if (width <= 0.dp) 1 else (available / width).toInt().coerceIn(1, MAX_CELLS)

    fun rowsIn(available: Dp): Int =
        if (height <= 0.dp) 1 else (available / height).toInt().coerceIn(1, MAX_CELLS)

    companion object {
        /**
         * A pod is never told about more cells than this. The cap is what keeps
         * a zero-width measurement or a degenerate layout from asking the pod
         * to render an unbounded grid.
         */
        const val MAX_CELLS = 1000

        /**
         * Measures ten characters and divides, rather than measuring one: a
         * single glyph's reported advance rounds, and the error compounds over
         * an 80-column line into a visible drift.
         */
        fun measure(measurer: TextMeasurer, style: TextStyle, density: Density): AnsiCellMetrics {
            val layout = measurer.measure(AnnotatedString(SAMPLE), style)
            return with(density) {
                AnsiCellMetrics(
                    width = (layout.size.width.toFloat() / SAMPLE.length).toDp(),
                    height = layout.size.height.toDp(),
                )
            }
        }

        private const val SAMPLE = "0000000000"
    }
}

/**
 * The cell size [style] paints at right now.
 *
 * Measured through the ambient [TextMeasurer], so the result already includes
 * the system font-size setting: a reader at 200% text gets a grid of larger
 * cells and correspondingly fewer columns, rather than a clipped line.
 */
@Composable
fun rememberAnsiCellMetrics(style: TextStyle): AnsiCellMetrics {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    return remember(measurer, style, density) {
        AnsiCellMetrics.measure(measurer, style, density)
    }
}
