import Foundation

/// A question pi is waiting on. An extension called `ctx.ui.confirm`, `select`,
/// `input` or `editor`, and pi's turn does not move until some client answers.
/// The gateway sends it to every attached client and again on every attach
/// until one of them answers, so the conversation shows it the way pi's own
/// terminal would.
public struct PiDialog: Identifiable, Hashable, Sendable {
    /// How a person answers. The keys are pi's extension-UI response keys, so a
    /// wrong one reads to the pod as no answer at all.
    public enum Style: Hashable, Sendable {
        case confirm
        case input(multiline: Bool)
        case select(options: [String])
        case unsupported
    }

    /// pi's request id. The answer must carry it.
    public let id: String
    public let title: String
    public let message: String
    /// Pretty-printed JSON: the complete request, for someone who wants to see
    /// exactly what they are answering.
    public let details: String
    public let style: Style
    public let placeholder: String?
    public let prefill: String

    /// Nil for anything that is not a dialog pi can be answered on.
    public init?(request payload: JSONValue) {
        guard let id = payload["id"]?.stringValue, !id.isEmpty,
              let method = payload["method"]?.stringValue,
              ["confirm", "select", "input", "editor"].contains(method)
        else { return nil }
        self.id = id
        let options = payload["options"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let suppliedTitle = PiDialog.firstString(payload, keys: ["title", "prompt", "question"])
        title = suppliedTitle ?? PiDialog.fallbackTitle(method)
        message = PiDialog.message(payload, method: method, options: options)
        details = payload.prettyPrinted().isEmpty ? payload.compactPrinted() : payload.prettyPrinted()
        placeholder = payload["placeholder"]?.stringValue
        prefill = payload["prefill"]?.stringValue ?? ""

        // A confirmation the app could not describe must not offer a confirm
        // button: no one can consent to an unnamed action.
        let describable = suppliedTitle != nil || !message.hasPrefix(PiDialog.noSummaryPrefix)
        switch method {
        case "confirm": style = describable ? .confirm : .unsupported
        case "select": style = options.isEmpty ? .unsupported : .select(options: options)
        case "input": style = .input(multiline: false)
        default: style = .input(multiline: true)
        }
    }

    // MARK: - Answers

    /// The `extension_ui_response` frame pi releases the turn on. Without the
    /// frame type and the request id pi does not recognise the answer.
    private func answer(_ fields: [String: JSONValue]) -> JSONValue {
        var frame = fields
        frame["type"] = .string("extension_ui_response")
        frame["id"] = .string(id)
        return .object(frame)
    }

    public func confirmed(_ value: Bool) -> JSONValue { answer(["confirmed": .bool(value)]) }
    public func value(_ value: String) -> JSONValue { answer(["value": .string(value)]) }
    public var cancelled: JSONValue { answer(["cancelled": .bool(true)]) }

    /// The transcript line an answer leaves behind. Secret-looking input is
    /// never echoed, and long values are cut to one line.
    @MainActor
    public func receipt(for response: JSONValue) -> String {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        func withTitle(_ action: String) -> String {
            title.isEmpty ? "\(action)." : "\(action) \(title)."
        }
        if response["cancelled"]?.boolValue == true { return withTitle("You cancelled") }
        if let confirmed = response["confirmed"]?.boolValue {
            return withTitle(confirmed ? "You confirmed" : "You declined")
        }
        guard let raw = response["value"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty
        else { return withTitle("You answered") }
        let value = raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let shown = value.count > 80
            ? String(value.prefix(80)).trimmingCharacters(in: .whitespaces) + "…"
            : value
        if case .select = style {
            return title.isEmpty ? "You chose \(shown)." : "You chose \(shown) for \(title)."
        }
        if SessionStream.redactingSecrets(raw) != raw { return withTitle("You answered") }
        return "You answered \(shown)."
    }

    // MARK: - Payload reading

    static let noSummaryPrefix = "The request has no safe summary"

    private static func firstString(_ payload: JSONValue, keys: [String]) -> String? {
        for key in keys {
            guard let value = payload[key]?.stringValue,
                  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { continue }
            return value
        }
        return nil
    }

    private static func message(_ payload: JSONValue, method: String, options: [String]) -> String {
        if let direct = firstString(
            payload, keys: ["message", "description", "text", "command", "target", "path"]
        ) {
            return direct
        }
        if method == "select", !options.isEmpty { return "Choose one of the options." }
        if method == "input" || method == "editor" {
            if let hint = payload["placeholder"]?.stringValue { return "Enter a response. Hint: \(hint)" }
            return "pi is asking for a response."
        }
        return "\(noSummaryPrefix). Review its complete details before deciding."
    }

    private static func fallbackTitle(_ method: String) -> String {
        switch method {
        case "confirm": return "pi needs a confirmation"
        case "select": return "Choose an option"
        default: return "pi needs a response"
        }
    }
}
