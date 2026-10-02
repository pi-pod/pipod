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
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.pipod.app.core.session.ChatAttachment
import com.pipod.app.core.session.ChatAttachmentLimits
import com.pipod.app.shell.ContentPane
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppFieldShape
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.rememberThumbnail
import com.pipod.app.ui.theme.appColors

/**
 * Everything the composer draws.
 *
 * A projection of the session state rather than the stream itself: the composer
 * cares about eight fields, and taking only those is what lets a UI test build
 * every variant — running, interrupting, disconnected, mid-pick — by hand.
 */
@Immutable
data class ComposerState(
    val text: String = "",
    val placeholder: String = "Message pi…",
    val attachments: List<ChatAttachment> = emptyList(),
    /**
     * Composer-ready validation copy — a refused image, or a prompt over the
     * gateway's text limit — shown under the strip until the next edit or pick.
     */
    val attachError: String? = null,
    val isRunning: Boolean = false,
    val isInterrupting: Boolean = false,
    val isConnected: Boolean = false,
    /** False while a picker is already open, so the field never reflows under a thumb. */
    val canAttach: Boolean = true,
) {
    val canSend: Boolean get() = text.trim().isNotEmpty() || attachments.isNotEmpty()
}

/** Test handles the acceptance pass addresses the composer by. */
object ComposerTestTags {
    const val ROOT = "session-composer"
    const val FIELD = "composer-field"
    const val LENGTH = "composer-length"
    const val SEND = "composer-send"
    const val ATTACH = "composer-attach"
    const val INTERRUPT = "composer-interrupt"
    const val ATTACHMENTS = "composer-attachments"
    const val ATTACH_ERROR = "composer-attach-error"

    fun attachment(id: String) = "composer-attachment-$id"

    fun removeAttachment(id: String) = "composer-remove-attachment-$id"
}

/**
 * Chat-style input pinned above the keyboard, plus the image staging strip for
 * turns that carry pictures.
 *
 * Ported from `pi-pod-flutter/lib/features/session/composer_bar.dart`. Send
 * stays available while pi is working so a follow-up can queue; Stop only
 * becomes actionable for the turn that can be interrupted, but keeps its place
 * in the bar so the field never resizes under a thumb that is already moving
 * toward Send.
 */
