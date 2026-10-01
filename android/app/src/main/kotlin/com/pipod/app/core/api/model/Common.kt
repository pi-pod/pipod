package com.pipod.app.core.api.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * A failure the server described in its response body.
 *
 * Mirrors `pi-pod-flutter/lib/core/api/models/common.dart`. It is an exception
 * because every call site either shows it or rethrows it, and a sealed result
 * type would make every one-line repository method a `when`.
 */
class ApiError(
    val error: String,
    val detail: JsonElement? = null,
    /**
     * The status the transport really received. Set **only** by [ApiClient]
     * from the response it got — never parsed out of server JSON, so an
     * untrusted body cannot forge it ([fromJson] strips the key).
     */
    val httpStatus: Int? = null,
) : Exception(error) {

    val transportStatus: Int? get() = httpStatus

    /** [detail] when it is a bare string, otherwise null. */
    val detailText: String? get() = (detail as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun detailString(key: String): String? {
        val obj = detail as? JsonObject ?: return null
        return (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }

    val detailCode: String? get() = detailString("code")

    val errorDescription: String get() = detailText?.let { "$error — $it" } ?: error

    fun copyWith(httpStatus: Int?): ApiError = ApiError(error, detail, httpStatus ?: this.httpStatus)

    override fun toString(): String = errorDescription

    companion object {
        /**
         * Keys the server puts beside `error` (`reason`, `provider`, `code`) are
         * folded into `detail`, so a caller only has to look in one place for
         * the typed fields the friendly-error mapping reads.
         */
        fun fromJson(json: JsonObject): ApiError {
            val siblings = json.filterKeys { it != "error" && it != "detail" && it != "httpStatus" }
            val rawDetail = json["detail"]
            val detail: JsonElement? = when {
                rawDetail is JsonObject -> buildJsonObject {
                    rawDetail.forEach { (key, value) -> put(key, value) }
                    siblings.forEach { (key, value) -> if (rawDetail[key] == null) put(key, value) }
                }

                siblings.isNotEmpty() -> buildJsonObject {
                    val message = (rawDetail as? JsonPrimitive)?.takeIf { it.isString }
                    if (message != null) put("message", message)
                    siblings.forEach { (key, value) -> put(key, value) }
                }

                else -> rawDetail
            }
            val message = json["error"]?.jsonPrimitive?.contentOrNull
                ?: throw IllegalArgumentException("error body has no \"error\" field")
            return ApiError(error = message, detail = detail)
        }
    }
}

/** A value the server refused to use as asked and replaced with a policy-legal one. */
@Serializable
data class PolicyClamp(
    val path: String,
    val from: JsonElement? = null,
    val to: JsonElement? = null,
    val reason: String,
)
