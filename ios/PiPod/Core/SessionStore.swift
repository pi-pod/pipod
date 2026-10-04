import Foundation
import Observation

/// Signed-in state for the whole app: who you are, which organization the token
/// selected, and the two counts the tab bar badges.
///
/// Every transition that touches credentials lives here, so the API client, the
/// keychain and the UI cannot disagree about whether there is a session.
@MainActor
@Observable
public final class SessionStore {
    public static let accessKey = SessionTokenKeys.access
    public static let refreshKey = SessionTokenKeys.refresh
    public static let idTokenKey = SessionTokenKeys.id

    public private(set) var user: AuthUser?
    public private(set) var organization: Organization?
    public private(set) var currentOrgId: String?
    public private(set) var permissions: [String] = []

    /// Where the identity provider lets an administrator manage the organization.
    /// Nil when the signed-in person may not open it.
    public private(set) var adminConsoleUrl: String?
    public private(set) var accountConsoleUrl: String?

    /// Where settings and environments are changed: the server's web dashboard.
    /// Nil when the server has none.
    public private(set) var dashboardURL: URL?

    /// The SaaS billing summary, when the server sends one. Nil under the
    /// self-hosted backend, and then nothing about billing appears anywhere.
    public private(set) var billing: BillingSummary?

    public private(set) var isRestoringSession = true
    public private(set) var authNotice: String?

    /// A destination a notification or `pipod://` URL asked for while signed out
    /// or mid-restore. The router consumes it once sign-in completes.
    public var pendingDeepLink: DeepLinkDestination?

    /// Runs whenever the signed-in session is replaced or destroyed — sign-out,
    /// an expiry, or an organization switch. Everything scoped to the old
    /// session (navigation, the pod on screen) is dropped here.
    @ObservationIgnored public var onSessionReset: (() -> Void)?

    /// Receives an isolated, access-only client for best-effort device
    /// unregistration after the shared credentials have been cleared.
    @ObservationIgnored public var onSignOut: ((APIClient) async -> Void)?

    public let api: APIClient
    private let authenticator: AuthService?
    /// `(count, announce)`. `announce` is false when the change was raised by a
    /// session this app is already rendering: the icon badge still moves, but a
    /// banner over the card the reader is looking at would repeat it.
    private let retryDelay: (Int) -> TimeInterval
    @ObservationIgnored private let credentialPersistenceLane: CredentialPersistenceLane
    @ObservationIgnored private let credentialPersistenceReady: Task<Void, Never>

    private var authOperationID: UUID?
    private var restoreOperationID: UUID?
    private var identityGeneration: UUID?
    private var pendingSessionExpiry: TokenVersion?
    private var attemptedDevToken = false

    /// How many extra attempts a transient restore failure is worth before the
    /// screen asks the person to wait. Bounded: a device with no network must
    /// not spin on the identity provider forever.
    public static let restoreRetryAttempts = 2

    public init(
        api: APIClient,
        storage: SessionTokenStorage,
        authenticator: AuthService?,
        retryDelay: ((Int) -> TimeInterval)? = nil
    ) {
        self.api = api
        self.authenticator = authenticator
        self.retryDelay = retryDelay ?? { attempt in attempt <= 1 ? 1 : 4 }
        let credentialPersistenceLane = CredentialPersistenceLane(storage: storage, tokens: api.tokens)
        self.credentialPersistenceLane = credentialPersistenceLane
        self.credentialPersistenceReady = Task {
            await api.tokens.setTokensUpdatedHandler { snapshot in
                credentialPersistenceLane.submit(snapshot)
            }
        }
        api.onSessionExpired = { [weak self] version in
            Task { @MainActor [weak self] in
                await self?.handleUnauthorized(version: version)
            }
        }
    }

    public var isSignedIn: Bool { user != nil && identityGeneration != nil }

    /// The credential generation validated by `/me`, or nil while an account
    /// transition has cleared the old identity but not validated the new one.
    public var validatedAuthGeneration: UUID? { identityGeneration }

    public func can(_ permission: String) -> Bool { permissions.contains(permission) }

    /// The whole launch sequence: restore a stored session, and failing that, use
    /// a Debug build's dev token. The operation identity survives every await so
    /// sign-out or a replacement sign-in can invalidate this startup.
    public func startup() async {
        guard let operationID = beginAuthenticationOperation() else { return }
        restoreOperationID = operationID
        isRestoringSession = true
        defer { finishAuthenticationOperation(operationID) }
        await credentialPersistenceReady.value
        guard authOperationID == operationID else { return }

        await performRestore(
            ownerID: operationID, expectedVersion: nil, showExpiryNotice: false
        )
        guard authOperationID == operationID, user == nil else { return }
        let token = Config.devToken
        guard !token.isEmpty, !attemptedDevToken else { return }
        attemptedDevToken = true
        let current = await api.tokens.snapshot()
        guard authOperationID == operationID else { return }
        do {
            try await installAuthorization(
                AuthResponse(accessToken: token, refreshToken: nil),
                ownerID: operationID,
                expectedGeneration: current.version.generation
            )
        } catch {
            guard authOperationID == operationID else { return }
            authNotice = "Dev token sign-in failed: \(FriendlyError.message(error))"
        }
    }

