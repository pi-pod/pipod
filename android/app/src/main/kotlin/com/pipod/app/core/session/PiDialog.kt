package com.pipod.app.core.session

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * A question pi is waiting on. An extension called `ctx.ui.confirm`, `select`,
 * `input` or `editor`, and pi's turn does not move until some client answers.
 * The gateway sends it to every attached client and again on every attach
 * until one of them answers, so the conversation shows it the way pi's own
 * terminal would.
 */
class PiDialog private constructor(
    /** pi's request id. The answer must carry it. */
    val id: String,
    val title: String,
    val message: String,
    /** Pretty-printed JSON: the complete request, for someone who wants to see exactly what they answer. */
    val details: String,
    val style: Style,
    val placeholder: String?,
    val prefill: String,
) {
    /** How a person answers. The keys are pi's extension-UI response keys. */
    sealed interface Style {
        data object Confirm : Style
        data class Input(val multiline: Boolean) : Style
        data class Select(val options: List<String>) : Style
        /** Nothing safe to render: the card offers details and a cancel, nothing else. */
        data object Unsupported : Style
    }

    /**
     * The `extension_ui_response` frame pi releases the turn on. Without the
     * frame type and the request id pi does not recognise the answer.
     */
    private fun answer(fields: Map<String, JsonElement>): JsonObject = buildJsonObject {
        fields.forEach { (key, value) -> put(key, value) }
        put("type", "extension_ui_response")
        put("id", id)
    }

    fun confirmed(value: Boolean): JsonObject = answer(mapOf("confirmed" to JsonPrimitive(value)))
    fun value(value: String): JsonObject = answer(mapOf("value" to JsonPrimitive(value)))
    val cancelled: JsonObject get() = answer(mapOf("cancelled" to JsonPrimitive(true)))

    /**
     * The transcript line an answer leaves behind. Secret-looking input is never
     * echoed, and long values are cut to one line.
     */
    fun receipt(response: JsonObject): String {
        val title = title.trim()
        // Quoted, because the title is usually the question itself ("Run this command?").
        fun withTitle(action: String) = if (title.isEmpty()) "$action." else "$action “$title”"
        if ((response["cancelled"] as? JsonPrimitive)?.content == "true") return withTitle("You cancelled")
        (response["confirmed"] as? JsonPrimitive)?.let {
            return withTitle(if (it.content == "true") "You confirmed" else "You declined")
        }
        val raw = response.string("value")?.trim().orEmpty()
        if (raw.isEmpty()) return withTitle("You answered")
        val value = raw.split(Regex("\\s+")).joinToString(" ")
        val shown = if (value.length > 80) value.take(80).trimEnd() + "…" else value
        if (style is Style.Select) {
            return if (title.isEmpty()) "You chose $shown." else "You chose $shown for “$title”"
        }
        if (SessionStream.redactingSecrets(raw) != raw) return withTitle("You answered")
        return "You answered $shown."
    }

    companion object {
        private val DIALOG_METHODS = setOf("confirm", "select", "input", "editor")
        private const val NO_SAFE_SUMMARY_PREFIX = "The request has no safe summary"

        /** Null for anything that is not a dialog pi can be answered on. */
        fun from(payload: JsonObject): PiDialog? {
            val id = payload.string("id")?.takeIf { it.isNotEmpty() } ?: return null
            val method = payload.string("method")?.takeIf { it in DIALOG_METHODS } ?: return null
            val options = (payload["options"] as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.content }
                .orEmpty()
            val suppliedTitle = firstString(payload, listOf("title", "prompt", "question"))
            val message = message(payload, method, options)
            // A confirmation the app could not describe must not offer a confirm
            // button: no one can consent to an unnamed action.
            val describable = suppliedTitle != null || !message.startsWith(NO_SAFE_SUMMARY_PREFIX)
            val style = when (method) {
                "confirm" -> if (describable) Style.Confirm else Style.Unsupported
                "select" -> if (options.isEmpty()) Style.Unsupported else Style.Select(options)
                "input" -> Style.Input(multiline = false)
                else -> Style.Input(multiline = true)
            }
            return PiDialog(
                id = id,
                title = suppliedTitle ?: fallbackTitle(method),
                message = message,
                details = prettyJson(payload),
                style = style,
                placeholder = payload.string("placeholder"),
                prefill = payload.string("prefill") ?: "",
            )
        }

        private fun firstString(payload: JsonObject, keys: List<String>): String? =
            keys.firstNotNullOfOrNull { key -> payload.string(key)?.takeIf { it.isNotBlank() } }

        private fun message(payload: JsonObject, method: String, options: List<String>): String {
            firstString(payload, listOf("message", "description", "text", "command", "target", "path"))
                ?.let { return it }
            if (method == "select" && options.isNotEmpty()) return "Choose one of the options."
            if (method == "input" || method == "editor") {
                val hint = payload.string("placeholder")
                return if (hint != null) "Enter a response. Hint: $hint" else "pi is asking for a response."
            }
            return "$NO_SAFE_SUMMARY_PREFIX. Review its complete details before deciding."
        }

        private fun fallbackTitle(method: String): String = when (method) {
            "confirm" -> "pi needs a confirmation"
            "select" -> "Choose an option"
            else -> "pi needs a response"
        }

        /** Keys are sorted so the same request always reads the same way. */
        private fun prettyJson(payload: JsonObject): String =
            runCatching { PRETTY.encodeToString(JsonElement.serializer(), sortedJson(payload)) }
                .getOrElse { payload.toString() }

        private fun sortedJson(value: JsonElement): JsonElement = when (value) {
            is JsonObject -> buildJsonObject {
                value.keys.sorted().forEach { key -> put(key, sortedJson(value.getValue(key))) }
            }
            is JsonArray -> buildJsonArray { value.forEach { add(sortedJson(it)) } }
            else -> value
        }

        private val PRETTY = Json {
            prettyPrint = true
            prettyPrintIndent = "  "
        }
    }
}

/** The value at [key] when it is a JSON string, otherwise null. */
internal fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
