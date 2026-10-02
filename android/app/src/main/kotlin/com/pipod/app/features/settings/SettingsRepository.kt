package com.pipod.app.features.settings

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.DecodedList
import com.pipod.app.core.api.model.SecretMeta
import com.pipod.app.core.api.model.SettingsLayer
import kotlinx.serialization.json.JsonObject

/**
 * The settings operations the screens need, ported from
 * `pi-pod-flutter/lib/features/settings/settings_repository.dart`.
 *
 * Secrets are always user-scoped here, so no screen has to remember which of
 * the server's scopes a personal secret lives in; and every write to a settings
 * layer carries the [SettingsLayer.version] it was read at, which is what lets
 * the server refuse a write that would overwrite somebody else's edit.
 */
interface SettingsRepository {

    suspend fun secrets(userId: String): DecodedList<SecretMeta>

    suspend fun putSecret(userId: String, name: String, value: String)

    suspend fun deleteSecret(userId: String, name: String)

    suspend fun orgSettings(orgId: String): SettingsLayer

    /** Returns the new version. Throws when [version] is no longer current. */
    suspend fun saveOrgSettings(
        orgId: String,
        config: JsonObject,
        initScript: String,
        bakeScript: String,
        version: Int,
    ): Int

    suspend fun userSettings(userId: String): SettingsLayer

    /** Returns the new version, with the same concurrency rule as [saveOrgSettings]. */
    suspend fun saveUserSettings(
        userId: String,
        config: JsonObject,
        initScript: String,
        bakeScript: String,
        version: Int,
    ): Int
}

class ApiSettingsRepository(private val api: ApiClient) : SettingsRepository {

    override suspend fun secrets(userId: String): DecodedList<SecretMeta> =
        api.secrets(scope = SECRET_SCOPE, scopeId = userId)

    override suspend fun putSecret(userId: String, name: String, value: String) =
        api.putSecret(scope = SECRET_SCOPE, scopeId = userId, name = name, value = value)

    override suspend fun deleteSecret(userId: String, name: String) =
        api.deleteSecret(scope = SECRET_SCOPE, scopeId = userId, name = name)

    override suspend fun orgSettings(orgId: String): SettingsLayer = api.orgSettings(orgId)

    override suspend fun saveOrgSettings(
        orgId: String,
        config: JsonObject,
        initScript: String,
        bakeScript: String,
        version: Int,
    ): Int = api.putOrgSettings(
        orgId = orgId,
        config = config,
        initScript = initScript,
        bakeScript = bakeScript,
        version = version,
    )

    override suspend fun userSettings(userId: String): SettingsLayer = api.userSettings(userId)

    override suspend fun saveUserSettings(
        userId: String,
        config: JsonObject,
        initScript: String,
        bakeScript: String,
        version: Int,
    ): Int = api.putUserSettings(
        userId = userId,
        config = config,
        initScript = initScript,
        bakeScript = bakeScript,
        version = version,
    )

    private companion object {
        const val SECRET_SCOPE = "user"
    }
}