    // MARK: - Restoration

    /// Rehydrates one credential generation. A transient failure is retried with
    /// a bounded backoff; replacement/sign-out invalidates the owner token first.
    public func restore(showExpiryNotice: Bool = true) async {
        guard let operationID = beginAuthenticationOperation() else { return }
        restoreOperationID = operationID
        isRestoringSession = true
        defer { finishAuthenticationOperation(operationID) }
        await credentialPersistenceReady.value
        guard authOperationID == operationID else { return }
        await performRestore(
            ownerID: operationID, expectedVersion: nil, showExpiryNotice: showExpiryNotice
        )
    }

    private func handleUnauthorized(version: TokenVersion) async {
        if let currentOperation = authOperationID {
            // Restore/authorization validation owns its own terminal 401. A
            // browser transition does not, so preserve expiry until it settles.
            if restoreOperationID != currentOperation { pendingSessionExpiry = version }
            return
        }
        guard let operationID = beginAuthenticationOperation() else {
            pendingSessionExpiry = version
            return
        }
        restoreOperationID = operationID
        isRestoringSession = true
        defer { finishAuthenticationOperation(operationID) }
        await credentialPersistenceReady.value
        guard authOperationID == operationID,
              await api.tokens.matches(version)
        else { return }
        await performRestore(
            ownerID: operationID, expectedVersion: version, showExpiryNotice: true
        )
    }

    private func beginAuthenticationOperation() -> UUID? {
        guard authOperationID == nil else { return nil }
        let operationID = UUID()
        authOperationID = operationID
        return operationID
    }

    private func finishAuthenticationOperation(_ operationID: UUID) {
        guard authOperationID == operationID else { return }
        authOperationID = nil
        if restoreOperationID == operationID {
            restoreOperationID = nil
            isRestoringSession = false
        }
        guard let expired = pendingSessionExpiry else { return }
        pendingSessionExpiry = nil
        Task { @MainActor [weak self] in
            await self?.handleUnauthorized(version: expired)
        }
    }

    /// What one restore attempt established. `.settled` is an answer — signed
    /// in, signed out, or expired; only `.transient` is worth trying again.
    private enum RestoreOutcome {
        case settled
        case transient
    }

    private func performRestore(
        ownerID: UUID, expectedVersion: TokenVersion?, showExpiryNotice: Bool
    ) async {
        var attempt = 0
        var requiredVersion = expectedVersion
        while authOperationID == ownerID {
            let outcome = await attemptRestore(
                ownerID: ownerID,
                expectedVersion: requiredVersion,
                showExpiryNotice: showExpiryNotice
            )
            requiredVersion = nil
            guard authOperationID == ownerID,
                  outcome == .transient,
                  user == nil,
                  attempt < Self.restoreRetryAttempts
            else { return }
            attempt += 1
            let delay = retryDelay(attempt)
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
            if Task.isCancelled || authOperationID != ownerID { return }
        }
    }

