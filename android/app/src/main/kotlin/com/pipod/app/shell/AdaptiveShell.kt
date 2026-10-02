package com.pipod.app.shell

import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.pipod.app.ui.AppIcons
import com.pipod.app.ui.LocalAppToastHost
import com.pipod.app.ui.isCompactWidth
import com.pipod.app.ui.theme.appColors
import kotlinx.coroutines.launch

/** The three top-level destinations shared by the compact and wide shells. */
enum class AppDestination(val label: String, val route: String) {
    Pods("Pods", "/pods"),
    Jobs("Jobs", "/jobs"),
    Settings("Settings", "/settings"),
    ;

    val icon: ImageVector
        get() = when (this) {
            Pods -> AppIcons.pods
            Jobs -> AppIcons.jobs
            Settings -> AppIcons.settings
        }

    val selectedIcon: ImageVector
        get() = when (this) {
            Pods -> AppIcons.podsSelected
            Jobs -> AppIcons.jobsSelected
            Settings -> AppIcons.settingsSelected
        }
}

/**
 * The tab frame every authenticated screen sits inside.
 *
 * Port of the Material branch of `pi-pod-flutter/lib/shell/adaptive_shell.dart`.
 * A phone gets a bottom navigation bar; a wide window gets a rail, because a
 * bottom bar on a tablet puts the primary navigation as far from the content as
 * the geometry allows.
 *
 * [fullScreen] is for the routes that own the whole window — the launch flow and
 * a conversation — where a tab bar under the composer would be a target the
 * thumb hits by accident.
 */
@Composable
fun AdaptiveShell(
    destination: AppDestination,
    onSelect: (AppDestination) -> Unit,
    modifier: Modifier = Modifier,
    fullScreen: Boolean = false,
    /**
     * True only at a tab's root, where back would leave the app. A detail
     * screen has somewhere to go back *to*, and swallowing its back gesture to
     * show "press back again to exit" would strand the reader there.
     */
    confirmsExit: Boolean = true,
    content: @Composable (PaddingValues) -> Unit,
) {
    if (fullScreen) {
        Box(modifier.fillMaxSize()) { content(PaddingValues(0.dp)) }
        return
    }

    BackTwiceToExit(enabled = confirmsExit)

    if (isCompactWidth()) {
        Scaffold(
            modifier = modifier.testTag("app-shell"),
            bottomBar = {
                NavigationBar(modifier = Modifier.testTag("app-tab-bar")) {
                    AppDestination.entries.forEach { entry ->
                        NavigationBarItem(
                            selected = entry == destination,
                            onClick = { onSelect(entry) },
                            icon = { DestinationIcon(entry, entry == destination) },
                            label = { Text(entry.label) },
                            modifier = Modifier
                                .testTag("app-tab-${entry.name.lowercase()}")
                                .semantics { contentDescription = entry.label },
                        )
                    }
                }
            },
            content = content,
        )
        return
    }

    Row(modifier.fillMaxSize().testTag("app-shell")) {
        NavigationRail(
            modifier = Modifier.testTag("app-tab-bar"),
            header = { BrandMark() },
        ) {
            AppDestination.entries.forEach { entry ->
                NavigationRailItem(
                    selected = entry == destination,
                    onClick = { onSelect(entry) },
                    icon = { DestinationIcon(entry, entry == destination) },
                    label = { Text(entry.label) },
                    modifier = Modifier
                        .testTag("app-tab-${entry.name.lowercase()}")
                        .semantics { contentDescription = entry.label },
                )
            }
        }
        VerticalDivider()
        Box(Modifier.fillMaxSize()) { content(PaddingValues(0.dp)) }
    }
}

@Composable
private fun DestinationIcon(destination: AppDestination, selected: Boolean) {
    Icon(if (selected) destination.selectedIcon else destination.icon, contentDescription = null)
}

@Composable
private fun BrandMark() {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        modifier = Modifier
            .padding(top = 12.dp, bottom = 24.dp)
            // Decoration: the app's own name is not a navigation target, and a
            // screen reader announcing it before every tab is noise.
            .clearAndSetSemantics { },
    ) {
        Icon(AppIcons.brand, contentDescription = null, tint = appColors.accent)
        Spacer(Modifier.width(10.dp))
    }
}

/**
 * Confirms before the system back gesture leaves the app from a tab root: the
 * first press shows a notice, a second within two seconds exits. Screens that
 * can pop handle back themselves and never reach this.
 */
@Composable
private fun BackTwiceToExit(enabled: Boolean) {
    val toasts = LocalAppToastHost.current
    val scope = rememberCoroutineScope()
    val lastPress = remember { LongArray(1) }
    val activity = LocalActivity.current
    BackHandler(enabled = enabled) {
        val now = System.currentTimeMillis()
        if (now - lastPress[0] < 2_000) {
            activity?.finish()
            return@BackHandler
        }
        lastPress[0] = now
        scope.launch { toasts.showSnackbar("Press back again to exit") }
    }
}
