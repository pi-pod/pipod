import Foundation

/// Swift half of the remote extension UI wire format (v1).
///
/// Extension component code runs in the pod; only rendered lines, layout
/// metadata and terminal input cross the wire. This mirrors pi-pod's
/// `remote-ui-protocol.ts` — including its bounds — so every implementation
/// rejects the same payloads.
public let remoteUIProtocolVersion = 1
public let remoteUINotificationPrefix = "pi-pod-internal/remote-ui-v1:"
public let remoteUIInputPrefix = "pi-pod-internal/remote-ui-input-v1:"

public enum RemoteUILimits {
    public static let maxEncodedBytes = 2 * 1024 * 1024
    public static let maxSurfaces = 32
    public static let maxLines = 2000
    public static let maxLineLength = 32768
    public static let maxSurfaceIDLength = 256
    public static let maxInputEvents = 64
    public static let maxDimension = 1000
}

public enum RemoteUIRole: String, Hashable, Sendable, CaseIterable {
    case custom, widget, header, footer, editor
}

public enum RemoteUISurfaceKind: String, Hashable, Sendable {
    case open, frame, close
}

public enum RemoteUIControlAction: String, Hashable, Sendable {
    case setWorkingMessage, setWorkingVisible, setWorkingIndicator
    case setHiddenThinkingLabel, setToolsExpanded
}

public enum RemoteUIInputKind: String, Hashable, Sendable {
    case input, resize, setText, close
}

public enum RemoteUIPlacement: String, Hashable, Sendable {
    case aboveEditor, belowEditor
}

/// An overlay dimension the pod expressed either in terminal cells or as a
/// percentage of the host surface, as in `width: 40` or `width: "60%"`.
public struct RemoteUILength: Hashable, Sendable {
    public let value: Double
    public let isPercent: Bool

    public static func cells(_ value: Double) -> RemoteUILength {
        RemoteUILength(value: value, isPercent: false)
    }

    public static func percent(_ value: Double) -> RemoteUILength {
        RemoteUILength(value: value, isPercent: true)
    }

    public static func parse(_ raw: JSONValue?) -> RemoteUILength? {
        if let number = raw?.doubleValue { return .cells(number) }
        guard let text = raw?.stringValue, text.hasSuffix("%"),
              let parsed = Double(text.dropLast())
        else { return nil }
        return .percent(parsed)
    }

    /// `total` is the available extent in the same unit the caller wants back.
    public func resolve(total: Double) -> Double {
        isPercent ? total * value / 100 : value
    }
}

public struct RemoteUIMargin: Hashable, Sendable {
    public let top: Double
    public let right: Double
    public let bottom: Double
    public let left: Double

    public init(top: Double = 0, right: Double = 0, bottom: Double = 0, left: Double = 0) {
        self.top = top
        self.right = right
        self.bottom = bottom
        self.left = left
    }

    public static func parse(_ raw: JSONValue?) -> RemoteUIMargin {
        if let all = raw?.doubleValue {
            return RemoteUIMargin(top: all, right: all, bottom: all, left: all)
        }
        guard let raw, raw.objectValue != nil else { return RemoteUIMargin() }
        func side(_ key: String) -> Double { raw[key]?.doubleValue ?? 0 }
        return RemoteUIMargin(
            top: side("top"), right: side("right"),
            bottom: side("bottom"), left: side("left")
        )
    }
}

/// Overlay placement metadata. The raw map is retained so unknown keys survive a
/// decode/encode round trip and never silently disappear from a frame the app
/// echoes back.
public struct RemoteUIOverlayOptions: Hashable, Sendable {
    public let raw: JSONValue

    public init(_ raw: JSONValue) { self.raw = raw }

    public var width: RemoteUILength? { RemoteUILength.parse(raw["width"]) }
    public var minWidth: Double? { raw["minWidth"]?.doubleValue }
    public var maxHeight: RemoteUILength? { RemoteUILength.parse(raw["maxHeight"]) }
    public var anchor: String? { raw["anchor"]?.stringValue }
    public var offsetX: Double { raw["offsetX"]?.doubleValue ?? 0 }
    public var offsetY: Double { raw["offsetY"]?.doubleValue ?? 0 }
    public var row: RemoteUILength? { RemoteUILength.parse(raw["row"]) }
    public var col: RemoteUILength? { RemoteUILength.parse(raw["col"]) }
    public var margin: RemoteUIMargin { RemoteUIMargin.parse(raw["margin"]) }
    public var nonCapturing: Bool { raw["nonCapturing"]?.boolValue == true }
}

