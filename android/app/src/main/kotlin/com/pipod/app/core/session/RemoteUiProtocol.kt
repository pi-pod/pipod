package com.pipod.app.core.session

import com.pipod.app.core.api.ApiJson
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64
import kotlin.math.floor
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Kotlin half of the remote extension UI wire format (v1). Extension component
 * code runs in the pod; only rendered lines, layout metadata and terminal input
 * cross the wire. This mirrors `pi-pod/src/remote-ui-protocol.ts` — including
 * its bounds — so all implementations reject the same payloads.
 *
 * Port of `pi-pod-flutter/lib/core/session/remote_ui_protocol.dart`.
 */
const val REMOTE_UI_PROTOCOL_VERSION: Int = 1
const val REMOTE_UI_NOTIFICATION_PREFIX: String = "pi-pod-internal/remote-ui-v1:"
const val REMOTE_UI_INPUT_PREFIX: String = "pi-pod-internal/remote-ui-input-v1:"
const val REMOTE_UI_MAX_ENCODED_BYTES: Int = 2 * 1024 * 1024
const val REMOTE_UI_MAX_SURFACES: Int = 32
const val REMOTE_UI_MAX_LINES: Int = 2000
const val REMOTE_UI_MAX_LINE_LENGTH: Int = 32768
const val REMOTE_UI_MAX_SURFACE_ID_LENGTH: Int = 256
const val REMOTE_UI_MAX_INPUT_EVENTS: Int = 64
const val REMOTE_UI_MAX_DIMENSION: Int = 1000

enum class RemoteUiRole(val wireName: String) {
    CUSTOM("custom"),
    WIDGET("widget"),
    HEADER("header"),
    FOOTER("footer"),
    EDITOR("editor"),
    ;

    companion object {
        fun fromWire(value: JsonElement?): RemoteUiRole? {
            val name = value.wireText() ?: return null
            return entries.firstOrNull { it.wireName == name }
        }
    }
}

enum class RemoteUiSurfaceKind(val wireName: String) {
    OPEN("open"),
    FRAME("frame"),
    CLOSE("close"),
    ;

    companion object {
        fun fromWire(value: JsonElement?): RemoteUiSurfaceKind? {
            val name = value.wireText() ?: return null
            return entries.firstOrNull { it.wireName == name }
        }
    }
}

enum class RemoteUiControlAction(val wireName: String) {
    SET_WORKING_MESSAGE("setWorkingMessage"),
    SET_WORKING_VISIBLE("setWorkingVisible"),
    SET_WORKING_INDICATOR("setWorkingIndicator"),
    SET_HIDDEN_THINKING_LABEL("setHiddenThinkingLabel"),
    SET_TOOLS_EXPANDED("setToolsExpanded"),
    ;

    companion object {
        fun fromWire(value: JsonElement?): RemoteUiControlAction? {
            val name = value.wireText() ?: return null
            return entries.firstOrNull { it.wireName == name }
        }
    }
}

enum class RemoteUiInputKind(val wireName: String) {
    INPUT("input"),
    RESIZE("resize"),
    SET_TEXT("setText"),
    CLOSE("close"),
    ;

    companion object {
        fun fromWire(value: JsonElement?): RemoteUiInputKind? {
            val name = value.wireText() ?: return null
            return entries.firstOrNull { it.wireName == name }
        }
    }
}

enum class RemoteUiPlacement(val wireName: String) {
    ABOVE_EDITOR("aboveEditor"),
    BELOW_EDITOR("belowEditor"),
    ;

    companion object {
        fun fromWire(value: JsonElement?): RemoteUiPlacement? {
            val name = value.wireText() ?: return null
            return entries.firstOrNull { it.wireName == name }
        }
    }
}

/**
 * An overlay dimension the pod expressed either in terminal cells or as a
 * percentage of the host surface, as in `width: 40` or `width: "60%"`.
 */
