package com.pipod.app.features.templates

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.EnvironmentEditorData
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.api.model.SecretMeta
import com.pipod.app.features.common.SecretEntryFields
import com.pipod.app.features.common.UnsupportedListItemCard
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppDialogHost
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListScaffold
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppProgressBar
import com.pipod.app.ui.AppSectionStyle
import com.pipod.app.ui.AppSelectableText
import com.pipod.app.ui.AppSeparator
import com.pipod.app.ui.rememberAppDialogHostState
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/**
 * The environment detail, wired to its view model.
 *
 * Port of `TemplateDetailView` in
 * `pi-pod-flutter/lib/features/templates/template_list_view.dart`.
 *
 * @param onEdit receives the editor data the form needs. It is fetched here
 *   rather than by the editor, because a detail that already has it should not
 *   make the reader wait for a second round trip to start typing.
 */
@Composable
fun TemplateDetailScreen(
    viewModel: TemplateDetailViewModel,
    onBack: () -> Unit,
    onEdit: (PodTemplate, EnvironmentEditorData) -> Unit,
    modifier: Modifier = Modifier,
    onChanged: () -> Unit = {},
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                TemplateDetailEvent.Changed -> onChanged()
                TemplateDetailEvent.Deleted -> onBack()
            }
        }
    }

    TemplateDetailScreen(
        state = state,
        onBack = onBack,
        onRefresh = viewModel::refresh,
        onEdit = {
            scope.launch {
                val data = viewModel.editorDataForEditing() ?: return@launch
                onEdit(state.template, data)
            }
        },
        onDelete = viewModel::deleteTemplate,
        onSecretNameChange = viewModel::setSecretName,
        onSecretValueChange = viewModel::setSecretValue,
        onSaveSecret = viewModel::saveSecret,
        onDeleteSecret = viewModel::deleteSecret,
        onDiscardSecretDraft = viewModel::clearSecretDraft,
        modifier = modifier,
        dialogs = dialogs,
    )
}

/** The environment detail as a pure function of [state]. */
@Composable
fun TemplateDetailScreen(
    state: TemplateDetailState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onSecretNameChange: (String) -> Unit,
    onSecretValueChange: (String) -> Unit,
    onSaveSecret: () -> Unit,
    onDeleteSecret: (SecretMeta) -> Unit,
    onDiscardSecretDraft: () -> Unit,
    modifier: Modifier = Modifier,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val scope = rememberCoroutineScope()
    val name = state.template.name
    // True while the discard confirmation is on screen, so a second back press
    // cannot stack a duplicate dialog on top of the first.
    val confirming = remember { mutableStateOf(false) }

    // An unsaved secret draft blocks the system back gesture until it is
    // confirmed, the same way the editor guards unsaved changes. A save in
    // flight blocks it outright: back must not drop a pending write.
    BackHandler(enabled = state.isSavingSecret || state.hasSecretDraft) {
        if (state.isSavingSecret || !state.hasSecretDraft || confirming.value) return@BackHandler
        confirming.value = true
        scope.launch {
            try {
                val discard = dialogs.confirm(
                    title = "Discard secret?",
                    message = "The secret name and value you entered have not been saved.",
                    confirmLabel = "Discard",
                    cancelLabel = "Keep editing",
                    destructive = true,
                    confirmSemanticsLabel = "Confirm discard unsaved secret",
                    cancelSemanticsLabel = "Keep editing unsaved secret",
                )
                if (discard) {
                    onDiscardSecretDraft()
                    onBack()
                }
            } finally {
                confirming.value = false
            }
        }
    }

    AppListScaffold(
        title = name,
        modifier = modifier.testTag(TemplateDetailTestTags.SCREEN),
        onNavigateBack = onBack,
        grouped = true,
        onRefresh = onRefresh,
        isRefreshing = state.isRefreshing,
        refreshSemanticsLabel = "Refresh environment $name",
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 32.dp),
        actions = {
            AppButton(
                text = "Edit",
                onClick = onEdit,
                kind = AppButtonKind.Plain,
                enabled = !state.isDeleting,
                semanticsLabel = "Edit environment $name",
                modifier = Modifier.testTag(TemplateDetailTestTags.EDIT),
            )
        },
    ) {
        templateDetailRows(
            state = state,
            onDelete = {
                scope.launch {
                    val confirmed = dialogs.confirm(
                        title = "Delete “$name”?",
                        message = "New pods can no longer be launched from it. " +
                            "Pods already running are unaffected.",
                        confirmLabel = "Delete environment",
                        destructive = true,
                        confirmSemanticsLabel = "Confirm delete detail environment $name",
                        cancelSemanticsLabel = "Cancel deleting $name",
                    )
                    if (confirmed) onDelete()
                }
            },
            onSecretNameChange = onSecretNameChange,
            onSecretValueChange = onSecretValueChange,
            onSaveSecret = onSaveSecret,
            onDeleteSecret = { secret ->
                scope.launch {
                    val confirmed = dialogs.confirm(
                        title = "Delete ${secret.name}?",
                        message = "Pods launched from this environment will no longer receive it.",
                        confirmLabel = "Delete secret",
                        destructive = true,
                        confirmSemanticsLabel = "Confirm delete environment secret ${secret.name}",
                        cancelSemanticsLabel = "Cancel deleting environment secret ${secret.name}",
                    )
                    if (confirmed) onDeleteSecret(secret)
                }
            },
        )
    }

    AppDialogHost(dialogs)
}

