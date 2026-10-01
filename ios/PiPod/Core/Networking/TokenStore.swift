import Foundation

/// The identity of one credential bundle. Refresh rotation advances the revision
/// without changing generation; sign-in, sign-out, and account replacement change
/// both so work from the previous authorization cannot cross the boundary.
public struct TokenVersion: Hashable, Sendable {
    public let generation: UUID
    public let revision: UInt64
}

/// An atomic view of the three credentials and the version they belong to.
public struct TokenSnapshot: Hashable, Sendable {
    public let version: TokenVersion
    public let accessToken: String?
    public let refreshToken: String?
    public let idToken: String?
}

public enum RefreshCommitResult: Sendable {
    case committed(TokenSnapshot)
    case superseded(TokenSnapshot)
    case sessionChanged(TokenSnapshot)
}

public struct TokenClearResult: Sendable {
    public let previous: TokenSnapshot
    public let current: TokenSnapshot
}

/// The tokens every authorized request needs, held in one place so the socket,
/// the REST client and the session state machine cannot drift apart.
///
/// An actor rather than a lock: refresh is asynchronous, while each version
/// check and credential replacement remains one non-suspending actor operation.
public actor TokenStore {
    public private(set) var accessToken: String?
    public private(set) var refreshToken: String?
    public private(set) var idToken: String?

    private var generation = UUID()
    private var revision: UInt64 = 0

    /// Notified synchronously from the accepted mutation so persistence can
    /// enqueue this complete version before a later mutation is observed.
    private var onTokensUpdated: (@Sendable (TokenSnapshot) -> Void)?

    public init(
        accessToken: String? = nil,
        refreshToken: String? = nil,
        idToken: String? = nil
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
    }

    public func snapshot() -> TokenSnapshot { makeSnapshot() }

    public func matches(_ version: TokenVersion) -> Bool {
        generation == version.generation && revision == version.revision
    }

    public func matches(generation expected: UUID) -> Bool {
        generation == expected
    }

    /// Installs a complete authorization bundle, optionally requiring that the
    /// session observed before an external sign-in is still the current one.
    @discardableResult
    public func replace(
        accessToken: String,
        refreshToken: String?,
        idToken: String?,
        ifGeneration expectedGeneration: UUID? = nil
    ) -> TokenSnapshot? {
        if let expectedGeneration, generation != expectedGeneration { return nil }
        generation = UUID()
        revision &+= 1
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
        let updated = makeSnapshot()
        onTokensUpdated?(updated)
        return updated
    }

    /// Restores a tuple read from ordered persistence. The tuple is already
    /// durable, so only the in-memory authorization generation changes.
    @discardableResult
    public func installPersisted(
        accessToken: String?,
        refreshToken: String?,
        idToken: String?,
        ifGeneration expectedGeneration: UUID
    ) -> TokenSnapshot? {
        guard generation == expectedGeneration else { return nil }
        generation = UUID()
        revision &+= 1
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
        return makeSnapshot()
    }

    /// Commits one refresh only if neither authorization replacement nor a
    /// different refresh has changed the observed token version.
    public func commitRefresh(
        _ response: RefreshResponse,
        ifVersion expected: TokenVersion
    ) -> RefreshCommitResult {
        guard generation == expected.generation else {
            return .sessionChanged(makeSnapshot())
        }
        guard revision == expected.revision else {
            return .superseded(makeSnapshot())
        }
        accessToken = response.accessToken
        refreshToken = response.refreshToken
        if let rotated = response.idToken, !rotated.isEmpty { idToken = rotated }
        revision &+= 1
        let updated = makeSnapshot()
        onTokensUpdated?(updated)
        return .committed(updated)
    }

    /// Clears credentials and returns the outgoing snapshot for authorized
    /// cleanup that must finish after local sign-out.
    @discardableResult
    public func clear() -> TokenClearResult {
        clearCredentials()
    }

    public func clear(ifGeneration expectedGeneration: UUID) -> TokenClearResult? {
        guard generation == expectedGeneration else { return nil }
        return clearCredentials()
    }

    public func setTokensUpdatedHandler(
        _ handler: (@Sendable (TokenSnapshot) -> Void)?
    ) {
        onTokensUpdated = handler
    }

    private func clearCredentials() -> TokenClearResult {
        let previous = makeSnapshot()
        generation = UUID()
        revision &+= 1
        accessToken = nil
        refreshToken = nil
        idToken = nil
        let current = makeSnapshot()
        onTokensUpdated?(current)
        return TokenClearResult(previous: previous, current: current)
    }

    private func makeSnapshot() -> TokenSnapshot {
        TokenSnapshot(
            version: TokenVersion(generation: generation, revision: revision),
            accessToken: accessToken,
            refreshToken: refreshToken,
            idToken: idToken
        )
    }
}
