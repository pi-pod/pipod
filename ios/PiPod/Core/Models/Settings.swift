import Foundation

/// Metadata for one secret. Values are write-only: the server never returns them.
public struct SecretMeta: Codable, Hashable, Sendable, Identifiable {
    public let name: String
    public let scopeType: String
    public let scopeId: String
    public let keyId: String
    public let updatedAt: String

    public var id: String { "\(scopeType)/\(scopeId)/\(name)" }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        scopeType = try container.decode(String.self, forKey: .scopeType)
        scopeId = try container.decode(String.self, forKey: .scopeId)
        keyId = try container.decodeIfPresent(String.self, forKey: .keyId) ?? ""
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
    }
}

/// The parts of an environment the editor round-trips beyond the list payload.
public struct EnvironmentEditorData: Codable, Hashable, Sendable {
    public let bakeScript: String?
    public let config: JSONValue

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        bakeScript = try container.decodeIfPresent(String.self, forKey: .bakeScript)
        config = try container.decodeIfPresent(JSONValue.self, forKey: .config) ?? .object([:])
    }
}

/// One config bundle layer — organization defaults or a person's own.
///
/// `version` is the concurrency token: a write sends the version it read, and the
/// server rejects it when someone else has saved since.
public struct SettingsLayer: Codable, Hashable, Sendable {
    public let config: JSONValue
    public let version: Int
    public let initScript: String
    public let bakeScript: String

    public init(config: JSONValue, version: Int, initScript: String, bakeScript: String) {
        self.config = config
        self.version = version
        self.initScript = initScript
        self.bakeScript = bakeScript
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        config = try container.decodeIfPresent(JSONValue.self, forKey: .config) ?? .object([:])
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 0
        initScript = try container.decodeIfPresent(String.self, forKey: .initScript) ?? ""
        bakeScript = try container.decodeIfPresent(String.self, forKey: .bakeScript) ?? ""
    }
}
