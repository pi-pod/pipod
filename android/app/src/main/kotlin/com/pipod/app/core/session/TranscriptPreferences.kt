package com.pipod.app.core.session

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * How the reader likes a transcript shown, remembered across pods and launches.
 *
 * There is one choice: whether a reply's reasoning is laid out in full or kept to a line that
 * opens on a tap. It is a reading preference, not a property of a pod, so it lives here rather
 * than in any one session.
 */
object TranscriptPreferences {
    private const val SHOWS_THINKING = "showsThinking"

    private var prefs: SharedPreferences? = null
    private val _showsThinking = MutableStateFlow(false)

    /** True when every reply's reasoning is expanded unless that reply was closed by hand. */
    val showsThinking: StateFlow<Boolean> = _showsThinking.asStateFlow()

    fun attach(prefs: SharedPreferences) {
        this.prefs = prefs
        _showsThinking.value = prefs.getBoolean(SHOWS_THINKING, false)
    }

    fun setShowsThinking(shows: Boolean) {
        _showsThinking.value = shows
        prefs?.edit()?.putBoolean(SHOWS_THINKING, shows)?.apply()
    }
}
