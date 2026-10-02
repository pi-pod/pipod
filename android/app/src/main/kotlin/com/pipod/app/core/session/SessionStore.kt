package com.pipod.app.core.session

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.AuthResponse
import com.pipod.app.core.api.model.AuthUser
import com.pipod.app.core.api.model.BillingSummary
import com.pipod.app.core.api.model.Job
import com.pipod.app.core.api.model.MeResponse
import com.pipod.app.core.api.model.Organization
import com.pipod.app.core.api.model.RefreshResponse
import com.pipod.app.core.auth.OidcSessionExpiredException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Immutable view state for everything that depends on who is signed in. */
data class SessionStoreState(
    val user: AuthUser? = null,
    val organization: Organization? = null,
    val currentOrgId: String? = null,
    val permissions: List<String> = emptyList(),
    /**
     * Where the identity provider lets an administrator manage the
     * organization. Null when the signed-in person may not open it.
     */
    val adminConsoleUrl: String? = null,
    /**
     * The SaaS account summary from `/v1/me`. Null on the self-hosted static
     * backend, which does not send it — the surface then hides silently.
     */
    val billing: BillingSummary? = null,
    val isRestoringSession: Boolean = true,
    val pendingDeepLink: Any? = null,
    val authNotice: String? = null,
)

/**
 * Where refresh/access/id tokens live between launches.
 *
 * Free of `Context` so a unit test can fake it; the Android implementation is
 * [SecureSessionTokenStorage].
 */
interface SessionTokenStorage {
    suspend fun read(key: String): String?
    suspend fun write(key: String, value: String)
    suspend fun delete(key: String)
}

/**
 * Keystore-backed token storage, the Android equivalent of Flutter's
 * `flutter_secure_storage`.
 *
 * A device whose keystore refuses must not stop the app from starting — a
 * corrupted key entry, a locked-boot user, or a vendor bug fails every
 * `EncryptedSharedPreferences` call, and treating that as fatal makes the app
 * unusable rather than merely forgetful. Degrade instead: reads report "nothing
 * stored", writes are dropped, and the person signs in again next launch. The
 * refusal latches so a broken keystore costs one failed call per launch instead
 * of one per token read.
 */
class SecureSessionTokenStorage(context: Context) : SessionTokenStorage {

    private val appContext = context.applicationContext

    @Volatile
    private var unavailable = false

    @Volatile
    private var preferences: SharedPreferences? = null

    /**
     * Whether tokens are being persisted. False once the platform store has
     * refused, which is what makes "you were signed out again" explicable
     * rather than a mystery.
     */
    val isPersistent: Boolean get() = !unavailable

    override suspend fun read(key: String): String? = tolerate { it.getString(key, null) }

    override suspend fun write(key: String, value: String) {
        tolerate { it.edit().putString(key, value).commit() }
    }

    override suspend fun delete(key: String) {
        tolerate { it.edit().remove(key).commit() }
    }

    private suspend fun <T> tolerate(action: (SharedPreferences) -> T): T? {
        if (unavailable) return null
        return withContext(Dispatchers.IO) {
            try {
                action(preferences ?: open().also { preferences = it })
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                unavailable = true
                null
            }
        }
    }

    private fun open(): SharedPreferences {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            appContext,
            FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    private companion object {
        const val FILE_NAME = "pipod-session-tokens"
    }
}

/** Authentication UI is kept outside the session state machine. */
interface SessionAuthenticator {
    suspend fun signIn(callback: String? = null, organizationAlias: String? = null): AuthResponse
    suspend fun signOut(refreshToken: String? = null, idToken: String? = null)
}

/** Narrow API boundary for deterministic state restoration tests. */
interface SessionStoreApi {
    var accessToken: String?
    var refreshToken: String?
    var idToken: String?

    suspend fun refresh(refreshToken: String): RefreshResponse
    suspend fun me(): MeResponse
}

class ApiClientSessionStoreApi(private val client: ApiClient) : SessionStoreApi {

    override var accessToken: String?
        get() = client.accessToken
        set(value) {
            client.accessToken = value
        }

    override var refreshToken: String?
        get() = client.refreshToken
        set(value) {
            client.refreshToken = value
        }

