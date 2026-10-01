package com.pipod.app.features.session

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pipod.app.core.session.RemoteUiKeys
import com.pipod.app.core.session.RemoteUiRole
import com.pipod.app.core.session.RemoteUiSurface
import com.pipod.app.ui.AnsiCellMetrics
import com.pipod.app.ui.AnsiLines
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.readableAnsiText
import com.pipod.app.ui.rememberAnsiCellMetrics
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors

/** The containers the acceptance pass addresses the extension surfaces by. */
object RemoteUiTestTags {
    const val HEADER: String = "remote-ui-header"
    const val FOOTER: String = "remote-ui-footer"
    const val WIDGETS: String = "remote-ui-widgets"
    const val EDITOR: String = "remote-ui-editor"
    const val EDITOR_FIELD: String = "remote-ui-editor-field"
    const val KEY_BAR: String = "remote-ui-key-bar"
    const val CAPTURE: String = "remote-ui-capture"
    const val OVERLAY_SCRIM: String = "remote-ui-overlay-scrim"

    fun surface(id: String): String = "remote-ui-surface-$id"

    fun widget(id: String): String = "remote-ui-widget-$id"

    fun overlay(id: String): String = "remote-ui-overlay-$id"

    fun overlayClose(id: String): String = "remote-ui-overlay-close-$id"

    fun key(label: String): String = "remote-ui-key-$label"
}

/**
 * Renders one pod-side extension surface as native styled text and forwards
 * terminal input back to it.
 *
 * Ported from `pi-pod-flutter/lib/features/session/remote_ui_surface_view.dart`.
 * The client is deliberately a dumb renderer: a frame is a whole-surface repaint
 * of a line array, so there is no cursor addressing or scrollback to emulate.
 * What it does own is the cell grid — the pod truncates lines against terminal
 * cells, so columns are always rounded down before being reported.
 *
 * @param revision `RemoteUiStore.state.value.revision`. A [RemoteUiSurface] is a
 *   plain mutable object that Compose cannot observe, and `input`/`setText`/
 *   `resize` never publish a snapshot, so the store's revision is the only thing
 *   that says "the pod repainted". Passing it as a parameter — rather than
 *   keying the composable on it — repaints without destroying the focus, scroll
 *   and editor state a `key(revision)` would throw away every tick.
 * @param interactive only `custom` and `editor` surfaces receive input; widgets,
 *   headers and footers are decorative in pi too.
 */
