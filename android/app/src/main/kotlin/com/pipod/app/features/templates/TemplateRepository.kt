package com.pipod.app.features.templates

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.DecodedList
import com.pipod.app.core.api.model.EnvironmentEditorData
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.api.model.SecretMeta
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/**
 * The environment operations the screens need, ported from
 * `pi-pod-flutter/lib/features/templates/template_repository.dart`.
 *
 * The scope string every secret call carries is `template`, so no screen has to
 * remember which of the server's scopes an environment secret lives in.
 */
interface TemplateRepository {
    suspend fun templates(): DecodedList<PodTemplate>
    suspend fun template(id: String): PodTemplate
    suspend fun editorData(id: String): EnvironmentEditorData

    suspend fun create(
        name: String,
        description: String? = null,
        initScript: String? = null,
        bakeScript: String? = null,
        config: JsonObject? = null,
        agentInstructions: String? = null,
    ): PodTemplate

    /**
     * @param bakeScript null when the editor never loaded one, which leaves the
     *   stored script untouched instead of overwriting it with an empty string.
     * @param agentInstructions null when the server never reported any, for the
     *   same reason.
     * @param expectedVersion the version the editor read; the server refuses
     *   the write with 409 when the environment has changed since.
     */
    suspend fun update(
        id: String,
        name: String,
        description: String,
        initScript: String,
        bakeScript: String?,
        config: JsonObject,
        agentInstructions: String? = null,
        expectedVersion: Int? = null,
    ): PodTemplate

    suspend fun delete(id: String)
    suspend fun secrets(templateId: String): DecodedList<SecretMeta>
    suspend fun putSecret(templateId: String, name: String, value: String)
    suspend fun deleteSecret(templateId: String, name: String)
}

class ApiTemplateRepository(private val api: ApiClient) : TemplateRepository {

    override suspend fun templates(): DecodedList<PodTemplate> = api.templates()

    override suspend fun template(id: String): PodTemplate = api.template(id)

    override suspend fun editorData(id: String): EnvironmentEditorData = api.templateEditorData(id)

    override suspend fun create(
        name: String,
        description: String?,
        initScript: String?,
        bakeScript: String?,
        config: JsonObject?,
        agentInstructions: String?,
    ): PodTemplate = api.createTemplate(name, description, initScript, bakeScript, config, agentInstructions)

    override suspend fun update(
        id: String,
        name: String,
        description: String,
        initScript: String,
        bakeScript: String?,
        config: JsonObject,
        agentInstructions: String?,
        expectedVersion: Int?,
    ): PodTemplate = api.updateTemplate(
        id = id,
        name = name,
        description = description,
        initScript = initScript,
        bakeScript = bakeScript,
        config = config,
        agentInstructions = agentInstructions,
        expectedVersion = expectedVersion,
    )

    override suspend fun delete(id: String) = api.deleteTemplate(id)

    override suspend fun secrets(templateId: String): DecodedList<SecretMeta> =
        api.secrets(scope = SECRET_SCOPE, scopeId = templateId)

    override suspend fun putSecret(templateId: String, name: String, value: String) =
        api.putSecret(scope = SECRET_SCOPE, scopeId = templateId, name = name, value = value)

    override suspend fun deleteSecret(templateId: String, name: String) =
        api.deleteSecret(scope = SECRET_SCOPE, scopeId = templateId, name = name)

    private companion object {
        const val SECRET_SCOPE = "template"
    }
}

/**
 * The `egress` block of an environment's config, as three answerable questions.
 *
 * The server's config is an open bag this client only partly understands, so it
 * is read leniently — an absent or wrongly-shaped key reads as the default
 * rather than failing the screen — and written back key by key, leaving
 * everything this build does not know about untouched.
 */
internal data class EgressSettings(
    val restricted: Boolean = false,
    val builtins: Boolean = true,
    val allow: List<String> = emptyList(),
) {

    val mode: String get() = if (restricted) ALLOWLIST else OPEN

    companion object {
        const val OPEN = "open"
        const val ALLOWLIST = "allowlist"

        fun from(config: JsonObject): EgressSettings {
            val egress = config[EGRESS] as? JsonObject ?: return EgressSettings()
            val allow = (egress["allow"] as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content }
                .orEmpty()
            return EgressSettings(
                restricted = (egress["mode"] as? JsonPrimitive)?.contentOrNull == ALLOWLIST,
                // Anything that is not an explicit `false` leaves the built-ins on.
                builtins = (egress["builtins"] as? JsonPrimitive)?.booleanOrNull != false,
                allow = allow,
            )
        }

        /** [config] with only the three egress keys this screen owns replaced. */
        fun write(config: JsonObject, settings: EgressSettings): JsonObject {
            val existing = config[EGRESS] as? JsonObject
            val egress = buildJsonObject {
                existing?.forEach { (key, value) ->
                    if (key != "mode" && key != "builtins" && key != "allow") put(key, value)
                }
                put("mode", JsonPrimitive(settings.mode))
                put("builtins", JsonPrimitive(settings.builtins))
                put("allow", JsonArray(settings.allow.map { JsonPrimitive(it) }))
            }
            return buildJsonObject {
                config.forEach { (key, value) -> if (key != EGRESS) put(key, value) }
                put(EGRESS, egress)
            }
        }

        private const val EGRESS = "egress"
    }
}
