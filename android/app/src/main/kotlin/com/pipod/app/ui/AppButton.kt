package com.pipod.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Button
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import com.pipod.app.ui.theme.appColors

/** How much weight a button carries on its screen. */
enum class AppButtonKind {
    /** The one action a screen most wants: solid accent fill. */
    Filled,

    /** A secondary action that still needs a visible edge. */
    Tinted,

    /** Inline actions inside rows, sheets and alerts. */
    Plain,
}

enum class AppButtonSize { Normal, Small }

/** Sizing every button kind shares, so a caller can hold the same target. */
object AppButtonDefaults {
    /**
     * Material's own default is 40dp, which leaves dialog actions and inline
     * retries below the minimum touch target. Android's own guidance is 48dp —
     * larger than the 44dp this app used to hold, which came from the iOS
     * figure. Callers may raise this, never lower it.
     */
    val MinHeight: Dp = 48.dp
    val MinWidth: Dp = 64.dp

    /**
     * The smallest a tap target may be in either direction, for the controls
     * that size themselves rather than going through [AppButton]: an icon
     * button, a whole clickable row, a hit box around a small glyph.
     */
    val MinTouchTarget: Dp = 48.dp
}

/**
 * A button, ported from `pi-pod-flutter/lib/ui/app_button.dart`.
 *
 * The Flutter widget takes a nullable `onPressed` to mean "disabled"; Compose
 * hoists that into [enabled], so a caller writes `enabled = canSave` instead of
 * threading a null callback through.
 *
 * @param semanticsLabel replaces the visible text as the button's accessible
 *   name, for a child that is an icon plus text or whose name carries state.
 *   Setting it here rather than wrapping the button keeps the tree at one node:
 *   a wrapper would expose the button twice.
 */
@Composable
fun AppButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: AppButtonKind = AppButtonKind.Filled,
    enabled: Boolean = true,
    destructive: Boolean = false,
    size: AppButtonSize = AppButtonSize.Normal,
    contentPadding: PaddingValues? = null,
    minSize: DpSize? = null,
    semanticsLabel: String? = null,
    content: @Composable RowScope.() -> Unit,
) {
    val colors = appColors
    val scheme = MaterialTheme.colorScheme
    val padding = contentPadding ?: when (size) {
        AppButtonSize.Small -> ButtonDefaults.TextButtonContentPadding
        AppButtonSize.Normal -> ButtonDefaults.ContentPadding
    }
    val sized = modifier
        .defaultMinSize(
            minWidth = minSize?.width ?: AppButtonDefaults.MinWidth,
            minHeight = maxOf(minSize?.height ?: AppButtonDefaults.MinHeight, AppButtonDefaults.MinHeight),
        )
        .then(
            // Material buttons already merge their children, so naming the
            // button itself renames the one node instead of adding another.
            if (semanticsLabel == null) {
                Modifier
            } else {
                Modifier.semantics { contentDescription = semanticsLabel }
            },
        )

    when (kind) {
        AppButtonKind.Filled -> Button(
            onClick = onClick,
            modifier = sized,
            enabled = enabled,
            contentPadding = padding,
            colors = if (destructive) {
                ButtonDefaults.buttonColors(
                    containerColor = colors.destructive,
                    contentColor = scheme.onError,
                )
            } else {
                ButtonDefaults.buttonColors()
            },
            content = content,
        )

        AppButtonKind.Tinted -> OutlinedButton(
            onClick = onClick,
            modifier = sized,
            enabled = enabled,
            contentPadding = padding,
            colors = if (destructive) {
                ButtonDefaults.outlinedButtonColors(contentColor = colors.destructive)
            } else {
                ButtonDefaults.outlinedButtonColors()
            },
            content = content,
        )

        AppButtonKind.Plain -> TextButton(
            onClick = onClick,
            modifier = sized,
            enabled = enabled,
            contentPadding = padding,
            colors = if (destructive) {
                ButtonDefaults.textButtonColors(contentColor = colors.destructive)
            } else {
                ButtonDefaults.textButtonColors()
            },
            content = content,
        )
    }
}