    private func attemptRestore(
        ownerID: UUID, expectedVersion: TokenVersion?, showExpiryNotice: Bool
    ) async -> RestoreOutcome {
        guard authOperationID == ownerID else { return .settled }
        var snapshot = await api.tokens.snapshot()
        guard authOperationID == ownerID else { return .settled }
        if let expectedVersion, snapshot.version != expectedVersion { return .settled }

        // A process-start token in APIClient (for example a debug token) is not
        // a restored identity. The ordered persisted tuple wins until `/me`
        // validates it; otherwise clear the constructor token before fallback.
        if identityGeneration == nil, expectedVersion == nil {
            let persisted = await credentialPersistenceLane.read()
            guard authOperationID == ownerID else { return .settled }
            let hasPersistedToken = !(persisted.accessToken ?? "").isEmpty
                || !(persisted.refreshToken ?? "").isEmpty
            if hasPersistedToken {
                guard let restored = await api.tokens.installPersisted(
                    accessToken: persisted.accessToken,
                    refreshToken: persisted.refreshToken,
                    idToken: persisted.idToken,
                    ifGeneration: snapshot.version.generation
                ) else { return .settled }
                snapshot = restored
            } else if !(snapshot.accessToken ?? "").isEmpty
                        || !(snapshot.refreshToken ?? "").isEmpty
                        || !(snapshot.idToken ?? "").isEmpty {
                guard let cleared = await api.tokens.clear(
                    ifGeneration: snapshot.version.generation
                ) else { return .settled }
                snapshot = cleared.current
                await credentialPersistenceLane.drain()
            }
        }

        if (snapshot.accessToken ?? "").isEmpty && (snapshot.refreshToken ?? "").isEmpty {
            if identityGeneration != nil {
                await clearSession(
                    ownerID: ownerID, expectedGeneration: snapshot.version.generation
                )
                if authOperationID == ownerID, showExpiryNotice {
                    authNotice = "Your session expired. Please sign in again."
                }
            }
            return .settled
        }

        if let refresh = snapshot.refreshToken, !refresh.isEmpty {
            do {
                snapshot = try await api.refreshSession(
                    expectedGeneration: snapshot.version.generation
                )
                await credentialPersistenceLane.drain()
                guard authOperationID == ownerID,
                      await api.tokens.matches(generation: snapshot.version.generation)
                else { return .settled }
            } catch is SessionExpiredError {
                await clearSession(
                    ownerID: ownerID, expectedGeneration: snapshot.version.generation
                )
                if authOperationID == ownerID, showExpiryNotice {
                    authNotice = "Your session expired. Please sign in again."
                }
                return .settled
            } catch is AuthContextChangedError {
                return .settled
            } catch {
                guard authOperationID == ownerID else { return .settled }
                if showExpiryNotice {
                    authNotice = "Could not reach the identity provider. Will retry."
                }
                return .transient
            }
        }

        guard !(snapshot.accessToken ?? "").isEmpty else { return .settled }
        do {
            try await loadMe(
                ownerID: ownerID, expectedGeneration: snapshot.version.generation
            )
            authNotice = nil
        } catch is SessionExpiredError {
            await clearSession(
                ownerID: ownerID, expectedGeneration: snapshot.version.generation
            )
            if authOperationID == ownerID, showExpiryNotice {
                authNotice = "Your session expired. Please sign in again."
            }
        } catch is AuthContextChangedError {
            return .settled
        } catch {
            guard authOperationID == ownerID else { return .settled }
            if showExpiryNotice {
                authNotice = "Could not reach the pi pod server. Will retry."
            }
            return .transient
        }
        return .settled
    }

    /// True when a restore left the person signed out holding credentials that
    /// never got a chance — the state a foreground is worth retrying from.
    public func needsRestoreRetry() async -> Bool {
        guard user == nil, authOperationID == nil else { return false }
        await credentialPersistenceReady.value
        let persisted = await credentialPersistenceLane.read()
        return !(persisted.refreshToken ?? "").isEmpty
    }

    // MARK: - Sign in / out

    public func signIn(callback: URL? = nil) async throws {
        authNotice = nil
        guard let authenticator else {
            throw APIError(error: "Sign-in is unavailable in this build.")
        }
        guard let operationID = beginAuthenticationOperation() else {
            throw APIError(error: "Another account change is already in progress.")
        }
        defer { finishAuthenticationOperation(operationID) }
        await credentialPersistenceReady.value
        let current = await api.tokens.snapshot()
        guard authOperationID == operationID else { throw AuthContextChangedError() }
        let response = try await authenticator.signIn(callback: callback, organizationAlias: nil)
        guard authOperationID == operationID else { throw AuthContextChangedError() }
        try await installAuthorization(
            response, ownerID: operationID,
            expectedGeneration: current.version.generation
        )
    }

    /// Re-authorizes against a named organization, which is how the access token
    /// changes tenant — the server accepts no tenant-selection header.
    public func setOrganizationAlias(_ organizationAlias: String) async throws {
        let alias = organizationAlias.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !alias.isEmpty else {
            throw APIError(error: "Organization alias is required to switch organization.")
        }
        guard let authenticator else {
            throw APIError(error: "Sign-in is unavailable in this build.")
        }
        guard let operationID = beginAuthenticationOperation() else {
            throw APIError(error: "Another account change is already in progress.")
        }
        defer { finishAuthenticationOperation(operationID) }
        await credentialPersistenceReady.value
        let current = await api.tokens.snapshot()
        guard authOperationID == operationID else { throw AuthContextChangedError() }

        // Keep the current account usable if the browser flow is cancelled. Once
        // B's authorization is accepted, installAuthorization clears A's UI
        // identity before any await and validates /me against B's generation.
        let response = try await authenticator.signIn(callback: nil, organizationAlias: alias)
        guard authOperationID == operationID else { throw AuthContextChangedError() }
        try await installAuthorization(
            response, ownerID: operationID,
            expectedGeneration: current.version.generation
        )
    }

