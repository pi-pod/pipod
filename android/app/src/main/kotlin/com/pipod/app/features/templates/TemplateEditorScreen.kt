package com.pipod.app.features.templates

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.EnvironmentEditorData
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.features.common.PlainTextEditor
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppOption
import com.pipod.app.ui.AppOptionPicker
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.AppSwitchRow
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.rememberAppDialogHostState
import kotlinx.coroutines.launch

/**
 * The environment editor, wired to its view model.
 *
 * Port of `TemplateEditorView` in
 * `pi-pod-flutter/lib/features/templates/template_list_view.dart`.
 */
@Composable
fun TemplateEditorScreen(
    viewModel: TemplateEditorViewModel,
    onDismiss: () -> Unit,
    onSaved: (PodTemplate, EnvironmentEditorData) -> Unit,
    modifier: Modifier = Modifier,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is TemplateEditorEvent.Saved -> {
                    onSaved(event.template, event.editorData)
                    onDismiss()
                }
            }
        }
    }

    TemplateEditorScreen(
        state = state,
        onNameChange = viewModel::setName,
        onDescriptionChange = viewModel::setDescription,
        onScriptChange = viewModel::setScript,
        onBakeScriptChange = viewModel::setBakeScript,
        onAgentInstructionsChange = viewModel::setAgentInstructions,
        onAllowedHostsChange = viewModel::setAllowedHosts,
        onEgressModeChange = viewModel::setEgressMode,
        onIncludeBuiltinsChange = viewModel::setIncludeBuiltins,
        onSave = viewModel::save,
        onDismiss = onDismiss,
        modifier = modifier,
        dialogs = dialogs,
    )
}

