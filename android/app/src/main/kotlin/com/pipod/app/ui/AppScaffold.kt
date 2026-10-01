package com.pipod.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import com.pipod.app.ui.theme.appColors

/**
 * A screen with a top bar, ported from
 * `pi-pod-flutter/lib/ui/app_scaffold.dart`.
 *
 * The bar disappears entirely when there is nothing to put in it, which is what
 * keeps a full-bleed screen (sign-in, a transcript) from carrying an empty band.
 *
 * @param onNavigateBack draws the back control. The Flutter widget infers the
 *   back button from the route; Compose navigation has no ambient route to ask,
 *   so a screen that can be left says so — which also makes it explicit which
 *   screens cannot.
 * @param grouped whether the content is a stack of list sections, which sits on
 *   the grouped backdrop rather than the plain one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppScaffold(
    modifier: Modifier = Modifier,
    title: String? = null,
    titleContent: (@Composable () -> Unit)? = null,
    titleSemanticsLabel: String? = null,
    onNavigateBack: (() -> Unit)? = null,
    navigationIcon: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    grouped: Boolean = false,
    floatingActionButton: @Composable () -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    toastHostState: SnackbarHostState? = null,
    content: @Composable (PaddingValues) -> Unit,
) {
    // An empty title is not a title: a screen that passes one gets a bare band
    // across the top with nothing in it, which reads as a rendering fault.
    val hasBar = !title.isNullOrEmpty() || titleContent != null || onNavigateBack != null ||
        navigationIcon != null
    val host = toastHostState ?: rememberAppToastHostState()
    // The same shape as the toast host: content too deep to be handed a dialog
    // host — a markdown link inside a transcript row — finds this one, and it is
    // rendered exactly once per screen. A screen that owns a host of its own
    // still passes it explicitly; this is only the fallback.
    val dialogs = rememberAppDialogHostState()
    CompositionLocalProvider(
        LocalAppToastHost provides host,
        LocalAppDialogHost provides dialogs,
    ) {
        AppDialogHost(dialogs)
        Scaffold(
            modifier = modifier,
            containerColor = appScaffoldBackground(grouped),
            topBar = {
                if (hasBar) {
                    TopAppBar(
                        modifier = Modifier.testTag("app-top-bar"),
                        title = { AppBarTitle(title, titleContent, titleSemanticsLabel) },
                        navigationIcon = {
                            when {
                                navigationIcon != null -> navigationIcon()
                                onNavigateBack != null -> AppBackButton(onNavigateBack)
                            }
                        },
                        actions = actions,
                        colors = TopAppBarDefaults.topAppBarColors(
                            containerColor = appColors.bar,
                        ),
                    )
                }
            },
            bottomBar = bottomBar,
            floatingActionButton = floatingActionButton,
            snackbarHost = { AppToastHost(host) },
            content = content,
        )
    }
}

/**
 * A scrolling screen, with the pull-to-refresh a list is expected to have.
 *
 * The Flutter original builds slivers because its title collapses into the
 * scroll view on Apple; Android keeps a pinned small title, so the content is
 * an ordinary lazy list and [content] is a [LazyListScope] rather than a list
 * of slivers.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppListScaffold(
    title: String,
    modifier: Modifier = Modifier,
    titleSemanticsLabel: String? = null,
    onNavigateBack: (() -> Unit)? = null,
    navigationIcon: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    grouped: Boolean = true,
    isRefreshing: Boolean = false,
    onRefresh: (() -> Unit)? = null,
    refreshSemanticsLabel: String? = null,
    listState: LazyListState = rememberLazyListState(),
    contentPadding: PaddingValues = AppListPadding,
    floatingActionButton: @Composable () -> Unit = {},
    toastHostState: SnackbarHostState? = null,
    content: LazyListScope.() -> Unit,
) {
    AppScaffold(
        modifier = modifier,
        title = title,
        titleSemanticsLabel = titleSemanticsLabel,
        onNavigateBack = onNavigateBack,
        navigationIcon = navigationIcon,
        actions = actions,
        grouped = grouped,
        floatingActionButton = floatingActionButton,
        toastHostState = toastHostState,
    ) { insets ->
        val list: @Composable (Modifier) -> Unit = { listModifier ->
            LazyColumn(
                modifier = listModifier.appListTestTag(),
                state = listState,
                contentPadding = contentPadding,
                content = content,
            )
        }
        if (onRefresh == null) {
            list(Modifier.fillMaxSize().padding(insets))
        } else {
            PullToRefreshBox(
                isRefreshing = isRefreshing,
                onRefresh = onRefresh,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(insets)
                    .appRefreshSemantics(isRefreshing, refreshSemanticsLabel, onRefresh),
            ) {
                list(Modifier.fillMaxSize())
            }
        }
    }
}

/** The node a UI test finds a screen's pull-to-refresh by. */
const val AppRefreshTestTag: String = "app-pull-to-refresh"

