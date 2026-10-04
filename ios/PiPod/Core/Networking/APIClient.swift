import Foundation

/// REST client for the pi pod `/v1` API.
///
/// Organization selection is carried only by the access token; no tenant
/// -selection header is sent or accepted. A 401 refreshes once, in single flight,
/// and replays the original request — so a token that expires mid-scroll costs a
/// retry rather than a sign-out.
public final class APIClient: @unchecked Sendable {
    /// Fixed at init, or else whichever server is configured now — so choosing another one on
    /// the sign-in screen needs no new client.
    public var baseURL: URL { fixedBaseURL ?? Config.serverURL }
    private let fixedBaseURL: URL?
    public let tokens: TokenStore

    private let transport: HTTPTransport
    private let refresher: TokenRefreshing
    private let refreshCoordinator = RefreshCoordinator()
    private let expiryHandler = Box<(@Sendable (TokenVersion) -> Void)?>(nil)

    public init(
        baseURL: URL? = nil,
        transport: HTTPTransport = URLSessionTransport(),
        tokens: TokenStore? = nil,
        refresher: TokenRefreshing? = nil
    ) {
        self.fixedBaseURL = baseURL
        self.transport = transport
        let devToken = Config.devToken
        self.tokens = tokens ?? TokenStore(accessToken: devToken.isEmpty ? nil : devToken)
        self.refresher = refresher ?? OIDCClient()
    }

    /// Called when the server has refused credentials that cannot be refreshed.
    public var onSessionExpired: (@Sendable (TokenVersion) -> Void)? {
        get { expiryHandler.value }
        set { expiryHandler.value = newValue }
    }

    /// Refreshes only the credential generation the caller observed. Concurrent
    /// REST requests use the same version-keyed flight and conditional commit.
    public func refreshSession(expectedGeneration: UUID) async throws -> TokenSnapshot {
        let observed = await tokens.snapshot()
        guard observed.version.generation == expectedGeneration else {
            throw AuthContextChangedError()
        }
        guard observed.refreshToken?.isEmpty == false else {
            throw SessionExpiredError(authVersion: observed.version)
        }
        do {
            return try await refreshCoordinator.refresh(
                observed: observed, tokens: tokens, refresher: refresher
            )
        } catch let error as SessionExpiredError {
            let current = await tokens.snapshot()
            guard current.version.generation == expectedGeneration else {
                throw AuthContextChangedError()
            }
            throw SessionExpiredError(message: error.message, authVersion: current.version)
        }
    }

    /// An isolated, access-only client for best-effort sign-out cleanup. It
    /// cannot refresh or persist credentials belonging to a later session.
    public func cleanupClient(accessToken: String?) -> APIClient {
        APIClient(
            baseURL: baseURL,
            transport: transport,
            tokens: TokenStore(accessToken: accessToken),
            refresher: refresher
        )
    }

    // MARK: - Identity

    public func me(expectedGeneration: UUID? = nil) async throws -> MeResponse {
        try await requestDecoded(
            MeResponse.self, "GET", "me", expectedGeneration: expectedGeneration
        )
    }

    public func billingAccount() async throws -> JSONValue {
        try await request("GET", "billing/account")
    }

    public func createCheckoutSession(plan: String, trial: Bool) async throws -> BillingURLSession {
        try await requestDecoded(
            BillingURLSession.self, "POST", "billing/checkout-session",
            body: .object(["plan": .string(plan), "trial": .bool(trial)])
        )
    }

    public func createPortalSession() async throws -> BillingURLSession {
        try await requestDecoded(BillingURLSession.self, "POST", "billing/portal-session", body: .object([:]))
    }

    // MARK: - Environments (templates)

    /// Every environment, not just the newest page of them.
    ///
    /// The route is cursor-paged exactly like `/pods` (`limit` up to 200,
    /// `before` on `created_at`) and defaults to 100. Reading one page made the
    /// 101st environment unreachable from the Environments list *and* from the
    /// launch picker, which then silently launched something else.
    public func templates() async throws -> DecodedList<PodTemplate> {
        try await pagedList(
            PodTemplate.self,
            path: "templates", key: "templates", resourceName: "environment",
            query: ["limit": "\(APIClient.listPageSize)"],
            id: \.id,
            cursor: { $0.createdAt }
        )
    }

