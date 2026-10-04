package com.pipod.app.features.settings

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.DecodedList
import com.pipod.app.core.api.model.SecretMeta

/**
 * The secret operations the settings screen needs, ported from
 * `pi-pod-flutter/lib/features/settings/settings_repository.dart`.
 *
 * Secrets are always user-scoped here, so no screen has to remember which of
 * the server's scopes a personal secret lives in. Settings layers are not
 * written here at all: they are changed in the web dashboard.
 */
interface SettingsRepository {

    suspend fun secrets(userId: String): DecodedList<SecretMeta>

    suspend fun putSecret(userId: String, name: String, value: String)

    suspend fun deleteSecret(userId: String, name: String)
}

class ApiSettingsRepository(private val api: ApiClient) : SettingsRepository {

    override suspend fun secrets(userId: String): DecodedList<SecretMeta> =
        api.secrets(scope = SECRET_SCOPE, scopeId = userId)

    override suspend fun putSecret(userId: String, name: String, value: String) =
        api.putSecret(scope = SECRET_SCOPE, scopeId = userId, name = name, value = value)

    override suspend fun deleteSecret(userId: String, name: String) =
        api.deleteSecret(scope = SECRET_SCOPE, scopeId = userId, name = name)

    private companion object {
        const val SECRET_SCOPE = "user"
    }
}
