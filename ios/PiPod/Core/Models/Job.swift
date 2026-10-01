import Foundation

/// When a job runs.
///
/// Decoding throws on an unrecognized trigger type. A schedule the client cannot
/// render must not be shown as if it were understood — misreporting when a job
/// runs is worse than refusing to display it, so the row lands in
/// `DecodedList.unparsedRows` instead.
public enum JobTrigger: Codable, Hashable, Sendable {
    case cron(String)
    case at([String])

    private enum CodingKeys: String, CodingKey {
        case type, cron, times
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "cron":
            self = .cron(try container.decode(String.self, forKey: .cron))
        case "at":
            self = .at(try container.decode([String].self, forKey: .times))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container,
                debugDescription: "unknown trigger type \"\(type)\""
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .cron(let expression):
            try container.encode("cron", forKey: .type)
            try container.encode(expression, forKey: .cron)
        case .at(let times):
            try container.encode("at", forKey: .type)
            try container.encode(times, forKey: .times)
        }
    }
}

/// Who a job belongs to.
///
/// Personal by default; `PATCH scope="org"` is a one-way share (`jobs/routes.ts`).
/// It decides who sees the job in the list *and* who a pause or a delete affects
/// — a shared job pauses for the whole organization — so it can never be left
/// implicit on a confirmation.
public enum JobScope: String, Codable, Hashable, Sendable {
    case user
    case org
}

public struct Job: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let description: String?
    public let status: String
    /// Absent on older servers, which had no sharing at all: personal is the
    /// server's own default, so the omission reads as personal rather than
    /// unknown.
    public let scope: JobScope
    public let trigger: JobTrigger
    public let templateId: String?
    public let model: String
    public let prompt: String
    public let createdFromPod: String?
    public let nextRunAt: String?
    public let lastRunAt: String?
    public let createdAt: String
    public let updatedAt: String

    // There is no draft status: server migration 030 removed it and rewrote the
    // rows that had it to `paused`.
    public var isActive: Bool { status == "active" }
    public var isPaused: Bool { status == "paused" }
    public var isCompleted: Bool { status == "completed" }

    /// True when everyone in the organization sees this job — and when pausing
    /// or deleting it acts on their schedule too.
    public var isSharedWithOrg: Bool { scope == .org }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        status = try container.decode(String.self, forKey: .status)
        // An unrecognised scope is not a reason to drop the row, but it must not
        // read as "shared" on a guess: only the value the server documents does.
        scope = try container.decodeIfPresent(String.self, forKey: .scope)
            .flatMap(JobScope.init(rawValue:)) ?? .user
        trigger = try container.decode(JobTrigger.self, forKey: .trigger)
        templateId = try container.decodeIfPresent(String.self, forKey: .templateId)
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        createdFromPod = try container.decodeIfPresent(String.self, forKey: .createdFromPod)
        nextRunAt = try container.decodeIfPresent(String.self, forKey: .nextRunAt)
        lastRunAt = try container.decodeIfPresent(String.self, forKey: .lastRunAt)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}

public struct JobRun: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let podId: String?
    public let scheduledAt: String
    public let status: String
    public let error: String?
    public let startedAt: String
    public let finishedAt: String?

    public var isRunning: Bool { status == "running" }
    public var didFail: Bool { status == "failed" }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        podId = try container.decodeIfPresent(String.self, forKey: .podId)
        scheduledAt = try container.decode(String.self, forKey: .scheduledAt)
        status = try container.decode(String.self, forKey: .status)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        startedAt = try container.decodeIfPresent(String.self, forKey: .startedAt) ?? scheduledAt
        finishedAt = try container.decodeIfPresent(String.self, forKey: .finishedAt)
    }
}
