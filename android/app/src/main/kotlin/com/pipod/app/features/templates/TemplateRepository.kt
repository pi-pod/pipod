package com.pipod.app.features.templates

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.DecodedList
import com.pipod.app.core.api.model.PodTemplate
import com.pipod.app.core.api.model.SecretMeta
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * The environment operations the screens need, ported from
 * `pi-pod-flutter/lib/features/templates/template_repository.dart`.
 *
 * Environments themselves are only read: they are written in the web dashboard.
 * Their secrets are written here, and the scope string every secret call carries
 * is `template`, so no screen has to remember which of the server's scopes an
 * environment secret lives in.
 */
interface TemplateRepository {
    suspend fun templates(): DecodedList<PodTemplate>
    suspend fun template(id: String): PodTemplate
    suspend fun secrets(templateId: String): DecodedList<SecretMeta>
    suspend fun putSecret(templateId: String, name: String, value: String)
    suspend fun deleteSecret(templateId: String, name: String)
}

class ApiTemplateRepository(private val api: ApiClient) : TemplateRepository {

    override suspend fun templates(): DecodedList<PodTemplate> = api.templates()

    override suspend fun template(id: String): PodTemplate = api.template(id)

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
 * is read leniently: an absent or wrongly-shaped key reads as the default rather
 * than failing the screen.
 */
internal data class EgressSettings(
    val restricted: Boolean = false,
    val builtins: Boolean = true,
    val allow: List<String> = emptyList(),
) {

    companion object {
        private const val ALLOWLIST = "allowlist"

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

        private const val EGRESS = "egress"
    }
}
