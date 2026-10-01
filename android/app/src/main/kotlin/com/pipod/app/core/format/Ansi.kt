package com.pipod.app.core.format

/**
 * A colour as the sequence named it. Resolving a palette index to pixels is a
 * theme decision, so it stays with the renderer.
 */
sealed interface AnsiColor {
    /**
     * An index into the terminal's 256-colour palette. 0–15 are the named colours
     * a theme is expected to remap; 16–255 are the fixed cube and greyscale ramp.
     */
    data class Palette(val index: Int) : AnsiColor

    data class Rgb(val red: Int, val green: Int, val blue: Int) : AnsiColor
}

data class AnsiStyle(
    val bold: Boolean = false,
    val dim: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val inverse: Boolean = false,
    val strikethrough: Boolean = false,
    val foreground: AnsiColor? = null,
    val background: AnsiColor? = null,
) {
    val isPlain: Boolean
        get() = !bold && !dim && !italic && !underline && !inverse && !strikethrough &&
            foreground == null && background == null

    companion object {
        val NONE = AnsiStyle()
    }
}

data class AnsiSpan(val text: String, val style: AnsiStyle)

/**
 * SGR-only ANSI parsing for remote extension UI lines.
 *
 * Frames are whole-line repaints produced by pi's own renderer in the pod, so
 * styling is all that has to survive: there is no cursor addressing, scrollback
 * or vt state to emulate. Anything that is not an SGR sequence is noise here and
 * is stripped, which is also what the pod-side line sanitizer assumes.
 */
object Ansi {

    /**
     * Splits one rendered line into styled runs. Adjacent runs that share a style
     * are merged, so a line with no styling yields exactly one span.
     */
    fun parse(line: String): List<AnsiSpan> {
        val spans = mutableListOf<AnsiSpan>()
        val buffer = StringBuilder()
        var style = AnsiStyle.NONE
        var column = 0

        fun flush() {
            if (buffer.isEmpty()) return
            val text = buffer.toString()
            buffer.setLength(0)
            val last = spans.lastOrNull()
            if (last != null && last.style == style) {
                spans[spans.size - 1] = AnsiSpan(last.text + text, style)
                return
            }
            spans.add(AnsiSpan(text, style))
        }

        var index = 0
        while (index < line.length) {
            val code = line[index].code
            if (code != ESCAPE) {
                if (code == 0x09) {
                    // Terminals advance to the next tab stop; spaces reproduce that on
                    // a monospace grid.
                    val width = TAB_STOP - column % TAB_STOP
                    buffer.append(" ".repeat(width))
                    column += width
                } else if (code >= 0x20 && code != 0x7f) {
                    buffer.append(line[index])
                    column += 1
                }
                index += 1
                continue
            }
            val sequence = sequenceAt(line, index) ?: break
            val parameters = sgrParameters(line, index, sequence)
            if (parameters != null) {
                flush()
                style = applySgr(style, parameters)
            }
            index = sequence
        }
        flush()
        return spans
    }

    /**
     * The line as it reads without any styling — the accessibility label and the
     * text a golden test compares.
     */
    fun strip(line: String): String = parse(line).joinToString("") { it.text }

    /**
     * End index (exclusive) of the escape sequence starting at [start], or null
     * when the line ends mid-sequence.
     */
    private fun sequenceAt(line: String, start: Int): Int? {
        val next = if (start + 1 < line.length) line[start + 1] else return null
        if (next == '[') {
            var end = start + 2
            while (end < line.length) {
                if (line[end].code in 0x40..0x7e) return end + 1
                end += 1
            }
            return null
        }
        if (next == ']' || next == 'P' || next == '_' || next == '^' || next == 'X') {
            // String sequences (OSC, DCS, APC, PM, SOS) run to BEL or ST.
            var end = start + 2
            while (end < line.length) {
                if (line[end].code == 0x07) return end + 1
                if (line[end] == '\\' && line[end - 1].code == ESCAPE) return end + 1
                end += 1
            }
            return null
        }
        var end = start + 1
        while (end < line.length && line[end].code in 0x20..0x2f) end += 1
        if (end < line.length && line[end].code in 0x30..0x7e) end += 1
        return if (end > start) end else start + 1
    }

    /**
     * Flattened SGR parameters, or null when the sequence is not an SGR. `;` and
     * `:` are both accepted as separators so the ITU colour forms (`38:2::r:g:b`)
     * parse alongside the common `38;2;r;g;b`.
     */
    private fun sgrParameters(line: String, start: Int, end: Int): List<Int?>? {
        if (line[end - 1] != 'm' || line[start + 1] != '[') return null
        val body = line.substring(start + 2, end - 1)
        val parameters = mutableListOf<Int?>()
        for (token in body.split(SEPARATOR)) {
            if (token.isEmpty()) {
                parameters.add(null)
                continue
            }
            parameters.add(token.toIntOrNull() ?: return null)
        }
        return parameters.ifEmpty { listOf(0) }
    }

    private fun applySgr(style: AnsiStyle, parameters: List<Int?>): AnsiStyle {
        var result = style
        var index = 0
        while (index < parameters.size) {
            when (val parameter = parameters[index] ?: 0) {
                0 -> result = AnsiStyle.NONE
                1 -> result = result.copy(bold = true)
                2 -> result = result.copy(dim = true)
                3 -> result = result.copy(italic = true)
                4 -> result = result.copy(underline = true)
                7 -> result = result.copy(inverse = true)
                9 -> result = result.copy(strikethrough = true)
                21, 22 -> result = result.copy(bold = false, dim = false)
                23 -> result = result.copy(italic = false)
                24 -> result = result.copy(underline = false)
                27 -> result = result.copy(inverse = false)
                29 -> result = result.copy(strikethrough = false)
                39 -> result = result.copy(foreground = null)
                49 -> result = result.copy(background = null)
                38, 48 -> {
                    val extended = extendedColor(parameters, index) ?: return result
                    index = extended.nextIndex
                    result = if (parameter == 38) {
                        result.copy(foreground = extended.color)
                    } else {
                        result.copy(background = extended.color)
                    }
                }

                else -> result = when (parameter) {
                    in 30..37 -> result.copy(foreground = AnsiColor.Palette(parameter - 30))
                    in 40..47 -> result.copy(background = AnsiColor.Palette(parameter - 40))
                    in 90..97 -> result.copy(foreground = AnsiColor.Palette(parameter - 90 + 8))
                    in 100..107 -> result.copy(background = AnsiColor.Palette(parameter - 100 + 8))
                    else -> result
                }
            }
            index += 1
        }
        return result
    }

    private fun extendedColor(parameters: List<Int?>, start: Int): ExtendedColor? {
        var index = start + 1
        fun next(): Int? {
            while (index < parameters.size && parameters[index] == null) index += 1
            return if (index < parameters.size) parameters[index++] else null
        }

        when (next()) {
            5 -> {
                val value = next()
                if (value == null || value < 0 || value > 255) return null
                return ExtendedColor(AnsiColor.Palette(value), index - 1)
            }

            2 -> {
                val red = next()
                val green = next()
                val blue = next()
                if (red == null || green == null || blue == null) return null
                return ExtendedColor(
                    AnsiColor.Rgb(
                        red.coerceIn(0, 255),
                        green.coerceIn(0, 255),
                        blue.coerceIn(0, 255),
                    ),
                    index - 1,
                )
            }

            else -> return null
        }
    }

    private class ExtendedColor(val color: AnsiColor, val nextIndex: Int)

    private const val ESCAPE = 0x1b
    private const val TAB_STOP = 8
    private val SEPARATOR = Regex("[;:]")
}