    public func template(id: String) async throws -> PodTemplate {
        try await requestDecoded(PodTemplate.self, "GET", "templates/\(escaped(id))")
    }

    // MARK: - Pods

    /// Every pod the filter names, not just the newest page of them.
    ///
    /// The list route answers `limit` rows newest-first and takes `before` as the
    /// cursor; its default is 100. Reading one page made the pod list quietly
    /// stop at whatever the server chose, with no "load more" anywhere on the
    /// screen — an org's older pods simply did not exist to the app.
    public func pods(state: String? = nil, mine: Bool = false) async throws -> DecodedList<Pod> {
        try await podsPage(state: state, mine: mine).pods
    }

    /// The pods list plus whatever else rode the envelope. The workstation
    /// billing block is optional and SaaS-only: the self-hosted backend never
    /// sends it, and its absence is the normal case.
    ///
    /// Pages past the route's default window with `limit`/`before` (the route
    /// orders by `last_activity_at` falling back to `created_at`, so the cursor
    /// is that same value): one page would quietly stop at whatever the server
    /// chose. Rows de-duplicate by id and billing is read from the first page.
    public func podsPage(state: String? = nil, mine: Bool = false) async throws -> PodsPage {
        var query: [String: String] = ["limit": "\(APIClient.listPageSize)"]
        if let state { query["state"] = state }
        if mine { query["mine"] = "true" }
        var items: [Pod] = []
        var unparsed: [UnparsedRow] = []
        var seen: Set<String> = []
        var billing: BillingSummary?
        var billingRead = false
        var before: String?
        for _ in 0..<APIClient.listPageCap {
            var pageQuery = query
            if let before { pageQuery["before"] = before }
            let json: JSONValue
            do {
                json = try await request("GET", "pods", query: pageQuery)
            } catch {
                if items.isEmpty, unparsed.isEmpty { throw error }
                break
            }
            let page: DecodedList<Pod> = try decodeListRows(json: json, key: "pods", resourceName: "pod")
            if !billingRead {
                // The production envelope carries billing under `workstation`;
                // older servers used `billing`. Either shape parses the same.
                billing = BillingSummary.parse(json["workstation"] ?? json["billing"])
                billingRead = true
            }
            for row in page.items where seen.insert(row.id).inserted { items.append(row) }
            for row in page.unparsedRows {
                guard let rowID = row.rowID else {
                    unparsed.append(row)
                    continue
                }
                if seen.insert(rowID).inserted { unparsed.append(row) }
            }
            // A short page is the end of the list.
            guard page.items.count + page.unparsedRows.count >= APIClient.listPageSize,
                  let next = APIClient.nextCursor(
                    page.items.map { $0.lastActivityAt ?? $0.createdAt }
                  ),
                  next != before
            else { break }
            before = next
        }
        return PodsPage(pods: DecodedList(items: items, unparsedRows: unparsed), billing: billing)
    }

    public func pod(id: String) async throws -> Pod {
        try await requestDecoded(Pod.self, "GET", "pods/\(escaped(id))")
    }

    /// Launches a pod on the single sandbox backend. There is no provider choice:
    /// the server places every pod on the sandbox host.
    ///
    /// The body carries the environment and nothing else. `piSettings`, like
    /// `project`, `hostConfig` and `hostEnv`, is a retired launch input: the
    /// server accepts it, applies none of it, and attaches a legacy warning to
    /// the launch report for having been sent it — which put a report screen in
    /// front of every otherwise clean launch.
    public func launch(
        templateId: String? = nil,
        operationID: String? = nil,
        expectedGeneration: UUID
    ) async throws -> LaunchAttempt {
        var body: [String: JSONValue] = [:]
        if let templateId { body["templateId"] = .string(templateId) }
        if let operationID { body["operationId"] = .string(operationID) }
        let response = try await request(
            "POST", "pods", body: .object(body), expectedGeneration: expectedGeneration
        )
        if response["state"]?.stringValue == "pending" {
            return .pending
        }
        return .admitted(try JSONCoding.decode(LaunchResponse.self, from: response))
    }

    public func launchOperation(
        operationID: String, expectedGeneration: UUID
    ) async throws -> LaunchOperationSnapshot {
        try await requestDecoded(
            LaunchOperationSnapshot.self, "GET", "launch-operations/\(escaped(operationID))",
            expectedGeneration: expectedGeneration
        )
    }

