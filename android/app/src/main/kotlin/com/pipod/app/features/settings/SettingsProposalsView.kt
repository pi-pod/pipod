package com.pipod.app.features.settings

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.SettingsProposal
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppButtonContent
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListScaffold
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppProgressBar
import com.pipod.app.ui.AppSelectableText
import com.pipod.app.ui.isCompactWidth
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import kotlinx.serialization.json.JsonObject
import kotlinx.coroutines.launch

/**
 * The settings changes an agent drafted from inside a pod.
 *
 * Ported from `ProposalsSection` in
 * `pi-pod-flutter/lib/features/settings/settings_proposals_view.dart`. It
 * renders nothing at all when there is nothing waiting, so the settings screen
 * can declare it unconditionally.
 */
@Composable
fun ProposalsSection(
    proposals: List<SettingsProposal>,
    onOpenProposal: (SettingsProposal) -> Unit,
    modifier: Modifier = Modifier,
) {
    // No header flag here: the caption inside AppListSection is the heading.
    // Flagging the whole section would merge every proposal row into it.
    AppListSection(
        modifier = modifier.testTag(ProposalTestTags.SECTION),
        header = "Waiting for your approval",
        footer = "An agent drafted these from inside a pod. Nothing changes until you apply " +
            "them here.",
    ) {
        items(proposals) { proposal ->
            AppListTile(
                modifier = Modifier
                    .semantics(mergeDescendants = true) { }
                    .testTag(ProposalTestTags.row(proposal.id)),
                onClick = { onOpenProposal(proposal) },
                showChevron = true,
                semanticsLabel = "Proposed change to ${proposal.scopeLabel}, needs approval",
                title = { Text("Change to ${proposal.scopeLabel}") },
                subtitle = proposal.note?.let {
                    { Text(text = it, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                },
            )
        }
    }
}

/**
 * The proposal detail, wired to its view model.
 *
 * There is no route for a proposal: the settings screen shows this in place of
 * its own content, which is why [onBack] is the only way out and
 * [onSetSecret] is how the applied names reach the secret form.
 */
@Composable
fun ProposalDetailScreen(
    viewModel: ProposalDetailViewModel,
    onBack: () -> Unit,
    onSetSecret: (String) -> Unit,
    onResolved: () -> Unit,
    modifier: Modifier = Modifier,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            onResolved()
            when (event) {
                is ProposalDetailEvent.Applied -> Unit
                is ProposalDetailEvent.Rejected -> onBack()
                // Somebody answered it first. Say so where the reader is
                // standing, then leave: the screen has nothing left to offer.
                is ProposalDetailEvent.AlreadyResolved -> {
                    dialogs.notice(
                        title = "Already answered",
                        message = event.message,
                        dismissSemanticsLabel = "Dismiss already-answered proposal message",
                    )
                    onBack()
                }
            }
        }
    }

    ProposalDetailScreen(
        proposal = viewModel.proposal,
        state = state,
        onBack = onBack,
        onApply = viewModel::applyProposal,
        onReject = viewModel::rejectProposal,
        onRetryCurrent = viewModel::loadCurrent,
        onSetSecret = onSetSecret,
        modifier = modifier,
        dialogs = dialogs,
    )
}

/** The proposal detail as a pure function of [state]. */
@Composable
fun ProposalDetailScreen(
    proposal: SettingsProposal,
    state: ProposalDetailState,
    onBack: () -> Unit,
    onApply: () -> Unit,
    onReject: () -> Unit,
    onSetSecret: (String) -> Unit,
    modifier: Modifier = Modifier,
    onRetryCurrent: () -> Unit = {},
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val scope = rememberCoroutineScope()

    val confirmApply: () -> Unit = {
        scope.launch {
            val confirmed = dialogs.confirm(
                title = "Apply this change to ${proposal.scopeLabel}?",
                message = if (proposal.initScript != null) {
                    "The proposed init script will run in every pod launched at this level."
                } else {
                    "The proposed settings take effect for every pod launched at this level."
                },
                confirmLabel = "Apply changes",
                confirmSemanticsLabel = "Confirm apply proposal to ${proposal.scopeLabel}",
                cancelSemanticsLabel = "Cancel applying proposal to ${proposal.scopeLabel}",
            )
            if (confirmed) onApply()
        }
    }

    val confirmReject: () -> Unit = {
        scope.launch {
            val confirmed = dialogs.confirm(
                title = "Reject this proposal?",
                message = "The proposed change to ${proposal.scopeLabel} will be discarded. " +
                    "This cannot be undone.",
                confirmLabel = "Reject proposal",
                destructive = true,
                confirmSemanticsLabel = "Confirm reject proposal for ${proposal.scopeLabel}",
                cancelSemanticsLabel = "Cancel rejecting proposal for ${proposal.scopeLabel}",
            )
            if (confirmed) onReject()
        }
    }

    AppListScaffold(
        title = "Proposal",
        modifier = modifier.testTag(ProposalTestTags.SCREEN),
        onNavigateBack = onBack,
        grouped = true,
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 32.dp),
    ) {
        proposalDetailRows(
            proposal = proposal,
            state = state,
            onApply = confirmApply,
            onReject = confirmReject,
            onRetryCurrent = onRetryCurrent,
            onSetSecret = onSetSecret,
            onDone = onBack,
        )
    }

    AppDialogHost(dialogs)
}

