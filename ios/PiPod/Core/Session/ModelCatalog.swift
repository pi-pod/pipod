import Foundation

/// A selectable model. Provider and model id, not the display name, are its
/// stable protocol identity — two providers may ship the same friendly name.
public struct ModelChoice: Hashable, Sendable, Identifiable {
    public let provider: String
    public let modelId: String
    public let name: String

    public init(provider: String, modelId: String, name: String) {
        self.provider = provider
        self.modelId = modelId
        self.name = name
    }

    public var id: String { "\(provider)/\(modelId)" }

    /// Decodes a `models[]` or `current` entry. Returns nil when the entry is
    /// missing either half of its identity.
    public static func from(_ payload: JSONValue?) -> ModelChoice? {
        guard let rawProvider = payload?["provider"]?.stringValue,
              let rawModelId = payload?["id"]?.stringValue
        else { return nil }
        let provider = rawProvider.trimmingCharacters(in: .whitespacesAndNewlines)
        let modelId = rawModelId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !provider.isEmpty, !modelId.isEmpty else { return nil }
        let rawName = payload?["name"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return ModelChoice(
            provider: provider,
            modelId: modelId,
            name: rawName.isEmpty ? modelId : rawName
        )
    }

    /// Identity is the wire pair only: a catalog refresh that renames a model
    /// must still recognise the current selection.
    public static func == (lhs: ModelChoice, rhs: ModelChoice) -> Bool {
        lhs.provider == rhs.provider && lhs.modelId == rhs.modelId
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(provider)
        hasher.combine(modelId)
    }
}

/// Ordering and filtering for the model picker. Pure functions so the picker
/// stays a view and the ordering stays testable.
public enum ModelCatalog {
    /// The catalog with duplicates dropped and the current model pinned first.
    public static func models(
        available: [ModelChoice], current: ModelChoice?
    ) -> [ModelChoice] {
        var seen = Set<String>()
        var result: [ModelChoice] = []
        for model in available where seen.insert(model.id).inserted {
            result.append(model)
        }
        // A pod may run a model the catalog no longer advertises; the picker
        // must still be able to show what is actually selected.
        if let current, seen.insert(current.id).inserted { result.append(current) }
        return result.sorted { left, right in
            if left == current { return right != current }
            if right == current { return false }
            let leftName = left.name.lowercased()
            let rightName = right.name.lowercased()
            if leftName != rightName { return leftName < rightName }
            let leftID = left.modelId.lowercased()
            let rightID = right.modelId.lowercased()
            if leftID != rightID { return leftID < rightID }
            let leftProvider = left.provider.lowercased()
            let rightProvider = right.provider.lowercased()
            if leftProvider != rightProvider { return leftProvider < rightProvider }
            return left.provider < right.provider
        }
    }
}

extension ModelCatalog {
    /// Every model whose name, provider or id contains each word of `query`, in
    /// the order given. Words rather than one substring, so "sol openai" finds a
    /// model either way round.
    public static func search(_ query: String, in models: [ModelChoice]) -> [ModelChoice] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return models }
        return models.filter { model in
            let haystack = "\(model.name) \(model.provider) \(model.modelId)".lowercased()
            return words.allSatisfy { haystack.contains($0) }
        }
    }
}

/// Which of a pod's models its user keeps to hand: pi's `enabledModels`, the
/// list `Ctrl+P` cycles through in a terminal.
///
/// The setting is a list of patterns, and pi resolves each against the catalog.
/// This follows pi's rules closely enough for a picker: a glob matches
/// `provider/id` or the id alone; any other pattern is an exact `provider/id`,
/// else an exact id, else a model whose id or name contains it. A `:level`
/// suffix names a thinking level for the terminal's cycle and is not part of
/// the model. A pattern that matches nothing is skipped: the scope is a
/// convenience, and a stale entry must not hide the models that do match.
public enum ModelScope {
    private static let thinkingSuffixes = [
        ":off", ":minimal", ":low", ":medium", ":high", ":xhigh",
    ]

    public static func resolve(_ patterns: [String], in models: [ModelChoice]) -> [ModelChoice] {
        var scoped: [ModelChoice] = []
        var seen = Set<String>()
        for raw in patterns {
            var pattern = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if let suffix = thinkingSuffixes.first(where: { pattern.hasSuffix($0) }) {
                pattern.removeLast(suffix.count)
            }
            guard !pattern.isEmpty else { continue }
            for model in matches(pattern, in: models) where seen.insert(model.id).inserted {
                scoped.append(model)
            }
        }
        return scoped
    }

    private static func matches(_ pattern: String, in models: [ModelChoice]) -> [ModelChoice] {
        if pattern.contains("*") || pattern.contains("?") {
            return models.filter {
                glob(pattern, matches: $0.id.lowercased())
                    || glob(pattern, matches: $0.modelId.lowercased())
            }
        }
        let exact = models.filter { $0.id.lowercased() == pattern }
        if !exact.isEmpty { return exact }
        let byModelID = models.filter { $0.modelId.lowercased() == pattern }
        if !byModelID.isEmpty { return byModelID }
        return models.filter {
            $0.modelId.lowercased().contains(pattern) || $0.name.lowercased().contains(pattern)
        }
    }

