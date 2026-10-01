package com.pipod.app.features.templates

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.EnvironmentEditorData
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * Everything the reader can change in the editor.
 *
 * Held as one value so "has anything changed" is a single comparison against
 * the snapshot the editor opened with, rather than seven remembered strings.
 */
data class TemplateEditorFields(
    val name: String = "",
    val description: String = "",
    val script: String = "",
    val bakeScript: String = "",
    val allowedHosts: String = "",
    val egressMode: String = EgressSettings.OPEN,
    val includeBuiltins: Boolean = true,
)

/** Everything the environment editor draws. */
data class TemplateEditorState(
    val fields: TemplateEditorFields = TemplateEditorFields(),
    /** What the editor opened with, which is what [isDirty] compares against. */
    val initial: TemplateEditorFields = TemplateEditorFields(),
    val isSaving: Boolean = false,
    val error: String? = null,
    val isEditing: Boolean = false,
    /**
     * True when the server refused the save because the environment changed
     * underneath. Everything typed is still here — discarding it would punish
     * the reader for someone else's write.
     */
    val hasVersionConflict: Boolean = false,
) {
    val isDirty: Boolean get() = fields != initial

    val trimmedName: String get() = fields.name.trim()

    /** An environment has to be named before it can be written. */
    val canSave: Boolean get() = trimmedName.isNotEmpty() && !isSaving

    val subject: String get() = if (isEditing) "Edit environment" else "New environment"

    val action: String get() = if (isEditing) "Save" else "Create"

    val actionLabel: String get() = if (isSaving) "Saving…" else action

    val setupScriptFooter: String
        get() = if (isEditing) {
            "Runs at pod launch with your secrets available. Pods already running keep the " +
                "script they started with."
        } else {
            "Runs at pod launch with your secrets available. Leave it empty to start pods bare."
        }

    val discardMessage: String
        get() = if (isEditing) {
            "Your edits to this environment will be lost."
        } else {
            "This new environment will be lost."
        }

    companion object {
        const val CONFLICT_MESSAGE: String =
            "This environment changed elsewhere while you were editing it, so nothing was " +
                "saved. Your text is still here — close and reopen the editor to load the " +
                "newer version, then reapply what you need."
    }
}

/** The write landed; only the caller knows what to do with the result. */
sealed interface TemplateEditorEvent {
    data class Saved(
        val template: PodTemplate,
        val editorData: EnvironmentEditorData,
    ) : TemplateEditorEvent
}

/**
 * The environment editor's state machine, ported from `TemplateEditorView` in
 * `pi-pod-flutter/lib/features/templates/template_list_view.dart`.
 */