@Composable
fun ComposerBar(
    state: ComposerState,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    onInterrupt: () -> Unit,
    modifier: Modifier = Modifier,
    onAttach: () -> Unit = {},
    onRemoveAttachment: (String) -> Unit = {},
    focusRequester: FocusRequester? = null,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(appColors.bar)
            .navigationBarsPadding()
            .imePadding()
            .testTag(ComposerTestTags.ROOT),
    ) {
        ContentPane {
            Column(
                Modifier.padding(start = 12.dp, top = 4.dp, end = 4.dp, bottom = 4.dp),
            ) {
                if (state.attachments.isNotEmpty() || state.attachError != null) {
                    AttachmentStrip(
                        attachments = state.attachments,
                        error = state.attachError,
                        onRemove = onRemoveAttachment,
                    )
                }
                // Only near the limit: a running character count over an
                // ordinary sentence is noise, and the limit is 64 KiB — nothing
                // typed by hand ever approaches it.
                PromptLimits.caption(state.text.length)?.let { caption ->
                    Text(
                        text = caption,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (state.text.length > PromptLimits.maxPromptTextChars) {
                            appColors.destructive
                        } else {
                            appColors.secondaryLabel
                        },
                        modifier = Modifier
                            .padding(bottom = 2.dp)
                            .testTag(ComposerTestTags.LENGTH)
                            .semantics {
                                contentDescription = caption
                                liveRegion = LiveRegionMode.Polite
                            },
                    )
                }
                Row(verticalAlignment = Alignment.Bottom) {
                    // Always in place: while a picker is open the button is
                    // disabled, so the field never reflows under the thumb.
                    AppIconButton(
                        icon = AppIcons.attach,
                        onClick = onAttach,
                        semanticsLabel = "Attach image",
                        enabled = state.canAttach,
                        tint = appColors.secondaryLabel,
                        modifier = Modifier.testTag(ComposerTestTags.ATTACH),
                    )
                    AppTextField(
                        value = state.text,
                        onValueChange = onValueChange,
                        // No naming wrapper: the placeholder already labels the
                        // field, and a wrapper would expose a second,
                        // value-less text-field node.
                        placeholder = state.placeholder,
                        shape = AppFieldShape.Pill,
                        minLines = 1,
                        maxLines = 6,
                        // Prompts to a coding agent are full of commands, flags
                        // and identifiers; autocorrect turns "sudo" into "Audi"
                        // and the agent answers the wrong question.
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Text,
                            // A touch keyboard keeps the newline action; the
                            // send button beside the field is always reachable.
                            imeAction = ImeAction.Default,
                        ),
                        modifier = Modifier
                            .weight(1f)
                            .then(
                                if (focusRequester == null) {
                                    Modifier
                                } else {
                                    Modifier.focusRequester(focusRequester)
                                },
                            )
                            .testTag(ComposerTestTags.FIELD),
                    )
                    if (state.isRunning) {
                        if (state.isInterrupting) {
                            Box(
                                modifier = Modifier
                                    .size(48.dp)
                                    // The tag is declared before the clearing
                                    // modifier: a semantics property set after
                                    // one is discarded when the node's config
                                    // is collapsed.
                                    .testTag(ComposerTestTags.INTERRUPT)
                                    // Still a named node while it spins: the
                                    // reader has to hear that Stop was taken.
                                    .clearAndSetSemantics {
                                        contentDescription = "Stopping the current turn"
                                        role = Role.Button
                                        disabled()
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                AppActivityIndicator(size = 18.dp)
                            }
                        } else {
                            AppIconButton(
                                icon = AppIcons.interrupt,
                                onClick = onInterrupt,
                                semanticsLabel = "Interrupt current turn",
                                enabled = state.isConnected,
                                destructive = true,
                                modifier = Modifier.testTag(ComposerTestTags.INTERRUPT),
                            )
                        }
                    }
                    AppIconButton(
                        icon = AppIcons.send,
                        onClick = onSend,
                        semanticsLabel = "Send message",
                        enabled = state.canSend,
                        tint = if (state.canSend) appColors.accent else appColors.secondaryLabel,
                        modifier = Modifier.testTag(ComposerTestTags.SEND),
                    )
                }
            }
        }
    }
}

