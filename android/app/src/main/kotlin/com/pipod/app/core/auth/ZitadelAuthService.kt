package com.pipod.app.core.auth

import android.net.Uri
import com.pipod.app.core.api.ApiJson
import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.AuthResponse
import com.pipod.app.core.config.Config
import java.security.SecureRandom
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * Browser-based OIDC authorization-code flow with PKCE and nonce binding.
 *
 * Port of `pi-pod-flutter/lib/core/auth/zitadel_auth.dart`. The authorization
 * page opens in the system browser (a Custom Tab), never a WebView: a WebView
 * would hand this app the user's identity-provider credentials, which is
 * exactly what the code flow exists to avoid.
 */
class ZitadelAuthService(
    private val oidc: OidcClient,
    private val openUrl: suspend (Uri) -> Boolean,
    private val broker: AuthCallbackBroker,
    private val scope: CoroutineScope,
    private val callbackRedirectUri: String = Config.MOBILE_CALLBACK_URL,
    private val postLogoutRedirectUri: String? = Config.MOBILE_CALLBACK_URL,
    private val includeOfflineAccess: Boolean = true,
    private val storeProof: suspend (String) -> Unit,
    private val readProof: suspend () -> String?,
    private val clearProof: suspend () -> Unit,
    /**
     * Persists the tokens the moment the exchange succeeds, inside the shared
     * attempt rather than in whatever coroutine happened to be awaiting it.
     *
     * [signIn] returns `attempt.await()`, and the attempt itself runs in the
     * application scope — so a caller whose composition was disposed mid-login
     * had its `await` cancelled while the attempt carried on, spent the
     * one-shot authorization code, and threw the tokens away. Nothing else
     * could pick them up either: the redirect had been consumed and the park
     * drained. Running the persist here means the attempt that spends the code
     * is the thing that saves what it bought.
     */
    private val onAuthorized: suspend (AuthResponse) -> Unit = {},
    private val random: SecureRandom = SecureRandom(),
    /**
     * How long a browser round trip may take before the wait gives up. An
     * identity provider page with a password manager and an MFA prompt is
     * minutes of work, so this is generous — what matters is that it is finite.
     */
    private val signInTimeout: Duration = DEFAULT_SIGN_IN_TIMEOUT,
) : AuthService {

    private val gate = Mutex()

    @Volatile
    private var inFlight: Deferred<AuthResponse>? = null

    @Volatile
    private var deliveredCallback: CompletableDeferred<Uri>? = null

    @Volatile
    private var offeredCallback: Uri? = null

    /** True once the authorization page is actually up for the attempt in flight. */
    @Volatile
    private var browserOpened = false

    /** True once a redirect for the attempt in flight has arrived, on either channel. */
    @Volatile
    private var redirectReceived = false

    val isConfigured: Boolean get() = oidc.clientId.isNotEmpty() && oidc.issuer.isNotEmpty()

    /**
     * True while an authorization round trip is open. Read from the activity's
     * foreground callback, which is why it is a plain volatile rather than
     * something the mutex guards.
     */
    val isSignInInFlight: Boolean get() = inFlight?.isActive == true

    /** True once the browser is up and no redirect has come back from it yet. */
    val isAwaitingRedirect: Boolean get() = browserOpened && !redirectReceived

    /**
     * Gives up on a browser the person walked away from.
     *
     * Dismissing the authorization page fires no redirect, so the wait below had
     * nothing to end it: the attempt suspended for the life of the process,
     * `inFlight` was never cleared (it is cleared in the creator's `finally`,
     * which cannot run while the creator is suspended inside it), and every
     * later `signIn()` joined that dead attempt — no browser, no error, nothing.
     *
     * Refuses when a redirect has already arrived: returning to the app is also
     * what a *successful* sign-in looks like from the activity's side.
     *
     * @return true when a wait was actually ended.
     */
    fun abandonSignIn(): Boolean {
        if (!isAwaitingRedirect) return false
        val waiter = deliveredCallback ?: return false
        if (waiter.isCompleted) return false
        return waiter.completeExceptionally(ApiError(error = SIGN_IN_INCOMPLETE))
    }

    override suspend fun signIn(callback: Uri?, organizationAlias: String?): AuthResponse {
        val incoming = authResult(callback)
        val (attempt, owned) = gate.withLock {
            // A *completed* attempt is history, never something to join: its
            // authorization code is spent and, after a sign-out, its tokens are
            // revoked. Only a live one coalesces.
            inFlight?.takeIf { !it.isCompleted }?.let { return@withLock it to false }
            val created = scope.async { performSignIn(incoming, organizationAlias) }
            inFlight = created
            // The attempt owns its own teardown as well, because the creator
            // below may never reach its `finally`: an awaiter cancelled while the
            // browser is still open leaves the attempt running, and something has
            // to retire it when it eventually settles.
            created.invokeOnCompletion { scope.launch { retire(created) } }
            created to true
        }
        if (!owned) {
            // Outside the lock: [offerCallback] takes it, and this mutex is not
            // re-entrant.
            if (incoming != null) offerCallback(incoming)
            return attempt.await()
        }
        try {
            return attempt.await()
        } finally {
            // A cancelled awaiter is not a finished attempt. The attempt lives in
            // the application scope with the browser still open in front of the
            // person using it; tearing its state down here would drain the
            // redirect out from under it and let the next `signIn()` start a
            // second authorization against the same browser session.
            //
            // NonCancellable because this *is* the cancellation path: an awaiter
            // cancelled as its attempt finished would otherwise skip the mutex
            // and hand the next caller a dead attempt to join.
            if (attempt.isCompleted) withContext(NonCancellable) { retire(attempt) }
        }
    }

    /** Idempotent: whichever of the two paths gets here first does the work. */
    private suspend fun retire(attempt: Deferred<AuthResponse>) {
        gate.withLock {
            if (inFlight !== attempt) return@withLock
            inFlight = null
            deliveredCallback = null
            offeredCallback = null
            browserOpened = false
            redirectReceived = false
            // Whatever is still parked belongs to this finished attempt: a live
            // emission already confirmed its own copy, so anything left is a
            // redirect nobody consumed. Draining it (inside the lock, before a
            // newer attempt can start) stops a spent code from being mistaken
            // for a fresh cold-start callback next time. The park is the only
            // durable copy — `_callbacks` has `replay = 0` and drops what no
            // collector is holding — so this drain is what makes "exactly once"
            // true.
            broker.takePending()
        }
    }

    private suspend fun performSignIn(incoming: Uri?, organizationAlias: String?): AuthResponse {
        browserOpened = false
        redirectReceived = false
        // Consume a platform callback even when the router supplied the same URI.
        // Otherwise a cold-start callback can be replayed on the next login.
        val pending = broker.takePending()
        val already = incoming ?: pending
        if (already != null) return authorized(completeCallback(already, callbackRedirectUri))

        check(isConfigured) {
            "Zitadel is not configured. Set PIPOD_OIDC_ISSUER and the mobile OIDC client id."
        }

        val scopes = Config.requestedOidcScopes(organizationAlias, includeOfflineAccess)
        val metadata = oidc.discover()
        val pkce = PkcePair.generate(random)
        val state = randomUrlSafe(24)
        val nonce = randomUrlSafe(32)
        storeProof(AuthorizationProof(pkce.verifier, state, nonce).encode())

        val authorize = authorizeUrl(metadata, callbackRedirectUri, pkce, state, nonce, scopes)
        if (!openUrl(Uri.parse(authorize.toString()))) {
            throw ApiError(error = "Could not open the sign-in page in a browser.")
        }
        browserOpened = true

        val redirect = try {
            awaitCallback()
        } catch (incomplete: ApiError) {
            // Abandoned or timed out: the proof is single-use and this attempt
            // is over, so it goes with the attempt rather than waiting to be
            // half-matched against whatever redirect arrives next.
            clearProof()
            throw incomplete
        }
        return authorized(
            completeCallback(
                redirect,
                redirectUri = callbackRedirectUri,
                verifier = pkce.verifier,
                state = state,
                nonce = nonce,
            ),
        )
    }

    /** Persists before the attempt resolves, so a cancelled awaiter loses nothing. */
    private suspend fun authorized(response: AuthResponse): AuthResponse {
        onAuthorized(response)
        return response
    }

    /**
     * Finishes a login from the redirect URI.
     *
     * Ownership is settled first and destructively second. `state` is what binds
     * a redirect to the attempt that asked for it, and any installed app can
     * deliver a `pipod://auth/callback` — so a redirect that does not carry this
     * attempt's state is refused while the single-use proof is left exactly as
     * it was. Clearing on an unrecognised `?error=access_denied` is a
     * cancel-anyone's-sign-in primitive: the browser then comes back with a
     * perfectly good code and there is no verifier left to spend it with.
     *
     * Once the redirect *is* ours the proof is single-use and is cleared before
     * the network exchange, so a failed or replayed code cannot reuse the
     * verifier, state or nonce.
     */
    suspend fun completeCallback(
        callback: Uri,
        redirectUri: String,
        verifier: String? = null,
        state: String? = null,
        nonce: String? = null,
    ): AuthResponse {
        var proof = verifier
        var expectedState = state
        var expectedNonce = nonce
        if (proof.isNullOrEmpty() || expectedNonce == null) {
            AuthorizationProof.tryDecode(readProof())?.let { stored ->
                if (proof.isNullOrEmpty()) proof = stored.verifier
                if (expectedState == null) expectedState = stored.state
                if (expectedNonce == null) expectedNonce = stored.nonce
            }
        }

        // A mismatch is what a forged or replayed callback looks like, so it is
        // refused rather than exchanged — and it is reported as a sign-in
        // problem, not a network one, because telling someone to check their
        // connection sends them after entirely the wrong thing.
        val returnedState = callback.getQueryParameter("state").orEmpty()
        val expected = expectedState
        if (expected.isNullOrEmpty() || returnedState != expected) {
            throw ApiError(error = SIGN_IN_MISMATCH)
        }

        val code = callback.getQueryParameter("code")
        if (code.isNullOrEmpty()) {
            // This redirect is ours and it carries no code: the attempt is over
            // either way, so the proof goes with it.
            clearProof()
            throw when (val error = callback.getQueryParameter("error")) {
                null -> ApiError(error = SIGN_IN_INCOMPLETE)
                "access_denied" -> ApiError(error = "Sign-in was cancelled.")
                else -> ApiError(error = "Sign-in was refused by the identity provider ($error).")
            }
        }

        val resolvedVerifier = proof
        val resolvedNonce = expectedNonce
        if (resolvedVerifier.isNullOrEmpty() || resolvedNonce.isNullOrEmpty()) {
            throw ApiError(error = SIGN_IN_INCOMPLETE)
        }

        clearProof()
        return oidc.exchangeCode(
            code = code,
            codeVerifier = resolvedVerifier,
            redirectUri = redirectUri,
            expectedNonce = resolvedNonce,
            // Zitadel's browser app intentionally has no refresh-token grant and
            // receives an access/ID-token pair. Native clients require the
            // offline grant promised by their app registrations.
            requireRefreshToken = includeOfflineAccess,
        )
    }

    override suspend fun signOut(refreshToken: String?, idToken: String?) {
        val logout = oidc.logoutUrl(
            refreshToken = refreshToken,
            idToken = idToken,
            postLogoutRedirectUri = postLogoutRedirectUri,
        ) ?: return
        openUrl(Uri.parse(logout.toString()))
    }

    private fun authorizeUrl(
        metadata: OidcMetadata,
        redirectUri: String,
        pkce: PkcePair,
        state: String,
        nonce: String,
        scopes: List<String>,
    ) = metadata.authorizationEndpoint.newBuilder()
        .setQueryParameter("client_id", oidc.clientId)
        .setQueryParameter("redirect_uri", redirectUri)
        .setQueryParameter("response_type", "code")
        .setQueryParameter("scope", scopes.joinToString(" "))
        .setQueryParameter("code_challenge", pkce.challenge)
        .setQueryParameter("code_challenge_method", "S256")
        .setQueryParameter("state", state)
        .setQueryParameter("nonce", nonce)
        .build()

    /**
     * Waits for the redirect, accepting one that arrived while the browser was
     * still opening.
     *
     * Bounded three ways, because the browser is not obliged to come back at
     * all: the redirect itself, [abandonSignIn] completing [deliveredCallback]
     * exceptionally, and [signInTimeout]. An unbounded wait here wedged every
     * later sign-in in the process.
     */
    private suspend fun awaitCallback(): Uri = coroutineScope {
        offeredCallback?.let { offered ->
            offeredCallback = null
            redirectReceived = true
            return@coroutineScope offered
        }
        val direct = CompletableDeferred<Uri>()
        gate.withLock { deliveredCallback = direct }
        // The parked redirect is re-checked *after* the subscription exists, not
        // before it. Checking first leaves a window — the whole of
        // `broker.callbacks.first()`'s own subscribe — in which a redirect that
        // arrives is neither seen by this check nor delivered to a collector,
        // and the sign-in then waits for a callback that already came back.
        val fromBroker = async {
            broker.callbacks
                .onSubscription { broker.takePending()?.let { emit(it) } }
                .first()
        }
        try {
            val redirect = withTimeoutOrNull<Uri>(signInTimeout) {
                select<Uri> {
                    direct.onAwait { it }
                    fromBroker.onAwait { it }
                }
            } ?: throw ApiError(error = SIGN_IN_INCOMPLETE)
            redirectReceived = true
            broker.confirmDelivered(redirect)
            redirect
        } finally {
            fromBroker.cancel()
        }
    }

    private suspend fun offerCallback(uri: Uri) {
        offeredCallback = uri
        redirectReceived = true
        gate.withLock { deliveredCallback }?.takeIf { !it.isCompleted }?.complete(uri)
    }

    private fun randomUrlSafe(bytes: Int): String =
        PkcePair.base64Url(ByteArray(bytes).also(random::nextBytes))

    companion object {
        /** Where the single-use PKCE/state/nonce triple is parked between screens. */
        const val AUTHORIZATION_PROOF_KEY = "oidc.authorization_proof"

        internal val DEFAULT_SIGN_IN_TIMEOUT: Duration = 10.minutes

        internal const val SIGN_IN_MISMATCH =
            "That sign-in link doesn’t match this attempt, so it wasn’t used. Sign in again."
        internal const val SIGN_IN_INCOMPLETE = "Sign-in didn’t complete. Sign in again."

        /**
         * Only a redirect that actually carries a result resumes a login. A bare
         * `pipod://auth/callback` — a stale shortcut, a shared link — must not
         * be mistaken for one.
         */
        private fun authResult(uri: Uri?): Uri? {
            if (uri == null) return null
            val code = uri.getQueryParameter("code")
            val error = uri.getQueryParameter("error")
            return if (code.isNullOrEmpty() && error.isNullOrEmpty()) null else uri
        }
    }
}

/** The single-use proof binding one authorization request to its redirect. */
internal data class AuthorizationProof(
    val verifier: String,
    val state: String,
    val nonce: String,
) {
    fun encode(): String = ApiJson.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("verifier", verifier)
            put("state", state)
            put("nonce", nonce)
        },
    )

    companion object {
        fun tryDecode(encoded: String?): AuthorizationProof? {
            if (encoded.isNullOrEmpty()) return null
            val value = runCatching { ApiJson.parseToJsonElement(encoded).jsonObject }.getOrNull()
                ?: return null
            val verifier = (value["verifier"] as? JsonPrimitive)?.contentOrNull
            val state = (value["state"] as? JsonPrimitive)?.contentOrNull
            val nonce = (value["nonce"] as? JsonPrimitive)?.contentOrNull
            if (verifier.isNullOrEmpty() || state.isNullOrEmpty() || nonce.isNullOrEmpty()) return null
            return AuthorizationProof(verifier, state, nonce)
        }
    }
}
