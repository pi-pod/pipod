package com.pipod.app.features.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.theme.appColors

/**
 * The pieces every settings surface is assembled from, ported from the private
 * widgets at the bottom of `pi-pod-flutter/lib/features/settings/settings_view.dart`.
 *
 * They live in one file because the settings screen and the config-bundle
 * editor both draw the same card, the same "label, value" row and the same
 * status line, and two copies would drift.
 */

/** Something that just happened, phrased for the reader. */
@Immutable
data class SettingsStatus(val text: String, val isError: Boolean)

/**
 * A card of settings rows under an optional heading.
 *
 * `AppListSection` already exposes its caption as a heading, so the card itself
 * is never flagged as one: that would merge every row and button inside it into
 * a single announced node.
 */
@Composable
fun SettingsCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    AppListSection(modifier = modifier, header = title, footer = footer) {
        row {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                content = content,
            )
        }
    }
}

/**
 * One "label, value" row.
 *
 * The whole row is one node carrying exactly `"label, value"`: without the
 * boundary the texts merge into the surrounding card and announce twice, once
 * from this row and once glued to its neighbours. Long values (an email has no
 * spaces) ellipsize on screen while the full value stays in the spoken name.
 */
@Composable
fun SettingsLabeledValue(label: String, value: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp)
            .clearAndSetSemantics { contentDescription = "$label, $value" },
        verticalAlignment = Alignment.Top,
    ) {
        Text(text = label)
        Spacer(Modifier.width(16.dp))
        Text(
            text = value,
            modifier = Modifier.weight(1f),
            textAlign = TextAlign.End,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            softWrap = false,
            fontWeight = FontWeight.Medium,
        )
    }
}

/**
 * A success or failure line, announced as it appears.
 *
 * The name already carries the whole sentence, so the icon and the text below
 * it are cleared — otherwise the same words announce a second time.
 */
@Composable
fun SettingsStatusLabel(status: SettingsStatus, modifier: Modifier = Modifier) {
    val colors = appColors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clearAndSetSemantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = "${if (status.isError) "Error" else "Success"}: ${status.text}"
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = if (status.isError) AppIcons.warning else AppIcons.success,
            contentDescription = null,
            tint = if (status.isError) colors.destructive else colors.success,
        )
        Spacer(Modifier.width(8.dp))
        Text(text = status.text, modifier = Modifier.weight(1f))
    }
}

/**
 * One section's load failure with its own retry.
 *
 * The settings sections load concurrently and fail independently, so a failure
 * is drawn where the missing data would have been rather than replacing the
 * screen — one outage must not hide or clear another's.
 */
@Composable
fun SettingsSectionError(
    message: String,
    retrySemanticsLabel: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth(), horizontalAlignment = Alignment.Start) {
        SettingsStatusLabel(SettingsStatus(text = message, isError = true))
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.Start) {
            AppButton(
                text = "Try again",
                onClick = onRetry,
                kind = AppButtonKind.Plain,
                semanticsLabel = retrySemanticsLabel,
            )
        }
    }
}

/** A footnote under a card's contents, in the same voice as a section footer. */
@Composable
fun SettingsFootnote(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier,
        style = MaterialTheme.typography.bodySmall,
        color = appColors.secondaryLabel,
    )
}
