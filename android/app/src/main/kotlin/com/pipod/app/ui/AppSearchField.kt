package com.pipod.app.ui

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction

/**
 * A field that filters a list, ported from
 * `pi-pod-flutter/lib/ui/app_search_field.dart`.
 *
 * Keep [label] and [placeholder] identical: the visible hint and the announced
 * name are the same words, and a search field that announces something the
 * reader cannot see on screen is harder to describe to someone else.
 */
@Composable
fun AppSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    AppTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier,
        label = label,
        placeholder = placeholder,
        enabled = enabled,
        prefixIcon = AppIcons.search,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
    )
}
