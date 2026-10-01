package com.pipod.app.core.session

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.json.JsonObject

/**
 * Process-local bus that keeps approval state agreeing across a live session,
 * the approvals list and the signed-in store.
 *
 * Port of `pi-pod-flutter/lib/core/session/session_notifications.dart`. The
 * Dart controllers are broadcast and synchronous; a [SharedFlow] with a buffer
 * and a non-suspending [post] keeps the same "publishing never blocks the
 * publisher" property and preserves emission order, which is what the
 * receipt-suppression logic depends on.
 */
object SessionNotifications {
    val interactionResolved = InteractionResolvedNotification()
    val interactionPending = SessionIdNotification()
}

/**
 * A resolution, carrying the answer when the resolver knows it so a live
 * session transcript can phrase the specific "You confirmed / chose …" receipt
 * instead of the generic replay fallback. Badge listeners ignore the response;
 * transcript listeners use it when they still hold the card.
 */
data class InteractionResolvedEvent(val id: String, val response: JsonObject? = null)

class InteractionResolvedNotification {
    private val events = MutableSharedFlow<InteractionResolvedEvent>(extraBufferCapacity = BUFFER)

    val stream: SharedFlow<InteractionResolvedEvent> get() = events

    fun post(id: String, response: JsonObject? = null) {
        events.tryEmit(InteractionResolvedEvent(id, response))
    }
}

class SessionIdNotification {
    private val events = MutableSharedFlow<String>(extraBufferCapacity = BUFFER)

    val stream: SharedFlow<String> get() = events

    fun post(id: String) {
        events.tryEmit(id)
    }
}

/**
 * Deep enough that a burst of replayed resolutions cannot drop one while a
 * collector is between resumptions, which would silently leave a stale badge.
 */
private const val BUFFER = 256