    /// Queues a prompt over REST for a pod with no socket attached. `requestID`
    /// is generated once per logical turn. While the durable row is retained,
    /// reusing it returns the same admission instead of creating a duplicate.
    /// `model` ("provider/id") asks the pod to switch to it before running the prompt, when its
    /// pi offers it.
    public func queuePrompt(
        podId: String, text: String, requestID: String, model: String? = nil
    ) async throws -> QueuedPromptReceipt {
        var body: [String: JSONValue] = ["text": .string(text), "id": .string(requestID)]
        if let model { body["model"] = .string(model) }
        return try await requestDecoded(
            QueuedPromptReceipt.self, "POST", "pods/\(escaped(podId))/prompts", body: .object(body)
        )
    }

    public func queuedPrompt(
        podId: String, requestID: String
    ) async throws -> QueuedPromptReceipt? {
        do {
            return try await requestDecoded(
                QueuedPromptReceipt.self,
                "GET", "pods/\(escaped(podId))/prompts/\(escaped(requestID))"
            )
        } catch let error as APIError where error.transportStatus == 404 {
            return nil
        }
    }

    public func podCommand(id: String, command: String) async throws -> Pod {
        // `stop` releases compute now and keeps the row and the disk; `archive`
        // is the logical hide. They are different requests and both are offered.
        guard command == "archive" || command == "restore" || command == "stop" else {
            throw APIError(error: "Unsupported pod lifecycle action")
        }
        let result = try await request(
            "POST", "pods/\(escaped(id))/\(command)", body: .object([:])
        )
        guard let refreshedID = result["id"]?.stringValue else {
            throw APIError(error: "Unexpected pod lifecycle response", detail: result)
        }
        return try await pod(id: refreshedID)
    }

    /// Deletes a pod. A pod hosting live co-located children is refused with a
    /// 409 naming them; `cascade` retries the same delete over the whole
    /// subtree, deepest first.
    public func deletePod(id: String, cascade: Bool = false) async throws {
        _ = try await request(
            "DELETE", "pods/\(escaped(id))", query: cascade ? ["cascade": "true"] : [:]
        )
    }

    /// Cooperatively cancels a bounded capacity wait (capacity contract §1).
    ///
    /// Returns true when a wait was cancelled, false when there was nothing to
    /// cancel: the pod never queued (contract 404 — including older servers,
    /// where the route itself 404s), or the wait had already finished.
    ///
    /// A wait that is already terminal answers `{…waitView, cancelRequested:
    /// true}` with no `cancelled` key at all, which is the server saying the
    /// request was recorded against a wait that is over. That is not a failure
    /// and not a cancellation. Only the transport's real 404 and that shape read
    /// as false: any other status, even one whose prose mentions not-found, is a
    /// genuine failure, and a response with neither key is malformed and throws
    /// rather than defaulting.
    public func cancelCapacityWait(id: String) async throws -> Bool {
        do {
            let data = try await request("DELETE", "pods/\(escaped(id))/capacity-wait")
            if let cancelled = data["cancelled"]?.boolValue { return cancelled }
            if data["cancelRequested"]?.boolValue != nil { return false }
            throw APIError(error: "Unexpected capacity-wait cancel response", detail: data)
        } catch let error as APIError {
            if error.transportStatus == 404 { return false }
            throw error
        }
    }

    // MARK: - Personal workstation

    /// `GET /v1/workstations/:hostId` — the durable truth about the caller's own
    /// workstation, which answers immediately and never blocks on the vendor.
    ///
    /// The path is rebuilt from the validated id; a `statusHref` the server sent
    /// is never dialled. Nil for an id this client will not accept, for a server
    /// that does not have the route, and for a body naming a different
    /// workstation — all of which mean "no durable status", not "failed".
    public func workstationStatus(hostId: String) async throws -> WorkstationStatus? {
        try await workstationStatus(hostId: hostId, expectedGeneration: nil)
    }

    public func workstationStatus(
        hostId: String, expectedGeneration: UUID?
    ) async throws -> WorkstationStatus? {
        guard WorkstationDemandDetail.isValidHostId(hostId) else { return nil }
        do {
            let json = try await request(
                "GET", "workstations/\(escaped(hostId))",
                expectedGeneration: expectedGeneration
            )
            return WorkstationStatus.parse(json, requested: hostId)
        } catch let error as APIError {
            if error.transportStatus == 404 { return nil }
            throw error
        }
    }

