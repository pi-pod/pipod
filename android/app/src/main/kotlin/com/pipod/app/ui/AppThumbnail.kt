package com.pipod.app.ui

import android.graphics.BitmapFactory
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Thumbnails for the image bytes a turn carries.
 *
 * A phone photo is 4000×3000; decoded whole it is 48 MB of ARGB for a tile 56dp
 * across. Both the allocation and the decode used to happen inline in the
 * composition — on the main thread, again on every recomposition of the row —
 * which is a dropped frame per thumbnail and, on a turn with several pictures,
 * an OutOfMemoryError.
 *
 * So: a bounds-only pass to learn the real size, a power-of-two `inSampleSize`
 * so the decoder never materialises more than roughly twice the pixels that are
 * drawn, the work moved off the composition thread, and the result kept against
 * the attachment's id so scrolling past a row and back does not decode again.
 */
object AppThumbnails {

    /** Decoded tiles, newest last. Bounded: a long transcript is not a cache. */
    private const val CAPACITY = 48

    private val cache = object : LinkedHashMap<String, ImageBitmap>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ImageBitmap>) =
            size > CAPACITY
    }

    /**
     * A tile at most about [targetPx] on its short side, or null when the bytes
     * are not an image this platform can read.
     *
     * Blocking: call it off the main thread. [rememberThumbnail] is the
     * composable that does.
     */
    fun decodeThumbnail(bytes: ByteArray, targetPx: Int): ImageBitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, targetPx)
        }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
    }.getOrNull()

    /**
     * The power-of-two subsampling factor for an image of [width]×[height] shown
     * at [targetPx].
     *
     * Halving stops while both sides still cover the target, so the decoded tile
     * is never smaller than what is drawn and never more than twice it — the
     * same rule `BitmapFactory` documents, made explicit so it can be tested
     * without a decoder.
     */
    internal fun sampleSizeFor(width: Int, height: Int, targetPx: Int): Int {
        if (targetPx <= 0 || width <= 0 || height <= 0) return 1
        var sample = 1
        while (width / (sample * 2) >= targetPx && height / (sample * 2) >= targetPx) {
            sample *= 2
        }
        return sample
    }

    internal fun cached(id: String, targetPx: Int): ImageBitmap? =
        synchronized(cache) { cache[key(id, targetPx)] }

    internal fun store(id: String, targetPx: Int, bitmap: ImageBitmap) {
        synchronized(cache) { cache[key(id, targetPx)] = bitmap }
    }

    /**
     * Drops every decoded tile.
     *
     * Called on sign-out beside the drafts and receipts purge — at 72dp on a 3x
     * display these are megabytes of the previous account's attachment content,
     * and nothing else in the process would ever have released them — and under
     * memory pressure from [com.pipod.app.PiPodApplication.onTrimMemory].
     */
    fun clearCache() {
        synchronized(cache) { cache.clear() }
    }

    /** How many tiles are resident. Test seam for the sign-out teardown. */
    internal val cachedCount: Int get() = synchronized(cache) { cache.size }

    private fun key(id: String, targetPx: Int) = "$id@$targetPx"
}

/**
 * The tile for one attachment, decoded off the composition thread.
 *
 * Null until the decode finishes — the caller draws its placeholder glyph
 * meanwhile — and null for ever if the bytes are not a readable image, which is
 * the same state and needs no second flag.
 *
 * @param id the attachment's identity, which is what the result is cached
 *   against. Two attachments with the same name are distinct here.
 */
@Composable
fun rememberThumbnail(id: String, bytes: ByteArray, size: Dp): State<ImageBitmap?> {
    val targetPx = with(LocalDensity.current) { size.roundToPx() }
    return produceState<ImageBitmap?>(
        initialValue = AppThumbnails.cached(id, targetPx),
        id,
        targetPx,
        bytes,
    ) {
        if (value != null) return@produceState
        val decoded = withContext(Dispatchers.Default) {
            AppThumbnails.decodeThumbnail(bytes, targetPx)
        }
        if (decoded != null) AppThumbnails.store(id, targetPx, decoded)
        value = decoded
    }
}
