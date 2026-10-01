import Foundation

/// The dedicated account-login WebSocket.
///
/// Tickets are minted over the normal REST client and then carried in the query
/// string, so no account JWT ever enters a URL — URLs reach proxy logs and
/// crash reports, and a leaked bearer token is the whole account.
@MainActor
public final class LoginSocket {
    public let providerId: String
    public let authType: String
    public let podId: String?

    /// Every decoded frame, in arrival order.
    public var onMessage: ((LoginServerMessage) -> Void)?
    /// The connection ended before a `done` frame. Nil error means a clean close.
    public var onDisconnect: ((Error?) -> Void)?

    public private(set) var isConnected = false

    private let api: APIClient
    private let serverURL: URL
    private let session: URLSession

    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    /// Guards every async continuation: a late frame from a socket the caller
    /// already replaced must not reopen a finished screen.
    private var generation = 0
    private var isClosed = true
    private var isCompleted = false

    public init(
        api: APIClient,
        providerId: String,
        authType: String,
        podId: String? = nil,
        serverURL: URL = Config.serverURL,
        session: URLSession = .shared
    ) {
        self.api = api
        self.providerId = providerId
        self.authType = authType
        self.podId = podId
        self.serverURL = serverURL
        self.session = session
    }

    deinit {
        receiveLoop?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
    }

    public func connect() async {
        disconnect(notify: false)
        generation += 1
        let generation = generation
        isClosed = false
        isCompleted = false

        do {
            let ticket = try await api.modelCredentialLoginTicket(
                providerId: providerId, authType: authType, podId: podId
            )
            guard generation == self.generation, !isClosed else { return }
            guard let url = connectionURL(ticket: ticket.ticket) else {
                throw APIError(error: "Could not build the sign-in connection URL")
            }
            let task = session.webSocketTask(with: url)
            self.task = task
            isConnected = true
            task.resume()
            receiveLoop = Task { [weak self] in await self?.receive(generation: generation) }
        } catch {
            if generation == self.generation { terminate(error) }
        }
    }

    public func connectionURL(ticket: String) -> URL? {
        guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.scheme = (components.scheme == "https" || components.scheme == "wss")
            ? "wss" : "ws"
        let base = components.path.split(separator: "/").map(String.init)
        // `.urlPathAllowed` keeps "/", which would let a provider id open a path
        // segment and point the socket at a different route.
        let segment = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        let escaped = providerId.addingPercentEncoding(withAllowedCharacters: segment)
            ?? providerId
        components.path = "/" + (base + ["v1", "model-credentials", escaped, "login"])
            .joined(separator: "/")
        components.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        components.fragment = nil
        return components.url
    }

    @discardableResult
    public func respond(id: String, value: String) -> Bool {
        send(["type": .string("response"), "id": .string(id), "value": .string(value)])
    }

    /// Tells the server to abandon the login before closing. A socket dropped
    /// without this leaves the provider's device flow polling until it expires.
    @discardableResult
    public func cancel() -> Bool {
        let sent = send(["type": .string("cancel")])
        disconnect(notify: false)
        return sent
    }

    public func disconnect(notify: Bool = true) {
        let wasConnected = isConnected
        generation += 1
        isClosed = true
        cleanUp()
        if notify, wasConnected, !isCompleted { onDisconnect?(nil) }
    }

    /// Exposed so protocol tests can drive frames without a socket.
    public func handleText(_ text: String) {
        guard let message = LoginProtocol.decode(text) else { return }
        if case .done = message { isCompleted = true }
        onMessage?(message)
    }

    // MARK: - Transport

    private func receive(generation: Int) async {
        while !Task.isCancelled {
            guard let task, generation == self.generation else { return }
            do {
                let message = try await task.receive()
                guard generation == self.generation else { return }
                if case .string(let text) = message { handleText(text) }
            } catch {
                guard generation == self.generation else { return }
                // A close after `done` is the server hanging up on a finished
                // login, not a failure worth reporting.
                if isCompleted {
                    cleanUp()
                } else {
                    terminate(error)
                }
                return
            }
        }
    }

    @discardableResult
    private func send(_ message: [String: JSONValue]) -> Bool {
        guard let task, isConnected,
              let data = try? JSONCoding.data(from: .object(message)),
              let text = String(data: data, encoding: .utf8)
        else { return false }
        task.send(.string(text)) { [weak self] error in
            guard let error else { return }
            Task { @MainActor [weak self] in self?.terminate(error) }
        }
        return true
    }

    private func terminate(_ error: Error?) {
        guard !isClosed else { return }
        isClosed = true
        generation += 1
        cleanUp()
        onDisconnect?(error)
    }

    private func cleanUp() {
        receiveLoop?.cancel()
        receiveLoop = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        isConnected = false
    }
}
