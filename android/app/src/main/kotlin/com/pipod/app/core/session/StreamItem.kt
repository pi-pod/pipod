package com.pipod.app.core.session

import java.time.Instant

/**
 * Client transcript row.
 *
 * Port of `pi-pod-flutter/lib/core/format/transcript_presentation.dart`. The
 * Dart row is mutable and repainted in place; here it is immutable and replaced
 * in the backing list, which is what lets Compose see a change at all — the
 * reducer's behaviour is identical either way.
 */
enum class StreamItemStyle { USER, ASSISTANT, TOOL, STATUS }

enum class StreamItemDelivery {
    DELIVERED,
    SENDING,
    WAITING_FOR_CONNECTION,
    SAVED_ON_SERVER,
    FAILED,
}

/**
 * An image that rode along with a user turn, carried on the item so the
 * transcript can thumbnail what was sent.
 *
 * The server persists `user_prompt` images as descriptors
 * (`{mimeType, bytes}`), never base64, so history rows for other sessions have
 * sizes but no pixels: those are placeholders ([isPlaceholder]) and render as
 * size tiles. A live echo adopts the outgoing bubble instead, so the local
 * bytes stay on the item and thumbnails survive the round trip.
 *
 * Identity is by reference, as in Dart: two attachments holding equal bytes are
 * still two different pictures the user attached.
 */
class StreamImageAttachment(
    /**
     * Stable identity carried over from the composer's [ChatAttachment], so a
     * retry reuses it instead of minting a colliding name-based one. Empty for
     * history rows, which never retry.
     */
    val id: String = "",
    val name: String,
    val mimeType: String,
    val bytes: ByteArray,
    /**
     * Decoded size the server reported for this image. Set only on descriptor
     * placeholders, whose bytes never left the pod.
     */
    val declaredBytes: Int? = null,
) {
    /** True when there are no pixels to show: the bytes never left the pod. */
    val isPlaceholder: Boolean get() = bytes.isEmpty()

    val sizeBytes: Int get() = declaredBytes ?: bytes.size
}

data class StreamItem(
    val id: String,
    val style: StreamItemStyle,
    val title: String,
    val text: String,
    val timestamp: Instant? = null,
    val isInProgress: Boolean = false,
    val isError: Boolean = false,
    val delivery: StreamItemDelivery = StreamItemDelivery.DELIVERED,
    val attachments: List<StreamImageAttachment> = emptyList(),
)