public struct RemoteUISurfaceFrame: Hashable, Sendable {
    public let kind: RemoteUISurfaceKind
    public let surfaceID: String
    public let revision: Int
    public let role: RemoteUIRole
    public let contextRevision: Int?
    public let lines: [String]?
    public let widgetKey: String?
    public let placement: RemoteUIPlacement?
    public let overlay: Bool
    public let overlayOptions: RemoteUIOverlayOptions?
    public let focused: Bool?
    public let editorText: String?
    public let editorSubmit: String?
    public let editorSubmitID: Int?
    public let error: String?
}

public struct RemoteUIControlFrame: Hashable, Sendable {
    public let action: RemoteUIControlAction
    public let value: JSONValue?
    public let contextRevision: Int?
}

public enum RemoteUIFrame: Hashable, Sendable {
    case surface(RemoteUISurfaceFrame)
    case control(RemoteUIControlFrame)

    public var contextRevision: Int? {
        switch self {
        case .surface(let frame): return frame.contextRevision
        case .control(let frame): return frame.contextRevision
        }
    }

    /// Decodes a validated frame. Anything the TypeScript codec would reject
    /// returns nil rather than a partially-populated frame.
    public static func from(json value: JSONValue) -> RemoteUIFrame? {
        guard value["v"]?.intValue == remoteUIProtocolVersion else { return nil }
        let contextRevision = integer(value["contextRevision"])
        if value.objectValue?.keys.contains("contextRevision") == true {
            guard let contextRevision, contextRevision >= 1 else { return nil }
        }

        if value["kind"]?.stringValue == "control" {
            guard let raw = value["action"]?.stringValue,
                  let action = RemoteUIControlAction(rawValue: raw)
            else { return nil }
            return .control(
                RemoteUIControlFrame(
                    action: action,
                    value: value["value"],
                    contextRevision: contextRevision
                )
            )
        }

        guard let rawKind = value["kind"]?.stringValue,
              let kind = RemoteUISurfaceKind(rawValue: rawKind)
        else { return nil }
        guard let surfaceID = value["surfaceId"]?.stringValue, !surfaceID.isEmpty,
              surfaceID.count <= RemoteUILimits.maxSurfaceIDLength
        else { return nil }
        guard let revision = integer(value["revision"]), revision >= 0 else { return nil }
        guard let rawRole = value["role"]?.stringValue,
              let role = RemoteUIRole(rawValue: rawRole)
        else { return nil }

        let rawFocused = value["focused"]
        if let rawFocused, !rawFocused.isNull, rawFocused.boolValue == nil { return nil }

        var lines: [String]?
        if let rawLines = value["lines"], !rawLines.isNull {
            guard let array = rawLines.arrayValue, array.count <= RemoteUILimits.maxLines
            else { return nil }
            var decoded: [String] = []
            decoded.reserveCapacity(array.count)
            for entry in array {
                guard let line = entry.stringValue,
                      line.count <= RemoteUILimits.maxLineLength
                else { return nil }
                decoded.append(line)
            }
            lines = decoded
        }

        let rawOptions = value["overlayOptions"]
        return .surface(
            RemoteUISurfaceFrame(
                kind: kind,
                surfaceID: surfaceID,
                revision: revision,
                role: role,
                contextRevision: contextRevision,
                lines: lines,
                widgetKey: value["widgetKey"]?.stringValue,
                placement: value["placement"]?.stringValue
                    .flatMap(RemoteUIPlacement.init(rawValue:)),
                overlay: value["overlay"]?.boolValue == true,
                overlayOptions: rawOptions?.objectValue == nil
                    ? nil : RemoteUIOverlayOptions(rawOptions!),
                focused: rawFocused?.boolValue,
                editorText: value["editorText"]?.stringValue,
                editorSubmit: value["editorSubmit"]?.stringValue,
                editorSubmitID: integer(value["editorSubmitId"]),
                error: value["error"]?.stringValue
            )
        )
    }

