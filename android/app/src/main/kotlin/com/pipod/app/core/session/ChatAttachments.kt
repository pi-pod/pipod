package com.pipod.app.core.session

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.Base64
import kotlin.math.roundToInt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * An image the user attached to a chat prompt, staged in the composer until it
 * is sent. Transported to the server as a pi `ImageContent` block
 * (`{type: 'image', data: <base64>, mimeType}`), which the gateway forwards to
 * pi's RPC `prompt` verbatim.
 *
 * Port of `pi-pod-flutter/lib/core/session/chat_attachments.dart`.
 */
class ChatAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val bytes: ByteArray,
) {
    val sizeBytes: Int get() = bytes.size

    /** The `images` entry the session socket sends inside the `prompt` message. */
    fun toWireJson(): JsonObject = buildJsonObject {
        put("type", "image")
        put("data", Base64.getEncoder().encodeToString(bytes))
        put("mimeType", mimeType)
    }
}

/**
 * User-facing validation failure. [message] is already copy-safe for the
 * composer; callers render it verbatim.
 */
class ChatAttachmentError(override val message: String) : Exception(message)

object ChatAttachmentLimits {

    /** Anthropic-style providers accept PNG, JPEG, GIF and WebP. */
    val supportedMimeTypes: Set<String> = setOf("image/png", "image/jpeg", "image/gif", "image/webp")

    /**
     * One phone photo is typically 3–6 MiB; anything larger is almost certainly
     * a RAW or a video renamed by accident. Images are sent as-is: no client or
     * gateway resize exists, so this cap — not dimensions — is what keeps a turn
     * inside the provider's payload limits.
     */
    const val maxBytesPerImage: Int = 8 * 1024 * 1024

    /**
     * Keeps the base64-inflated WebSocket frame comfortably under pi's 64 MiB
     * RPC line cap even when every slot is full.
     */
    const val maxTotalBytes: Int = 15 * 1024 * 1024

    const val maxCount: Int = 5

    /**
     * The gateway's own prompt-text bound (`MAX_PROMPT_TEXT_CHARS` in
     * `gateway/stream-fanout.ts`).
     *
     * Images have had a client-side budget since the composer was written;
     * text had none, so pasting a long log produced an optimistic bubble the
     * gateway refused with an `error` frame and no event — and retrying
     * reproduced it forever. Mirrored here rather than guessed: a refusal the
     * composer can predict is one the reader can act on.
     */
    const val maxPromptTextChars: Int = 64 * 1024

    /**
     * Replay (history) budgets, mirroring the server ingress contract rather
     * than the composer: the CLI can persist turns with up to 8 images and
     * 24 MiB decoded (32 MiB base64), and truncating those rows would silently
     * lose turns the user actually sent. Descriptors cost no pixels, so the
     * wider budget is safe to hold; provider-side limits (dimensions, per-model
     * maxima) may still be stricter than any of these, and a turn the provider
     * refuses surfaces as an ordinary model error, not a client-side refusal.
     */
    const val maxHistoryCount: Int = 8
    const val maxHistoryTotalBytes: Int = 24 * 1024 * 1024

    /**
     * Max base64 chars of one full `data` block (8 MiB decoded). Checked on the
     * string *before* decoding so a hostile row cannot force an unbounded
     * allocation.
     */
    const val maxImageBase64Chars: Int = 11184812

    /**
     * Validates raw bytes picked outside the composer and returns the
     * attachment to stage. Throws [ChatAttachmentError] with composer-ready copy.
     */
    fun validate(
        id: String,
        name: String,
        bytes: ByteArray,
        existingCount: Int,
        existingBytes: Int,
    ): ChatAttachment {
        val displayName = name.trim().ifEmpty { "image" }
        if (bytes.isEmpty()) throw ChatAttachmentError("$displayName is empty.")
        checkBudget(
            displayName = displayName,
            byteLength = bytes.size.toLong(),
            existingCount = existingCount,
            existingBytes = existingBytes,
        )
        if (isLikelyHeic(displayName, bytes)) {
            throw ChatAttachmentError(
                "$displayName looks like an HEIC photo, which pi can’t read " +
                    "yet. Export it as JPEG or PNG first, then attach that.",
            )
        }
        val mimeType = sniffMimeType(bytes)
            ?: throw ChatAttachmentError(
                "$displayName is not a supported image. Use PNG, JPEG, GIF or WebP.",
            )
        return ChatAttachment(id = id, name = displayName, mimeType = mimeType, bytes = bytes)
    }

    /**
     * Count and byte-budget checks without touching the bytes. The picker runs
     * this against the file's stat size *before* reading, so a multi-gigabyte
     * mis-pick is refused without ever being read into memory.
     */
    fun checkBudget(displayName: String, byteLength: Long, existingCount: Int, existingBytes: Int) {
        if (existingCount >= maxCount) {
            throw ChatAttachmentError("A message holds at most $maxCount images. Remove one first.")
        }
        if (byteLength > maxBytesPerImage) {
            throw ChatAttachmentError(
                "$displayName is ${describeBytes(byteLength)} — images must be " +
                    "under ${describeBytes(maxBytesPerImage.toLong())} each.",
            )
        }
        if (existingBytes.toLong() + byteLength > maxTotalBytes) {
            throw ChatAttachmentError(
                "These images exceed ${describeBytes(maxTotalBytes.toLong())} in total. " +
                    "Remove one first.",
            )
        }
    }