class RemoteUiLength private constructor(val value: Double, val isPercent: Boolean) {

    /** [total] is the available extent in the same unit the caller wants back. */
    fun resolve(total: Double): Double = if (isPercent) total * value / 100 else value

    override fun equals(other: Any?): Boolean =
        other is RemoteUiLength && other.value == value && other.isPercent == isPercent

    override fun hashCode(): Int = 31 * value.hashCode() + isPercent.hashCode()

    override fun toString(): String = if (isPercent) "$value%" else "$value"

    companion object {
        fun cells(value: Double): RemoteUiLength = RemoteUiLength(value, isPercent = false)

        fun percent(value: Double): RemoteUiLength = RemoteUiLength(value, isPercent = true)

        fun parse(raw: JsonElement?): RemoteUiLength? {
            raw.wireNumber()?.let { return cells(it) }
            val text = raw.wireText() ?: return null
            if (!text.endsWith("%")) return null
            val parsed = text.dropLast(1).toDoubleOrNull() ?: return null
            return percent(parsed)
        }
    }
}

data class RemoteUiMargin(
    val top: Double = 0.0,
    val right: Double = 0.0,
    val bottom: Double = 0.0,
    val left: Double = 0.0,
) {
    companion object {
        fun parse(raw: JsonElement?): RemoteUiMargin {
            raw.wireNumber()?.let { return RemoteUiMargin(it, it, it, it) }
            val map = raw as? JsonObject ?: return RemoteUiMargin()
            fun side(key: String) = map[key].wireNumber() ?: 0.0
            return RemoteUiMargin(
                top = side("top"),
                right = side("right"),
                bottom = side("bottom"),
                left = side("left"),
            )
        }
    }
}

/**
 * Overlay placement metadata. The raw object is retained so unknown keys survive
 * a decode/encode round trip and never silently disappear from a frame the app
 * echoes back.
 */
class RemoteUiOverlayOptions(val raw: JsonObject) {

    val width: RemoteUiLength? get() = RemoteUiLength.parse(raw["width"])
    val minWidth: Double? get() = raw["minWidth"].wireNumber()
    val maxHeight: RemoteUiLength? get() = RemoteUiLength.parse(raw["maxHeight"])
    val anchor: String? get() = raw["anchor"].wireText()
    val offsetX: Double get() = raw["offsetX"].wireNumber() ?: 0.0
    val offsetY: Double get() = raw["offsetY"].wireNumber() ?: 0.0
    val row: RemoteUiLength? get() = RemoteUiLength.parse(raw["row"])
    val col: RemoteUiLength? get() = RemoteUiLength.parse(raw["col"])
    val margin: RemoteUiMargin get() = RemoteUiMargin.parse(raw["margin"])
    val nonCapturing: Boolean get() = raw["nonCapturing"].wireBoolean() == true

    fun toJson(): JsonObject = raw

    override fun equals(other: Any?): Boolean = other is RemoteUiOverlayOptions && other.raw == raw

    override fun hashCode(): Int = raw.hashCode()

    override fun toString(): String = raw.toString()
}

sealed class RemoteUiFrame {
    abstract val contextRevision: Int?

    abstract fun toJson(): JsonObject
}

