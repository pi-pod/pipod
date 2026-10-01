package com.pipod.app.features.pods

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pipod.app.core.session.ModelCatalog
import com.pipod.app.core.session.ModelChoice
import com.pipod.app.core.session.SessionStream
import com.pipod.app.core.session.SessionStreamState
import com.pipod.app.features.common.EmptyState
import com.pipod.app.ui.AppButton
import com.pipod.app.ui.AppButtonDefaults
import com.pipod.app.ui.AppButtonKind
import com.pipod.app.ui.AppIconButton
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.AppListSection
import com.pipod.app.ui.AppListTile
import com.pipod.app.ui.AppScaffold
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.appScaffoldBackground
import com.pipod.app.ui.currentWindowWidth
import com.pipod.app.ui.isCompactWidth
import com.pipod.app.ui.rememberAppToastHostState
import com.pipod.app.ui.showAppToast
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/**
 * Everything the model picker draws.
 *
 * A projection of `SessionStreamState` rather than the whole thing: the picker
 * cares about six fields, and taking only those is what lets a UI test build
 * every variant — disconnected, mid-switch, empty catalog — by hand.
 */
data class ModelPickerState(
    val availableModels: List<ModelChoice> = emptyList(),
    val availableThinkingLevels: List<String> = emptyList(),
    val currentModel: ModelChoice? = null,
    val currentThinkingLevel: String? = null,
    val isConnected: Boolean = false,
    val isModelSwitchInFlight: Boolean = false,
    val isThinkingSwitchInFlight: Boolean = false,
    val error: String? = null,
) {

    val providers: List<String> get() = ModelCatalog.providers(availableModels, currentModel)

    val allModels: List<ModelChoice> get() = ModelCatalog.models(availableModels, currentModel)

    fun modelsIn(provider: String, query: String): List<ModelChoice> =
        ModelCatalog.modelsIn(provider, query, availableModels, currentModel)

    /**
     * A row stays usable while a switch is in flight only if it is the one
     * already selected, so the reader can see what is current without being
     * able to start a second switch on top of the first.
     */
    fun modelRowEnabled(model: ModelChoice): Boolean =
        (isConnected && !isModelSwitchInFlight) ||
            (model == currentModel && !isModelSwitchInFlight)

    fun thinkingRowEnabled(level: String): Boolean =
        (isConnected && !isThinkingSwitchInFlight) ||
            (level == currentThinkingLevel && !isThinkingSwitchInFlight)

    /**
     * What tapping this row would do — or why it would do nothing.
     *
     * A frozen row is also marked disabled, but "disabled" alone does not say
     * whether the reader should reconnect or simply wait, and the notice that
     * explains it is at the top of a screen they may not be looking at.
     */
    fun modelRowAction(model: ModelChoice): String = when {
        model == currentModel -> "Currently selected"
        isModelSwitchInFlight -> UNAVAILABLE_SWITCHING
        !isConnected -> UNAVAILABLE_DISCONNECTED
        else -> "Switch to this model"
    }

    fun thinkingRowAction(level: String): String = when {
        level == currentThinkingLevel -> "Currently selected"
        isThinkingSwitchInFlight -> UNAVAILABLE_SWITCHING
        !isConnected -> UNAVAILABLE_DISCONNECTED
        else -> "Use this thinking level"
    }

    /** Why the model list is empty, in the reader's terms. */
    fun emptyModelsMessage(selectedProvider: String, query: String): String {
        if (providers.isEmpty()) {
            return if (isConnected) {
                "This pod did not return any model providers."
            } else {
                "Reconnect to load this pod’s model catalog."
            }
        }
        if (query.isEmpty()) return "No models are available from $selectedProvider."
        return "No models from $selectedProvider match “$query”."
    }

    /** The provider to show, given one the reader may have chosen earlier. */
    fun reconcileProvider(selected: String): String {
        if (selected in providers) return selected
        return currentModel?.provider ?: providers.firstOrNull() ?: ""
    }

    companion object {
        const val UNAVAILABLE_DISCONNECTED = "Unavailable while the pod is disconnected"
        const val UNAVAILABLE_SWITCHING = "Unavailable while a switch is in progress"

        fun from(state: SessionStreamState): ModelPickerState = ModelPickerState(
            availableModels = state.availableModels,
            availableThinkingLevels = state.availableThinkingLevels,
            currentModel = state.currentModel,
            currentThinkingLevel = state.currentThinkingLevel,
            isConnected = state.isConnected,
            isModelSwitchInFlight = state.isModelSwitchInFlight,
            isThinkingSwitchInFlight = state.isThinkingSwitchInFlight,
            error = state.error,
        )
    }
}

