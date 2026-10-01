package com.pipod.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pipod.app.ui.theme.appColors

/** How the items in a section relate to each other. */
enum class AppSectionStyle {
    /** One block of related rows under a shared header, hairline-separated. */
    Grouped,

    /** Independent items, each standing on its own card with space between. */
    Separated,
}

/**
 * Declares the rows of an [AppListSection].
 *
 * A slot API cannot see where one row ends and the next begins, and the
 * separators between rows are exactly that boundary — so rows are declared,
 * the way `LazyListScope.item` declares them, rather than emitted straight
 * into a column.
 */
class AppListSectionScope internal constructor() {
    internal val entries = mutableListOf<@Composable () -> Unit>()

    fun row(content: @Composable () -> Unit) {
        entries += content
    }

    /** Declares one row per element, for a section built from data. */
    fun <T> items(items: List<T>, content: @Composable (T) -> Unit) {
        items.forEach { item -> row { content(item) } }
    }
}

/**
 * A group of rows, ported from `pi-pod-flutter/lib/ui/app_list.dart`.
 *
 * An empty section renders nothing at all — not an empty card and not its
 * header — so a screen can declare a section for data that may not have
 * arrived without guarding every call site.
 */
@Composable
fun AppListSection(
    modifier: Modifier = Modifier,
    header: String? = null,
    footer: String? = null,
    style: AppSectionStyle = AppSectionStyle.Grouped,
    content: AppListSectionScope.() -> Unit,
) {
    val scope = AppListSectionScope().apply(content)
    if (scope.entries.isEmpty()) return

    Column(modifier = modifier.fillMaxWidth()) {
        if (header != null) SectionCaption(text = header, isHeader = true)
        when (style) {
            AppSectionStyle.Separated -> scope.entries.forEach { row ->
                Column(Modifier.padding(vertical = 4.dp)) {
                    SectionBlock { row() }
                }
            }

            AppSectionStyle.Grouped -> SectionBlock {
                scope.entries.forEachIndexed { index, row ->
                    if (index > 0) {
                        HorizontalDivider(
                            modifier = Modifier.padding(start = 16.dp),
                            thickness = 1.dp,
                            color = appColors.separator,
                        )
                    }
                    row()
                }
            }
        }
        if (footer != null) SectionCaption(text = footer, isHeader = false)
    }
}

/** The card every block of rows sits on. */
@Composable
private fun SectionBlock(content: @Composable () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = appColors.card),
    ) {
        Column(Modifier.fillMaxWidth()) { content() }
    }
}

/**
 * A section's header or footer line.
 *
 * Kept in the sentence case it was written in: upper-casing here would also
 * change the string a screen reader announces. A header is exposed as a
 * heading carrying exactly this text, so assistive technology can jump between
 * sections instead of merging a whole section into one node.
 */
@Composable
private fun SectionCaption(text: String, isHeader: Boolean) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall.copy(
            fontWeight = if (isHeader) FontWeight.SemiBold else FontWeight.Normal,
        ),
        color = appColors.secondaryLabel,
        modifier = Modifier
            .padding(
                start = 16.dp,
                end = 16.dp,
                top = if (isHeader) 16.dp else 6.dp,
                bottom = if (isHeader) 6.dp else 16.dp,
            )
            .then(if (isHeader) Modifier.semantics { heading() } else Modifier),
    )
}

/**
 * One row of a section.
 *
 * @param additionalInfo the short value printed in grey before the chevron,
 *   such as a status or a count. Material folds it into the trailing slot.
 * @param showChevron whether tapping the row opens another screen, which is
 *   marked rather than left implicit.
 * @param backgroundColor a tint for a row that stands out from its section,
 *   such as one asking to be acted on. Set here rather than by wrapping, so
 *   the row still paints its own pressed state over it.
 * @param semanticsLabel replaces the row's accessible name — for a disclosure
 *   row whose name carries its expanded state, say. Setting it here rather
 *   than wrapping keeps the row at one node.
 * @param semanticsExpanded announced alongside [semanticsLabel] as the row's
 *   state, for a disclosure row.
 */
@Composable
fun AppListTile(
    title: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: (@Composable () -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    additionalInfo: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    showChevron: Boolean = false,
    backgroundColor: Color? = null,
    selected: Boolean = false,
    enabled: Boolean = true,
    semanticsLabel: String? = null,
    semanticsExpanded: Boolean? = null,
) {
    val activate = if (enabled) onClick else null
    val end: (@Composable () -> Unit)? = trailing ?: additionalInfo ?: if (showChevron) {
        {
            Icon(
                imageVector = AppIcons.chevron,
                contentDescription = null,
                tint = appColors.tertiaryLabel,
            )
        }
    } else {
        null
    }

    ListItem(
        headlineContent = title,
        modifier = modifier
            .then(
                if (activate == null) {
                    Modifier
                } else {
                    Modifier.clickable(role = Role.Button, onClick = activate)
                },
            )
            .semantics {
                if (semanticsLabel != null) contentDescription = semanticsLabel
                if (semanticsExpanded != null) {
                    stateDescription = if (semanticsExpanded) "Expanded" else "Collapsed"
                }
                if (selected) this.selected = true
            },
        supportingContent = subtitle,
        leadingContent = leading,
        trailingContent = end,
        colors = ListItemDefaults.colors(
            containerColor = backgroundColor ?: appColors.card,
        ),
    )
}

/**
 * The padding a screen puts around a stack of sections.
 *
 * A grouped list is inset from the screen edge; a row's own 16dp is horizontal
 * padding inside the card, not a margin around it.
 */
val AppListPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)

/** Test handle for the scrolling container a list screen builds. */
const val AppListTestTag = "app-list"

/** Applies [AppListTestTag], so a UI test can find the list without a title. */
fun Modifier.appListTestTag(): Modifier = this.testTag(AppListTestTag)
