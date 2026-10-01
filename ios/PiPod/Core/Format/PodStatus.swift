import Foundation

/// The lifecycle vocabulary a pod is allowed to show.
///
/// The server's own `state` enum is not presentable: `active` covers a running
/// pod, a stopped one and a failed launch, so every screen reads this instead and
/// the word "active" never reaches a person.
public enum PodLifecycle: String, CaseIterable, Hashable, Sendable {
    case running
    case asleep
    case starting
    case failed
    case archived
    case unavailable

    public var label: String {
        switch self {
        case .running: return "Running"
        case .asleep: return "Asleep"
        case .starting: return "Starting"
        case .failed: return "Failed"
        case .archived: return "Archived"
        case .unavailable: return "Unavailable"
        }
    }

    public var tone: StatusTone {
        switch self {
        case .running: return .positive
        case .asleep: return .info
        case .starting: return .caution
        case .failed: return .danger
        case .archived: return .neutral
        case .unavailable: return .unreachable
        }
    }

    /// Pulses in the UI: the state is on its way somewhere, so a still icon would
    /// read as settled.
    public var isTransitional: Bool { self == .starting }

    public var systemImage: String {
        switch self {
        case .running: return "play.circle.fill"
        case .asleep: return "moon.fill"
        case .starting: return "circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .archived: return "archivebox.fill"
        case .unavailable: return "cloud.bolt"
        }
    }
}
