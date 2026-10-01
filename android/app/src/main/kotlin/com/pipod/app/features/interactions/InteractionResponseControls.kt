package com.pipod.app.features.interactions

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.session.InteractionPresentation
import com.pipod.app.core.session.InteractionResponseStyle
import com.pipod.app.features.session.InteractionDraftStore
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppOption
import com.pipod.app.ui.AppOptionPicker
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Payload-driven response UI for pi's extension UI protocol.
 *
 * Port of `pi-pod-flutter/lib/features/interactions/interaction_response_controls.dart`.
 * It is deliberately independent of the approvals list so a live session
 * transcript composes the same safe controls inside its own approval card.
 *
 * @param onResolve sends the answer and throws on failure; the controls catch
 *   it and show the error line. That is what lets the session screen route a
 *   resolve through its own view model while the approvals detail screen routes
 *   it through the repository.
 * @param guardUnsentDraft veto a back navigation while an unsent freeform draft
 *   exists, confirming before it is dropped. Enable **only** for the
 *   single-approval detail screen: several mounted guards in a transcript would
 *   each answer the same back press, and discarding there should exit the
 *   session rather than pop it from inside.
 * @param dialogHostState the host the discard confirmation is raised on. Null —
 *   the usual case — means these controls remember and render their own, so an
 *   embedded card needs no wiring; a caller that passes one must render
 *   `AppDialogHost` itself, or the confirmation never appears.
 */