    public func wsTicket(podId: String) async throws -> WsTicket {
        try await requestDecoded(
            WsTicket.self, "POST", "pods/\(escaped(podId))/ws-ticket", body: .object([:])
        )
    }

    /// Every session this pod has had, newest first.
    ///
    /// Rows are decoded the way every other list is: one row this build cannot
    /// read is dropped, not thrown, because throwing empties a screen that had
    /// an answer for every other row. The route pages on `started_at`.
    public func sessions(podId: String) async throws -> [AgentSession] {
        try await pagedList(
            AgentSession.self,
            path: "pods/\(escaped(podId))/sessions", key: "sessions", resourceName: "session",
            query: ["limit": "\(APIClient.listPageSize)"],
            id: \.id,
            cursor: { $0.startedAt }
        ).items
    }

    public func sessionEvents(
        sessionId: String, afterSeq: Int, limit: Int = 200
    ) async throws -> [SessionEventRecord] {
        let data = try await request(
            "GET", "sessions/\(escaped(sessionId))/events",
            query: ["after_seq": "\(afterSeq)", "limit": "\(limit)"]
        )
        return try JSONCoding.decode(SessionEventsPage.self, from: data).events
    }

    public func conversationEvents(
        podId: String, before: String? = nil, limit: Int = 200
    ) async throws -> ConversationEventsPage {
        var query = ["limit": "\(limit)"]
        if let before { query["before"] = before }
        let data = try await request(
            "GET", "pods/\(escaped(podId))/conversation/events", query: query
        )
        return try JSONCoding.decode(ConversationEventsPage.self, from: data)
    }

    // MARK: - Jobs

    /// Every job, not just the newest page.
    ///
    /// `/jobs` is the one list route with a proper keyset cursor — it takes
    /// `beforeId` beside `before` and compares `(created_at, id)` — so the walk
    /// sends both and never has to step back over a shared timestamp.
    public func jobs() async throws -> DecodedList<Job> {
        try await pagedList(
            Job.self,
            path: "jobs", key: "jobs", resourceName: "job",
            query: ["limit": "\(APIClient.listPageSize)"],
            id: \.id,
            cursor: { $0.createdAt },
            tieBreaker: { $0.id }
        )
    }

    public func job(id: String) async throws -> Job {
        try await requestDecoded(Job.self, "GET", "jobs/\(escaped(id))")
    }

    /// The run history for one job. This route has no cursor at all — only
    /// `limit`, defaulting to 50 — so the most it can do is ask for the
    /// server's maximum page instead of a third of it.
    public func jobRuns(id: String) async throws -> DecodedList<JobRun> {
        try decodeListRows(
            json: try await request(
                "GET", "jobs/\(escaped(id))/runs",
                query: ["limit": "\(APIClient.listPageSize)"]
            ),
            key: "runs", resourceName: "job run"
        )
    }

    public func jobCommand(id: String, command: String) async throws -> Job {
        guard ["activate", "pause", "resume", "run"].contains(command) else {
            throw APIError(error: "Unsupported job action")
        }
        _ = try await request("POST", "jobs/\(escaped(id))/\(command)", body: .object([:]))
        return try await job(id: id)
    }

    public func deleteJob(id: String) async throws {
        _ = try await request("DELETE", "jobs/\(escaped(id))")
    }

    // MARK: - Secrets

    public func secrets(scope: String, scopeId: String) async throws -> DecodedList<SecretMeta> {
        try decodeListRows(
            json: try await request("GET", "secrets/\(escaped(scope))/\(escaped(scopeId))"),
            key: "secrets", resourceName: "secret"
        )
    }

    public func putSecret(scope: String, scopeId: String, name: String, value: String) async throws {
        _ = try await request(
            "PUT", "secrets/\(escaped(scope))/\(escaped(scopeId))/\(escaped(name))",
            body: .object(["value": .string(value)])
        )
    }

    public func deleteSecret(scope: String, scopeId: String, name: String) async throws {
        _ = try await request(
            "DELETE", "secrets/\(escaped(scope))/\(escaped(scopeId))/\(escaped(name))"
        )
    }

    // MARK: - Model credentials