/** The thinking levels, named the way the picker and the toolbar say them. */
object ThinkingLevelChoice {
    fun label(level: String): String = when (level) {
        "off" -> "Off"
        "minimal" -> "Minimal"
        "low" -> "Low"
        "medium" -> "Medium"
        "high" -> "High"
        "xhigh" -> "Extra high"
        else -> if (level.isEmpty()) {
            level
        } else {
            level.substring(0, 1).uppercase() + level.substring(1).lowercase()
        }
    }
}

/**
 * The toolbar entry point into the catalog, ported from `ModelPickerButton`.
 *
 * The label collapses to the glyph alone on a narrow screen or at large text,
 * where the model name would push the rest of the bar off the edge — the name
 * still reaches a screen reader through the button's own accessible name.
 */
@Composable
fun ModelPickerButton(
    state: ModelPickerState,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val thinkingLabel = state.currentThinkingLevel?.let { ThinkingLevelChoice.label(it) }
    val current = state.currentModel
    val compact = isCompactWidth()
    val fontScale = LocalConfiguration.current.fontScale
    val showText = !compact || (currentWindowWidth() >= 360.dp && fontScale <= 1.5f)
    val name = buildList {
        add(if (current == null) "Choose provider and model" else "Model: ${current.name}")
        thinkingLabel?.let { add("Thinking: $it") }
        if (current != null) add("Choose provider and model")
    }.joinToString(". ")

    AppButton(
        onClick = onClick,
        modifier = modifier.testTag(ModelPickerTestTags.BUTTON),
        kind = AppButtonKind.Plain,
        contentPadding = PaddingValues(horizontal = 8.dp),
        minSize = DpSize(AppButtonDefaults.MinTouchTarget, AppButtonDefaults.MinTouchTarget),
        semanticsLabel = name,
    ) {
        Icon(
            imageVector = AppIcons.resources,
            contentDescription = null,
            modifier = Modifier.size(18.dp),
        )
        if (showText) {
            Spacer(Modifier.width(4.dp))
            Text(
                text = current?.name ?: "Choose model",
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.widthIn(max = if (compact) 96.dp else 160.dp),
            )
            if (thinkingLabel != null) {
                Spacer(Modifier.width(4.dp))
                Text(
                    text = "· $thinkingLabel",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelMedium,
                    color = appColors.secondaryLabel,
                )
            }
        }
    }
}

/** The picker, driven by a live [SessionStream]. */
@Composable
fun ModelPickerScreen(
    stream: SessionStream,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val session by stream.state.collectAsStateWithLifecycle()

    LaunchedEffect(stream) { stream.refreshModels() }

    ModelPickerScreen(
        state = ModelPickerState.from(session),
        onSelectModel = stream::selectModel,
        onSelectThinkingLevel = stream::selectThinkingLevel,
        onDone = onDone,
        modifier = modifier,
    )
}

/**
 * The picker as a pure function of [state].
 *
 * @param onSelectModel returns whether the switch was actually started; only
 *   then is it confirmed, because a disconnected pod refuses it.
 */
