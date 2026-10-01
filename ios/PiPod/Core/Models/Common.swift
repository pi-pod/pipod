import Foundation

/// A `{ "error": ..., "detail": ... }` failure body from the pi pod API.
///
/// `detail` is deliberately dynamic: the server attaches typed capacity reasons,
/// credential codes and validation context under it, and the copy layer reads
/// those keys to write a sentence a person can act on.
public struct APIError: Error, Hashable, Sendable {
    public let error: String
    public let detail: JSONValue?

    /// The actual HTTP status from the transport. Set ONLY by the HTTP client
    /// from the response it really received — never parsed from server JSON, so
    /// untrusted bodies cannot forge it (`init(json:)` strips the key).
    public let httpStatus: Int?

    public init(error: String, detail: JSONValue? = nil, httpStatus: Int? = nil) {
        self.error = error
        self.detail = detail
        self.httpStatus = httpStatus
    }

    public var transportStatus: Int? { httpStatus }

    /// Decodes a server body. Sibling keys next to `error`/`detail` are folded
    /// into the detail object so a typed `reason` survives wherever it was put.
    public init(json: [String: JSONValue]) {
        var siblings = json
        siblings.removeValue(forKey: "error")
        siblings.removeValue(forKey: "detail")
        // Transport-only: a body that claims its own status must not forge it.
        siblings.removeValue(forKey: "httpStatus")

        let rawDetail = json["detail"]
        let detail: JSONValue?
        if case .object(let object)? = rawDetail {
            var merged = object
            for (key, value) in siblings where merged[key] == nil {
                merged[key] = value
            }
            detail = .object(merged)
        } else if !siblings.isEmpty {
            var merged = siblings
            if case .string(let text)? = rawDetail {
                merged["message"] = .string(text)
            }
            detail = .object(merged)
        } else {
            detail = rawDetail
        }

        self.error = json["error"]?.stringValue ?? "Unexpected server response"
        self.detail = detail
        self.httpStatus = nil
    }

    public func withHTTPStatus(_ status: Int?) -> APIError {
        APIError(error: error, detail: detail, httpStatus: status)
    }

    public var detailText: String? { detail?.stringValue }

    public func detailString(_ key: String) -> String? {
        detail?[key]?.stringValue
    }

    public var detailCode: String? { detailString("code") }

    public var errorDescription: String {
        guard let detailText else { return error }
        return "\(error) — \(detailText)"
    }

    public var localizedDescription: String { errorDescription }
}

/// A single value the server clamped while resolving a launch against policy.
public struct PolicyClamp: Codable, Hashable, Sendable, Identifiable {
    public let path: String
    public let from: JSONValue
    public let to: JSONValue
    public let reason: String

    public var id: String { "\(path)|\(reason)" }

    public init(path: String, from: JSONValue, to: JSONValue, reason: String) {
        self.path = path
        self.from = from
        self.to = to
        self.reason = reason
    }
}
