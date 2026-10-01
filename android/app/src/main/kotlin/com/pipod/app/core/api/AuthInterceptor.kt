package com.pipod.app.core.api

import com.pipod.app.core.api.model.ApiError
import com.pipod.app.core.api.model.RefreshResponse
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Response

/** Exchanges a refresh token for a fresh token set. */
fun interface TokenRefresher {
    suspend fun refresh(refreshToken: String): RefreshResponse
}

/**
 * Adds API authorization and transparently refreshes an expired access token.
 *
 * Organization selection is carried only by the token; no tenant-selection
 * header is accepted or sent.
 *
 * Port of `pi-pod-flutter/lib/core/api/auth_interceptor.dart`. Refresh is
 * single-flight: a burst of screens hitting 401 at once must not spend the
 * one-time-use refresh token several times over, which the provider answers by
 * invalidating the whole chain.
 */
class AuthInterceptor(
    private val accessToken: () -> String?,
    private val refreshToken: () -> String?,
    /**
     * Suspending, and awaited before the retry goes out. Persisting the rotated
     * pair fire-and-forget raced session restoration: the retry succeeded, the
     * write had not landed, and a restore that read the keystore in between
     * spent the token the provider had already retired — which it answers by
     * invalidating the chain, signing the person out of a working session.
     */
    private val updateTokens: suspend (accessToken: String, refreshToken: String, idToken: String?) -> Unit,
    private val refresh: TokenRefresher,
) : Interceptor {

    private val lock = Any()
    private var inFlight: CompletableDeferred<Unit>? = null

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.header(UNAUTHORIZED_HEADER) != null) {
            return chain.proceed(request.newBuilder().removeHeader(UNAUTHORIZED_HEADER).build())
        }

        val token = accessToken()
        if (token.isNullOrEmpty()) throw ApiIoException(ApiError(error = "not signed in"))

        val response = chain.proceed(request.newBuilder().header("Authorization", "Bearer $token").build())
        if (response.code != 401) return response

        val stored = refreshToken()
        if (stored.isNullOrEmpty()) return response

        // Refresh runs off the interceptor's own thread pool; blocking here is
        // what OkHttp's interceptor contract expects, and the call itself was
        // already dispatched from a coroutine on Dispatchers.IO.
        try {
            runBlocking { refreshSingleFlight() }
        } catch (error: Throwable) {
            response.close()
            throw when (error) {
                is IOException -> error
                else -> ApiIoException(error)
            }
        }

        val retryToken = accessToken()
        if (retryToken.isNullOrEmpty()) return response
        response.close()
        return chain.proceed(request.newBuilder().header("Authorization", "Bearer $retryToken").build())
    }

    private suspend fun refreshSingleFlight() {
        val existing: CompletableDeferred<Unit>?
        val mine: CompletableDeferred<Unit>?
        synchronized(lock) {
            if (inFlight != null) {
                existing = inFlight
                mine = null
            } else {
                existing = null
                mine = CompletableDeferred<Unit>().also { inFlight = it }
            }
        }
        if (existing != null) return existing.await()

        val gate = requireNotNull(mine)
        try {
            performRefresh()
            gate.complete(Unit)
        } catch (error: Throwable) {
            gate.completeExceptionally(error)
            throw error
        } finally {
            synchronized(lock) { if (inFlight === gate) inFlight = null }
        }
    }

    private suspend fun performRefresh() {
        val token = refreshToken()
        if (token.isNullOrEmpty()) throw ApiError(error = "not signed in")
        val tokens = refresh.refresh(token)
        updateTokens(tokens.accessToken, tokens.refreshToken, tokens.idToken)
    }

    companion object {
        /**
         * Marks the few requests that must go out without a bearer token. It is
         * a request header rather than an OkHttp tag so a caller can set it with
         * nothing but a `Request.Builder`; the interceptor strips it before the
         * request leaves the process.
         */
        const val UNAUTHORIZED_HEADER = "X-PiPod-Unauthorized"
    }
}

/**
 * Carries a non-IO failure out through OkHttp, which only lets an interceptor
 * throw [IOException]. [ApiClient] unwraps it back to the original error.
 */
class ApiIoException(val original: Throwable) : IOException(original.message, original)
