package com.pipod.app.features.session

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.format.Format
import com.pipod.app.core.format.MessageChrome
import com.pipod.app.core.session.ChatAttachmentLimits
import com.pipod.app.core.session.InteractionPresentation
import com.pipod.app.core.session.StreamImageAttachment
import com.pipod.app.core.session.StreamItem
import com.pipod.app.core.session.StreamItemDelivery
import com.pipod.app.core.session.StreamItemStyle
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppButtonSize
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppPillButton
import com.pipod.app.ui.AppSelectableText
import com.pipod.app.ui.AppSelectionScope
import com.pipod.app.ui.rememberThumbnail
import com.pipod.app.ui.LocalAppToastHost
import com.pipod.app.ui.showAppToast
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/**
 * The row widgets a chat transcript is assembled from, ported from
 * `pi-pod-flutter/lib/features/session/transcript_widgets.dart`.
 *
 * Every one of them is a pure function of its arguments: expansion lives on the
 * session stream, drafts live in the composer, and nothing here reaches for a
 * store. That is what lets a UI test build any row — a failed send, a nine-call
 * tool run, a stale approval — without a server.
 */

/**
 * A conversation stays readable at roughly 60 characters a line; a wide window
 * is wide enough to run well past that without a cap.
 */
val TranscriptMeasure: Dp = 560.dp

/** Test handles the acceptance pass addresses these rows by. */
object TranscriptTestTags {
    const val DAY_SEPARATOR = "transcript-day-separator"
    const val TYPING_INDICATOR = "transcript-typing-indicator"
    const val JUMP_TO_LATEST = "jump-to-latest"
    const val EMPTY_STATE = "transcript-empty-state"
    const val RETRY = "transcript-row-retry"
    const val DISCARD = "transcript-row-discard"

    fun row(id: String) = "transcript-row-$id"

    fun suggestion(index: Int) = "transcript-suggestion-$index"

    fun tools(id: String) = "transcript-tools-$id"

    fun toolDetail(id: String) = "transcript-tool-detail-$id"

    fun approvalCard(id: String) = "approval-card-$id"

    const val APPROVAL_DETAILS = "approval-card-details"
    const val APPROVAL_DISMISS = "approval-card-dismiss"
}

/**
 * Day header between clusters of a long conversation. Chat apps use this so a
 * week-old transcript is scannable without a timestamp on every bubble.
 */
