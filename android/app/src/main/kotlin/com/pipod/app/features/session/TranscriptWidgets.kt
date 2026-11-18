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
import com.pipod.app.core.format.Format
import com.pipod.app.core.format.MessageChrome
import com.pipod.app.core.session.ChatAttachmentLimits
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
import com.pipod.app.ui.rememberCopyAction
import com.pipod.app.ui.showAppToast
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll

/**
 * The row widgets a chat transcript is assembled from, ported from
 * `pi-pod-flutter/lib/features/session/transcript_widgets.dart`.
 *
 * Every one of them is a pure function of its arguments: expansion lives on the
 * session stream, drafts live in the composer, and nothing here reaches for a
 * store. That is what lets a UI test build any row — a failed send, a nine-call
 * tool run, a question pi is waiting on — without a server.
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

    fun thinking(id: String) = "transcript-thinking-$id"
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
    /** Whether this reply's reasoning is shown in full rather than as a one-line row. */
    showsThinking: Boolean = false,
    onShowsThinkingChanged: (Boolean) -> Unit = {},
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
            StreamItemStyle.ASSISTANT -> AssistantBlock(
                item, chrome, timeLabel, thinkingLabel, showsThinking, onShowsThinkingChanged,
            )
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
    showsThinking: Boolean,
    onShowsThinkingChanged: (Boolean) -> Unit,
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
                if (item.thinking.isNotBlank()) {
                    ThinkingBlock(
                        item = item,
                        isExpanded = showsThinking,
                        onExpandedChanged = onShowsThinkingChanged,
                    )
                }
                when {
                    // The reasoning row above already says what pi is doing.
                    item.text.isBlank() && item.thinking.isNotBlank() && !item.isError -> Unit

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
 * The model's reasoning for one reply.
 *
 * Collapsed it is one quiet line, because reasoning is long and the reply under it is what
 * was asked for; opened it reads as an aside, set off from the reply by a rule and a dimmer
 * colour. While pi is still reasoning the line says so.
 */
@Composable
private fun ThinkingBlock(item: StreamItem, isExpanded: Boolean, onExpandedChanged: (Boolean) -> Unit) {
    val colors = appColors
    val isLive = item.isInProgress && item.text.isBlank()
    val label = if (isLive) "Thinking…" else "Thought"
    Column(Modifier.fillMaxWidth().testTag(TranscriptTestTags.thinking(item.id))) {
        Row(
            modifier = Modifier
                .heightIn(min = 40.dp)
                .clickable { onExpandedChanged(!isExpanded) }
                .clearAndSetSemantics {
                    contentDescription = label
                    role = Role.Button
                    stateDescription = if (isExpanded) "Expanded" else "Collapsed"
                    onClick(label = if (isExpanded) "Hides the reasoning" else "Shows the reasoning") {
                        onExpandedChanged(!isExpanded)
                        true
                    }
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (isLive) {
                AppActivityIndicator(size = 14.dp)
            } else {
                Icon(
                    imageVector = AppIcons.thinking,
                    contentDescription = null,
                    tint = colors.secondaryLabel,
                    modifier = Modifier.size(16.dp),
                )
            }
            Spacer(Modifier.width(6.dp))
            Text(label, style = MaterialTheme.typography.bodySmall, color = colors.secondaryLabel)
            Spacer(Modifier.width(4.dp))
            Icon(
                imageVector = if (isExpanded) AppIcons.expand else AppIcons.chevron,
                contentDescription = null,
                tint = colors.secondaryLabel,
                modifier = Modifier.size(14.dp),
            )
        }
        if (isExpanded) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(bottom = 10.dp)) {
                Box(Modifier.width(2.dp).fillMaxHeight().background(colors.separator))
                Spacer(Modifier.width(10.dp))
                AppSelectableText(
                    text = item.thinking.trim(),
                    style = MaterialTheme.typography.bodySmall.copy(color = colors.secondaryLabel),
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * One run of tool calls.
 *
 * A turn that reads six files and runs three commands is nine cards otherwise, and the prose
 * the reader came for scrolls away. So a run is one card: closed, it says how many calls there
 * were and what the latest was doing; opened, every call is a line naming its tool and what it
 * was pointed at, and a call opens in turn to show what it was given and what it answered. A
 * run of one skips the first step.
 *
 * [expandedKeys] is state, not a lookup function: a function reference never changes, so a
 * card handed one was never recomposed when a row was opened.
 */
@Composable
fun ToolActivityCard(
    items: List<StreamItem>,
    expandedKeys: Set<String>,
    onExpandedChanged: (String, Boolean) -> Unit,
    modifier: Modifier = Modifier,
    /** A pod extension asked for every tool card to be open. */
    allExpanded: Boolean = false,
) {
    val groupId = toolActivityGroupId(items)
    val isOpen: (String) -> Boolean = { key -> allExpanded || key in expandedKeys }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .background(appColors.fill.copy(alpha = 0.45f), RoundedCornerShape(12.dp))
            .padding(horizontal = 10.dp, vertical = 2.dp)
            .testTag(TranscriptTestTags.tools(items.firstOrNull()?.id.orEmpty())),
    ) {
        if (items.size == 1) {
            val item = items.first()
            ToolCallRow(item, isOpen(item.id)) { onExpandedChanged(item.id, it) }
            return@Column
        }
        val expanded = isOpen(groupId)
        ToolGroupHeader(items, expanded) { onExpandedChanged(groupId, !expanded) }
        if (expanded) {
            items.forEach { item ->
                ToolCallRow(item, isOpen(item.id)) { onExpandedChanged(item.id, it) }
            }
        }
    }
}

@Composable
private fun ToolGroupHeader(items: List<StreamItem>, expanded: Boolean, onToggle: () -> Unit) {
    val failureCount = items.count { it.isError }
    val label = toolActivityLabel(items)
    // What the run is doing now, or did last: the line a reader would otherwise open it for.
    val latest = (items.lastOrNull { it.isInProgress } ?: items.last())
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = AppButtonDefaults.MinTouchTarget)
            .clickable(onClick = onToggle)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                stateDescription = if (expanded) "Expanded" else "Collapsed"
                onClick(label = "Shows each tool call") {
                    onToggle()
                    true
                }
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ToolStatusIcon(isRunning = items.any { it.isInProgress }, failed = failureCount > 0)
        Spacer(Modifier.width(8.dp))
        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "${items.size} tool calls",
                    style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                    color = appColors.label,
                )
                if (failureCount > 0) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = "$failureCount failed",
                        style = MaterialTheme.typography.labelSmall,
                        color = appColors.destructive,
                    )
                }
            }
            if (!expanded) {
                Text(
                    text = toolCallLine(latest),
                    maxLines = 1,
                    overflow = toolSummaryOverflow(latest.toolSummary),
                    style = MonospaceTextStyle.copy(fontSize = MaterialTheme.typography.labelSmall.fontSize),
                    color = appColors.secondaryLabel,
                )
            }
        }
        Spacer(Modifier.width(8.dp))
        Icon(
            imageVector = if (expanded) AppIcons.expand else AppIcons.chevron,
            contentDescription = null,
            tint = appColors.secondaryLabel,
            modifier = Modifier.size(16.dp),
        )
    }
}

