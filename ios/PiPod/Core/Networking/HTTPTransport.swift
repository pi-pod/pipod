import Foundation

/// The one HTTP round trip the client makes, behind a protocol so tests can
/// answer requests without a socket.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    public let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }
}

/// Refreshes an expired access token. Injected so `APIClient` does not depend on
/// the OIDC client, which in turn keeps both testable in isolation.
public protocol TokenRefreshing: Sendable {
    func refresh(refreshToken: String) async throws -> RefreshResponse
}

/// The refresh token is no longer valid and local credentials must be cleared.
public struct SessionExpiredError: Error, Hashable, Sendable {
    public let message: String
    public let authVersion: TokenVersion?

    public init(message: String = "session expired", authVersion: TokenVersion? = nil) {
        self.message = message
        self.authVersion = authVersion
    }
}

/// An authorized request was superseded by a different credential generation.
/// It must neither replay under the replacement account nor expire that account.
public struct AuthContextChangedError: Error, Hashable, Sendable {
    public init() {}
}

/// Discovery, JWKS, or token refresh could not complete because the provider is down.
public struct TransientAuthError: Error, Hashable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}
