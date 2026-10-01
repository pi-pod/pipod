import Foundation

/// A decoded JSON value of unknown shape.
///
/// The server carries genuinely dynamic payloads — interaction bodies, transcript
/// event payloads, extension-UI frames, config bundles — that no Swift type can
/// describe ahead of time. Modelling them as `Any` loses `Codable` and equatability
/// (SwiftUI diffing needs both), so they are kept as this enum instead.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    // MARK: - Codable

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value):
            // Whole numbers round-trip as integers so a server that validates
            // `limit: 200` does not receive `200.0`.
            if let integer = exactInteger(value) {
                try container.encode(integer)
            } else {
                try container.encode(value)
            }
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    // MARK: - Typed access

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// A number an `Int` can hold. Out-of-range values read as absent rather
    /// than trapping: these payloads come off the wire, and `Int(1e300)` is a
    /// crash, not a large number.
    public var intValue: Int? {
        guard case .number(let value) = self, value.isFinite else { return nil }
        return Int(exactly: value.rounded())
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// Reads a key from an object value; anything else reads as absent.
    public subscript(key: String) -> JSONValue? {
        guard case .object(let object) = self else { return nil }
        return object[key]
    }

    /// Reads an index from an array value; anything else reads as absent.
    public subscript(index: Int) -> JSONValue? {
        guard case .array(let array) = self, array.indices.contains(index) else { return nil }
        return array[index]
    }

    /// The string a caller can show. Numbers and booleans print rather than
    /// vanishing, which is what makes a tolerant transcript readable.
    public var displayText: String? {
        switch self {
        case .string(let value): return value
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            if let integer = exactInteger(value) { return String(integer) }
            return String(value)
        case .null, .array, .object: return nil
        }
    }

    // MARK: - Bridging

    /// Converts a `JSONSerialization` value. Returns `.null` for anything unsupported.
    public init(any value: Any?) {
        switch value {
        case nil, is NSNull:
            self = .null
        // NSNumber must be matched before Bool: `1` from JSONSerialization also
        // casts to `true`, which would print every count in the app as a boolean.
        // CFBoolean is the only reliable tell between the two.
        case let value as NSNumber:
            if CFGetTypeID(value) == CFBooleanGetTypeID() {
                self = .bool(value.boolValue)
            } else {
                self = .number(value.doubleValue)
            }
        case let value as Bool:
            self = .bool(value)
        case let value as String:
            self = .string(value)
        case let value as [Any?]:
            self = .array(value.map(JSONValue.init(any:)))
        case let value as [String: Any?]:
            self = .object(value.mapValues(JSONValue.init(any:)))
        default:
            self = .null
        }
    }

    /// The `JSONSerialization`-compatible representation.
    public var anyValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value):
            if let integer = exactInteger(value) { return integer }
            return value
        case .string(let value): return value
        case .array(let value): return value.map(\.anyValue)
        case .object(let value): return value.mapValues(\.anyValue)
        }
    }

    /// Pretty-printed JSON, for the config-bundle editors and detail screens.
    public func prettyPrinted() -> String {
        let object = anyValue
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                withJSONObject: object, options: [.prettyPrinted, .sortedKeys]
              ),
              let text = String(data: data, encoding: .utf8)
        else {
            return displayText ?? ""
        }
        return text
    }

    /// Compact JSON on a single line, for inline summaries.
    public func compactPrinted() -> String {
        let object = anyValue
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(
                withJSONObject: object, options: [.sortedKeys]
              ),
              let text = String(data: data, encoding: .utf8)
        else {
            return displayText ?? ""
        }
        return text
    }

    /// Parses a JSON document. Returns nil when the text is not valid JSON.
    public static func parse(_ text: String) -> JSONValue? {
        guard let data = text.data(using: .utf8) else { return nil }
        guard let value = try? JSONSerialization.jsonObject(
            with: data, options: [.fragmentsAllowed]
        ) else { return nil }
        return JSONValue(any: value)
    }
}

extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension JSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
}

extension JSONValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension JSONValue: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) { self = .null }
}

extension JSONValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .object(Dictionary(uniqueKeysWithValues: elements))
    }
}

private func exactInteger(_ value: Double) -> Int? {
    guard value.isFinite, value == value.rounded() else { return nil }
    // Not a range comparison: `Double(Int.max)` rounds up to 2^63, so
    // `value <= Double(Int.max)` accepts one value past the end of `Int` and
    // the conversion below traps on it. `Int(exactly:)` is the exact test.
    return Int(exactly: value)
}
