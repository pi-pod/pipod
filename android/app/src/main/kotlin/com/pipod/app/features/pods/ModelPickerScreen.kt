package com.pipod.app.features.pods

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
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
import com.pipod.app.ui.AppSeparator
import com.pipod.app.ui.AppTextField
import com.pipod.app.ui.currentWindowWidth
import com.pipod.app.ui.isCompactWidth
import com.pipod.app.ui.rememberAppToastHostState
import com.pipod.app.ui.showAppToast
import com.pipod.app.ui.theme.MonospaceTextStyle
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/**
 * Everything the model picker draws.
 *
 * A projection of `SessionStreamState` rather than the whole thing: taking only what the
 * picker reads is what lets a UI test build every variant — connecting, mid-switch, empty
 * catalog — by hand.
 */
data class ModelPickerState(
    val availableModels: List<ModelChoice> = emptyList(),
    val availableThinkingLevels: List<String> = emptyList(),
    /** The models this pod's user keeps to hand; empty when the pod names no scope. */
    val scopedModels: List<ModelChoice> = emptyList(),
    val currentModel: ModelChoice? = null,
    val currentThinkingLevel: String? = null,
    /** Chosen while the pod was not connected; made when it connects. */
    val deferredModel: ModelChoice? = null,
    val deferredThinkingLevel: String? = null,
    val isConnected: Boolean = false,
    val isModelSwitchInFlight: Boolean = false,
    val isThinkingSwitchInFlight: Boolean = false,
    val error: String? = null,
) {
    /** What the next message will run on: a choice still waiting for the pod, else pi's own. */
    val selectedModel: ModelChoice? get() = deferredModel ?: currentModel
    val selectedThinkingLevel: String? get() = deferredThinkingLevel ?: currentThinkingLevel

    val allModels: List<ModelChoice> get() = ModelCatalog.models(availableModels, selectedModel)

    /**
     * A switch in flight freezes the rows: a second one on top of it would race. Being
     * disconnected does not, because a choice made then is simply kept until the pod connects.
     */
    val rowsEnabled: Boolean get() = !isModelSwitchInFlight && !isThinkingSwitchInFlight

    /** What tapping a model row would do, for a screen reader. */
    fun modelRowAction(model: ModelChoice): String = when {
        model == selectedModel -> "Currently selected"
        !rowsEnabled -> UNAVAILABLE_SWITCHING
        !isConnected -> "Use this model when the pod connects"
        else -> "Switch to this model"
    }

    fun thinkingAction(level: String): String = when {
        level == selectedThinkingLevel -> "Currently selected"
        !rowsEnabled -> UNAVAILABLE_SWITCHING
        !isConnected -> "Use this thinking level when the pod connects"
        else -> "Use this thinking level"
    }

    companion object {
        const val UNAVAILABLE_SWITCHING = "Unavailable while a switch is in progress"

        fun from(state: SessionStreamState): ModelPickerState = ModelPickerState(
            availableModels = state.availableModels,
            availableThinkingLevels = state.availableThinkingLevels,
            scopedModels = state.scopedModels,
            currentModel = state.currentModel,
            currentThinkingLevel = state.currentThinkingLevel,
            deferredModel = state.deferredModel,
            deferredThinkingLevel = state.deferredThinkingLevel,
            isConnected = state.isConnected,
            isModelSwitchInFlight = state.isModelSwitchInFlight,
            isThinkingSwitchInFlight = state.isThinkingSwitchInFlight,
            error = state.error,
        )
    }
}

/** The thinking levels, named the way the picker and the composer say them. */
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
 * The composer's entry point into the catalog: the model and thinking level the next message
 * runs on, where the message is written.
 *
 * The label collapses to the glyph alone at very large text, where the name would push the
 * usage readout off the row — the name still reaches a screen reader through the button.
 */
