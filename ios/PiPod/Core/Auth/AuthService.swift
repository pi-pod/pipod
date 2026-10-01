import AuthenticationServices
import Foundation
import UIKit

/// Boundary for browser OIDC authorization and RP-initiated logout.
public protocol AuthService: AnyObject, Sendable {
    func signIn(callback: URL?, organizationAlias: String?) async throws -> AuthResponse
    func signOut(refreshToken: String?, idToken: String?) async
}

extension AuthService {
    public func signIn() async throws -> AuthResponse {
        try await signIn(callback: nil, organizationAlias: nil)
    }
}

/// Browser-based OIDC authorization-code flow with PKCE and nonce binding.
///
/// The authorization itself runs in `ASWebAuthenticationSession`, which keeps the
/// credential entry out of this process and hands back the `pipod://auth/callback`
/// redirect directly. A callback that instead arrives as a cold-start deep link —
/// the person finished sign-in after the app was killed — is accepted through
/// `signIn(callback:)`, so both routes complete the same exchange.
public final class ZitadelAuthService: NSObject, AuthService, @unchecked Sendable {
    /// The in-flight PKCE verifier, state and nonce, persisted so a cold start can
    /// still finish the exchange.
    public static let authorizationProofKey = "oidc.authorization_proof"

    private let oidc: OIDCClient
    private let storage: SessionTokenStorage
    private let redirectURI: String
    private let postLogoutRedirectURI: String
    private let openURL: @MainActor (URL) async -> Bool
    private let presentation: WebAuthenticationPresenting

    public init(
        oidc: OIDCClient,
        storage: SessionTokenStorage,
        redirectURI: String = Config.oidcRedirectURI,
        postLogoutRedirectURI: String = Config.postLogoutRedirectURI,
        presentation: WebAuthenticationPresenting = WebAuthenticationSession(),
        openURL: (@MainActor (URL) async -> Bool)? = nil
    ) {
        self.oidc = oidc
        self.storage = storage
        self.redirectURI = redirectURI
        self.postLogoutRedirectURI = postLogoutRedirectURI
        self.presentation = presentation
        self.openURL = openURL ?? { url in
            await UIApplication.shared.open(url, options: [:])
        }
    }

    public var isConfigured: Bool {
        !oidc.clientID.isEmpty && !oidc.issuer.isEmpty
    }

    // MARK: - Sign in

    public func signIn(callback: URL? = nil, organizationAlias: String? = nil) async throws -> AuthResponse {
        // A callback handed in by the deep-link router is an authorization that
        // already happened; finish it rather than starting a second one.
        if let callback, Self.isAuthorizationResult(callback) {
            return try await complete(callback: callback)
        }

        guard isConfigured else {
            throw APIError(
                error: """
                    Sign-in is not configured. Set OIDC_ISSUER and the mobile OIDC client id.
                    """
            )
        }

        let scopes = try Config.requestedOidcScopes(organizationAlias: organizationAlias)
        let pkce = PKCEPair.generate()
        let state = Random.urlSafeString(byteCount: 24)
        let nonce = Random.urlSafeString(byteCount: 32)
        await storage.write(
            Self.authorizationProofKey,
            value: AuthorizationProof(verifier: pkce.verifier, state: state, nonce: nonce).encoded()
        )

        let authorize = try await oidc.authorizationURL(
            redirectURI: redirectURI, pkce: pkce, state: state, nonce: nonce, scopes: scopes
        )
        let redirect = try await presentation.authenticate(
            url: authorize, callbackScheme: Config.callbackScheme
        )
        return try await complete(
            callback: redirect, verifier: pkce.verifier, state: state, nonce: nonce
        )
    }

    /// Finishes an authorization whose redirect has already been received.
    public func complete(
        callback: URL, verifier: String? = nil, state: String? = nil, nonce: String? = nil
    ) async throws -> AuthResponse {
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func parameter(_ name: String) -> String? {
            query.first { $0.name == name }?.value
        }

        guard let code = parameter("code"), !code.isEmpty else {
            await storage.delete(Self.authorizationProofKey)
            if let error = parameter("error") {
                throw AuthorizationRejected(
                    code: error, detail: parameter("error_description")
                )
            }
            throw APIError(error: "authorization code missing from callback")
        }

        var proof = verifier
        var expectedState = state
        var expectedNonce = nonce
        if proof?.isEmpty != false || expectedNonce == nil {
            let stored = AuthorizationProof.decode(await storage.read(Self.authorizationProofKey))
            if let stored {
                proof = proof ?? stored.verifier
                expectedState = expectedState ?? stored.state
                expectedNonce = expectedNonce ?? stored.nonce
            }
        }
        guard let proof, !proof.isEmpty else {
            throw APIError(error: "PKCE verifier missing; start sign-in again.")
        }
        guard let expectedNonce, !expectedNonce.isEmpty else {
            throw APIError(error: "OIDC nonce missing; start sign-in again.")
        }
        let returnedState = parameter("state") ?? ""
        guard let expectedState, !expectedState.isEmpty, returnedState == expectedState else {
            throw APIError(error: "the sign-in redirect did not match this login attempt")
        }

        // Callback proof is single-use. Clear it before the network exchange so a
        // failed or replayed code cannot reuse verifier/state/nonce material.
        await storage.delete(Self.authorizationProofKey)
        return try await oidc.exchangeCode(
            code: code,
            codeVerifier: proof,
            redirectURI: redirectURI,
            expectedNonce: expectedNonce,
            // The native client's registration promises the offline grant.
            requireRefreshToken: true
        )
    }

