package com.pipod.app.di

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.provider.Settings
import java.lang.ref.WeakReference
import androidx.browser.customtabs.CustomTabsIntent
import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.TokenRefresher
import com.pipod.app.core.api.model.AuthResponse
import com.pipod.app.core.auth.AuthCallbackBroker
import com.pipod.app.core.auth.OidcClient
import com.pipod.app.core.auth.ZitadelAuthService
import com.pipod.app.core.config.Config
import com.pipod.app.core.config.RuntimeConfig
import com.pipod.app.core.push.AndroidLocalNotifier
import com.pipod.app.core.push.LocalNotifier
import com.pipod.app.core.push.PushController
import com.pipod.app.core.session.ApiClientSessionStoreApi
import com.pipod.app.core.session.InteractionReceiptStore
import com.pipod.app.core.session.LiveSessionStreams
import com.pipod.app.core.session.SecureSessionTokenStorage
import com.pipod.app.core.session.SessionAuthenticator
import com.pipod.app.core.session.SessionEnvironment
import com.pipod.app.core.session.SessionSocket
import com.pipod.app.core.session.SessionTransportFactory
import com.pipod.app.core.session.SharedPreferencesReceiptStorage
import com.pipod.app.features.session.InteractionDraftStore
import com.pipod.app.features.session.SessionDraftStore
import com.pipod.app.features.session.SharedPreferencesInteractionDraftStorage
import com.pipod.app.features.session.SharedPreferencesSessionDraftStore
import com.pipod.app.core.session.SessionKeys
import com.pipod.app.core.session.SessionStore
import com.pipod.app.ui.AppThumbnails
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * The process-wide object graph, built by hand.
 *
 * A dependency-injection framework would add a build step and generated code
 * for a dozen singletons whose wiring fits on one screen. What it would buy —
 * swapping an implementation in a test — is already available here, because
 * every collaborator is a constructor parameter of the class that uses it.
 */