/** The environment editor as a pure function of [state]. */
@Composable
fun TemplateEditorScreen(
    state: TemplateEditorState,
    onNameChange: (String) -> Unit,
    onDescriptionChange: (String) -> Unit,
    onScriptChange: (String) -> Unit,
    onBakeScriptChange: (String) -> Unit,
    onAgentInstructionsChange: (String) -> Unit,
    onAllowedHostsChange: (String) -> Unit,
    onEgressModeChange: (String) -> Unit,
    onIncludeBuiltinsChange: (Boolean) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val scope = rememberCoroutineScope()
    val subject = state.subject
    // True while the discard confirmation is on screen, so Cancel and a system
    // back arriving together cannot stack a duplicate dialog.
    val confirming = remember { mutableStateOf(false) }

    /**
     * The single exit for Cancel and for a blocked system back: confirm when
     * dirty, then leave. A save in flight refuses outright — neither may drop
     * a pending write.
     */
    val requestCancel: () -> Unit = {
        if (!state.isSaving && !confirming.value) {
            if (!state.isDirty) {
                onDismiss()
            } else {
                confirming.value = true
                scope.launch {
                    try {
                        val discard = dialogs.confirm(
                            title = "Discard changes?",
                            message = state.discardMessage,
                            confirmLabel = "Discard",
                            cancelLabel = "Keep editing",
                            destructive = true,
                            confirmSemanticsLabel = "Confirm discard environment changes",
                            cancelSemanticsLabel = "Keep editing environment",
                        )
                        if (discard) onDismiss()
                    } finally {
                        confirming.value = false
                    }
                }
            }
        }
    }

    BackHandler(enabled = state.isSaving || state.isDirty) { requestCancel() }

    AppScaffold(
        modifier = modifier.testTag(TemplateEditorTestTags.SCREEN),
        title = subject,
        grouped = true,
        navigationIcon = {
            AppButton(
                text = "Cancel",
                onClick = requestCancel,
                kind = AppButtonKind.Plain,
                enabled = !state.isSaving,
                semanticsLabel = "Cancel $subject",
                modifier = Modifier.testTag(TemplateEditorTestTags.CANCEL),
            )
        },
        actions = {
            AppButton(
                text = state.actionLabel,
                onClick = onSave,
                kind = AppButtonKind.Plain,
                enabled = state.canSave,
                semanticsLabel = "${state.action} environment form",
                modifier = Modifier.testTag(TemplateEditorTestTags.SAVE),
            )
        },
    ) { insets ->
        Box(Modifier.fillMaxSize().padding(insets)) {
            Column(
                Modifier
                    .fillMaxSize()
                    .dismissKeyboardOnScroll()
                    .verticalScroll(rememberScrollState())
                    .padding(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 32.dp),
            ) {
                SectionCard(modifier = Modifier.testTag(TemplateEditorTestTags.NAME_SECTION)) {
                    AppTextField(
                        value = state.fields.name,
                        onValueChange = onNameChange,
                        label = "Name",
                        semanticsLabel = "$subject name",
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Next,
                        ),
                    )
                    Spacer(Modifier.height(12.dp))
                    AppTextField(
                        value = state.fields.description,
                        onValueChange = onDescriptionChange,
                        label = "What it's for (optional)",
                        semanticsLabel = "$subject description",
                        keyboardOptions = KeyboardOptions(
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Done,
                        ),
                    )
                }
                Spacer(Modifier.height(12.dp))

                if (state.showsAgentInstructions) {
                    SectionCard(
                        title = "Agent instructions",
                        footer = TemplateEditorState.AGENT_INSTRUCTIONS_FOOTER,
                        modifier = Modifier.testTag(TemplateEditorTestTags.AGENT_INSTRUCTIONS),
                    ) {
                        PlainTextEditor(
                            value = state.fields.agentInstructions,
                            onValueChange = onAgentInstructionsChange,
                            accessibilityLabel = "$subject agent instructions",
                            minHeight = 120.dp,
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                }

                SectionCard(
                    title = "Setup script",
                    footer = state.setupScriptFooter,
                    modifier = Modifier.testTag(TemplateEditorTestTags.SETUP_SCRIPT),
                ) {
                    PlainTextEditor(
                        value = state.fields.script,
                        onValueChange = onScriptChange,
                        accessibilityLabel = "$subject setup script",
                        minHeight = 140.dp,
                    )
                }
                Spacer(Modifier.height(12.dp))

                SectionCard(
                    title = "Bake script",
                    footer = "Runs when the environment image is built, not each time a pod " +
                        "launches.",
                    modifier = Modifier.testTag(TemplateEditorTestTags.BAKE_SCRIPT),
                ) {
                    PlainTextEditor(
                        value = state.fields.bakeScript,
                        onValueChange = onBakeScriptChange,
                        accessibilityLabel = "$subject bake script",
                        minHeight = 140.dp,
                    )
                }
                Spacer(Modifier.height(12.dp))

                SectionCard(
                    title = "Network / egress",
                    footer = "Controls which hosts pods launched from this environment can reach.",
                    modifier = Modifier.testTag(TemplateEditorTestTags.NETWORK),
                ) {
                    AppOptionPicker(
                        label = "Network access",
                        value = state.fields.egressMode,
                        options = listOf(
                            AppOption(EgressSettings.OPEN, "Open"),
                            AppOption(EgressSettings.ALLOWLIST, "Restricted to allowed hosts"),
                        ),
                        onValueChange = onEgressModeChange,
                    )
                    Spacer(Modifier.height(8.dp))
                    AppSwitchRow(
                        checked = state.fields.includeBuiltins,
                        onCheckedChange = onIncludeBuiltinsChange,
                        subtitle = {
                            Text("Keeps pi pod and configured model services reachable.")
                        },
                        title = { Text("Allow built-in services") },
                    )
                    PlainTextEditor(
                        value = state.fields.allowedHosts,
                        onValueChange = onAllowedHostsChange,
                        accessibilityLabel = "$subject allowed network hosts",
                        minHeight = 100.dp,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "One hostname per line. Used when network access is restricted.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }

                val error = state.error
                if (error != null) {
                    Spacer(Modifier.height(12.dp))
                    // Tagged separately when it is a concurrent-write refusal:
                    // nothing was saved, nothing typed was lost, and the way
                    // out is to reload rather than to retry the same write.
                    Box(
                        Modifier.testTag(
                            if (state.hasVersionConflict) {
                                TemplateEditorTestTags.CONFLICT
                            } else {
                                TemplateEditorTestTags.ERROR
                            },
                        ),
                    ) {
                        StatusCard(message = error, isError = true)
                    }
                }
            }

            // While a save is in flight the form is inert rather than merely
            // disabled field by field: a tap that lands mid-write would edit
            // something the request has already sent.
            if (state.isSaving) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .testTag(TemplateEditorTestTags.SAVING)
                        .pointerInput(Unit) {
                            awaitPointerEventScope {
                                while (true) awaitPointerEvent().changes.forEach { it.consume() }
                            }
                        },
                )
            }
        }
    }

    AppDialogHost(dialogs)
}

/**
 * Drops focus as soon as the form is dragged, which puts the keyboard away.
 *
 * The Flutter editor asks for this with
 * `ScrollViewKeyboardDismissBehavior.onDrag`; Compose has no such property, so
 * it is a nested-scroll connection that clears focus before the scroll runs.
 */
@Composable
private fun Modifier.dismissKeyboardOnScroll(): Modifier {
    val focus: FocusManager = LocalFocusManager.current
    val connection = remember(focus) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (available.y != 0f) focus.clearFocus()
                return Offset.Zero
            }
        }
    }
    return nestedScroll(connection)
}

/** The handles a UI test finds this screen's parts by. */
object TemplateEditorTestTags {
    const val SCREEN = "environment-editor-screen"
    const val CANCEL = "environment-editor-cancel"
    const val SAVE = "environment-editor-save"
    const val NAME_SECTION = "environment-editor-name-section"
    const val AGENT_INSTRUCTIONS = "environment-editor-agent-instructions"
    const val SETUP_SCRIPT = "environment-editor-setup-script"
    const val BAKE_SCRIPT = "environment-editor-bake-script"
    const val NETWORK = "environment-editor-network"
    const val SAVING = "environment-editor-saving"
    const val ERROR = "environment-editor-error"
    const val CONFLICT = "environment-editor-conflict"

    /** Set by `AppOptionPicker` itself, from its visible label. */
    const val NETWORK_ACCESS_PICKER = "app-option-picker-Network access"
}
