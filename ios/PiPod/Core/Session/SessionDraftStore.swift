import Foundation

/// Per-pod composer drafts, so a half-written prompt survives leaving the
/// screen, a push deep link into another pod, and a relaunch.
///
/// Losing typed work is the one thing a composer must not do — but drafts are
/// still only a convenience, so a backing store that refuses to answer degrades
/// to "no draft" instead of taking the screen down.
@MainActor
public enum SessionDraftStore {
    private static var defaults: UserDefaults? = .standard

    public static func key(podId: String) -> String { "session-draft-\(podId)" }

    public static func read(podId: String) -> String {
        defaults?.string(forKey: key(podId: podId)) ?? ""
    }

    public static func write(podId: String, draft: String) {
        guard let defaults else { return }
        if draft.isEmpty {
            defaults.removeObject(forKey: key(podId: podId))
        } else {
            defaults.set(draft, forKey: key(podId: podId))
        }
    }

    /// Drops every stored draft. Sign-out is the one moment a half-written
    /// prompt stops being the same person's work in progress.
    public static func purgeAll() {
        guard let defaults else { return }
        for storedKey in defaults.dictionaryRepresentation().keys
        where storedKey.hasPrefix("session-draft-") {
            defaults.removeObject(forKey: storedKey)
        }
    }

    public static func resetForTesting(defaults replacement: UserDefaults? = nil) {
        purgeAll()
        Self.defaults = replacement ?? .standard
    }
}

/// A REST queue admission that may outlive the screen or process which started
/// it. The UUID is reused only to query/retry that same admission; restored rows
/// are never automatically submitted again.
public struct QueuedPromptAdmission: Codable, Hashable, Sendable, Identifiable {
    public let requestID: String
    public let text: String
    public var id: String { requestID }

    public init(requestID: String, text: String) {
        self.requestID = requestID
        self.text = text
    }
}

@MainActor
public enum QueuedPromptAdmissionStore {
    private static var defaults: UserDefaults? = .standard
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    public static func key(podID: String) -> String { "queued-prompt-admissions-\(podID)" }

    public static func read(podID: String) -> [QueuedPromptAdmission] {
        guard let data = defaults?.data(forKey: key(podID: podID)),
              let records = try? decoder.decode([QueuedPromptAdmission].self, from: data)
        else { return [] }
        return records
    }

    public static func write(_ admission: QueuedPromptAdmission, podID: String) {
        guard let defaults else { return }
        var records = read(podID: podID)
        if let index = records.firstIndex(where: { $0.requestID == admission.requestID }) {
            records[index] = admission
        } else {
            records.append(admission)
        }
        guard let data = try? encoder.encode(records) else { return }
        defaults.set(data, forKey: key(podID: podID))
    }

    public static func remove(requestID: String, podID: String) {
        guard let defaults else { return }
        let remaining = read(podID: podID).filter { $0.requestID != requestID }
        guard !remaining.isEmpty else {
            defaults.removeObject(forKey: key(podID: podID))
            return
        }
        guard let data = try? encoder.encode(remaining) else { return }
        defaults.set(data, forKey: key(podID: podID))
    }

    public static func purgeAll() {
        guard let defaults else { return }
        for storedKey in defaults.dictionaryRepresentation().keys
        where storedKey.hasPrefix("queued-prompt-admissions-") {
            defaults.removeObject(forKey: storedKey)
        }
    }

    public static func resetForTesting(defaults replacement: UserDefaults? = nil) {
        purgeAll()
        Self.defaults = replacement ?? .standard
    }
}

/// One unfinished pod admission per signed-in account and server. The request
/// identity and environment are persisted before POST so view/app cancellation
/// can reconcile the same operation rather than starting another pod.
public struct LaunchOperationRecord: Codable, Hashable, Sendable {
    public let operationID: String
    public let templateID: String?

    public init(operationID: String, templateID: String?) {
        self.operationID = operationID
        self.templateID = templateID
    }
}

@MainActor
public enum LaunchOperationStore {
    private static var testDirectory: URL?
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()
    private static let directoryName = "pi-pod-launch-operations"

    private static var directory: URL? {
        if let testDirectory { return testDirectory }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?.appendingPathComponent(directoryName, isDirectory: true)
    }

    private static func fileURL(accountScope: String) -> URL? {
        guard let directory else { return nil }
        let safeName = Data(accountScope.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return directory.appendingPathComponent("launch-operation-\(safeName).json")
    }

    public static func read(accountScope: String) throws -> LaunchOperationRecord? {
        guard let fileURL = fileURL(accountScope: accountScope) else {
            throw CocoaError(.fileNoSuchFile)
        }
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let data = try Data(contentsOf: fileURL)
        return try decoder.decode(LaunchOperationRecord.self, from: data)
    }

    /// Returns true only after an atomic file replacement succeeds. The caller
    /// must not dispatch a create when its operation identity could not be saved.
    @discardableResult
    public static func write(_ record: LaunchOperationRecord, accountScope: String) -> Bool {
        guard let fileURL = fileURL(accountScope: accountScope),
              let data = try? encoder.encode(record)
        else { return false }
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
            return true
        } catch {
            return false
        }
    }