data class RemoteUiSurfaceFrame(
    val kind: RemoteUiSurfaceKind,
    val surfaceId: String,
    val revision: Int,
    val role: RemoteUiRole,
    override val contextRevision: Int? = null,
    val lines: List<String>? = null,
    val widgetKey: String? = null,
    val placement: RemoteUiPlacement? = null,
    val overlay: Boolean = false,
    val overlayOptions: RemoteUiOverlayOptions? = null,
    val focused: Boolean? = null,
    val editorText: String? = null,
    val editorSubmit: String? = null,
    val editorSubmitId: Int? = null,
    val error: String? = null,
) : RemoteUiFrame() {

    override fun toJson(): JsonObject = buildJsonObject {
        put("v", REMOTE_UI_PROTOCOL_VERSION)
        put("kind", kind.wireName)
        put("surfaceId", surfaceId)
        put("revision", revision)
        put("role", role.wireName)
        contextRevision?.let { put("contextRevision", it) }
        lines?.let { put("lines", JsonArray(it.map { line -> JsonPrimitive(line) })) }
        widgetKey?.let { put("widgetKey", it) }
        placement?.let { put("placement", it.wireName) }
        if (overlay) put("overlay", true)
        overlayOptions?.let { put("overlayOptions", it.toJson()) }
        focused?.let { put("focused", it) }
        editorText?.let { put("editorText", it) }
        editorSubmit?.let { put("editorSubmit", it) }
        editorSubmitId?.let { put("editorSubmitId", it) }
        error?.let { put("error", it) }
    }
}

data class RemoteUiControlFrame(
    val action: RemoteUiControlAction,
    val value: JsonElement? = null,
    override val contextRevision: Int? = null,
) : RemoteUiFrame() {

    override fun toJson(): JsonObject = buildJsonObject {
        put("v", REMOTE_UI_PROTOCOL_VERSION)
        put("kind", "control")
        contextRevision?.let { put("contextRevision", it) }
        put("action", action.wireName)
        value?.let { put("value", it) }
    }
}

data class RemoteUiInput(
    val kind: RemoteUiInputKind,
    val surfaceId: String,
    val sequence: Int,
    val width: Int,
    val height: Int,
    val data: String? = null,
    val events: List<String>? = null,
) {
    /**
     * Key order matches the reference client's object literal so an encoded input
     * is byte-identical to the one the CLI would have sent.
     */
    fun toJson(): JsonObject = buildJsonObject {
        put("v", REMOTE_UI_PROTOCOL_VERSION)
        put("kind", kind.wireName)
        put("surfaceId", surfaceId)
        put("sequence", sequence)
        put("width", width)
        put("height", height)
        data?.let { put("data", it) }
        events?.takeIf { it.isNotEmpty() }
            ?.let { put("events", JsonArray(it.map { event -> JsonPrimitive(event) })) }
    }
}

fun encodeRemoteUiPayload(value: JsonObject): String =
    encodeBase64UrlUnpadded(
        ApiJson.encodeToString(JsonObject.serializer(), value).toByteArray(Charsets.UTF_8),
    )

fun encodeBase64UrlUnpadded(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

private val BASE64_URL_ALPHABET = Regex("[A-Za-z0-9_-]+")

/**
 * Canonical base64url-JSON decode with the shared size cap. Returns null for
 * anything the TypeScript codec would also reject.
 */
fun decodeWireJson(encoded: String, maxBytes: Int): JsonElement? {
    if (encoded.isEmpty()) return null
    if (encoded.length > maxBytes) return null
    if (!BASE64_URL_ALPHABET.matches(encoded)) return null
    val padding = encoded.length % 4
    if (padding == 1) return null
    val bytes = try {
        Base64.getUrlDecoder()
            .decode(if (padding == 0) encoded else encoded + "=".repeat(4 - padding))
    } catch (_: IllegalArgumentException) {
        return null
    }
    if (encodeBase64UrlUnpadded(bytes) != encoded) return null
    // A lenient UTF-8 decode would turn malformed bytes into replacement
    // characters, accepting payloads the other two implementations refuse.
    val text = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: CharacterCodingException) {
        return null
    }
    return try {
        ApiJson.parseToJsonElement(text)
    } catch (_: SerializationException) {
        null
    }
}

/**
 * Extracts a frame from an `extension_ui_request` payload: `notify` carries
 * repaints in `message`, `input` carries the long-poll the client may answer in
 * `title`.
 */
