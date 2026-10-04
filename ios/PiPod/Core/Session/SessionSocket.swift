import Foundation
import OSLog

/// Close reasons that are safe to write to the log.
///
/// The peer controls the close-frame reason, so logging it verbatim would put
/// arbitrary remote text — tokens, URLs, HTML — into `os_log`, where it lands
/// in sysdiagnoses and bug reports. Only these exact trimmed codes are ever
/// logged; everything else, including "no reason", logs as `"<redacted>"`.
/// The close *code* is always logged. Transport error logs stay
/// domain-and-code (`logSafeDescription`), never the remote string.
///
/// The first three are also the workstation-wait reasons (`WorkstationCloseReason`),
/// so the wait keeps seeing them: the allowlist is what the wait reads.
public enum SessionCloseReasonLog: Sendable {
    public static let allowed: Set<String> = [
        "host_starting", "host_stopped", "host_archived",
        "pod_unavailable", "gateway_shutdown",
    ]

    /// What the log line may print for `reason`: the trimmed code when it is
    /// allowlisted, `"<redacted>"` otherwise — including nil and blank.
    public static func safe(_ reason: String?) -> String {
        guard let reason else { return "<redacted>" }
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard allowed.contains(trimmed) else { return "<redacted>" }
        return trimmed
    }
}

/// The gateway `errCode` values that close a socket with 4420 because the
/// caller's own personal workstation is not up.
///
/// The code alone is not enough: 4420 is also the long-standing "pod asleep"
/// close, and `host_stopped` / `host_archived` are also the stop causes of a
/// *co-located host pod*, which is a different thing entirely. Only the typed
/// detail on the preceding `error` frame tells them apart, so these names are
/// used to look for that detail, never on their own.
public enum WorkstationCloseReason {
    public static let codes: Set<String> = ["host_starting", "host_stopped", "host_archived"]

    public static func names(_ code: String?) -> Bool {
        guard let code else { return false }
        return codes.contains(code)
    }
}

/// Server close codes from the session WebSocket contract. Each one means a
/// different thing for reconnect, so they are named rather than compared raw.
public enum SessionCloseCode: Int, Sendable, CaseIterable {
    case goingAway = 1012
    case unauthorized = 4001
    case badRequest = 4400
    case podNotFound = 4404
    case podUnavailable = 4409
    case asleep = 4420
    case piExited = 4421
    case transient = 4500

    public static func from(_ value: Int?) -> SessionCloseCode? {
        guard let value else { return nil }
        return SessionCloseCode(rawValue: value)
    }
}

/// One image block inside an outgoing `prompt`. Mirrors pi's `ImageContent`
/// (`{type: "image", data: <base64>, mimeType}`), which the gateway forwards to
/// pi's RPC `prompt` verbatim.
public struct SessionImage: Hashable, Sendable {
    public let mimeType: String
    public let base64Data: String

    public init(mimeType: String, base64Data: String) {
        self.mimeType = mimeType
        self.base64Data = base64Data
    }

    public var json: JSONValue {
        .object([
            "type": .string("image"),
            "data": .string(base64Data),
            "mimeType": .string(mimeType),
        ])
    }
}

/// A decoded message from `/v1/pods/:podId/session`.
public enum SessionServerMessage: Sendable {
    /// `firstAvailableSeq` is present only when this client asked to resume from
    /// a point the server has since truncated: everything below it is gone from
    /// durable history, which the transcript has to say out loud.
    case hello(
        sessionId: String, latestSeq: Int, firstReplayedSeq: Int?, firstAvailableSeq: Int?,
        state: JSONValue?
    )
    case event(seq: Int, kind: String, ts: String?, payload: JSONValue)
    case ephemeral(kind: String, payload: JSONValue)
    /// Some client answered the dialog with this pi request id.
    case dialogClosed(id: String)
    case replayGap(fromSeq: Int, toSeq: Int)
    case podState(state: String, reason: String?)
    case podUpdated(id: String, name: String)
    case queuedPromptStatus(id: String, status: String)
    case sessionEnded(reason: String, kind: String, recoverable: Bool)
    case models(
        models: [JSONValue], current: JSONValue?, thinkingLevel: String?,
        thinkingLevels: [String]
    )
    case modelConfirmation(
        requestID: String, models: [JSONValue], current: JSONValue?, thinkingLevel: String?,
        thinkingLevels: [String]
    )
    /// pi's answer to an `rpc` command this client sent, under the client's id.
    case rpcResult(id: String, response: JSONValue)
    case pong
    /// `detail` carries the gateway's typed refusal body. A host-demand refusal
    /// arrives as an `error` frame immediately before close code 4420, and that
    /// frame is the only place the typed detail exists on this transport.
    case error(code: String?, message: String, detail: JSONValue?)
}

