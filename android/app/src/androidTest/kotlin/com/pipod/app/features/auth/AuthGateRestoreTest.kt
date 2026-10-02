package com.pipod.app.features.auth

import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pipod.app.core.api.model.AuthUser
import com.pipod.app.core.api.model.MeResponse
import com.pipod.app.core.api.model.Organization
import com.pipod.app.core.api.model.RefreshResponse
import com.pipod.app.core.auth.OidcTransientException
import com.pipod.app.core.session.SessionKeys
import com.pipod.app.core.session.SessionStore
import com.pipod.app.core.session.SessionStoreApi
import com.pipod.app.core.session.SessionTokenStorage
import com.pipod.app.ui.theme.PiPodTheme
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * F1: the gate is composed once per destination, so it must not be what drives
 * session restoration.
 *
 * `LaunchedEffect(session) { session.restore() }` fired on every navigation.
 * Each firing re-read the keystore, spent the one-time-use refresh token again,
 * and put "Restoring session…" over the whole app for the length of the round
 * trip — so switching tabs flashed a spinner and rotated a token per tab.
 */
@RunWith(AndroidJUnit4::class)
class AuthGateRestoreTest {

    @get:Rule val compose = createComposeRule()

    @Test
    fun navigatingBetweenTabsDoesNotRestoreAgain() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val api = CountingApi()
        val store = SessionStore(api = api, storage = storage(), scope = scope)
        try {
            // What the activity does once, before the first composition.
            runBlocking { store.restore() }
            assertEquals(1, api.refreshes.get())

            var destination by mutableStateOf("Pods")
            compose.setContent {
                PiPodTheme {
                    // A fresh gate per destination, exactly as the nav host
                    // composes one inside every tab.
                    key(destination) {
                        AuthGate(session = store) { Text(destination) }
                    }
                }
            }

            compose.onNodeWithText("Pods").assertIsDisplayed()

            destination = "Jobs"
            compose.waitForIdle()
            compose.onNodeWithText("Jobs").assertIsDisplayed()
            assertNoProgressNode()

            destination = "Pods"
            compose.waitForIdle()
            compose.onNodeWithText("Pods").assertIsDisplayed()
            assertNoProgressNode()

            assertEquals(
                1,
                api.refreshes.get(),
                "a refresh token spent once per navigation is invalidated by the provider",
            )
            assertEquals(1, api.meCalls.get(), "/v1/me must not be re-fetched per navigation")
        } finally {
            store.dispose()
            scope.cancel()
        }
    }

    /**
     * The other half of the latch. An attempt that failed because the provider
     * was unreachable deliberately does not latch, and the gate's nudge is what
     * retries it — otherwise a cold start behind a dead network would strand the
     * person on the sign-in screen with "Will retry" and nothing that ever does.
     */
    @Test
    fun anAttemptThatCouldNotReachTheProviderIsRetried() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val api = CountingApi().apply { refreshError = OidcTransientException("offline") }
        val store = SessionStore(api = api, storage = storage(), scope = scope)
        try {
            // The activity's kick, with the identity provider unreachable.
            runBlocking { store.restore() }
            assertEquals(1, api.refreshes.get())

            var destination by mutableStateOf("Pods")
            compose.setContent {
                PiPodTheme {
                    key(destination) {
                        AuthGate(session = store) { Text("gated-$destination") }
                    }
                }
            }
            compose.waitForIdle()

            assertEquals(2, api.refreshes.get(), "the gate retries an attempt that did not settle")
            assertEquals(
                0,
                compose.onAllNodesWithText("gated-Pods").fetchSemanticsNodes().size,
                "still offline, so nothing behind the gate is shown",
            )

            // The network comes back and the person changes tab.
            api.refreshError = null
            destination = "Jobs"
            compose.waitForIdle()

            compose.onNodeWithText("gated-Jobs").assertIsDisplayed()
            assertNoProgressNode()
            assertEquals(3, api.refreshes.get())

            destination = "Pods"
            compose.waitForIdle()
            compose.onNodeWithText("gated-Pods").assertIsDisplayed()
            assertEquals(3, api.refreshes.get(), "and latches once it finally settles")
        } finally {
            store.dispose()
            scope.cancel()
        }
    }

    private fun assertNoProgressNode() {
        assertEquals(
            0,
            compose.onAllNodesWithTag("auth-progress").fetchSemanticsNodes().size,
            "\"Restoring session…\" must not flash between destinations",
        )
    }

    private fun storage() = object : SessionTokenStorage {
        private val values = linkedMapOf(SessionKeys.REFRESH to "stored-refresh")
        override suspend fun read(key: String): String? = values[key]
        override suspend fun write(key: String, value: String) {
            values[key] = value
        }

        override suspend fun delete(key: String) {
            values.remove(key)
        }
    }

    private class CountingApi : SessionStoreApi {
        override var accessToken: String? = null
        override var refreshToken: String? = null
        override var idToken: String? = null

        val refreshes = AtomicInteger(0)
        val meCalls = AtomicInteger(0)

        @Volatile
        var refreshError: Throwable? = null

        override suspend fun refresh(refreshToken: String): RefreshResponse {
            refreshes.incrementAndGet()
            refreshError?.let { throw it }
            return RefreshResponse(
                accessToken = "access",
                refreshToken = "next-refresh",
                idToken = "id",
            )
        }

        override suspend fun me(): MeResponse {
            meCalls.incrementAndGet()
            return MeResponse(
                user = AuthUser(id = "user", email = "user@example.com"),
                currentOrgId = "org",
                permissions = emptyList(),
                organization = Organization(id = "org", alias = "acme", name = "Org"),
            )
        }
    }
}
