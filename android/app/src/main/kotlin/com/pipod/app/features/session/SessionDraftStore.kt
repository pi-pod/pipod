package com.pipod.app.features.session

import android.content.Context
import android.content.SharedPreferences

/**
 * Per-pod composer drafts, so a half-written prompt survives leaving the
 * screen, a push deep link into another pod, and a relaunch — losing typed work
 * is the one thing a composer must not do.
 *
 * Port of `pi-pod-flutter/lib/features/session/session_draft_store.dart`. The
 * Dart loads `SharedPreferences` asynchronously and treats a failure as "no
 * store"; Android reads are synchronous once the instance exists, so the async
 * `load()` collapses into a constructor and the interface stays synchronous.
 * A backend that refuses must not take the screen down with it: drafts are a
 * convenience, and a session is still usable without them.
 */
interface SessionDraftStore {
    fun read(podId: String): String

    fun write(podId: String, draft: String)

    /**
     * Forgets every draft. Called when the session is cleared: a half-written
     * prompt is the signed-in person's text, kept in plain preferences because
     * it is not a credential, and it must not be waiting in a composer for
     * whoever signs in next on the same device.
     */
    fun clearAll()

    companion object {
        fun keyFor(podId: String): String = "session-draft-$podId"

        /** The preferences file both draft stores share. */
        const val PREFERENCES_NAME: String = "pipod-drafts"
    }
}

/** The real store. */
class SharedPreferencesSessionDraftStore(context: Context) : SessionDraftStore {

    private val preferences: SharedPreferences? = runCatching {
        context.applicationContext.getSharedPreferences(
            SessionDraftStore.PREFERENCES_NAME,
            Context.MODE_PRIVATE,
        )
    }.getOrNull()

    override fun read(podId: String): String =
        runCatching { preferences?.getString(SessionDraftStore.keyFor(podId), null) }
            .getOrNull()
            .orEmpty()

    override fun write(podId: String, draft: String) {
        val editor = preferences?.edit() ?: return
        // An empty draft removes the entry rather than storing "": there is
        // nothing to restore, and a stored blank would outlive the pod.
        if (draft.isEmpty()) {
            editor.remove(SessionDraftStore.keyFor(podId))
        } else {
            editor.putString(SessionDraftStore.keyFor(podId), draft)
        }
        editor.apply()
    }

    override fun clearAll() {
        // The whole file: it holds nothing but drafts, and enumerating them would
        // miss any the app no longer knows a pod for.
        runCatching { preferences?.edit()?.clear()?.apply() }
    }
}

/** For tests, previews, and any composition without a `Context` to hand. */
class InMemorySessionDraftStore(initial: Map<String, String> = emptyMap()) : SessionDraftStore {

    private val drafts = initial.toMutableMap()

    override fun read(podId: String): String = drafts[podId].orEmpty()

    override fun write(podId: String, draft: String) {
        if (draft.isEmpty()) drafts.remove(podId) else drafts[podId] = draft
    }

    override fun clearAll() = drafts.clear()
}