@Composable
fun ModelPickerScreen(
    state: ModelPickerState,
    onSelectModel: (ModelChoice) -> Boolean,
    onSelectThinkingLevel: (String) -> Boolean,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
    toastHostState: SnackbarHostState = rememberAppToastHostState(),
) {
    val providers = state.providers
    var selectedProvider by rememberSaveable { mutableStateOf("") }
    var modelSearch by rememberSaveable { mutableStateOf("") }
    var choosingProvider by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // The chosen provider can disappear under the reader when the catalog is
    // refreshed, so it is re-resolved rather than left pointing at nothing.
    LaunchedEffect(providers, state.currentModel) {
        val reconciled = state.reconcileProvider(selectedProvider)
        if (reconciled != selectedProvider) {
            selectedProvider = reconciled
            modelSearch = ""
        }
    }

    if (choosingProvider) {
        ProviderPickerScreen(
            providers = providers,
            models = state.allModels,
            selection = selectedProvider,
            onSelected = { provider ->
                selectedProvider = state.reconcileProvider(provider)
                modelSearch = ""
                choosingProvider = false
            },
            onBack = { choosingProvider = false },
            modifier = modifier,
        )
        return
    }

    val models = state.modelsIn(selectedProvider, modelSearch)

    AppScaffold(
        modifier = modifier.testTag(ModelPickerTestTags.SCREEN),
        title = "Model & Thinking",
        grouped = true,
        toastHostState = toastHostState,
        actions = {
            AppButton(
                text = "Done",
                onClick = onDone,
                kind = AppButtonKind.Plain,
                semanticsLabel = "Done choosing model and thinking level",
                modifier = Modifier.testTag(ModelPickerTestTags.DONE),
            )
            Spacer(Modifier.width(8.dp))
        },
    ) { insets ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(insets)
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 32.dp),
        ) {
            AppTextField(
                value = modelSearch,
                onValueChange = { modelSearch = it },
                placeholder = "Search model names or IDs",
                semanticsLabel = "Search model names or IDs",
                prefixIcon = AppIcons.search,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Search,
                ),
                suffix = if (modelSearch.isEmpty()) {
                    null
                } else {
                    {
                        AppIconButton(
                            icon = AppIcons.close,
                            onClick = { modelSearch = "" },
                            semanticsLabel = "Clear model search",
                        )
                    }
                },
            )

            val error = state.error
            if (error != null) {
                Spacer(Modifier.height(12.dp))
                Notice(
                    label = "Model catalog error: $error",
                    icon = AppIcons.warning,
                    message = error,
                    isError = true,
                )
            } else if (!state.isConnected) {
                Spacer(Modifier.height(12.dp))
                Notice(
                    label = "Pod disconnected while choosing a model",
                    icon = AppIcons.offline,
                    message = "The pod is disconnected. You can browse the catalog, but " +
                        "reconnect before switching models.",
                )
            }

            Spacer(Modifier.height(20.dp))
            SectionTitle("Provider")
            if (providers.isEmpty()) {
                LabeledValueRow(label = "Provider", value = "Not available")
            } else {
                AppListSection {
                    row {
                        AppListTile(
                            title = { Text("Provider") },
                            trailing = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        text = selectedProvider,
                                        color = appColors.secondaryLabel,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Spacer(Modifier.width(4.dp))
                                    Icon(
                                        imageVector = AppIcons.chevron,
                                        contentDescription = null,
                                        tint = appColors.tertiaryLabel,
                                    )
                                }
                            },
                            onClick = { choosingProvider = true },
                            modifier = Modifier
                                .testTag(ModelPickerTestTags.PROVIDER_ROW)
                                .semantics(mergeDescendants = true) { },
                            semanticsLabel = "Provider, $selectedProvider. Choose provider",
                        )
                    }
                }
            }

            Spacer(Modifier.height(20.dp))
            SectionTitle("Model")
            if (models.isEmpty()) {
                EmptyState(
                    icon = AppIcons.search,
                    title = if (modelSearch.isEmpty()) "No Models" else "No Matching Models",
                    message = state.emptyModelsMessage(selectedProvider, modelSearch),
                )
            } else {
                AppListSection(modifier = Modifier.testTag(ModelPickerTestTags.MODEL_LIST)) {
                    items(models) { model ->
                        val isCurrent = model == state.currentModel
                        val enabled = state.modelRowEnabled(model)
                        AppListTile(
                            title = { Text(model.name) },
                            subtitle = if (model.name == model.modelId) {
                                null
                            } else {
                                { Text(model.modelId) }
                            },
                            trailing = if (!isCurrent) {
                                null
                            } else {
                                {
                                    Icon(
                                        imageVector = AppIcons.success,
                                        contentDescription = null,
                                        tint = appColors.accent,
                                    )
                                }
                            },
                            onClick = {
                                // Tapping the model already in use is a no-op,
                                // not a switch: sending it announced "Switched
                                // to X" for a change that never happened, and
                                // the round trip could genuinely fail.
                                if (!isCurrent && onSelectModel(model)) {
                                    scope.launch {
                                        showAppToast(toastHostState, "Switched to ${model.name}.")
                                    }
                                }
                            },
                            enabled = enabled,
                            // A row that cannot be tapped says so. `AppListTile`
                            // simply drops its click action when disabled, which
                            // leaves a frozen row announcing as an ordinary one.
                            modifier = Modifier.semantics(mergeDescendants = true) {
                                if (!enabled) disabled()
                            },
                            semanticsLabel = "Model ${model.name}, ${model.modelId}, " +
                                "${model.provider}. ${state.modelRowAction(model)}",
                        )
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    text = "${models.size} ${if (models.size == 1) "model" else "models"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = appColors.secondaryLabel,
                )
            }

            Spacer(Modifier.height(20.dp))
            SectionTitle("Thinking Level")
            if (state.availableThinkingLevels.isEmpty()) {
                LabeledValueRow(
                    label = "Thinking",
                    value = state.currentThinkingLevel
                        ?.let { ThinkingLevelChoice.label(it) }
                        ?: "Not available",
                )
            } else {
                AppListSection(modifier = Modifier.testTag(ModelPickerTestTags.THINKING_LIST)) {
                    items(state.availableThinkingLevels) { level ->
                        val label = ThinkingLevelChoice.label(level)
                        val isCurrent = level == state.currentThinkingLevel
                        AppListTile(
                            title = { Text(label) },
                            trailing = if (!isCurrent) {
                                null
                            } else {
                                {
                                    Icon(
                                        imageVector = AppIcons.success,
                                        contentDescription = null,
                                        tint = appColors.accent,
                                    )
                                }
                            },
                            onClick = {
                                // Same as the model rows: the level already in
                                // use is a no-op, not a change to announce.
                                if (!isCurrent && onSelectThinkingLevel(level)) {
                                    scope.launch {
                                        showAppToast(
                                            toastHostState,
                                            "Thinking level changed to $label.",
                                        )
                                    }
                                }
                            },
                            enabled = state.thinkingRowEnabled(level),
                            modifier = Modifier.semantics(mergeDescendants = true) {
                                if (!state.thinkingRowEnabled(level)) disabled()
                            },
                            semanticsLabel = "Thinking $label. " +
                                state.thinkingRowAction(level),
                        )
                    }
                }
            }
        }
    }
}