// MARK: - Transport seam

/// The socket as the reducer uses it. A protocol so lifecycle and replay tests
/// exercise the whole protocol without opening a network connection.
@MainActor
public protocol SessionTransport: AnyObject {
    var isConnected: Bool { get }
    var latestSeq: Int { get }
    var sessionId: String? { get }
    var onMessage: ((SessionServerMessage) -> Void)? { get set }
    var onDisconnect: ((Error?, SessionCloseCode?) -> Void)? { get set }
    /// Sanitized close-frame reason from the last disconnect. Never a URL.
    var lastCloseReason: String? { get }

    func connect(ticket: String)
    func disconnect(notify: Bool)
    @discardableResult func prompt(_ text: String, images: [SessionImage]) -> Bool
    @discardableResult func interrupt() -> Bool
    @discardableResult func requestModels() -> Bool
    @discardableResult func uiResponse(_ response: JSONValue) -> Bool
    @discardableResult func set(
        model: [String: String]?, thinkingLevel: String?, requestID: String?
    ) -> Bool
    @discardableResult func rpc(id: String, command: JSONValue) -> Bool
}

/// One open WebSocket, narrow enough that a test double is a dozen lines.
@MainActor
public protocol SessionWebSocketChannel: AnyObject {
    func send(_ text: String)
    func close()
    var closeCode: Int? { get }
    /// UTF-8 close reason, truncated and without URLs. Nil when the peer sent none.
    var closeReason: String? { get }
}

/// Opens a channel and reports its traffic. Injected so tests answer frames
/// synchronously instead of racing a real socket.
@MainActor
public protocol SessionChannelFactory {
    func open(
        url: URL,
        onText: @escaping (String) -> Void,
        onClose: @escaping (Error?) -> Void
    ) -> SessionWebSocketChannel
}

// MARK: - Socket

private let socketLog = Logger(subsystem: "com.pipod.app", category: "session.socket")

/// JSON WebSocket client for a pi session.
///
/// Authentication rides the one-shot `ticket` query parameter: a WebSocket
/// handshake cannot carry an `Authorization` header, so the ticket is minted per
/// connection attempt and never retained for a retry.
@MainActor
public final class SessionSocket: SessionTransport {
    public let podId: String
    public let fromSeq: Int?
    public let fromSessionId: String?
    public let serverURL: URL
    public let pingInterval: TimeInterval

    /// A connection is considered dead when nothing at all has arrived for this
    /// many ping intervals. Two and a half leaves room for one lost ping and its
    /// answer before the reconnect starts.
    public static let inboundDeadlineFactor: Double = 2.5

    public private(set) var isConnected = false
    public private(set) var latestSeq = 0
    public private(set) var sessionId: String?

    /// When the last frame of any kind arrived. A silent half-open socket — the
    /// one a phone comes back from sleep holding — looks identical to an idle
    /// healthy one without it.
    public private(set) var lastInboundAt: Date?

    public var onMessage: ((SessionServerMessage) -> Void)?
    public var onDisconnect: ((Error?, SessionCloseCode?) -> Void)?
    public private(set) var lastCloseReason: String?

    private let factory: SessionChannelFactory
    private let now: () -> Date
    private var channel: SessionWebSocketChannel?
    private var pingTask: Task<Void, Never>?
    private var generation = 0
    private var terminated = true

    public init(
        podId: String,
        fromSeq: Int?,
        fromSessionId: String?,
        serverURL: URL = Config.serverURL,
        factory: SessionChannelFactory? = nil,
        pingInterval: TimeInterval = 25,
        now: @escaping () -> Date = Date.init
    ) {
        self.podId = podId
        self.fromSeq = fromSeq
        self.fromSessionId = fromSessionId
        self.serverURL = serverURL
        self.factory = factory ?? URLSessionChannelFactory()
        self.pingInterval = pingInterval
        self.now = now
    }

    // MARK: Lifecycle

