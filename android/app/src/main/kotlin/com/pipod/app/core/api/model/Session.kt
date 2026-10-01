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

@Serializable
data class PendingInteraction(
    val id: String,
    @SerialName("session_id") val sessionId: String,
    @SerialName("pod_id") val podId: String,
    @SerialName("pod_name") val podName: String,
    val seq: Long,
    val kind: String,
    val payload: JsonElement = JsonNull,
    @SerialName("created_at") val createdAt: String,
    @SerialName("resolved_at") val resolvedAt: String? = null,
    @SerialName("delivered_at") val deliveredAt: String? = null,
)

@Serializable
data class ResolveOutcome(
    val resolved: Boolean,
    val delivery: String? = null,
    val alreadyResolved: Boolean? = null,
) {
    /**
     * The server accepted the answer but has not handed it to the pod. The row
     * stays on screen as "sent" rather than disappearing, so nobody assumes the
     * agent already acted on it.
     */
    val isDeliveryPending: Boolean get() = delivery == "pending"
}
