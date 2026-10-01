package com.pipod.app.core.session

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The durable half of [InteractionReceiptStore].
 *
 * Behind an interface because the reducer reads receipts synchronously from a
 * plain JVM unit test, where no `Context` and no real `SharedPreferences`
 * exist. Every method is best-effort: an implementation that throws is treated
 * as "nothing stored" rather than taken as fatal.
 */
interface ReceiptPreferences {
    fun getString(key: String): String?
    fun setString(key: String, value: String)
    fun remove(key: String)
    fun getStringList(key: String): List<String>
    fun setStringList(key: String, value: List<String>)
    fun keys(): Set<String>

    /** Drops everything. Used when the session is cleared. */
    fun clear()
}

/** Android backing store, the equivalent of Flutter's `SharedPreferences`. */
class SharedPreferencesReceiptStorage(context: Context) : ReceiptPreferences {
    private val preferences = context.applicationContext
        .getSharedPreferences("interaction-receipts", Context.MODE_PRIVATE)

    override fun getString(key: String): String? = preferences.getString(key, null)

    override fun setString(key: String, value: String) {
        preferences.edit().putString(key, value).apply()
    }

    override fun remove(key: String) {
        preferences.edit().remove(key).apply()
    }

    /** Stored as one string; the receipt ids are opaque and never contain [SEPARATOR]. */
    override fun getStringList(key: String): List<String> =
        preferences.getString(key, null)?.split(SEPARATOR)?.filter { it.isNotEmpty() } ?: emptyList()

    override fun setStringList(key: String, value: List<String>) {
        preferences.edit().putString(key, value.joinToString(SEPARATOR)).apply()
    }

    override fun keys(): Set<String> = preferences.all.keys

    override fun clear() {
        preferences.edit().clear().apply()
    }

    private companion object {
        const val SEPARATOR = "\u0000"
    }
}

/**
 * Durable phrasing of approval transcript receipts, keyed by interaction id.
 *
 * The stream phrases "You confirmed …" / "You chose X for …" / "You answered …"
 * when the answer is known locally, but a reattach or cold restart replays an
 * `interaction_resolved` event that carries no answer, so every receipt would
 * otherwise re-render as the generic "Resolved {title}.". The specific wording
 * is therefore persisted here when it is emitted and read back when a replayed
 * resolution has no answer.
 *
 * Port of `pi-pod-flutter/lib/core/session/interaction_receipt_store.dart`:
 * process-static so a read stays synchronous before the backend has loaded, a
 * backend that refuses must not take the session down with it, and the store is
 * bounded (the last [maxEntries] receipts) so it cannot grow forever.
 *
 * Wiring: the application object calls [install] once with a
 * [SharedPreferencesReceiptStorage]; [SessionStream] then calls [load] to warm
 * the cache. Without an [install] the receipts live for one launch only.
 */
object InteractionReceiptStore {

    /** Upper bound on retained receipts. */
    const val maxEntries: Int = 200

    private const val ORDER_KEY = "interaction-receipt-order"
    private const val KEY_PREFIX = "interaction-receipt-"

    /** Synchronous reads before [load] completes (and across sessions). */
    private val cache = LinkedHashMap<String, String>()

    /** Insertion order (oldest first) for FIFO eviction, persisted alongside the receipts. */
    private val order = mutableListOf<String>()

    @Volatile
    private var preferences: ReceiptPreferences? = null

    @Volatile
    private var hydrated = false

    fun keyFor(interactionId: String): String = "$KEY_PREFIX$interactionId"

    /**
     * Installs the durable backend. Separate from [load] so the application can
     * bind storage synchronously at start-up and lose no receipt to a race with
     * the first session's warm-up.
     */
    fun install(preferences: ReceiptPreferences?) {
        this.preferences = preferences
    }

    /**
     * Warms the cache from the installed backend. Idempotent, and safe to call
     * fire-and-forget: receipts are a convenience and must not delay attach.
     */
    suspend fun load() {
        if (hydrated) return
        hydrated = true
        val backend = preferences ?: return
        withContext(Dispatchers.IO) { hydrate(backend) }
    }