    /// Consumes a freshly minted one-shot ticket for this connection attempt.
    public func connect(ticket: String) {
        disconnect(notify: false)
        generation += 1
        let generation = generation
        terminated = false
        guard let url = connectionURL(ticket: ticket) else {
            terminated = true
            onDisconnect?(APIError(error: "Could not build the session URL"), nil)
            return
        }
        channel = factory.open(
            url: url,
            onText: { [weak self] text in
                guard let self, generation == self.generation else { return }
                self.handle(text: text)
            },
            onClose: { [weak self] error in
                guard let self, generation == self.generation else { return }
                self.fail(error)
            }
        )
    }

    public func connectionURL(ticket: String) -> URL? {
        guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)
        else { return nil }
        components.scheme = serverURL.scheme == "https" ? "wss" : "ws"
        let prefix = components.path.split(separator: "/").map(String.init)
        components.path = "/" + (prefix + ["v1", "pods", podId, "session"]).joined(separator: "/")
        var query = [URLQueryItem(name: "ticket", value: ticket)]
        if let fromSeq { query.append(URLQueryItem(name: "from_seq", value: "\(fromSeq)")) }
        if let fromSessionId {
            query.append(URLQueryItem(name: "from_session", value: fromSessionId))
        }
        components.queryItems = query
        components.fragment = nil
        return components.url
    }

    public func disconnect(notify: Bool = true) {
        let wasConnected = isConnected
        generation += 1
        terminated = true
        pingTask?.cancel()
        pingTask = nil
        let channel = channel
        self.channel = nil
        channel?.close()
        isConnected = false
        if notify, wasConnected { onDisconnect?(nil, nil) }
    }

    // MARK: Client messages

    @discardableResult
    public func prompt(_ text: String, images: [SessionImage] = []) -> Bool {
        var body: [String: JSONValue] = ["type": .string("prompt"), "text": .string(text)]
        if !images.isEmpty { body["images"] = .array(images.map(\.json)) }
        return send(.object(body))
    }

    @discardableResult
    public func interrupt() -> Bool { send(.object(["type": .string("interrupt")])) }

    @discardableResult
    public func requestModels() -> Bool { send(.object(["type": .string("get_models")])) }

    /// Answers an extension UI request the pod is blocking on: a dialog, or a
    /// remote-UI surface. The gateway forwards it to pi verbatim, so it must
    /// already be a complete `extension_ui_response` frame.
    @discardableResult
    public func uiResponse(_ response: JSONValue) -> Bool {
        send(.object(["type": .string("ui_response"), "response": response]))
    }

    @discardableResult
    public func set(
        model: [String: String]?, thinkingLevel: String?, requestID: String? = nil
    ) -> Bool {
        var body: [String: JSONValue] = ["type": .string("set")]
        if let model {
            body["model"] = .object(model.mapValues(JSONValue.string))
        }
        if let thinkingLevel { body["thinkingLevel"] = .string(thinkingLevel) }
        if let requestID { body["requestId"] = .string(requestID) }
        return send(.object(body))
    }

    /// Sends one pi RPC command through the gateway's passthrough. The answer
    /// comes back to this socket alone as `rpc_result` under `id`, which must
    /// be unique: pi retires an id once it has answered it.
    @discardableResult
    public func rpc(id: String, command: JSONValue) -> Bool {
        send(.object(["type": .string("rpc"), "id": .string(id), "command": command]))
    }

    private func send(_ message: JSONValue) -> Bool {
        guard let channel, isConnected else { return false }
        guard let data = try? JSONCoding.data(from: message),
              let text = String(data: data, encoding: .utf8)
        else { return false }
        channel.send(text)
        return true
    }

    // MARK: Server messages

    /// Exposed for protocol-focused tests. Malformed and unknown frames are
    /// ignored rather than fatal: a newer server must not wedge an older app.
    public func handle(text: String) {
        guard let value = JSONValue.parse(text), case .object(let object) = value,
              let type = object["type"]?.stringValue
        else { return }
        guard let message = SessionSocket.decode(type: type, object: object) else { return }
        // Any frame, a pong included, proves the connection is still carrying
        // traffic. This is the only evidence the deadline below has.
        lastInboundAt = now()
        switch message {
        case .hello(let sessionId, let latestSeq, _, _, _):
            self.sessionId = sessionId
            self.latestSeq = latestSeq
            isConnected = true
            startPinging()
        case .event(let seq, _, _, _):
            latestSeq = max(seq, latestSeq)
        default:
            break
        }
        onMessage?(message)
    }

    static func decode(type: String, object: [String: JSONValue]) -> SessionServerMessage? {
        switch type {
        case "hello":
            return .hello(
                sessionId: string(object["sessionId"]),
                latestSeq: integer(object["latestSeq"]),
                firstReplayedSeq: object["firstReplayedSeq"]?.intValue,
                firstAvailableSeq: object["firstAvailableSeq"]?.intValue,
                state: map(object["state"])
            )
        case "event":
            return .event(
                seq: integer(object["seq"]),
                kind: string(object["kind"], fallback: "event"),
                ts: object["ts"]?.stringValue,
                payload: map(object["payload"]) ?? .object([:])
            )
        case "ephemeral":
            return .ephemeral(
                kind: string(object["kind"], fallback: "event"),
                payload: map(object["payload"]) ?? .object([:])
            )
        case "dialog_closed":
            return .dialogClosed(id: string(object["id"]))
        case "replay_gap":
            return .replayGap(
                fromSeq: integer(object["fromSeq"]), toSeq: integer(object["toSeq"])
            )
        case "pod_state":
            return .podState(
                state: string(object["state"]), reason: object["reason"]?.stringValue
            )
        case "pod_updated":
            return .podUpdated(id: string(object["id"]), name: string(object["name"]))
        case "queued_prompt_status":
            let id = string(object["queuedPromptId"])
            let status = string(object["status"])
            guard !id.isEmpty,
                  ["pending", "delivering", "delivered", "failed", "unknown"].contains(status)
            else { return nil }
            return .queuedPromptStatus(id: id, status: status)
        case "session_ended":
            return .sessionEnded(
                reason: string(object["reason"]),
                kind: string(object["kind"]),
                recoverable: object["recoverable"]?.boolValue ?? true
            )
        case "models":
            let rows = object["models"]?.arrayValue ?? []
            let models = rows.filter { $0.objectValue != nil }
            let current = map(object["current"])
            let thinkingLevel = object["thinkingLevel"]?.stringValue
            let thinkingLevels = (object["thinkingLevels"]?.arrayValue ?? [])
                .compactMap(\.stringValue)
            if let requestID = object["requestId"]?.stringValue, !requestID.isEmpty {
                return .modelConfirmation(
                    requestID: requestID, models: models, current: current,
                    thinkingLevel: thinkingLevel, thinkingLevels: thinkingLevels
                )
            }
            return .models(
                models: models, current: current,
                thinkingLevel: thinkingLevel, thinkingLevels: thinkingLevels
            )
        case "rpc_result":
            guard let id = object["id"]?.stringValue, let response = map(object["response"])
            else { return nil }
            return .rpcResult(id: id, response: response)
        case "pong":
            return .pong
        case "error":
            return .error(
                code: object["code"]?.stringValue,
                message: string(object["message"], fallback: "unknown error"),
                detail: map(object["detail"])
            )
        default:
            return nil
        }
    }

    // MARK: Keepalive and failure

    private func startPinging() {
        pingTask?.cancel()
        let interval = pingInterval
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                // A ping nobody answers is the whole point of pinging. Without a
                // deadline the socket stayed "connected" forever against a peer
                // that had gone — sends vanished and no reconnect ever ran.
                if let last = self.lastInboundAt,
                   self.now().timeIntervalSince(last)
                       > interval * SessionSocket.inboundDeadlineFactor {
                    self.fail(nil)
                    return
                }
                _ = self.send(.object(["type": .string("ping")]))
            }
        }
    }

    private func fail(_ error: Error?) {
        guard !terminated else { return }
        terminated = true
        pingTask?.cancel()
        pingTask = nil
        let channel = channel
        self.channel = nil
        isConnected = false
        let code = SessionCloseCode.from(channel?.closeCode)
        lastCloseReason = channel?.closeReason
        // Never the raw remote string: the peer controls it, so only the
        // allowlisted codes reach `os_log`. Anything else is `"<redacted>"`.
        let reasonLog = SessionCloseReasonLog.safe(lastCloseReason)
        let codeLog = code.map { String($0.rawValue) } ?? "none"
        socketLog.debug("session socket closed code=\(codeLog, privacy: .public) reason=\(reasonLog, privacy: .public)")
        if let error {
            // Never the error's description: `URLError` carries the failing URL,
            // and this URL's query string is the one-shot session ticket.
            socketLog.debug(
                "session socket closed error: \(logSafeDescription(error), privacy: .public)"
            )
        }
        onDisconnect?(error, code)
    }

    // MARK: Tolerant readers

    private static func integer(_ value: JSONValue?) -> Int { value?.intValue ?? 0 }

    private static func string(_ value: JSONValue?, fallback: String = "") -> String {
        value?.stringValue ?? fallback
    }

    private static func map(_ value: JSONValue?) -> JSONValue? {
        guard let value, value.objectValue != nil else { return nil }
        return value
    }
}

