import Foundation

/// An image the user attached to a chat prompt, staged in the composer until it
/// is sent. Transported as a pi `ImageContent` block
/// (`{type: "image", data: <base64>, mimeType}`), which the gateway forwards to
/// pi's RPC `prompt` verbatim.
public struct ChatAttachment: Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let mimeType: String
    public let bytes: Data

    public init(id: String, name: String, mimeType: String, bytes: Data) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.bytes = bytes
    }

    public var sizeBytes: Int { bytes.count }
}

/// A validation failure whose `message` is already composer-ready copy; callers
/// render it verbatim rather than wrapping it again.
public struct ChatAttachmentError: LocalizedError, Hashable, Sendable {
    public let message: String

    public init(_ message: String) { self.message = message }

    public var errorDescription: String? { message }
}

public enum ChatAttachmentLimits {
    /// Anthropic-style providers accept PNG, JPEG, GIF and WebP.
    public static let supportedMimeTypes: Set<String> = [
        "image/png", "image/jpeg", "image/gif", "image/webp",
    ]

    /// One phone photo is typically 3–6 MiB; anything larger is almost certainly
    /// a RAW or a video renamed by accident. Images are sent as-is — no client
    /// or gateway resize exists — so this cap, not dimensions, is what keeps a
    /// turn inside the provider's payload limits.
    public static let maxBytesPerImage = 8 * 1024 * 1024

    /// Keeps the base64-inflated WebSocket frame comfortably under pi's 64 MiB
    /// RPC line cap even when every slot is full.
    public static let maxTotalBytes = 15 * 1024 * 1024

    public static let maxCount = 5

    /// Replay budgets, mirroring the server ingress contract rather than the
    /// composer: the CLI can persist turns with up to 8 images and 24 MiB
    /// decoded, and truncating those rows would silently lose turns the user
    /// really sent.
    public static let maxHistoryCount = 8
    public static let maxHistoryTotalBytes = 24 * 1024 * 1024

    /// Max base64 characters in one full `data` block (8 MiB decoded). Checked
    /// on the string *before* decoding, so a hostile row cannot force an
    /// unbounded allocation.
    public static let maxImageBase64Chars = 11_184_812

    /// Validates raw bytes and returns the attachment to stage.
    public static func validate(
        id: String, name: String, bytes: Data, existingCount: Int, existingBytes: Int
    ) throws -> ChatAttachment {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = trimmed.isEmpty ? "image" : trimmed
        if bytes.isEmpty {
            throw ChatAttachmentError("\(displayName) is empty.")
        }
        try checkBudget(
            displayName: displayName,
            byteLength: bytes.count,
            existingCount: existingCount,
            existingBytes: existingBytes
        )
        if isLikelyHEIC(name: displayName, bytes: bytes) {
            throw ChatAttachmentError(
                "\(displayName) looks like an HEIC photo, which pi can\u{2019}t read yet. "
                    + "Export it as JPEG or PNG first, then attach that."
            )
        }
        guard let mimeType = sniffMimeType(bytes) else {
            throw ChatAttachmentError(
                "\(displayName) is not a supported image. Use PNG, JPEG, GIF or WebP."
            )
        }
        return ChatAttachment(id: id, name: displayName, mimeType: mimeType, bytes: bytes)
    }

    /// Count and byte-budget checks without touching the bytes, so a picker can
    /// refuse a multi-gigabyte mis-pick before reading it into memory.
    public static func checkBudget(
        displayName: String, byteLength: Int, existingCount: Int, existingBytes: Int
    ) throws {
        if existingCount >= maxCount {
            throw ChatAttachmentError(
                "A message holds at most \(maxCount) images. Remove one first."
            )
        }
        if byteLength > maxBytesPerImage {
            throw ChatAttachmentError(
                "\(displayName) is \(describeBytes(byteLength)) \u{2014} images must be "
                    + "under \(describeBytes(maxBytesPerImage)) each."
            )
        }
        if existingBytes + byteLength > maxTotalBytes {
            throw ChatAttachmentError(
                "These images exceed \(describeBytes(maxTotalBytes)) in total. "
                    + "Remove one first."
            )
        }
    }

    /// File signatures only — never the extension. A renamed video with a `.png`
    /// suffix is refused instead of being sent to the provider as garbage.
    /// Returns nil for anything unrecognised, including HEIC, which
    /// `isLikelyHEIC` names with its own copy.
    public static func sniffMimeType(_ bytes: Data) -> String? {
        let b = [UInt8](bytes.prefix(12))
        if b.count >= 8, b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47 {
            return "image/png"
        }
        if b.count >= 3, b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF {
            return "image/jpeg"
        }
        if b.count >= 6, b[0] == 0x47, b[1] == 0x49, b[2] == 0x46 {
            return "image/gif"
        }
        if b.count >= 12,
           b[0] == 0x52, b[1] == 0x49, b[2] == 0x46, b[3] == 0x46,
           b[8] == 0x57, b[9] == 0x45, b[10] == 0x42, b[11] == 0x50 {
            return "image/webp"
        }
        return nil
    }

    /// HEIC/HEIF — the iPhone default — is not supported by the providers.
    /// Detected by suffix or ISO-BMFF `ftyp` brand so the refusal can name the
    /// workaround instead of the generic unsupported-image copy.
    public static func isLikelyHEIC(name: String, bytes: Data) -> Bool {
        let lower = name.lowercased()
        if lower.hasSuffix(".heic") || lower.hasSuffix(".heif") { return true }
        let b = [UInt8](bytes.prefix(12))
        guard b.count >= 12, b[4] == 0x66, b[5] == 0x74, b[6] == 0x79, b[7] == 0x70
        else { return false }
        let brands: Set<String> = [
            "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1",
        ]
        return brands.contains(String(decoding: b[8..<12], as: UTF8.self))
    }

    /// File suffix for a supported mime type, for naming descriptor
    /// placeholders that arrive without a name.
    public static func fileExtension(forMime mimeType: String) -> String {
        switch mimeType {
        case "image/png": return "png"
        case "image/jpeg": return "jpg"
        case "image/gif": return "gif"
        case "image/webp": return "webp"
        default: return "img"
        }
    }

    /// Short human size for composer copy and history placeholders.
    ///
    /// Hand-rolled rather than `ByteCountFormatter`: the refusal sentences above
    /// are written against these exact strings, and a locale-aware formatter
    /// would rewrite them under the app.
    public static func describeBytes(_ bytes: Int) -> String {
        let megabytes = Double(bytes) / (1024 * 1024)
        if megabytes >= 10 { return "\(Int(megabytes.rounded())) MB" }
        if megabytes >= 0.1 {
            return trimmedDecimal(megabytes, unit: "MB")
        }
        let kilobytes = Double(bytes) / 1024
        if kilobytes >= 10 { return "\(Int(kilobytes.rounded())) KB" }
        return trimmedDecimal(kilobytes, unit: "KB")
    }

    private static func trimmedDecimal(_ value: Double, unit: String) -> String {
        let tenths = (value * 10).rounded() / 10
        if tenths == tenths.rounded() { return "\(Int(tenths)) \(unit)" }
        return String(format: "%.1f %@", tenths, unit)
    }
}