    override var idToken: String?
        get() = client.idToken
        set(value) {
            client.idToken = value
        }

    override suspend fun refresh(refreshToken: String): RefreshResponse = client.refresh(refreshToken)

    override suspend fun me(): MeResponse = client.me()

}

/**
 * The signed-in state machine: token restoration and sign-in/out.
 *
 * Port of `pi-pod-flutter/lib/core/session/session_store.dart` minus its
 * Riverpod adapter — this app wires its graph by hand, so the class itself is
 * the whole surface.
 *
 * [scope] owns fire-and-forget work ([handleUnauthorized]); [dispose] cancels
 * it. Pass a scope you own (an `Application`-lifetime one in production) and
 * the store will not cancel
 * it, matching how [SessionStream] treats its scope.
 */
class SessionStore(
    private val api: SessionStoreApi,
    private val storage: SessionTokenStorage,
    private val authenticator: SessionAuthenticator? = null,
    /**
     * True when an authorization redirect arrived with nothing waiting for it —
     * the app was killed while the browser was open. The gate resumes it instead
     * of asking for another "Sign in" tap.
     */
    private val pendingAuthCallback: () -> Boolean = { false },
    scope: CoroutineScope? = null,
) {

    private val ownsScope = scope == null
    private val scope = scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _state = MutableStateFlow(SessionStoreState())
    val state: StateFlow<SessionStoreState> = _state.asStateFlow()

    /**
     * Atomic because [handleUnauthorized] fires from OkHttp's thread pool while
     * a foreground restoration may be starting on another: two threads reading
     * a plain flag both see "idle" and both spend the one-time-use refresh
     * token, which the provider answers by invalidating the whole chain.
     */
    private val isRefreshing = AtomicBoolean(false)

    /**
     * Restoration is a once-per-process job. The gate that calls it is composed
     * on every tab, so without this latch each navigation re-read the keystore,
     * rotated the refresh token again, and flashed "Restoring session…".
     * [restore] takes an explicit `force` for the two paths that genuinely have
     * to run again: a 401 and a foreground return.
     */
    @Volatile
    private var hasRestored = false

    private var disposed = false

    /**
     * Fired from [clearSession]. Sign-out has to reach further than this class:
     * a live session socket keeps streaming somebody else's conversation, and
     * drafts sit in plaintext preferences until something drops
     * them.
     */
    private val sessionClearedListeners = CopyOnWriteArrayList<() -> Unit>()

    /** The authorization already applied, so [applyAuthorization] is idempotent. */
    @Volatile
    private var appliedAuthorization: AuthResponse? = null

    /**
     * Registers a listener for sign-out. Returns the unregistration, so a caller
     * with a shorter life than the store can let go.
     */
    fun onSessionCleared(listener: () -> Unit): () -> Unit {
        sessionClearedListeners += listener
        return { sessionClearedListeners -= listener }
    }

    /** True when a redirect is parked with no sign-in waiting for it. */
    val hasPendingAuthCallback: Boolean get() = runCatching(pendingAuthCallback).getOrDefault(false)

    /**
     * Applies [change] to the current state.
     *
     * Read-modify-write through [MutableStateFlow.update] rather than
     * `copy(…)` of a separately read value: a 401 from
     * OkHttp's pool and the foreground restoration all publish concurrently, and
     * a lost update there strands `isRestoringSession` at true — a permanent
     * spinner over the whole app.
     */
    private fun publish(change: (SessionStoreState) -> SessionStoreState) {
        if (disposed) return
        _state.update(change)
    }

    suspend fun setOrganizationAlias(organizationAlias: String) {
        val alias = organizationAlias.trim()
        if (alias.isEmpty()) {
            throw IllegalStateException("Organization alias is required to switch organization.")
        }
        val auth = authenticator
            ?: throw IllegalStateException("A SessionAuthenticator is required to switch organization.")
        val response = auth.signIn(organizationAlias = alias)
        // What the old organization left behind goes the way a sign-out sends it:
        // its live sessions would keep streaming under the new identity, and its
        // drafts and deep links would act in the wrong tenant.
        publish { it.copy(pendingDeepLink = null) }
        notifySessionCleared()
        applyAuthorization(response)
    }

    fun setPendingDeepLink(destination: Any?) {
        publish { it.copy(pendingDeepLink = destination) }
    }

    /**
     * Restores the signed-in session from stored credentials.
     *
     * Runs once per process. [force] is for the two callers that must repeat it
     * anyway: [handleUnauthorized], where the access token has just been
     * refused, and a foreground return after the process was backgrounded long
     * enough for the token to age out. Everything else — every screen, every
     * navigation — may call this freely and gets a no-op.
     */
    suspend fun restore(showExpiryNotice: Boolean = true, force: Boolean = false) {
        if (hasRestored && !force) return
        if (!isRefreshing.compareAndSet(false, true)) return
        publish { it.copy(isRestoringSession = true) }
        var settled = false
        try {
            // The rotated token in memory is newer than the one on disk: the
            // interceptor's write-back and this read are two different
            // operations, and reading the spent token here is what signs a
            // perfectly good session out.
            val refresh = api.refreshToken?.takeIf { it.isNotEmpty() } ?: storage.read(SessionKeys.REFRESH)
            if (api.idToken.isNullOrEmpty()) api.idToken = storage.read(SessionKeys.ID_TOKEN)
            if (refresh.isNullOrEmpty()) {
                settled = restoreFromAccessToken(showExpiryNotice)
                return
            }
            try {
                val tokens = api.refresh(refresh)
                api.accessToken = tokens.accessToken
                api.refreshToken = tokens.refreshToken
                storage.write(SessionKeys.REFRESH, tokens.refreshToken)
                val rotatedIdToken = tokens.idToken
                if (!rotatedIdToken.isNullOrEmpty()) {
                    api.idToken = rotatedIdToken
                    storage.write(SessionKeys.ID_TOKEN, rotatedIdToken)
                }
                loadMe()
                publish { it.copy(authNotice = null) }
                settled = true
            } catch (_: OidcSessionExpiredException) {
                clearSession()
                if (showExpiryNotice) publish { it.copy(authNotice = SESSION_EXPIRED_NOTICE) }
                settled = true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // Keep refresh/id tokens and any loaded identity during provider
                // or network outages. A later foreground/401 retry can recover,
                // so this attempt deliberately does not latch.
                if (showExpiryNotice) {
                    publish { it.copy(authNotice = "Could not reach the identity provider. Will retry.") }
                }
            }
        } finally {
            if (settled) hasRestored = true
            isRefreshing.set(false)
            publish { it.copy(isRestoringSession = false) }
        }
    }

    /**
     * Zitadel's web app has no refresh-token grant. Its short-lived access token
     * is kept across launches and validated immediately with the API; a rejected
     * token is discarded rather than refreshed.
     */
    /** True when the outcome is final, so [restore] may latch on it. */
    private suspend fun restoreFromAccessToken(showExpiryNotice: Boolean): Boolean {
        val access = storage.read(SessionKeys.ACCESS)
        if (access.isNullOrEmpty()) {
            if (_state.value.user != null) {
                clearSession()
                if (showExpiryNotice) publish { it.copy(authNotice = SESSION_EXPIRED_NOTICE) }
            }
            // Nothing was stored: there is nothing a later attempt could find.
            return true
        }
        api.accessToken = access
        return try {
            loadMe()
            publish { it.copy(authNotice = null) }
            true
        } catch (_: OidcSessionExpiredException) {
            clearSession()
            if (showExpiryNotice) publish { it.copy(authNotice = SESSION_EXPIRED_NOTICE) }
            true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // A temporary API outage must not destroy an otherwise usable token.
            // A later foreground restoration can validate it again.
            if (showExpiryNotice) {
                publish { it.copy(authNotice = "Could not reach the pi pod server. Will retry.") }
            }
            false
        }
    }

    suspend fun signIn(callback: String? = null) {
        publish { it.copy(authNotice = null) }
        val auth = authenticator ?: throw IllegalStateException("A SessionAuthenticator is required to sign in.")
        applyAuthorization(auth.signIn(callback = callback))
    }

    /**
     * Persists an authorization and loads the identity behind it.
     *
     * Called twice for one browser sign-in and deliberately so: the auth
     * service invokes it from inside the attempt that spent the code (so a
     * cancelled awaiter cannot lose the tokens), and the caller invokes it again
     * with the value it finally received. The second call is a no-op — the same
     * response is not worth a second `/v1/me` — unless the first one never got
     * as far as an identity.
     */
    suspend fun applyAuthorization(response: AuthResponse) {
        if (appliedAuthorization == response && _state.value.user != null) return
        storeAuthorization(response)
        loadMe()
        appliedAuthorization = response
        // A completed sign-in is a restored session; a gate composed afterwards
        // must not start reading the keystore behind it.
        hasRestored = true
    }

    private suspend fun storeAuthorization(response: AuthResponse) {
        api.accessToken = response.accessToken
        api.refreshToken = response.refreshToken
        api.idToken = response.idToken
        val refreshToken = response.refreshToken
        if (refreshToken.isNullOrEmpty()) {
            storage.delete(SessionKeys.REFRESH)
            storage.write(SessionKeys.ACCESS, response.accessToken)
        } else {
            storage.delete(SessionKeys.ACCESS)
            storage.write(SessionKeys.REFRESH, refreshToken)
        }
        val idToken = response.idToken
        if (idToken.isNullOrEmpty()) {
            storage.delete(SessionKeys.ID_TOKEN)
        } else {
            storage.write(SessionKeys.ID_TOKEN, idToken)
        }
    }

    /** Debug-only bypass: the token is stripped to the JWT alphabet before use. */
    suspend fun signInWithDevToken(token: String) {
        publish { it.copy(authNotice = null) }
        api.accessToken = token.replace(NON_TOKEN_CHARACTERS, "")
        loadMe()
        hasRestored = true
    }

    suspend fun loadMe() {
        val me = api.me()
        publish {
            it.copy(
                user = me.user,
                organization = me.organization,
                currentOrgId = me.currentOrgId,
                permissions = me.permissions,
                adminConsoleUrl = me.adminConsoleUrl,
                billing = me.billingSummary,
            )
        }
    }

    suspend fun signOut() {
        val auth = authenticator
        val refreshToken = api.refreshToken
        val idToken = api.idToken
        clearSession()
        publish { it.copy(authNotice = null) }
        try {
            auth?.signOut(refreshToken = refreshToken, idToken = idToken)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // Captured credentials are used best-effort only after local
            // sign-out, so slow discovery, revocation, or a browser launch
            // cannot retain the session.
        }
    }

    /** Wire to `ApiClient.onSessionExpired`; a refresh already in flight owns the retry. */
    fun handleUnauthorized() {
        if (!isRefreshing.get()) scope.launch { restore(force = true) }
    }

    private suspend fun clearSession() {
        storage.delete(SessionKeys.ACCESS)
        storage.delete(SessionKeys.REFRESH)
        storage.delete(SessionKeys.ID_TOKEN)
        api.accessToken = null
        api.refreshToken = null
        api.idToken = null
        appliedAuthorization = null
        // The next launch has nothing to restore, and a gate composed after a
        // sign-out must show the sign-in screen rather than start over.
        hasRestored = false
        publish {
            it.copy(
                user = null,
                organization = null,
                currentOrgId = null,
                permissions = emptyList(),
                adminConsoleUrl = null,
                billing = null,
            )
        }
        notifySessionCleared()
    }

    private fun notifySessionCleared() {
        for (listener in sessionClearedListeners) {
            try {
                listener()
            } catch (_: Throwable) {
                // One listener that throws must not strand the rest — or leave
                // the credentials half-cleared.
            }
        }
    }

    fun dispose() {
        disposed = true
        sessionClearedListeners.clear()
        if (ownsScope) scope.cancel()
    }

    companion object {
        private const val SESSION_EXPIRED_NOTICE = "Your session expired. Please sign in again."
        private val NON_TOKEN_CHARACTERS = Regex("[^A-Za-z0-9_.-]")
    }
}

/** Storage keys, shared with whoever wires `ApiClient.onTokensUpdated`. */
object SessionKeys {
    const val ACCESS = "oidc.access_token"
    const val REFRESH = "oidc.refresh_token"
    const val ID_TOKEN = "oidc.id_token"
}
