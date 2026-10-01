package com.pipod.app.core.auth

import com.pipod.app.core.api.ApiJson
import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.AuthResponse
import com.pipod.app.core.api.model.RefreshResponse
import com.pipod.app.core.config.RuntimeConfig
import java.io.IOException
import java.math.BigInteger
import java.net.URI
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.RSAPublicKeySpec
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/** Runtime OIDC provider metadata. Endpoints come only from discovery. */
data class OidcMetadata(
    val issuer: String,
    val authorizationEndpoint: HttpUrl,
    val tokenEndpoint: HttpUrl,
    val jwksUri: HttpUrl,
    val endSessionEndpoint: HttpUrl? = null,
    val revocationEndpoint: HttpUrl? = null,
)

/** The refresh token is no longer valid and local credentials must be cleared. */
class OidcSessionExpiredException(message: String = "session expired") : Exception(message)

/** Discovery, JWKS, or token refresh could not complete because the provider is down. */
class OidcTransientException(message: String) : Exception(message)

/**
 * Direct public-client OIDC.
 *
 * Discovery is the endpoint contract; the configured issuer and the discovered
 * issuer must match byte-for-byte. Port of
 * `pi-pod-flutter/lib/core/auth/oidc_client.dart`.
 */
class OidcClient(
    val clientId: String = RuntimeConfig.oidcMobileClientId,
    val issuer: String = RuntimeConfig.oidcIssuer,
    private val httpClient: OkHttpClient = OkHttpClient(),
    private val now: () -> Long = System::currentTimeMillis,
) {

    // Both caches are read on the fast path *outside* their mutex — that is the
    // point of the double-check — so the write that fills them has to be visible
    // to the thread doing the reading. Without @Volatile a reader on another
    // core may see the reference before the object it points at is fully
    // published, or never see it at all and rediscover on every call.
    private val metadataLock = Mutex()

    @Volatile
    private var metadata: OidcMetadata? = null

    private val jwksLock = Mutex()

    @Volatile
    private var jwks: List<JsonObject>? = null

    val discoveryUri: HttpUrl
        get() {
            val validated = providerUri(issuer, "OIDC issuer", allowQuery = false)
            return validated.newBuilder()
                .addPathSegments(".well-known/openid-configuration")
                .build()
        }

    suspend fun discover(): OidcMetadata {
        metadata?.let { return it }
        return metadataLock.withLock {
            metadata ?: loadMetadata().also { metadata = it }
        }
    }

    suspend fun exchangeCode(
        code: String,
        codeVerifier: String,
        redirectUri: String,
        expectedNonce: String,
        requireRefreshToken: Boolean = true,
    ): AuthResponse {
        val metadata = discover()
        val tokens = token(
            metadata.tokenEndpoint,
            mapOf(
                "grant_type" to "authorization_code",
                "client_id" to clientId,
                "code" to code,
                "redirect_uri" to redirectUri,
                "code_verifier" to codeVerifier,
            ),
        )
        val refreshToken = tokens.refreshToken
        if (requireRefreshToken && refreshToken.isNullOrEmpty()) {
            throw ApiError(error = "Identity provider returned no refresh token")
        }
        val idToken = tokens.idToken
        if (idToken.isNullOrEmpty()) throw ApiError(error = "Identity provider returned no ID token")
        try {
            verifyIdToken(idToken, metadata, expectedNonce)
        } catch (error: InvalidIdTokenException) {
            throw ApiError(error = "Invalid ID token", detail = JsonPrimitive(error.message))
        }
        return AuthResponse(
            accessToken = tokens.accessToken,
            refreshToken = refreshToken,
            idToken = idToken,
        )
    }

    suspend fun refresh(refreshToken: String): RefreshResponse {
        val metadata = discover()
        val tokens = token(
            metadata.tokenEndpoint,
            mapOf(
                "grant_type" to "refresh_token",
                "client_id" to clientId,
                "refresh_token" to refreshToken,
            ),
            refreshRequest = true,
        )
        val idToken = tokens.idToken
        if (!idToken.isNullOrEmpty()) {
            try {
                verifyIdToken(idToken, metadata, expectedNonce = null)
            } catch (error: InvalidIdTokenException) {
                throw OidcSessionExpiredException(
                    "identity provider returned an invalid ID token: ${error.message}",
                )
            }
        }
        return RefreshResponse(
            accessToken = tokens.accessToken,
            refreshToken = tokens.refreshToken ?: refreshToken,
            idToken = idToken,
        )
    }

    /**
     * Revokes the refresh token best-effort, then returns the provider's
     * RP-initiated logout URL for the system browser.
     */
    suspend fun logoutUrl(
        refreshToken: String? = null,
        idToken: String? = null,
        postLogoutRedirectUri: String? = null,
    ): HttpUrl? {
        val metadata = discover()
        val revocation = metadata.revocationEndpoint
        if (revocation != null && !refreshToken.isNullOrEmpty()) {
            runCatching {
                post(
                    revocation,
                    mapOf(
                        "client_id" to clientId,
                        "token" to refreshToken,
                        "token_type_hint" to "refresh_token",
                    ),
                )
            }
            // Revocation must never prevent local or browser sign-out.
        }

        val endpoint = metadata.endSessionEndpoint ?: return null
        return endpoint.newBuilder()
            .setQueryParameter("client_id", clientId)
            .apply {
                if (!idToken.isNullOrEmpty()) setQueryParameter("id_token_hint", idToken)
                if (!postLogoutRedirectUri.isNullOrEmpty()) {
                    setQueryParameter("post_logout_redirect_uri", postLogoutRedirectUri)
                }
            }
            .build()
    }

    // --- discovery ----------------------------------------------------------

    private suspend fun loadMetadata(): OidcMetadata {
        val data = getJson(discoveryUri, "identity provider discovery failed")
        val discoveredIssuer = (data["issuer"] as? JsonPrimitive)?.contentOrNull
        if (discoveredIssuer == null || discoveredIssuer != issuer) {
            throw ApiError(
                error = "OIDC discovery issuer mismatch",
                detail = JsonPrimitive("expected $issuer, received $discoveredIssuer"),
            )
        }
        providerUri(discoveredIssuer, "OIDC issuer", allowQuery = false)
        return OidcMetadata(
            issuer = discoveredIssuer,
            authorizationEndpoint = requiredEndpoint(data, "authorization_endpoint"),
            tokenEndpoint = requiredEndpoint(data, "token_endpoint"),
            jwksUri = requiredEndpoint(data, "jwks_uri"),
            endSessionEndpoint = optionalEndpoint(data, "end_session_endpoint"),
            revocationEndpoint = optionalEndpoint(data, "revocation_endpoint"),
        )
    }

    private suspend fun signingKeys(metadata: OidcMetadata, forceRefresh: Boolean = false): List<JsonObject> {
        if (!forceRefresh) jwks?.let { return it }
        return jwksLock.withLock {
            if (!forceRefresh) jwks?.let { return@withLock it }
            loadJwks(metadata.jwksUri).also { jwks = it }
        }
    }

    private suspend fun loadJwks(uri: HttpUrl): List<JsonObject> {
        val data = getJson(uri, "identity provider JWKS request failed")
        val keys = data["keys"] as? JsonArray
            ?: throw OidcTransientException("identity provider returned an invalid JWKS document")
        val accepted = keys.filterIsInstance<JsonObject>().filter { key ->
            val kty = (key["kty"] as? JsonPrimitive)?.contentOrNull
            val alg = (key["alg"] as? JsonPrimitive)?.contentOrNull
            val use = (key["use"] as? JsonPrimitive)?.contentOrNull
            val operations = key["key_ops"] as? JsonArray
            kty == "RSA" &&
                (alg == null || alg == "RS256") &&
                (use == null || use == "sig") &&
                (operations == null || operations.any { it.jsonPrimitive.contentOrNull == "verify" }) &&
                key["n"] != null && key["e"] != null
        }
        if (accepted.isEmpty()) {
            throw OidcTransientException("identity provider JWKS contains no usable RS256 signing key")
        }
        return accepted
    }

    // --- ID token -----------------------------------------------------------

    /**
     * Test seam for the claim and signature rules.
     *
     * Every negative case here is one a caller could otherwise only reach
     * through a full authorization-code exchange, which would test the
     * transport rather than the checks.
     */
    internal suspend fun verifyIdTokenForTesting(
        idToken: String,
        metadata: OidcMetadata,
        expectedNonce: String? = null,
    ) = verifyIdToken(idToken, metadata, expectedNonce)

    private suspend fun verifyIdToken(idToken: String, metadata: OidcMetadata, expectedNonce: String?) {
        val parts = idToken.split('.')
        if (parts.size != 3) throw InvalidIdTokenException("token is not a compact JWS")
        val header = runCatching { ApiJson.parseToJsonElement(String(base64Url(parts[0]))).jsonObject }
            .getOrElse { throw InvalidIdTokenException("token header is not JSON") }
        if ((header["alg"] as? JsonPrimitive)?.contentOrNull != "RS256") {
            throw InvalidIdTokenException("signing algorithm must be RS256")
        }
        val kid = (header["kid"] as? JsonPrimitive)?.contentOrNull

        val signed = "${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII)
        val signature = base64Url(parts[2])

        // A cached set may be stale during provider key rotation. Fetch once
        // more, but never accept a token that still fails verification.
        if (!verifies(signed, signature, signingKeys(metadata), kid)) {
            if (!verifies(signed, signature, signingKeys(metadata, forceRefresh = true), kid)) {
                throw InvalidIdTokenException("signature verification failed")
            }
        }

        val claims = runCatching { ApiJson.parseToJsonElement(String(base64Url(parts[1]))).jsonObject }
            .getOrElse { throw InvalidIdTokenException("token payload is not JSON") }
        validateClaims(claims, expectedNonce)
    }

    private fun verifies(
        signed: ByteArray,
        signature: ByteArray,
        keys: List<JsonObject>,
        kid: String?,
    ): Boolean {
        // A `kid` narrows the set; a provider that omits it means every key is a
        // candidate, which is what the spec expects a client to do.
        val candidates = keys.filter { kid == null || (it["kid"] as? JsonPrimitive)?.contentOrNull == kid }
            .ifEmpty { keys }
        return candidates.any { key ->
            runCatching {
                val n = BigInteger(1, base64Url(key.getValue("n").jsonPrimitive.content))
                val e = BigInteger(1, base64Url(key.getValue("e").jsonPrimitive.content))
                val publicKey = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(n, e))
                Signature.getInstance("SHA256withRSA").run {
                    initVerify(publicKey)
                    update(signed)
                    verify(signature)
                }
            }.getOrDefault(false)
        }
    }

    /**
     * Checks the claims that decide *whose* token this is and *when* it is good
     * for.
     *
     * Every claim is checked for its JSON type, not just its value. JSON has
     * both a string `"123"` and a number `123`, and a lenient read makes them
     * interchangeable — which is a way in: a numeric `sub` or `aud` that
     * stringifies to the right value would pass an identity check it should
     * fail, and a *string* `exp` of `"NaN"` or `"Infinity"` parses to a double
     * for which every `>=` comparison is false, so an expired token would read
     * as fresh. The type is therefore part of the claim.
     */
    private fun validateClaims(claims: JsonObject, expectedNonce: String?) {
        if (stringClaim(claims, "iss") != issuer) {
            throw InvalidIdTokenException("issuer does not exactly match configuration")
        }

        val audience = claims["aud"]
        val audiences = when (audience) {
            is JsonPrimitive -> if (audience.isString) listOf(audience.content) else null
            is JsonArray ->
                if (audience.isNotEmpty() && audience.all { it is JsonPrimitive && it.isString }) {
                    audience.map { it.jsonPrimitive.content }
                } else {
                    null
                }

            else -> null
        } ?: throw InvalidIdTokenException("audience is missing or not a string")
        if (clientId !in audiences) {
            throw InvalidIdTokenException("audience does not contain the configured client ID")
        }

        // With more than one audience the token is not addressed to us alone, and
        // only `azp` says which client it was actually issued for. OIDC core
        // §3.1.3.7 requires it in that case; without it the token could have been
        // minted for a different client that shares an audience with this one.
        val authorizedParty = claims["azp"]
        if (authorizedParty != null) {
            val azp = (authorizedParty as? JsonPrimitive)?.takeIf { it.isString }?.content
                ?: throw InvalidIdTokenException("authorized party is not a string")
            if (azp != clientId) {
                throw InvalidIdTokenException("authorized party is not the configured client ID")
            }
        } else if (audiences.size > 1) {
            throw InvalidIdTokenException("multiple audiences require an authorized party")
        }

        if (stringClaim(claims, "sub").isNullOrEmpty()) {
            throw InvalidIdTokenException("subject is missing")
        }

        val nowSeconds = now() / 1000.0

        val expiration = numberClaim(claims, "exp")
            ?: throw InvalidIdTokenException("expiration is missing or invalid")
        if (nowSeconds >= expiration) throw InvalidIdTokenException("token is expired")

        claims["nbf"]?.let {
            val notBefore = numberClaim(claims, "nbf")
                ?: throw InvalidIdTokenException("not-before claim is invalid")
            if (nowSeconds < notBefore) throw InvalidIdTokenException("token is not valid yet")
        }

        // `iat` is required rather than optional: it is what bounds how old a
        // replayed token may be, and a provider that omits it is not one whose
        // freshness claims we can check at all. A token issued in the future is
        // a clock disagreement, tolerated only up to [CLOCK_SKEW_SECONDS] —
        // beyond that it is a forgery or a badly wrong device clock, and in
        // either case the exp check above cannot be trusted either.
        val issuedAt = numberClaim(claims, "iat")
            ?: throw InvalidIdTokenException("issued-at is missing or invalid")
        if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) {
            throw InvalidIdTokenException("token was issued in the future")
        }

        if (expectedNonce != null) {
            if (stringClaim(claims, "nonce") != expectedNonce) {
                throw InvalidIdTokenException("nonce does not match authorization request")
            }
        }
    }

    /** The claim only when it is a JSON **string**; a number is not a name. */
    private fun stringClaim(claims: JsonObject, key: String): String? =
        (claims[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /**
     * The claim only when it is a finite JSON **number**.
     *
     * A quoted `"NaN"` or `"1e999"` is rejected on both counts: it is not a
     * number, and it would not be finite if it were.
     */
    private fun numberClaim(claims: JsonObject, key: String): Double? {
        val primitive = (claims[key] as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
        val value = primitive.doubleOrNull ?: return null
        return value.takeIf { it.isFinite() }
    }

    // --- transport ----------------------------------------------------------

    private suspend fun token(
        endpoint: HttpUrl,
        body: Map<String, String>,
        refreshRequest: Boolean = false,
    ): TokenSet {
        val (status, text) = post(endpoint, body)
        val data = runCatching { ApiJson.parseToJsonElement(text).jsonObject }.getOrNull()
        if (status !in 200..299) {
            val code = (data?.get("error") as? JsonPrimitive)?.contentOrNull
            if (refreshRequest && (status == 401 || code == "invalid_grant")) {
                throw OidcSessionExpiredException()
            }
            if (status >= 500) {
                throw OidcTransientException("identity provider token request failed")
            }
            val description = (data?.get("error_description") as? JsonPrimitive)?.contentOrNull ?: code
            throw ApiError(error = description ?: "Identity provider token request failed")
        }
        val accessToken = (data?.get("access_token") as? JsonPrimitive)?.contentOrNull
        if (accessToken.isNullOrEmpty()) {
            throw ApiError(error = "Identity provider returned no access token")
        }
        return TokenSet(
            accessToken = accessToken,
            refreshToken = (data["refresh_token"] as? JsonPrimitive)?.contentOrNull,
            idToken = (data["id_token"] as? JsonPrimitive)?.contentOrNull,
        )
    }

    private suspend fun post(endpoint: HttpUrl, form: Map<String, String>): Pair<Int, String> =
        withContext(Dispatchers.IO) {
            val body = FormBody.Builder().apply { form.forEach { (k, v) -> add(k, v) } }.build()
            try {
                httpClient.newCall(Request.Builder().url(endpoint).post(body).build()).execute().use {
                    it.code to it.body.string()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: IOException) {
                throw OidcTransientException(error.message ?: "identity provider request failed")
            }
        }

    private suspend fun getJson(url: HttpUrl, failureMessage: String): JsonObject =
        withContext(Dispatchers.IO) {
            val text = try {
                httpClient.newCall(Request.Builder().url(url).get().build()).execute().use { response ->
                    val payload = response.body.string()
                    if (!response.isSuccessful) throw OidcTransientException(failureMessage)
                    payload
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: IOException) {
                throw OidcTransientException(error.message ?: failureMessage)
            }
            runCatching { ApiJson.parseToJsonElement(text).jsonObject }
                .getOrElse { throw OidcTransientException(failureMessage) }
        }

    private class TokenSet(
        val accessToken: String,
        val refreshToken: String?,
        val idToken: String?,
    )

    internal class InvalidIdTokenException(message: String) : Exception(message)

    companion object {
        /**
         * How far ahead of this device's clock an `iat` may sit before the token
         * is treated as forged rather than as a clock disagreement. Two minutes
         * is generous for NTP-synced devices and far short of any useful replay
         * window.
         */
        internal const val CLOCK_SKEW_SECONDS = 120

        private fun requiredEndpoint(data: JsonObject, key: String): HttpUrl =
            optionalEndpoint(data, key) ?: throw ApiError(error = "OIDC discovery document is missing $key")

        private fun optionalEndpoint(data: JsonObject, key: String): HttpUrl? {
            val value = data[key] ?: return null
            val text = (value as? JsonPrimitive)?.contentOrNull
                ?: throw ApiError(error = "OIDC discovery document has invalid $key")
            return providerUri(text, key)
        }

        /**
         * Provider endpoints must be HTTPS. Loopback HTTP is allowed so a local
         * identity provider can be developed against; nothing else can.
         *
         * Userinfo and a fragment are refused everywhere. `https://evil@real/`
         * reads as the real host to a person and resolves to `evil` in some
         * parsers, and a fragment is never sent to a server, so an endpoint that
         * carries one is not the endpoint it appears to be. The issuer must also
         * carry no query, because it is compared byte-for-byte against the `iss`
         * claim and a query would make that comparison depend on parameter
         * ordering.
         */
        internal fun providerUri(value: String, label: String, allowQuery: Boolean = true): HttpUrl {
            val parsed = runCatching { URI(value) }.getOrNull()
            val scheme = parsed?.scheme?.lowercase()
            val host = parsed?.host?.lowercase()
            val loopback = host == "localhost" || host == "127.0.0.1" || host == "::1"
            val legal = parsed != null && !host.isNullOrEmpty() &&
                parsed.userInfo == null &&
                parsed.rawFragment == null &&
                (allowQuery || parsed.rawQuery == null) &&
                (scheme == "https" || (scheme == "http" && loopback))
            if (!legal) throw ApiError(error = "$label must use HTTPS except for loopback HTTP")
            return value.trimEnd('/').toHttpUrlOrNull()
                ?: throw ApiError(error = "$label must use HTTPS except for loopback HTTP")
        }

        internal fun base64Url(value: String): ByteArray =
            Base64.getUrlDecoder().decode(value.trimEnd('=').replace('+', '-').replace('/', '_'))
    }
}
