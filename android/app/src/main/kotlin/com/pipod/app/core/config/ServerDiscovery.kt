package com.pipod.app.core.config

import com.pipod.app.BuildConfig
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Finds how to sign in to a pi pod server from its address alone. Every server publishes its
 * identity provider, and the client id the phone apps use there, at `GET /v1/auth/config`.
 */
object ServerDiscovery {
    class Failure(message: String) : Exception(message)

    private const val PRODUCTION_SERVER_URL = "https://api.pipod.dev"

    /** The choice to remember for [address], or null when it is the built-in server. */
    suspend fun resolve(address: String, http: OkHttpClient): RuntimeConfig.ServerChoice? {
        val url = serverUrl(address)
        if (url == BuildConfig.PIPOD_SERVER_URL.trimEnd('/')) return null
        val name = displayName(url)
        val body = withContext(Dispatchers.IO) {
            try {
                http.newCall(Request.Builder().url("$url/v1/auth/config").build()).execute()
                    .use { if (it.code == 200) it.body?.string() else null }
            } catch (_: IOException) {
                throw Failure("Couldn’t reach $name. Check the address and your connection.")
            }
        }
        val json = body?.let { runCatching { Json.parseToJsonElement(it).jsonObject }.getOrNull() }
        val issuer = json?.get("issuer")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }
            ?: throw Failure(
                "$name didn’t answer like a pi pod server. Check the address — it is the one " +
                    "you pass to pipod login --server.",
            )
        // A server that runs its own identity provider must name the app's client there; only
        // the built-in provider's client id is known in advance.
        val clientId = json["mobileClientId"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }
            ?: Config.OIDC_MOBILE_CLIENT_ID.takeIf { issuer == Config.OIDC_ISSUER }
            ?: throw Failure(
                "$name doesn’t offer sign-in to the phone apps yet. Its operator can turn it on " +
                    "by running selfhost/upgrade.",
            )
        return RuntimeConfig.ServerChoice(serverUrl = url, issuer = issuer, clientId = clientId)
    }

    /**
     * `pipod.example.com` → `https://pipod.example.com`. Plain HTTP is accepted only for this
     * device's own loopback, where a development server runs: anywhere else it would send
     * sign-in tokens in the clear.
     */
    fun serverUrl(address: String): String {
        var text = address.trim().trimEnd('/')
        if (text.isEmpty()) throw Failure("Enter your server’s address, like pipod.example.com.")
        if (!text.contains("://")) text = "https://$text"
        val url = text.toHttpUrlOrNull()
        if (url == null || url.username.isNotEmpty() || url.query != null || url.fragment != null) {
            throw Failure("“$address” isn’t a server address. Enter one like pipod.example.com.")
        }
        if (url.scheme == "http" && url.host !in setOf("127.0.0.1", "localhost", "::1")) {
            throw Failure("The app signs in only over HTTPS. Use the server’s https:// address.")
        }
        return text
    }

    /**
     * The address to show in the field for a chosen server: what [serverUrl] turns back into
     * the same URL, so the scheme stays only where it is not the default HTTPS.
     */
    fun address(url: String): String = url.removePrefix("https://")

    /** How the sign-in screen names a server: "pi pod cloud" for the hosted one, else its host. */
    fun displayName(url: String): String {
        if (url.trimEnd('/') == PRODUCTION_SERVER_URL) return "pi pod cloud"
        val parsed = url.toHttpUrlOrNull() ?: return url
        val defaultPort = if (parsed.scheme == "https") 443 else 80
        return if (parsed.port == defaultPort) parsed.host else "${parsed.host}:${parsed.port}"
    }
}
