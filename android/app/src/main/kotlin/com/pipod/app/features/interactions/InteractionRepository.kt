package com.pipod.app.features.interactions

import com.pipod.app.core.api.ApiClient
import com.pipod.app.core.api.model.DecodedList
import com.pipod.app.core.api.model.PendingInteraction
import com.pipod.app.core.api.model.ResolveOutcome
import kotlinx.serialization.json.JsonObject

/** UI-facing approval operations, narrow enough to replace in a test. */
interface InteractionRepository {
    suspend fun interactions(): DecodedList<PendingInteraction>

    /**
     * Answers one approval.
     *
     * The Dart returns `void`; the outcome is kept here because the session
     * screen needs [ResolveOutcome.isDeliveryPending] to decide whether the card
     * disappears or stays on screen as "sent", and throwing it away would force
     * a second round trip to find out.
     */
    suspend fun resolve(id: String, response: JsonObject): ResolveOutcome
}

/**
 * The real thing, over [ApiClient].
 *
 * Resolving always goes through `ApiClient.resolveInteraction`, which wraps the
 * answer in the `type: "extension_ui_response"` envelope pi blocks on. A
 * hand-built resolve request looks like it succeeded and then hangs the agent's
 * turn for two minutes, which is the bug the Flutter client still ships.
 */
class ApiInteractionRepository(private val api: ApiClient) : InteractionRepository {

    override suspend fun interactions(): DecodedList<PendingInteraction> = api.interactions()

    override suspend fun resolve(id: String, response: JsonObject): ResolveOutcome =
        api.resolveInteraction(id = id, response = response)
}