private fun LazyListScope.templateDetailRows(
    state: TemplateDetailState,
    onDelete: () -> Unit,
    onSecretNameChange: (String) -> Unit,
    onSecretValueChange: (String) -> Unit,
    onSaveSecret: () -> Unit,
    onDeleteSecret: (SecretMeta) -> Unit,
) {
    val name = state.template.name

    val message = state.message
    if (message != null) {
        item(key = "message") {
            StatusCard(message = message, isError = state.messageIsError)
            Spacer(Modifier.height(12.dp))
        }
    }

    item(key = "overview") {
        SectionCard(modifier = Modifier.testTag(TemplateDetailTestTags.OVERVIEW)) {
            LabeledValue(label = "Status", value = state.statusLabel)
            state.template.description?.takeIf { it.isNotEmpty() }?.let {
                LabeledValue(label = "Description", value = it)
            }
            if (state.template.createdFromPod != null) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = AppIcons.resources,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("Created by an agent inside a pod", modifier = Modifier.weight(1f))
                }
            }
        }
        Spacer(Modifier.height(12.dp))
    }

    item(key = "setup-script") {
        SectionCard(
            title = "Setup script",
            footer = state.setupScriptFooter,
            modifier = Modifier.testTag(TemplateDetailTestTags.SETUP_SCRIPT),
        ) {
            val script = state.template.initScript
            if (script.isNullOrEmpty()) {
                Text(
                    text = "No setup script — pods from this environment start empty.",
                    color = appColors.secondaryLabel,
                )
            } else {
                AppSelectableText(
                    text = script,
                    style = MonospaceTextStyle,
                    semanticsLabel = "Setup script: $script",
                )
            }
        }
        Spacer(Modifier.height(12.dp))
    }

    item(key = "bake-script") {
        SectionCard(
            title = "Bake script",
            footer = "Runs when the environment image is built, not each time a pod launches.",
            modifier = Modifier.testTag(TemplateDetailTestTags.BAKE_SCRIPT),
        ) {
            val bake = state.editorData?.bakeScript
            when {
                state.editorData == null ->
                    AppProgressBar(progress = null, modifier = Modifier.fillMaxWidth())

                bake.isNullOrEmpty() -> Text("No bake script.")
                else -> AppSelectableText(
                    text = bake,
                    style = MonospaceTextStyle,
                    semanticsLabel = "Bake script: $bake",
                )
            }
        }
        Spacer(Modifier.height(12.dp))
    }

    item(key = "network") {
        SectionCard(
            title = "Network / egress",
            footer = "Controls which hosts pods launched from this environment can reach.",
            modifier = Modifier.testTag(TemplateDetailTestTags.NETWORK),
        ) {
            val data = state.editorData
            if (data == null) {
                AppProgressBar(progress = null, modifier = Modifier.fillMaxWidth())
            } else {
                val egress = EgressSettings.from(data.config)
                LabeledValue(
                    label = "Network access",
                    value = if (egress.restricted) "Restricted" else "Open",
                )
                LabeledValue(
                    label = "Built-in services",
                    value = if (egress.builtins) "Allowed" else "Blocked",
                )
                LabeledValue(
                    label = "Allowed hosts",
                    value = if (egress.allow.isEmpty()) "None" else egress.allow.joinToString(", "),
                )
            }
        }
        Spacer(Modifier.height(12.dp))
    }

    item(key = "secrets") {
        SectionCard(
            title = "Environment secrets (write-only)",
            footer = "Values can be replaced or deleted but never read back — not even by the " +
                "agent that drafted this environment. They are injected into pods launched " +
                "from it.",
            modifier = Modifier.testTag(TemplateDetailTestTags.SECRETS),
        ) {
            repeat(state.unsupportedSecretCount) { UnsupportedListItemCard(itemName = "secret") }
            state.secrets.forEach { secret ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = secret.name,
                        style = MonospaceTextStyle,
                        modifier = Modifier.weight(1f),
                    )
                    AppIconButton(
                        icon = AppIcons.delete,
                        onClick = { onDeleteSecret(secret) },
                        semanticsLabel = "Delete environment secret ${secret.name}",
                    )
                }
            }
            if (state.secrets.isNotEmpty()) AppSeparator()
            SecretEntryFields(
                name = state.secretName,
                onNameChange = onSecretNameChange,
                value = state.secretValue,
                onValueChange = onSecretValueChange,
                semanticsPrefix = "Environment secret",
                isSaving = state.isSavingSecret,
                onSave = onSaveSecret,
            )
        }
        Spacer(Modifier.height(12.dp))
    }

    item(key = "delete") {
        SectionCard(modifier = Modifier.testTag(TemplateDetailTestTags.DELETE_SECTION)) {
            AppButton(
                text = if (state.isDeleting) "Deleting…" else "Delete environment",
                onClick = onDelete,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(TemplateDetailTestTags.DELETE),
                kind = AppButtonKind.Plain,
                destructive = true,
                enabled = !state.isDeleting,
                semanticsLabel = "Delete detail environment $name",
            )
        }
    }
}