@Composable
fun DaySeparator(title: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            // The tag is declared before the clearing modifier: a semantics
            // property set after one is discarded when the node's config is
            // collapsed.
            .testTag(TranscriptTestTags.DAY_SEPARATOR)
            // One node: the visible label must not be announced twice.
            .clearAndSetSemantics {
                contentDescription = title
                heading()
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
            color = appColors.secondaryLabel,
            modifier = Modifier
                .background(appColors.fill.copy(alpha = 0.6f), CircleShape)
                .padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

/**
 * Lives at the end of the transcript, next to the last turn — the same place
 * iMessage puts a typing indicator. A top-of-screen "pi is working" banner is
 * too far from the conversation it describes.
 *
 * @param label a pod extension can rename the working state through a remote-UI
 *   control frame; the app's own wording is the default.
 */
@Composable
fun TypingIndicator(label: String? = null, modifier: Modifier = Modifier) {
    val text = label?.trim()?.takeIf { it.isNotEmpty() } ?: "pi is working…"
    Row(
        modifier = modifier
            .padding(horizontal = 4.dp, vertical = 4.dp)
            .testTag(TranscriptTestTags.TYPING_INDICATOR)
            .clearAndSetSemantics { contentDescription = text },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AppActivityIndicator(size = 14.dp)
        Spacer(Modifier.width(8.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            color = appColors.secondaryLabel,
        )
    }
}

/**
 * Compact jump control that also reports what arrived while the user was
 * reading further up — scrolling away from the bottom should not hide the fact
 * that the conversation moved on.
 */
@Composable
fun JumpToLatestButton(newMessageCount: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val hasNew = newMessageCount > 0
    Box(modifier.padding(end = 16.dp, bottom = 10.dp)) {
        AppPillButton(
            onClick = onClick,
            semanticsLabel = if (hasNew) {
                "$newMessageCount new messages. Scroll to latest"
            } else {
                "Scroll to latest messages"
            },
            modifier = Modifier.testTag(TranscriptTestTags.JUMP_TO_LATEST),
        ) {
            Row(
                modifier = Modifier.padding(horizontal = if (hasNew) 12.dp else 0.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(AppIcons.expand, contentDescription = null, modifier = Modifier.size(18.dp))
                if (hasNew) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = "$newMessageCount new",
                        style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                    )
                }
            }
        }
    }
}

/**
 * What an empty conversation offers. Tapping one of these only fills the
 * composer — a suggestion that fires a model turn spends money the user has not
 * confirmed.
 */
val ConversationSuggestions: List<String> = listOf(
    "What's in this workspace?",
    "Summarize recent changes",
    "Help me fix a bug",
)

/** Empty conversation: explain what to do, and offer chips that only fill the composer. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ConversationEmptyState(onChooseSuggestion: (String) -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 12.dp)
            .testTag(TranscriptTestTags.EMPTY_STATE),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = AppIcons.conversation,
            contentDescription = null,
            tint = appColors.secondaryLabel,
            modifier = Modifier.size(AppButtonDefaults.MinTouchTarget),
        )
        Spacer(Modifier.height(10.dp))
        Text("Start a conversation", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Text(
            text = "Tell pi what you want to do in this pod.",
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodyMedium,
            color = appColors.secondaryLabel,
        )
        Spacer(Modifier.height(18.dp))
        FlowRow(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ConversationSuggestions.forEachIndexed { index, suggestion ->
                AppButton(
                    text = suggestion,
                    onClick = { onChooseSuggestion(suggestion) },
                    kind = AppButtonKind.Tinted,
                    semanticsLabel = suggestion,
                    modifier = Modifier.testTag(TranscriptTestTags.suggestion(index)),
                )
            }
        }
    }
}

/** One transcript row: a status line, a user bubble or an assistant block. */
@Composable
fun EventRow(
    item: StreamItem,
    modifier: Modifier = Modifier,
    chrome: MessageChrome = MessageChrome.STANDALONE,
    thinkingLabel: String? = null,
    onRetry: () -> Unit = {},
    onDiscard: () -> Unit = {},
) {
    val timeLabel = item.timestamp?.let { Format.transcriptTime(it) }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = if (chrome.isContinuation) 0.dp else 8.dp)
            .testTag(TranscriptTestTags.row(item.id)),
    ) {
        when (item.style) {
            StreamItemStyle.STATUS, StreamItemStyle.TOOL -> StatusLine(item)
            StreamItemStyle.USER -> UserBubble(item, chrome, timeLabel, onRetry, onDiscard)
            StreamItemStyle.ASSISTANT -> AssistantBlock(item, chrome, timeLabel, thinkingLabel)
        }
    }
}

@Composable
private fun StatusLine(item: StreamItem) {
    Text(
        text = item.text,
        textAlign = TextAlign.Center,
        style = MaterialTheme.typography.bodySmall,
        color = appColors.secondaryLabel,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            // One node: without this the status text is announced twice.
            .clearAndSetSemantics { contentDescription = item.text },
    )
}

