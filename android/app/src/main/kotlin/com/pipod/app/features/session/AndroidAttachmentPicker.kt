package com.pipod.app.features.session

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import com.pipod.app.core.format.FriendlyError
import com.pipod.app.core.session.ChatAttachment
import com.pipod.app.core.session.ChatAttachmentError
import com.pipod.app.core.session.ChatAttachmentLimits
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Turns URIs the system photo picker returned into validated attachments.
 *
 * Flutter used `file_selector` on every target, so its picker owned both the
 * platform dialog and the validation. On Android the dialog is an
 * activity-result contract the composable has to own, so this class keeps only
 * the second half — and every limit and message still comes from
 * [ChatAttachmentLimits], never from here.
 */
class AndroidAttachmentPicker(private val contentResolver: ContentResolver) {

    /**
     * Stages every URI that fits, keeping the first that do and reporting what
     * was dropped. Throws [ChatAttachmentError] only when nothing at all could
     * be staged, so picking six images with five slots free is a success.
     */
    fun stage(uris: List<Uri>, existing: List<ChatAttachment>): List<ChatAttachment> {
        val staged = mutableListOf<ChatAttachment>()
        var firstRefusal: ChatAttachmentError? = null
        var count = existing.size
        var bytes = existing.sumOf { it.sizeBytes }

        for (uri in uris) {
            try {
                val attachment = read(uri, existingCount = count, existingBytes = bytes)
                staged.add(attachment)
                count += 1
                bytes += attachment.sizeBytes
            } catch (error: ChatAttachmentError) {
                if (firstRefusal == null) firstRefusal = error
            } catch (error: Throwable) {
                if (firstRefusal == null) {
                    firstRefusal = ChatAttachmentError(
                        "Couldn\u2019t attach that image: ${FriendlyError.message(error)}",
                    )
                }
            }
        }
        if (staged.isEmpty() && firstRefusal != null) throw firstRefusal
        return staged
    }

    private fun read(uri: Uri, existingCount: Int, existingBytes: Int): ChatAttachment {
        val (name, size) = describe(uri)
        // The stat size is checked before a single byte is read, so a
        // mis-picked multi-gigabyte file is refused rather than loaded.
        if (size != null) {
            ChatAttachmentLimits.checkBudget(
                displayName = name,
                byteLength = size,
                existingCount = existingCount,
                existingBytes = existingBytes,
            )
        }
        val stream = contentResolver.openInputStream(uri)
            ?: throw ChatAttachmentError("$name could not be opened. Attach it again.")
        val bytes = ChatAttachmentLimits.readBounded(stream, displayName = name, knownSize = size)
        return ChatAttachmentLimits.validate(
            // Identity comes from the URI, so a retry reuses it and two
            // same-named images stay distinct.
            id = uri.toString(),
            name = name,
            bytes = bytes,
            existingCount = existingCount,
            existingBytes = existingBytes,
        )
    }

    /** The display name and stat size the provider reports, with fallbacks. */
    private fun describe(uri: Uri): Pair<String, Long?> {
        val projection = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val queried = runCatching {
            contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                val name = if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                    cursor.getString(nameIndex)
                } else {
                    null
                }
                val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                    cursor.getLong(sizeIndex)
                } else {
                    null
                }
                name to size
            }
        }.getOrNull()
        val name = queried?.first?.trim()?.takeIf { it.isNotEmpty() }
            ?: uri.lastPathSegment?.trim()?.takeIf { it.isNotEmpty() }
            ?: "image"
        return name to queried?.second?.takeIf { it > 0 }
    }
}

/**
 * Remembers a photo-picker launcher and hands back the callback the composer's
 * attach button calls.
 *
 * @param existing read at launch time rather than captured, so the budget is
 *   checked against whatever is staged when the picker actually returns.
 */
@Composable
fun rememberAttachmentPicker(
    existing: () -> List<ChatAttachment>,
    onPicked: (List<ChatAttachment>) -> Unit,
    onError: (String) -> Unit,
    onPickingChanged: (Boolean) -> Unit = {},
): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentExisting by rememberUpdatedState(existing)
    val currentPicked by rememberUpdatedState(onPicked)
    val currentError by rememberUpdatedState(onError)
    val currentPicking by rememberUpdatedState(onPickingChanged)

    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(ChatAttachmentLimits.maxCount),
    ) { uris ->
        scope.launch {
            try {
                if (uris.isEmpty()) return@launch
                val picker = AndroidAttachmentPicker(context.contentResolver)
                // Reading and decoding a handful of megabytes is not frame work.
                val staged = withContext(Dispatchers.IO) { picker.stage(uris, currentExisting()) }
                currentPicked(staged)
            } catch (error: ChatAttachmentError) {
                currentError(error.message)
            } catch (error: Throwable) {
                currentError("Couldn\u2019t attach that image: ${FriendlyError.message(error)}")
            } finally {
                currentPicking(false)
            }
        }
    }

    return {
        currentPicking(true)
        // A device with no photo picker — a stripped image, a work profile with
        // the picker disabled — throws here. The result callback then never
        // runs, so the flag that disables the attach button stayed set and the
        // button was dead for the rest of the session.
        val launched = runCatching {
            launcher.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
            )
        }
        launched.exceptionOrNull()?.let { error ->
            currentPicking(false)
            currentError("Couldn’t open the photo picker: ${FriendlyError.message(error)}")
        }
    }
}
