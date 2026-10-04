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