@Composable
private fun UserBubble(
    item: StreamItem,
    chrome: MessageChrome,
    timeLabel: String?,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
) {
    val colors = appColors
    val showsMeta = chrome.showsSender || (chrome.showsTimestamp && timeLabel != null)
    val copy = rememberCopyAction(item.text)
    val bubbleShape = RoundedCornerShape(
        topStart = 18.dp,
        bottomStart = 18.dp,
        // Outgoing bubbles tuck the trailing-bottom corner so grouped follow-ups
        // read as one stack instead of a pile of identical cards.
        bottomEnd = if (chrome.isContinuation) 18.dp else 6.dp,
        topEnd = if (chrome.isContinuation) 6.dp else 18.dp,
    )
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Column(
            modifier = Modifier.widthIn(max = TranscriptMeasure).padding(start = 56.dp),
            horizontalAlignment = Alignment.End,
        ) {
            // The bubble is named as a whole; the delivery footer stays outside
            // it so a Retry the sighted user can tap is not merged away. The
            // node does not merge its descendants, matching the Dart's
            // `Semantics(container: true)` without `excludeSemantics`: the
            // attachment strip keeps a name of its own.
            //
            // One selection scope for the whole message, and no long-press
            // gesture over it: a `detectTapGestures(onLongPress = ...)` above a
            // SelectionContainer wins the same gesture selection starts with,
            // so the two cannot both be here. Copy stays reachable as the
            // platform's own selection toolbar and as the named action below.
            AppSelectionScope {
                Column(
                    modifier = Modifier.semantics(mergeDescendants = false) {
                        contentDescription = transcriptAccessibilityText(item, "You", timeLabel)
                        customActions = listOf(
                            CustomAccessibilityAction("Copy message") {
                                copy()
                                true
                            },
                        )
                    },
                    horizontalAlignment = Alignment.End,
                ) {
                    if (showsMeta) MetaRow(item, chrome, "You", timeLabel, Arrangement.End)
                    if (item.attachments.isNotEmpty()) {
                        AttachmentThumbs(item.attachments, bottomGap = item.text.isNotEmpty())
                    }
                    if (item.text.isNotEmpty()) {
                    // Contrast: the bubble text always names its own colour.
                    // The default bodyLarge inherits onSurface (near-black),
                    // which is unreadable on the opaque purple accent — hence
                    // onAccent. Error text is destructive on a destructive
                    // wash. Pending/sending keeps the same opaque accent: the
                    // DeliveryFooter below the bubble ("Sending…", "Waiting
                    // for connection", "Saved — sends when the pod is
                    // ready") already conveys the state, so fading the
                    // background would only wash white text into lilac.
                        AppSelectableText(
                            text = item.text,
                            style = MaterialTheme.typography.bodyLarge.copy(
                                color = if (item.isError) colors.destructive else colors.onAccent,
                            ),
                            modifier = Modifier
                                .background(
                                    color = if (item.isError) {
                                        colors.destructive.copy(alpha = 0.12f)
                                    } else {
                                        colors.accent
                                    },
                                    shape = bubbleShape,
                                )
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
            }
            DeliveryFooter(item, onRetry, onDiscard)
        }
    }
}

@Composable
private fun AssistantBlock(
    item: StreamItem,
    chrome: MessageChrome,
    timeLabel: String?,
    thinkingLabel: String?,
) {
    val colors = appColors
    val showsMeta = chrome.showsSender || (chrome.showsTimestamp && timeLabel != null)
    val copy = rememberCopyAction(item.text)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
        // One selection scope per reply, so a drag runs from a heading through
        // the paragraph and the bullet under it. See the note in [UserBubble]
        // for why there is no long-press gesture over it.
        AppSelectionScope {
            Column(
                modifier = Modifier
                    .widthIn(max = TranscriptMeasure)
                    .padding(end = 20.dp)
                    .semantics(mergeDescendants = false) {
                        contentDescription = transcriptAccessibilityText(item, "pi", timeLabel)
                        customActions = listOf(
                            CustomAccessibilityAction("Copy message") {
                                copy()
                                true
                            },
                        )
                    },
            ) {
                if (showsMeta) MetaRow(item, chrome, "pi", timeLabel, Arrangement.Start)
                when {
                    item.isInProgress && item.text.isBlank() -> Row(
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AppActivityIndicator(size = 14.dp)
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text = thinkingLabel?.trim()?.takeIf { it.isNotEmpty() } ?: "Thinking…",
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.secondaryLabel,
                        )
                    }

                    item.isError -> AppSelectableText(
                        text = item.text,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(
                                colors.destructive.copy(alpha = 0.08f),
                                RoundedCornerShape(12.dp),
                            )
                            .padding(10.dp),
                    )

                    else -> MarkdownText(text = item.text)
                }
            }
        }
    }
}