// MARK: - URLSession channel

/// `URLSessionWebSocketTask` behind the channel seam. No third-party client:
/// the protocol here is a line of JSON in each direction.
@MainActor
public struct URLSessionChannelFactory: SessionChannelFactory {
    private let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    public func open(
        url: URL,
        onText: @escaping (String) -> Void,
        onClose: @escaping (Error?) -> Void
    ) -> SessionWebSocketChannel {
        URLSessionChannel(task: session.webSocketTask(with: url), onText: onText, onClose: onClose)
    }
}

/// The slice of `URLSessionWebSocketTask` the channel actually uses.
///
/// `receive(completionHandler:)` lives in an extension and so cannot be
/// overridden, which leaves no way to watch the cancel a released channel owes
/// its task. The methods are spelled differently from the originals so the
/// conformance below forwards rather than recurses.
protocol WebSocketTaskHandle: AnyObject {
    var socketCloseCode: URLSessionWebSocketTask.CloseCode { get }
    var socketCloseReason: Data? { get }
    func resumeSocket()
    func sendText(_ text: String, completion: @escaping @Sendable (Error?) -> Void)
    func receiveMessage(
        _ completion: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    )
    func cancelSocket(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
}

extension URLSessionWebSocketTask: WebSocketTaskHandle {
    var socketCloseCode: URLSessionWebSocketTask.CloseCode { closeCode }
    var socketCloseReason: Data? { closeReason }
    func resumeSocket() { resume() }
    func sendText(_ text: String, completion: @escaping @Sendable (Error?) -> Void) {
        send(.string(text), completionHandler: completion)
    }
    func receiveMessage(
        _ completion: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    ) {
        receive(completionHandler: completion)
    }
    func cancelSocket(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        cancel(with: closeCode, reason: reason)
    }
}

@MainActor
final class URLSessionChannel: SessionWebSocketChannel {
    private let task: any WebSocketTaskHandle
    private let onText: (String) -> Void
    private let onClose: (Error?) -> Void
    private var closed = false

