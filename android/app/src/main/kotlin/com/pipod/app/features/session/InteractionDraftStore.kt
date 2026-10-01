package com.pipod.app.features.session

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Where an approval draft is kept between launches. */
interface InteractionDraftStorage {
    fun read(key: String): String?

    fun write(key: String, value: String)

    fun remove(key: String)

    /** Drops every stored draft. Used when the session is cleared. */
    fun clearAll()
}

/**
 * Unsent freeform drafts for approval responses, keyed by interaction id.
 *
 * Port of `pi-pod-flutter/lib/features/session/interaction_draft_store.dart`.
 * A half-typed answer must survive backing out of the session route — the
 * session disposes its stream on the way out, so the restored card would
 * otherwise come back empty.
 *
 * The Dart splits this into an instance (SharedPreferences) plus a set of
 * static `readCached`/`writeCached`/`clearCached` helpers that keep reads
 * synchronous before the preferences load. Here the object **is** the cache and
 * [install] merely gives it something durable to write through, so the two
 * halves collapse into one and a read before `install` still works.
 */
object InteractionDraftStore {

    private val cache = mutableMapOf<String, String>()

    @Volatile
    private var storage: InteractionDraftStorage? = null

    /**
     * Installed once from the application object. Without it, drafts still work
     * but last only as long as the process.
     */
    fun install(storage: InteractionDraftStorage) {
        this.storage = storage
    }

    fun keyFor(interactionId: String): String = "interaction-draft-$interactionId"

    /**
     * The canonical draft key for an approval: its pi request id
     * (`payload["id"]`) when it carries one, otherwise its current id.
     *
     * A restored inline card (request id) and an Approvals-tab row (gateway
     * uuid) name the same approval in different domains but share one payload
     * id, so both surfaces read and write the same draft across id adoption.
     */
    fun canonicalKeyFor(interactionId: String, payload: JsonElement?): String =
        payloadRequestId(payload) ?: interactionId

    /**
     * The draft typed for [interactionId], or `""` when none was kept. Falls
     * back to the canonical request-id key so drafts stored before id adoption —
     * or from the other surface — are still found.
     */
    fun read(interactionId: String, payload: JsonElement? = null): String {
        val direct = cache[interactionId] ?: storage?.readOrNull(keyFor(interactionId))
        if (!direct.isNullOrEmpty()) return direct
        val canonical = canonicalKeyFor(interactionId, payload)
        if (canonical != interactionId) {
            val viaCanonical = cache[canonical] ?: storage?.readOrNull(keyFor(canonical))
            if (!viaCanonical.isNullOrEmpty()) return viaCanonical
        }
        return direct.orEmpty()
    }

    /**
     * Keeps [draft]; writing back the [prefill] (or an empty string) removes the
     * entry instead — there is nothing to restore then.
     */
    fun write(key: String, draft: String, prefill: String = "") {
        if (draft.isEmpty() || draft == prefill) {
            clear(key)
            return
        }
        cache[key] = draft
        runCatching { storage?.write(keyFor(key), draft) }
    }

    /** Drops the draft, e.g. after the response was sent successfully. */
    fun clear(key: String) {
        cache.remove(key)
        runCatching { storage?.remove(keyFor(key)) }
    }

    /**
     * Forgets every draft, in memory and on disk, keeping the installed backing
     * store. Called when the session is cleared — an unsent answer to somebody
     * else's approval must not come back in a card for the next person to sign
     * in on this device.
     */
    fun clearAll() {
        cache.clear()
        runCatching { storage?.clearAll() }
    }

    /** Test seam: forgets every cached draft and any installed backing store. */
    fun resetForTest() {
        cache.clear()
        storage = null
    }

    private fun payloadRequestId(payload: JsonElement?): String? {
        val id = (payload as? JsonObject)?.get("id") as? JsonPrimitive ?: return null
        if (!id.isString) return null
        return id.content.takeIf { it.isNotEmpty() }
    }

    private fun InteractionDraftStorage.readOrNull(key: String): String? =
        runCatching { read(key) }.getOrNull()
}

/** The durable half, over the same preferences file the composer drafts use. */
class SharedPreferencesInteractionDraftStorage(context: Context) : InteractionDraftStorage {

    private val preferences: SharedPreferences? = runCatching {
        context.applicationContext.getSharedPreferences(
            SessionDraftStore.PREFERENCES_NAME,
            Context.MODE_PRIVATE,
        )
    }.getOrNull()

    override fun read(key: String): String? = preferences?.getString(key, null)

    override fun write(key: String, value: String) {
        preferences?.edit()?.putString(key, value)?.apply()
    }

    override fun remove(key: String) {
        preferences?.edit()?.remove(key)?.apply()
    }

    override fun clearAll() {
        // Shared with the composer drafts, and the file holds nothing else.
        runCatching { preferences?.edit()?.clear()?.apply() }
    }
}
