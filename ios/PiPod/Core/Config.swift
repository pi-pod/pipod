import Foundation

/// Build-time application configuration.
///
/// Values are compiled into `Info.plist` from `project.yml` (per configuration),
/// which is the native equivalent of the Flutter build's `--dart-define`.
///
/// Debug builds additionally accept launch arguments, which is the workspace's
/// shared dev contract across both native clients:
///
///     xcrun simctl launch <udid> com.pipod.app \
///       -PIPOD_SERVER_URL http://127.0.0.1:18081 -PIPOD_DEV_TOKEN <jwt>
///
/// `-Key value` pairs land in `UserDefaults`' argument domain, so they are read
/// back by name. A Release build never consults them: nothing outside the app may choose
/// its server, and a dev token must never bypass sign-in. The person using it chooses the
/// server on the sign-in screen instead (`serverChoice`).
public enum Config {
    /// Launch-argument / defaults keys, DEBUG only.
    public enum DevOverride {
        public static let serverURL = "PIPOD_SERVER_URL"
        public static let devToken = "PIPOD_DEV_TOKEN"
        public static let oidcIssuer = "PIPOD_OIDC_ISSUER"
        public static let oidcClientID = "PIPOD_OIDC_MOBILE_CLIENT_ID"
    }

    /// Base URL of the pi pod server, without a trailing slash.
    public static var serverURL: URL {
        // Debug-only: a stale override otherwise survives into a Release install of
        // the same bundle id and silently points the app at an unreachable dev host.
        #if DEBUG
        if let override = devOverride(DevOverride.serverURL),
           let url = normalizedURL(override) {
            return url
        }
        #endif
        if let choice = serverChoice { return choice.serverURL }
        return builtInServerURL
    }

    /// The server this build signs in to unless the user picks another one.
    public static var builtInServerURL: URL {
        // The fallback is production, not localhost. It is only reached when the
        // Info.plist key is missing, and a shipped build that quietly pointed at a
        // loopback address would fail every request with nothing to explain it.
        // Debug builds name their local server explicitly in `project.yml`.
        return normalizedURL(infoString("SERVER_URL")) ?? Self.productionServerURL
    }

    static let productionServerURL = URL(string: "https://api.pipod.dev")!

    /// Exact Zitadel instance issuer. Provider metadata is loaded with discovery
    /// and rejected unless its `issuer` is exactly this value.
    public static var oidcIssuer: String {
        #if DEBUG
        if let override = devOverride(DevOverride.oidcIssuer) { return override }
        #endif
        if let choice = serverChoice { return choice.issuer }
        return builtInOidcIssuer
    }

    static var builtInOidcIssuer: String {
        let value = infoString("OIDC_ISSUER")
        return value.isEmpty ? "https://auth.pipod.dev" : value
    }

    /// The mobile public client registered with Zitadel. Each platform has its own.
    public static var oidcClientID: String {
        #if DEBUG
        if let override = devOverride(DevOverride.oidcClientID) { return override }
        #endif
        if let choice = serverChoice { return choice.clientID }
        return builtInOidcClientID
    }

    static var builtInOidcClientID: String {
        let value = infoString("OIDC_CLIENT_ID")
        return value.isEmpty ? "388199923079774215" : value
    }

    /// A server the user picked on the sign-in screen instead of the built-in one — their own
    /// self-hosted pi pod — with the identity provider and client id it publishes. Kept across
    /// launches; nil means the built-in server. Only the signed-out screen changes it, so tokens
    /// never cross from one server to another.
    public struct ServerChoice: Codable, Equatable, Sendable {
        public let serverURL: URL
        public let issuer: String
        public let clientID: String

        public init(serverURL: URL, issuer: String, clientID: String) {
            self.serverURL = serverURL
            self.issuer = issuer
            self.clientID = clientID
        }
    }

    private static let serverChoiceKey = "pipod.serverChoice"

    public static var serverChoice: ServerChoice? {
        get {
            UserDefaults.standard.data(forKey: serverChoiceKey)
                .flatMap { try? JSONDecoder().decode(ServerChoice.self, from: $0) }
        }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) {
                UserDefaults.standard.set(data, forKey: serverChoiceKey)
            } else {
                UserDefaults.standard.removeObject(forKey: serverChoiceKey)
            }
        }
    }

    /// Exact redirect registered on the mobile OIDC client.
    public static var oidcRedirectURI: String {
        let value = infoString("OIDC_REDIRECT_URI")
        return value.isEmpty ? "\(callbackScheme)://auth/callback" : value
    }

    /// Zitadel ends the browser session back at the same registered redirect.
    public static var postLogoutRedirectURI: String { oidcRedirectURI }

    public static let callbackScheme = "pipod"
    public static let callbackPath = "/auth/callback"

    /// Scopes every mobile authorization requests. `offline_access` is what makes
    /// the refresh-token grant available to this native client.
    public static let oidcScopes: [String] = [
        "openid",
        "profile",
        "email",
        "offline_access",
        "urn:zitadel:iam:user:resourceowner",
        "urn:zitadel:iam:org:projects:roles",
    ]

    /// Optional development access token, which signs in without the browser.
    /// Only honoured in Debug builds — never a Release sign-in bypass.
    public static var devToken: String {
        #if DEBUG
        return devOverride(DevOverride.devToken) ?? ""
        #else
        return ""
        #endif
    }

    #if DEBUG
    /// Reads a launch argument (`-KEY value`) or a persisted default of the same
    /// name. Empty reads as absent so `-PIPOD_DEV_TOKEN ""` does not sign anyone in.
    private static func devOverride(_ key: String) -> String? {
        let value = UserDefaults.standard.string(forKey: key)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value, !value.isEmpty else { return nil }
        return value
    }
    #endif

    /// A single organization alias, as Zitadel's org-scope suffix accepts it.
    private static let organizationAlias = try! NSRegularExpression(
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
    )

    /// Adds Zitadel's primary-domain scope when an organization is being selected.
    /// An alias that is not a single validated label is refused rather than sent:
    /// scope values are space separated, so an unchecked alias could inject scopes.
    public static func requestedOidcScopes(organizationAlias alias: String?) throws -> [String] {
        guard let alias, !alias.isEmpty else { return oidcScopes }
        let range = NSRange(alias.startIndex..<alias.endIndex, in: alias)
        guard organizationAlias.firstMatch(in: alias, range: range) != nil else {
            throw ConfigError.invalidOrganizationAlias(alias)
        }
        return oidcScopes + ["urn:zitadel:iam:org:domain:primary:\(alias)"]
    }

    public enum ConfigError: LocalizedError {
        case invalidOrganizationAlias(String)

        public var errorDescription: String? {
            switch self {
            case .invalidOrganizationAlias(let alias):
                return """
                    “\(alias)” is not a valid organization alias. Use one alias containing \
                    only letters, digits, dot, underscore, or hyphen.
                    """
            }
        }
    }

    private static func infoString(_ key: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func normalizedURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.hasPrefix("http") ? trimmed : "http://\(trimmed)"
        // A trailing slash would double up against the "/v1/..." paths below it.
        let withoutTrailingSlash = withScheme.replacingOccurrences(
            of: "/+$", with: "", options: .regularExpression
        )
        return URL(string: withoutTrailingSlash)
    }
}