    public func modelCredentials() async throws -> ModelCredentialsResponse {
        try await requestDecoded(ModelCredentialsResponse.self, "GET", "model-credentials")
    }

    public func modelCredentialLoginTicket(
        providerId: String, authType: String, podId: String? = nil
    ) async throws -> LoginTicket {
        var body: [String: JSONValue] = ["authType": .string(authType)]
        if let podId { body["podId"] = .string(podId) }
        return try await requestDecoded(
            LoginTicket.self, "POST", "model-credentials/\(escaped(providerId))/login-ticket",
            body: .object(body)
        )
    }

    public func testModelCredential(providerId: String) async throws -> CredentialStatus {
        let data = try await request(
            "POST", "model-credentials/\(escaped(providerId))/test", body: .object([:])
        )
        guard let status = data["status"] else {
            throw APIError(error: "Unexpected credential test response", detail: data)
        }
        return try JSONCoding.decode(CredentialStatus.self, from: status)
    }

    public func deleteModelCredential(providerId: String) async throws {
        _ = try await request("DELETE", "model-credentials/\(escaped(providerId))")
    }

    // MARK: - Devices

    public func registerDevice(
        token: String, tokenKind: String = "apns", platform: String = "ios", environment: String
    ) async throws {
        guard !token.isEmpty else {
            throw APIError(error: "registerDevice requires a token")
        }
        _ = try await request(
            "POST", "devices",
            body: .object([
                // Both spellings are sent so an older server that only reads
                // `apnsToken` still registers this device.
                "apnsToken": .string(token),
                "token": .string(token),
                "tokenKind": .string(tokenKind),
                "platform": .string(platform),
                "environment": .string(environment),
            ])
        )
    }

    public func unregisterDevice(token: String) async throws {
        _ = try await request("DELETE", "devices/\(escaped(token))")
    }

    // MARK: - Paged lists

    /// The server's maximum page size for the cursor list routes.
    static let listPageSize = 200
    /// Upper bound on pages walked, so a server that keeps answering full pages
    /// cannot turn one screen into an unbounded request loop.
    static let listPageCap = 25

    /// Walks a `limit`/`before` list route to the end.
    ///
    /// Rows are de-duplicated by id: the cursor is a timestamp, rows move while
    /// the walk is in progress, and the same pod appearing twice would render
    /// twice. A failure partway through returns what has been read rather than
    /// emptying a screen that already had an answer.
    private func pagedList<Element: Decodable & Sendable>(
        _ type: Element.Type = Element.self,
        path: String,
        key: String,
        resourceName: String,
        query: [String: String],
        id: (Element) -> String,
        cursor: (Element) -> String?,
        tieBreaker: ((Element) -> String)? = nil
    ) async throws -> DecodedList<Element> {
        var items: [Element] = []
        var unparsed: [UnparsedRow] = []
        var seen: Set<String> = []
        var before: String?
        var beforeId: String?

        for _ in 0..<APIClient.listPageCap {
            var pageQuery = query
            if let before { pageQuery["before"] = before }
            if let beforeId { pageQuery["beforeId"] = beforeId }
            let page: DecodedList<Element>
            do {
                page = try decodeListRows(
                    json: try await request("GET", path, query: pageQuery),
                    key: key, resourceName: resourceName, as: Element.self
                )
            } catch {
                if items.isEmpty, unparsed.isEmpty { throw error }
                break
            }
            for row in page.items where seen.insert(id(row)).inserted { items.append(row) }
            for row in page.unparsedRows {
                guard let rowID = row.rowID else {
                    unparsed.append(row)
                    continue
                }
                if seen.insert(rowID).inserted { unparsed.append(row) }
            }
            // A short page is the end of the list.
            guard page.items.count + page.unparsedRows.count >= APIClient.listPageSize
            else { break }
            if let tieBreaker {
                // A keyset cursor: `(created_at, id) < (before, beforeId)` names
                // one row exactly, so no row can hide behind a shared timestamp
                // and no row is ever re-read.
                guard let last = page.items.last, let next = cursor(last), !next.isEmpty,
                      next != before || tieBreaker(last) != beforeId
                else { break }
                before = next
                beforeId = tieBreaker(last)
                continue
            }
            guard let next = APIClient.nextCursor(page.items.compactMap(cursor)),
                  next != before
            else { break }
            before = next
        }
        return DecodedList(items: items, unparsedRows: unparsed)
    }

