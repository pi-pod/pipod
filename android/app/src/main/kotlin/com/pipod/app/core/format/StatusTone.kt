package com.pipod.app.core.format

import androidx.compose.ui.graphics.Color

/**
 * Lifecycle status colours for a pod, job or run.
 *
 * Hand-tuned to clear 4.5:1 against their own surface. Material's `Color.Green` /
 * `Color.Yellow` measure 2.2:1 and 1.7:1 on the ivory scaffold, so they are never
 * substituted here.
 */
enum class StatusTone {
    Positive,
    Info,
    Caution,
    Danger,
    Neutral,
    Unreachable,
    ;

    fun color(dark: Boolean): Color = if (dark) darkColor else lightColor

    private val lightColor: Color
        get() = when (this) {
            Positive -> Color(0xFF1B5E20)
            Info -> Color(0xFF0D47A1)
            Caution -> Color(0xFF8A4300)
            Danger -> Color(0xFFA32017)
            Neutral -> Color(0xFF5A5A5A)
            Unreachable -> Color(0xFF6A1B9A)
        }

    private val darkColor: Color
        get() = when (this) {
            Positive -> Color(0xFF7FD98C)
            Info -> Color(0xFF9CC4F8)
            Caution -> Color(0xFFFFB77A)
            Danger -> Color(0xFFF2A29A)
            Neutral -> Color(0xFFB5B0BA)
            Unreachable -> Color(0xFFD6A8F0)
        }
}
