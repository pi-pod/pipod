package com.pipod.app.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow

/** One choice in an [AppOptionPicker]. */
@Immutable
data class AppOption<T>(val value: T, val label: String)

/**
 * Picks one value from a known set, ported from
 * `pi-pod-flutter/lib/ui/app_picker.dart`.
 *
 * The current value is shown in the field itself and the choices drop down over
 * it, which is what a Material form does; the Flutter widget's action-sheet and
 * wheel presentations belong to Apple targets and have no Android counterpart.
 *
 * Labels ellipsize rather than wrap: a long environment name would otherwise
 * push the row taller than the rest of the form at large text sizes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> AppOptionPicker(
    label: String,
    value: T,
    options: List<AppOption<T>>,
    onValueChange: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = options.firstOrNull { it.value == value }

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { if (enabled) expanded = it },
        modifier = modifier.testTag("app-option-picker-$label"),
    ) {
        OutlinedTextField(
            value = selected?.label.orEmpty(),
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(label) },
            singleLine = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable, enabled)
                .fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = {
                        Text(option.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    },
                    onClick = {
                        expanded = false
                        if (option.value != value) onValueChange(option.value)
                    },
                )
            }
        }
    }
}
