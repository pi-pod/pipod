package com.pipod.app.features.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pipod.app.core.format.WorkstationCopy
import com.pipod.app.core.workstation.WorkstationWaitState
import com.pipod.app.core.workstation.WorkstationWaitStatus
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonContent
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.theme.appColors

/**
 * The personal workstation's own state, wherever a screen can hit it.
 *
 * Deliberately unlike both neighbours it could be mistaken for:
 *
 * - **not** the "pod asleep" state — a pod wakes on a keystroke in seconds; a
 *   workstation is a whole VM whose measured start is minutes, so there is no
 *   "send a message to wake it" here and no bedtime glyph;
 * - **not** the fleet capacity wait — that is other people's pressure on a
 *   shared fleet with a server-sent countdown. This is the reader's own machine,
 *   it names no fleet, and it counts *up* from a measured start rather than down
 *   to a number nobody promised.
 *
 * Cancel says what it really does: waiting stops here, the workstation keeps
 * starting, the files are retained. Nothing on this card says anything was lost
 * or suggests launching a duplicate.
 *
 * @param onCancel ends this app's wait. Omitted where there is no wait to end.
 * @param onRetry re-issues the original request, for a wait that is over. It is
 *   deliberately not drawn while one is running: the wait is already re-issuing
 *   the request on its own schedule, so the button could only either do nothing
 *   or throw the elapsed reading away and start again from zero — and the one
 *   thing a reader can usefully decide mid-wait is Cancel, which is beside it.
 */
@Composable
fun WorkstationWaitCard(
    state: WorkstationWaitState,
    modifier: Modifier = Modifier,
    onCancel: (() -> Unit)? = null,
    onRetry: (() -> Unit)? = null,
) {
    val waiting = state.status == WorkstationWaitStatus.Waiting
    val headline = WorkstationCopy.headline(state)
    val elapsed = if (waiting) WorkstationCopy.waiting(state.elapsedMs) else null
    val technical = if (waiting) WorkstationCopy.technicalDetail(state.demand) else null
    val tint = when (state.status) {
        WorkstationWaitStatus.Waiting -> appColors.noticeText
        WorkstationWaitStatus.Terminal -> appColors.secondaryLabel
        WorkstationWaitStatus.Expired, WorkstationWaitStatus.Cancelled -> appColors.secondaryLabel
    }

    AppListSection(modifier = modifier.testTag(WorkstationWaitTestTags.CARD)) {
        row {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(appColors.noticeFill)
                    .padding(16.dp),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics(mergeDescendants = true) {
                            contentDescription = listOfNotNull(
                                WorkstationCopy.TITLE,
                                headline,
                                elapsed,
                                technical,
                            ).joinToString(", ")
                            liveRegion = LiveRegionMode.Polite
                        },
                    verticalAlignment = Alignment.Top,
                ) {
                    if (waiting) {
                        AppActivityIndicator(size = 20.dp)
                    } else {
                        Icon(
                            imageVector = AppIcons.info,
                            contentDescription = null,
                            modifier = Modifier.size(20.dp),
                            tint = tint,
                        )
                    }
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.fillMaxWidth()) {
                        Text(
                            text = WorkstationCopy.TITLE,
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.SemiBold,
                            color = tint,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(text = headline)
                        if (elapsed != null) {
                            Spacer(Modifier.height(6.dp))
                            Text(
                                text = elapsed,
                                style = MaterialTheme.typography.bodySmall,
                                color = appColors.secondaryLabel,
                                modifier = Modifier.testTag(WorkstationWaitTestTags.ELAPSED),
                            )
                        }
                        if (technical != null) {
                            Spacer(Modifier.height(2.dp))
                            Text(
                                text = technical,
                                style = MaterialTheme.typography.labelMedium,
                                color = appColors.tertiaryLabel,
                                modifier = Modifier.testTag(WorkstationWaitTestTags.PHASE),
                            )
                        }
                    }
                }

                if (waiting && onCancel != null) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        text = WorkstationCopy.CANCEL_EXPLANATION,
                        style = MaterialTheme.typography.bodySmall,
                        color = appColors.secondaryLabel,
                    )
                }

                val actions = buildList<@Composable () -> Unit> {
                    if (waiting && onCancel != null) {
                        add {
                            AppButton(
                                onClick = onCancel,
                                kind = AppButtonKind.Plain,
                                semanticsLabel = "Stop waiting for the workstation",
                                modifier = Modifier.testTag(WorkstationWaitTestTags.CANCEL),
                            ) {
                                AppButtonContent(
                                    icon = AppIcons.close,
                                    label = WorkstationCopy.CANCEL_ACTION,
                                )
                            }
                        }
                    }
                    if (onRetry != null && !waiting) {
                        add {
                            AppButton(
                                onClick = onRetry,
                                kind = AppButtonKind.Tinted,
                                semanticsLabel = "Try the workstation again now",
                                modifier = Modifier.testTag(WorkstationWaitTestTags.RETRY),
                            ) {
                                AppButtonContent(
                                    icon = AppIcons.refresh,
                                    label = WorkstationCopy.RETRY_ACTION,
                                )
                            }
                        }
                    }
                }
                if (actions.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        actions.forEach { it() }
                    }
                }
            }
        }
    }
}

/** The handles a UI test finds this card's parts by. */
object WorkstationWaitTestTags {
    const val CARD = "workstation-wait-card"
    const val ELAPSED = "workstation-wait-elapsed"
    const val PHASE = "workstation-wait-phase"
    const val CANCEL = "workstation-wait-cancel"
    const val RETRY = "workstation-wait-retry"
}