class AppContainer(
    private val context: Context,
    /** Lives as long as the process; sign-in outlives any one activity. */
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {

    /**
     * One connection pool for the whole app.
     *
     * The API, the identity provider and the session WebSocket share it, which
     * is what lets a reconnect reuse a warm TLS connection instead of paying a
     * fresh handshake every time the process comes back to the foreground.
     */
    val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    val tokenStorage = SecureSessionTokenStorage(context)

    /** Per-approval freeform drafts, shared by the inline card and the inbox row. */
    private val interactionDrafts = SharedPreferencesInteractionDraftStorage(context)

    /**
     * The session socket's transport, built on the app's one connection pool.
     *
     * [SessionSocket] used to construct an `OkHttpClient` of its own per
     * instance — a dispatcher, a thread pool and a connection pool each — and a
     * session that reconnected a few times left every one of them behind. It
     * still needs the WebSocket read/ping settings, which is what `newBuilder`
     * is for: the pool and its connections are shared, the timeouts are not.
     */
    private val webSocketClient: OkHttpClient = httpClient.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(0, TimeUnit.MILLISECONDS)
        .build()

    /**
     * The identity provider's transport: the same pool, with a bound on the
     * whole call.
     *
     * The shared client's connect/read/write settings are per-operation, not a
     * ceiling on one request: connection setup, TLS, redirects and a slow body
     * each restart their own clock, so an OIDC discovery, token or JWKS call
     * can run far past any one of them while the app sits on "Signing in…"
     * with no way out. `callTimeout` is the only setting that bounds the
     * request end to end, and this is the one client that needs it — the API
     * and the session socket keep their existing behaviour, a long-poll or a
     * socket being exactly what a whole-call deadline must not cut.
     *
     * Twenty seconds is a discovery document, not a download. Exceeding it
     * surfaces the existing transport error the sign-in screen already knows
     * how to show, instead of nothing at all. The browser is opened after
     * these calls, so no time a person spends signing in is inside this bound.
     *
     * Trade-off, stated explicitly: the same [OidcClient] also performs the
     * post-callback token exchange and any JWKS fetch, so the same bound
     * applies there too. A post-callback timeout fails closed on that same
     * existing transport error and requires a fresh browser/code to retry;
     * there is no resume of a timed-out token call.
     */
    private val oidcHttpClient: OkHttpClient = httpClient.newBuilder()
        .callTimeout(OIDC_CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * Whether the device has a validated network.
     *
     * Nothing observed connectivity before, so a session that lost the network
     * discovered it only when a write failed — and "Offline", which the session
     * screen has always been able to render, never appeared. Starts optimistic:
     * a device with no `ConnectivityManager` behaves exactly as it did before.
     */
    private val _connectivity = MutableStateFlow(true)
    val connectivity: StateFlow<Boolean> = _connectivity.asStateFlow()

    private val connectivityManager: ConnectivityManager? =
        runCatching { context.getSystemService(ConnectivityManager::class.java) }.getOrNull()

    private val connectivityCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = publishConnectivity()
        override fun onLost(network: Network) = publishConnectivity()
        override fun onUnavailable() = publishConnectivity()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
            publishConnectivity()
    }

    private fun publishConnectivity() {
        val manager = connectivityManager
        if (manager == null) {
            _connectivity.value = true
            return
        }
        // The capabilities of the *active* network, not "is any network
        // registered": a Wi-Fi connection with no internet behind it is offline
        // as far as a session socket is concerned.
        val online = runCatching {
            val active = manager.activeNetwork ?: return@runCatching false
            val capabilities = manager.getNetworkCapabilities(active) ?: return@runCatching false
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }.getOrDefault(true)
        _connectivity.value = online
    }

    init {
        // Approval receipts have to be durable before the first session opens:
        // installed later, a receipt written by this launch is the only one that
        // survives, and a card answered just before a restart comes back looking
        // unanswered. The same is true of approval drafts, which had no
        // installation at all and so never outlived the process.
        InteractionReceiptStore.install(SharedPreferencesReceiptStorage(context))
        InteractionDraftStore.install(interactionDrafts)
        SessionEnvironment.transportFactory = SessionTransportFactory { podId, fromSeq, fromSession ->
            SessionSocket(
                podId = podId,
                fromSeq = fromSeq,
                fromSessionId = fromSession,
                webSocketFactory = webSocketClient,
            )
        }
        SessionEnvironment.connectivity = connectivity
        SessionEnvironment.loginSocketFactory = webSocketClient
        runCatching {
            connectivityManager?.registerNetworkCallback(
                NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(),
                connectivityCallback,
            )
        }
        publishConnectivity()
    }

    val authCallbacks: AuthCallbackBroker = AuthCallbackBroker()

    /**
     * The activity to open the browser from, while one is on screen.
     *
     * The Custom Tab has to run **in the app's own task**. Launched from the
     * application context it needs `FLAG_ACTIVITY_NEW_TASK`, which puts it in a
     * task of its own — and the `pipod://auth/callback` redirect Chrome then
     * fires never comes back to the `singleTask` activity waiting for it, so the
     * sign-in sits on "Signing in…" forever. Held weakly so a destroyed activity
     * is not kept alive by the process-wide graph.
     */
    @Volatile
    private var activity: WeakReference<Activity>? = null

    /** The grace period [onForeground] is waiting out, if one is running. */
    @Volatile
    private var abandonCheck: Job? = null

    fun attachActivity(value: Activity) {
        activity = WeakReference(value)
    }

    fun detachActivity(value: Activity) {
        if (activity?.get() === value) activity = null
        if (permissionPrompt != null && activity == null) permissionPrompt = null
    }

    /**
     * Asks the OS for notification permission.
     *
     * Only an `Activity` can raise the system prompt, and only one registered
     * before it started; the activity installs its launcher here on create. With
     * nothing installed the answer is "denied" rather than a crash — which is
     * also the honest answer, because no prompt was shown.
     */
    @Volatile
    var permissionPrompt: (suspend (String) -> Boolean)? = null

    val notifier: LocalNotifier = AndroidLocalNotifier(context)

    /** Per-pod composer drafts. Losing typed work is the one thing a composer must not do. */
    val drafts: SessionDraftStore = SharedPreferencesSessionDraftStore(context)

    /**
     * Rebuilt whenever a debug launch extra repoints the app, so a `make android`
     * run reaches the local server and the throwaway issuer without a reinstall.
     */
    @Volatile
    var oidc: OidcClient = newOidcClient()
        private set

    @Volatile
    var api: ApiClient = newApiClient()
        private set

    @Volatile
    var authService: ZitadelAuthService = newAuthService()
        private set

    @Volatile
    var push: PushController = newPushController()
        private set

    @Volatile
    var session: SessionStore = newSessionStore()
        private set

    /**
     * Applies a debug launch's overrides and rebuilds everything that captured
     * one. Returns true when something changed, so the caller can restart the
     * screens holding a client.
     */
    fun applyLaunchExtras(intent: Intent?): Boolean {
        val changed = RuntimeConfig.applyLaunchExtras { key -> intent?.getStringExtra(key) }
        if (!changed) return false
        session.dispose()
        // The old graph's streams point at the old server; a repoint is a
        // sign-out in everything but name.
        LiveSessionStreams.disposeAll()
        oidc = newOidcClient()
        api = newApiClient()
        authService = newAuthService()
        push = newPushController()
        session = newSessionStore()
        return true
    }

    private fun newOidcClient() = OidcClient(
        clientId = RuntimeConfig.oidcMobileClientId,
        issuer = RuntimeConfig.oidcIssuer,
        httpClient = oidcHttpClient,
    )

    private fun newApiClient(): ApiClient {
        val client = oidc
        val api = ApiClient(
            baseUrl = RuntimeConfig.serverUrl,
            httpClient = httpClient,
            accessToken = RuntimeConfig.devToken.ifEmpty { null },
            refreshTokens = TokenRefresher { client.refresh(it) },
        )
        // A refresh mints a new token pair; if it is not written back, the next
        // cold start signs the user out despite a perfectly good session.
        //
        // Written *before* the retried request goes out, not launched alongside
        // it: the interceptor awaits this. Fire-and-forget lost the race with a
        // session restoration reading the same keys, which then spent the token
        // the provider had already retired and invalidated the whole chain.
        api.onTokensUpdated = { access, refresh, id ->
            tokenStorage.write(SessionKeys.ACCESS, access)
            tokenStorage.write(SessionKeys.REFRESH, refresh)
            id?.let { tokenStorage.write(SessionKeys.ID_TOKEN, it) }
        }
        return api
    }

    private fun newAuthService() = ZitadelAuthService(
        oidc = oidc,
        openUrl = ::openInBrowser,
        broker = authCallbacks,
        scope = appScope,
        storeProof = { tokenStorage.write(ZitadelAuthService.AUTHORIZATION_PROOF_KEY, it) },
        readProof = { tokenStorage.read(ZitadelAuthService.AUTHORIZATION_PROOF_KEY) },
        clearProof = { tokenStorage.delete(ZitadelAuthService.AUTHORIZATION_PROOF_KEY) },
        // The attempt that spends the authorization code is the thing that saves
        // what it bought. Reading `session` late rather than capturing it keeps
        // this correct across `applyLaunchExtras`, which rebuilds the store.
        onAuthorized = { session.applyAuthorization(it) },
    )

    private fun newPushController() = PushController(
        api = api,
        notifier = notifier,
        requestPermission = ::requestNotificationPermission,
        openSettings = ::openNotificationSettings,
    )

    private suspend fun requestNotificationPermission(): Boolean {
        // Below API 33 there is no runtime permission to ask for: the manifest
        // one is granted at install, so the only question is whether the user
        // has switched notifications off for the app.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return notifier.isPermitted()
        val prompt = permissionPrompt ?: return false
        return prompt(Manifest.permission.POST_NOTIFICATIONS)
    }

    /**
     * Opens this app's notification settings.
     *
     * Android only shows the permission prompt once; after a refusal the system
     * settings page is the only way back, so "Open notification settings" has to
     * land somewhere specific rather than on the top-level settings app.
     */
    private fun openNotificationSettings() {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        val host = activity?.get()
        runCatching {
            if (host != null) {
                host.startActivity(intent)
            } else {
                context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }

    private fun newSessionStore(): SessionStore {
        val store = SessionStore(
            api = ApiClientSessionStoreApi(api),
            storage = tokenStorage,
            authenticator = BrowserSessionAuthenticator(authService),
            onBadgeChanged = { badge ->
                appScope.launch { push.onPendingCount(badge.count, badge.byPod) }
            },
            pendingAuthCallback = { authCallbacks.hasPending },
            scope = appScope,
        )
        api.onSessionExpired = store::handleUnauthorized
        // Signing out has to reach past the credentials. A live gateway socket
        // keeps streaming the conversation of the person who just left, and the
        // drafts and receipts they typed sit in plain preferences waiting for
        // whoever signs in next on this device.
        store.onSessionCleared(::clearLocalUserData)
        return store
    }

    /**
     * Everything a sign-out has to reach past the credentials.
     *
     * A live gateway socket keeps streaming the conversation of the person who
     * just left; drafts and receipts sit in plain preferences waiting for
     * whoever signs in next on this device; and decoded attachment tiles are
     * held process-wide against the attachment's id, which is the one thing the
     * round-one teardown missed.
     */
    internal fun clearLocalUserData() {
        LiveSessionStreams.disposeAll()
        drafts.clearAll()
        InteractionDraftStore.clearAll()
        InteractionReceiptStore.clearAll()
        AppThumbnails.clearCache()
    }

    /**
     * The activity is in the foreground again.
     *
     * Returning to the app is what an abandoned sign-in looks like — the person
     * pressed back on the authorization page — and also what a *successful* one
     * looks like a moment before its redirect lands. So this waits out a short
     * grace period and then abandons only if nothing arrived: no redirect
     * reached the service, and nothing is parked in the broker. Without it the
     * abandoned attempt suspends forever and every later sign-in joins it,
     * opening no browser and reporting nothing.
     */
    fun onForeground() {
        val service = authService
        if (!service.isAwaitingRedirect) return
        abandonCheck?.cancel()
        abandonCheck = appScope.launch {
            delay(SIGN_IN_ABANDON_GRACE_MS)
            if (!service.isAwaitingRedirect || authCallbacks.hasPending) return@launch
            service.abandonSignIn()
        }
    }

    /**
     * Starts session restoration, once per process.
     *
     * Restoration used to be driven by the gate composable, which is composed
     * per destination — so every tab change re-read the keystore, rotated the
     * refresh token again, and flashed "Restoring session…" over the app.
     * [SessionStore.restore] now latches, and this is the one call that starts
     * it. It runs after the launch extras have been applied so a debug build
     * points at the right server before the first request.
     */
    fun startRestore() {
        val store = session
        appScope.launch { store.restore() }
    }

    /** Keeps the settings screen's cached permission honest with the OS. */
    fun refreshNotificationAuthorization() {
        val controller = push
        appScope.launch { controller.refresh() }
    }

    /**
     * Opens the authorization page in a Custom Tab.
     *
     * Never a WebView: a WebView would hand this app the user's
     * identity-provider credentials, which is the whole thing the
     * authorization-code flow exists to prevent. A Custom Tab also shares the
     * browser's session, so a user already signed in is not asked again.
     */
    private fun openInBrowser(uri: Uri): Boolean {
        val host = activity?.get()
        val opened = runCatching {
            val tab = CustomTabsIntent.Builder().setShowTitle(true).build()
            if (host != null) {
                tab.launchUrl(host, uri)
            } else {
                tab.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                tab.launchUrl(context, uri)
            }
            true
        }.getOrDefault(false)
        if (opened) return true

        // A device with no Custom Tabs provider at all still has to be able to
        // sign in; any browser that can view a URL will do.
        return runCatching {
            val view = Intent(Intent.ACTION_VIEW, uri)
            if (host != null) {
                host.startActivity(view)
            } else {
                context.startActivity(view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            true
        }.getOrDefault(false)
    }

    companion object {
        /** The compiled-in production issuer, for a screen that wants to name it. */
        val productionIssuer: String get() = Config.OIDC_ISSUER

        /**
         * How long a returning activity waits before deciding the browser came
         * back empty-handed. The redirect is delivered through `onNewIntent`,
         * which precedes `onResume` — this covers the case where it does not.
         */
        internal const val SIGN_IN_ABANDON_GRACE_MS = 1_500L

        /**
         * The whole-call bound on identity-provider requests, in seconds.
         *
         * Named here so the value is one fact rather than a literal buried in
         * a builder chain. It applies only to [oidcHttpClient]; the API client
         * and the session socket are untouched.
         */
        internal const val OIDC_CALL_TIMEOUT_SECONDS = 20L
    }
}

/** Adapts the browser OIDC service to the session state machine's boundary. */
private class BrowserSessionAuthenticator(
    private val service: ZitadelAuthService,
) : SessionAuthenticator {

    override suspend fun signIn(callback: String?, organizationAlias: String?): AuthResponse =
        service.signIn(
            callback = callback?.let(Uri::parse),
            organizationAlias = organizationAlias,
        )

    override suspend fun signOut(refreshToken: String?, idToken: String?) =
        service.signOut(refreshToken = refreshToken, idToken = idToken)
}
