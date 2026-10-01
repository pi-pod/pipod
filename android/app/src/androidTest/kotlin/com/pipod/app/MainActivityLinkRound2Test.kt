package com.pipod.app

import android.content.Intent
import androidx.core.net.toUri
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Round 2, core F8 and features F2: what the activity does with an intent it
 * has already handled, and with a link that names nothing.
 *
 * The launch intent is retained across every recreation, so consuming it
 * unconditionally re-parked an already-spent `pipod://auth/callback` on each
 * rotation — and the next sign-out then spent a "Signing in…" cycle on a
 * redirect whose one-shot code was long gone.
 */
@RunWith(AndroidJUnit4::class)
class MainActivityLinkRound2Test {

    private val container get() =
        ApplicationProvider.getApplicationContext<PiPodApplication>().container

    @Before
    fun setUp() {
        container.authCallbacks.takePending()
    }

    @After
    fun tearDown() {
        container.authCallbacks.takePending()
    }

    @Test
    fun aSpentCallbackIntentIsNotOfferedASecondTime() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val intent = Intent(
                    Intent.ACTION_VIEW,
                    "pipod://auth/callback?code=the-code&state=the-state".toUri(),
                )
                assertNotNull(intent.data)

                activity.handleIntentForTesting(intent)
                assertNull(intent.data, "the retained intent has to be marked spent")

                // Whoever was waiting for the redirect takes it, exactly once.
                container.authCallbacks.takePending()

                // A recreation hands the activity that very same intent back.
                activity.handleIntentForTesting(intent)
            }

            assertFalse(
                container.authCallbacks.hasPending,
                "a spent redirect was parked again and would fail the next sign-in",
            )
        }
    }

    @Test
    fun aPodLinkWhoseIdContainsASlashDoesNotTakeTheProcessDown() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { it.handleLinkForTesting("pipod://pod/a%2Fb") }
            // Let the navigation effect run: it is where the throw used to be.
            Thread.sleep(1_000)

            scenario.onActivity { activity ->
                assertFalse(activity.isFinishing, "the link took the activity down")
                assertFalse(activity.isDestroyed)
            }
        }
    }
}
