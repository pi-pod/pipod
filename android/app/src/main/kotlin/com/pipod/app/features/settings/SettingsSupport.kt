package com.pipod.app.features.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.credentials.LoginSocket

/**
 * Opens a URL outside the app.
 *
 * A seam rather than a direct `startActivity`, because both call sites — the
 * identity provider's admin console and a provider's sign-in page — have to
 * report *failure to open* to the reader, and a test has to be able to answer
 * "the browser refused" without a device.
 */
fun interface UrlOpener {
    /** True when something took the URL; false when nothing on the device would. */
    suspend fun open(url: String): Boolean
}

/**
 * The real opener: an `ACTION_VIEW` in whichever browser the device prefers.
 *
 * Deliberately not a Custom Tab. A provider sign-in and the admin console are
 * the identity provider's own pages, and they are worth handing to the browser
 * the person already has a session in.
 */
fun androidUrlOpener(context: Context): UrlOpener {
    val appContext = context.applicationContext
    return UrlOpener { url ->
        runCatching {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            appContext.startActivity(intent)
            true
        }.getOrDefault(false)
    }
}

/** Nothing to open a URL with — the default in a test and in a preview. */
val NoUrlOpener = UrlOpener { false }

/**
 * Builds the WebSocket one provider login runs over.
 *
 * The login view takes the factory rather than an [ApiClient] so a test can
 * drive the frozen prompt/event protocol without a server.
 */
fun interface LoginSocketFactory {
    fun create(providerId: String, authType: String, podId: String?): LoginSocket
}

/** Most logins are account-wide; only a pod-scoped one names a pod. */
fun LoginSocketFactory.create(providerId: String, authType: String): LoginSocket =
    create(providerId = providerId, authType = authType, podId = null)

/** The production factory: one socket per login, ticketed by the REST client. */
fun apiLoginSocketFactory(api: ApiClient) = LoginSocketFactory { providerId, authType, podId ->
    LoginSocket(api = api, providerId = providerId, authType = authType, podId = podId)
}
