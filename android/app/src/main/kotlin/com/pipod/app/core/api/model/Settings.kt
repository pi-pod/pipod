package com.pipod.app.core.api.model

import kotlinx.serialization.Serializable

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