private fun LazyListScope.proposalDetailRows(
    proposal: SettingsProposal,
    state: ProposalDetailState,
    onApply: () -> Unit,
    onReject: () -> Unit,
    onRetryCurrent: () -> Unit,
    onSetSecret: (String) -> Unit,
    onDone: () -> Unit,
) {
    item(key = "summary") {
        SettingsCard(modifier = Modifier.testTag(ProposalTestTags.SUMMARY_CARD)) {
            SettingsLabeledValue(label = "Changes", value = proposal.scopeLabel)
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = AppIcons.resources,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(text = "Written by an agent inside a pod", modifier = Modifier.weight(1f))
            }
            proposal.note?.let { note ->
                Spacer(Modifier.height(8.dp))
                Text(note)
            }
        }
    }

    if (state.isLoadingCurrent) {
        item(key = "loading-current") {
            Spacer(Modifier.height(12.dp))
            AppProgressBar(
                progress = null,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "Loading current settings" },
            )
        }
    }

    // Without the current settings there is nothing to compare the proposal
    // against and Apply stays refused, so the read has to be retryable rather
    // than leaving the screen a dead end.
    val currentError = state.currentError
    if (currentError != null && !state.isLoadingCurrent) {
        item(key = "current-error") {
            Spacer(Modifier.height(12.dp))
            SettingsCard(modifier = Modifier.testTag(ProposalTestTags.CURRENT_ERROR)) {
                Text(
                    text = currentError,
                    modifier = Modifier.semantics {
                        liveRegion = LiveRegionMode.Polite
                        contentDescription = currentError
                    },
                )
                Spacer(Modifier.height(12.dp))
                AppButton(
                    text = "Try again",
                    onClick = onRetryCurrent,
                    kind = AppButtonKind.Tinted,
                    semanticsLabel = "Try loading current settings again",
                    modifier = Modifier.testTag(ProposalTestTags.RETRY_CURRENT),
                )
            }
        }
    }

    proposal.initScript?.let { proposed ->
        item(key = "init-script") {
            Spacer(Modifier.height(12.dp))
            SettingsCard(
                modifier = Modifier.testTag(ProposalTestTags.INIT_SCRIPT_CARD),
                title = "Default init script: current → proposed",
            ) {
                ValueComparison(
                    current = scriptLabel(state.current?.initScript),
                    proposed = scriptLabel(proposed),
                    monospace = true,
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    "Runs at the start of every pod launch at this level, before any " +
                        "environment script.",
                )
            }
        }
    }

    proposal.bakeScript?.let { proposed ->
        item(key = "bake-script") {
            Spacer(Modifier.height(12.dp))
            SettingsCard(
                modifier = Modifier.testTag(ProposalTestTags.BAKE_SCRIPT_CARD),
                title = "Default bake script: current → proposed",
            ) {
                ValueComparison(
                    current = scriptLabel(state.current?.bakeScript),
                    proposed = scriptLabel(proposed),
                    monospace = true,
                )
                Spacer(Modifier.height(12.dp))
                Text("Runs when an environment image is built.")
            }
        }
    }

    proposal.config?.let { proposed ->
        item(key = "config") {
            Spacer(Modifier.height(12.dp))
            SettingsCard(
                modifier = Modifier.testTag(ProposalTestTags.CONFIG_CARD),
                title = "Settings: current → proposed",
            ) {
                val current = state.current?.config
                if (current != null) {
                    SettingsComparison(current = current, proposed = proposed)
                } else {
                    Text("Current settings are unavailable.")
                }
                Spacer(Modifier.height(8.dp))
                RawSettingsDisclosure(
                    current = current ?: JsonObject(emptyMap()),
                    proposed = proposed,
                )
                Spacer(Modifier.height(8.dp))
                Text("The proposed settings replace the current settings at this level.")
            }
        }
    }

    if (proposal.secretNames.isNotEmpty()) {
        item(key = "secret-names") {
            Spacer(Modifier.height(12.dp))
            SettingsCard(
                modifier = Modifier.testTag(ProposalTestTags.SECRETS_CARD),
                title = "Secrets it asks you to set",
            ) {
                Text(text = proposal.secretNames.joinToString(", "), style = MonospaceTextStyle)
                Spacer(Modifier.height(12.dp))
                Text(
                    "Only the names travel with the proposal. You enter the values yourself " +
                        "after applying — the agent never sees them.",
                )
            }
        }
    }

    item(key = "actions") {
        Spacer(Modifier.height(12.dp))
        val applied = state.appliedSecretNames
        if (applied != null) {
            AppliedCard(
                names = applied,
                isWorking = state.isWorking,
                onSetSecret = onSetSecret,
                onDone = onDone,
            )
        } else {
            SettingsCard(modifier = Modifier.testTag(ProposalTestTags.ACTIONS_CARD)) {
                AppButton(
                    onClick = onApply,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag(ProposalTestTags.APPLY),
                    enabled = state.canApply,
                    semanticsLabel = "Apply proposal to ${proposal.scopeLabel}",
                ) {
                    if (state.isWorking) AppActivityIndicator(size = 18.dp) else Text("Apply changes")
                }
                Spacer(Modifier.height(8.dp))
                AppButton(
                    text = "Reject",
                    onClick = onReject,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag(ProposalTestTags.REJECT),
                    kind = AppButtonKind.Plain,
                    enabled = !state.isWorking,
                    destructive = true,
                    semanticsLabel = "Reject proposal for ${proposal.scopeLabel}",
                )
            }
        }
    }

    state.errorMessage?.let { error ->
        item(key = "error") {
            Spacer(Modifier.height(12.dp))
            AppListSection(modifier = Modifier.testTag(ProposalTestTags.ERROR)) {
                row {
                    AppListTile(
                        modifier = Modifier.semantics(mergeDescendants = true) {
                            liveRegion = LiveRegionMode.Polite
                        },
                        backgroundColor = appColors.destructiveFill,
                        title = { Text(error) },
                        semanticsLabel = "Proposal error: $error",
                    )
                }
            }
        }
    }
}

