package com.pipod.app.shell

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pipod.app.PiPodApplication
import com.pipod.app.ui.theme.PiPodTheme
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Round 2, features F2: an incoming link is untrusted input.
 *
 * `AppRoot` handed whatever arrived straight to `NavController.navigate`, from
 * inside a `LaunchedEffect` with no guard. Navigation answers a location no
 * pattern matches with `IllegalArgumentException`, and from a `LaunchedEffect`
 * that throw takes the process down — for a link any installed app can fire.
 * The app has a not-found screen for exactly this and nothing could reach it.
 *
 * Asserted on the navigation controller rather than the semantics tree: the
 * gate behind this graph shows an indefinite progress indicator, and waiting
 * for a composition to go idle underneath one never returns.
 */
@RunWith(AndroidJUnit4::class)
class AppRootLinkRound2Test {

    @get:Rule val compose = createComposeRule()

    private val container get() =
        ApplicationProvider.getApplicationContext<PiPodApplication>().container

    @Test
    fun aLocationNoRouteMatchesLandsOnNotFoundInsteadOfCrashing() {
        val route = routeFor("/wormhole/a/b/c/d")

        assertEquals(Routes.NOT_FOUND, route)
    }

    @Test
    fun anEncodedPodIdRoutesToTheSessionRatherThanFallingBack() {
        // `pipod://pod/a%2Fb` resolves to this, and it is a legal three-segment
        // location precisely because the id is encoded.
        val route = routeFor("/pods/a%2Fb/session")

        assertEquals(Routes.SESSION, route)
        assertNotEquals(Routes.NOT_FOUND, route)
    }

    /** Where a link actually lands, once the navigation effect has run. */
    private fun routeFor(location: String): String? {
        var navController: NavHostController? = null
        compose.setContent {
            val controller = rememberNavController()
            navController = controller
            PiPodTheme {
                AppRoot(container = container, location = location, navController = controller)
            }
        }
        compose.waitUntil(timeoutMillis = 15_000) {
            val route = navController?.currentDestination?.route
            route != null && route != Routes.PODS
        }
        return navController?.currentDestination?.route
    }
}
