package com.pipod.app.features.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.unit.min
import com.pipod.app.core.session.RemoteUiLength
import com.pipod.app.core.session.RemoteUiMargin
import com.pipod.app.core.session.RemoteUiOverlayOptions
import com.pipod.app.core.session.RemoteUiSurface
import com.pipod.app.shell.ContentPane
import com.pipod.app.ui.AnsiCellMetrics
import com.pipod.app.ui.AnsiLines
import com.pipod.app.ui.AppFieldShape
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.rememberAnsiCellMetrics
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors

/**
 * Where an overlay surface lands inside the session view, resolved from the
 * pod's terminal-cell placement options.
 *
 * Ported from `pi-pod-flutter/lib/features/session/remote_ui_layers.dart`. Every
 * length the pod sends is either a count of terminal cells or a percentage of
 * the host, so nothing here can be resolved without the measured cell size.
 */
@Immutable
data class RemoteUiOverlayGeometry(
    val width: Dp,
    val maxHeight: Dp,
    val alignment: Alignment,
    val offset: DpOffset,
    val margin: PaddingValues,
) {
    companion object {
        fun resolve(
            viewportWidth: Dp,
            viewportHeight: Dp,
            metrics: AnsiCellMetrics,
            options: RemoteUiOverlayOptions?,
            lineCount: Int,
            widestLine: Int,
        ): RemoteUiOverlayGeometry {
            val cells = options?.margin ?: RemoteUiMargin()
            val left = metrics.width * cells.left.toFloat()
            val top = metrics.height * cells.top.toFloat()
            val right = metrics.width * cells.right.toFloat()
            val bottom = metrics.height * cells.bottom.toFloat()
            val availableWidth = (viewportWidth - left - right).coerceAtLeast(metrics.width)
            val availableHeight = (viewportHeight - top - bottom).coerceAtLeast(metrics.height)

            val requestedWidth = options?.width
            val minWidth = metrics.width * (options?.minWidth ?: 0.0).toFloat()
            val width = if (requestedWidth == null) {
                (metrics.width * widestLine.toFloat()).clampTo(minWidth, availableWidth)
            } else {
                resolveLength(requestedWidth, viewportWidth, metrics.width)
            }.clampTo(metrics.width, availableWidth)

            val requestedHeight = options?.maxHeight
            val maxHeight = if (requestedHeight == null) {
                metrics.height * lineCount.toFloat()
            } else {
                resolveLength(requestedHeight, viewportHeight, metrics.height)
            }.clampTo(metrics.height, availableHeight)

            val anchor = options?.anchor?.lowercase() ?: ""
            var alignment: Alignment = BiasAlignment(
                horizontalBias = bias(anchor, negative = "left", positive = "right"),
                verticalBias = bias(anchor, negative = "top", positive = "bottom"),
            )
            var offset = DpOffset(
                x = metrics.width * (options?.offsetX ?: 0.0).toFloat(),
                y = metrics.height * (options?.offsetY ?: 0.0).toFloat(),
            )

            val row = options?.row
            val col = options?.col
            if (row != null || col != null) {
                // An absolute cell position is measured from the top-left of the host.
                alignment = Alignment.TopStart
                offset += DpOffset(
                    x = if (col == null) 0.dp else resolveLength(col, viewportWidth, metrics.width),
                    y = if (row == null) 0.dp else resolveLength(row, viewportHeight, metrics.height),
                )
            }

            return RemoteUiOverlayGeometry(
                width = width,
                maxHeight = maxHeight,
                alignment = alignment,
                offset = offset,
                margin = PaddingValues(start = left, top = top, end = right, bottom = bottom),
            )
        }

        private fun bias(anchor: String, negative: String, positive: String): Float = when {
            anchor.contains(negative) -> -1f
            anchor.contains(positive) -> 1f
            else -> 0f
        }

        private fun resolveLength(length: RemoteUiLength, total: Dp, cell: Dp): Dp =
            if (length.isPercent) {
                length.resolve(total.value.toDouble()).toFloat().dp
            } else {
                cell * length.value.toFloat()
            }

        /**
         * Dart's `num.clamp` refuses a lower bound above the upper one; here the
         * upper bound wins, because a panel wider than the space it has is
         * unusable either way.
         */
        private fun Dp.clampTo(min: Dp, max: Dp): Dp = coerceAtLeast(min).coerceAtMost(max)
    }
}

