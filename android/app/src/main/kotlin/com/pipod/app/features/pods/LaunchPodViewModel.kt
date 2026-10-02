package com.pipod.app.features.pods

import com.pipod.app.core.session.ModelMemory
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pipod.app.core.api.model.Pod
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.workstation.WorkstationAttemptPolicy
import com.pipod.app.core.workstation.WorkstationStatusSource
import com.pipod.app.core.workstation.WorkstationWaitOutcome
import com.pipod.app.core.workstation.WorkstationWaitSession
import com.pipod.app.core.workstation.WorkstationWaitState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The launch form and the environment catalog it needs, as one state.
 *
 * The Flutter client splits these into `LaunchPodRoute` (which loads) and
 * `LaunchPodView` (which is the form), because a `FutureBuilder` cannot hand a
 * form its own state. One state object with a null [templates] meaning "still
 * loading" says the same thing without the second widget.
 */
data class LaunchPodState(
    val templates: List<PodTemplate>? = null,
    val unsupportedTemplateCount: Int = 0,
    val templatesError: String? = null,
    val selectedTemplateId: String? = null,
    val isLaunching: Boolean = false,
    val error: String? = null,
    /**
     * True when this came from a failed pod's Edit & retry: the form replaces
     * that pod rather than creating an unrelated one, so it says so.
     */
    val isRetry: Boolean = false,
    /**
     * The reader's own personal workstation, when the launch found it not ready.
     * The launch is not lost while this is showing: the same request is
     * re-issued on the wait's schedule, so nothing here suggests a duplicate.
     */
    val workstationWait: WorkstationWaitState? = null,
) {

    /** Every environment the server returns can be launched from. */
    val launchable: List<PodTemplate> get() = templates.orEmpty()

    val selectedTemplate: PodTemplate?
        get() = launchable.firstOrNull { it.id == selectedTemplateId }

    val isLoadingTemplates: Boolean get() = templates == null && templatesError == null

    val title: String get() = if (isRetry) "Retry pod" else "New pod"

    /** What picking this environment will actually do to the new pod. */
    val templateFooter: String
        get() {
            val template = selectedTemplate
            val start = when {
                template == null ->
                    "Starts a pod with an empty filesystem. Pick an environment to have its " +
                        "setup script run first."

                !template.initScript.isNullOrEmpty() ->
                    "Runs this environment's setup script before you connect."

                else -> "This environment has no setup script, so the pod starts empty."
            }
            return "$start Your saved secrets and connected model providers travel into it."
        }
}

/** The launch finished; only the caller knows where the new pod should open. */
sealed interface LaunchPodEvent {
    data class Launched(val pod: Pod) : LaunchPodEvent
}

/**
 * The launch flow's state machine, ported from
 * `pi-pod-flutter/lib/features/pods/launch_pod_view.dart` and
 * `launch_pod_route.dart`.
 */
class LaunchPodViewModel(
    private val repository: PodRepository,
    private val initialTemplateId: String? = null,
    isRetry: Boolean = false,
    private val serverHost: String? = RuntimeConfig.serverUrl,
) : ViewModel() {

    private val _state = MutableStateFlow(LaunchPodState(isRetry = isRetry))
    val state: StateFlow<LaunchPodState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<LaunchPodEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<LaunchPodEvent> = _events.asSharedFlow()

    private val workstationWait = WorkstationWaitSession(
        status = WorkstationStatusSource { repository.workstation(it) },
        onState = { wait -> _state.update { it.copy(workstationWait = wait) } },
        // `POST /v1/pods` carries no idempotency key: a re-issue is a second pod.
        policy = LAUNCH_POLICY,
    )

    init {
        loadTemplates()
    }

    /**
     * Loads the catalog before the form is usable: the picker needs the list,
     * and a spinner is better than an empty dropdown.
     */
    fun loadTemplates() {
        viewModelScope.launch {
            _state.update { it.copy(templatesError = null) }
            try {
                val templates = repository.templates()
                _state.update { current ->
                    current.copy(
                        templates = templates.items,
                        unsupportedTemplateCount = templates.unparsedRows.size,
                        templatesError = null,
                        // Only a real environment prefills the form — a retry
                        // whose environment has since been deleted starts from
                        // "None (empty pod)".
                        selectedTemplateId = current.selectedTemplateId
                            ?: templates.items.firstOrNull { it.id == initialTemplateId }?.id,
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                _state.update {
                    it.copy(templatesError = FriendlyError.message(error, serverHost))
                }
            }
        }
    }

    /** Null is the built-in default: a pod with an empty filesystem. */
    fun selectTemplate(templateId: String?) {
        _state.update { it.copy(selectedTemplateId = templateId) }
    }

    fun launch() {
        if (_state.value.isLaunching) return
        viewModelScope.launch {
            val templateId = _state.value.selectedTemplateId
            _state.update { it.copy(isLaunching = true, error = null, workstationWait = null) }
            try {
                val pod = repository.launch(templateId)
                ModelMemory.launched(pod.id)
                _events.tryEmit(LaunchPodEvent.Launched(pod))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                // A workstation that is not ready is a wait, not a failed launch:
                // the same request is re-issued until the server admits it.
                when (val outcome = workstationWait.run(error) { repository.launch(templateId) }) {
                    null -> _state.update { it.copy(error = launchFailure(error)) }

                    is WorkstationWaitOutcome.Ready -> {
                        ModelMemory.launched(outcome.value.id)
                        _events.tryEmit(LaunchPodEvent.Launched(outcome.value))
                    }

                    is WorkstationWaitOutcome.Failed -> _state.update {
                        it.copy(error = launchFailure(outcome.error))
                    }

                    else -> Unit
                }
            } finally {
                _state.update { it.copy(isLaunching = false) }
            }
        }
    }

    /** Ends this app's wait. The workstation keeps starting on the server. */
    fun cancelWorkstationWait() = workstationWait.cancel()

    /** Drops a finished wait's resting card and launches again. */
    fun retryAfterWorkstationWait() {
        workstationWait.clear()
        launch()
    }

    /**
     * A failed launch, worded so a second tap cannot silently make two pods.
     *
     * A launch that never got an answer may well have been accepted: the create
     * is not idempotent, so "try again" is exactly the wrong instruction until
     * the reader has looked. A refusal the server put into words is left as it
     * is — nothing was created, and the extra sentence would only be noise.
     */
    private fun launchFailure(error: Throwable): String {
        val message = FriendlyError.message(error, serverHost)
        if (!LAUNCH_POLICY.outcomeUnknown(error)) return message
        return "$message $LAUNCH_OUTCOME_UNKNOWN"
    }

    companion object {
        private val LAUNCH_POLICY = WorkstationAttemptPolicy.CreatesSomething

        /** Said after a launch whose answer was lost, never after a refusal. */
        const val LAUNCH_OUTCOME_UNKNOWN: String =
            "The pod may still have been created — check the pod list before launching another."
    }
}
