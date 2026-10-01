package com.pipod.app.core.config

import com.pipod.app.BuildConfig

/**
 * Build-time application configuration.
 *
 * Values come from `BuildConfig`, which `app/build.gradle.kts` fills from
 * `-P` properties or environment variables — the native equivalent of Flutter's
 * `--dart-define`. Defaults match `pi-pod-flutter/lib/core/config.dart`.
 */
object Config {

    /** Exact Zitadel instance issuer. Discovery metadata is rejected unless its
     * `issuer` is exactly this value. */
    const val OIDC_ISSUER: String = BuildConfig.PIPOD_OIDC_ISSUER

    /** Mobile clients use their own separately registered public client. */
    const val OIDC_MOBILE_CLIENT_ID: String = BuildConfig.PIPOD_OIDC_MOBILE_CLIENT_ID

    /** Exact mobile redirect registered on the mobile OIDC client. */
    const val MOBILE_CALLBACK_URL: String = BuildConfig.PIPOD_OIDC_MOBILE_REDIRECT_URI

    const val CALLBACK_SCHEME: String = "pipod"
    const val CALLBACK_PATH: String = "/auth/callback"

    val OIDC_SCOPES: List<String> = listOf(
        "openid",
        "profile",
        "email",
        "offline_access",
        "urn:zitadel:iam:user:resourceowner",
        "urn:zitadel:iam:org:projects:roles",
    )

    private val organizationAlias = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

    /**
     * The scopes to ask for, optionally pinned to one organization.
     *
     * A malformed alias throws rather than being dropped: silently requesting
     * the wrong tenant's scopes would sign the user into the wrong organization.
     */
    fun requestedOidcScopes(
        organizationAlias: String?,
        includeOfflineAccess: Boolean = true,
    ): List<String> {
        if (!organizationAlias.isNullOrEmpty() &&
            !Config.organizationAlias.matches(organizationAlias)
        ) {
            throw IllegalArgumentException(
                "organizationAlias must be a single organization alias containing only " +
                    "letters, digits, dot, underscore, or hyphen: $organizationAlias",
            )
        }
        return buildList {
            for (scope in OIDC_SCOPES) {
                if (includeOfflineAccess || scope != "offline_access") add(scope)
            }
            if (!organizationAlias.isNullOrEmpty()) {
                add("urn:zitadel:iam:org:domain:primary:$organizationAlias")
            }
        }
    }
}