    private fun hydrate(backend: ReceiptPreferences) {
        try {
            synchronized(cache) {
                val seen = HashSet(cache.keys).apply { addAll(order) }
                for (id in backend.getStringList(ORDER_KEY)) {
                    if (order.size >= maxEntries) break
                    if (!cache.containsKey(id) && seen.add(id)) {
                        val text = backend.getString(keyFor(id))
                        if (!text.isNullOrEmpty()) {
                            cache[id] = text
                            order.add(id)
                        }
                    }
                }
                // Entries that predate the order list still count toward the bound.
                for (key in backend.keys()) {
                    if (order.size >= maxEntries) break
                    if (!key.startsWith(KEY_PREFIX)) continue
                    val id = key.removePrefix(KEY_PREFIX)
                    if (id.isEmpty() || cache.containsKey(id) || !seen.add(id)) continue
                    val text = backend.getString(key)
                    if (!text.isNullOrEmpty()) {
                        cache[id] = text
                        order.add(id)
                    }
                }
                evictExcess()
                persistOrder()
            }
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            // Receipts are a convenience; a hostile backend must not wedge attach.
        }
    }

    /**
     * The receipt stored for [interactionId], or null when none was kept. Falls
     * back to the backend so entries written by a previous launch are found even
     * before [load] rehydrates the cache.
     */
    fun readCached(interactionId: String): String? {
        if (interactionId.isEmpty()) return null
        synchronized(cache) {
            cache[interactionId]?.takeIf { it.isNotEmpty() }?.let { return it }
            try {
                val stored = preferences?.getString(keyFor(interactionId))
                if (!stored.isNullOrEmpty()) {
                    cache[interactionId] = stored
                    if (!order.contains(interactionId)) {
                        order.add(interactionId)
                        evictExcess()
                    }
                    return stored
                }
            } catch (_: Throwable) {
                // A hostile backend must not take the transcript down with it.
            }
            return null
        }
    }

    /**
     * Keeps [receipt] for [interactionId], evicting the oldest entries past
     * [maxEntries]. Empty ids and empty receipts are ignored — a generic
     * fallback must never overwrite a specific wording with nothing.
     */
    fun writeCached(interactionId: String, receipt: String) {
        if (interactionId.isEmpty() || receipt.isEmpty()) return
        synchronized(cache) {
            cache[interactionId] = receipt
            order.remove(interactionId)
            order.add(interactionId)
            evictExcess()
            try {
                preferences?.setString(keyFor(interactionId), receipt)
                persistOrder()
            } catch (_: Throwable) {
                // Cache-only then; the next launch simply falls back to generic.
            }
        }
    }

    private fun evictExcess() {
        while (order.size > maxEntries) {
            val oldest = order.removeAt(0)
            cache.remove(oldest)
            try {
                preferences?.remove(keyFor(oldest))
            } catch (_: Throwable) {
                // Best effort; the in-memory bound still holds.
            }
        }
    }

    private fun persistOrder() {
        try {
            preferences?.setStringList(ORDER_KEY, order.toList())
        } catch (_: Throwable) {
            // Best effort.
        }
    }

    /**
     * Forgets every receipt, in memory and on disk, keeping the installed
     * backend.
     *
     * Receipts phrase what *this person* answered ("You approved deploy to
     * production."). They are written to plain preferences by design — they are
     * not credentials — but they are still one signed-in person's activity, and
     * leaving them for whoever signs in next on the same device is not a
     * trade-off anybody chose.
     */
    fun clearAll() {
        synchronized(cache) {
            cache.clear()
            order.clear()
            try {
                preferences?.clear()
            } catch (_: Throwable) {
                // The in-memory half is already gone, which is the half a
                // running app reads.
            }
        }
    }

    val cacheSizeForTesting: Int get() = synchronized(cache) { cache.size }

    fun containsCachedForTesting(interactionId: String): Boolean =
        synchronized(cache) { cache.containsKey(interactionId) }

    fun resetForTest() {
        synchronized(cache) {
            preferences = null
            hydrated = false
            cache.clear()
            order.clear()
        }
    }
}