    /// JSON numbers arrive as doubles; an integral double counts exactly as
    /// `Number.isInteger` accepts it, and a fractional one does not.
    ///
    /// `Number.isInteger(1e300)` is also true in JavaScript, but no revision,
    /// sequence or dimension the protocol describes can be that large, and
    /// `Int(1e300)` traps. Anything outside `Int` reads as absent, which every
    /// caller here turns into a rejected frame.
    static func integer(_ value: JSONValue?) -> Int? {
        guard let number = value?.doubleValue, number.isFinite,
              number == number.rounded()
        else { return nil }
        return Int(exactly: number)
    }
}

public struct RemoteUIInput: Hashable, Sendable {
    public let kind: RemoteUIInputKind
    public let surfaceID: String
    public let sequence: Int
    public let width: Int
    public let height: Int
    public let data: String?
    public let events: [String]?

    public init(
        kind: RemoteUIInputKind,
        surfaceID: String,
        sequence: Int,
        width: Int,
        height: Int,
        data: String? = nil,
        events: [String]? = nil
    ) {
        self.kind = kind
        self.surfaceID = surfaceID
        self.sequence = sequence
        self.width = width
        self.height = height
        self.data = data
        self.events = events
    }

    public var json: JSONValue {
        var object: [String: JSONValue] = [
            "v": .number(Double(remoteUIProtocolVersion)),
            "kind": .string(kind.rawValue),
            "surfaceId": .string(surfaceID),
            "sequence": .number(Double(sequence)),
            "width": .number(Double(width)),
            "height": .number(Double(height)),
        ]
        if let data { object["data"] = .string(data) }
        if let events, !events.isEmpty { object["events"] = .array(events.map(JSONValue.string)) }
        return .object(object)
    }

    /// The encoded body, with keys in the reference client's literal order so an
    /// input this app sends is byte-identical to the one the CLI would have sent.
    /// `JSONEncoder` cannot express that ordering, so the object is written out
    /// by hand; the values themselves still go through the shared encoder.
    var wireJSONText: String {
        var parts: [String] = [
            "\"v\":\(remoteUIProtocolVersion)",
            "\"kind\":\(RemoteUIInput.quoted(kind.rawValue))",
            "\"surfaceId\":\(RemoteUIInput.quoted(surfaceID))",
            "\"sequence\":\(sequence)",
            "\"width\":\(width)",
            "\"height\":\(height)",
        ]
        if let data { parts.append("\"data\":\(RemoteUIInput.quoted(data))") }
        if let events, !events.isEmpty {
            let encoded = events.map(RemoteUIInput.quoted).joined(separator: ",")
            parts.append("\"events\":[\(encoded)]")
        }
        return "{\(parts.joined(separator: ","))}"
    }

    private static func quoted(_ text: String) -> String {
        guard let data = try? JSONCoding.data(from: .string(text)),
              let encoded = String(data: data, encoding: .utf8)
        else { return "\"\"" }
        return encoded
    }

    public static func from(json value: JSONValue) -> RemoteUIInput? {
        guard value["v"]?.intValue == remoteUIProtocolVersion else { return nil }
        guard let rawKind = value["kind"]?.stringValue,
              let kind = RemoteUIInputKind(rawValue: rawKind)
        else { return nil }
        guard let surfaceID = value["surfaceId"]?.stringValue, !surfaceID.isEmpty,
              surfaceID.count <= RemoteUILimits.maxSurfaceIDLength
        else { return nil }
        guard let sequence = RemoteUIFrame.integer(value["sequence"]), sequence >= 0
        else { return nil }
        guard let width = RemoteUIFrame.integer(value["width"]),
              width >= 1, width <= RemoteUILimits.maxDimension
        else { return nil }
        guard let height = RemoteUIFrame.integer(value["height"]),
              height >= 1, height <= RemoteUILimits.maxDimension
        else { return nil }

        var data: String?
        if let raw = value["data"], !raw.isNull {
            guard let text = raw.stringValue, text.count <= RemoteUILimits.maxLineLength
            else { return nil }
            data = text
        }
        var events: [String]?
        if let raw = value["events"], !raw.isNull {
            guard let array = raw.arrayValue, array.count <= RemoteUILimits.maxInputEvents
            else { return nil }
            var decoded: [String] = []
            for entry in array {
                guard let text = entry.stringValue,
                      text.count <= RemoteUILimits.maxLineLength
                else { return nil }
                decoded.append(text)
            }
            events = decoded
        }
        return RemoteUIInput(
            kind: kind, surfaceID: surfaceID, sequence: sequence,
            width: width, height: height, data: data, events: events
        )
    }
}

