import Foundation

/// Identity returned by `/v1/me`.
public struct AuthUser: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let email: String?
    public let displayName: String?

    public init(id: String, email: String? = nil, displayName: String? = nil) {
        self.id = id
        self.email = email
        self.displayName = displayName
    }

    /// The best name to print: display name, then email, then the raw id.
    public var label: String {
        if let displayName, !displayName.isEmpty { return displayName }
        if let email, !email.isEmpty { return email }
        return id
    }
}

/// Tokens returned by an authorization-code exchange.
public struct AuthResponse: Codable, Hashable, Sendable {
    public let accessToken: String
    public let refreshToken: String?
    public let idToken: String?

    public init(accessToken: String, refreshToken: String?, idToken: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
    }
}

public struct RefreshResponse: Codable, Hashable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let idToken: String?

    public init(accessToken: String, refreshToken: String, idToken: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
    }
}

public struct Organization: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let alias: String?
    public let name: String?

    public init(id: String, alias: String? = nil, name: String? = nil) {
        self.id = id
        self.alias = alias
        self.name = name
    }

    public var label: String {
        if let name, !name.isEmpty { return name }
        if let alias, !alias.isEmpty { return alias }
        return id
    }
}

/// Current identity and the one organization selected by the access token.
public struct MeResponse: Codable, Hashable, Sendable {
    public let user: AuthUser
    public let currentOrgId: String?
    public let permissions: [String]
    public let organization: Organization?
    public let accountConsoleUrl: String?
    public let adminConsoleUrl: String?
    /// Where this server's web dashboard is: absolute, or a path to resolve
    /// against the server's address. Absent when the server has none.
    public let dashboardUrl: String?
    /// The optional SaaS workstation block, kept raw so one parser owns both
    /// the shapes it arrives in (here and on the pods-list envelope). Absent
    /// under the self-hosted backend, which is the normal case today.
    public let workstation: JSONValue?
    /// The same block under the name older servers used. `podsPage` has always
    /// accepted both spellings; reading only one here meant the billing surface
    /// appeared after a pod list loaded and was missing on every `/me`-only
    /// path — a cold launch, or the settings screen.
    public let billing: JSONValue?

    public var billingSummary: BillingSummary? { BillingSummary.parse(workstation ?? billing) }

    /// `dashboardUrl` as an absolute URL, resolved against the server this
    /// response came from.
    public func dashboardURL(relativeTo server: URL) -> URL? {
        dashboardUrl.flatMap { URL(string: $0, relativeTo: server)?.absoluteURL }
    }

    public init(
        user: AuthUser,
        currentOrgId: String? = nil,
        permissions: [String] = [],
        organization: Organization? = nil,
        accountConsoleUrl: String? = nil,
        adminConsoleUrl: String? = nil,
        dashboardUrl: String? = nil,
        workstation: JSONValue? = nil,
        billing: JSONValue? = nil
    ) {
        self.user = user
        self.currentOrgId = currentOrgId
        self.permissions = permissions
        self.organization = organization
        self.accountConsoleUrl = accountConsoleUrl
        self.adminConsoleUrl = adminConsoleUrl
        self.dashboardUrl = dashboardUrl
        self.workstation = workstation
        self.billing = billing
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        user = try container.decode(AuthUser.self, forKey: .user)
        currentOrgId = try container.decodeIfPresent(String.self, forKey: .currentOrgId)
        permissions = try container.decodeIfPresent([String].self, forKey: .permissions) ?? []
        organization = try container.decodeIfPresent(Organization.self, forKey: .organization)
        accountConsoleUrl = try container.decodeIfPresent(String.self, forKey: .accountConsoleUrl)
        adminConsoleUrl = try container.decodeIfPresent(String.self, forKey: .adminConsoleUrl)
        dashboardUrl = try container.decodeIfPresent(String.self, forKey: .dashboardUrl)
        workstation = try container.decodeIfPresent(JSONValue.self, forKey: .workstation)
        billing = try container.decodeIfPresent(JSONValue.self, forKey: .billing)
    }
}
