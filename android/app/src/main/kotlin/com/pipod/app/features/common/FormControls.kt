package com.pipod.app.features.common

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.pipod.app.core.format.SecretName
import com.pipod.app.core.format.StatusTone
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors

/**
 * A multiline editor for shell scripts and JSON.
 *
 * Ported from `pi-pod-flutter/lib/features/common/form_controls.dart`. Every
 * substitution the keyboard would helpfully apply is off: an auto-capitalised
 * `Echo` or a curly quote turns pasted code into code that no longer runs, and
 * the reader has no way to see which character was swapped.
 *
 * Nothing draws a visible label for a multi-line editor, so
 * [accessibilityLabel] is the field's only name.
 */
@Composable
fun PlainTextEditor(
    value: String,
    onValueChange: (String) -> Unit,
    accessibilityLabel: String,
    modifier: Modifier = Modifier,
    minHeight: Dp = 100.dp,
    enabled: Boolean = true,
) {
    AppTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier
            .heightIn(min = minHeight)
            .testTag("plain-text-editor"),
        enabled = enabled,
        semanticsLabel = accessibilityLabel,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Ascii,
        ),
        textStyle = MonospaceTextStyle,
        // A line is about 20dp tall, so the editor opens at the height the
        // caller asked for instead of growing into it from one line.
        minLines = (minHeight / 20.dp).toInt().coerceAtLeast(1),
        maxLines = Int.MAX_VALUE,
    )
}

/**
 * Name, value, validation and save action for one write-only secret.
 *
 * The state is hoisted so the screen that owns the save request also owns what
 * is being saved; everything below is derived from those two strings.
 */
@Composable
fun SecretEntryFields(
    name: String,
    onNameChange: (String) -> Unit,
    value: String,
    onValueChange: (String) -> Unit,
    semanticsPrefix: String,
    isSaving: Boolean,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val valueFocus = remember { FocusRequester() }
    val problem = SecretName.problem(name)
    val notice = SecretName.normalizationNotice(name)
    val canSave = enabled && !isSaving &&
        SecretName.isValid(name) && value.trim().isNotEmpty()

    Column(modifier = modifier.fillMaxWidth()) {
        // The accessible name rides the field itself, so the tree holds one
        // text-field node rather than a label wrapper beside the field.
        AppTextField(
            value = name,
            // A secret name is one line by definition; a pasted trailing
            // newline would otherwise silently become part of it.
            onValueChange = { onNameChange(it.replace(NEWLINES, "")) },
            enabled = enabled && !isSaving,
            label = "Name",
            semanticsLabel = "$semanticsPrefix name",
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Characters,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Next,
            ),
            keyboardActions = KeyboardActions(onNext = { valueFocus.requestFocus() }),
            textStyle = MonospaceTextStyle,
        )
        when {
            problem != null -> FieldNotice(
                text = problem,
                semanticsLabel = "$semanticsPrefix name problem: $problem",
                color = appColors.tone(StatusTone.Caution),
            )

            notice != null -> FieldNotice(
                text = notice,
                semanticsLabel = "$semanticsPrefix name normalization: $notice",
                color = appColors.secondaryLabel,
            )
        }
        Spacer(Modifier.height(12.dp))
        SecretValueField(
            value = value,
            onValueChange = onValueChange,
            semanticsPrefix = semanticsPrefix,
            enabled = enabled && !isSaving,
            focusRequester = valueFocus,
            imeAction = ImeAction.Done,
            onSubmit = { if (canSave) onSave() },
        )
        Spacer(Modifier.height(12.dp))
        AppButton(
            onClick = onSave,
            enabled = canSave,
            semanticsLabel = "Save ${semanticsPrefix.lowercase()}",
            modifier = Modifier.testTag("save-secret"),
        ) {
            if (isSaving) {
                AppActivityIndicator(size = 16.dp)
                Spacer(Modifier.width(8.dp))
                Text("Saving secret…")
            } else {
                Text("Save secret")
            }
        }
    }
}

/**
 * A write-only secret value with an explicit show/hide control.
 *
 * Revealing is deliberate and never sticky beyond this field: a value typed
 * while someone is looking over a shoulder should not stay visible because an
 * earlier screen turned reveal on.
 */
@Composable
fun SecretValueField(
    value: String,
    onValueChange: (String) -> Unit,
    semanticsPrefix: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    focusRequester: FocusRequester? = null,
    imeAction: ImeAction = ImeAction.Default,
    onSubmit: (() -> Unit)? = null,
) {
    var reveals by rememberSaveable { mutableStateOf(false) }
    val toggleLabel = if (reveals) "Hide secret value" else "Show secret value"

    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        AppTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier
                .weight(1f)
                .then(if (focusRequester == null) Modifier else Modifier.focusRequester(focusRequester)),
            enabled = enabled,
            obscureText = !reveals,
            label = "Value",
            semanticsLabel = "$semanticsPrefix value",
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Password,
                imeAction = imeAction,
            ),
            keyboardActions = KeyboardActions(onDone = { onSubmit?.invoke() }),
            // A revealed secret is read character by character to check it, so
            // it is set in the column-aligned face while it is visible.
            textStyle = if (reveals) MonospaceTextStyle else MaterialTheme.typography.bodyLarge,
        )
        Spacer(Modifier.width(4.dp))
        AppIconButton(
            icon = if (reveals) AppIcons.hide else AppIcons.show,
            onClick = { reveals = !reveals },
            enabled = enabled,
            semanticsLabel = "$toggleLabel for ${semanticsPrefix.lowercase()}",
        )
    }
}

/** A one-line note under a field, announced as it appears. */
@Composable
private fun FieldNotice(text: String, semanticsLabel: String, color: Color) {
    Spacer(Modifier.height(4.dp))
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        modifier = Modifier.semantics {
            liveRegion = LiveRegionMode.Polite
            contentDescription = semanticsLabel
        },
    )
}

private val NEWLINES = Regex("[\\r\\n]")
