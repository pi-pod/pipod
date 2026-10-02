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

