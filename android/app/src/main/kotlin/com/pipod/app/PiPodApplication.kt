package com.pipod.app

import android.app.Application
import android.content.ComponentCallbacks2
import com.pipod.app.di.AppContainer
import com.pipod.app.ui.AppThumbnails

/**
 * Process-wide object graph.
 *
 * The app has one graph and builds it by hand: a dependency-injection framework
 * would add a build step and generated code for a dozen singletons whose wiring
 * fits on one screen.
 */
class PiPodApplication : Application() {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }

    /**
     * Attachment thumbnails are the only bitmaps this process holds beyond what
     * Compose is drawing, and they are held process-wide against the
     * attachment's id. From `TRIM_MEMORY_RUNNING_LOW` upwards a re-decode is
     * cheap and being killed is not; `RUNNING_MODERATE` is a hint rather than
     * pressure, and spending a decode on it would cost more than it saves.
     */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) AppThumbnails.clearCache()
    }
}