@Composable
fun RemoteUiSurfaceView(
    surface: RemoteUiSurface,
    viewportRows: Int,
    revision: Long,
    modifier: Modifier = Modifier,
    interactive: Boolean = false,
    autofocus: Boolean = false,
    maxHeight: Dp? = null,
) {
    val metrics = rememberAnsiCellMetrics(MonospaceTextStyle)
    val label = remoteUiSemanticsLabel(surface)
    val root = modifier.testTag(RemoteUiTestTags.surface(surface.id))

    if (!interactive) {
        SurfaceLines(surface, viewportRows, metrics, label, maxHeight, root)
        return
    }

    val readOnly = surface.readOnly
    val focusManager = LocalFocusManager.current
    val captureFocus = remember { FocusRequester() }
    var hasFocus by remember { mutableStateOf(false) }
    var controlArmed by remember { mutableStateOf(false) }

    // The last mirrored focus state actually applied. Surfaces repaint on every
    // pod-side tick, so reapplying focus per frame would drag it back from
    // wherever the user put it — the reference client tracks it the same way.
    var appliedFocus by remember { mutableStateOf<Boolean?>(null) }

    LaunchedEffect(surface.frame.focused, revision, readOnly) {
        if (readOnly) return@LaunchedEffect
        // `focused` mirrors the pod extension's own handle.focus()/unfocus(). A
        // surface that never sets it still takes focus once if it is a takeover.
        val want = surface.frame.focused ?: if (autofocus) surface.focused else null
        if (want == null || appliedFocus == want) return@LaunchedEffect
        appliedFocus = want
        // Only the unfocus half is honoured. Android is always the touch-keyboard
        // branch of the Dart, and there taking focus would hand it to the hidden
        // capture field that raises the keyboard — so a tap on the surface would
        // dismiss an open keyboard instead of summoning one. Tapping focuses
        // explicitly through the surface's own click below.
        if (!want && hasFocus) focusManager.clearFocus()
    }

    // The armed-control transform, cleared after the one key it applies to.
    fun send(data: String) {
        if (data.isEmpty()) return
        surface.input(if (controlArmed) asControl(data) else data)
        if (controlArmed) controlArmed = false
    }

    Column(root) {
        if (readOnly) ReadOnlyBanner()
        Box(
            Modifier
                .fillMaxWidth()
                // Preview rather than bubble: the zero-sized capture field below
                // holds the focus, and a focused text field would otherwise
                // swallow every printable key before the pod saw it.
                .onPreviewKeyEvent { event ->
                    if (readOnly) return@onPreviewKeyEvent false
                    val data = RemoteUiKeys.fromKeyEvent(event.nativeKeyEvent)
                        ?: return@onPreviewKeyEvent false
                    surface.input(data)
                    true
                }
                .clickable(enabled = !readOnly) { captureFocus.requestFocus() },
        ) {
            SurfaceLines(surface, viewportRows, metrics, label, maxHeight, Modifier.fillMaxWidth())
            if (!readOnly) {
                SoftKeyboardCapture(
                    focusRequester = captureFocus,
                    onInput = { data -> send(data) },
                    onFocusStateChanged = { hasFocus = it },
                )
            }
        }
        if (!readOnly) {
            RemoteUiKeyBar(
                // Straight to the surface: the key bar's own arrows and Esc are
                // already terminal sequences, so arming control must not rewrite
                // them. Only typed characters go through `send`.
                onKey = surface::input,
                onToggleControl = { controlArmed = !controlArmed },
                controlArmed = controlArmed,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * The lines themselves, on the cell grid the pod is told about.
 *
 * Split out because it is the whole of a decorative surface and the scrolling
 * body of an interactive one.
 */
@Composable
private fun SurfaceLines(
    surface: RemoteUiSurface,
    viewportRows: Int,
    metrics: AnsiCellMetrics,
    label: String,
    maxHeight: Dp?,
    modifier: Modifier,
) {
    val bounded = if (maxHeight == null) {
        modifier
    } else {
        modifier.heightIn(max = maxHeight).verticalScroll(rememberScrollState())
    }
    BoxWithConstraints(bounded) {
        val columns = metrics.columnsIn(maxWidth)
        // Reported from an effect, never from the layout pass: `resize` notifies
        // the store, which is what the Dart's post-frame callback existed to keep
        // out of the middle of a build.
        LaunchedEffect(columns, viewportRows, surface) { surface.resize(columns, viewportRows) }
        AnsiLines(
            lines = surface.lines,
            style = MonospaceTextStyle,
            metrics = metrics,
            semanticsLabel = label,
        )
    }
}

@Composable
private fun ReadOnlyBanner() {
    val colors = appColors
    Row(modifier = Modifier.padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = AppIcons.info,
            contentDescription = null,
            tint = colors.secondaryLabel,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = "Controlled by another client",
            style = MaterialTheme.typography.labelSmall,
            color = colors.secondaryLabel,
        )
    }
}

/**
 * Raises the on-screen keyboard for a surface that expects raw terminal input.
 *
 * A phone has no physical key events, so committed text is turned into input
 * events and deletions are detected against a sentinel the field is reset to
 * after every change. Composing input (autocorrect, CJK) only reaches the pod
 * once committed — a pod-side component that interprets individual keystrokes
 * sees the commit, not the composition.
 */
@Composable
private fun SoftKeyboardCapture(
    focusRequester: FocusRequester,
    onInput: (String) -> Unit,
    onFocusStateChanged: (Boolean) -> Unit,
) {
    var captured by remember { mutableStateOf(CAPTURE_BLANK) }

    // The reset is an effect rather than part of `onValueChange` so the state
    // really transitions: writing the sentinel back over itself would compare
    // equal, skip recomposition, and leave the typed character sitting in the
    // IME's own buffer.
    LaunchedEffect(captured) { if (captured != CAPTURE_BLANK) captured = CAPTURE_BLANK }

    BasicTextField(
        value = captured,
        onValueChange = { next ->
            val text = next.text
            when {
                text.length > CAPTURE_SENTINEL.length && text.startsWith(CAPTURE_SENTINEL) ->
                    onInput(text.substring(CAPTURE_SENTINEL.length))

                text.length < CAPTURE_SENTINEL.length ->
                    repeat(CAPTURE_SENTINEL.length - text.length) { onInput("\u007f") }

                text != CAPTURE_SENTINEL -> onInput(text.replace("\u200b", ""))
            }
            captured = next
        },
        modifier = Modifier
            // Zero-sized rather than absent: a field that is not in the tree
            // cannot hold focus, and the keyboard has to stay up for as long as
            // the surface is focused.
            .size(0.dp)
            .focusRequester(focusRequester)
            .onFocusChanged { onFocusStateChanged(it.isFocused) }
            // The tag is declared before the clearing modifier: a semantics
            // property set after one is discarded when the node's config is
            // collapsed.
            .testTag(RemoteUiTestTags.CAPTURE)
            // A mechanism, not a control: the surface's own node is what a
            // reader hears.
            .clearAndSetSemantics { },
        textStyle = TextStyle(fontSize = 1.sp),
        cursorBrush = SolidColor(Color.Transparent),
        singleLine = true,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Text,
            imeAction = ImeAction.Done,
        ),
        keyboardActions = KeyboardActions(onDone = { onInput("\r") }),
    )
}

/**
 * The keys a terminal component needs that an on-screen keyboard does not offer.
 *
 * @param onKey receives the raw terminal bytes for the key, already encoded.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RemoteUiKeyBar(
    onKey: (String) -> Unit,
    onToggleControl: () -> Unit,
    controlArmed: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = appColors
    FlowRow(
        modifier = modifier.padding(top = 6.dp).testTag(RemoteUiTestTags.KEY_BAR),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        REMOTE_UI_KEYS.forEach { (label, data) ->
            KeyChip(
                label = label,
                semanticsLabel = "Send $label",
                background = colors.fill,
                foreground = colors.label,
                onClick = { onKey(data) },
            )
        }
        KeyChip(
            label = "Ctrl",
            semanticsLabel = if (controlArmed) {
                "Control armed for the next key"
            } else {
                "Arm control for the next key"
            },
            background = if (controlArmed) colors.accent else colors.fill,
            foreground = if (controlArmed) colors.onAccent else colors.label,
            armed = controlArmed,
            onClick = onToggleControl,
        )
    }
}

@Composable
private fun KeyChip(
    label: String,
    semanticsLabel: String,
    background: Color,
    foreground: Color,
    onClick: () -> Unit,
    armed: Boolean? = null,
) {
    Box(
        modifier = Modifier
            // Android's minimum touch target; anything shorter turns the
            // terminal key bar into a mis-tap strip on a phone.
            .defaultMinSize(
                minWidth = AppButtonDefaults.MinTouchTarget,
                minHeight = AppButtonDefaults.MinTouchTarget,
            )
            .clip(RoundedCornerShape(8.dp))
            .background(background)
            .clickable(onClick = onClick)
            .testTag(RemoteUiTestTags.key(label))
            .padding(horizontal = 10.dp)
            .clearAndSetSemantics {
                contentDescription = semanticsLabel
                role = Role.Button
                if (armed != null) selected = armed
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, style = MaterialTheme.typography.bodySmall, color = foreground)
    }
}

/** The accessible name a surface reads as, by role. */
internal fun remoteUiSemanticsLabel(surface: RemoteUiSurface): String {
    val text = readableAnsiText(surface.lines)
    val prefix = when (surface.role) {
        RemoteUiRole.HEADER -> "Extension header"
        RemoteUiRole.FOOTER -> "Extension footer"
        RemoteUiRole.WIDGET -> "Extension panel"
        RemoteUiRole.EDITOR -> "Extension editor"
        RemoteUiRole.CUSTOM -> "Extension surface"
    }
    return if (text.isEmpty()) prefix else "$prefix. $text"
}

/** A letter typed while control is armed becomes its C0 control character. */
private fun asControl(data: String): String {
    val code = data[0].code or 0x20
    return if (code in 0x61..0x7a) (code - 0x60).toChar().toString() else data
}

private val REMOTE_UI_KEYS: List<Pair<String, String>> = listOf(
    "Esc" to "\u001b",
    "Tab" to "\t",
    "←" to "\u001b[D",
    "↓" to "\u001b[B",
    "↑" to "\u001b[A",
    "→" to "\u001b[C",
    "⏎" to "\r",
)

private const val CAPTURE_SENTINEL: String = "\u200b\u200b\u200b\u200b"

private val CAPTURE_BLANK = TextFieldValue(
    text = CAPTURE_SENTINEL,
    selection = TextRange(CAPTURE_SENTINEL.length),
)
