package com.pipod.app.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import com.pipod.app.di.AppContainer

/**
 * The top of the composable tree: session gate, navigation host, and the sink
 * for a link that arrived from outside the app.
 *
 * [location] is a navigation location produced by [DeepLinkDestination]; it is
 * consumed once and cleared, so returning to the app later does not replay the
 * link that brought it to the foreground the first time.
 */
@Composable
fun AppRoot(
    container: AppContainer,
    modifier: Modifier = Modifier,
    location: String? = null,
    onLocationHandled: () -> Unit = {},
    navController: NavHostController = rememberNavController(),
) {
    val router = remember(navController) { AppRouter(navController) }
    val session by container.session.state.collectAsState()
    val user = session.user

    LaunchedEffect(location) {
        val target = location ?: return@LaunchedEffect
        // A link is untrusted input from an exported activity: any installed app
        // can fire one, and `NavController.navigate` throws on a location no
        // route pattern matches. Unguarded that throw travelled straight out of
        // this effect and took the process down; the app has a not-found screen
        // for exactly this and nothing could reach it.
        runCatching { router.go(target) }
            .onFailure { runCatching { router.go(Routes.NOT_FOUND) } }
        onLocationHandled()
    }

    // Signing out has to take the back stack with it. Without this the entries
    // behind the current one survive, and so do their `ViewModelStore`s: the
    // next person to sign in on this device lands on a pod list, an approvals
    // inbox and a settings screen still holding the previous account's data,
    // and pressing back walks straight into it.
    var hadUser by remember { mutableStateOf(user != null) }
    LaunchedEffect(user) {
        val signedIn = user != null
        if (hadUser && !signedIn) {
            navController.navigate(Routes.PODS) {
                popUpTo(0) { inclusive = true; saveState = false }
                launchSingleTop = true
            }
        }
        hadUser = signedIn
    }

    AppNavHost(
        container = container,
        navController = navController,
        router = router,
        modifier = modifier.testTag("app-root"),
    )
}