/** [AppButton] with a plain text child, which is what most call sites want. */
@Composable
fun AppButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: AppButtonKind = AppButtonKind.Filled,
    enabled: Boolean = true,
    destructive: Boolean = false,
    size: AppButtonSize = AppButtonSize.Normal,
    contentPadding: PaddingValues? = null,
    minSize: DpSize? = null,
    semanticsLabel: String? = null,
) {
    AppButton(
        onClick = onClick,
        modifier = modifier,
        kind = kind,
        enabled = enabled,
        destructive = destructive,
        size = size,
        contentPadding = contentPadding,
        minSize = minSize,
        semanticsLabel = semanticsLabel,
    ) {
        Text(text)
    }
}

/**
 * A tappable glyph, used in top bars and beside fields.
 *
 * The glyph carries no words, so [semanticsLabel] is required rather than
 * optional — it is the button's only name. The Flutter widget also takes a
 * `tooltip` for pointer targets; a phone has no hover, so the label is the
 * single naming channel here.
 */
@Composable
fun AppIconButton(
    icon: ImageVector,
    onClick: () -> Unit,
    semanticsLabel: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    destructive: Boolean = false,
    iconSize: Dp? = null,
    tint: Color? = null,
    dimension: Dp? = null,
) {
    val colors = appColors
    IconButton(
        onClick = onClick,
        modifier = if (dimension == null) modifier else modifier.size(dimension),
        enabled = enabled,
        colors = IconButtonDefaults.iconButtonColors(
            // Falling back to the ambient content colour keeps a glyph in a top
            // bar or a row tinted by whatever surface it sits on.
            contentColor = tint ?: if (destructive) colors.destructive else LocalContentColor.current,
        ),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = semanticsLabel,
            modifier = if (iconSize == null) Modifier else Modifier.size(iconSize),
        )
    }
}

/**
 * The primary action on a screen too tall to reach into the top bar.
 *
 * The visible label already names the one node the extended FAB exposes, so
 * nothing is added on top of it: the Flutter original grew a second, empty
 * container node exactly by wrapping this.
 */
@Composable
fun AppFloatingAction(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    ExtendedFloatingActionButton(
        onClick = onClick,
        modifier = modifier
            .testTag("app-floating-action")
            // Material 3's extended FAB does not expose its own text slot to
            // accessibility — the merged node carries a Button role, a click
            // action and no name at all — so the label is named here. Without
            // this the control announces as an unlabelled button, and the one
            // thing that says what it does is the word next to the icon.
            .semantics { contentDescription = label },
        // The label also has to stay on screen: collapsed, this is an icon-only
        // circle, and "+" does not say what it creates.
        expanded = true,
        icon = { Icon(icon, contentDescription = null) },
        text = { Text(label) },
    )
}

/**
 * A small control that floats over scrolling content, such as "jump to latest".
 *
 * Raised on a real elevated surface so it reads as sitting above the transcript
 * rather than in it, and held at 48dp so it stays a comfortable target over a
 * moving list.
 */
@Composable
fun AppPillButton(
    onClick: () -> Unit,
    semanticsLabel: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Surface(
        onClick = onClick,
        modifier = modifier
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .semantics { contentDescription = semanticsLabel },
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shadowElevation = 3.dp,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
        ) {
            content()
        }
    }
}

/**
 * A tinted secondary action, for the few places that want a filled affordance
 * without claiming to be the screen's primary one.
 */
@Composable
fun AppTonalButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    FilledTonalButton(
        onClick = onClick,
        modifier = modifier.defaultMinSize(
            minWidth = AppButtonDefaults.MinWidth,
            minHeight = AppButtonDefaults.MinHeight,
        ),
        enabled = enabled,
    ) {
        Text(text)
    }
}

/** An icon and a label side by side, the usual child of a filled [AppButton]. */
@Composable
fun AppButtonContent(icon: ImageVector, label: String, iconSize: Dp = 20.dp) {
    Icon(icon, contentDescription = null, modifier = Modifier.size(iconSize))
    Spacer(Modifier.width(8.dp))
    Text(label)
}
