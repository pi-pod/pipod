package com.pipod.app.features.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pipod.app.core.session.SlashCommand
import com.pipod.app.core.session.SlashCommandDraftEvaluation
import com.pipod.app.core.session.SlashCommandSource
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors

/** Test handles for slash-command palette and validation surfaces. */
object SlashCommandTestTags {
    const val PALETTE = "composer-slash-palette"
    const val STATUS_VALID = "composer-slash-status-valid"
    const val STATUS_BLOCKED = "composer-slash-status-blocked"
    const val STATUS_UNKNOWN = "composer-slash-status-unknown"
    const val TOGGLE_BUTTON = "composer-slash-toggle"

    fun option(name: String) = "composer-slash-option-$name"
}

/**
 * Floating slash-command picker shown directly above the composer when typing
 * `/` or opening the command list. Tapping a row fills the composer rather than
 * sending immediately, so the user can review arguments or confirm.
 */
@Composable
fun SlashCommandPalette(
    commands: List<SlashCommand>,
    isLoadingPodCommands: Boolean,
    onSelect: (SlashCommand) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = appColors
    val shape = RoundedCornerShape(12.dp)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = 4.dp)
            .clip(shape)
            .background(colors.card, shape)
            .border(1.dp, colors.separator, shape)
            .testTag(SlashCommandTestTags.PALETTE),
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 220.dp),
        ) {
            itemsIndexed(commands, key = { _, cmd -> cmd.name }) { index, command ->
                if (index > 0) {
                    HorizontalDivider(
                        modifier = Modifier.padding(start = 12.dp),
                        color = colors.separator.copy(alpha = 0.6f),
                    )
                }
                SlashCommandRow(command = command, onClick = { onSelect(command) })
            }
        }
        if (isLoadingPodCommands) {
            HorizontalDivider(color = colors.separator.copy(alpha = 0.6f))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AppActivityIndicator(size = 12.dp)
                Text(
                    text = "Loading pod commands…",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.secondaryLabel,
                )
            }
        }
    }
}

@Composable
private fun SlashCommandRow(
    command: SlashCommand,
    onClick: () -> Unit,
) {
    val colors = appColors
    val label = "${command.displayName}, ${command.source.badgeLabel}, ${command.description}"
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 9.dp)
            .testTag(SlashCommandTestTags.option(command.name))
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
            },
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = command.displayName,
                style = MonospaceTextStyle.copy(
                    fontSize = MaterialTheme.typography.bodyMedium.fontSize,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = colors.accent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (command.argumentHint != null) {
                Text(
                    text = command.argumentHint,
                    style = MonospaceTextStyle.copy(
                        fontSize = MaterialTheme.typography.labelSmall.fontSize,
                    ),
                    color = colors.tertiaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.weight(1f))
            SlashSourceBadge(source = command.source)
        }
        Text(
            text = command.description,
            style = MaterialTheme.typography.bodySmall,
            color = colors.secondaryLabel,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Compact validation strip directly above the text field that confirms whether
 * the typed slash command is valid, what it will do, or why it cannot run.
 */
@Composable
fun SlashCommandStatusBar(
    evaluation: SlashCommandDraftEvaluation,
    modifier: Modifier = Modifier,
) {
    val colors = appColors
    val shape = RoundedCornerShape(10.dp)
    when (evaluation) {
        is SlashCommandDraftEvaluation.Valid -> {
            val warning = evaluation.warning
            val toneColor = when {
                warning == null -> colors.success
                evaluation.canExecute -> colors.warning
                else -> colors.destructive
            }
            val fillColor = when {
                warning == null -> colors.fill.copy(alpha = 0.75f)
                evaluation.canExecute -> colors.warning.copy(alpha = 0.12f)
                else -> colors.destructive.copy(alpha = 0.10f)
            }
            val icon = if (warning == null) AppIcons.success else AppIcons.warning
            val detailText = warning ?: evaluation.actionSummary
            val description = "${evaluation.command.displayName}, ${evaluation.command.source.badgeLabel}, $detailText"

            Row(
                modifier = modifier
                    .fillMaxWidth()
                    .padding(bottom = 4.dp)
                    .background(fillColor, shape)
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .testTag(
                        if (evaluation.canExecute) {
                            SlashCommandTestTags.STATUS_VALID
                        } else {
                            SlashCommandTestTags.STATUS_BLOCKED
                        },
                    )
                    .clearAndSetSemantics { contentDescription = description },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    tint = toneColor,
                    modifier = Modifier.size(16.dp),
                )
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            text = evaluation.command.displayName,
                            style = MonospaceTextStyle.copy(
                                fontSize = MaterialTheme.typography.labelMedium.fontSize,
                                fontWeight = FontWeight.SemiBold,
                            ),
                            color = colors.label,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        SlashSourceBadge(source = evaluation.command.source)
                    }
                    Text(
                        text = detailText,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (warning != null && !evaluation.canExecute) {
                            colors.destructive
                        } else {
                            colors.secondaryLabel
                        },
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }

        is SlashCommandDraftEvaluation.Unknown -> {
            val message = when {
                evaluation.isLoadingCatalog -> "Checking /${evaluation.name} against pod commands…"
                !evaluation.isConnected -> "/${evaluation.name} isn’t a built-in command — pod commands load once connected."
                else -> "Unknown command /${evaluation.name} — check the spelling or pick a command."
            }
            val toneColor = when {
                evaluation.isLoadingCatalog -> colors.secondaryLabel
                evaluation.isConnected -> colors.destructive
                else -> colors.warning
            }
            val fillColor = when {
                evaluation.isLoadingCatalog -> colors.fill.copy(alpha = 0.6f)
                evaluation.isConnected -> colors.destructive.copy(alpha = 0.10f)
                else -> colors.warning.copy(alpha = 0.12f)
            }

            Row(
                modifier = modifier
                    .fillMaxWidth()
                    .padding(bottom = 4.dp)
                    .background(fillColor, shape)
                    .padding(horizontal = 10.dp, vertical = 6.dp)
                    .testTag(SlashCommandTestTags.STATUS_UNKNOWN)
                    .clearAndSetSemantics { contentDescription = message },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (evaluation.isLoadingCatalog) {
                    AppActivityIndicator(size = 14.dp)
                } else {
                    Icon(
                        imageVector = AppIcons.warning,
                        contentDescription = null,
                        tint = toneColor,
                        modifier = Modifier.size(16.dp),
                    )
                }
                Text(
                    text = message,
                    style = MaterialTheme.typography.labelSmall,
                    color = toneColor,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        SlashCommandDraftEvaluation.None, is SlashCommandDraftEvaluation.Browsing -> Unit
    }
}

@Composable
private fun SlashSourceBadge(source: SlashCommandSource) {
    val colors = appColors
    Box(
        modifier = Modifier
            .background(colors.fill, CircleShape)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Text(
            text = source.badgeLabel,
            style = MaterialTheme.typography.labelSmall,
            color = colors.secondaryLabel,
        )
    }
}
