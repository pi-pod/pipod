package com.pipod.app.features.settings

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.CredentialStatus
import com.pipod.app.core.api.model.ModelCredentialsResponse

/**
 * Account-scoped model-provider credential operations, ported from
 * `pi-pod-flutter/lib/features/settings/credentials_repository.dart`.
 *
 * There is deliberately no read of a stored credential's secret material: the
 * control plane holds it in custody and hands out only the health of the
 * connection.
 */
interface CredentialsRepository {
    suspend fun modelCredentials(): ModelCredentialsResponse
    suspend fun test(providerId: String): CredentialStatus
    suspend fun remove(providerId: String)
}

class ApiCredentialsRepository(private val api: ApiClient) : CredentialsRepository {

    override suspend fun modelCredentials(): ModelCredentialsResponse = api.modelCredentials()

    override suspend fun test(providerId: String): CredentialStatus = api.testModelCredential(providerId)

    override suspend fun remove(providerId: String) = api.deleteModelCredential(providerId)
}
