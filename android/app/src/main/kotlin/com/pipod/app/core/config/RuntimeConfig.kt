package com.pipod.app.core.config

import android.content.SharedPreferences
import com.pipod.app.BuildConfig

/**
 * The server, identity provider and optional dev access token in force for this
 * process.
 *
 * Every value starts at its compiled-in default. A **debug** build additionally
 * accepts launch extras, which is how `make android` points the app at a local
 * server already signed in as the dev user, and how a manual test points it at a
 * throwaway identity provider without rebuilding the APK.
 *
 * [applyLaunchExtras] is a no-op in a release build. A shipped artifact
 * therefore has no sign-in bypass to reach and — just as important — no way to
 * be pointed at an attacker's issuer by an intent: an app that could be told
 * which identity provider to trust would accept that provider's tokens as this
 * user's.
 */
object RuntimeConfig {

    const val SERVER_URL_EXTRA: String = "PIPOD_SERVER_URL"
    const val DEV_TOKEN_EXTRA: String = "PIPOD_DEV_TOKEN"
    const val OIDC_ISSUER_EXTRA: String = "PIPOD_OIDC_ISSUER"
    const val OIDC_MOBILE_CLIENT_ID_EXTRA: String = "PIPOD_OIDC_MOBILE_CLIENT_ID"

    @Volatile
    var serverUrl: String = BuildConfig.PIPOD_SERVER_URL
        private set

    /** Empty unless a debug build was handed one. Never non-empty in release. */
    @Volatile
    var devToken: String = if (BuildConfig.DEBUG) BuildConfig.PIPOD_DEV_TOKEN else ""
        private set

    /**
     * The issuer whose discovery document and signing keys are trusted. Pinned
     * to the compiled-in value in release; see the class comment for why.
     */
    @Volatile
    var oidcIssuer: String = Config.OIDC_ISSUER
        private set

    @Volatile
    var oidcMobileClientId: String = Config.OIDC_MOBILE_CLIENT_ID
        private set

    /**
     * Applies launch overrides read from an `Intent`'s string extras.
     *
     * Returns true when anything changed, so a caller can rebuild the API client
     * and the OIDC client. Takes a plain lookup rather than an `Intent` so it
     * stays unit-testable.
     */
    /**
     * A server the user picked on the sign-in screen instead of the built-in one — their own
     * self-hosted pi pod — with the identity provider and client id it publishes. Only the
     * signed-out screen changes it, so tokens never cross from one server to another.
     */
    data class ServerChoice(val serverUrl: String, val issuer: String, val clientId: String)

    private var choicePrefs: SharedPreferences? = null

    /** Reads the persisted choice; called before any client is built. */
    fun restoreServerChoice(prefs: SharedPreferences) {
        choicePrefs = prefs
        val url = prefs.getString(KEY_SERVER, null) ?: return
        val issuer = prefs.getString(KEY_ISSUER, null) ?: return
        val clientId = prefs.getString(KEY_CLIENT, null) ?: return
        use(ServerChoice(url, issuer, clientId))
    }

    /** Persists [choice] (null: the built-in server) and points every later client at it. */
    fun chooseServer(choice: ServerChoice?) {
        choicePrefs?.edit()?.apply {
            if (choice == null) {
                remove(KEY_SERVER); remove(KEY_ISSUER); remove(KEY_CLIENT)
            } else {
                putString(KEY_SERVER, choice.serverUrl)
                putString(KEY_ISSUER, choice.issuer)
                putString(KEY_CLIENT, choice.clientId)
            }
        }?.apply()
        use(choice)
    }

    /** The server picked on the sign-in screen; null while the built-in one is in use. */
    @Volatile
    var serverChoice: ServerChoice? = null
        private set

    private fun use(choice: ServerChoice?) {
        serverChoice = choice
        serverUrl = choice?.serverUrl ?: BuildConfig.PIPOD_SERVER_URL
        oidcIssuer = choice?.issuer ?: Config.OIDC_ISSUER
        oidcMobileClientId = choice?.clientId ?: Config.OIDC_MOBILE_CLIENT_ID
    }

    private const val KEY_SERVER = "serverUrl"
    private const val KEY_ISSUER = "issuer"
    private const val KEY_CLIENT = "clientId"

    fun applyLaunchExtras(extra: (String) -> String?): Boolean {
        if (!BuildConfig.DEBUG) return false
        var changed = false
        fun override(key: String, current: String, assign: (String) -> Unit) {
            val value = extra(key)?.trim()?.takeIf { it.isNotEmpty() } ?: return
            if (value == current) return
            assign(value)
            changed = true
        }
        override(SERVER_URL_EXTRA, serverUrl) { serverUrl = it }
        override(DEV_TOKEN_EXTRA, devToken) { devToken = it }
        override(OIDC_ISSUER_EXTRA, oidcIssuer) { oidcIssuer = it }
        override(OIDC_MOBILE_CLIENT_ID_EXTRA, oidcMobileClientId) { oidcMobileClientId = it }
        return changed
    }

    /** Test seam: restores the compiled-in values. */
    fun resetForTesting() {
        serverUrl = BuildConfig.PIPOD_SERVER_URL
        devToken = if (BuildConfig.DEBUG) BuildConfig.PIPOD_DEV_TOKEN else ""
        oidcIssuer = Config.OIDC_ISSUER
        oidcMobileClientId = Config.OIDC_MOBILE_CLIENT_ID
    }
}
