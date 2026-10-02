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
data class SettingsLayer(
    val config: JsonObject = JsonObject(emptyMap()),
    val version: Int,
    val initScript: String = "",
    val bakeScript: String = "",
)