/**
 * The provider list.
 *
 * The Flutter client pushes this as its own route; here it swaps the picker's
 * content, with the framework back control and the system back gesture both
 * returning to the model list.
 */
@Composable
fun ProviderPickerScreen(
    providers: List<String>,
    models: List<ModelChoice>,
    selection: String,
    onSelected: (String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var search by rememberSaveable { mutableStateOf("") }
    val visible = ModelCatalog.providersMatching(providers, search)

    BackHandler(enabled = true) { onBack() }

    AppScaffold(
        modifier = modifier.testTag(ModelPickerTestTags.PROVIDER_SCREEN),
        title = "Choose Provider",
        onNavigateBack = onBack,
        grouped = true,
    ) { insets ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(insets)
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, top = 8.dp, end = 16.dp, bottom = 32.dp),
        ) {
            AppTextField(
                value = search,
                onValueChange = { search = it },
                placeholder = "Search providers",
                semanticsLabel = "Search providers",
                prefixIcon = AppIcons.search,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Search,
                ),
                suffix = if (search.isEmpty()) {
                    null
                } else {
                    {
                        AppIconButton(
                            icon = AppIcons.close,
                            onClick = { search = "" },
                            semanticsLabel = "Clear provider search",
                        )
                    }
                },
            )
            Spacer(Modifier.height(12.dp))
            if (visible.isEmpty()) {
                EmptyState(
                    icon = AppIcons.noResults,
                    title = "No Results for “$search”",
                    message = "Check the spelling or try a new search.",
                )
            } else {
                AppListSection(modifier = Modifier.testTag(ModelPickerTestTags.PROVIDER_LIST)) {
                    items(visible) { provider ->
                        val count = models.count { it.provider == provider }
                        val countLabel = "$count ${if (count == 1) "model" else "models"}"
                        val selected = provider == selection
                        AppListTile(
                            title = { Text(provider) },
                            subtitle = { Text(countLabel) },
                            trailing = if (!selected) {
                                null
                            } else {
                                {
                                    Icon(
                                        imageVector = AppIcons.check,
                                        contentDescription = null,
                                        tint = appColors.accent,
                                    )
                                }
                            },
                            onClick = { onSelected(provider) },
                            modifier = Modifier.semantics(mergeDescendants = true) { },
                            semanticsLabel = "Provider $provider, $countLabel. " +
                                if (selected) {
                                    "Currently selected"
                                } else {
                                    "Show models from this provider"
                                },
                        )
                    }
                }
            }
        }
    }
}

