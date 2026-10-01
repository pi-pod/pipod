package com.pipod.app.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.pipod.app.ui.theme.appColors

/**
 * How a field is drawn. A composer sits in a bar and reads as a pill; an
 * ordinary form field reads as a box.
 */
enum class AppFieldShape { Box, Pill }

/**
 * A single- or multi-line text input, ported from
 * `pi-pod-flutter/lib/ui/app_text_field.dart`.
 *
 * Compose hoists the text, so callers own a `String` and an `onValueChange`
 * instead of a `TextEditingController`; everything a form has to coordinate —
 * validation, enabling Save, clearing after a submit — then lives in one place
 * rather than behind a controller's listener.
 *
 * @param semanticsLabel the field's accessible name, for when the visible
 *   [label] is too terse to stand alone. A form of fields called "Name" and
 *   "Value" reads fine on screen, where the section heading supplies the
 *   context, and not at all through a screen reader, which announces one field
 *   at a time. It is applied as the field's content description, so the visible
 *   label keeps saying "Name" while the spoken one says "User secret name".
 */
@Composable
fun AppTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    obscureText: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    textStyle: TextStyle = LocalTextStyle.current,
    minLines: Int = 1,
    maxLines: Int = 1,
    prefixIcon: ImageVector? = null,
    shape: AppFieldShape = AppFieldShape.Box,
    suffix: (@Composable () -> Unit)? = null,
    isError: Boolean = false,
    semanticsLabel: String? = null,
) {
    val name = semanticsLabel ?: label
    val singleLine = maxLines == 1
    val visualTransformation: VisualTransformation =
        if (obscureText) PasswordVisualTransformation() else VisualTransformation.None
    val leading: (@Composable () -> Unit)? = prefixIcon?.let {
        { Icon(it, contentDescription = null, tint = appColors.secondaryLabel) }
    }
    val hint: (@Composable () -> Unit)? = placeholder?.let { { Text(it) } }
    val naming: (@Composable () -> Unit)? = name?.let { { Text(it) } }
    val visibleLabel: (@Composable () -> Unit)? = label?.let { { Text(it) } }

    // Naming the field replaces what a screen reader would otherwise assemble
    // from its label and value. Applied once, on the field's own node, so there
    // is exactly one node to find and it keeps its name after the placeholder
    // disappears behind typed text.
    val named = if (name != null && name != label) {
        modifier.semantics { contentDescription = name }
    } else {
        modifier
    }

    when (shape) {
        AppFieldShape.Box -> OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = named.fillMaxWidth(),
            enabled = enabled,
            readOnly = readOnly,
            textStyle = textStyle,
            label = visibleLabel ?: naming,
            placeholder = hint,
            leadingIcon = leading,
            trailingIcon = suffix,
            isError = isError,
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            singleLine = singleLine,
            minLines = minLines,
            maxLines = maxLines,
        )

        // A composer has no room for a floating label and no space above it to
        // put one, so the pill carries the name in semantics and shows only the
        // hint. Both indicators are cleared: the fill is the field's edge.
        AppFieldShape.Pill -> TextField(
            value = value,
            onValueChange = onValueChange,
            // The pill shows only a hint, and a hint disappears the moment
            // anything is typed — so the name rides on the field's own node
            // instead, and survives into the state where it matters most.
            modifier = named.fillMaxWidth(),
            enabled = enabled,
            readOnly = readOnly,
            textStyle = textStyle,
            label = null,
            placeholder = hint ?: naming,
            leadingIcon = leading,
            trailingIcon = suffix,
            isError = isError,
            visualTransformation = visualTransformation,
            keyboardOptions = keyboardOptions,
            keyboardActions = keyboardActions,
            singleLine = singleLine,
            minLines = minLines,
            maxLines = maxLines,
            shape = RoundedCornerShape(20.dp),
            colors = TextFieldDefaults.colors(
                focusedContainerColor = appColors.fill,
                unfocusedContainerColor = appColors.fill,
                disabledContainerColor = appColors.fill,
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                disabledIndicatorColor = Color.Transparent,
            ),
        )
    }
}
