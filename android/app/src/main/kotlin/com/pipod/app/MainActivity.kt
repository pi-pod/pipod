package com.pipod.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts.RequestPermission
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.net.toUri
import com.pipod.app.core.deeplink.DeepLinkDestination
import com.pipod.app.shell.AppRoot
import com.pipod.app.ui.theme.PiPodTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred

/**
 * The app's single activity.
 *
 * `singleTask` in the manifest is what makes this the only instance: the OIDC
 * redirect and every `pipod://` link have to reach the process that started the
 * sign-in, not a second copy of the app with no PKCE verifier in memory.
 */
class MainActivity : ComponentActivity() {

    private val container get() = (application as PiPodApplication).container

    /** The link the app is currently meant to be showing, if one arrived. */
    private var pendingLocation by mutableStateOf<String?>(null)

    /**
     * The in-flight permission request, so the coroutine that asked can be told
     * what the person answered. `registerForActivityResult` has to be called
     * before the activity starts, which is why the launcher lives here rather
     * than beside the settings screen that needs it.
     */
    private var permissionAnswer: CompletableDeferred<Boolean>? = null

    private val requestPermission = registerForActivityResult(RequestPermission()) { granted ->
        permissionAnswer?.complete(granted)
        permissionAnswer = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        // Debug launch overrides are read before anything builds a client, so
        // `make android` reaches the local server on the very first request.
        container.applyLaunchExtras(intent)
        container.attachActivity(this)
        container.permissionPrompt = ::askFor
        // Restoration is a once-per-process job and this is where it starts:
        // after the overrides, before the first composition. The gate that used
        // to drive it is composed on every tab.
        container.startRestore()
        // Only a launch, never a recreation. The launch intent is retained
        // across configuration changes and process death, so consuming it here
        // unconditionally re-parked an already-spent `pipod://auth/callback` on
        // every rotation — and the next sign-out then spent a "Signing in…"
        // cycle on a redirect whose code was gone. A genuinely new link arrives
        // through [onNewIntent].
        if (savedInstanceState == null) consume(intent)

        setContent {
            PiPodTheme {
                AppRoot(
                    container = container,
                    location = pendingLocation,
                    onLocationHandled = { pendingLocation = null },
                )
            }
        }
    }

    /**
     * Asks the OS what it currently thinks about notifications.
     *
     * Permission can be granted or revoked in system settings while the app is
     * backgrounded, so the answer is only ever as good as the last time it was
     * asked — and nothing asked unless the settings screen had been opened,
     * which is why approval banners never appeared for anyone who had not been
     * there.
     */
    override fun onStart() {
        super.onStart()
        container.refreshNotificationAuthorization()
    }

    /**
     * Coming back from the authorization browser.
     *
     * A redirect arrives through [onNewIntent], which the framework delivers
     * before this; the container waits out a grace period anyway and only ends
     * a sign-in that really came back with nothing.
     */
    override fun onResume() {
        super.onResume()
        container.onForeground()
    }

    override fun onDestroy() {
        container.detachActivity(this)
        super.onDestroy()
    }

    /**
     * Raises the system permission prompt and suspends until it is answered.
     *
     * A prompt that is already up wins: asking twice would leave the first
     * caller waiting on a dialog the OS will not show again.
     */
    private suspend fun askFor(permission: String): Boolean {
        permissionAnswer?.let { return it.await() }
        val answer = CompletableDeferred<Boolean>()
        permissionAnswer = answer
        return try {
            requestPermission.launch(permission)
            answer.await()
        } catch (error: Throwable) {
            permissionAnswer = null
            if (error is CancellationException) throw error
            false
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A relaunch may also be a re-point in development; a release build
        // ignores the extras entirely.
        if (container.applyLaunchExtras(intent)) container.startRestore()
        consume(intent)
    }

    /**
     * Routes one incoming intent.
     *
     * An authorization redirect goes to the broker — the coroutine waiting on it
     * is not this object — and everything else becomes a location for the
     * navigation host. The two are separate because a callback must resume the
     * sign-in that is already running rather than start a navigation.
     */
    private fun consume(intent: Intent?) {
        val uri = intent?.data ?: return
        // One link, one delivery. Clearing the data marks this intent spent, so
        // the retained copy the framework hands back on the next recreation
        // carries nothing to replay.
        intent.data = null
        if (com.pipod.app.core.auth.AuthCallbackBroker.isAuthCallback(uri)) {
            container.authCallbacks.offer(uri)
            return
        }
        DeepLinkDestination.routerLocationFor(uri)?.let { pendingLocation = it }
            ?: DeepLinkDestination.fromUri(uri)?.let { pendingLocation = it.location }
    }

    /** Test seam: drives [consume] the way the system would. */
    internal fun handleLinkForTesting(link: String) = consume(Intent(Intent.ACTION_VIEW, link.toUri()))

    /**
     * Test seam for the *retained* intent: the framework hands the same object
     * back on every recreation, so what matters is what a second pass over it
     * does.
     */
    internal fun handleIntentForTesting(intent: Intent) = consume(intent)
}
