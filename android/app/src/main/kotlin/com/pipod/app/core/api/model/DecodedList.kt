package com.pipod.app.core.api.model

import android.util.Log
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** One list row the client could not read, kept so a screen can say so. */
data class UnparsedRow(
    val id: String?,
    val rawJson: JsonElement,
    val error: Throwable,
)

/**
 * A decoded list plus the rows that failed.
 *
 * One unreadable pod must not blank the pod list: a server that adds a field
 * shape this build does not know should cost that row, not the screen.
 */
data class DecodedList<T>(
    val items: List<T> = emptyList(),
    val unparsedRows: List<UnparsedRow> = emptyList(),
)

/**
 * Reads `json[key]` as a list, decoding each row independently.
 *
 * A missing or non-list `key` still throws — that is a response the client
 * genuinely cannot read, as opposed to one row it cannot.
 */
fun <T> decodeListRows(
    json: JsonObject,
    key: String,
    resourceName: String,
    decode: (JsonObject) -> T,
): DecodedList<T> {
    val rawRows = json[key]
    if (rawRows !is kotlinx.serialization.json.JsonArray) {
        throw IllegalArgumentException("Expected \"$key\" to be a list")
    }

    val items = mutableListOf<T>()
    val unparsedRows = mutableListOf<UnparsedRow>()
    for (rawRow in rawRows) {
        try {
            if (rawRow !is JsonObject) throw IllegalArgumentException("Expected list row to be an object")
            items += decode(rawRow)
        } catch (error: Throwable) {
            val id = (rawRow as? JsonObject)?.get("id")?.let {
                (it as? JsonPrimitive)?.contentOrNull ?: it.toString()
            }
            Log.w(LOG_TAG, decodeFailureLog(resourceName, id, error))
            unparsedRows += UnparsedRow(id = id, rawJson = rawRow, error = error)
        }
    }
    return DecodedList(items = items, unparsedRows = unparsedRows)
}

private const val LOG_TAG = "pi_pod.api.decode"

/**
 * What a failed row is allowed to say in logcat.
 *
 * Never the throwable and never its message: the kotlinx-serialization tree
 * decoder embeds the offending element in both (`JSON input: {…}`), and for a
 * pod row that element is the resolved config. Logcat is readable by
 * anyone with a cable, and this is the app's only [Log] call. The resource, the
 * row id and the exception type say which shape failed, which is all a log can
 * honestly offer.
 */
internal fun decodeFailureLog(resourceName: String, id: String?, error: Throwable): String =
    "Could not decode $resourceName row ${id ?: "<unknown>"}: " +
        (error::class.qualifiedName ?: error::class.java.name)

/** `id` of a row, when it has one — the only field the fallback UI needs. */
internal fun JsonObject.rowId(): String? = this["id"]?.jsonPrimitive?.contentOrNull