    /// Where the next page of a `limit`/`before` walk starts.
    ///
    /// `before` is exclusive and the column it filters is not unique: Postgres
    /// `now()` is transaction time, so a cascade that touches many pods writes
    /// the same `last_activity_at` to the microsecond on all of them. Asking for
    /// rows strictly older than the last row on the page therefore drops every
    /// other row sharing that timestamp — a whole group vanishes when it
    /// straddles a page boundary.
    ///
    /// So the cursor steps back to the timestamp just *above* the page's
    /// trailing run of equal values: the next page re-reads that run, and the
    /// walk's `seen` set de-duplicates it. A page whose rows all carry one
    /// timestamp has no earlier value to step to — it keeps the exclusive
    /// cursor, which is the only value that still makes progress, so the walk
    /// terminates instead of asking for the same page forever.
    static func nextCursor(_ values: [String]) -> String? {
        guard let last = values.last, !last.isEmpty else { return nil }
        guard let boundary = values.last(where: { $0 != last }), !boundary.isEmpty else {
            return last
        }
        return boundary
    }

    // MARK: - Transport

    @discardableResult
    func request(
        _ method: String,
        _ path: String,
        query: [String: String] = [:],
        body: JSONValue? = nil,
        authorized: Bool = true,
        expectedGeneration: UUID? = nil
    ) async throws -> JSONValue {
        do {
            return try await perform(
                method, path, query: query, body: body, authorized: authorized,
                expectedGeneration: expectedGeneration, boundGeneration: nil, isRetry: false
            )
        } catch let error as SessionExpiredError {
            if let authVersion = error.authVersion { onSessionExpired?(authVersion) }
            throw error
        }
    }

    private func requestDecoded<T: Decodable>(
        _ type: T.Type,
        _ method: String,
        _ path: String,
        query: [String: String] = [:],
        body: JSONValue? = nil,
        expectedGeneration: UUID? = nil
    ) async throws -> T {
        try JSONCoding.decode(
            type,
            from: try await request(
                method, path, query: query, body: body,
                expectedGeneration: expectedGeneration
            )
        )
    }