    public static func remove(accountScope: String, operationID: String) {
        guard let fileURL = fileURL(accountScope: accountScope) else { return }
        do {
            guard let current = try read(accountScope: accountScope),
                  current.operationID == operationID
            else { return }
            try FileManager.default.removeItem(at: fileURL)
        } catch {
            return
        }
    }

    public static func purgeAll() {
        guard let directory,
              let files = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil
              )
        else { return }
        for file in files where file.lastPathComponent.hasPrefix("launch-operation-") {
            try? FileManager.default.removeItem(at: file)
        }
    }

    public static func resetForTesting(directory replacement: URL? = nil) {
        if let testDirectory { try? FileManager.default.removeItem(at: testDirectory) }
        if let replacement { try? FileManager.default.removeItem(at: replacement) }
        testDirectory = replacement
    }
}

/// Unsent freeform drafts for approval responses, keyed by interaction id.
///
/// A half-typed answer must survive backing out of the session: the session
/// disposes its stream on the way out, so the restored card would otherwise come
/// back empty.
///
/// The dual key is the point. An inline card carries the pi request id and an
/// inbox row carries the gateway uuid; they name the same approval, so both
/// surfaces read and write one draft across id adoption.
@MainActor
public enum InteractionDraftStore {
    private static var cache: [String: String] = [:]
    private static var defaults: UserDefaults? = .standard

    public static func key(for interactionID: String) -> String {
        "interaction-draft-\(interactionID)"
    }

    /// The pi request id (`payload["id"]`) when the payload carries one,
    /// otherwise the id itself.
    public static func canonicalKey(id: String, payload: JSONValue?) -> String {
        guard let requestId = payload?["id"]?.stringValue, !requestId.isEmpty else { return id }
        return requestId
    }

    public static func read(id: String, payload: JSONValue?) -> String {
        let direct = cache[id] ?? defaults?.string(forKey: key(for: id))
        if let direct, !direct.isEmpty { return direct }
        let canonical = canonicalKey(id: id, payload: payload)
        if canonical != id {
            let viaCanonical = cache[canonical] ?? defaults?.string(forKey: key(for: canonical))
            if let viaCanonical, !viaCanonical.isEmpty { return viaCanonical }
        }
        return direct ?? ""
    }

    /// Writing back the prefill (or an empty string) removes the entry — there
    /// is nothing to restore then.
    public static func write(_ storeKey: String, _ draft: String, prefill: String = "") {
        guard !draft.isEmpty, draft != prefill else {
            clear(storeKey)
            return
        }
        cache[storeKey] = draft
        // An approval that asks for a token gets answered with one. Keeping it
        // for the life of the screen is the convenience; writing it into a
        // plist that survives sign-out, backup and the next person is not.
        guard !looksLikeSecret(draft) else {
            defaults?.removeObject(forKey: key(for: storeKey))
            return
        }
        defaults?.set(draft, forKey: key(for: storeKey))
    }

    /// Whether a typed answer reads as a credential rather than as prose.
    ///
    /// Deliberately eager: a false positive costs one unrestored draft after a
    /// relaunch, a false negative writes somebody's API key to disk.
    public static func looksLikeSecret(_ draft: String) -> Bool {
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return false }
        // `TOKEN=…` and friends, the same rule the transcript redacts by.
        if SessionStream.redactingSecrets(value) != value { return true }
        // Prose, a sentence, or a path answer. A credential is one word.
        guard !value.contains(where: \.isWhitespace) else { return false }
        let lowered = value.lowercased()
        let prefixes = [
            "sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghu_", "ghs_", "github_pat_",
            "xox", "akia", "asia", "aiza", "hf_", "pat_", "glpat-", "npm_", "dop_v1_",
        ]
        if prefixes.contains(where: lowered.hasPrefix) { return true }
        // A JWT: three base64url segments.
        let segments = value.split(separator: ".", omittingEmptySubsequences: false)
        if segments.count == 3, value.hasPrefix("ey"), segments.allSatisfy({ $0.count > 4 }) {
            return true
        }
        // A long unbroken run of token characters, mixing letters and digits.
        // Branch names, file paths and URLs carry `/` or `:` and are left alone.
        guard value.count >= 20,
              value.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-_+=".contains($0)) })
        else { return false }
        return value.contains(where: \.isNumber) && value.contains(where: \.isLetter)
    }

    public static func clear(_ storeKey: String) {
        cache.removeValue(forKey: storeKey)
        defaults?.removeObject(forKey: key(for: storeKey))
    }

    /// Drops every stored and cached answer, on sign-out.
    public static func purgeAll() {
        cache.removeAll()
        guard let defaults else { return }
        for storedKey in defaults.dictionaryRepresentation().keys
        where storedKey.hasPrefix("interaction-draft-") {
            defaults.removeObject(forKey: storedKey)
        }
    }

    public static func resetForTesting(defaults replacement: UserDefaults? = nil) {
        purgeAll()
        Self.defaults = replacement ?? .standard
    }
}