class TemplateEditorViewModel(
    private val repository: TemplateRepository,
    private val template: PodTemplate? = null,
    editorData: EnvironmentEditorData? = null,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    /**
     * The config as the server last sent it. Everything this build does not
     * understand is written straight back, so editing the network settings
     * cannot quietly drop a key a newer server added.
     */
    private val baseConfig: JsonObject =
        editorData?.config ?: template?.config ?: JsonObject(emptyMap())

    /**
     * Whether this editor ever saw the stored bake script.
     *
     * It arrives from a second request, and an editor opened before that landed
     * has an empty field that means "not loaded", not "empty". Writing that
     * back would erase a script the reader never saw, so the key is omitted
     * from the update instead.
     */
    private val bakeScriptLoaded: Boolean = editorData != null

    /** The version the editor read, sent back so a concurrent write is caught. */
    private val readVersion: Int? = template?.version

    private val _state: MutableStateFlow<TemplateEditorState>
    val state: StateFlow<TemplateEditorState>

    private val _events = MutableSharedFlow<TemplateEditorEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<TemplateEditorEvent> = _events.asSharedFlow()

    init {
        val egress = EgressSettings.from(baseConfig)
        val opened = TemplateEditorFields(
            name = template?.name.orEmpty(),
            description = template?.description.orEmpty(),
            script = template?.initScript.orEmpty(),
            bakeScript = editorData?.bakeScript.orEmpty(),
            allowedHosts = egress.allow.joinToString("\n"),
            egressMode = egress.mode,
            includeBuiltins = egress.builtins,
        )
        _state = MutableStateFlow(
            TemplateEditorState(
                fields = opened,
                initial = opened,
                isEditing = template != null,
            ),
        )
        state = _state.asStateFlow()
    }

    fun setName(value: String) = update { it.copy(name = value) }

    fun setDescription(value: String) = update { it.copy(description = value) }

    fun setScript(value: String) = update { it.copy(script = value) }

    fun setBakeScript(value: String) = update { it.copy(bakeScript = value) }

    fun setAllowedHosts(value: String) = update { it.copy(allowedHosts = value) }

    fun setEgressMode(value: String) = update { it.copy(egressMode = value) }

    fun setIncludeBuiltins(value: Boolean) = update { it.copy(includeBuiltins = value) }

    private fun update(transform: (TemplateEditorFields) -> TemplateEditorFields) {
        _state.update { it.copy(fields = transform(it.fields)) }
    }

    fun save() {
        if (!_state.value.canSave) return
        viewModelScope.launch {
            _state.update { it.copy(isSaving = true, error = null) }
            try {
                val fields = _state.value.fields
                val description = fields.description.trim()
                val script = fields.script.trim()
                val bakeScript = fields.bakeScript.trim()
                val config = updatedConfig(fields)
                val existing = template
                // A new environment always writes what was typed; an edit only
                // writes a bake script this editor actually loaded.
                val writesBakeScript = existing == null || bakeScriptLoaded
                val saved = if (existing != null) {
                    repository.update(
                        id = existing.id,
                        name = _state.value.trimmedName,
                        description = description,
                        initScript = script,
                        bakeScript = bakeScript.takeIf { bakeScriptLoaded },
                        config = config,
                        expectedVersion = readVersion,
                    )
                } else {
                    repository.create(
                        name = _state.value.trimmedName,
                        description = description.ifEmpty { null },
                        initScript = script.ifEmpty { null },
                        bakeScript = bakeScript.ifEmpty { null },
                        config = config,
                    )
                }
                // A saved editor is no longer dirty, so leaving it must not
                // prompt: the snapshot moves up to what was just written.
                _state.update { it.copy(initial = it.fields, hasVersionConflict = false) }
                _events.tryEmit(
                    TemplateEditorEvent.Saved(
                        template = saved,
                        editorData = EnvironmentEditorData(
                            // Null means "unchanged and unknown" rather than
                            // "empty", so a screen folding this back in cannot
                            // adopt a bake script this editor never held.
                            bakeScript = bakeScript.takeIf { writesBakeScript },
                            config = config,
                        ),
                    ),
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (isVersionConflict(error)) {
                    // Not a failure the reader caused, and not one a retry
                    // fixes: the fields stay exactly as typed.
                    _state.update {
                        it.copy(
                            error = TemplateEditorState.CONFLICT_MESSAGE,
                            hasVersionConflict = true,
                        )
                    }
                } else {
                    _state.update {
                        it.copy(
                            error = FriendlyError.message(error, serverHost),
                            hasVersionConflict = false,
                        )
                    }
                }
            } finally {
                _state.update { it.copy(isSaving = false) }
            }
        }
    }

    /** [baseConfig] with only this screen's three egress keys replaced. */
    internal fun updatedConfig(fields: TemplateEditorFields): JsonObject = EgressSettings.write(
        baseConfig,
        EgressSettings(
            restricted = fields.egressMode == EgressSettings.ALLOWLIST,
            builtins = fields.includeBuiltins,
            allow = parseHosts(fields.allowedHosts),
        ),
    )

    companion object {
        /**
         * A refused write, told apart from every other failure by status and
         * wording: the server answers 409 for a stale `expectedVersion`, and
         * also for a duplicate name, which is the reader's to fix.
         */
        internal fun isVersionConflict(error: Throwable): Boolean {
            if (error !is ApiError || error.transportStatus != 409) return false
            return error.error.contains("version conflict", ignoreCase = true)
        }

        /** One host per line, and a pasted comma-separated list works too. */
        internal fun parseHosts(raw: String): List<String> = raw
            .split(HOST_SEPARATORS)
            .map { it.trim() }
            .filter { it.isNotEmpty() }

        private val HOST_SEPARATORS = Regex("[\\r\\n,]+")
    }
}