/** A titled block of form content, the shape every section on this screen takes. */
@Composable
internal fun SectionCard(
    modifier: Modifier = Modifier,
    title: String? = null,
    footer: String? = null,
    content: @Composable () -> Unit,
) {
    AppListSection(modifier = modifier, header = title, footer = footer) {
        row {
            Column(Modifier.fillMaxWidth().padding(16.dp)) { content() }
        }
    }
}

/** One `label: value` line, read as a single node. */
@Composable
internal fun LabeledValue(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 5.dp)
            .semantics(mergeDescendants = true) { contentDescription = "$label, $value" },
        verticalAlignment = Alignment.Top,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(16.dp))
        Text(text = value, textAlign = TextAlign.End, fontWeight = FontWeight.Medium)
    }
}

/**
 * What just happened, announced as it appears.
 *
 * It is a live region because the thing it reports — a secret saved, a delete
 * that failed — happens somewhere else on the screen than where the reader's
 * focus is.
 */
@Composable
internal fun StatusCard(message: String, isError: Boolean) {
    AppListSection(
        modifier = Modifier
            .testTag(TemplateDetailTestTags.STATUS_CARD)
            .semantics(mergeDescendants = true) {
                contentDescription = "${if (isError) "Error" else "Success"}: $message"
                liveRegion = LiveRegionMode.Polite
            },
        style = AppSectionStyle.Separated,
    ) {
        row {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        if (isError) {
                            appColors.destructiveFill
                        } else {
                            appColors.success.copy(alpha = 0.12f)
                        },
                    )
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = if (isError) AppIcons.warning else AppIcons.successOutline,
                    contentDescription = null,
                )
                Spacer(Modifier.width(8.dp))
                Text(message, modifier = Modifier.weight(1f))
            }
        }
    }
}

/** The handles a UI test finds this screen's parts by. */
object TemplateDetailTestTags {
    const val SCREEN = "environment-detail-screen"
    const val EDIT = "environment-detail-edit"
    const val OVERVIEW = "environment-detail-overview"
    const val SETUP_SCRIPT = "environment-detail-setup-script"
    const val BAKE_SCRIPT = "environment-detail-bake-script"
    const val NETWORK = "environment-detail-network"
    const val SECRETS = "environment-detail-secrets"
    const val DELETE_SECTION = "environment-detail-delete-section"
    const val DELETE = "environment-detail-delete"
    const val STATUS_CARD = "environment-status-card"
}
