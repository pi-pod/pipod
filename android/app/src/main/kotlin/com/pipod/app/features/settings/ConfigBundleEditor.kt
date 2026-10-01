package com.pipod.app.features.settings

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.api.model.SettingsLayer
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.features.common.PlainTextEditor
import com.pipod.app.ui.AppActivityIndicator
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppDialogHostState
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppProgressBar
import com.pipod.app.ui.rememberAppDialogHostState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Reads one settings layer, with the version the write will have to match. */
fun interface ConfigBundleLoader {
    suspend fun load(): SettingsLayer
}

/** Writes one settings layer back, and answers with its new version. */
fun interface ConfigBundleSaver {
    suspend fun save(config: JsonObject, initScript: String, bakeScript: String, version: Int): Int
}

/** Everything the config bundle editor draws. */
data class ConfigBundleEditorUiState(
    val isExpanded: Boolean = false,
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    /**
     * True while the discard confirmation is on screen, so a second trigger
     * (Reload tapped twice) cannot stack a duplicate dialog.
     */
    val isConfirming: Boolean = false,
    /** The version that was read. Null until the bundle has been loaded once. */
    val version: Int? = null,
    val config: String = "",
    val initScript: String = "",
    val bakeScript: String = "",
    val status: String? = null,
    val statusIsError: Boolean = false,
    /** Last loaded or saved contents, which Save arms against. */
    val baseConfig: String = "",
    val baseInitScript: String = "",
    val baseBakeScript: String = "",
) {
    val isLoaded: Boolean get() = version != null

    val isBusy: Boolean get() = isLoading || isSaving

    val isDirty: Boolean
        get() = isLoaded &&
            (config != baseConfig || initScript != baseInitScript || bakeScript != baseBakeScript)

    /**
     * A pristine save would round-trip version N to N+1 with no diff — and take
     * everyone else's editor out of date for nothing — so Save arms only once
     * the fields differ from the baseline.
     */
    fun canSave(canEdit: Boolean): Boolean =
        isLoaded && isDirty && !isBusy && !isConfirming && canEdit
}

/**
 * A settings layer loaded on demand and written back with the version it was
 * read at.
 *
 * Ported from `ConfigBundleEditor` in
 * `pi-pod-flutter/lib/features/settings/config_bundle_editor.dart`. The server
 * refuses a write carrying a stale version rather than applying it, which is
 * the whole point: two people editing an organization's defaults must not have
 * the later save silently erase the earlier one. A refused save keeps the typed
 * edits and the old baseline, says what happened, and leaves reloading to the
 * reader — retrying with the same version would only be refused again, and
 * retrying with a fresh one is exactly the overwrite this prevents.
 *
 * A plain state holder rather than a `ViewModel`: three of these can be on the
 * settings screen at once, and each is a piece of that screen rather than a
 * screen of its own.
 */
