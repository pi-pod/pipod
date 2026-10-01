import Foundation

/// How a person answers an approval. The keys are pi's documented extension-UI
/// response keys, so a wrong one reads to the pod as no answer at all.
public enum InteractionResponseStyle: Hashable, Sendable {
    case confirmation(key: String)
    case input(multiline: Bool)
    case selection(options: [String])
    case unsupported
}

/// Turns a protocol-shaped interaction payload into language and controls a
/// person can safely review.
public struct InteractionPresentation: Hashable, Sendable {
    public let title: String
    public let message: String
    /// Pretty-printed, recursively key-sorted JSON: the complete request, for
    /// someone who wants to see exactly what they are approving.
    public let details: String
    public let responseStyle: InteractionResponseStyle
    public let placeholder: String?
    public let prefill: String

    public init(_ interaction: PendingInteraction) {
        let payload = interaction.payload
        let method = payload["method"]?.stringValue
        let options = InteractionPresentation.stringOptions(payload["options"])

        let suppliedTitle = InteractionPresentation.firstString(
            payload, keys: ["title", "prompt", "question"]
        )
        let kind = method ?? interaction.kind
        title = suppliedTitle ?? InteractionPresentation.friendlyKind(kind)
        let message = InteractionPresentation.meaningfulMessage(
            payload, method: method, options: options
        )
        self.message = message

        // A confirmation the app could not describe must not offer an approve
        // button: no one can consent to an unnamed action.
        let hasSafeSummary =
            suppliedTitle != nil || !message.hasPrefix(InteractionPresentation.noSummaryPrefix)

        details = InteractionPresentation.prettyJSON(payload)
        placeholder = payload["placeholder"]?.stringValue
        prefill = payload["prefill"]?.stringValue ?? ""

        switch kind {
        case "confirm":
            responseStyle = hasSafeSummary ? .confirmation(key: "confirmed") : .unsupported
        case "select":
            responseStyle = options.isEmpty ? .unsupported : .selection(options: options)
        case "input":
            responseStyle = .input(multiline: false)
        case "editor":
            responseStyle = .input(multiline: true)
        case "tool_approval", "approval", "permission":
            // Compatibility for approval events that are not extension UI.
            responseStyle = hasSafeSummary ? .confirmation(key: "approved") : .unsupported
        default:
            responseStyle = .unsupported
        }
    }

    static let noSummaryPrefix = "The request has no safe summary"

    // MARK: - Payload reading

    private static func firstString(_ payload: JSONValue, keys: [String]) -> String? {
        for key in keys {
            guard let value = payload[key]?.stringValue,
                  !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { continue }
            return value
        }
        return nil
    }

    private static func stringOptions(_ value: JSONValue?) -> [String] {
        value?.arrayValue?.compactMap(\.stringValue) ?? []
    }

    private static func meaningfulMessage(
        _ payload: JSONValue, method: String?, options: [String]
    ) -> String {
        if let direct = firstString(
            payload, keys: ["message", "description", "text", "command", "target", "path"]
        ) {
            return direct
        }
        if let toolName = payload["toolName"]?.stringValue,
           let args = payload["args"], args.objectValue != nil,
           let command = firstString(args, keys: ["command", "path", "target"]) {
            return "\(toolName): \(command)"
        }
        if method == "select", !options.isEmpty {
            return "Choose one of the available options."
        }
        if method == "input" || method == "editor" {
            if let hint = payload["placeholder"]?.stringValue {
                return "Enter a response. Hint: \(hint)"
            }
            return "Enter the response requested by pi."
        }
        return "\(noSummaryPrefix). Review its complete details before deciding."
    }

    private static func friendlyKind(_ kind: String) -> String {
        switch kind {
        case "tool_approval": return "Tool approval needed"
        case "approval", "permission": return "Approval needed"
        case "input": return "Input needed"
        case "editor": return "Text response needed"
        case "select": return "Choose an option"
        case "confirm": return "Confirmation needed"
        default: return "Unsupported request"
        }
    }

    private static func prettyJSON(_ payload: JSONValue) -> String {
        let text = payload.prettyPrinted()
        return text.isEmpty ? payload.compactPrinted() : text
    }
}