/**
 * What the reader still owes after applying.
 *
 * Applying does not leave the screen, because the secret names the server hands
 * back are values only a person can supply and popping would take the list of
 * them away.
 */
@Composable
private fun AppliedCard(
    names: List<String>,
    isWorking: Boolean,
    onSetSecret: (String) -> Unit,
    onDone: () -> Unit,
) {
    SettingsCard(
        modifier = Modifier
            .testTag(ProposalTestTags.APPLIED_CARD)
            .semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = if (names.isEmpty()) {
                    "Proposal applied"
                } else {
                    "Proposal applied, now set ${names.joinToString(", ")}"
                }
            },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = AppIcons.success,
                contentDescription = null,
                tint = appColors.success,
            )
            Spacer(Modifier.width(8.dp))
            Text(text = "Applied.", modifier = Modifier.weight(1f))
        }
        names.forEach { name ->
            Spacer(Modifier.height(8.dp))
            AppButton(
                onClick = { onSetSecret(name) },
                modifier = Modifier.testTag(ProposalTestTags.setSecret(name)),
                kind = AppButtonKind.Tinted,
                semanticsLabel = "Now set secret $name",
            ) {
                AppButtonContent(icon = AppIcons.secret, label = "Now set: $name")
            }
        }
        Spacer(Modifier.height(8.dp))
        AppButton(
            text = "Done",
            onClick = onDone,
            modifier = Modifier.testTag(ProposalTestTags.DONE),
            kind = AppButtonKind.Plain,
            enabled = !isWorking,
            semanticsLabel = "Done reviewing proposal",
        )
    }
}