/** One tool call: its tool and what it was pointed at, opening to its input and output. */
@Composable
private fun ToolCallRow(item: StreamItem, isExpanded: Boolean, onExpandedChanged: (Boolean) -> Unit) {
    val name = item.toolName.ifEmpty { item.title }
    // The input is worth a block of its own only when the one-line summary left some out.
    val input = item.toolInput.takeIf { it.isNotEmpty() && it.trim() != item.toolSummary.trim() }
    val hasDetails = input != null || item.text.isNotEmpty()
    val toggle = { onExpandedChanged(!isExpanded) }
    val label = toolCallLabel(item)
    Column(Modifier.fillMaxWidth().testTag(TranscriptTestTags.toolDetail(item.id))) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = AppButtonDefaults.MinTouchTarget)
                .clickable(enabled = hasDetails, onClick = toggle)
                .clearAndSetSemantics {
                    contentDescription = label
                    role = Role.Button
                    if (hasDetails) {
                        stateDescription = if (isExpanded) "Expanded" else "Collapsed"
                        onClick(label = "Shows what the tool was given and what it answered") {
                            toggle()
                            true
                        }
                    } else {
                        disabled()
                    }
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ToolStatusIcon(isRunning = item.isInProgress, failed = item.isError)
            Spacer(Modifier.width(8.dp))
            Text(
                text = name,
                maxLines = 1,
                style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                color = if (item.isError) appColors.destructive else appColors.label,
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = item.toolSummary,
                maxLines = 1,
                overflow = toolSummaryOverflow(item.toolSummary),
                style = MonospaceTextStyle.copy(fontSize = MaterialTheme.typography.labelSmall.fontSize),
                color = appColors.secondaryLabel,
                modifier = Modifier.weight(1f),
            )
            if (hasDetails) {
                Spacer(Modifier.width(8.dp))
                Icon(
                    imageVector = if (isExpanded) AppIcons.expand else AppIcons.chevron,
                    contentDescription = null,
                    tint = appColors.secondaryLabel,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
        if (isExpanded && hasDetails) {
            Column(Modifier.fillMaxWidth().padding(start = 24.dp, bottom = 8.dp)) {
                if (input != null) ToolDetailBlock(text = input, isError = false)
                if (input != null && item.text.isNotEmpty()) Spacer(Modifier.height(6.dp))
                if (item.text.isNotEmpty()) ToolDetailBlock(text = item.text, isError = item.isError)
            }
        }
    }
}

@Composable
private fun ToolStatusIcon(isRunning: Boolean, failed: Boolean) {
    if (isRunning) {
        AppActivityIndicator(size = 14.dp)
        return
    }
    Icon(
        imageVector = if (failed) AppIcons.close else AppIcons.successOutline,
        contentDescription = null,
        tint = if (failed) appColors.destructive else appColors.secondaryLabel,
        modifier = Modifier.size(14.dp),
    )
}

/** Tool input or output: monospaced, selectable, and bounded so one call cannot fill a screen. */
@Composable
private fun ToolDetailBlock(text: String, isError: Boolean) {
    val scroll = rememberScrollState()
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 280.dp)
            .background(appColors.background.copy(alpha = 0.6f), RoundedCornerShape(8.dp))
            .verticalScroll(scroll)
            .padding(8.dp),
    ) {
        AppSelectableText(
            text = text,
            style = MonospaceTextStyle.copy(
                fontSize = MaterialTheme.typography.labelSmall.fontSize,
                color = if (isError) appColors.destructive else appColors.label,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
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
    parts.add(if (body.isEmpty() && (item.isInProgress || item.thinking.isNotBlank())) "Thinking" else body)
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

/**
 * Where a summary too long for its line gives way. A path is recognised by its last
 * component, so it loses its start; a command is recognised by how it begins.
 */
internal fun toolSummaryOverflow(summary: String): TextOverflow =
    if ('/' in summary && ' ' !in summary.trim()) TextOverflow.StartEllipsis else TextOverflow.Ellipsis

/** A tool call as one line of text: its tool and what it was pointed at. */
internal fun toolCallLine(item: StreamItem): String {
    val name = item.toolName.ifEmpty { item.title }
    return if (item.toolSummary.isEmpty()) name else "$name ${item.toolSummary}"
}

/** What a tool call row is named: how it went, then what it was. */
internal fun toolCallLabel(item: StreamItem): String =
    if (item.toolSummary.isEmpty()) item.title else "${item.title}: ${item.toolSummary}"

/** What a run of tool calls is named: the count, how many failed, and what is running. */
internal fun toolActivityLabel(items: List<StreamItem>): String {
    val parts = mutableListOf("${items.size} tool calls")
    val failures = items.count { it.isError }
    if (failures > 0) parts += "$failures failed"
    items.lastOrNull { it.isInProgress }?.let { parts += toolCallLabel(it) }
    return parts.joinToString(", ")
}