/** A card stating something about the catalog the reader cannot act on here. */
@Composable
private fun Notice(
    label: String,
    icon: ImageVector,
    message: String,
    isError: Boolean = false,
) {
    val color = if (isError) appColors.destructive else appColors.secondaryLabel
    AppListSection(
        modifier = Modifier
            .testTag(if (isError) ModelPickerTestTags.ERROR_NOTICE else ModelPickerTestTags.OFFLINE_NOTICE)
            .semantics(mergeDescendants = true) {
                contentDescription = label
                if (isError) liveRegion = LiveRegionMode.Polite
            },
    ) {
        row {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(if (isError) appColors.destructiveFill else appColors.card)
                    .padding(16.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(imageVector = icon, contentDescription = null, tint = color)
                Spacer(Modifier.width(12.dp))
                Text(text = message, color = color, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(start = 4.dp, bottom = 8.dp),
    )
}

/** A read-only `label: value` row, for a section with nothing to choose from. */
@Composable
private fun LabeledValueRow(label: String, value: String) {
    AppListSection {
        row {
            AppListTile(
                title = { Text(label) },
                additionalInfo = { Text(value, color = appColors.secondaryLabel) },
                modifier = Modifier.semantics(mergeDescendants = true) { },
                semanticsLabel = "$label, $value",
            )
        }
    }
}

/** The handles a UI test finds this screen's parts by. */
object ModelPickerTestTags {
    const val BUTTON = "model-picker-button"
    const val SCREEN = "model-picker-screen"
    const val DONE = "model-picker-done"
    const val PROVIDER_ROW = "model-picker-provider-row"
    const val MODEL_LIST = "model-picker-models"
    const val THINKING_LIST = "model-picker-thinking"
    const val ERROR_NOTICE = "model-picker-error"
    const val OFFLINE_NOTICE = "model-picker-offline"
    const val PROVIDER_SCREEN = "provider-picker-screen"
    const val PROVIDER_LIST = "provider-picker-list"
}
