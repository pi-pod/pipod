package com.pipod.app.features.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One setting a proposal would change, current beside proposed. */
data class SettingComparisonRow(
    val label: String,
    val current: JsonElement?,
    val proposed: JsonElement?,
)

/**
 * The settings a proposal changes, in a fixed reading order.
 *
 * A config bundle is an open bag this client only partly understands, so a
 * proposal is summarised through the keys that have a name worth reading and
 * everything else is left to the raw disclosure. A key absent from **both**
 * sides is not a change and gets no row.
 */
fun knownSettingRows(current: JsonObject, proposed: JsonObject): List<SettingComparisonRow> =
    SETTING_LABELS.mapNotNull { (path, label) ->
        val currentValue = valueAt(current, path)
        val proposedValue = valueAt(proposed, path)
        if (currentValue == null && proposedValue == null) {
            null
        } else {
            SettingComparisonRow(label = label, current = currentValue, proposed = proposedValue)
        }
    }

/**
 * The value at a dotted [path], or null when any step is missing or is not an
 * object. A JSON null reads as absent: the server writes one for "no value",
 * and a row saying "null" would be reporting a value nobody set.
 */
fun valueAt(value: JsonObject, path: String): JsonElement? {
    var cursor: JsonElement? = value
    for (part in path.split(".")) {
        val obj = cursor as? JsonObject ?: return null
        cursor = obj[part]
    }
    return cursor?.takeIf { it != JsonNull }
}

/** One setting's value, phrased rather than printed. */
fun displaySetting(value: JsonElement?): String = when {
    value == null || value == JsonNull -> "Not set"
    // A list is read as its members, so each one stays what it is rather than
    // being re-phrased: "On, Off" says nothing about a list of hosts.
    value is JsonArray -> if (value.isEmpty()) "None" else value.joinToString(", ") { literal(it) }
    value is JsonPrimitive && !value.isString && value.content == "true" -> "On"
    value is JsonPrimitive && !value.isString && value.content == "false" -> "Off"
    else -> literal(value)
}

/** A script's contents, or the fact that there is none. */
fun scriptLabel(script: String?): String = if (script.isNullOrEmpty()) "(none)" else script

/**
 * The bundle as text a reader can diff by eye.
 *
 * Keys are sorted recursively so the same settings always print in the same
 * order — otherwise two bundles that differ only in key order look like a
 * change to every line.
 */
fun prettyJson(value: JsonObject): String = try {
    PRETTY.encodeToString(JsonElement.serializer(), sortKeys(value))
} catch (_: Throwable) {
    "{}"
}

private fun sortKeys(value: JsonElement): JsonElement = when (value) {
    is JsonObject -> JsonObject(value.entries.sortedBy { it.key }.associate { it.key to sortKeys(it.value) })
    is JsonArray -> JsonArray(value.map { sortKeys(it) })
    else -> value
}

/** A single value as the reader should see it, without JSON's quoting. */
private fun literal(value: JsonElement): String =
    (value as? JsonPrimitive)?.content ?: value.toString()

/**
 * The keys worth naming, and the order they read in. Kept as a list rather than
 * a map so the order is the file's, not a hash's.
 */
private val SETTING_LABELS: List<Pair<String, String>> = listOf(
    "provider" to "Sandbox provider",
    "image" to "Image",
    "idleTimeoutMinutes" to "Idle timeout (minutes)",
    "archiveAfterMinutes" to "Archive after (minutes)",
    "autoStopOnExit" to "Stop when pi exits",
    "reuse" to "Reuse stopped pod",
    "workdir" to "Working directory",
    "resources.cpu" to "CPU",
    "resources.memoryGB" to "Memory (GB)",
    "resources.diskGB" to "Disk (GB)",
    "egress.mode" to "Network access",
    "egress.builtins" to "Built-in service access",
    "egress.allow" to "Allowed hosts",
    "pi.model" to "Default model",
    "pi.thinking" to "Thinking level",
    "pi.sessionNaming" to "Session naming",
)

private val PRETTY = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
}