@Composable
fun ModelPickerButton(
    state: ModelPickerState,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val selected = state.selectedModel
    val thinkingLabel = state.selectedThinkingLevel?.let { ThinkingLevelChoice.label(it) }
    val compact = isCompactWidth()
    val fontScale = LocalConfiguration.current.fontScale
    val showText = !compact || (currentWindowWidth() >= 360.dp && fontScale <= 1.5f)
    val name = buildList {
        add(if (selected == null) "Choose model" else "Model: ${selected.name}")
        thinkingLabel?.let { add("Thinking: $it") }
        if (state.deferredModel != null || state.deferredThinkingLevel != null) add("Applies when the pod connects")
        if (selected != null) add("Choose model and thinking level")
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
                text = selected?.name ?: "Choose model",
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.widthIn(max = if (compact) 132.dp else 200.dp),
            )
            if (thinkingLabel != null) {
                Spacer(Modifier.width(4.dp))
                Text(
                    text = "· $thinkingLabel",
                    maxLines = 1,
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
 * One list, top to bottom in the order a choice is made: the thinking level, a search field
 * that is always there, the models the pod's user keeps in scope, then every other model. A
 * catalog is dozens of models across several providers, so the handful in scope lead and one
 * search covers names, providers and ids together. Choosing a model closes the picker,
 * because that is what the reader came to do; choosing a thinking level does not, because it
 * usually goes with a model.
 *
 * @param onSelectModel returns whether the choice was taken; false leaves the picker open
 *   with the stream's error showing.
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
    var query by rememberSaveable { mutableStateOf("") }
    val models = state.allModels
    val scoped = remember(state.scopedModels, models) { state.scopedModels.filter { it in models } }
    val matches = remember(query, models) { ModelCatalog.search(query, models) }
    val searching = query.isNotBlank()

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
        Column(Modifier.fillMaxSize().padding(insets)) {
            // Above the list rather than in it, so neither scrolls away from a long catalog.
            Column(Modifier.padding(start = 16.dp, top = 8.dp, end = 16.dp)) {
                PickerNotice(state)
                ThinkingLevels(state, onSelectThinkingLevel)
                AppTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = "Search models, providers or IDs",
                    semanticsLabel = "Search models, providers or IDs",
                    prefixIcon = AppIcons.search,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Search,
                    ),
                    suffix = if (query.isEmpty()) {
                        null
                    } else {
                        {
                            AppIconButton(
                                icon = AppIcons.close,
                                onClick = { query = "" },
                                semanticsLabel = "Clear model search",
                            )
                        }
                    },
                    modifier = Modifier.testTag(ModelPickerTestTags.SEARCH),
                )
            }

            val row: @Composable (ModelChoice) -> Unit = { model ->
                ModelRow(
                    model = model,
                    state = state,
                    onClick = {
                        // The model already in use is a no-op, not a switch to announce.
                        if (model == state.selectedModel || onSelectModel(model)) onDone()
                    },
                )
            }
            LazyColumn(
                modifier = Modifier.fillMaxSize().testTag(ModelPickerTestTags.MODEL_LIST),
                contentPadding = PaddingValues(start = 16.dp, top = 12.dp, end = 16.dp, bottom = 32.dp),
            ) {
                when {
                    models.isEmpty() -> item(key = "empty") {
                        EmptyState(
                            icon = AppIcons.search,
                            title = "No Models Yet",
                            message = if (state.isConnected) {
                                "This pod did not report any models. Check its model providers in Settings."
                            } else {
                                "This pod’s models appear once it connects."
                            },
                        )
                    }

                    searching && matches.isEmpty() -> item(key = "no-matches") {
                        EmptyState(
                            icon = AppIcons.search,
                            title = "No Matching Models",
                            message = "No model matches “${query.trim()}”. Search by name, provider or ID.",
                        )
                    }

                    searching -> {
                        item(key = "matches-title") {
                            SectionTitle("${matches.size} ${if (matches.size == 1) "match" else "matches"}")
                        }
                        items(matches, key = { "match-${it.id}" }) { row(it) }
                    }

                    else -> {
                        // What is selected is always in the first screenful, even when it is
                        // outside the scope that would otherwise lead the list.
                        val selected = state.selectedModel
                        if (selected != null && scoped.isNotEmpty() && selected !in scoped) {
                            item(key = "selected-title") { SectionTitle("Selected") }
                            item(key = "selected-${selected.id}") { row(selected) }
                            item(key = "selected-gap") { Spacer(Modifier.height(20.dp)) }
                        }
                        if (scoped.isNotEmpty()) {
                            item(key = "scoped-title") { SectionTitle("Scoped models") }
                            items(scoped, key = { "scoped-${it.id}" }) { row(it) }
                            item(key = "scoped-gap") { Spacer(Modifier.height(20.dp)) }
                        }
                        item(key = "all-title") {
                            SectionTitle(if (scoped.isEmpty()) "Models" else "All models")
                        }
                        items(models, key = { "all-${it.id}" }) { row(it) }
                    }
                }
            }
        }
    }
}

