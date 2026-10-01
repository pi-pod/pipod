package com.pipod.app.core.auth

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pipod.app.core.api.ApiJson
import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.AuthResponse
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Round 2, diff F1 and core F4: what happens to a sign-in nobody finishes.
 *
 * Instrumented because the whole callback path is written in `android.net.Uri`,
 * and end-to-end against a real discovery document, a real token endpoint and a
 * real signed ID token: a stubbed `OidcClient` would test the stub, and the
 * thing under test here is precisely which coroutine spends the one-shot code
 * and who ends up holding what it bought.
 */
@RunWith(AndroidJUnit4::class)
class SignInLifecycleRound2Test {

    private lateinit var provider: MockWebServer
    private lateinit var keys: KeyPair
    private lateinit var scope: CoroutineScope

    /** Every authorization page the service asked to open. */
    private val opened = CopyOnWriteArrayList<Uri>()

    private val issuer get() = provider.url("/").toString().trimEnd('/')
    private val clientId = "client-under-test"

    @Before
    fun setUp() {
        keys = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        opened.clear()
        provider = MockWebServer()
        provider.start()
        provider.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath.orEmpty()
                return when {
                    path.endsWith("/.well-known/openid-configuration") -> json(discovery())
                    path.endsWith("/jwks") -> json(jwks())
                    path.endsWith("/token") -> json(tokenResponse())
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    @After
    fun tearDown() {
        scope.cancel()
        provider.shutdown()
    }

    // --- diff F1: an abandoned browser must not wedge the process -----------

    @Test
    fun abandoningTheBrowserEndsTheSignInAndTheNextOneOpensAgain() = runBlocking {
        val service = service()

        val first = scope.async { runCatching { service.signIn() } }
        awaitOpened()

        // The person pressed back on the authorization page.
        abandon(service)

        val failure = withTimeout(TIMEOUT) { first.await() }.exceptionOrNull()
        assertTrue(failure is ApiError, "abandoning has to produce an answer, not silence")
        assertEquals(ZitadelAuthService.SIGN_IN_INCOMPLETE, (failure as ApiError).error)
        assertFalse(service.isSignInInFlight, "the in-flight attempt was never cleared")

        val second = scope.async { runCatching { service.signIn() } }
        awaitOpened(count = 2)
        assertEquals(2, opened.size, "every later sign-in joined a dead attempt and opened nothing")

        abandon(service)
        withTimeout(TIMEOUT) { second.await() }
        Unit
    }

    @Test
    fun abandonRefusesOnceTheRedirectHasArrived() = runBlocking {
        val broker = AuthCallbackBroker()
        val service = service(broker)

        val attempt = scope.async { runCatching { service.signIn() } }
        awaitOpened()
        broker.offer(Uri.parse("pipod://auth/callback?code=c&state=${state()}"))

        // Returning to the app is also what a *successful* sign-in looks like
        // from the activity's side, a moment before its redirect is processed.
        awaitUntil { !service.isAwaitingRedirect }
        assertFalse(service.abandonSignIn(), "a sign-in that is about to complete must not be killed")

        assertTrue(withTimeout(TIMEOUT) { attempt.await() }.isSuccess)
    }

    @Test
    fun aBrowserThatNeverAnswersTimesOutRatherThanWaitingForever() = runBlocking {
        val service = service(signInTimeout = 300.milliseconds)

        val failure = withTimeout(TIMEOUT) { runCatching { service.signIn() } }.exceptionOrNull()

        assertTrue(failure is ApiError)
        assertEquals(ZitadelAuthService.SIGN_IN_INCOMPLETE, (failure as ApiError).error)
        assertFalse(service.isSignInInFlight)
        assertEquals(1, opened.size)
    }

    // --- core F4: a cancelled awaiter must not orphan the attempt ------------

    @Test
    fun aCancelledAwaiterLeavesTheAttemptRunningRatherThanStartingASecondOne() = runBlocking {
        val service = service()

        val awaiter = scope.launch { runCatching { service.signIn() } }
        awaitOpened()
        awaiter.cancel()
        awaiter.join()

        // The browser is still open in front of the person using it. A second
        // request has to join that attempt, not race it with a fresh authorize
        // whose state the pending redirect will not match.
        val joined = scope.async { runCatching { service.signIn() } }
        Thread.sleep(300)
        assertEquals(1, opened.size, "the cancelled awaiter tore down a live attempt")

        abandon(service)
        withTimeout(TIMEOUT) { joined.await() }
        Unit
    }

    @Test
    fun theAttemptItselfPersistsTheTokensEvenWhenNobodyIsAwaitingIt() = runBlocking {
        val broker = AuthCallbackBroker()
        val persisted = CompletableDeferred<AuthResponse>()
        val service = service(broker, onAuthorized = { persisted.complete(it) })

        val awaiter = scope.launch { runCatching { service.signIn() } }
        awaitOpened()
        // The composition that started the sign-in is disposed while the browser
        // is up — the ordinary case, since the activity behind a Custom Tab is
        // killable.
        awaiter.cancel()
        awaiter.join()

        broker.offer(Uri.parse("pipod://auth/callback?code=the-code&state=${state()}"))

        val response = withTimeoutOrNull(TIMEOUT) { persisted.await() }
        assertNotNull(
            response,
            "the orphaned attempt spent the one-shot code and threw the tokens away",
        )
        assertEquals("access-token", response.accessToken)
        assertEquals("refresh-token", response.refreshToken)
    }

    // --- fixtures -----------------------------------------------------------

    private fun service(
        broker: AuthCallbackBroker = AuthCallbackBroker(),
        onAuthorized: suspend (AuthResponse) -> Unit = {},
        signInTimeout: Duration = 5.minutes,
    ): ZitadelAuthService {
        var proof: String? = null
        return ZitadelAuthService(
            oidc = OidcClient(clientId = clientId, issuer = issuer),
            openUrl = { uri ->
                opened += uri
                true
            },
            broker = broker,
            scope = scope,
            callbackRedirectUri = REDIRECT,
            storeProof = { proof = it },
            readProof = { proof },
            clearProof = { proof = null },
            onAuthorized = onAuthorized,
            signInTimeout = signInTimeout,
        )
    }

    /** The `state` the newest authorization request bound itself to. */
    private fun state(): String = opened.last().getQueryParameter("state")!!

    /** The `nonce` the newest authorization request bound itself to. */
    private fun nonce(): String? = opened.lastOrNull()?.getQueryParameter("nonce")

    private fun awaitOpened(count: Int = 1) = awaitUntil { opened.size >= count }

    /**
     * Ends the wait the way `MainActivity.onResume` does, once it really is one:
     * `openUrl` returning and the wait being parked are two instants apart.
     */
    private fun abandon(service: ZitadelAuthService) {
        awaitUntil { service.isAwaitingRedirect }
        awaitUntil { service.abandonSignIn() }
    }

    private fun awaitUntil(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + TIMEOUT
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "the sign-in never got that far" }
            Thread.sleep(10)
        }
    }