/** The named settings a proposal touches, current beside proposed. */
@Composable
private fun SettingsComparison(current: JsonObject, proposed: JsonObject) {
    val rows = remember(current, proposed) { knownSettingRows(current, proposed) }
    if (rows.isEmpty()) {
        Text("No labelled settings in this proposal. Show raw to review it.")
        return
    }
    rows.forEach { row ->
        SettingsFieldLabel(row.label)
        Spacer(Modifier.height(4.dp))
        ValueComparison(
            current = displaySetting(row.current),
            proposed = displaySetting(row.proposed),
        )
        Spacer(Modifier.height(12.dp))
    }
}

/** The whole bundle, for a proposal this build has no labelled row for. */
@Composable
private fun RawSettingsDisclosure(current: JsonObject, proposed: JsonObject) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val turn by animateFloatAsState(if (expanded) 180f else 0f, label = "raw-settings-chevron")

    Column(Modifier.fillMaxWidth()) {
        AppListTile(
            modifier = Modifier
                .semantics(mergeDescendants = true) { }
                .testTag(ProposalTestTags.SHOW_RAW),
            onClick = { expanded = !expanded },
            title = { Text("Show raw") },
            trailing = {
                Icon(
                    imageVector = AppIcons.expand,
                    contentDescription = null,
                    modifier = Modifier.rotate(turn),
                )
            },
            semanticsLabel = "Show raw",
            semanticsExpanded = expanded,
        )
        if (expanded) {
            ValueComparison(
                current = prettyJson(current),
                proposed = prettyJson(proposed),
                monospace = true,
            )
        }
    }
}

/**
 * One value, before and after.
 *
 * At phone widths two narrow columns turn JSON into alphabet soup, so current
 * stacks over proposed and the arrow turns to point down the page.
 */
@Composable
private fun ValueComparison(current: String, proposed: String, monospace: Boolean = false) {
    val style = if (monospace) MonospaceTextStyle else androidx.compose.material3.LocalTextStyle.current

    if (isCompactWidth()) {
        Column(Modifier.fillMaxWidth()) {
            ComparisonColumn(title = "Current", value = current, style = style)
            Row(Modifier.padding(vertical = 12.dp)) { ComparisonArrow(Modifier.rotate(90f)) }
            ComparisonColumn(title = "Proposed", value = proposed, style = style)
        }
        return
    }

    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        ComparisonColumn(
            title = "Current",
            value = current,
            style = style,
            modifier = Modifier.weight(1f),
        )
        ComparisonArrow(Modifier.padding(horizontal = 12.dp, vertical = 24.dp))
        ComparisonColumn(
            title = "Proposed",
            value = proposed,
            style = style,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun ComparisonColumn(
    title: String,
    value: String,
    style: androidx.compose.ui.text.TextStyle,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth()) {
        Text(title)
        Spacer(Modifier.height(4.dp))
        AppSelectableText(text = value, style = style)
    }
}

@Composable
private fun ComparisonArrow(modifier: Modifier = Modifier) {
    Icon(
        imageVector = AppIcons.forward,
        contentDescription = "changes to",
        modifier = modifier,
    )
}

/** The handles a UI test finds the proposal surfaces by. */
object ProposalTestTags {
    const val SECTION = "settings-proposals-section"
    const val SCREEN = "proposal-detail-screen"
    const val SUMMARY_CARD = "proposal-summary"
    const val INIT_SCRIPT_CARD = "proposal-init-script"
    const val BAKE_SCRIPT_CARD = "proposal-bake-script"
    const val CONFIG_CARD = "proposal-config"
    const val SECRETS_CARD = "proposal-secrets"
    const val ACTIONS_CARD = "proposal-actions"
    const val APPLIED_CARD = "proposal-applied"
    const val APPLY = "proposal-apply"
    const val REJECT = "proposal-reject"
    const val DONE = "proposal-done"
    const val SHOW_RAW = "proposal-show-raw"
    const val ERROR = "proposal-error"
    const val CURRENT_ERROR = "proposal-current-error"
    const val RETRY_CURRENT = "proposal-retry-current"

    fun row(id: String) = "proposal-row-$id"

    fun setSecret(name: String) = "proposal-set-secret-$name"
}
