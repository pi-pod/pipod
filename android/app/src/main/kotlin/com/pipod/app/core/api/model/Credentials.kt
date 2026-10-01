package com.pipod.app.core.api.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Metadata for one account-scoped model-provider credential. */
@Serializable
data class CredentialStatus(
    val providerId: String,
    val type: String,
    val state: String,
    val revision: Int,
    val expiresAt: String? = null,
    val lastRefreshAt: String? = null,
    val reason: String? = null,
    val retryAfter: String? = null,
)

/** The provider's OAuth capability, when it has one. */
@Serializable
data class ProviderOauth(val loginLabel: String? = null)

/** A provider for which the control plane can establish account credentials. */
@Serializable
data class ConnectableProvider(
    val id: String,
    val name: String,
    val apiKey: Boolean,
    val brokerSupported: Boolean,
    @SerialName("oauth") val oauth: ProviderOauth? = null,
) {
    val oauthLoginLabel: String? get() = oauth?.loginLabel
    val hasOauth: Boolean get() = oauthLoginLabel != null
}

/** Credential health plus the server's provider capability list. */
@Serializable
data class ModelCredentialsResponse(
    val credentials: List<CredentialStatus> = emptyList(),
    val providers: List<ConnectableProvider> = emptyList(),
)

/** One-shot WebSocket login ticket minted with the user's normal JWT. */
@Serializable
data class LoginTicket(val ticket: String, val expiresAt: String)

/** `POST /v1/model-credentials/:id/test` wraps the fresh status in one key. */
@Serializable
data class CredentialTestResponse(val status: CredentialStatus)