/** What the reader should know before choosing: an error, or that the choice will wait. */
@Composable
private fun PickerNotice(state: ModelPickerState) {
    val error = state.error
    when {
        error != null && state.isConnected -> Notice(
            label = "Model catalog error: $error",
            icon = AppIcons.warning,
            message = error,
            isError = true,
        )

        !state.isConnected -> Notice(
            label = "The pod is not connected. Your choice applies when it connects.",
            icon = AppIcons.schedule,
            message = if (state.availableModels.isEmpty()) {
                "This pod isn’t connected yet. Its models appear once it is."
            } else {
                "This pod isn’t connected yet. Choose now and it switches as soon as it connects."
            },
        )

        else -> return
    }
    Spacer(Modifier.height(12.dp))
}

/** The thinking levels as one row of chips: few, short, and chosen together with a model. */
@Composable
private fun ThinkingLevels(state: ModelPickerState, onSelect: (String) -> Boolean) {
    val levels = state.availableThinkingLevels
    if (levels.isEmpty()) return
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 12.dp)
            .horizontalScroll(rememberScrollState())
            .testTag(ModelPickerTestTags.THINKING_LIST),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "Thinking",
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.padding(start = 4.dp, end = 12.dp),
        )
        levels.forEach { level ->
            val label = ThinkingLevelChoice.label(level)
            val isSelected = level == state.selectedThinkingLevel
            val enabled = state.rowsEnabled
            Box(
                modifier = Modifier
                    .padding(end = 8.dp)
                    .heightIn(min = AppButtonDefaults.MinTouchTarget)
                    .clip(RoundedCornerShape(50))
                    .background(if (isSelected) appColors.accent else appColors.card)
                    .clickable(enabled = enabled && !isSelected) { onSelect(level) }
                    .padding(horizontal = 16.dp)
                    .clearAndSetSemantics {
                        contentDescription = "Thinking $label. ${state.thinkingAction(level)}"
                        role = Role.RadioButton
                        selected = isSelected
                        if (!enabled) disabled()
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (isSelected) appColors.onAccent else appColors.label,
                )
            }
        }
    }
}

/** One model: its name, then the provider and id that tell two same-named models apart. */
@Composable
private fun ModelRow(model: ModelChoice, state: ModelPickerState, onClick: () -> Unit) {
    val isSelected = model == state.selectedModel
    val enabled = state.rowsEnabled
    Column(Modifier.fillMaxWidth().padding(bottom = 6.dp).clip(RoundedCornerShape(12.dp)).background(appColors.card)) {
        AppListTile(
            title = { Text(model.name, fontWeight = if (isSelected) FontWeight.SemiBold else null) },
            subtitle = {
                Text(
                    text = "${model.provider} · ${model.modelId}",
                    style = MonospaceTextStyle.copy(fontSize = MaterialTheme.typography.labelSmall.fontSize),
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                )
            },
            trailing = if (!isSelected) {
                null
            } else {
                {
                    Icon(
                        imageVector = if (state.deferredModel == model) AppIcons.schedule else AppIcons.success,
                        contentDescription = null,
                        tint = appColors.accent,
                    )
                }
            },
            onClick = onClick,
            enabled = enabled,
            // A row that cannot be tapped says so: the tile drops its click action when
            // disabled, which would leave a frozen row announcing as an ordinary one.
            modifier = Modifier
                .testTag(ModelPickerTestTags.model(model.id))
                .semantics(mergeDescendants = true) { if (!enabled) disabled() },
            semanticsLabel = "Model ${model.name}, ${model.provider}, ${model.modelId}. ${state.modelRowAction(model)}",
        )
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

/** Test handles the acceptance pass addresses the picker by. */
object ModelPickerTestTags {
    const val BUTTON = "model-picker-button"
    const val SCREEN = "model-picker-screen"
    const val DONE = "model-picker-done"
    const val SEARCH = "model-picker-search"
    const val MODEL_LIST = "model-picker-models"
    const val THINKING_LIST = "model-picker-thinking"
    const val ERROR_NOTICE = "model-picker-error"
    const val OFFLINE_NOTICE = "model-picker-offline"

    fun model(id: String) = "model-picker-model-$id"
}
