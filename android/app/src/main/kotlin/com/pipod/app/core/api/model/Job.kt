package com.pipod.app.core.api.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

/** When a job runs. */
@Serializable(with = JobTriggerSerializer::class)
sealed interface JobTrigger {
    data class Cron(val expression: String) : JobTrigger
    data class At(val times: List<String>) : JobTrigger
}

/**
 * Decoding throws on an unrecognized trigger type.
 *
 * A schedule the client cannot render must not be shown as if it were
 * understood — misreporting when a job runs is worse than refusing to display
 * it, and [decodeListRows] turns the throw into one skipped row rather than a
 * failed screen.
 */
object JobTriggerSerializer : KSerializer<JobTrigger> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("JobTrigger")

    override fun deserialize(decoder: Decoder): JobTrigger {
        val input = decoder as? JsonDecoder ?: error("JobTrigger can only be read from JSON")
        val json = input.decodeJsonElement().jsonObject
        return when (val type = json["type"]?.jsonPrimitive?.contentOrNull) {
            "cron" -> JobTrigger.Cron(
                json["cron"]?.jsonPrimitive?.contentOrNull
                    ?: throw IllegalArgumentException("cron trigger has no \"cron\" field"),
            )

            "at" -> JobTrigger.At(
                json["times"]?.jsonArray?.map { it.jsonPrimitive.content }
                    ?: throw IllegalArgumentException("at trigger has no \"times\" field"),
            )

            else -> throw IllegalArgumentException("unknown trigger type \"$type\"")
        }
    }

    override fun serialize(encoder: Encoder, value: JobTrigger) {
        val output = encoder as? JsonEncoder ?: error("JobTrigger can only be written as JSON")
        output.encodeJsonElement(toJson(value))
    }

    fun toJson(value: JobTrigger): JsonObject = when (value) {
        is JobTrigger.Cron -> buildJsonObject {
            put("type", "cron")
            put("cron", value.expression)
        }

        is JobTrigger.At -> buildJsonObject {
            put("type", "at")
            putJsonArray("times") { value.times.forEach { add(JsonPrimitive(it)) } }
        }
    }
}

@Serializable
data class Job(
    val id: String,
    val name: String,
    val description: String? = null,
    val status: String,
    val trigger: JobTrigger,
    val templateId: String? = null,
    val model: String,
    val prompt: String,
    val createdFromPod: String? = null,
    val nextRunAt: String? = null,
    val lastRunAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
    /**
     * `"user"` or `"org"`, from `jobs.scope`.
     *
     * `GET /v1/jobs` returns every org-scoped job in the organization
     * alongside the caller's own (`AND (scope = 'org' OR user_id = $2)`), so
     * without this a colleague's shared schedule is indistinguishable from your
     * own — including in the confirmation for deleting it. Defaulted, because
     * an older server omits the key and personal is the safe reading.
     */
    val scope: String = "user",
) {
    /** Shared with the whole organization: everyone sees it, anyone can act on it. */
    val isOrgScoped: Boolean get() = scope == "org"

    val isActive: Boolean get() = status == "active"
    val isPaused: Boolean get() = status == "paused"
    val isCompleted: Boolean get() = status == "completed"
}

@Serializable
data class JobRun(
    val id: String,
    val podId: String? = null,
    val scheduledAt: String,
    val status: String,
    val error: String? = null,
    val startedAt: String,
    val finishedAt: String? = null,
) {
    val isRunning: Boolean get() = status == "running"
    val didFail: Boolean get() = status == "failed"
}
