package com.pipod.app.features.session

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.pipod.app.core.session.PiDialog
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppOption
import com.pipod.app.ui.AppOptionPicker
import com.pipod.app.ui.AppSelectableText
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import kotlinx.serialization.json.JsonObject

/** Test handles for a dialog card. */
object DialogTestTags {
    fun card(id: String) = "dialog-card-$id"
    const val DETAILS = "dialog-card-details"
    const val CONFIRM = "dialog-confirm"
    const val DECLINE = "dialog-decline"
    const val INPUT = "dialog-input"
    const val OPTIONS = "dialog-options"
    const val SUBMIT = "dialog-submit"
    const val CANCEL = "dialog-cancel"
}

/**
 * A question pi is waiting on, at the end of the conversation it belongs to.
 *
 * @param onAnswer sends the answer; false when the conversation is not connected.
 */
@Composable
fun DialogCard(
    dialog: PiDialog,
    onAnswer: (JsonObject) -> Boolean,
    modifier: Modifier = Modifier,
) {
    var text by rememberSaveable(dialog.id) { mutableStateOf(dialog.prefill) }
    var selectedOption by rememberSaveable(dialog.id) { mutableStateOf("") }
    var showsDetails by rememberSaveable(dialog.id) { mutableStateOf(false) }
    var error by remember(dialog.id) { mutableStateOf<String?>(null) }
    val colors = appColors
    val title = dialog.title.trim()
    fun label(verb: String) = if (title.isEmpty()) verb else "$verb $title"
    fun send(answer: JsonObject) {
        error = if (onAnswer(answer)) {
            null
        } else {
            "Not connected. pi is still waiting; answer again once the conversation reconnects."
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.notice.copy(alpha = 0.12f), RoundedCornerShape(16.dp))
            .padding(14.dp)
            .testTag(DialogTestTags.card(dialog.id)),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(AppIcons.question, contentDescription = null, tint = colors.noticeText)
            Spacer(Modifier.width(8.dp))
            Text(text = dialog.title, style = MaterialTheme.typography.titleSmall, color = colors.noticeText)
        }
        Spacer(Modifier.height(10.dp))
        AppSelectableText(dialog.message, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(10.dp))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = AppButtonDefaults.MinTouchTarget)
                .clickable { showsDetails = !showsDetails }
                .testTag(DialogTestTags.DETAILS)
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
            Text(text = "Complete request details", style = MaterialTheme.typography.bodySmall)
        }
        if (showsDetails) {
            AppSelectableText(
                text = dialog.details,
                style = MonospaceTextStyle,
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            )
        }
        Spacer(Modifier.height(10.dp))

        when (val style = dialog.style) {
            PiDialog.Style.Confirm -> ActionRow(
                primary = "Confirm" to { send(dialog.confirmed(true)) },
                primaryLabel = label("Confirm"),
                primaryTag = DialogTestTags.CONFIRM,
                secondary = "Decline" to { send(dialog.confirmed(false)) },
                secondaryLabel = label("Decline"),
                secondaryTag = DialogTestTags.DECLINE,
            )

            is PiDialog.Style.Input -> {
                // Answers are full of hostnames, flags and commands; autocorrect
                // turns those into different instructions.
                AppTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.testTag(DialogTestTags.INPUT),
                    semanticsLabel = label("Response for"),
                    placeholder = dialog.placeholder ?: "Response",
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Text,
                        imeAction = if (style.multiline) ImeAction.Default else ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(
                        onDone = { if (text.isNotBlank()) send(dialog.value(text)) },
                    ),
                    minLines = if (style.multiline) 4 else 1,
                    maxLines = if (style.multiline) Int.MAX_VALUE else 1,
                )
                Spacer(Modifier.height(10.dp))
                ActionRow(
                    primary = "Submit" to { send(dialog.value(text)) },
                    primaryLabel = label("Submit response for"),
                    primaryTag = DialogTestTags.SUBMIT,
                    primaryEnabled = text.isNotBlank(),
                    secondary = "Cancel question" to { send(dialog.cancelled) },
                    secondaryLabel = label("Cancel question"),
                    secondaryTag = DialogTestTags.CANCEL,
                )
            }

            is PiDialog.Style.Select -> {
                // No pre-selection: Submit stays disabled until a real pick, so a
                // default is never sent as if it were a decision.
                AppOptionPicker(
                    label = label("Response for"),
                    value = selectedOption,
                    options = listOf(AppOption(value = "", label = "Choose…")) +
                        style.options.map { AppOption(value = it, label = it) },
                    onValueChange = { selectedOption = it },
                    modifier = Modifier.testTag(DialogTestTags.OPTIONS),
                )
                Spacer(Modifier.height(10.dp))
                ActionRow(
                    primary = "Submit" to { send(dialog.value(selectedOption)) },
                    primaryLabel = label("Submit choice for"),
                    primaryTag = DialogTestTags.SUBMIT,
                    primaryEnabled = selectedOption.isNotEmpty(),
                    secondary = "Cancel question" to { send(dialog.cancelled) },
                    secondaryLabel = label("Cancel question"),
                    secondaryTag = DialogTestTags.CANCEL,
                )
            }

            PiDialog.Style.Unsupported -> {
                // Every dialog takes `{cancelled: true}`, so backing out is always
                // possible rather than leaving pi waiting until its timeout.
                Row(verticalAlignment = Alignment.Top) {
                    Icon(AppIcons.warning, contentDescription = null, tint = colors.warning)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "This app can’t answer this kind of question. Cancel it so pi " +
                            "stops waiting, or answer it from the terminal.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Spacer(Modifier.height(10.dp))
                AppButton(
                    text = "Cancel question",
                    onClick = { send(dialog.cancelled) },
                    modifier = Modifier.fillMaxWidth().testTag(DialogTestTags.CANCEL),
                    kind = AppButtonKind.Plain,
                    destructive = true,
                )
            }
        }

        error?.let { message ->
            Spacer(Modifier.height(10.dp))
            Text(text = message, style = MaterialTheme.typography.bodySmall, color = colors.destructive)
        }
    }
}

/**
 * One filled primary and one destructive secondary, wrapping rather than
 * overflowing at large text sizes.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ActionRow(
    primary: Pair<String, () -> Unit>,
    primaryLabel: String,
    primaryTag: String,
    secondary: Pair<String, () -> Unit>,
    secondaryLabel: String,
    secondaryTag: String,
    primaryEnabled: Boolean = true,
) {
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AppButton(
            text = primary.first,
            onClick = primary.second,
            enabled = primaryEnabled,
            semanticsLabel = primaryLabel,
            modifier = Modifier.testTag(primaryTag),
        )
        AppButton(
            text = secondary.first,
            onClick = secondary.second,
            kind = AppButtonKind.Tinted,
            destructive = true,
            semanticsLabel = secondaryLabel,
            modifier = Modifier.testTag(secondaryTag),
        )
    }
}
