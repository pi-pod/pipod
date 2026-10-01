package com.pipod.app.core.api.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class SecretMeta(
    val name: String,
    val scopeType: String,
    val scopeId: String,
    val keyId: String,
    val updatedAt: String,
) {
    val id: String get() = "$scopeType/$scopeId/$name"
}

@Serializable
data class EnvironmentEditorData(
    val bakeScript: String? = null,
    val config: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class SettingsProposal(
    val id: String,
    val scope: String,
    val scopeId: String,
    val config: JsonObject? = null,
    val initScript: String? = null,
    val bakeScript: String? = null,
    val secretNames: List<String> = emptyList(),
    val note: String? = null,
    val status: String,
    val createdFromPod: String,
    val createdAt: String,
) {
    val scopeLabel: String
        get() = if (scope == "org_defaults") "organization defaults" else "unsupported scope ($scope)"
}

@Serializable
data class SettingsLayer(
    val config: JsonObject = JsonObject(emptyMap()),
    val version: Int,
    val initScript: String = "",
    val bakeScript: String = "",
)