    /**
     * Reads through a cap of [maxBytesPerImage]+1 bytes, so a file that grew
     * between the stat pre-check and the read is still refused without holding
     * more than the cap in memory. [knownSize] is the stat size the picker
     * already took (null when stating failed); it narrows the read window and
     * detects concurrent growth.
     *
     * Takes a stream rather than a platform file handle so the same budget
     * applies to a `content://` URI, a `File`, and a test fixture alike.
     */
    fun readBounded(stream: InputStream, displayName: String, knownSize: Long?): ByteArray {
        val window = if (knownSize != null && knownSize <= maxBytesPerImage) {
            knownSize + 1
        } else {
            maxBytesPerImage.toLong() + 1
        }
        val builder = ByteArrayOutputStream()
        val chunk = ByteArray(64 * 1024)
        var total = 0L
        stream.use { input ->
            while (total < window) {
                val wanted = minOf(chunk.size.toLong(), window - total).toInt()
                val read = input.read(chunk, 0, wanted)
                if (read < 0) break
                total += read
                if (total > maxBytesPerImage) {
                    throw ChatAttachmentError(
                        "$displayName is over ${describeBytes(maxBytesPerImage.toLong())} — " +
                            "images must be under ${describeBytes(maxBytesPerImage.toLong())} each.",
                    )
                }
                builder.write(chunk, 0, read)
            }
        }
        if (knownSize != null && total > knownSize) {
            throw ChatAttachmentError("$displayName changed while it was being read. Attach it again.")
        }
        return builder.toByteArray()
    }

    /**
     * File signatures only — never the extension. A renamed video or text file
     * with a `.png` suffix is refused instead of being sent to the provider as
     * garbage. Returns null for anything unrecognized, including HEIC (see
     * [isLikelyHeic] for that copy).
     */
    fun sniffMimeType(bytes: ByteArray): String? {
        if (bytes.size >= 8 &&
            bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte() &&
            bytes[2] == 0x4E.toByte() && bytes[3] == 0x47.toByte()
        ) {
            return "image/png"
        }
        if (bytes.size >= 3 &&
            bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()
        ) {
            return "image/jpeg"
        }
        if (bytes.size >= 6 &&
            bytes[0] == 0x47.toByte() && bytes[1] == 0x49.toByte() && bytes[2] == 0x46.toByte()
        ) {
            return "image/gif"
        }
        if (bytes.size >= 12 &&
            bytes[0] == 0x52.toByte() && bytes[1] == 0x49.toByte() &&
            bytes[2] == 0x46.toByte() && bytes[3] == 0x46.toByte() &&
            bytes[8] == 0x57.toByte() && bytes[9] == 0x45.toByte() &&
            bytes[10] == 0x42.toByte() && bytes[11] == 0x50.toByte()
        ) {
            return "image/webp"
        }
        return null
    }

    /**
     * HEIC/HEIF (the iPhone default) is not in [supportedMimeTypes]. Detected by
     * suffix or ISO-BMFF `ftyp` brand so the refusal can say what to do instead
     * of the generic unsupported-image copy.
     */
    fun isLikelyHeic(name: String, bytes: ByteArray): Boolean {
        val lower = name.lowercase()
        if (lower.endsWith(".heic") || lower.endsWith(".heif")) return true
        if (bytes.size >= 12 &&
            bytes[4] == 0x66.toByte() && // f
            bytes[5] == 0x74.toByte() && // t
            bytes[6] == 0x79.toByte() && // y
            bytes[7] == 0x70.toByte() // p
        ) {
            val brand = String(bytes, 8, 4, Charsets.ISO_8859_1)
            return brand in HEIC_BRANDS
        }
        return false
    }

    /**
     * File suffix for a supported mime type, for naming descriptor placeholders
     * that arrive without a name.
     */
    fun extensionForMime(mimeType: String): String = when (mimeType) {
        "image/png" -> "png"
        "image/jpeg" -> "jpg"
        "image/gif" -> "gif"
        "image/webp" -> "webp"
        else -> "img"
    }

    /** Short human size for composer copy and history placeholders. */
    fun describeBytes(bytes: Long): String {
        val mb = bytes / (1024.0 * 1024.0)
        if (mb >= 10) return "${mb.roundToInt()} MB"
        if (mb >= 0.1) return "${(mb * 10).roundToInt() / 10.0} MB".replace(".0 MB", " MB")
        val kb = bytes / 1024.0
        if (kb >= 10) return "${kb.roundToInt()} KB"
        return "${(kb * 10).roundToInt() / 10.0} KB".replace(".0 KB", " KB")
    }

    private val HEIC_BRANDS = setOf(
        "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1",
    )
}

/**
 * Stages images the platform picker returned.
 *
 * Flutter used `file_selector` for every target; on Android the picker is a
 * `Context`-bound concern (photo picker / SAF), so the interface stays here and
 * the UI layer supplies the implementation. Picking more than fits keeps the
 * first that fit and reports what was dropped: [pick] throws only when nothing
 * could be staged at all.
 */
interface ChatAttachmentPicker {
    suspend fun pick(existing: List<ChatAttachment>): List<ChatAttachment>
}