    /// `*` matches any run of characters and `?` exactly one; nothing else is special.
    private static func glob(_ pattern: String, matches text: String) -> Bool {
        let pattern = Array(pattern)
        let text = Array(text)
        var patternIndex = 0
        var textIndex = 0
        var starIndex: Int?
        var starText = 0
        while textIndex < text.count {
            if patternIndex < pattern.count,
               pattern[patternIndex] == "?" || pattern[patternIndex] == text[textIndex] {
                patternIndex += 1
                textIndex += 1
            } else if patternIndex < pattern.count, pattern[patternIndex] == "*" {
                starIndex = patternIndex
                starText = textIndex
                patternIndex += 1
            } else if let star = starIndex {
                // Let the last `*` take one more character and try again.
                patternIndex = star + 1
                starText += 1
                textIndex = starText
            } else {
                return false
            }
        }
        while patternIndex < pattern.count, pattern[patternIndex] == "*" { patternIndex += 1 }
        return patternIndex == pattern.count
    }
}

/// The last model catalog a pod on this server reported, kept so a model can be
/// chosen before the pod it is for has connected.
///
/// A pod's catalog exists only while its pi is running, which is exactly when
/// nobody needs to wait to choose. One account's pods offer much the same
/// models, so the last catalog seen is what the picker shows until the live one
/// arrives; a choice made from it is applied on connection, and dropped with a
/// note if this pod turns out not to offer it.
@MainActor
public enum ModelCatalogCache {
    public struct Snapshot: Sendable {
        public var models: [ModelChoice] = []
        public var thinkingLevels: [String] = []
        public var scopePatterns: [String] = []

        public init(
            models: [ModelChoice] = [], thinkingLevels: [String] = [],
            scopePatterns: [String] = []
        ) {
            self.models = models
            self.thinkingLevels = thinkingLevels
            self.scopePatterns = scopePatterns
        }
    }

    private static var key: String { "pipod.modelCatalog." + Config.serverURL.absoluteString }

    public static func read() -> Snapshot {
        guard let raw = UserDefaults.standard.string(forKey: key),
              let root = JSONValue.parse(raw)
        else { return Snapshot() }
        return Snapshot(
            models: (root["models"]?.arrayValue ?? []).compactMap { ModelChoice.from($0) },
            thinkingLevels: (root["thinkingLevels"]?.arrayValue ?? []).compactMap(\.stringValue),
            scopePatterns: (root["scope"]?.arrayValue ?? []).compactMap(\.stringValue)
        )
    }

    public static func write(_ snapshot: Snapshot) {
        let root: [String: Any] = [
            "models": snapshot.models.map {
                ["provider": $0.provider, "id": $0.modelId, "name": $0.name]
            },
            "thinkingLevels": snapshot.thinkingLevels,
            "scope": snapshot.scopePatterns,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: root),
              let text = String(data: data, encoding: .utf8)
        else { return }
        UserDefaults.standard.set(text, forKey: key)
    }
}

/// What the model picker needs from a live session.
///
/// The picker is reached from the session composer but knows nothing else about
/// the transport, so it takes this instead of the whole session: a preview or a
/// test can stand up a catalog without a socket.
@MainActor
public protocol ModelSelecting: AnyObject {
    var availableModels: [ModelChoice] { get }
    var currentModel: ModelChoice? { get }
    var pendingModel: ModelChoice? { get }
    var availableThinkingLevels: [String] { get }
    var currentThinkingLevel: String? { get }
    var pendingThinkingLevel: String? { get }
    /// The models this pod's user keeps to hand; empty when the pod names no scope.
    var scopedModels: [ModelChoice] { get }
    /// Chosen while the pod was not connected; made when it connects.
    var deferredModel: ModelChoice? { get }
    var deferredThinkingLevel: String? { get }
    var selectionNeedsAttention: Bool { get }
    /// True only after the gateway explicitly reports a missing/reconnect-required
    /// provider credential; an empty catalog alone is not evidence of this.
    var credentialSettingsNeeded: Bool { get }
    var hasModelSnapshot: Bool { get }
    var isConnected: Bool { get }
    /// True while an optimistic switch is unconfirmed. Rows stay disabled so a
    /// second tap cannot race the first.
    var isModelSwitchInFlight: Bool { get }
    var isThinkingSwitchInFlight: Bool { get }
    var error: String? { get }

    func refreshModels()
    /// Re-reads the live catalog without changing the requested selection.
    func checkModelStatus()
    /// Returns false when the switch could not be sent; `error` says why.
    @discardableResult func selectModel(_ model: ModelChoice) -> Bool
    @discardableResult func selectThinkingLevel(_ level: String) -> Bool
    /// Replays or reverses an unresolved selection after the live status is read.
    @discardableResult func retryPendingSelection() -> Bool
    @discardableResult func useConfirmedSelection() -> Bool
}

extension ModelSelecting {
    /// What the next message will run on: a choice still waiting for the pod,
    /// else a switch in flight, else what pi confirmed.
    public var selectedModel: ModelChoice? { deferredModel ?? pendingModel ?? currentModel }
    public var selectedThinkingLevel: String? {
        deferredThinkingLevel ?? pendingThinkingLevel ?? currentThinkingLevel
    }
}

/// Display names for pi's thinking levels.
public enum ThinkingLevelChoice {
    public static func label(_ level: String) -> String {
        switch level {
        case "off": return "Off"
        case "minimal": return "Minimal"
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "Extra high"
        default:
            guard let first = level.first else { return level }
            return first.uppercased() + level.dropFirst().lowercased()
        }
    }
}
