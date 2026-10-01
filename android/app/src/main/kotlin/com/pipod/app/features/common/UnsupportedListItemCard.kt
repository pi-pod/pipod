package com.pipod.app.features.common

import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.pipod.app.core.api.model.UnparsedRow
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppSectionStyle
import com.pipod.app.ui.theme.appColors

/**
 * The placeholder for a row this build could not read.
 *
 * Ported from `pi-pod-flutter/lib/features/common/unsupported_list_item_card.dart`.
 * One unreadable pod must not blank the pod list: a server that adds a field
 * shape this build does not know costs that row, not the screen.
 */
@Composable
fun UnsupportedListItemCard(modifier: Modifier = Modifier, itemName: String = "item") {
    AppListSection(modifier = modifier.testTag("unsupported-list-item"), style = AppSectionStyle.Separated) {
        row {
            AppListTile(
                title = { Text("This app can’t display this $itemName.") },
                leading = {
                    Icon(
                        imageVector = AppIcons.unknown,
                        contentDescription = null,
                        tint = appColors.secondaryLabel,
                    )
                },
            )
        }
    }
}

/**
 * One placeholder per row a decode dropped, which is what a list screen renders
 * after `decodeListRows` hands back [UnparsedRow]s.
 */
@Composable
fun UnsupportedListItemCards(
    rows: List<UnparsedRow>,
    modifier: Modifier = Modifier,
    itemName: String = "item",
) {
    rows.forEach { _ -> UnsupportedListItemCard(modifier = modifier, itemName = itemName) }
}