@Composable
fun InteractionResponseControls(
    interaction: PendingInteraction,
    onResolve: suspend (JsonObject) -> Unit,
    modifier: Modifier = Modifier,
    guardUnsentDraft: Boolean = false,
    onDiscardGuardedDraft: () -> Unit = {},
    dialogHostState: AppDialogHostState? = null,
) {
    val presentation = remember(interaction) { InteractionPresentation(interaction) }
    val style = presentation.responseStyle
    // Keyed on the pi request id when the payload carries one, so the inline
    // card and the Approvals detail share one draft across id adoption.
    val draftKey = remember(interaction) {
        InteractionDraftStore.canonicalKeyFor(interaction.id, interaction.payload)
    }

    // A draft typed before backing out wins over the prefill, so the restored
    // card shows the user's own words. Saved across a rotation as well: the
    // decision is often long enough that retyping it is the whole cost.
    var text by rememberSaveable(interaction.id) {
        mutableStateOf(initialResponseText(style, interaction, presentation))
    }
    // CR-29: a selection approval must never pre-select. Submit stays disabled
    // until the user picks for real.
    var selectedOption by rememberSaveable(interaction.id) { mutableStateOf("") }
    var isResolving by remember(interaction.id) { mutableStateOf(false) }
    var isConfirmingDiscard by remember(interaction.id) { mutableStateOf(false) }
    var error by remember(interaction.id) { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val ownDialogs = rememberAppDialogHostState()
    val dialogs = dialogHostState ?: ownDialogs
    val fieldFocus = remember { FocusRequester() }

    // Names the action plus the request title, so a screen reader never hears a
    // raw interaction UUID (IOS-9 / ANDROID-12).
    val title = presentation.title.trim()
    val verbs = interactionConfirmVerbs(style)
    fun actionLabel(verb: String): String = interactionActionLabel(title, verb)

    fun updateResponse(value: String) {
        text = value
        // Only a freeform answer has anything worth restoring; writing the
        // prefill back removes the entry rather than storing a no-op draft.
        if (style is InteractionResponseStyle.Input) {
            InteractionDraftStore.write(draftKey, value, prefill = presentation.prefill)
        }
    }

    fun resolve(answer: JsonObject) {
        // A send already in flight wins: without this, a second tap — or a
        // semantics action slipping past the disabled state — fires a duplicate
        // resolve. The flag is set before the suspend point, not inside it.
        if (isResolving) return
        isResolving = true
        error = null
        focus.clearFocus()
        scope.launch {
            try {
                onResolve(answer)
                // The answer went out: the draft served its purpose. Both the
                // canonical request-id key and the current id go, since entries
                // stored under either domain before id adoption must be dropped.
                InteractionDraftStore.clear(draftKey)
                InteractionDraftStore.clear(interaction.id)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                error = "Could not send your response: " +
                    FriendlyError.message(failure, RuntimeConfig.serverUrl)
            } finally {
                isResolving = false
            }
        }
    }

    if (guardUnsentDraft && style is InteractionResponseStyle.Input) {
        // The detail route is a purpose-built answer screen (CR-30); embedded
        // transcript controls must not steal focus from the composer.
        LaunchedEffect(interaction.id) {
            runCatching { fieldFocus.requestFocus() }
        }
    }

    if (guardUnsentDraft) {
        val hasUnsentDraft =
            style is InteractionResponseStyle.Input && text != presentation.prefill
        // Mid-send the back press is swallowed rather than confirmed, as the
        // Dart's `canPop: !_isResolving && !_hasResponseDraft` does: leaving
        // while the answer is in flight would strand it.
        BackHandler(enabled = isResolving || hasUnsentDraft) {
            if (isResolving || !hasUnsentDraft || isConfirmingDiscard) return@BackHandler
            isConfirmingDiscard = true
            scope.launch {
                try {
                    val discard = dialogs.confirm(
                        title = "Discard response?",
                        confirmLabel = "Discard",
                        message = "The response you typed has not been sent.",
                        cancelLabel = "Keep editing",
                        destructive = true,
                        confirmSemanticsLabel = "Confirm discard approval response",
                        cancelSemanticsLabel = "Keep editing approval response",
                    )
                    if (discard) {
                        updateResponse(presentation.prefill)
                        onDiscardGuardedDraft()
                    }
                } finally {
                    isConfirmingDiscard = false
                }
            }
        }
    }

    Column(modifier = modifier.fillMaxWidth().testTag(InteractionTestTags.CONTROLS)) {
        when (style) {
            is InteractionResponseStyle.Confirmation -> {
                val confirmation = style
                InteractionActionRow(
                    primaryText = verbs.first,
                    primarySemanticsLabel = actionLabel(verbs.first),
                    primaryTestTag = InteractionTestTags.CONFIRM,
                    primaryEnabled = !isResolving,
                    onPrimary = {
                        resolve(interactionConfirmationAnswer(confirmation, accepted = true))
                    },
                    secondaryText = verbs.second,
                    secondarySemanticsLabel = actionLabel(verbs.second),
                    secondaryTestTag = InteractionTestTags.DECLINE,
                    secondaryEnabled = !isResolving,
                    onSecondary = {
                        resolve(interactionConfirmationAnswer(confirmation, accepted = false))
                    },
                )
            }

            is InteractionResponseStyle.Input -> {
                val multiline = style.multiline
                AppTextField(
                    value = text,
                    onValueChange = { updateResponse(it) },
                    modifier = Modifier
                        .focusRequester(fieldFocus)
                        .testTag(InteractionTestTags.INPUT),
                    // The name replaces the visible label rather than sitting
                    // beside it, so there is one node carrying one name.
                    semanticsLabel = actionLabel("Response for"),
                    placeholder = presentation.placeholder ?: "Response",
                    enabled = !isResolving,
                    keyboardOptions = KeyboardOptions(
                        // Decision text holds hostnames and commands (CR-28):
                        // autocorrect turns "sudo" into "Audi" and the wrong
                        // answer goes to the agent.
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Text,
                        imeAction = if (multiline) ImeAction.Default else ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(
                        onDone = {
                            if (text.trim().isNotEmpty()) resolve(interactionValueAnswer(text))
                        },
                    ),
                    minLines = if (multiline) 4 else 1,
                    maxLines = if (multiline) Int.MAX_VALUE else 1,
                )
                Spacer(Modifier.height(10.dp))
                InteractionActionRow(
                    primaryText = "Submit",
                    primarySemanticsLabel = actionLabel("Submit response for"),
                    primaryTestTag = InteractionTestTags.SUBMIT,
                    primaryEnabled = text.trim().isNotEmpty() && !isResolving,
                    onPrimary = { resolve(interactionValueAnswer(text)) },
                    secondaryText = "Cancel request",
                    secondarySemanticsLabel = actionLabel("Cancel request for"),
                    secondaryTestTag = InteractionTestTags.CANCEL,
                    secondaryEnabled = !isResolving,
                    onSecondary = { resolve(InteractionCancelledAnswer) },
                )
            }

            is InteractionResponseStyle.Selection -> {
                val choices = style.options
                // The tag rides its own box: the picker sets a tag of its own on
                // the field, and one node cannot answer to two.
                Box(Modifier.testTag(InteractionTestTags.OPTIONS)) {
                    AppOptionPicker(
                        label = actionLabel("Response for"),
                        value = selectedOption,
                        // The leading placeholder makes "no pick yet" a valid
                        // value, which is what keeps Submit inert until a real
                        // one arrives.
                        options = listOf(AppOption(value = "", label = "Choose…")) +
                            choices.map { AppOption(value = it, label = it) },
                        onValueChange = { selectedOption = it },
                        enabled = !isResolving,
                    )
                }
                Spacer(Modifier.height(10.dp))
                InteractionActionRow(
                    primaryText = "Submit",
                    primarySemanticsLabel = actionLabel("Submit choice for"),
                    primaryTestTag = InteractionTestTags.SUBMIT,
                    primaryEnabled = selectedOption.isNotEmpty() && !isResolving,
                    onPrimary = { resolve(interactionValueAnswer(selectedOption)) },
                    secondaryText = "Cancel request",
                    secondarySemanticsLabel = actionLabel("Cancel selection request for"),
                    secondaryTestTag = InteractionTestTags.CANCEL,
                    secondaryEnabled = !isResolving,
                    onSecondary = { resolve(InteractionCancelledAnswer) },
                )
            }

            // A request this build cannot answer still blocks the agent, and
            // the reader may have no other client to hand. The notice explains,
            // and Cancel — the one answer that needs no understanding of the
            // payload — releases the turn.
            InteractionResponseStyle.Unsupported -> {
                UnsupportedRequestNotice()
                Spacer(Modifier.height(10.dp))
                AppButton(
                    text = "Cancel request",
                    onClick = { resolve(InteractionCancelledAnswer) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag(InteractionTestTags.CANCEL),
                    kind = AppButtonKind.Plain,
                    destructive = true,
                    enabled = !isResolving,
                    semanticsLabel = actionLabel("Cancel request for"),
                )
            }
        }

        if (isResolving) {
            Spacer(Modifier.height(10.dp))
            SendingResponseRow()
        }

        val message = error
        if (message != null) {
            Spacer(Modifier.height(10.dp))
            ResponseErrorRow(message)
        }
    }

    // A caller that supplied its own host is already rendering it; rendering a
    // second one over the same state would raise the dialog twice.
    if (guardUnsentDraft && dialogHostState == null) AppDialogHost(ownDialogs)
}

/**
 * The submit/cancel pair every payload shape ends in: one filled primary and one
 * destructive secondary, wrapping rather than overflowing at large text sizes.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InteractionActionRow(
    primaryText: String,
    primarySemanticsLabel: String,
    primaryTestTag: String,
    primaryEnabled: Boolean,
    onPrimary: () -> Unit,
    secondaryText: String,
    secondarySemanticsLabel: String,
    secondaryTestTag: String,
    secondaryEnabled: Boolean,
    onSecondary: () -> Unit,
) {
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AppButton(
            text = primaryText,
            onClick = onPrimary,
            enabled = primaryEnabled,
            semanticsLabel = primarySemanticsLabel,
            modifier = Modifier.testTag(primaryTestTag),
        )
        AppButton(
            text = secondaryText,
            onClick = onSecondary,
            kind = AppButtonKind.Tinted,
            enabled = secondaryEnabled,
            destructive = true,
            semanticsLabel = secondarySemanticsLabel,
            modifier = Modifier.testTag(secondaryTestTag),
        )
    }
}

/**
 * What a payload this build cannot answer offers instead: the details are still
 * readable, and the copy names the client rather than blaming the request.
 */
@Composable
private fun UnsupportedRequestNotice() {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(InteractionTestTags.UNSUPPORTED),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(AppIcons.warning, contentDescription = null, tint = appColors.warning)
        Spacer(Modifier.width(8.dp))
        Text(
            text = "This app can’t answer this request type. Review the details, or use a " +
                "client that supports it.",
            modifier = Modifier.weight(1f),
            color = appColors.warning,
        )
    }
}

/** One live node while the answer is in flight; the row text is silenced. */
@Composable
private fun SendingResponseRow() {
    Row(
        modifier = Modifier
            .testTag(InteractionTestTags.SENDING)
            .clearAndSetSemantics {
                contentDescription = "Sending approval response"
                liveRegion = LiveRegionMode.Polite
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AppActivityIndicator(size = 18.dp)
        Spacer(Modifier.width(8.dp))
        Text("Sending response…")
    }
}

/** The failure, announced once, with the visible line silenced under it. */
@Composable
private fun ResponseErrorRow(message: String) {
    Text(
        text = message,
        color = appColors.destructive,
        modifier = Modifier
            .testTag(InteractionTestTags.ERROR)
            .clearAndSetSemantics {
                contentDescription = "Approval response error: $message"
                liveRegion = LiveRegionMode.Polite
            },
    )
}

/** The handles the acceptance pass finds the response controls by. */
object InteractionTestTags {
    const val CONTROLS = "interaction-controls"
    const val CONFIRM = "interaction-confirm"
    const val DECLINE = "interaction-decline"
    const val INPUT = "interaction-input"
    const val SUBMIT = "interaction-submit"
    const val CANCEL = "interaction-cancel"
    const val OPTIONS = "interaction-options"
    const val UNSUPPORTED = "interaction-unsupported"
    const val SENDING = "interaction-sending"
    const val ERROR = "interaction-error"
}

// --- pure helpers, testable without a composition -----------------------------

/** `"$verb $title"`, or the bare verb when the request has no usable title. */
internal fun interactionActionLabel(title: String, verb: String): String =
    if (title.isEmpty()) verb else "$verb $title"

/**
 * The yes/no wording for a style: a tool approval reads Approve/Deny, an
 * extension UI confirmation reads Confirm/Decline. Visible text and accessible
 * name are built from the same pair, so the two never drift.
 */
internal fun interactionConfirmVerbs(style: InteractionResponseStyle): Pair<String, String> =
    if (style is InteractionResponseStyle.Confirmation && style.key != "confirmed") {
        "Approve" to "Deny"
    } else {
        "Confirm" to "Decline"
    }

/** The answer to a yes/no request, under the protocol key its style names. */
internal fun interactionConfirmationAnswer(
    style: InteractionResponseStyle.Confirmation,
    accepted: Boolean,
): JsonObject = buildJsonObject { put(style.key, JsonPrimitive(accepted)) }

/** The answer to an input, editor or selection request. */
internal fun interactionValueAnswer(value: String): JsonObject =
    buildJsonObject { put("value", JsonPrimitive(value)) }

/** Declining to answer at all, which pi treats as the request being withdrawn. */
internal val InteractionCancelledAnswer: JsonObject =
    buildJsonObject { put("cancelled", JsonPrimitive(true)) }

/**
 * The row's single merged label.
 *
 * ANDROID-15: each fragment loses its trailing punctuation before joining, so a
 * message that already ends in "." does not produce "..".
 */
internal fun interactionRowLabel(
    interaction: PendingInteraction,
    presentation: InteractionPresentation,
): String {
    val pod = interactionSentence(interaction.podName)
    val title = interactionSentence(presentation.title)
    val message = interactionSentence(presentation.message)
    return "Open approval for $pod. $title. $message. Review request."
}

private fun interactionSentence(value: String): String =
    value.trim().replace(TrailingPunctuation, "")

private val TrailingPunctuation = Regex("[.!?:;\\s]+$")

/**
 * What the field opens with: a kept draft beats the prefill, since it is the
 * reader's own words. Only a freeform style has a draft to restore.
 */
private fun initialResponseText(
    style: InteractionResponseStyle,
    interaction: PendingInteraction,
    presentation: InteractionPresentation,
): String {
    if (style !is InteractionResponseStyle.Input) return presentation.prefill
    val kept = InteractionDraftStore.read(interaction.id, interaction.payload)
    return kept.ifEmpty { presentation.prefill }
}