    public func signInWithDevToken(_ token: String) async throws {
        authNotice = nil
        guard let operationID = beginAuthenticationOperation() else {
            throw APIError(error: "Another account change is already in progress.")
        }
        defer { finishAuthenticationOperation(operationID) }
        await credentialPersistenceReady.value
        let current = await api.tokens.snapshot()
        guard authOperationID == operationID else { throw AuthContextChangedError() }
        let sanitized = token.replacingOccurrences(
            of: "[^A-Za-z0-9_.-]", with: "", options: .regularExpression
        )
        try await installAuthorization(
            AuthResponse(accessToken: sanitized, refreshToken: nil),
            ownerID: operationID,
            expectedGeneration: current.version.generation
        )
    }

    private func installAuthorization(
        _ response: AuthResponse,
        ownerID: UUID,
        expectedGeneration: UUID
    ) async throws {
        guard authOperationID == ownerID else { throw AuthContextChangedError() }
        resetSessionState()
        restoreOperationID = ownerID
        isRestoringSession = true
        guard let installed = await api.tokens.replace(
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            idToken: response.idToken,
            ifGeneration: expectedGeneration
        ) else { throw AuthContextChangedError() }
        guard authOperationID == ownerID else { throw AuthContextChangedError() }
        await credentialPersistenceLane.drain()
        guard authOperationID == ownerID else { throw AuthContextChangedError() }
        do {
            try await loadMe(
                ownerID: ownerID,
                expectedGeneration: installed.version.generation
            )
            authNotice = nil
        } catch {
            if authOperationID == ownerID {
                await clearSession(
                    ownerID: ownerID,
                    expectedGeneration: installed.version.generation
                )
                if authOperationID == ownerID {
                    authNotice = FriendlyError.message(error)
                }
            }
            throw error
        }
    }

    public func signOut() async {
        let operationID = UUID()
        authOperationID = operationID
        pendingSessionExpiry = nil
        restoreOperationID = operationID
        isRestoringSession = true
        resetSessionState()
        authNotice = nil

        // Clear the shared authorization generation first. Device cleanup uses
        // an isolated access-only client made from the captured old credential.
        let cleared = await api.tokens.clear()
        await credentialPersistenceReady.value
        credentialPersistenceLane.submit(cleared.current)
        await credentialPersistenceLane.drain()
        let cleanupClient = api.cleanupClient(accessToken: cleared.previous.accessToken)
        await onSignOut?(cleanupClient)
        await authenticator?.signOut(
            refreshToken: cleared.previous.refreshToken,
            idToken: cleared.previous.idToken
        )
        finishAuthenticationOperation(operationID)
    }

    private func loadMe(ownerID: UUID, expectedGeneration: UUID) async throws {
        guard authOperationID == ownerID else { throw AuthContextChangedError() }
        let me = try await api.me(expectedGeneration: expectedGeneration)
        guard authOperationID == ownerID,
              await api.tokens.matches(generation: expectedGeneration),
              authOperationID == ownerID
        else { throw AuthContextChangedError() }
        user = me.user
        organization = me.organization
        currentOrgId = me.currentOrgId
        permissions = me.permissions
        adminConsoleUrl = me.adminConsoleUrl
        accountConsoleUrl = me.accountConsoleUrl
        dashboardURL = me.dashboardURL(relativeTo: api.baseURL)
        billing = me.billingSummary
        identityGeneration = expectedGeneration
    }

    private func clearSession(ownerID: UUID, expectedGeneration: UUID) async {
        guard authOperationID == ownerID else { return }
        resetSessionState()
        guard await api.tokens.clear(ifGeneration: expectedGeneration) != nil else { return }
        guard authOperationID == ownerID else { return }
        await credentialPersistenceLane.drain()
    }

    /// Resets account-owned UI state synchronously before credentials change.
    /// Launch operation records are intentionally retained by their own scope.
    private func resetSessionState() {
        SessionDraftStore.purgeAll()
        QueuedPromptAdmissionStore.purgeAll()
        user = nil
        organization = nil
        currentOrgId = nil
        permissions = []
        adminConsoleUrl = nil
        accountConsoleUrl = nil
        dashboardURL = nil
        billing = nil
        authNotice = nil
        identityGeneration = nil
        onSessionReset?()
    }

    /// Adopts a billing block from wherever it arrived. A response that carries
    /// none says nothing about billing — it must not erase what `/v1/me` sent —
    /// so only a real summary replaces the current one.
    public func applyBilling(_ summary: BillingSummary?) {
        guard let summary else { return }
        billing = summary
    }

    /// Explains, on the sign-in screen, why an authorization that came back
    /// through the deep link could not be completed.
    public func reportAuthorizationFailure(_ error: Error) {
        authNotice = FriendlyError.message(error)
    }
}
