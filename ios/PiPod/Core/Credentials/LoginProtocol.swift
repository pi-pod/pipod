import Foundation

/// A choice offered by a login `select` prompt.
public struct LoginPromptOption: Hashable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let description: String?

    public init(id: String, label: String, description: String? = nil) {
        self.id = id
        self.label = label
        self.description = description
    }

    /// What the picker row reads as: the label, plus the provider's own gloss.
    public var displayLabel: String {
        guard let description, !description.isEmpty else { return label }
        return "\(label) — \(description)"
    }
}

/// One provider-auth question that must be answered before login can continue.
public struct LoginPrompt: Hashable, Sendable, Identifiable {
    public let id: String
    public let type: String
    public let message: String
    public let placeholder: String?
    public let options: [LoginPromptOption]

    public var isSelect: Bool { type == "select" }
    /// `secret` covers API keys and provider passwords: never echoed by default.
    public var isSecret: Bool { type == "secret" }

    public init(
        id: String,
        type: String,
        message: String,
        placeholder: String? = nil,
        options: [LoginPromptOption] = []
    ) {
        self.id = id
        self.type = type
        self.message = message
        self.placeholder = placeholder
        self.options = options
    }
}

public struct LoginLink: Hashable, Sendable {
    public let url: String
    public let label: String

    public init(url: String, label: String) {
        self.url = url
        self.label = label
    }

    /// What the row reads as. A provider that sent a link without a label still
    /// gets an openable button rather than a blank one.
    public var displayLabel: String { label.isEmpty ? "Open link" : label }
}

/// Progress the provider reports while a login runs.
public enum LoginEvent: Hashable, Sendable {
    case info(message: String, links: [LoginLink])
    /// `instructions` is optional in the provider contract and the serializer
    /// omits the key entirely when there are none (`model-credentials/routes.ts`
    /// only sets it `if (event.instructions)`), so a sign-in link with no gloss
    /// is an ordinary event, not a malformed one.
    case authURL(url: String, instructions: String?)
    case deviceCode(
        userCode: String, verificationURI: String, intervalSeconds: Int, expiresInSeconds: Int
    )
    case progress(message: String)

    /// Consecutive progress lines replace one another rather than stacking: they
    /// are one status, not a log.
    public var isProgress: Bool {
        if case .progress = self { return true }
        return false
    }
}

public struct LoginFailure: Hashable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public struct LoginDone: Hashable, Sendable {
    public let ok: Bool
    public let status: CredentialStatus?
    public let failure: LoginFailure?

    public init(ok: Bool, status: CredentialStatus? = nil, failure: LoginFailure? = nil) {
        self.ok = ok
        self.status = status
        self.failure = failure
    }
}

public enum LoginServerMessage: Hashable, Sendable {
    case prompt(LoginPrompt)
    case event(LoginEvent)
    case done(LoginDone)
}

/// The frozen provider-login wire protocol, as a pure function of the frame text.
///
/// Malformed, unknown and unsafe-URL frames decode to nil and are dropped rather
/// than handed to presentation code: a login screen that renders whatever arrives
/// is a phishing surface, and a half-understood prompt cannot be answered
/// honestly.
public enum LoginProtocol {
    private static let promptTypes: Set<String> = ["text", "secret", "manual_code", "select"]

    public static func decode(_ text: String) -> LoginServerMessage? {
        guard let value = JSONValue.parse(text), case .object = value else { return nil }
        switch value["type"]?.stringValue {
        case "prompt": return decodePrompt(value)
        case "event": return decodeEvent(value)
        case "done": return decodeDone(value)
        default: return nil
        }
    }