/**
 * Staged thumbnails with per-image removal, plus the latest validation error.
 *
 * Thumbnails are small on purpose: they confirm *what* is staged, while the
 * transcript's own rendering is where the user checks the pictures arrived.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AttachmentStrip(
    attachments: List<ChatAttachment>,
    error: String?,
    onRemove: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        if (attachments.isNotEmpty()) {
            FlowRow(
                modifier = Modifier
                    .fillMaxWidth()
                    // The strip enumerates the names itself: a per-thumbnail
                    // name is easy for a driver to miss, and this is the node
                    // the acceptance pass asserts on.
                    .semantics(mergeDescendants = false) {
                        contentDescription = attachmentStripLabel(attachments)
                    }
                    .testTag(ComposerTestTags.ATTACHMENTS),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                attachments.forEach { attachment ->
                    AttachmentThumb(attachment = attachment, onRemove = { onRemove(attachment.id) })
                }
            }
        }
        if (error != null) {
            Text(
                text = error,
                style = MaterialTheme.typography.labelSmall,
                color = appColors.destructive,
                modifier = Modifier
                    .padding(top = 4.dp)
                    .testTag(ComposerTestTags.ATTACH_ERROR)
                    // The label already speaks the message; the raw text stays
                    // out of the tree so drivers match one exact string.
                    .clearAndSetSemantics {
                        contentDescription = "Composer error, $error"
                        liveRegion = LiveRegionMode.Polite
                    },
            )
        }
    }
}

@Composable
private fun AttachmentThumb(attachment: ChatAttachment, onRemove: () -> Unit) {
    // Subsampled off the composition thread: a staged phone photo is 4000×3000,
    // and decoding it whole for a 56dp tile drops frames in the composer the
    // reader is typing in.
    val thumbnail by rememberThumbnail(
        id = attachment.id,
        bytes = attachment.bytes,
        size = AttachmentThumbSize,
    )
    val bitmap = thumbnail
    Box(Modifier.testTag(ComposerTestTags.attachment(attachment.id))) {
        Box(
            modifier = Modifier
                .size(AttachmentThumbSize)
                .border(1.dp, appColors.separator, RoundedCornerShape(10.dp))
                .semantics(mergeDescendants = true) {
                    contentDescription = "Attached image, ${attachment.name}"
                },
            contentAlignment = Alignment.Center,
        ) {
            if (bitmap == null) {
                Icon(
                    imageVector = AppIcons.attach,
                    contentDescription = null,
                    tint = appColors.secondaryLabel,
                    modifier = Modifier.size(22.dp),
                )
            } else {
                Image(
                    bitmap = bitmap,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(AttachmentThumbSize - 2.dp),
                )
            }
        }
        // The remove control is its own node with its own 48dp target: merged
        // into the thumbnail's label a driver could no longer address it.
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .defaultMinSize(
                    minWidth = AppButtonDefaults.MinTouchTarget,
                    minHeight = AppButtonDefaults.MinTouchTarget,
                )
                .clickable(onClick = onRemove)
                .testTag(ComposerTestTags.removeAttachment(attachment.id))
                .clearAndSetSemantics {
                    contentDescription = "Remove image, ${attachment.name}"
                    role = Role.Button
                },
            contentAlignment = Alignment.TopEnd,
        ) {
            Box(
                modifier = Modifier
                    .size(22.dp)
                    .background(appColors.bar, CircleShape)
                    .border(1.dp, appColors.separator, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = AppIcons.close,
                    contentDescription = null,
                    tint = appColors.label,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}

/**
 * The bound on prompt text, mirroring the gateway's own.
 *
 * `MAX_PROMPT_TEXT_CHARS` in `server/src/server/gateway/stream-fanout.ts`
 * refuses a longer prompt at the socket, which used to arrive as "Not
 * delivered / Retry / Delete" on a message that could never be delivered —
 * pasting a log or a long diff reproduced it forever. Images have had a
 * mirrored client-side budget since the first release (`ChatAttachmentLimits`);
 * this is the same idea for text.
 */
object PromptLimits {

    /**
     * The gateway's bound, owned by [ChatAttachmentLimits] beside the image
     * budgets it belongs with, so the composer's refusal and the session
     * layer's cannot drift apart.
     */
    const val maxPromptTextChars: Int = ChatAttachmentLimits.maxPromptTextChars

    /** Silence until the last tenth, where the number starts being useful. */
    private const val CAPTION_FROM: Int = maxPromptTextChars * 9 / 10

    /** The count-remaining line, or null while the length is unremarkable. */
    fun caption(length: Int): String? = when {
        length > maxPromptTextChars ->
            "${length - maxPromptTextChars} characters over the $maxPromptTextChars limit"
        length >= CAPTION_FROM -> "${maxPromptTextChars - length} characters left"
        else -> null
    }

    /** Why a send was refused, in the composer's own error line. */
    fun tooLong(length: Int): String =
        "This message is $length characters; the limit is $maxPromptTextChars. " +
            "Shorten it or send it as a file in the pod."
}

/** How big a staged thumbnail is drawn, and therefore how big it is decoded. */
private val AttachmentThumbSize = 56.dp

/** The one string the strip announces, enumerating what is staged. */
internal fun attachmentStripLabel(attachments: List<ChatAttachment>): String =
    if (attachments.size == 1) {
        "1 image attached, ${attachments.single().name}"
    } else {
        "${attachments.size} images attached, " + attachments.joinToString(", ") { it.name }
    }