@Composable
private fun MetaRow(
    item: StreamItem,
    chrome: MessageChrome,
    sender: String,
    timeLabel: String?,
    arrangement: Arrangement.Horizontal,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = arrangement,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (chrome.showsSender) {
            Text(
                text = sender,
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                color = appColors.secondaryLabel,
            )
        }
        if (item.isError) {
            Spacer(Modifier.width(6.dp))
            Icon(
                imageVector = AppIcons.warningOutline,
                contentDescription = null,
                tint = appColors.destructive,
                modifier = Modifier.size(12.dp),
            )
        }
        if (chrome.showsTimestamp && timeLabel != null) {
            Spacer(Modifier.width(6.dp))
            Text(
                text = timeLabel,
                style = MaterialTheme.typography.labelSmall,
                color = appColors.secondaryLabel,
            )
        }
    }
}

/**
 * Thumbnails of the images that rode along with this turn. Read-only: removal
 * happens in the composer before sending, never after. Descriptor placeholders
 * (history rows whose bytes never left the pod) render as size tiles instead of
 * attempting a decode.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AttachmentThumbs(attachments: List<StreamImageAttachment>, bottomGap: Boolean) {
    val count = attachments.size
    FlowRow(
        modifier = Modifier
            .padding(bottom = if (bottomGap) 6.dp else 0.dp)
            .semantics(mergeDescendants = false) {
                contentDescription = if (count == 1) {
                    "1 image attached, ${attachments.first().name}"
                } else {
                    "$count images attached"
                }
            },
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        attachments.forEach { attachment ->
            if (attachment.isPlaceholder) PlaceholderThumb(attachment) else ImageThumb(attachment)
        }
    }
}

@Composable
private fun ImageThumb(attachment: StreamImageAttachment) {
    // Subsampled off the composition thread and kept against the attachment's
    // id: a transcript row is recomposed on every streaming delta, and a
    // full-resolution decode per delta is what makes a long turn stutter.
    // A replayed history row carries no id, so the byte array's own identity
    // stands in: it is stable for as long as the row is, and two rows never
    // share one array.
    val key = remember(attachment) {
        attachment.id.ifEmpty { "replayed-${System.identityHashCode(attachment.bytes)}" }
    }
    val thumbnail by rememberThumbnail(
        id = key,
        bytes = attachment.bytes,
        size = TranscriptThumbSize,
    )
    val bitmap = thumbnail
    Box(
        modifier = Modifier
            .size(TranscriptThumbSize)
            .border(1.dp, appColors.separator, RoundedCornerShape(10.dp))
            .padding(1.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap == null) {
            Icon(
                imageVector = AppIcons.attach,
                contentDescription = null,
                tint = appColors.secondaryLabel,
                modifier = Modifier.size(24.dp),
            )
        } else {
            Image(
                bitmap = bitmap,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(TranscriptThumbSize - 2.dp),
            )
        }
    }
}

/** How big a transcript thumbnail is drawn, and therefore how big it is decoded. */
private val TranscriptThumbSize = 72.dp

/**
 * A history image whose bytes never left the pod: icon plus the size the server
 * reported, so an older turn still reads as carrying pictures.
 */
@Composable
private fun PlaceholderThumb(attachment: StreamImageAttachment) {
    val size = ChatAttachmentLimits.describeBytes(attachment.sizeBytes.toLong())
    Column(
        modifier = Modifier
            .size(72.dp)
            .background(appColors.fill.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
            .border(1.dp, appColors.separator, RoundedCornerShape(10.dp))
            .semantics(mergeDescendants = true) {
                contentDescription = "${attachment.name}, $size, sent earlier"
            },
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = AppIcons.attach,
            contentDescription = null,
            tint = appColors.secondaryLabel,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.height(2.dp))
        Text(
            text = size,
            maxLines = 1,
            style = MaterialTheme.typography.labelSmall,
            color = appColors.secondaryLabel,
        )
    }
}