    private func perform(
        _ method: String,
        _ path: String,
        query: [String: String],
        body: JSONValue?,
        authorized: Bool,
        expectedGeneration: UUID?,
        boundGeneration: UUID?,
        isRetry: Bool
    ) async throws -> JSONValue {
        // The path is assembled already percent-encoded (ids and secret names can
        // hold spaces and slashes). `appendingPathComponent` would escape the `%`
        // again and ask the server for a literally different resource.
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let basePath = components?.percentEncodedPath.replacingOccurrences(
            of: "/+$", with: "", options: .regularExpression
        ) ?? ""
        components?.percentEncodedPath = "\(basePath)/v1/\(path)"
        if !query.isEmpty {
            components?.queryItems = query
                .sorted { $0.key < $1.key }
                .map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components?.url else {
            throw APIError(error: "Could not build a request URL for \(path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONCoding.data(from: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let authSnapshot: TokenSnapshot?
        if authorized {
            let current = await tokens.snapshot()
            let generation = boundGeneration ?? expectedGeneration ?? current.version.generation
            guard current.version.generation == generation else {
                throw AuthContextChangedError()
            }
            guard let token = current.accessToken, !token.isEmpty else {
                throw APIError(error: "not signed in")
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            authSnapshot = current
        } else {
            authSnapshot = nil
        }

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            throw error
        }

        let currentAuth: TokenSnapshot?
        if authorized {
            currentAuth = await tokens.snapshot()
        } else {
            currentAuth = nil
        }
        if let authSnapshot, let currentAuth,
           currentAuth.version.generation != authSnapshot.version.generation {
            throw AuthContextChangedError()
        }

        if response.statusCode == 401, let authSnapshot, let currentAuth {
            if currentAuth.version.revision != authSnapshot.version.revision {
                // Another request already rotated this same generation. Replay
                // once with its current access token, but never refresh again.
                guard !isRetry else { throw AuthContextChangedError() }
                return try await perform(
                    method, path, query: query, body: body, authorized: true,
                    expectedGeneration: authSnapshot.version.generation,
                    boundGeneration: authSnapshot.version.generation,
                    isRetry: true
                )
            }
            if !isRetry, let refreshToken = authSnapshot.refreshToken, !refreshToken.isEmpty {
                do {
                    _ = try await refreshCoordinator.refresh(
                        observed: authSnapshot, tokens: tokens, refresher: refresher
                    )
                } catch let error as SessionExpiredError {
                    let latest = await tokens.snapshot()
                    guard latest.version.generation == authSnapshot.version.generation else {
                        throw AuthContextChangedError()
                    }
                    throw SessionExpiredError(message: error.message, authVersion: latest.version)
                }
                let latest = await tokens.snapshot()
                guard latest.version.generation == authSnapshot.version.generation else {
                    throw AuthContextChangedError()
                }
                return try await perform(
                    method, path, query: query, body: body, authorized: true,
                    expectedGeneration: authSnapshot.version.generation,
                    boundGeneration: authSnapshot.version.generation,
                    isRetry: true
                )
            }
            throw SessionExpiredError(authVersion: currentAuth.version)
        }

        guard (200..<300).contains(response.statusCode) else {
            throw mapFailure(
                status: response.statusCode, data: data,
                authVersion: currentAuth?.version
            )
        }
        if data.isEmpty { return .object([:]) }
        return (try? JSONCoding.value(from: data)) ?? .object([:])
    }

    private func mapFailure(
        status: Int, data: Data, authVersion: TokenVersion?
    ) -> Error {
        if status == 401 { return SessionExpiredError(authVersion: authVersion) }
        if let value = try? JSONCoding.value(from: data), let object = value.objectValue,
           object["error"]?.stringValue != nil {
            return APIError(json: object).withHTTPStatus(status)
        }
        let detail = String(data: data, encoding: .utf8) ?? ""
        return APIError(
            error: "HTTP \(status)",
            detail: detail.isEmpty ? nil : .string(detail),
            httpStatus: status
        )
    }

    /// Escapes one path component. `.urlPathAllowed` keeps `/`, which would let an
    /// id walk up the path, so the separators are escaped explicitly too.
    private func escaped(_ component: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return component.addingPercentEncoding(withAllowedCharacters: allowed) ?? component
    }
}

/// Collapses refreshes for one exact credential version. A request from a
/// replaced account never joins another generation's flight.
actor RefreshCoordinator {
    private struct Flight {
        let id: UUID
        let task: Task<TokenSnapshot, Error>
    }

    private var flights: [TokenVersion: Flight] = [:]

    func refresh(
        observed: TokenSnapshot,
        tokens: TokenStore,
        refresher: TokenRefreshing
    ) async throws -> TokenSnapshot {
        if let flight = flights[observed.version] {
            return try await flight.task.value
        }

        let flightID = UUID()
        let task = Task<TokenSnapshot, Error> {
            let current = await tokens.snapshot()
            guard current.version.generation == observed.version.generation else {
                throw AuthContextChangedError()
            }
            if current.version.revision != observed.version.revision { return current }
            guard let refreshToken = observed.refreshToken, !refreshToken.isEmpty else {
                throw SessionExpiredError(authVersion: observed.version)
            }

            do {
                let response = try await refresher.refresh(refreshToken: refreshToken)
                switch await tokens.commitRefresh(response, ifVersion: observed.version) {
                case .committed(let committed): return committed
                case .superseded(let latest):
                    guard latest.version.generation == observed.version.generation else {
                        throw AuthContextChangedError()
                    }
                    return latest
                case .sessionChanged:
                    throw AuthContextChangedError()
                }
            } catch {
                let latest = await tokens.snapshot()
                guard latest.version.generation == observed.version.generation else {
                    throw AuthContextChangedError()
                }
                if latest.version.revision != observed.version.revision { return latest }
                if let expired = error as? SessionExpiredError {
                    throw SessionExpiredError(
                        message: expired.message, authVersion: latest.version
                    )
                }
                throw error
            }
        }
        flights[observed.version] = Flight(id: flightID, task: task)
        defer {
            if flights[observed.version]?.id == flightID {
                flights.removeValue(forKey: observed.version)
            }
        }
        return try await task.value
    }
}

/// A minimal mutable box for callbacks stored on an otherwise immutable client.
final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Value

    init(_ value: Value) { storage = value }

    var value: Value {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}
