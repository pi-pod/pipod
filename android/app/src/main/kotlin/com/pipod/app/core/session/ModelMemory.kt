package com.pipod.app.core.session

import android.content.SharedPreferences
import com.pipod.app.core.config.RuntimeConfig

/**
 * The model new pods start on: the one last chosen in any pod on this server — the way pi
 * itself starts each session on the model last picked. Without it every pod launched from
 * the phone opened on the provider's built-in default, which the account may not offer.
 *
 * It applies only to pods this app has just launched and only while they have no
 * conversation: a pod launched anywhere else keeps the model it was given.
 */
object ModelMemory {
    private var prefs: SharedPreferences? = null
    private val freshPods = mutableSetOf<String>()

    private val key: String get() = "lastModel." + RuntimeConfig.serverUrl

    fun attach(prefs: SharedPreferences) {
        this.prefs = prefs
    }

    fun remember(model: ModelChoice) {
        prefs?.edit()?.putString(key, "${model.provider}/${model.modelId}")?.apply()
    }

    /** Called once a launch is admitted. */
    @Synchronized
    fun launched(podId: String) {
        freshPods += podId
    }

    /**
     * "provider/id" to start [podId] on, or null when it is not a pod this app just launched
     * or no model has been chosen on this server yet.
     */
    @Synchronized
    fun startingModel(podId: String): String? =
        if (podId in freshPods) prefs?.getString(key, null) else null

    /** The pod has been started on its model, or no longer needs to be. */
    @Synchronized
    fun settled(podId: String) {
        freshPods -= podId
    }
}