    var closeCode: Int? {
        let raw = task.socketCloseCode.rawValue
        return raw == 0 ? nil : raw
    }

    var closeReason: String? {
        Self.sanitizedCloseReason(task.socketCloseReason)
    }

    static func sanitizedCloseReason(_ data: Data?) -> String? {
        guard let data, let raw = String(data: data, encoding: .utf8) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        // Allowlist only: the peer controls this string, so nothing arbitrary
        // is kept where a log line could pick it up. Unknown reasons become
        // `"<redacted>"`; the raw bytes stay on the task, which is never logged.
        guard SessionCloseReasonLog.allowed.contains(trimmed) else { return "<redacted>" }
        return trimmed
    }

    init(
        task: any WebSocketTaskHandle,
        onText: @escaping (String) -> Void,
        onClose: @escaping (Error?) -> Void
    ) {
        self.task = task
        self.onText = onText
        self.onClose = onClose
        task.resumeSocket()
        receive()
    }

    deinit {
        // `URLSession` — not this object — owns the task's lifetime, so a channel
        // released without `close()` (a stream discarded while its screen was
        // popped) would leave the WebSocket open until the process died.
        if !closed { task.cancelSocket(with: .goingAway, reason: nil) }
    }

    func send(_ text: String) {
        task.sendText(text) { [weak self] error in
            guard let error else { return }
            Task { @MainActor in self?.finish(error) }
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        task.cancelSocket(with: .normalClosure, reason: nil)
    }

    private func receive() {
        task.receiveMessage { [weak self] result in
            Task { @MainActor in
                guard let self, !self.closed else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.onText(text)
                    case .data(let data):
                        // The gateway speaks text; a binary frame is not ours.
                        if let text = String(data: data, encoding: .utf8) { self.onText(text) }
                    @unknown default:
                        break
                    }
                    self.receive()
                case .failure(let error):
                    self.finish(error)
                }
            }
        }
    }

    private func finish(_ error: Error?) {
        guard !closed else { return }
        closed = true
        onClose(error)
    }
}
