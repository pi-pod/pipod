import Foundation

/// Metadata for one account-scoped model-provider credential.
public struct CredentialStatus: Codable, Hashable, Sendable, Identifiable {
    public let providerId: String
    public let type: String
    public let state: String
    public let expiresAt: String?
    public let lastRefreshAt: String?
    public let revision: Int
    public let reason: String?
    public let retryAfter: String?

    public var id: String { providerId }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        providerId = try container.decode(String.self, forKey: .providerId)
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? "unknown"
        state = try container.decodeIfPresent(String.self, forKey: .state) ?? "unknown"
        expiresAt = try container.decodeIfPresent(String.self, forKey: .expiresAt)
        lastRefreshAt = try container.decodeIfPresent(String.self, forKey: .lastRefreshAt)
        revision = try container.decodeIfPresent(Int.self, forKey: .revision) ?? 0
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        retryAfter = try container.decodeIfPresent(String.self, forKey: .retryAfter)
    }
}

/// A provider for which the control plane can establish account credentials.
public struct ConnectableProvider: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let oauthLoginLabel: String?
    public let apiKey: Bool
    public let brokerSupported: Bool

    public var hasOauth: Bool { oauthLoginLabel != nil }

    private enum CodingKeys: String, CodingKey {
        case id, name, oauth, apiKey, brokerSupported
    }

    private enum OAuthKeys: String, CodingKey {
        case loginLabel
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? id
        apiKey = try container.decodeIfPresent(Bool.self, forKey: .apiKey) ?? false
        brokerSupported = try container.decodeIfPresent(Bool.self, forKey: .brokerSupported) ?? false
        let oauth = try? container.nestedContainer(keyedBy: OAuthKeys.self, forKey: .oauth)
        oauthLoginLabel = try oauth?.decodeIfPresent(String.self, forKey: .loginLabel)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(apiKey, forKey: .apiKey)
        try container.encode(brokerSupported, forKey: .brokerSupported)
        if let oauthLoginLabel {
            var oauth = container.nestedContainer(keyedBy: OAuthKeys.self, forKey: .oauth)
            try oauth.encode(oauthLoginLabel, forKey: .loginLabel)
        }
    }
}

/// Credential health plus the server's provider capability list.
public struct ModelCredentialsResponse: Codable, Hashable, Sendable {
    public let credentials: [CredentialStatus]
    public let providers: [ConnectableProvider]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        credentials = try container.decodeIfPresent([CredentialStatus].self, forKey: .credentials) ?? []
        providers = try container.decodeIfPresent([ConnectableProvider].self, forKey: .providers) ?? []
    }
}

/// One-shot WebSocket login ticket minted with the user's normal JWT.
public struct LoginTicket: Codable, Hashable, Sendable {
    public let ticket: String
    public let expiresAt: String
}
