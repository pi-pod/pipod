package com.pipod.app.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/**
 * The pi pod brand palette.
 *
 * These are the hand-pinned roles from `pi-pod-flutter/lib/shell/app_theme.dart`;
 * Material's generated tones drift off-brand, so the scheme is written out rather
 * than re-derived from a seed. Do not substitute generic Material purple.
 */
object BrandColors {
    val SimplePurple = Color(0xFF6D2598)
    val IvoryPorcelain = Color(0xFFEDE4D1)
    val MutedFawn = Color(0xFFDBAC8F)
    val Byzantine = Color(0xFFBF34A4)
    val TraditionalPurple = Color(0xFFAA1C7D)
    val DarkSurface = Color(0xFF160A1F)
    val DarkRaised = Color(0xFF201230)
}

/** Internal so the contrast tests measure the palette that actually ships. */
internal val PiPodLightColors = lightColorScheme(
    primary = BrandColors.SimplePurple,
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = BrandColors.TraditionalPurple,
    onPrimaryContainer = Color(0xFFFFFFFF),
    secondary = BrandColors.TraditionalPurple,
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = BrandColors.MutedFawn,
    onSecondaryContainer = Color(0xFF2E1330),
    tertiary = BrandColors.Byzantine,
    onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFFADDF2),
    onTertiaryContainer = Color(0xFF3F0033),
    background = BrandColors.IvoryPorcelain,
    onBackground = Color(0xFF241426),
    surface = BrandColors.IvoryPorcelain,
    onSurface = Color(0xFF241426),
    surfaceVariant = Color(0xFFE3D0B6),
    onSurfaceVariant = Color(0xFF574450),
    outline = Color(0xFF75604F),
    outlineVariant = Color(0xFFD3C1A4),
    surfaceContainerLowest = Color(0xFFFCF8F0),
    surfaceContainerLow = Color(0xFFF6EFE0),
    surfaceContainer = Color(0xFFE7DBC4),
    surfaceContainerHigh = Color(0xFFE3D0B6),
    surfaceContainerHighest = BrandColors.MutedFawn,
)

internal val PiPodDarkColors = darkColorScheme(
    primary = Color(0xFFC38CE3),
    onPrimary = Color(0xFF350A52),
    primaryContainer = BrandColors.SimplePurple,
    onPrimaryContainer = Color(0xFFF0DDFA),
    secondary = Color(0xFFE79ACB),
    onSecondary = Color(0xFF46002F),
    secondaryContainer = BrandColors.TraditionalPurple,
    onSecondaryContainer = Color(0xFFFFDCEF),
    tertiary = Color(0xFFE572CE),
    onTertiary = Color(0xFF4B0040),
    tertiaryContainer = Color(0xFF8A1874),
    onTertiaryContainer = Color(0xFFFFD8F2),
    background = BrandColors.DarkSurface,
    onBackground = Color(0xFFF1E6EE),
    surface = BrandColors.DarkSurface,
    onSurface = Color(0xFFF1E6EE),
    surfaceVariant = Color(0xFF2F1E42),
    onSurfaceVariant = Color(0xFFCDB9CE),
    outline = Color(0xFF96829A),
    outlineVariant = Color(0xFF3B2B45),
    surfaceContainerLowest = Color(0xFF100617),
    surfaceContainerLow = BrandColors.DarkRaised,
    surfaceContainer = Color(0xFF271738),
    surfaceContainerHigh = Color(0xFF2F1E42),
    surfaceContainerHighest = Color(0xFF38254C),
)

/**
 * Wraps content in the brand Material 3 theme.
 *
 * Dynamic colour is deliberately not used: the ivory scaffold and Simple Purple
 * accent are the product's identity, and wallpaper-derived tones would erase it.
 */
@Composable
fun PiPodTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) PiPodDarkColors else PiPodLightColors
    val appColors = remember(darkTheme) { AppColors.from(colorScheme, darkTheme) }

    val view = LocalView.current
    if (!view.isInEditMode) {
        val context = LocalContext.current
        SideEffect {
            val window = (context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }

    CompositionLocalProvider(LocalAppColors provides appColors) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = PiPodTypography,
            content = content,
        )
    }
}