    private fun json(body: JsonObject) = MockResponse()
        .setResponseCode(200)
        .setHeader("content-type", "application/json")
        .setBody(ApiJson.encodeToString(JsonObject.serializer(), body))

    private fun discovery(): JsonObject = buildJsonObject {
        put("issuer", issuer)
        put("authorization_endpoint", "$issuer/authorize")
        put("token_endpoint", "$issuer/token")
        put("jwks_uri", "$issuer/jwks")
    }

    private fun tokenResponse(): JsonObject = buildJsonObject {
        put("access_token", "access-token")
        put("refresh_token", "refresh-token")
        put("id_token", signedIdToken())
        put("token_type", "Bearer")
    }

    /** Bound to the nonce this attempt asked for, exactly as a provider binds it. */
    private fun signedIdToken(): String {
        val seconds = System.currentTimeMillis() / 1000
        val claims = buildJsonObject {
            put("iss", issuer)
            put("aud", clientId)
            put("sub", "user-1")
            nonce()?.let { put("nonce", it) }
            put("exp", seconds + 600)
            put("iat", seconds - 10)
        }
        val header = base64Url("""{"alg":"RS256","kid":"test-key","typ":"JWT"}""".toByteArray())
        val payload = base64Url(ApiJson.encodeToString(JsonObject.serializer(), claims).toByteArray())
        val signature = Signature.getInstance("SHA256withRSA").run {
            initSign(keys.private as RSAPrivateKey)
            update("$header.$payload".toByteArray(Charsets.US_ASCII))
            sign()
        }
        return "$header.$payload.${base64Url(signature)}"
    }

    private fun jwks(): JsonObject {
        val public = keys.public as RSAPublicKey
        return buildJsonObject {
            putJsonArray("keys") {
                add(
                    buildJsonObject {
                        put("kty", "RSA")
                        put("alg", "RS256")
                        put("use", "sig")
                        put("kid", "test-key")
                        put("n", base64Url(unsigned(public.modulus)))
                        put("e", base64Url(unsigned(public.publicExponent)))
                    },
                )
            }
        }
    }

    /** JWK integers are unsigned; Java's two's-complement sign byte is not part of them. */
    private fun unsigned(value: BigInteger): ByteArray = value.toByteArray()
        .let { if (it.isNotEmpty() && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }

    private fun base64Url(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private companion object {
        const val REDIRECT = "pipod://auth/callback"
        const val TIMEOUT = 15_000L
    }
}
