package com.pipod.app.core.api.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Identity returned by `/v1/me`. */
@Serializable
data class AuthUser(
    val id: String,
    val email: String? = null,
    val displayName: String? = null,
)

/** Tokens returned by an authorization-code exchange. */
@Serializable
data class AuthResponse(
    val accessToken: String,
    val refreshToken: String? = null,
    val idToken: String? = null,
)

@Serializable
data class RefreshResponse(
    val accessToken: String,
    val refreshToken: String,
    val idToken: String? = null,
)

@Serializable
data class Organization(
    val id: String,
    val alias: String? = null,
    val name: String? = null,
)

/** Current identity and the one organization selected by the access token. */
@Serializable
data class MeResponse(
    val user: AuthUser,
    val currentOrgId: String? = null,
    val permissions: List<String> = emptyList(),
    val organization: Organization? = null,
    val accountConsoleUrl: String? = null,
    val adminConsoleUrl: String? = null,
    /**
     * The SaaS account summary. Held raw because every field inside is
     * independently optional and has to be validated rather than decoded — a
     * negative or non-finite number is dropped, not rendered. The self-hosted
     * static backend omits the key entirely.
     *
     * Wire key `workstation` from `workstationSummary()`
     * (hosted edition billing routes); absent under static.
     */
    val workstation: JsonObject? = null,
) {
    /** The validated summary, or null when nothing renderable arrived. */
    val billingSummary: BillingSummary? get() = BillingSummary.fromObject(workstation)
}