fun remoteUiFrameFromExtensionRequest(request: JsonObject): RemoteUiFrame? {
    val json = remoteUiFrameJsonFromExtensionRequest(request) ?: return null
    return remoteUiFrameFromJson(json)
}

/**
 * The validated frame as raw JSON. Surfaces merge successive frames key by key
 * — an `open` frame carries overlay metadata that later repaints omit — and
 * merging the wire objects is the only way to reproduce that exactly.
 */
fun remoteUiFrameJsonFromExtensionRequest(request: JsonObject): JsonObject? {
    val encoded = remoteUiEncodedFrame(request) ?: return null
    val decoded = decodeWireJson(encoded, REMOTE_UI_MAX_ENCODED_BYTES) as? JsonObject ?: return null
    return if (remoteUiFrameFromJson(decoded) == null) null else decoded
}

fun remoteUiEncodedFrame(request: JsonObject): String? {
    val method = request["method"].wireText()
    val title = request["title"].wireText()
    val message = request["message"].wireText()
    if (method == "input" && title != null && title.startsWith(REMOTE_UI_INPUT_PREFIX)) {
        return title.substring(REMOTE_UI_INPUT_PREFIX.length)
    }
    if (method == "notify" && message != null && message.startsWith(REMOTE_UI_NOTIFICATION_PREFIX)) {
        return message.substring(REMOTE_UI_NOTIFICATION_PREFIX.length)
    }
    return null
}

fun remoteUiFrameFromJson(value: JsonObject): RemoteUiFrame? {
    if (!isProtocolVersion(value["v"])) return null
    val contextRevision = wireInteger(value["contextRevision"])
    if (value.containsKey("contextRevision") && (contextRevision == null || contextRevision < 1)) {
        return null
    }
    if (value["kind"].wireText() == "control") {
        val action = RemoteUiControlAction.fromWire(value["action"]) ?: return null
        return RemoteUiControlFrame(
            action = action,
            value = value["value"]?.takeIf { it !is JsonNull },
            contextRevision = contextRevision,
        )
    }
    val kind = RemoteUiSurfaceKind.fromWire(value["kind"]) ?: return null
    val surfaceId = value["surfaceId"].wireText() ?: return null
    if (surfaceId.isEmpty() || surfaceId.length > REMOTE_UI_MAX_SURFACE_ID_LENGTH) return null
    val revision = wireInteger(value["revision"]) ?: return null
    if (revision < 0) return null
    val role = RemoteUiRole.fromWire(value["role"]) ?: return null
    val rawFocused = value["focused"]?.takeIf { it !is JsonNull }
    var focused: Boolean? = null
    if (rawFocused != null) focused = rawFocused.wireBoolean() ?: return null
    var lines: List<String>? = null
    val rawLines = value["lines"]?.takeIf { it !is JsonNull }
    if (rawLines != null) {
        if (rawLines !is JsonArray || rawLines.size > REMOTE_UI_MAX_LINES) return null
        val collected = ArrayList<String>(rawLines.size)
        for (line in rawLines) {
            val text = line.wireText() ?: return null
            if (text.length > REMOTE_UI_MAX_LINE_LENGTH) return null
            collected.add(text)
        }
        lines = collected
    }
    return RemoteUiSurfaceFrame(
        kind = kind,
        surfaceId = surfaceId,
        revision = revision,
        role = role,
        contextRevision = contextRevision,
        lines = lines,
        widgetKey = value["widgetKey"].wireText(),
        placement = RemoteUiPlacement.fromWire(value["placement"]),
        overlay = value["overlay"].wireBoolean() == true,
        overlayOptions = (value["overlayOptions"] as? JsonObject)?.let { RemoteUiOverlayOptions(it) },
        focused = focused,
        editorText = value["editorText"].wireText(),
        editorSubmit = value["editorSubmit"].wireText(),
        editorSubmitId = wireInteger(value["editorSubmitId"]),
        error = value["error"].wireText(),
    )
}

