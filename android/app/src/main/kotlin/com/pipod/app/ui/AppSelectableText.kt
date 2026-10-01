package com.pipod.app.ui

import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow

/**
 * True inside an [AppSelectionScope].
 *
 * A [SelectionContainer] only ever selects within itself, so one per text
 * widget means a drag stops dead at the end of the paragraph it started in —
 * a reply made of a heading, two paragraphs and a bullet list cannot be copied
 * in one gesture. Every text that can select therefore asks whether a scope is
 * already open above it and stays a plain `Text` when one is.
 */
private val LocalAppSelectionScope = compositionLocalOf { false }

/**
 * One selectable region spanning everything inside it.
 *
 * Put it at the level a reader would expect a drag to cover — a whole message,
 * not each block of one.
 */
@Composable
fun AppSelectionScope(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    if (LocalAppSelectionScope.current) {
        // Already inside one. Nesting would cut the outer selection in two.
        content()
        return
    }
    SelectionContainer(modifier = modifier) {
        CompositionLocalProvider(LocalAppSelectionScope provides true) { content() }
    }
}

/**
 * Selectable [content], unless an [AppSelectionScope] above already covers it.
 *
 * The building block for a widget that has to be selectable wherever it is
 * used, without breaking a wider selection when it is used inside one. It takes
 * no modifier on purpose: the container disappears inside a scope, so anything
 * hung on it would disappear with it. Callers put their modifiers on the
 * content.
 */
@Composable
fun AppSelectable(content: @Composable () -> Unit) {
    if (LocalAppSelectionScope.current) {
        content()
        return
    }
    SelectionContainer { content() }
}

/**
 * Text the reader can select and copy, such as a transcript line or an id.
 *
 * Ported from `pi-pod-flutter/lib/ui/app_selectable_text.dart`. Selection is
 * an ambient capability in Compose rather than a property of the text, so the
 * widget is an [AppSelectable] around an ordinary [Text]; the handles and the
 * toolbar come from the platform.
 *
 * @param semanticsLabel what a screen reader announces instead of the visible
 *   run, for an id that reads as noise when spelled out character by character.
 */
@Composable
fun AppSelectableText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = LocalTextStyle.current,
    textAlign: TextAlign? = null,
    maxLines: Int = Int.MAX_VALUE,
    semanticsLabel: String? = null,
) {
    AppSelectable {
        Text(
            text = text,
            style = style,
            textAlign = textAlign,
            maxLines = maxLines,
            overflow = TextOverflow.Ellipsis,
            modifier = if (semanticsLabel == null) {
                modifier
            } else {
                modifier.semantics { contentDescription = semanticsLabel }
            },
        )
    }
}
