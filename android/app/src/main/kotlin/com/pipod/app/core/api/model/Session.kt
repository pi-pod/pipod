package com.pipod.app.core.api.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

@Serializable
data class WsTicket(val ticket: String, val expiresAt: String)

@Serializable
data class QueuedPromptReceipt(val id: String, val status: String, val createdAt: String)

@Serializable
data class AgentSession(
    val id: String,
    @SerialName("user_id") val userId: String,
    @SerialName("started_at") val startedAt: String,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("end_reason") val endReason: String? = null,
)

@Serializable
data class SessionEventRecord(
    val seq: Long,
    val kind: String,
    val payload: JsonElement = JsonNull,
    val createdAt: String,
)

@Serializable
data class SessionEventsPage(val events: List<SessionEventRecord> = emptyList())

@Serializable
data class ConversationEventRecord(
    val sessionId: String,
    val seq: Long,
    val kind: String,
    val payload: JsonElement = JsonNull,
    val createdAt: String,
)

@Serializable
data class ConversationEventsPage(
    val events: List<ConversationEventRecord> = emptyList(),
    val nextBefore: String? = null,
)