public enum RemoteUICodec {
    public static func encodePayload(_ value: JSONValue) -> String {
        guard let data = try? JSONCoding.data(from: value) else { return "" }
        return encodeBase64URLUnpadded(data)
    }

    public static func encodeBase64URLUnpadded(_ bytes: Data) -> String {
        bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Canonical base64url-JSON decode with the shared size cap. Returns nil for
    /// anything the TypeScript codec would also reject — including a
    /// non-canonical encoding, which must not be accepted just because it
    /// happens to decode.
    public static func decodeWireJSON(_ encoded: String, maxBytes: Int) -> JSONValue? {
        guard !encoded.isEmpty, encoded.count <= maxBytes else { return nil }
        guard encoded.allSatisfy(isBase64URLCharacter) else { return nil }
        let padding = encoded.count % 4
        if padding == 1 { return nil }
        var standard = encoded
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        if padding > 0 { standard += String(repeating: "=", count: 4 - padding) }
        guard let bytes = Data(base64Encoded: standard) else { return nil }
        guard encodeBase64URLUnpadded(bytes) == encoded else { return nil }
        guard let text = String(data: bytes, encoding: .utf8) else { return nil }
        return JSONValue.parse(text)
    }

    private static func isBase64URLCharacter(_ character: Character) -> Bool {
        character.isASCII
            && (character.isLetter || character.isNumber || character == "-" || character == "_")
    }

    /// `notify` carries repaints in `message`; `input` carries the long-poll the
    /// client may answer in `title`.
    public static func encodedFrame(in request: JSONValue) -> String? {
        let method = request["method"]?.stringValue
        if method == "input", let title = request["title"]?.stringValue,
           title.hasPrefix(remoteUIInputPrefix) {
            return String(title.dropFirst(remoteUIInputPrefix.count))
        }
        if method == "notify", let message = request["message"]?.stringValue,
           message.hasPrefix(remoteUINotificationPrefix) {
            return String(message.dropFirst(remoteUINotificationPrefix.count))
        }
        return nil
    }

    /// The validated frame as raw JSON. Surfaces merge successive frames key by
    /// key — an `open` frame carries overlay metadata that later repaints omit —
    /// and merging the wire maps is the only way to reproduce that exactly.
    public static func frameJSON(in request: JSONValue) -> JSONValue? {
        guard let encoded = encodedFrame(in: request) else { return nil }
        return decodedFrameJSON(encoded)
    }

    /// The same validation for a body already lifted out of its request, so a
    /// caller can tell "not remote-UI traffic" from "remote-UI traffic that does
    /// not decode" — which are answered very differently.
    public static func decodedFrameJSON(_ encoded: String) -> JSONValue? {
        guard let decoded = decodeWireJSON(encoded, maxBytes: RemoteUILimits.maxEncodedBytes),
              decoded.objectValue != nil,
              RemoteUIFrame.from(json: decoded) != nil
        else { return nil }
        return decoded
    }

    public static func frame(in request: JSONValue) -> RemoteUIFrame? {
        guard let json = frameJSON(in: request) else { return nil }
        return RemoteUIFrame.from(json: json)
    }

    /// The `ui_response` body the gateway forwards to the pod verbatim.
    public static func responsePayload(requestID: String, input: RemoteUIInput) -> JSONValue {
        let encoded = encodeBase64URLUnpadded(Data(input.wireJSONText.utf8))
        return .object([
            "type": .string("extension_ui_response"),
            "id": .string(requestID),
            "value": .string(remoteUIInputPrefix + encoded),
        ])
    }
}
