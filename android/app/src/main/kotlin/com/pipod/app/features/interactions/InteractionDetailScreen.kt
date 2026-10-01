package com.pipod.app.features.interactions

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.session.InteractionPresentation
import com.pipod.app.core.session.InteractionResponseStyle
import com.pipod.app.features.session.InteractionDraftStore
import com.pipod.app.shell.ContentPane
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonContent
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.AppSelectableText
import com.pipod.app.ui.theme.MonospaceTextStyle
import kotlinx.serialization.json.JsonObject

/**
 * One approval, opened from the inbox or a push notification.
 *
 * Port of `InteractionDetailView` in
 * `pi-pod-flutter/lib/features/interactions/interaction_list_view.dart`.
 *
 * @param onResolve sends the answer; it throws on failure, which the response
 *   controls turn into the error line. The screen pops only once it returns.
 * @param onOpenPod the pod this request came from. The Flutter version pushes a
 *   pod detail route itself when no callback is given; navigation belongs to the
 *   shell here, so the default does nothing.
 */
@Composable
fun InteractionDetailScreen(
    interaction: PendingInteraction,
    onResolve: suspend (JsonObject) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenPod: (String) -> Unit = {},
) {
    val presentation = remember(interaction) { InteractionPresentation(interaction) }
    var resolved by remember(interaction.id) { mutableStateOf(false) }

    // Popping from inside the controls' own coroutine would dispose them
    // mid-resolve, so the answer finishes first and the screen leaves on the
    // frame after it.
    LaunchedEffect(resolved) { if (resolved) onBack() }

    val backDispatcher = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val leave: () -> Unit = {
        // The toolbar's Back is a back navigation like any other, so it goes
        // through the dispatcher whenever the controls have their unsent-draft
        // guard armed — the draft store is what the guard reads too. With
        // nothing armed there is nothing to intercept and the caller pops.
        val guarded = presentation.responseStyle is InteractionResponseStyle.Input &&
            InteractionDraftStore.read(interaction.id, interaction.payload).isNotEmpty()
        if (guarded && backDispatcher != null && backDispatcher.hasEnabledCallbacks()) {
            backDispatcher.onBackPressed()
        } else {
            onBack()
        }
    }

    AppScaffold(
        modifier = modifier.testTag(InteractionDetailTestTags.SCREEN),
        title = "Approval",
        onNavigateBack = leave,
        grouped = true,
    ) { insets ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(insets)
                .verticalScroll(rememberScrollState()),
        ) {
            ContentPane {
                Column(
                    Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 32.dp),
                ) {
                    SectionCard(title = "Request") {
                        LabeledValue(label = "Pod", value = interaction.podName)
                        Text(presentation.title, style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(8.dp))
                        AppSelectableText(presentation.message)
                        Spacer(Modifier.height(8.dp))
                        Box(Modifier.align(Alignment.Start)) {
                            AppButton(
                                onClick = { onOpenPod(interaction.podId) },
                                kind = AppButtonKind.Plain,
                                semanticsLabel =
                                    "Open pod ${interaction.podName} for this approval",
                                modifier = Modifier.testTag(InteractionDetailTestTags.OPEN_POD),
                            ) {
                                AppButtonContent(AppIcons.openExternal, "Open pod")
                            }
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    DetailsDisclosure(
                        podName = interaction.podName,
                        details = presentation.details,
                    )
                    Spacer(Modifier.height(12.dp))
                    SectionCard(title = "Your response") {
                        InteractionResponseControls(
                            interaction = interaction,
                            onResolve = { response ->
                                onResolve(response)
                                resolved = true
                            },
                            // Single-detail use: a typed response confirms
                            // before a back navigation may drop it.
                            guardUnsentDraft = true,
                            onDiscardGuardedDraft = onBack,
                        )
                    }
                }
            }
        }
    }
}

/**
 * The complete payload, folded away by default.
 *
 * The name stays "Toggle complete request details for …" in both states and the
 * open/closed part is announced as the row's state, so a reader listening for
 * the row does not hear it renamed underneath them.
 */
@Composable
private fun DetailsDisclosure(podName: String, details: String) {
    var expanded by rememberSaveable(podName) { mutableStateOf(false) }
    AppListSection {
        row {
            Column {
                AppListTile(
                    modifier = Modifier.testTag(InteractionDetailTestTags.DISCLOSURE),
                    title = { Text("Complete request details") },
                    onClick = { expanded = !expanded },
                    semanticsLabel = "Toggle complete request details for $podName",
                    semanticsExpanded = expanded,
                    trailing = {
                        Icon(
                            imageVector = AppIcons.expand,
                            contentDescription = null,
                            modifier = Modifier.rotate(if (expanded) 180f else 0f),
                        )
                    },
                )
                if (expanded) {
                    AppSelectableText(
                        text = details,
                        style = MonospaceTextStyle,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
                    )
                }
            }
        }
    }
}

/** A titled block of a form, drawn on the same card a list section uses. */
@Composable
private fun SectionCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    AppListSection {
        row {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(12.dp))
                content()
            }
        }
    }
}

/** A label and its value, read as one phrase rather than two stray words. */
@Composable
private fun LabeledValue(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 10.dp)
            .clearAndSetSemantics { contentDescription = "$label, $value" },
        verticalAlignment = Alignment.Top,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(16.dp))
        Text(
            text = value,
            modifier = Modifier.weight(1f, fill = false),
            textAlign = TextAlign.End,
            fontWeight = FontWeight.Medium,
        )
    }
}

/** The handles a UI test finds this screen's parts by. */
object InteractionDetailTestTags {
    const val SCREEN = "approval-detail"
    const val DISCLOSURE = "approval-detail-disclosure"
    const val OPEN_POD = "approval-detail-open-pod"
}
