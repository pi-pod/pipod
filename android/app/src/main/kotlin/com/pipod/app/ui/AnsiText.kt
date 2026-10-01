package com.pipod.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import com.pipod.app.core.format.Ansi
import com.pipod.app.core.format.AnsiStyle

/**
 * One rendered line, as styled runs in a fixed monospace grid.
 *
 * Ported from `pi-pod-flutter/lib/ui/ansi_text.dart`. Lines never wrap: the pod
 * already laid the line out for the width it was told about, so wrapping here
 * would break it a second time and throw the grid off by a row.
 */
@Composable
fun AnsiText(
    line: String,
    style: TextStyle,
    modifier: Modifier = Modifier,
    palette: AnsiPalette = AnsiPalette.current(),
) {
    Text(
        text = ansiAnnotatedString(line, style, palette),
        style = style,
        modifier = modifier,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Clip,
    )
}

/**
 * A block of rendered lines on a stable cell grid, read as one accessibility
 * node using its ANSI-stripped text.
 *
 * One node rather than one per line: a screen reader stepping through 40
 * separate rows of a repainting terminal frame never gets to the end of it.
 */
@Composable
fun AnsiLines(
    lines: List<String>,
    style: TextStyle,
    metrics: AnsiCellMetrics,
    modifier: Modifier = Modifier,
    semanticsLabel: String? = null,
) {
    val palette = AnsiPalette.current()
    val label = semanticsLabel ?: readableAnsiText(lines)
    Column(
        modifier = modifier.semantics(mergeDescendants = true) { contentDescription = label },
    ) {
        lines.forEach { line ->
            AnsiText(
                line = line,
                style = style,
                palette = palette,
                // Every row is exactly one cell tall whatever it contains, so a
                // line of box-drawing characters cannot shift the rows under it.
                modifier = Modifier
                    .fillMaxWidth()
                    .height(metrics.height),
            )
        }
    }
}

/** What a reader hears instead of the escape sequences: the text alone. */
fun readableAnsiText(lines: List<String>): String =
    lines.joinToString("\n") { Ansi.strip(it) }.trim()

/** One line's runs, each carrying the style its escape sequence asked for. */
fun ansiAnnotatedString(line: String, base: TextStyle, palette: AnsiPalette): AnnotatedString {
    val spans = Ansi.parse(line)
    if (spans.isEmpty()) return AnnotatedString("")
    return buildAnnotatedString {
        spans.forEach { span ->
            withStyle(ansiSpanStyle(span.style, base, palette)) { append(span.text) }
        }
    }
}

/**
 * The paint for one run.
 *
 * Inverse video swaps against the surface the block is painted on rather than
 * against black: swapping against black is what makes an inverted run
 * unreadable in exactly one of the two themes.
 */
fun ansiSpanStyle(ansi: AnsiStyle, base: TextStyle, palette: AnsiPalette): SpanStyle {
    if (ansi.isPlain) return base.toSpanStyle()

    var foreground = ansi.foreground?.let(palette::resolve)
        ?: base.color.takeIf { it != Color.Unspecified }
        ?: palette.foreground
    var background = ansi.background?.let(palette::resolve)

    if (ansi.inverse) {
        val swapped = background ?: palette.background
        background = foreground
        foreground = swapped
    }
    // Dim is a lightening of the ink, not a separate colour: the terminal's own
    // "faint" is the same hue at lower contrast. The blend is deliberately
    // shallow — a terminal's usual 35% erasure drops a palette that only just
    // clears AA to around 2.5:1, which is unreadable rather than faint.
    if (ansi.dim) foreground = foreground.copy(alpha = DIM_ALPHA)

    val decorations = buildList {
        if (ansi.underline) add(TextDecoration.Underline)
        if (ansi.strikethrough) add(TextDecoration.LineThrough)
    }
    return base.toSpanStyle().copy(
        color = foreground,
        background = background ?: Color.Unspecified,
        fontWeight = if (ansi.bold) FontWeight.Bold else base.fontWeight,
        fontStyle = if (ansi.italic) FontStyle.Italic else base.fontStyle,
        textDecoration = if (decorations.isEmpty()) null else TextDecoration.combine(decorations),
    )
}

/**
 * How much ink "faint" keeps. Shared with `AnsiPaletteTest`, which asserts that
 * every palette entry still clears 3:1 once blended at this alpha.
 */
const val DIM_ALPHA: Float = 0.75f