/**
 * Undelivered work is reported on the message it belongs to, with the recovery
 * next to it — a banner elsewhere on screen cannot say *which* message is stuck.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DeliveryFooter(item: StreamItem, onRetry: () -> Unit, onDiscard: () -> Unit) {
    when (item.delivery) {
        StreamItemDelivery.DELIVERED -> Unit
        StreamItemDelivery.SENDING -> DeliveryLabel("Sending…", AppIcons.submit)
        StreamItemDelivery.WAITING_FOR_CONNECTION ->
            DeliveryLabel("Waiting for connection", AppIcons.schedule)

        StreamItemDelivery.SAVED_ON_SERVER ->
            DeliveryLabel("Saved — sends when the pod is ready", AppIcons.successOutline)

        // Wraps rather than a Row: "Not delivered" plus both recoveries do not
        // fit beside a bubble's 56dp gutter on a narrow phone, and the recovery
        // for a stuck message is the last thing that should be clipped away.
        StreamItemDelivery.FAILED -> FlowRow(
            modifier = Modifier.fillMaxWidth().padding(top = 1.dp),
            horizontalArrangement = Arrangement.End,
            verticalArrangement = Arrangement.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = AppIcons.errorOutline,
                    contentDescription = null,
                    tint = appColors.noticeText,
                    modifier = Modifier.size(13.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = "Not delivered",
                    style = MaterialTheme.typography.labelSmall,
                    color = appColors.noticeText,
                )
                Spacer(Modifier.width(10.dp))
            }
            AppButton(
                text = "Retry",
                onClick = onRetry,
                kind = AppButtonKind.Plain,
                size = AppButtonSize.Small,
                semanticsLabel = "Send this message again",
                modifier = Modifier.testTag(TranscriptTestTags.RETRY),
            )
            AppButton(
                text = "Delete",
                onClick = onDiscard,
                kind = AppButtonKind.Plain,
                size = AppButtonSize.Small,
                destructive = true,
                semanticsLabel = "Delete this undelivered message",
                modifier = Modifier.testTag(TranscriptTestTags.DISCARD),
            )
        }
    }
}

@Composable
private fun DeliveryLabel(text: String, icon: ImageVector) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = appColors.secondaryLabel,
            modifier = Modifier.size(12.dp),
        )
        Spacer(Modifier.width(4.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = appColors.secondaryLabel,
        )
    }
}

/**
 * One run of tool calls, collapsed into a single line. A turn that reads six
 * files and runs three commands is nine full-width cards otherwise, and the
 * prose the user actually came for scrolls off the top.
 *
 * @param isExpanded expansion lives on the stream, keyed by id, so recycling
 *   this card does not silently collapse it.
 */
