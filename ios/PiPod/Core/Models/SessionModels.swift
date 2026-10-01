import Foundation

/// One-shot ticket for the session WebSocket. Browser and native clients both
/// use it because a WebSocket handshake cannot carry an Authorization header.
public struct WsTicket: Codable, Hashable, Sendable {
    public let ticket: String
    public let expiresAt: String
}

/// Receipt for a prompt queued over REST while no socket was attached.
public struct QueuedPromptReceipt: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let status: String
    public let createdAt: String
}

public struct AgentSession: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let userId: String
    public let startedAt: String
    public let endedAt: String?
    public let endReason: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case endReason = "end_reason"
    }
}

public struct SessionEventRecord: Codable, Hashable, Sendable {
    public let seq: Int
    public let kind: String
    public let payload: JSONValue
    public let createdAt: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seq = try container.decode(Int.self, forKey: .seq)
        kind = try container.decode(String.self, forKey: .kind)
        payload = try container.decodeIfPresent(JSONValue.self, forKey: .payload) ?? .null
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    }
}

public struct SessionEventsPage: Codable, Hashable, Sendable {
    public let events: [SessionEventRecord]
}

public struct ConversationEventRecord: Codable, Hashable, Sendable {
    public let sessionId: String
    public let seq: Int
    public let kind: String
    public let payload: JSONValue
    public let createdAt: String

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        seq = try container.decode(Int.self, forKey: .seq)
        kind = try container.decode(String.self, forKey: .kind)
        payload = try container.decodeIfPresent(JSONValue.self, forKey: .payload) ?? .null
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
    }
}

public struct ConversationEventsPage: Codable, Hashable, Sendable {
    public let events: [ConversationEventRecord]
    public let nextBefore: String?
}

/// An approval or question the pod is blocked on, as the REST inbox returns it.
public struct PendingInteraction: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let sessionId: String
    public let podId: String
    public let podName: String
    public let seq: Int
    public let kind: String
    public let payload: JSONValue
    public let createdAt: String
    public let resolvedAt: String?
    public let deliveredAt: String?

    private enum CodingKeys: String, CodingKey {
        case id, seq, kind, payload
        case sessionId = "session_id"
        case podId = "pod_id"
        case podName = "pod_name"
        case createdAt = "created_at"
        case resolvedAt = "resolved_at"
        case deliveredAt = "delivered_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        podId = try container.decode(String.self, forKey: .podId)
        podName = try container.decodeIfPresent(String.self, forKey: .podName) ?? ""
        seq = try container.decode(Int.self, forKey: .seq)
        kind = try container.decode(String.self, forKey: .kind)
        payload = try container.decodeIfPresent(JSONValue.self, forKey: .payload) ?? .null
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        resolvedAt = try container.decodeIfPresent(String.self, forKey: .resolvedAt)
        deliveredAt = try container.decodeIfPresent(String.self, forKey: .deliveredAt)
    }
}

/// The shape an interaction answer has to be in before it leaves the app.
///
/// The gateway's `deliverResolution` forwards the answer **unchanged** to pi's
/// `rpc.respondExtensionUi`, and pi only releases the blocked prompt when the
/// frame carries `type: "extension_ui_response"`. Sending a bare
/// `{confirmed: true}` is accepted by the server with a 200 and an
/// `interaction_resolved` event — so the card clears and the receipt renders —
/// while the agent's turn hangs until pi's 120s `askUi` timeout. That is the bug
/// the Flutter client shipped; it is deliberately not ported.
///
/// `id` is supplied by the server from the pending request, so the client omits it.
public enum InteractionResponse {
    public static let frameType = "extension_ui_response"

    /// Adds the frame type to an object answer, leaving anything else alone.
    ///
    /// A literal `null` is a valid answer and keeps its meaning; wrapping it in an
    /// object would turn "no answer" into an empty one.
    public static func normalized(_ response: JSONValue) -> JSONValue {
        guard case .object(var fields) = response else { return response }
        if fields["type"] == nil { fields["type"] = .string(frameType) }
        return .object(fields)
    }

    /// `{confirmed: …}` — the answer to a CONFIRM prompt.
    public static func confirmed(_ value: Bool) -> JSONValue {
        normalized(.object(["confirmed": .bool(value)]))
    }

    /// `{value: …}` — the answer to a SELECT, INPUT or EDITOR prompt.
    public static func value(_ value: JSONValue) -> JSONValue {
        normalized(.object(["value": value]))
    }

    /// `{cancelled: true}` — backing out of any of them.
    public static var cancelled: JSONValue {
        normalized(.object(["cancelled": .bool(true)]))
    }
}

public struct ResolveOutcome: Codable, Hashable, Sendable {
    public let resolved: Bool
    public let delivery: String?
    public let alreadyResolved: Bool?

    public init(resolved: Bool, delivery: String? = nil, alreadyResolved: Bool? = nil) {
        self.resolved = resolved
        self.delivery = delivery
        self.alreadyResolved = alreadyResolved
    }

    /// The answer was accepted but the pod has not taken it yet: the card must
    /// stay on screen rather than claiming the agent has moved on.
    public var isDeliveryPending: Bool { delivery == "pending" }
}