fun remoteUiInputFromJson(value: JsonObject): RemoteUiInput? {
    if (!isProtocolVersion(value["v"])) return null
    val kind = RemoteUiInputKind.fromWire(value["kind"]) ?: return null
    val surfaceId = value["surfaceId"].wireText() ?: return null
    if (surfaceId.isEmpty() || surfaceId.length > REMOTE_UI_MAX_SURFACE_ID_LENGTH) return null
    val sequence = wireInteger(value["sequence"]) ?: return null
    if (sequence < 0) return null
    val width = wireInteger(value["width"]) ?: return null
    if (width < 1 || width > REMOTE_UI_MAX_DIMENSION) return null
    val height = wireInteger(value["height"]) ?: return null
    if (height < 1 || height > REMOTE_UI_MAX_DIMENSION) return null
    val rawData = value["data"]?.takeIf { it !is JsonNull }
    var data: String? = null
    if (rawData != null) {
        data = rawData.wireText() ?: return null
        if (data.length > REMOTE_UI_MAX_LINE_LENGTH) return null
    }
    var events: List<String>? = null
    val rawEvents = value["events"]?.takeIf { it !is JsonNull }
    if (rawEvents != null) {
        if (rawEvents !is JsonArray || rawEvents.size > REMOTE_UI_MAX_INPUT_EVENTS) return null
        val collected = ArrayList<String>(rawEvents.size)
        for (event in rawEvents) {
            val text = event.wireText() ?: return null
            if (text.length > REMOTE_UI_MAX_LINE_LENGTH) return null
            collected.add(text)
        }
        events = collected
    }
    return RemoteUiInput(
        kind = kind,
        surfaceId = surfaceId,
        sequence = sequence,
        width = width,
        height = height,
        data = data,
        events = events,
    )
}

/** The `ui_response` body the gateway forwards to the pod verbatim. */
fun remoteUiResponsePayload(requestId: String, input: RemoteUiInput): JsonObject = buildJsonObject {
    put("type", "extension_ui_response")
    put("id", requestId)
    put("value", REMOTE_UI_INPUT_PREFIX + encodeRemoteUiPayload(input.toJson()))
}

private fun JsonElement?.wirePrimitive(): JsonPrimitive? = this as? JsonPrimitive

private fun JsonElement?.wireText(): String? = wirePrimitive()?.takeIf { it.isString }?.content

/**
 * `booleanOrNull` reads the content of a quoted `"true"` as well, which would
 * accept a string where the codec requires a JSON boolean.
 */
private fun JsonElement?.wireBoolean(): Boolean? =
    wirePrimitive()?.takeIf { !it.isString }?.content?.toBooleanStrictOrNull()

private fun JsonElement?.wireNumber(): Double? =
    wirePrimitive()?.takeIf { !it.isString }?.content?.toDoubleOrNull()

/** The version tag is compared against the integer literal, so `1.0` is not a 1. */
private fun isProtocolVersion(value: JsonElement?): Boolean =
    value.wirePrimitive()?.takeIf { !it.isString }?.content?.toLongOrNull() ==
        REMOTE_UI_PROTOCOL_VERSION.toLong()

/**
 * JSON numbers carry a fraction marker or an exponent, so an integral literal is
 * accepted exactly as `Number.isInteger` accepts it. A magnitude past 32 bits is
 * refused rather than wrapped — the wire has no such value, and truncating one
 * would turn a bogus revision into a plausible one.
 */
private fun wireInteger(value: JsonElement?): Int? {
    val literal = value.wirePrimitive()?.takeIf { !it.isString }?.content ?: return null
    val exact = literal.toLongOrNull()
        ?: literal.toDoubleOrNull()?.takeIf { it.isFinite() && it == floor(it) }?.toLong()
        ?: return null
    return if (exact >= Int.MIN_VALUE && exact <= Int.MAX_VALUE) exact.toInt() else null
}