/** What [appRefreshSemantics] says while a refresh is in flight. */
const val AppRefreshingStateDescription: String = "Refreshing"

/**
 * Names a pull-to-refresh region.
 *
 * The spinner Material draws carries no semantics at all: a screen-reader user
 * can neither perform the gesture nor hear that it is running. Both are fixed
 * here — a named custom action to start a refresh, and a state description
 * while one is in flight — so every screen with a pull gesture reports it the
 * same way, and a UI test can see it.
 */
fun Modifier.appRefreshSemantics(
    isRefreshing: Boolean,
    refreshSemanticsLabel: String?,
    onRefresh: () -> Unit,
): Modifier = testTag(AppRefreshTestTag).semantics {
    stateDescription = if (isRefreshing) AppRefreshingStateDescription else "Idle"
    if (refreshSemanticsLabel != null) {
        customActions = listOf(
            CustomAccessibilityAction(refreshSemanticsLabel) {
                onRefresh()
                true
            },
        )
    }
}

/**
 * The top bar's title.
 *
 * Exposed as a heading so a reader can jump straight to "which screen is this",
 * and optionally under a name of its own for a screen whose bare title needs
 * context ("Detail" alone says nothing about what it is the detail of).
 */
@Composable
private fun AppBarTitle(
    title: String?,
    titleContent: (@Composable () -> Unit)?,
    titleSemanticsLabel: String?,
) {
    val naming = Modifier.semantics {
        heading()
        if (titleSemanticsLabel != null) contentDescription = titleSemanticsLabel
    }
    when {
        titleContent != null -> Box(naming) { titleContent() }
        // Ellipsised rather than clipped: a long pod or environment name — and
        // at a large font scale almost every title — otherwise ends mid-glyph
        // with nothing to say it was cut.
        title != null -> Text(
            text = title,
            modifier = naming,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * The back control, named exactly "Back".
 *
 * The manual UI tests and TalkBack both find the way out of a screen by that
 * word, so it is not re-worded per screen.
 */
@Composable
fun AppBackButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    AppIconButton(
        icon = Icons.AutoMirrored.Rounded.ArrowBack,
        onClick = onClick,
        semanticsLabel = "Back",
        modifier = modifier.testTag("app-back-button"),
    )
}

/**
 * The page-level background, for a screen that paints its own body instead of
 * handing content to [AppScaffold].
 */
@Composable
@ReadOnlyComposable
fun appScaffoldBackground(grouped: Boolean = false): Color =
    if (grouped) appColors.groupedBackground else appColors.background

/** The shape a sheet or dialog raised over a screen is drawn with. */
@Composable
@ReadOnlyComposable
fun appSurfaceShape() = MaterialTheme.shapes.large

/** A named glyph for a top-bar action that closes rather than goes back. */
@Composable
fun AppCloseButton(onClick: () -> Unit, semanticsLabel: String = "Close", modifier: Modifier = Modifier) {
    AppIconButton(
        icon = AppIcons.close,
        onClick = onClick,
        semanticsLabel = semanticsLabel,
        modifier = modifier.testTag("app-close-button"),
    )
}