class ConfigBundleEditorState(
    /** Lower-case noun phrase used in every accessible name, unique per screen. */
    val subject: String,
    val description: String,
    private val load: ConfigBundleLoader,
    private val save: ConfigBundleSaver,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) {

    private val _state = MutableStateFlow(ConfigBundleEditorUiState())
    val state: StateFlow<ConfigBundleEditorUiState> = _state.asStateFlow()

    val capitalizedSubject: String get() = subject.replaceFirstChar { it.uppercase() }

    fun onConfigChange(value: String) = _state.update { it.copy(config = value) }

    fun onInitScriptChange(value: String) = _state.update { it.copy(initScript = value) }

    fun onBakeScriptChange(value: String) = _state.update { it.copy(bakeScript = value) }

    /** Opens or closes the disclosure, loading the bundle the first time it opens. */
    suspend fun toggle() {
        val expanded = !_state.value.isExpanded
        _state.update { it.copy(isExpanded = expanded, status = null) }
        // Nothing to discard on the first open, so the confirmation never runs.
        if (expanded && _state.value.version == null) reload { true }
    }

    /**
     * Re-reads the bundle. [confirmDiscard] is asked only when the fields differ
     * from what was last loaded or saved; answering no leaves every field
     * untouched.
     */
    suspend fun reload(confirmDiscard: suspend () -> Boolean) {
        val before = _state.value
        if (before.isBusy || before.isConfirming) return
        if (before.isDirty) {
            _state.update { it.copy(isConfirming = true) }
            val discard = try {
                confirmDiscard()
            } finally {
                _state.update { it.copy(isConfirming = false) }
            }
            if (!discard) return
            if (_state.value.isBusy) return
        }

        _state.update { it.copy(isLoading = true, status = null) }
        try {
            val layer = load.load()
            val config = PRETTY.encodeToString(JsonElement.serializer(), layer.config)
            _state.update {
                it.copy(
                    version = layer.version,
                    config = config,
                    initScript = layer.initScript,
                    bakeScript = layer.bakeScript,
                    baseConfig = config,
                    baseInitScript = layer.initScript,
                    baseBakeScript = layer.bakeScript,
                )
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            show(FriendlyError.message(error, serverHost), isError = true)
        } finally {
            _state.update { it.copy(isLoading = false) }
        }
    }

    /**
     * Re-reads the bundle when it is open and has nothing unsaved in it.
     *
     * For a change that landed somewhere else — applying a settings proposal
     * writes the very layer this editor is showing — where silently leaving
     * the old contents on screen would invite a save carrying a version the
     * server has already moved past. Typed edits are never discarded: a dirty
     * editor keeps what is in it and the reader reloads deliberately.
     */
    suspend fun reloadIfClean() {
        val current = _state.value
        if (!current.isExpanded || !current.isLoaded || current.isDirty) return
        reload { true }
    }

    suspend fun saveNow() {
        val current = _state.value
        val version = current.version ?: return
        if (current.isBusy || current.isConfirming) return

        val text = current.config.trim().ifEmpty { "{}" }
        val config = runCatching { PRETTY.parseToJsonElement(text) }.getOrNull() as? JsonObject
        if (config == null) {
            show("Config must be a JSON object, such as {}.", isError = true)
            return
        }

        _state.update { it.copy(isSaving = true, status = null) }
        try {
            val saved = save.save(
                config = config,
                initScript = current.initScript,
                bakeScript = current.bakeScript,
                version = version,
            )
            val pretty = PRETTY.encodeToString(JsonElement.serializer(), config)
            _state.update {
                it.copy(
                    version = saved,
                    config = pretty,
                    // Saved contents become the new clean baseline; a failed save
                    // leaves the previous baseline — and the typed edits — alone.
                    baseConfig = pretty,
                    baseInitScript = it.initScript,
                    baseBakeScript = it.bakeScript,
                )
            }
            show("$capitalizedSubject saved.", isError = false)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            show(FriendlyError.message(error, serverHost), isError = true)
        } finally {
            _state.update { it.copy(isSaving = false) }
        }
    }

    private fun show(message: String, isError: Boolean) {
        _state.update { it.copy(status = message, statusIsError = isError) }
    }

    private companion object {
        /**
         * Keys are left in the order the server sent them: this is a document
         * somebody edits by hand, and re-ordering their file on every load would
         * show as a diff nobody made.
         */
        val PRETTY = Json {
            prettyPrint = true
            prettyPrintIndent = "  "
        }
    }
}

/**
 * One editor per layer, kept across recompositions of the settings screen.
 *
 * @param layerId which layer this editor is showing — an organization id or a
 *   user id. It is part of the remember key, not decoration: the editor holds
 *   the loaded text *and the version the save has to match*, and switching
 *   organization used to leave both behind. The next Save then either wrote one
 *   organization's defaults into another or was refused with a version conflict
 *   the reader could make no sense of.
 */
@Composable
fun rememberConfigBundleEditor(
    subject: String,
    description: String,
    layerId: String,
    load: ConfigBundleLoader,
    save: ConfigBundleSaver,
    serverHost: String? = RuntimeConfig.serverUrl,
): ConfigBundleEditorState {
    val currentLoad by rememberUpdatedState(load)
    val currentSave by rememberUpdatedState(save)
    return remember(subject, layerId) {
        ConfigBundleEditorState(
            subject = subject,
            description = description,
            load = { currentLoad.load() },
            save = { config, initScript, bakeScript, version ->
                currentSave.save(config, initScript, bakeScript, version)
            },
            serverHost = serverHost,
        )
    }
}

/** The config bundle editor, wired to its state holder. */
@Composable
fun ConfigBundleEditor(
    editor: ConfigBundleEditorState,
    modifier: Modifier = Modifier,
    canEdit: Boolean = true,
    readOnlyReason: String? = null,
    dialogs: AppDialogHostState = rememberAppDialogHostState(),
) {
    val state by editor.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current

    ConfigBundleEditor(
        subject = editor.subject,
        description = editor.description,
        state = state,
        onToggle = {
            focus.clearFocus()
            scope.launch { editor.toggle() }
        },
        onReload = {
            scope.launch {
                editor.reload {
                    dialogs.confirm(
                        title = "Discard changes?",
                        message = "Reloading this ${editor.subject} will discard your unsaved edits.",
                        confirmLabel = "Reload",
                        cancelLabel = "Keep editing",
                        confirmSemanticsLabel = "Confirm reload ${editor.subject}",
                        cancelSemanticsLabel = "Keep editing ${editor.subject}",
                    )
                }
            }
        },
        onSave = {
            focus.clearFocus()
            scope.launch { editor.saveNow() }
        },
        onConfigChange = editor::onConfigChange,
        onInitScriptChange = editor::onInitScriptChange,
        onBakeScriptChange = editor::onBakeScriptChange,
        modifier = modifier,
        canEdit = canEdit,
        readOnlyReason = readOnlyReason,
    )
}

/** The config bundle editor as a pure function of [state]. */
@Composable
fun ConfigBundleEditor(
    subject: String,
    description: String,
    state: ConfigBundleEditorUiState,
    onToggle: () -> Unit,
    onReload: () -> Unit,
    onSave: () -> Unit,
    onConfigChange: (String) -> Unit,
    onInitScriptChange: (String) -> Unit,
    onBakeScriptChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    canEdit: Boolean = true,
    readOnlyReason: String? = null,
) {
    val capitalized = subject.replaceFirstChar { it.uppercase() }
    val turn by animateFloatAsState(if (state.isExpanded) 180f else 0f, label = "bundle-chevron")
    val editable = !state.isBusy && canEdit

    Column(modifier.fillMaxWidth().testTag(ConfigBundleTestTags.editor(subject))) {
        Text(description)
        Spacer(Modifier.height(8.dp))
        AppButton(
            onClick = onToggle,
            modifier = Modifier
                .fillMaxWidth()
                .testTag(ConfigBundleTestTags.toggle(subject))
                .semantics {
                    stateDescription = if (state.isExpanded) "Expanded" else "Collapsed"
                },
            kind = AppButtonKind.Plain,
            // The name never flips with the state: the state is announced
            // separately, and a control that renames itself is a different
            // control to anything driving the screen by name.
            semanticsLabel = "Edit $subject",
        ) {
            Icon(
                imageVector = AppIcons.expand,
                contentDescription = null,
                modifier = Modifier.rotate(turn),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = if (state.isExpanded) "Hide $subject" else "Edit $subject",
                modifier = Modifier.weight(1f),
            )
        }

        if (!state.isExpanded) return@Column

        if (state.isLoading && !state.isLoaded) {
            AppProgressBar(
                progress = null,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp)
                    .semantics { contentDescription = "Loading $subject" },
            )
        }

        if (state.isLoaded) {
            if (!canEdit && readOnlyReason != null) {
                SettingsFootnote(text = readOnlyReason, modifier = Modifier.padding(bottom = 8.dp))
            }
            SettingsFieldLabel("Config (JSON)")
            Spacer(Modifier.height(4.dp))
            PlainTextEditor(
                value = state.config,
                onValueChange = onConfigChange,
                accessibilityLabel = "$capitalized config JSON",
                minHeight = 120.dp,
                enabled = editable,
            )
            Spacer(Modifier.height(12.dp))
            SettingsFieldLabel("Setup script")
            Spacer(Modifier.height(4.dp))
            PlainTextEditor(
                value = state.initScript,
                onValueChange = onInitScriptChange,
                accessibilityLabel = "$capitalized setup script",
                enabled = editable,
            )
            Spacer(Modifier.height(12.dp))
            SettingsFieldLabel("Bake script")
            Spacer(Modifier.height(4.dp))
            PlainTextEditor(
                value = state.bakeScript,
                onValueChange = onBakeScriptChange,
                accessibilityLabel = "$capitalized bake script",
                enabled = editable,
            )
            Spacer(Modifier.height(8.dp))
            SettingsFootnote(
                "Version ${state.version}. Saving is refused if someone else changed this " +
                    "bundle since it was loaded; reload to pick up their change.",
            )
            Spacer(Modifier.height(8.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AppButton(
                    onClick = onSave,
                    modifier = Modifier.testTag(ConfigBundleTestTags.save(subject)),
                    enabled = state.canSave(canEdit),
                    semanticsLabel = "Save $subject",
                ) {
                    if (state.isSaving) AppActivityIndicator(size = 18.dp) else Text("Save")
                }
                AppButton(
                    text = "Reload",
                    onClick = onReload,
                    modifier = Modifier.testTag(ConfigBundleTestTags.reload(subject)),
                    kind = AppButtonKind.Plain,
                    enabled = !state.isBusy && !state.isConfirming,
                    semanticsLabel = "Reload $subject",
                )
            }
        }

        if (!state.isLoaded && !state.isLoading && state.status != null) {
            Spacer(Modifier.height(8.dp))
            AppButton(
                text = "Try again",
                onClick = onReload,
                modifier = Modifier.testTag(ConfigBundleTestTags.retry(subject)),
                kind = AppButtonKind.Plain,
                enabled = !state.isBusy && !state.isConfirming,
                semanticsLabel = "Retry loading $subject",
            )
        }

        state.status?.let { status ->
            Spacer(Modifier.height(8.dp))
            SettingsStatusLabel(
                status = SettingsStatus(text = status, isError = state.statusIsError),
                modifier = Modifier.testTag(ConfigBundleTestTags.status(subject)),
            )
        }
    }
}

/** The handles a UI test finds one editor's parts by. */
object ConfigBundleTestTags {
    fun editor(subject: String) = "config-bundle-$subject"

    fun toggle(subject: String) = "config-bundle-toggle-$subject"

    fun save(subject: String) = "config-bundle-save-$subject"

    fun reload(subject: String) = "config-bundle-reload-$subject"

    fun retry(subject: String) = "config-bundle-retry-$subject"

    fun status(subject: String) = "config-bundle-status-$subject"
}
