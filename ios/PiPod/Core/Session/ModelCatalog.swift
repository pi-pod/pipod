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

    /// Searches every available model by display name, provider, or stable ID.
    /// `models` preserves the selected model at the top when the query is empty
    /// or matches it, so the common case never has to search for current state.
    public static func modelsMatching(
        _ query: String,
        available: [ModelChoice],
        current: ModelChoice?
    ) -> [ModelChoice] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let ordered = models(available: available, current: current)
        guard !needle.isEmpty else { return ordered }
        return ordered.filter {
            $0.name.localizedCaseInsensitiveContains(needle)
                || $0.provider.localizedCaseInsensitiveContains(needle)
                || $0.modelId.localizedCaseInsensitiveContains(needle)
        }
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
