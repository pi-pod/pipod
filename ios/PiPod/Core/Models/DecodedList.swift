import Foundation
import OSLog

/// One list row the client could not decode, kept so a screen can say how many
/// rows it is not showing instead of silently shortening the list.
public struct UnparsedRow: Identifiable, Sendable {
    public let id: String
    /// The row's server id when it had one, for a support conversation.
    public let rowID: String?
    public let rawJSON: JSONValue
    public let reason: String

    public init(rowID: String?, rawJSON: JSONValue, reason: String) {
        self.id = rowID ?? UUID().uuidString
        self.rowID = rowID
        self.rawJSON = rawJSON
        self.reason = reason
    }
}

/// A decoded collection plus the rows that failed.
///
/// One unreadable row must not empty a screen: a pod whose payload gained a
/// shape this build does not understand is skipped and counted, and the rest of
/// the list still renders.
public struct DecodedList<Element>: Sendable where Element: Sendable {
    public let items: [Element]
    public let unparsedRows: [UnparsedRow]

    public init(items: [Element], unparsedRows: [UnparsedRow] = []) {
        self.items = items
        self.unparsedRows = unparsedRows
    }

    public var isEmpty: Bool { items.isEmpty && unparsedRows.isEmpty }
}

private let decodeLog = Logger(subsystem: "com.pipod.app", category: "api.decode")

/// Decodes `json[key]` as a list, tolerating individual bad rows.
public func decodeListRows<Element: Decodable & Sendable>(
    json: JSONValue,
    key: String,
    resourceName: String,
    as type: Element.Type = Element.self
) throws -> DecodedList<Element> {
    guard let rows = json[key]?.arrayValue else {
        throw APIError(error: "Expected \"\(key)\" to be a list")
    }

    var items: [Element] = []
    var unparsed: [UnparsedRow] = []
    let decoder = JSONCoding.decoder
    for row in rows {
        do {
            guard case .object = row else {
                throw APIError(error: "Expected list row to be an object")
            }
            items.append(try decoder.decode(Element.self, from: JSONCoding.data(from: row)))
        } catch {
            let id = row["id"]?.displayText
            decodeLog.error(
                "Could not decode \(resourceName, privacy: .public) row \(id ?? "<unknown>", privacy: .public): \(String(describing: error), privacy: .public)"
            )
            unparsed.append(
                UnparsedRow(rowID: id, rawJSON: row, reason: String(describing: error))
            )
        }
    }
    return DecodedList(items: items, unparsedRows: unparsed)
}

/// Shared JSON coders. The server speaks camelCase and ISO-8601 strings, both of
/// which the models declare literally, so no key or date strategy is applied.
public enum JSONCoding {
    public static let decoder = JSONDecoder()
    public static let encoder = JSONEncoder()

    public static func data(from value: JSONValue) throws -> Data {
        try encoder.encode(value)
    }

    public static func value(from data: Data) throws -> JSONValue {
        try decoder.decode(JSONValue.self, from: data)
    }

    public static func decode<T: Decodable>(_ type: T.Type, from value: JSONValue) throws -> T {
        try decoder.decode(type, from: data(from: value))
    }
}
