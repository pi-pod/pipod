package com.pipod.app.features.session

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pipod.app.core.session.SessionUsage
import com.pipod.app.ui.AppListPadding
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppSheet
import com.pipod.app.ui.theme.appColors

/** Test handles for the usage readout and its breakdown. */
object SessionUsageTestTags {
    const val STRIP = "composer-usage"
    const val SHEET = "session-usage-sheet"
}

/**
 * pi's footer line for the phone: tokens in and out, cost, and how full the
 * context is. Tapping anywhere along it opens the breakdown, which is why the
 * whole row is the target rather than the text alone.
 */
@Composable
internal fun SessionUsageStrip(usage: SessionUsage, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val label = usage.accessibilitySummary
    val style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = "tnum")
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 32.dp)
            .testTag(SessionUsageTestTags.STRIP)
            .clickable(role = Role.Button, onClickLabel = "Show usage breakdown", onClick = onClick)
            .clearAndSetSemantics { contentDescription = label }
            .padding(end = 12.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val spend = listOfNotNull(usage.tokenSummary, usage.costSummary).joinToString("  ")
        if (spend.isNotEmpty()) {
            // At large font scales the spend gives way, so the context warning stays visible.
            Text(
                text = spend,
                style = style,
                color = appColors.secondaryLabel,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        usage.contextSummary?.let { context ->
            if (spend.isNotEmpty()) Spacer(Modifier.width(8.dp))
            Text(
                text = context,
                style = style,
                color = usage.contextTone?.let(appColors::tone) ?: appColors.secondaryLabel,
                maxLines = 1,
            )
        }
    }
}

/**
 * Everything behind the footer line, exact rather than abbreviated. Takes the
 * stream's current value, so it keeps up while pi is still working.
 */
@Composable
internal fun SessionUsageSheet(usage: SessionUsage?, onDismiss: () -> Unit) {
    AppSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag(SessionUsageTestTags.SHEET)) {
        Text(
            text = "Session usage",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp),
        )
        if (usage == null) {
            Text(
                text = "Usage appears once pi has replied.",
                color = appColors.secondaryLabel,
                modifier = Modifier.padding(24.dp),
            )
        } else {
            UsageBreakdown(usage)
        }
    }
}

@Composable
private fun UsageBreakdown(usage: SessionUsage) {
    Column(
        Modifier
            .verticalScroll(rememberScrollState())
            .padding(AppListPadding)
            .padding(bottom = 16.dp),
    ) {
        AppListSection(header = "Tokens") {
            row { UsageRow("Input", SessionUsage.exact(usage.inputTokens)) }
            row { UsageRow("Output", SessionUsage.exact(usage.outputTokens)) }
            row { UsageRow("Cache read", SessionUsage.exact(usage.cacheReadTokens)) }
            row { UsageRow("Cache write", SessionUsage.exact(usage.cacheWriteTokens)) }
            row { UsageRow("Total", SessionUsage.exact(usage.totalTokens)) }
        }
        Spacer(Modifier.height(12.dp))
        AppListSection {
            row { UsageRow("Estimated cost", SessionUsage.money(usage.cost)) }
            usage.contextDetail?.let { context ->
                row {
                    UsageRow(
                        label = "Context",
                        value = context,
                        color = usage.contextTone?.let(appColors::tone),
                    )
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        AppListSection(header = "Activity", footer = SessionUsage.FOOTNOTE) {
            row { UsageRow("Your messages", SessionUsage.exact(usage.userMessages)) }
            row { UsageRow("pi replies", SessionUsage.exact(usage.assistantMessages)) }
            row { UsageRow("Tool calls", SessionUsage.exact(usage.toolCalls)) }
        }
    }
}

@Composable
private fun UsageRow(label: String, value: String, color: Color? = null) {
    AppListTile(
        title = { Text(label) },
        // The list's trailing default is a caption; these numbers are the point of the sheet.
        trailing = {
            Text(
                text = value,
                style = MaterialTheme.typography.bodyLarge.copy(fontFeatureSettings = "tnum"),
                color = color ?: appColors.secondaryLabel,
            )
        },
        semanticsLabel = "$label, $value",
    )
}
