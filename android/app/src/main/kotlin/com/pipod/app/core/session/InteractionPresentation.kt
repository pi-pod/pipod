package com.pipod.app.core.session

import com.pipod.app.core.api.model.PendingInteraction
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/**
 * Turns protocol-shaped interaction payloads into language and controls a
 * person can safely review. Extension UI responses must match pi's documented
 * response keys.
 *
 * Port of `pi-pod-flutter/lib/core/format/interaction_presentation.dart`. It
 * lives beside the reducer rather than under `core/format` because the
 * transcript receipt wording is derived from it and nothing else needs it yet.
 */
sealed interface InteractionResponseStyle {
    /** Yes/no, answered under [key] — `confirmed` for extension UI, `approved` for tool approvals. */
    data class Confirmation(val key: String) : InteractionResponseStyle

    data class Input(val multiline: Boolean) : InteractionResponseStyle

    data class Selection(val options: List<String>) : InteractionResponseStyle

    /** Nothing safe to render: the card offers details and a cancel, nothing else. */
    data object Unsupported : InteractionResponseStyle
}

class InteractionPresentation private constructor(
    val title: String,
    val message: String,
    val details: String,
    val responseStyle: InteractionResponseStyle,
    val placeholder: String?,
    val prefill: String,
) {

    companion object {
        operator fun invoke(interaction: PendingInteraction): InteractionPresentation {
            val payload = interaction.payload as? JsonObject ?: JsonObject(emptyMap())
            val method = payload.string("method")
            val options = stringOptions(payload["options"])

            val suppliedTitle = firstString(payload, listOf("title", "prompt", "question"))
            val title = suppliedTitle ?: friendlyKind(method ?: interaction.kind)
            val message = meaningfulMessage(payload, method, options)
            val hasSafeSummary = suppliedTitle != null || !message.startsWith(NO_SAFE_SUMMARY_PREFIX)

            val responseStyle = when (method ?: interaction.kind) {
                "confirm" ->
                    if (hasSafeSummary) {
                        InteractionResponseStyle.Confirmation("confirmed")
                    } else {
                        InteractionResponseStyle.Unsupported
                    }

                "select" ->
                    if (options.isEmpty()) {
                        InteractionResponseStyle.Unsupported
                    } else {
                        InteractionResponseStyle.Selection(options)
                    }

                "input" -> InteractionResponseStyle.Input(multiline = false)
                "editor" -> InteractionResponseStyle.Input(multiline = true)

                // Compatibility for non-extension approval events.
                "tool_approval", "approval", "permission" ->
                    if (hasSafeSummary) {
                        InteractionResponseStyle.Confirmation("approved")
                    } else {
                        InteractionResponseStyle.Unsupported
                    }

                else -> InteractionResponseStyle.Unsupported
            }

            return InteractionPresentation(
                title = title,
                message = message,
                details = prettyJson(payload),
                responseStyle = responseStyle,
                placeholder = payload.string("placeholder"),
                prefill = payload.string("prefill") ?: "",
            )
        }

        private const val NO_SAFE_SUMMARY_PREFIX = "The request has no safe summary"

        private fun firstString(payload: JsonObject, keys: List<String>): String? {
            for (key in keys) {
                val value = payload.string(key)
                if (value != null && value.trim().isNotEmpty()) return value
            }
            return null
        }

        private fun meaningfulMessage(
            payload: JsonObject,
            method: String?,
            options: List<String>,
        ): String {
            firstString(payload, listOf("message", "description", "text", "command", "target", "path"))
                ?.let { return it }

            val toolName = payload.string("toolName")
            val args = payload["args"] as? JsonObject
            if (toolName != null && args != null) {
                firstString(args, listOf("command", "path", "target"))?.let { return "$toolName: $it" }
            }

            if (method == "select" && options.isNotEmpty()) return "Choose one of the available options."
            if (method == "input" || method == "editor") {
                val hint = payload.string("placeholder")
                return if (hint != null) "Enter a response. Hint: $hint" else "Enter the response requested by pi."
            }
            return "$NO_SAFE_SUMMARY_PREFIX. Review its complete details before deciding."
        }

        private fun friendlyKind(kind: String): String = when (kind) {
            "tool_approval" -> "Tool approval needed"
            "approval", "permission" -> "Approval needed"
            "input" -> "Input needed"
            "editor" -> "Text response needed"
            "select" -> "Choose an option"
            "confirm" -> "Confirmation needed"
            else -> "Unsupported request"
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

        private fun stringOptions(value: JsonElement?): List<String> {
            val array = value as? JsonArray ?: return emptyList()
            return array.mapNotNull { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.content }
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