/** A header or footer band pinned to the top or bottom of the session view. */
@Composable
fun RemoteUiBand(
    surface: RemoteUiSurface,
    viewportRows: Int,
    isHeader: Boolean,
    revision: Long,
    modifier: Modifier = Modifier,
) {
    if (surface.lines.all { it.isBlank() }) return
    val colors = appColors
    val separator = colors.separator
    Box(
        modifier
            .fillMaxWidth()
            .background(colors.bar)
            // A hairline on the inner edge only: the band reads as part of the
            // chrome it is pinned to, not as a floating card.
            .drawBehind {
                val stroke = 0.5.dp.toPx()
                val y = if (isHeader) size.height - stroke / 2 else stroke / 2
                drawLine(separator, Offset(0f, y), Offset(size.width, y), stroke)
            }
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .testTag(if (isHeader) RemoteUiTestTags.HEADER else RemoteUiTestTags.FOOTER),
    ) {
        ContentPane {
            RemoteUiSurfaceView(surface = surface, viewportRows = viewportRows, revision = revision)
        }
    }
}

/**
 * Extension widget surfaces for one placement, in the order the pod opened them.
 */
@Composable
fun RemoteUiWidgetStack(
    surfaces: List<RemoteUiSurface>,
    viewportRows: Int,
    revision: Long,
    modifier: Modifier = Modifier,
) {
    if (surfaces.isEmpty()) return
    ContentPane(modifier.testTag(RemoteUiTestTags.WIDGETS)) {
        Column(Modifier.fillMaxWidth()) {
            surfaces.forEach { surface ->
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, top = 2.dp, end = 16.dp, bottom = 2.dp)
                        .testTag(RemoteUiTestTags.widget(surface.id)),
                ) {
                    RemoteUiSurfaceView(
                        surface = surface,
                        viewportRows = viewportRows,
                        revision = revision,
                    )
                }
            }
        }
    }
}

/**
 * An extension-owned editor presented next to the composer. The surface's text
 * is bound to a real text field, so IME, selection and autocorrect behave the
 * way they do everywhere else in the app.
 *
 * @param revision see [RemoteUiSurfaceView]. `setText` never publishes a
 *   snapshot, so this is also the only signal that the pod — rather than the
 *   user — changed the text.
 */
