package com.pipod.app.features.common

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.pipod.app.core.api.model.BillingAlert
import com.pipod.app.core.api.model.BillingAlertTone
import com.pipod.app.core.api.model.BillingSummary
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.theme.appColors

/**
 * The one account row: plan, active hours, spend cap, trial — whichever of them
 * the server sent.
 *
 * **This is the edition boundary.** The SaaS backend sends `billing`; the
 * self-hosted static backend does not send it at all. When it is absent, or when
 * everything inside it was unreadable, this renders *nothing* — no placeholder,
 * no "unknown", no zeroes, no empty section header, no error, and no layout
 * space. The caller must also skip the list item entirely; the guard here is the
 * second lock, not the first.
 *
 * Every number shown is a number the server sent. Nothing is projected, and no
 * price or plan tier is named that did not arrive on the wire.
 */
@Composable
fun BillingSummaryRow(summary: BillingSummary?, modifier: Modifier = Modifier) {
    val segments = summary?.segments().orEmpty()
    val alert = summary?.alert
    if (segments.isEmpty() && alert == null) return
    val line = segments.joinToString(" · ")

    AppListSection(modifier = modifier.testTag(BillingSummaryTestTags.ROW)) {
        row {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp)
                    .semantics(mergeDescendants = true) {
                        contentDescription = listOfNotNull(
                            "Account",
                            alert?.message,
                            segments.joinToString(", ").takeIf { it.isNotEmpty() },
                        ).joinToString(", ")
                        // A blocked account arriving on a refresh is news, and
                        // the row is the only place it is said.
                        if (alert != null) liveRegion = LiveRegionMode.Polite
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = if (alert == null) AppIcons.person else AppIcons.warning,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = alert?.let { billingAlertColor(it) } ?: appColors.secondaryLabel,
                )
                Spacer(Modifier.width(10.dp))
                Column {
                    if (alert != null) {
                        Text(
                            text = alert.message,
                            style = MaterialTheme.typography.bodySmall,
                            color = billingAlertColor(alert),
                            modifier = Modifier.testTag(BillingSummaryTestTags.ALERT),
                        )
                        if (line.isNotEmpty()) Spacer(Modifier.height(2.dp))
                    }
                    if (line.isNotEmpty()) {
                        Text(
                            text = line,
                            style = MaterialTheme.typography.bodySmall,
                            color = appColors.secondaryLabel,
                        )
                    }
                }
            }
        }
    }
}

/** Blocked reads as a refusal; a warning is attention, not an error. */
@Composable
fun billingAlertColor(alert: BillingAlert): Color = when (alert.tone) {
    BillingAlertTone.Blocked -> appColors.destructive
    BillingAlertTone.Warning -> appColors.noticeText
}

/** The handle a UI test finds the account row by — and asserts the absence of. */
object BillingSummaryTestTags {
    const val ROW = "billing-summary-row"
    const val ALERT = "billing-summary-alert"
}
