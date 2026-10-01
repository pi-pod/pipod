package com.pipod.app.core.config

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
