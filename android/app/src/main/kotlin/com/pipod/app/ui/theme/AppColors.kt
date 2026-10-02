package com.pipod.app.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import com.pipod.app.core.format.StatusTone

/**
 * The semantic colour vocabulary the app is written against, mirroring
 * `pi-pod-flutter/lib/ui/app_colors.dart`.
 *
 * Screens name a role — `secondaryLabel`, `fill`, `notice` — instead of reaching
 * into the [ColorScheme], so the mapping from brand palette to meaning lives in
 * exactly one place.
 */
@Immutable
data class AppColors(
    /** Interactive tint: links, selected tabs, primary actions. */
    val accent: Color,
    val onAccent: Color,
    /** Primary body text. */
    val label: Color,
    /** Supporting text: subtitles, metadata, captions. */
    val secondaryLabel: Color,
    /** De-emphasised text and disabled glyphs. */
    val tertiaryLabel: Color,
    /** Hairlines between rows and sections. */
    val separator: Color,
    /** Backdrop for screens whose content is not a grouped list. */
    val background: Color,
    /** Backdrop behind inset grouped lists. */
    val groupedBackground: Color,
    /** Surface of a row, section or card sitting on [groupedBackground]. */
    val card: Color,
    /** Subtle filled surface for chips, code blocks and inline badges. */
    val fill: Color,
    /** Surface of a bar against the edge of the screen, such as the composer. */
    val bar: Color,
    /** Errors and destructive actions. */
    val destructive: Color,
    val destructiveFill: Color,
    /** Attention that is not an error, such as a question pi is waiting on. */
    val notice: Color,
    val noticeFill: Color,
    /**
     * [notice] as *text*, which is a different job from [notice] as a glyph or
     * a wash.
     *
     * Material's raw tertiary is tuned to sit against its container as a fill;
     * at 12–14sp it lands between 3.3:1 and 4.3:1 on the surfaces this app
     * paints it on, which is under the 4.5:1 AA bar for normal-size text. Both
     * ends are therefore hand-pinned — like [StatusTone], and unlike the rest
     * of this palette — to clear 4.5:1 on every backdrop a notice string is
     * drawn on: [card], [background], [noticeFill], and the 12%-[notice] wash
     * behind a dialog card. `AppColorsContrastRound2Test` measures all of it.
     */
    val noticeText: Color,
    /** Which end of the palette this instance resolves against. */
    val isDark: Boolean,
) {
    fun tone(tone: StatusTone): Color = tone.color(isDark)

    val success: Color get() = tone(StatusTone.Positive)
    val warning: Color get() = tone(StatusTone.Caution)
    val info: Color get() = tone(StatusTone.Info)
    val neutral: Color get() = tone(StatusTone.Neutral)

    companion object {
        fun from(scheme: ColorScheme, isDark: Boolean): AppColors = AppColors(
            accent = scheme.primary,
            onAccent = scheme.onPrimary,
            label = scheme.onSurface,
            secondaryLabel = scheme.onSurfaceVariant,
            tertiaryLabel = scheme.outline,
            separator = scheme.outlineVariant,
            background = scheme.surface,
            groupedBackground = scheme.surface,
            card = scheme.surfaceContainerLow,
            fill = scheme.surfaceContainerHighest,
            bar = scheme.surfaceContainer,
            destructive = scheme.error,
            destructiveFill = scheme.errorContainer,
            notice = scheme.tertiary,
            noticeFill = scheme.tertiaryContainer,
            noticeText = if (isDark) DarkNoticeText else LightNoticeText,
            isDark = isDark,
        )

        /**
         * Byzantine darkened until it clears AA on ivory, on the tertiary
         * container and through the dialog-card wash — still recognisably the
         * brand's magenta rather than a generic warning brown.
         */
        private val LightNoticeText = Color(0xFF8A1874)

        /**
         * The dark end has the harder backdrop: `tertiaryContainer` is itself a
         * deep magenta, and the scheme's own tertiary reads only 3.1:1 on it.
         * This is that hue lifted until it clears the bar on the container and
         * on the near-black surface alike.
         */
        private val DarkNoticeText = Color(0xFFF5B8E6)
    }
}

val LocalAppColors = staticCompositionLocalOf {
    // Replaced by PiPodTheme. The fallback keeps previews from crashing outside it.
    AppColors.from(androidx.compose.material3.lightColorScheme(), isDark = false)
}

/** `AppColors.current` — the semantic palette for the enclosing theme. */
val appColors: AppColors
    @Composable @ReadOnlyComposable
    get() = LocalAppColors.current

/** Convenience for code that already has [MaterialTheme] in scope. */
object PiPod {
    val colors: AppColors
        @Composable @ReadOnlyComposable
        get() = LocalAppColors.current
}