    private static func decodePrompt(_ value: JSONValue) -> LoginServerMessage? {
        guard let id = value["id"]?.stringValue,
              let prompt = value["prompt"], case .object = prompt,
              let type = prompt["type"]?.stringValue, promptTypes.contains(type),
              let message = prompt["message"]?.stringValue
        else { return nil }

        let options = (prompt["options"]?.arrayValue ?? []).compactMap { raw -> LoginPromptOption? in
            guard let id = raw["id"]?.stringValue, let label = raw["label"]?.stringValue else {
                return nil
            }
            return LoginPromptOption(
                id: id, label: label, description: raw["description"]?.stringValue
            )
        }
        // A select with nothing to select from cannot be answered.
        if type == "select", options.isEmpty { return nil }

        return .prompt(
            LoginPrompt(
                id: id,
                type: type,
                message: message,
                placeholder: prompt["placeholder"]?.stringValue,
                options: options
            )
        )
    }

    private static func decodeEvent(_ value: JSONValue) -> LoginServerMessage? {
        guard let event = value["event"], case .object = event else { return nil }
        switch event["type"]?.stringValue {
        case "info":
            guard let message = event["message"]?.stringValue else { return nil }
            // The label is the provider's caption for the link, not part of
            // what makes it safe: the URL is what is checked, and a caption the
            // provider did not send is no reason to drop the link. One it sent
            // in the wrong shape is a different matter — see `optionalText`.
            let links = (event["links"]?.arrayValue ?? []).compactMap { raw -> LoginLink? in
                guard let url = raw["url"]?.stringValue, isSafeLoginURL(url),
                      let label = optionalText(raw["label"])
                else { return nil }
                return LoginLink(url: url, label: label ?? "")
            }
            return .event(.info(message: message, links: links))
        case "auth_url":
            guard let url = event["url"]?.stringValue, isSafeLoginURL(url),
                  let instructions = optionalText(event["instructions"])
            else { return nil }
            return .event(.authURL(url: url, instructions: instructions))
        case "device_code":
            guard let userCode = event["userCode"]?.stringValue,
                  let verificationURI = event["verificationUri"]?.stringValue,
                  isSafeLoginURL(verificationURI)
            else { return nil }
            return .event(
                .deviceCode(
                    userCode: userCode,
                    verificationURI: verificationURI,
                    intervalSeconds: event["intervalSeconds"]?.intValue ?? 0,
                    expiresInSeconds: event["expiresInSeconds"]?.intValue ?? 0
                )
            )
        case "progress":
            guard let message = event["message"]?.stringValue else { return nil }
            return .event(.progress(message: message))
        default:
            return nil
        }
    }

    private static func decodeDone(_ value: JSONValue) -> LoginServerMessage? {
        guard let ok = value["ok"]?.boolValue else { return nil }
        if ok {
            guard let raw = value["status"], case .object = raw,
                  let status = try? JSONCoding.decode(CredentialStatus.self, from: raw)
            else { return nil }
            return .done(LoginDone(ok: true, status: status))
        }
        guard let error = value["error"], case .object = error,
              let code = error["code"]?.stringValue,
              let message = error["message"]?.stringValue
        else { return nil }
        return .done(LoginDone(ok: false, failure: LoginFailure(code: code, message: message)))
    }

    /// An optional string field, with the distinction that matters on this wire:
    /// absent or null is "the provider sent none" (`.some(nil)`), while present
    /// in another shape means the frame is not what it claims to be (`nil`) and
    /// the caller drops it. Empty and whitespace-only text read as absent.
    private static func optionalText(_ value: JSONValue?) -> String?? {
        guard let value, !value.isNull else { return .some(nil) }
        guard let text = value.stringValue else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return .some(trimmed.isEmpty ? nil : trimmed)
    }

    /// Login links may use HTTPS anywhere. Plain HTTP is allowed only for a local
    /// loopback callback used by provider development flows.
    public static func isSafeLoginURL(_ value: String) -> Bool {
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty
        else { return false }
        if scheme == "https" { return true }
        guard scheme == "http" else { return false }
        // URLComponents keeps IPv6 literals bracketed.
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        return ["localhost", "127.0.0.1", "::1"].contains(bare)
    }
}