    // MARK: - Sign out

    public func signOut(refreshToken: String?, idToken: String?) async {
        let logout = try? await oidc.logoutURL(
            refreshToken: refreshToken,
            idToken: idToken,
            postLogoutRedirectURI: postLogoutRedirectURI
        )
        guard let logout else { return }
        // The end-session page is a real browser navigation, not an authorization:
        // opening it in Safari is what actually clears the provider's cookie.
        _ = await openURL(logout)
    }

    /// Whether a URL carries an authorization result rather than being a bare
    /// `pipod://auth/callback` with nothing on it.
    public static func isAuthorizationResult(_ url: URL) -> Bool {
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let code = query.first { $0.name == "code" }?.value
        let error = query.first { $0.name == "error" }?.value
        return !(code ?? "").isEmpty || !(error ?? "").isEmpty
    }
}

/// The provider refused the authorization request and named an OAuth error code.
///
/// Kept structured rather than flattened into a sentence at the throw site: the
/// codes are a fixed vocabulary, and only the copy layer knows which of them are
/// worth alarming a person about.
public struct AuthorizationRejected: Error, Hashable, Sendable {
    public let code: String
    public let detail: String?

    public init(code: String, detail: String? = nil) {
        self.code = code
        self.detail = detail
    }
}

// MARK: - Authorization proof

struct AuthorizationProof: Codable {
    let verifier: String
    let state: String
    let nonce: String

    func encoded() -> String {
        guard let data = try? JSONEncoder().encode(self),
              let text = String(data: data, encoding: .utf8)
        else { return "" }
        return text
    }

    static func decode(_ encoded: String?) -> AuthorizationProof? {
        guard let encoded, !encoded.isEmpty, let data = encoded.data(using: .utf8),
              let proof = try? JSONDecoder().decode(AuthorizationProof.self, from: data),
              !proof.verifier.isEmpty, !proof.state.isEmpty, !proof.nonce.isEmpty
        else { return nil }
        return proof
    }
}

// MARK: - Browser presentation

/// The browser hand-off, behind a protocol so sign-in can be tested without one.
public protocol WebAuthenticationPresenting: Sendable {
    func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

public final class WebAuthenticationSession: NSObject, WebAuthenticationPresenting,
                                             ASWebAuthenticationPresentationContextProviding,
                                             @unchecked Sendable {
    /// The authorization in flight.
    ///
    /// `ASWebAuthenticationSession` is not retained by the system while it runs.
    /// Held only by a local `let`, the object is free to be deallocated as soon
    /// as `start()` returns — which takes the browser sheet down with it and
    /// leaves the continuation waiting for a callback that can never come. A
    /// stored reference, released when the completion handler fires, is what
    /// keeps the sheet alive.
    @MainActor private var active: ASWebAuthenticationSession?

    public override init() { super.init() }

    public func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            Task { @MainActor in
                let session = ASWebAuthenticationSession(
                    url: url, callbackURLScheme: callbackScheme
                ) { [weak self] callback, error in
                    // The sheet is gone; let go of it so a retry starts a fresh
                    // one. Hopped rather than assumed: this handler's isolation
                    // is the system's business, not ours.
                    Task { @MainActor in self?.active = nil }
                    if let callback {
                        continuation.resume(returning: callback)
                    } else if let error = error as? ASWebAuthenticationSessionError,
                              error.code == .canceledLogin {
                        continuation.resume(
                            throwing: APIError(error: "Sign-in was cancelled.")
                        )
                    } else {
                        continuation.resume(
                            throwing: error ?? APIError(error: "Could not open the sign-in page.")
                        )
                    }
                }
                session.presentationContextProvider = self
                // The provider's cookie is kept on purpose. Which tenant an
                // authorization lands in is pinned by the
                // `urn:zitadel:iam:org:domain:primary:<alias>` scope this
                // request carries (`Config.requestedOidcScopes`), not by the
                // session cookie — so "switch organization" is correct either
                // way, and an ephemeral session would only cost a full
                // credential re-entry, MFA included, on every single sign-in.
                session.prefersEphemeralWebBrowserSession = false
                self.active = session
                if !session.start() {
                    self.active = nil
                    continuation.resume(
                        throwing: APIError(error: "Could not open the sign-in page.")
                    )
                }
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
        let window = scenes
            .first { $0.activationState == .foregroundActive }?
            .keyWindow ?? scenes.first?.keyWindow
        return window ?? ASPresentationAnchor()
    }
}
