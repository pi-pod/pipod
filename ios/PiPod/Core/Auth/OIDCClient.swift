import Foundation

/// Runtime OIDC provider metadata. Endpoints come only from discovery.
public struct OIDCMetadata: Sendable {
    public let issuer: String
    public let authorizationEndpoint: URL
    public let tokenEndpoint: URL
    public let jwksURI: URL
    public let endSessionEndpoint: URL?
    public let revocationEndpoint: URL?
}

/// Direct public-client OIDC.
///
/// Discovery is the endpoint contract: configured issuer and discovered issuer
/// must match byte for byte, and every endpoint must be HTTPS (loopback HTTP is
/// allowed so a local Zitadel can be developed against).
public actor OIDCClient: TokenRefreshing {
    public let issuer: String
    public let clientID: String

    private let transport: HTTPTransport
    private let now: @Sendable () -> Date

    private var metadataTask: Task<OIDCMetadata, Error>?
    private var keysTask: Task<[JSONWebKey], Error>?

    public init(
        clientID: String,
        issuer: String = Config.oidcIssuer,
        transport: HTTPTransport = URLSessionTransport(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.clientID = clientID
        self.issuer = issuer
        self.transport = transport
        self.now = now
    }

    public nonisolated var discoveryURL: URL? {
        guard let base = try? Self.providerURL(
            issuer, label: "OIDC issuer", allowsQuery: false
        ) else { return nil }
        let trimmed = base.absoluteString.replacingOccurrences(
            of: "/+$", with: "", options: .regularExpression
        )
        return URL(string: "\(trimmed)/.well-known/openid-configuration")
    }

    /// Discovery is fetched once per client and shared by every caller.
    public func discover() async throws -> OIDCMetadata {
        if let metadataTask { return try await metadataTask.value }
        let task = Task { try await loadMetadata() }
        metadataTask = task
        do {
            return try await task.value
        } catch {
            // A failed discovery must not be cached, or a transient provider
            // outage would keep the app signed out for its whole lifetime.
            if metadataTask == task { metadataTask = nil }
            throw error
        }
    }

    // MARK: - Authorization

    public func authorizationURL(
        redirectURI: String,
        pkce: PKCEPair,
        state: String,
        nonce: String,
        scopes: [String]
    ) async throws -> URL {
        let metadata = try await discover()
        guard var components = URLComponents(
            url: metadata.authorizationEndpoint, resolvingAgainstBaseURL: false
        ) else {
            throw APIError(error: "OIDC authorization endpoint is not a valid URL")
        }
        var items = components.queryItems ?? []
        items.append(contentsOf: [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: scopes.joined(separator: " ")),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
        ])
        components.queryItems = items
        guard let url = components.url else {
            throw APIError(error: "Could not build the sign-in URL")
        }
        return url
    }

    public func exchangeCode(
        code: String,
        codeVerifier: String,
        redirectURI: String,
        expectedNonce: String,
        requireRefreshToken: Bool = true
    ) async throws -> AuthResponse {
        let metadata = try await discover()
        let tokens = try await token(
            metadata.tokenEndpoint,
            body: [
                "grant_type": "authorization_code",
                "client_id": clientID,
                "code": code,
                "redirect_uri": redirectURI,
                "code_verifier": codeVerifier,
            ]
        )
        if requireRefreshToken, (tokens.refreshToken ?? "").isEmpty {
            throw APIError(error: "Identity provider returned no refresh token")
        }
        guard let idToken = tokens.idToken, !idToken.isEmpty else {
            throw APIError(error: "Identity provider returned no ID token")
        }
        do {
            try await verifyIDToken(idToken, metadata: metadata, expectedNonce: expectedNonce)
        } catch let error as InvalidIDTokenError {
            throw APIError(error: "Invalid ID token", detail: .string(error.message))
        }
        return AuthResponse(
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            idToken: idToken
        )
    }

    public func refresh(refreshToken: String) async throws -> RefreshResponse {
        let metadata = try await discover()
        let tokens = try await token(
            metadata.tokenEndpoint,
            body: [
                "grant_type": "refresh_token",
                "client_id": clientID,
                "refresh_token": refreshToken,
            ],
            isRefresh: true
        )
        if let idToken = tokens.idToken, !idToken.isEmpty {
            do {
                try await verifyIDToken(idToken, metadata: metadata, expectedNonce: nil)
            } catch let error as InvalidIDTokenError {
                throw SessionExpiredError(
                    message: "identity provider returned an invalid ID token: \(error.message)"
                )
            }
        }
        return RefreshResponse(
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? refreshToken,
            idToken: tokens.idToken
        )
    }

    /// Revokes the refresh token best-effort, then returns the provider's
    /// RP-initiated logout URL for the browser.
    public func logoutURL(
        refreshToken: String?, idToken: String?, postLogoutRedirectURI: String?
    ) async throws -> URL? {
        let metadata = try await discover()
        if let revocation = metadata.revocationEndpoint, let refreshToken, !refreshToken.isEmpty {
            // Revocation must never prevent local or browser sign-out.
            _ = try? await form(
                revocation,
                body: [
                    "client_id": clientID,
                    "token": refreshToken,
                    "token_type_hint": "refresh_token",
                ]
            )
        }
        guard let endpoint = metadata.endSessionEndpoint,
              var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        else { return nil }
        var items = components.queryItems ?? []
        items.append(URLQueryItem(name: "client_id", value: clientID))
        if let idToken, !idToken.isEmpty {
            items.append(URLQueryItem(name: "id_token_hint", value: idToken))
        }
        if let postLogoutRedirectURI, !postLogoutRedirectURI.isEmpty {
            items.append(
                URLQueryItem(name: "post_logout_redirect_uri", value: postLogoutRedirectURI)
            )
        }
        components.queryItems = items
        return components.url
    }

    // MARK: - Discovery

    private func loadMetadata() async throws -> OIDCMetadata {
        guard let discoveryURL else {
            throw APIError(error: "OIDC issuer must use HTTPS except for loopback HTTP")
        }
        let data = try await get(discoveryURL, failure: "identity provider discovery failed")
        guard let document = data.objectValue else {
            throw APIError(error: "Invalid OIDC discovery document")
        }
        guard let discoveredIssuer = document["issuer"]?.stringValue,
              discoveredIssuer == issuer else {
            throw APIError(
                error: "OIDC discovery issuer mismatch",
                detail: .string(
                    "expected \(issuer), received \(document["issuer"]?.displayText ?? "nothing")"
                )
            )
        }
        _ = try Self.providerURL(discoveredIssuer, label: "OIDC issuer", allowsQuery: false)
        return OIDCMetadata(
            issuer: discoveredIssuer,
            authorizationEndpoint: try Self.requiredEndpoint(document, "authorization_endpoint"),
            tokenEndpoint: try Self.requiredEndpoint(document, "token_endpoint"),
            jwksURI: try Self.requiredEndpoint(document, "jwks_uri"),
            endSessionEndpoint: try Self.optionalEndpoint(document, "end_session_endpoint"),
            revocationEndpoint: try Self.optionalEndpoint(document, "revocation_endpoint")
        )
    }

    private func signingKeys(_ metadata: OIDCMetadata, forceRefresh: Bool = false) async throws -> [JSONWebKey] {
        if forceRefresh { keysTask = nil }
        if let keysTask { return try await keysTask.value }
        let task = Task { try await loadKeys(metadata.jwksURI) }
        keysTask = task
        do {
            return try await task.value
        } catch {
            if keysTask == task { keysTask = nil }
            throw error
        }
    }

    private func loadKeys(_ url: URL) async throws -> [JSONWebKey] {
        let data = try await get(url, failure: "identity provider JWKS request failed")
        guard let keys = data["keys"]?.arrayValue else {
            throw TransientAuthError("identity provider returned an invalid JWKS document")
        }
        let usable = keys.compactMap { value -> JSONWebKey? in
            guard let object = value.objectValue else { return nil }
            return JSONWebKey(json: object)
        }
        if usable.isEmpty {
            throw TransientAuthError(
                "identity provider JWKS contains no usable RS256 signing key"
            )
        }
        return usable
    }

    // MARK: - Verification

    func verifyIDToken(
        _ idToken: String, metadata: OIDCMetadata, expectedNonce: String?
    ) async throws {
        let jws = try DecodedJWS(compactSerialization: idToken)
        guard jws.algorithm == "RS256" else {
            throw InvalidIDTokenError("signing algorithm must be RS256")
        }

        var keys = try await signingKeys(metadata)
        if !verified(jws, with: keys) {
            // A cached set may be stale during provider key rotation. Fetch once
            // more, but never accept a token that still fails verification.
            keys = try await signingKeys(metadata, forceRefresh: true)
            guard verified(jws, with: keys) else {
                throw InvalidIDTokenError("signature verification failed")
            }
        }
        try validateClaims(jws.claims, expectedNonce: expectedNonce)
    }

    private func verified(_ jws: DecodedJWS, with keys: [JSONWebKey]) -> Bool {
        // A `kid` narrows the search, but a provider that omits it is still
        // verifiable against every advertised key.
        let candidates = jws.keyID.map { id in
            keys.filter { $0.keyID == id || $0.keyID == nil }
        } ?? keys
        let searched = candidates.isEmpty ? keys : candidates
        return searched.contains { $0.verifies(jws) }
    }

    func validateClaims(_ claims: [String: JSONValue], expectedNonce: String?) throws {
        guard claims["iss"]?.stringValue == issuer else {
            throw InvalidIDTokenError("issuer does not exactly match configuration")
        }

        let audience = claims["aud"]
        let audienceMatches: Bool
        if let single = audience?.stringValue {
            audienceMatches = single == clientID
        } else if let list = audience?.arrayValue {
            let values = list.compactMap(\.stringValue)
            audienceMatches = values.count == list.count && values.contains(clientID)
        } else {
            audienceMatches = false
        }
        guard audienceMatches else {
            throw InvalidIDTokenError("audience does not contain the configured client ID")
        }

        // OIDC requires `azp` when the token has more than one audience, and
        // requires it to be the client that asked for the token. Without this a
        // token minted for a different client of the same provider — which
        // legitimately lists us among its audiences — would be accepted as ours.
        let authorizedParty = claims["azp"]
        let audienceCount = audience?.arrayValue?.count ?? 1
        if let authorizedParty, !authorizedParty.isNull {
            guard authorizedParty.stringValue == clientID else {
                throw InvalidIDTokenError("authorized party is not the configured client ID")
            }
        } else if audienceCount > 1 {
            throw InvalidIDTokenError(
                "authorized party is required when the token has multiple audiences"
            )
        }

        guard let subject = claims["sub"]?.stringValue, !subject.isEmpty else {
            throw InvalidIDTokenError("subject is missing")
        }

        let nowSeconds = now().timeIntervalSince1970
        guard let expiration = claims["exp"]?.doubleValue, expiration.isFinite else {
            throw InvalidIDTokenError("expiration is missing or invalid")
        }
        if nowSeconds >= expiration { throw InvalidIDTokenError("token is expired") }

        // `iat` is required by OIDC. It is not a second expiry check — the clock
        // skew allowance below is deliberately generous — but a token stamped far
        // in the future is not one this provider just issued.
        guard let issuedAt = claims["iat"]?.doubleValue, issuedAt.isFinite else {
            throw InvalidIDTokenError("issued-at is missing or invalid")
        }
        if issuedAt > nowSeconds + Self.clockSkewTolerance {
            throw InvalidIDTokenError("token is issued too far in the future")
        }

        if let notBefore = claims["nbf"], !notBefore.isNull {
            guard let value = notBefore.doubleValue, value.isFinite else {
                throw InvalidIDTokenError("not-before claim is invalid")
            }
            if nowSeconds < value { throw InvalidIDTokenError("token is not valid yet") }
        }

        if let expectedNonce {
            guard claims["nonce"]?.stringValue == expectedNonce else {
                throw InvalidIDTokenError("nonce does not match authorization request")
            }
        }
    }

    // MARK: - HTTP

    private struct TokenSet {
        let accessToken: String
        let refreshToken: String?
        let idToken: String?
    }

    private func token(
        _ endpoint: URL, body: [String: String], isRefresh: Bool = false
    ) async throws -> TokenSet {
        let (data, response) = try await form(endpoint, body: body)
        let document = (try? JSONCoding.value(from: data))?.objectValue ?? [:]

        guard (200..<300).contains(response.statusCode) else {
            let code = document["error"]?.stringValue
            if isRefresh, response.statusCode == 401 || code == "invalid_grant" {
                throw SessionExpiredError()
            }
            if response.statusCode >= 500 {
                throw TransientAuthError("identity provider token request failed")
            }
            let description = document["error_description"]?.stringValue ?? code
            throw APIError(error: description ?? "Identity provider token request failed")
        }

        guard let accessToken = document["access_token"]?.stringValue, !accessToken.isEmpty else {
            throw APIError(error: "Identity provider returned no access token")
        }
        return TokenSet(
            accessToken: accessToken,
            refreshToken: document["refresh_token"]?.stringValue,
            idToken: document["id_token"]?.stringValue
        )
    }

    @discardableResult
    private func form(
        _ url: URL, body: [String: String]
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(
            "application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type"
        )
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(FormURLEncoding.encode(body).utf8)
        return try await transport.send(request)
    }

    private func get(_ url: URL, failure: String) async throws -> JSONValue {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            // No response at all is a plain network failure; the copy layer knows
            // how to phrase those.
            throw error
        }
        guard (200..<300).contains(response.statusCode) else {
            throw TransientAuthError(failure)
        }
        guard let value = try? JSONCoding.value(from: data) else {
            throw TransientAuthError(failure)
        }
        return value
    }

    // MARK: - URL validation

    static func requiredEndpoint(_ document: [String: JSONValue], _ key: String) throws -> URL {
        guard let endpoint = try optionalEndpoint(document, key) else {
            throw APIError(error: "OIDC discovery document is missing \(key)")
        }
        return endpoint
    }

    static func optionalEndpoint(_ document: [String: JSONValue], _ key: String) throws -> URL? {
        guard let value = document[key], !value.isNull else { return nil }
        guard let text = value.stringValue else {
            throw APIError(error: "OIDC discovery document has invalid \(key)")
        }
        return try providerURL(text, label: key)
    }

    /// Tolerated clock skew when judging `iat`, in seconds.
    static let clockSkewTolerance: TimeInterval = 300

    /// Validates a URL the provider handed us, or that we were configured with.
    ///
    /// `allowsQuery` is false for the issuer, whose identity is compared byte for
    /// byte and which has no business carrying parameters. It stays true for the
    /// endpoints, where a provider may legitimately pin query parameters that the
    /// authorization request then merges with its own.
    static func providerURL(
        _ value: String, label: String, allowsQuery: Bool = true
    ) throws -> URL {
        func refuse(_ reason: String) -> APIError {
            APIError(error: "\(label) \(reason)")
        }
        guard let components = URLComponents(string: value),
              let host = components.host, !host.isEmpty,
              let scheme = components.scheme?.lowercased(),
              let url = components.url
        else {
            throw refuse("must use HTTPS except for loopback HTTP")
        }
        let loopback = ["localhost", "127.0.0.1", "::1"].contains(host.lowercased())
        guard scheme == "https" || (scheme == "http" && loopback) else {
            throw refuse("must use HTTPS except for loopback HTTP")
        }
        // `https://evil@issuer.example/` has authority `evil@issuer.example` but a
        // host of `issuer.example`, so a userinfo component turns an issuer
        // comparison into something a person reading the URL would not predict.
        guard components.user == nil, components.password == nil else {
            throw refuse("must not carry a username or password")
        }
        guard components.fragment == nil else {
            throw refuse("must not carry a fragment")
        }
        guard allowsQuery || components.query == nil else {
            throw refuse("must not carry a query")
        }
        return url
    }
}
