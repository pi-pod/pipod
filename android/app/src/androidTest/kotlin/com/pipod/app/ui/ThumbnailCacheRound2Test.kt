package com.pipod.app.ui

import android.content.ComponentCallbacks2
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.pipod.app.PiPodApplication
import kotlin.test.assertEquals
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Round 2, features F13: the decoded-tile cache is process-wide, bounded only by
 * a 48-entry count, and nothing ever dropped it.
 *
 * At 72dp on a 3x display the subsampling rule allows roughly twice the drawn
 * pixels per tile, so 48 entries is tens of megabytes held for the life of the
 * process — including, after a sign-out, the previous account's attachments.
 */
@RunWith(AndroidJUnit4::class)
class ThumbnailCacheRound2Test {

    private val application get() = ApplicationProvider.getApplicationContext<PiPodApplication>()

    @Before
    fun setUp() = AppThumbnails.clearCache()

    @After
    fun tearDown() = AppThumbnails.clearCache()

    @Test
    fun theSignOutTeardownEmptiesTheCache() {
        fill()

        application.container.clearLocalUserData()

        assertEquals(0, AppThumbnails.cachedCount, "the previous account's tiles stayed resident")
    }

    @Test
    fun memoryPressureEmptiesTheCache() {
        fill()

        application.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN)

        assertEquals(0, AppThumbnails.cachedCount)
    }

    @Test
    fun anIdleTrimIsNotAReasonToThrowWorkAway() {
        fill()

        application.onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE)

        assertEquals(2, AppThumbnails.cachedCount, "a foreground hint must not cost a re-decode")
    }

    private fun fill() {
        AppThumbnails.store("a", 72, tile())
        AppThumbnails.store("b", 72, tile())
        assertEquals(2, AppThumbnails.cachedCount)
    }

    private fun tile() = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888).asImageBitmap()
}
