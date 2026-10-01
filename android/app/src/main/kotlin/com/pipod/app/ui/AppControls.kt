package com.pipod.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.pipod.app.ui.theme.appColors

/**
 * A switch, ported from `pi-pod-flutter/lib/ui/app_controls.dart`.
 *
 * A thin wrapper on purpose: naming it here is what lets every settings screen
 * read the same, and leaves one place to change if the control ever has to.
 */
@Composable
fun AppSwitch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Switch(
        checked = checked,
        onCheckedChange = onCheckedChange,
        modifier = modifier,
        enabled = enabled && onCheckedChange != null,
    )
}

/**
 * A labelled setting the reader flips in place.
 *
 * The whole row toggles rather than just the thumb, and it is one node with a
 * switch role, so the name and the state are announced together instead of as
 * two stops with the state on the unnamed one.
 */
@Composable
fun AppSwitchRow(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    subtitle: (@Composable () -> Unit)? = null,
    title: @Composable () -> Unit,
) {
    val active = enabled && onCheckedChange != null
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .then(
                if (onCheckedChange == null) {
                    Modifier
                } else {
                    Modifier.toggleable(
                        value = checked,
                        enabled = active,
                        role = Role.Switch,
                        onValueChange = onCheckedChange,
                    )
                },
            )
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            ProvideTextStyle(MaterialTheme.typography.bodyLarge) { title() }
            if (subtitle != null) {
                Spacer(Modifier.height(2.dp))
                CompositionLocalProvider(LocalContentColor provides appColors.secondaryLabel) {
                    ProvideTextStyle(MaterialTheme.typography.bodyMedium) { subtitle() }
                }
            }
        }
        Spacer(Modifier.width(12.dp))
        // The row already carries the toggle action and the state, so the
        // switch is decoration here: a second toggleable node would make one
        // setting two stops.
        Switch(checked = checked, onCheckedChange = null, enabled = active)
    }
}