@Composable
fun ToolActivityCard(
    items: List<StreamItem>,
    isExpanded: (String) -> Boolean,
    onExpandedChanged: (String, Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val groupId = toolActivityGroupId(items)
    val expanded = isExpanded(groupId)
    val hasDetails = items.any { it.text.isNotEmpty() }
    val failureCount = items.count { it.isError }
    val label = toolActivityLabel(items)
    val summary = toolActivitySummary(items)
    val toggle = { onExpandedChanged(groupId, !expanded) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .background(appColors.fill.copy(alpha = 0.45f), RoundedCornerShape(12.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp)
            .testTag(TranscriptTestTags.tools(items.firstOrNull()?.id.orEmpty())),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = AppButtonDefaults.MinTouchTarget)
                .clickable(enabled = hasDetails, onClick = toggle)
                .clearAndSetSemantics {
                    contentDescription = label
                    role = Role.Button
                    if (hasDetails) {
                        stateDescription = if (expanded) "Expanded" else "Collapsed"
                        onClick(label = "Shows what each tool did") {
                            toggle()
                            true
                        }
                    } else {
                        disabled()
                    }
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (items.any { it.isInProgress }) {
                AppActivityIndicator(size = 14.dp)
            } else {
                Icon(
                    imageVector = if (failureCount > 0) AppIcons.close else AppIcons.success,
                    contentDescription = null,
                    tint = if (failureCount > 0) appColors.destructive else appColors.secondaryLabel,
                    modifier = Modifier.size(16.dp),
                )
            }
            Spacer(Modifier.width(8.dp))
            Text(
                text = summary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                color = if (failureCount > 0) appColors.destructive else appColors.label,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (failureCount > 0 && items.size > 1) {
                Spacer(Modifier.width(6.dp))
                Text(
                    text = "$failureCount failed",
                    style = MaterialTheme.typography.labelSmall,
                    color = appColors.destructive,
                )
            }
            Spacer(Modifier.weight(1f))
            if (hasDetails) {
                Icon(
                    imageVector = if (expanded) AppIcons.expand else AppIcons.chevron,
                    contentDescription = null,
                    tint = appColors.secondaryLabel,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        if (expanded) {
            Spacer(Modifier.height(8.dp))
            if (items.size == 1) {
                AppSelectableText(
                    text = items.first().text,
                    style = MonospaceTextStyle,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                items.forEach { item ->
                    ToolDetailRow(
                        item = item,
                        isExpanded = isExpanded(item.id),
                        onExpandedChanged = { value -> onExpandedChanged(item.id, value) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ToolDetailRow(item: StreamItem, isExpanded: Boolean, onExpandedChanged: (Boolean) -> Unit) {
    val hasDetails = item.text.isNotEmpty()
    val toggle = { onExpandedChanged(!isExpanded) }
    Column(Modifier.fillMaxWidth().testTag(TranscriptTestTags.toolDetail(item.id))) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = AppButtonDefaults.MinTouchTarget)
                .clickable(enabled = hasDetails, onClick = toggle)
                .clearAndSetSemantics {
                    contentDescription = item.title
                    role = Role.Button
                    if (hasDetails) {
                        stateDescription = if (isExpanded) "Expanded" else "Collapsed"
                        onClick {
                            toggle()
                            true
                        }
                    } else {
                        disabled()
                    }
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (item.isError) AppIcons.close else AppIcons.successOutline,
                contentDescription = null,
                tint = if (item.isError) appColors.destructive else appColors.secondaryLabel,
                modifier = Modifier.size(13.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = item.title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodySmall,
                color = if (item.isError) appColors.destructive else appColors.label,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.weight(1f))
            if (hasDetails) {
                Icon(
                    imageVector = if (isExpanded) AppIcons.expand else AppIcons.chevron,
                    contentDescription = null,
                    tint = appColors.secondaryLabel,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
        if (isExpanded && hasDetails) {
            // Indented under its own title, or the output reads as the card's.
            AppSelectableText(
                text = item.text,
                style = MonospaceTextStyle,
                modifier = Modifier.fillMaxWidth().padding(start = 22.dp, top = 4.dp),
            )
        }
    }
}

/** Wording that belongs to an approval card whichever surface draws it. */
object ApprovalCardDefaults {
    /**
     * Shown when the turn settled without an answer. The request may still be
     * answerable server-side, so the usual actions stay and this only says pi
     * moved on.
     */
    const val STALE_CAPTION: String =
        "pi moved on without this answer — you can still respond or dismiss."
}

/**
 * An approval request inline in the transcript. The response controls are
 * passed in so the transcript does not depend on the interactions feature.
 */
@Composable
fun ApprovalCard(
    interaction: PendingInteraction,
    modifier: Modifier = Modifier,
    isStale: Boolean = false,
    onDismissStale: (() -> Unit)? = null,
    controls: @Composable () -> Unit = {},
) {
    val presentation = remember(interaction) { InteractionPresentation(interaction) }
    var showsDetails by rememberSaveable(interaction.id) { mutableStateOf(false) }
    val colors = appColors

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.notice.copy(alpha = 0.12f), RoundedCornerShape(16.dp))
            .padding(14.dp)
            // The request id travels as a test handle only: a 36-char UUID is
            // noise in an announced label.
            .testTag(TranscriptTestTags.approvalCard(interaction.id)),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(AppIcons.approval, contentDescription = null, tint = colors.noticeText)
            Spacer(Modifier.width(8.dp))
            Text(
                text = presentation.title,
                style = MaterialTheme.typography.titleSmall,
                color = colors.noticeText,
            )
        }
        Spacer(Modifier.height(10.dp))
        AppSelectableText(presentation.message, style = MaterialTheme.typography.bodyMedium)
        if (isStale) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = ApprovalCardDefaults.STALE_CAPTION,
                style = MaterialTheme.typography.bodySmall,
                color = colors.secondaryLabel,
                // Its own node: folded into the surrounding text it would vanish
                // as a findable element.
                modifier = Modifier.clearAndSetSemantics {
                    contentDescription = ApprovalCardDefaults.STALE_CAPTION
                },
            )
        } else {
            Spacer(Modifier.height(10.dp))
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = AppButtonDefaults.MinTouchTarget)
                .clickable { showsDetails = !showsDetails }
                .testTag(TranscriptTestTags.APPROVAL_DETAILS)
                .clearAndSetSemantics {
                    contentDescription = "Complete request details"
                    role = Role.Button
                    stateDescription = if (showsDetails) "Expanded" else "Collapsed"
                    onClick {
                        showsDetails = !showsDetails
                        true
                    }
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (showsDetails) AppIcons.expand else AppIcons.chevron,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(4.dp))
            Text(
                text = "Complete request details",
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (showsDetails) {
            AppSelectableText(
                text = presentation.details,
                style = MonospaceTextStyle,
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            )
        }
        Spacer(Modifier.height(10.dp))
        controls()
        if (isStale && onDismissStale != null) {
            Spacer(Modifier.height(8.dp))
            AppButton(
                text = "Dismiss",
                onClick = onDismissStale,
                kind = AppButtonKind.Tinted,
                semanticsLabel = if (presentation.title.trim().isEmpty()) {
                    "Dismiss stale request"
                } else {
                    "Dismiss stale request for ${presentation.title.trim()}"
                },
                modifier = Modifier.testTag(TranscriptTestTags.APPROVAL_DISMISS),
            )
        }
    }
}

// --- pure helpers, so the wording can be tested without a composition --------

/**
 * Screen readers still need the speaker when the visual label is collapsed into
 * a group — otherwise consecutive "You" bubbles become anonymous.
 */
internal fun transcriptAccessibilityText(
    item: StreamItem,
    sender: String,
    timeLabel: String?,
): String {
    val parts = mutableListOf(sender)
    if (timeLabel != null) parts.add(timeLabel)
    if (item.isError) parts.add("Error")
    if (item.attachments.isNotEmpty()) {
        val count = item.attachments.size
        parts.add(if (count == 1) "1 image attached" else "$count images attached")
    }
    val body = item.text.trim()
    parts.add(if (body.isEmpty() && item.isInProgress) "Thinking" else body)
    when (item.delivery) {
        StreamItemDelivery.DELIVERED -> Unit
        StreamItemDelivery.SENDING -> parts.add("Sending")
        StreamItemDelivery.WAITING_FOR_CONNECTION -> parts.add("Waiting for connection")
        StreamItemDelivery.SAVED_ON_SERVER -> parts.add("Saved on the server")
        StreamItemDelivery.FAILED -> parts.add("Not delivered")
    }
    return parts.joinToString(", ")
}

internal fun toolActivityGroupId(items: List<StreamItem>): String =
    "tool-group-${items.firstOrNull()?.id.orEmpty()}"

/** The one line a collapsed run of tool calls shows. */
internal fun toolActivitySummary(items: List<StreamItem>): String {
    val active = items.lastOrNull { it.isInProgress }
    if (active != null) return active.title
    if (items.size == 1) return items[0].title
    return "${items.size} tool calls"
}

/** The same line plus the failure count, which is what the row is named. */
internal fun toolActivityLabel(items: List<StreamItem>): String {
    val summary = toolActivitySummary(items)
    val failures = items.count { it.isError }
    return if (failures > 0) "$summary, $failures failed" else summary
}

@Composable
private fun rememberCopyAction(text: String): () -> Unit {
    val clipboard = LocalClipboardManager.current
    val toastHost = LocalAppToastHost.current
    val scope = rememberCoroutineScope()
    return remember(text, clipboard, toastHost, scope) {
        {
            clipboard.setText(AnnotatedString(text))
            scope.launch { showAppToast(toastHost, "Copied") }
        }
    }
}