@Composable
fun RemoteUiEditorPanel(
    surface: RemoteUiSurface,
    viewportRows: Int,
    revision: Long,
    modifier: Modifier = Modifier,
) {
    val colors = appColors
    val metrics = rememberAnsiCellMetrics(MonospaceTextStyle)
    val focusManager = LocalFocusManager.current
    val fieldFocus = remember { FocusRequester() }
    var text by remember { mutableStateOf(surface.editorText) }
    var hasFocus by remember { mutableStateOf(false) }

    // The last pod-requested focus state actually applied. Surfaces repaint on
    // every pod-side tick, so reapplying per frame would yank focus back from
    // wherever the user moved it.
    var appliedFocus by remember { mutableStateOf<Boolean?>(null) }

    LaunchedEffect(revision, surface) {
        // The field owns its text and adopts the surface's only when a pod frame
        // actually changed it: `setText` publishes nothing, so reading the
        // surface every frame would fight whatever is being typed.
        if (surface.editorText != text) text = surface.editorText
        if (surface.readOnly) {
            if (hasFocus) focusManager.clearFocus()
            return@LaunchedEffect
        }
        // The pod explicitly asking for the editor (`focused: true`) focuses the
        // real text input, which is what raises the software keyboard. Anything
        // else leaves focus alone: an editor that steals focus on every frame
        // would fight the user's taps.
        val want = surface.frame.focused
        if (want == null || appliedFocus == want) return@LaunchedEffect
        appliedFocus = want
        if (want) fieldFocus.requestFocus() else if (hasFocus) focusManager.clearFocus()
    }

    // pi's editor component renders its input on the first line and anything
    // else — completions, hints — below it. The field replaces that first line;
    // the rest still renders so those affordances survive.
    val decoration = if (surface.lines.size > 1) surface.lines.drop(1) else emptyList()

    Box(
        modifier
            .fillMaxWidth()
            .background(colors.bar)
            .padding(start = 16.dp, top = 6.dp, end = 16.dp, bottom = 6.dp)
            .testTag(RemoteUiTestTags.EDITOR),
    ) {
        ContentPane {
            Column(Modifier.fillMaxWidth()) {
                // No naming wrapper: the placeholder already labels the field,
                // and a wrapper would expose a second, value-less text-field
                // node. Enter is intercepted on the field's own node for the
                // same reason — a wrapper focus target would swallow the tap
                // that raises the keyboard.
                AppTextField(
                    value = text,
                    onValueChange = { next ->
                        text = next
                        surface.setText(next)
                    },
                    placeholder = "Extension input…",
                    shape = AppFieldShape.Pill,
                    minLines = 1,
                    maxLines = 6,
                    enabled = !surface.readOnly,
                    // A pod-side component reads keystrokes, so it has to see
                    // what was typed rather than what a keyboard guessed.
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Text,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { surface.input("\r") }),
                    modifier = Modifier
                        .focusRequester(fieldFocus)
                        .onFocusChanged { hasFocus = it.isFocused }
                        // A multi-line field would swallow Enter as a newline,
                        // but the component in the pod is what decides what
                        // Enter means. Shift+Enter keeps the local newline.
                        .onPreviewKeyEvent { event -> forwardEnter(event, surface) }
                        .testTag(RemoteUiTestTags.EDITOR_FIELD),
                )
                if (decoration.isNotEmpty()) {
                    AnsiLines(
                        lines = decoration,
                        style = MonospaceTextStyle,
                        metrics = metrics,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

/**
 * Custom surfaces floating over the transcript, each at the cell position its
 * extension asked for.
 */
@Composable
fun RemoteUiOverlayLayer(
    surfaces: List<RemoteUiSurface>,
    viewportRows: Int,
    revision: Long,
    modifier: Modifier = Modifier,
) {
    if (surfaces.isEmpty()) return
    val metrics = rememberAnsiCellMetrics(MonospaceTextStyle)
    BoxWithConstraints(modifier.fillMaxSize()) {
        val viewportWidth = maxWidth
        val viewportHeight = maxHeight
        // A focused surface is modal in the pod's own model — keystrokes go to
        // it, not to the conversation. Without a scrim the transcript behind it
        // looks live, and a tap meant for the panel lands on a message. The
        // scrim carries no semantics and no click of its own: it dims and
        // swallows strays, while back and the panel's own Dismiss are the two
        // named ways out.
        if (surfaces.any { it.focused }) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = REMOTE_UI_SCRIM_ALPHA))
                    .pointerInput(Unit) {
                        awaitPointerEventScope {
                            while (true) awaitPointerEvent().changes.forEach { it.consume() }
                        }
                    }
                    .testTag(RemoteUiTestTags.OVERLAY_SCRIM),
            )
        }
        surfaces.forEach { surface ->
            val geometry = RemoteUiOverlayGeometry.resolve(
                viewportWidth = viewportWidth,
                viewportHeight = viewportHeight,
                metrics = metrics,
                options = surface.overlayOptions,
                lineCount = surface.lines.size,
                widestLine = surface.lines.maxOfOrNull { it.length } ?: 0,
            )
            Box(
                Modifier
                    .align(geometry.alignment)
                    .padding(geometry.margin)
                    .offset(geometry.offset.x, geometry.offset.y)
                    // A panel narrower than its own chrome is unusable, so a very
                    // small requested width is widened; the pod renders to the
                    // columns this box actually reports back.
                    .width(max(geometry.width, min(240.dp, viewportWidth - 16.dp))),
            ) {
                OverlayPanel(
                    surface = surface,
                    viewportRows = viewportRows,
                    revision = revision,
                    maxHeight = geometry.maxHeight,
                )
            }
        }
    }
}

@Composable
private fun OverlayPanel(
    surface: RemoteUiSurface,
    viewportRows: Int,
    revision: Long,
    maxHeight: Dp,
) {
    val colors = appColors
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier
            .padding(8.dp)
            .shadow(6.dp, shape)
            .background(colors.card, shape)
            .border(
                width = if (surface.focused) 1.5.dp else 0.5.dp,
                color = if (surface.focused) colors.accent else colors.separator,
                shape = shape,
            )
            .padding(start = 12.dp, top = 8.dp, end = 12.dp, bottom = 8.dp)
            // A boundary without a label: it scopes the surface's semantics to
            // the panel instead of letting assistive tech treat the screen
            // behind it as part of the overlay.
            .semantics(mergeDescendants = false) { isTraversalGroup = true }
            .testTag(RemoteUiTestTags.overlay(surface.id)),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = "Extension",
                style = MaterialTheme.typography.labelSmall,
                color = colors.secondaryLabel,
                modifier = Modifier.weight(1f),
            )
            AppIconButton(
                icon = AppIcons.close,
                onClick = surface::close,
                semanticsLabel = "Dismiss extension surface",
                // The glyph stays small; the tap target keeps the 48dp minimum.
                iconSize = 18.dp,
                dimension = AppButtonDefaults.MinTouchTarget,
                modifier = Modifier.testTag(RemoteUiTestTags.overlayClose(surface.id)),
            )
        }
        // The panel's own chrome and padding come out of the height the pod asked
        // for, so a surface taller than the session view shrinks and scrolls
        // instead of overflowing it.
        RemoteUiSurfaceView(
            surface = surface,
            viewportRows = viewportRows,
            revision = revision,
            modifier = Modifier.fillMaxWidth(),
            interactive = true,
            autofocus = true,
            maxHeight = maxHeight,
        )
    }
}

/** How far the conversation is dimmed behind a focused extension surface. */
private const val REMOTE_UI_SCRIM_ALPHA = 0.45f

/** Enter belongs to the pod's component; Shift+Enter stays a local newline. */
private fun forwardEnter(event: KeyEvent, surface: RemoteUiSurface): Boolean {
    if (event.type != KeyEventType.KeyDown) return false
    if (event.key != Key.Enter && event.key != Key.NumPadEnter) return false
    if (event.isShiftPressed) return false
    surface.input("\r")
    return true
}