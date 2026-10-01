package com.pipod.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import com.pipod.app.core.format.AnsiColor
import com.pipod.app.ui.theme.appColors

/**
 * Terminal colours resolved against the app theme, so an extension surface
 * follows light and dark mode instead of freezing one terminal's palette.
 *
 * Ported from `pi-pod-flutter/lib/ui/ansi_text.dart`. The resolvers take an
 * index or three channels rather than a parsed colour object: that keeps the
 * whole palette — including the parts most likely to be wrong, the 256-colour
 * cube and the greyscale ramp — testable without a parser or a device.
 */
@Immutable
data class AnsiPalette(
    /** The 16 named terminal colours, in ANSI order. */
    val colors: List<Color>,
    val foreground: Color,
    /**
     * What the surface is painted on. Inverse video swaps against this, which
     * is the only way an inverted run stays legible in both themes.
     */
    val background: Color,
) {

    /** Resolves an index into the terminal's 256-colour palette. */
    fun resolveIndexed(index: Int): Color {
        if (index < 16) return colors[index.coerceAtLeast(0)]
        if (index < 232) {
            val offset = index - 16
            fun channel(value: Int) = if (value == 0) 0 else 55 + value * 40
            return Color(
                red = channel(offset / 36),
                green = channel(offset % 36 / 6),
                blue = channel(offset % 6),
                alpha = 255,
            )
        }
        val grey = 8 + (index - 232) * 10
        return Color(red = grey, green = grey, blue = grey, alpha = 255)
    }

    fun resolveRgb(red: Int, green: Int, blue: Int): Color =
        Color(red = red, green = green, blue = blue, alpha = 255)

    /** Resolves a colour as the escape sequence named it. */
    fun resolve(color: AnsiColor): Color = when (color) {
        is AnsiColor.Palette -> resolveIndexed(color.index)
        is AnsiColor.Rgb -> resolveRgb(color.red, color.green, color.blue)
    }

    companion object {
        /** The palette for the enclosing theme. */
        @Composable
        @ReadOnlyComposable
        fun current(): AnsiPalette {
            val colors = appColors
            return AnsiPalette(
                colors = if (colors.isDark) DarkNamed else LightNamed,
                foreground = colors.label,
                background = colors.card,
            )
        }

        /**
         * The two surfaces these palettes are contrast-tuned against — the
         * card an extension surface or a tool panel is painted on in each
         * theme. `AnsiPaletteTest` measures every entry against them, so a
         * colour cannot be nudged without the ratio being re-checked.
         */
        val LightBackdrop: Color = Color(0xFFF6EFE0)
        val DarkBackdrop: Color = Color(0xFF201230)

        /**
         * Tuned against each backdrop rather than reused: the standard
         * dark-terminal blues and cyans fall under 4.5:1 on a light one.
         */
        val DarkNamed: List<Color> = listOf(
            // Black is the comment/box-drawing colour; the terminal default
            // sits at 3.6:1 on the raised dark card, so it is lifted to clear
            // AA both plain and after the dim blend.
            Color(0xFF878B9E), // black, raised so dimmed text stays legible
            Color(0xFFF38BA8),
            Color(0xFFA6E3A1),
            Color(0xFFF9E2AF),
            Color(0xFF89B4FA),
            Color(0xFFF5C2E7),
            Color(0xFF94E2D5),
            Color(0xFFBAC2DE),
            Color(0xFF7F849C),
            Color(0xFFF5A0B8),
            Color(0xFFB9F0B4),
            Color(0xFFFAEBC8),
            Color(0xFFA6C8FF),
            Color(0xFFF7D0EE),
            Color(0xFFAAF0E4),
            Color(0xFFE6E9F0),
        )

        /**
         * The light table runs deeper than a terminal's own: on ivory, the
         * usual green, yellow, blue and bright-black land between 3.5:1 and
         * 4.4:1, which is below AA for body text. Each is darkened to clear
         * 4.5:1 with headroom, and the bright variants stay a further step
         * down so `\e[32m` and `\e[1;32m` remain distinguishable.
         */
        val LightNamed: List<Color> = listOf(
            Color(0xFF4C4F69),
            Color(0xFFD20F39),
            Color(0xFF337333), // green, was #3F8F3F at 3.5:1
            Color(0xFF826100), // yellow, was #8F6A00 at 4.3:1
            Color(0xFF0B57F0), // blue, was #1E66F5 at 4.3:1
            Color(0xFF8839EF),
            Color(0xFF0E7490),
            Color(0xFF5C5F77),
            Color(0xFF5B5D70), // bright black, was #6C6F85 at 4.3:1
            Color(0xFFB4123A),
            Color(0xFF276727), // bright green, kept a step below the new green
            Color(0xFF7A5A00),
            Color(0xFF1B54C7),
            Color(0xFF7229CC),
            Color(0xFF0B5F76),
            Color(0xFF4C4F69),
        )
    }
}
