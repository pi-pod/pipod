import Foundation

/// One titled group of jobs on the list screen.
public struct JobSection: Identifiable, Hashable, Sendable {
    public let title: String
    public let jobs: [Job]

    public var id: String { title }

    public init(title: String, jobs: [Job]) {
        self.title = title
        self.jobs = jobs
    }
}

/// How a job and its runs read on screen.
///
/// Status arrives as a raw server enum. Every string here is written for the
/// person holding the phone, and an enum this build does not know degrades to a
/// sentence that admits it rather than printing the raw token.
public enum JobPresentation {
    /// Active jobs sort by what fires next, so the top of the list is what
    /// happens next.
    ///
    /// There is no approval group: server migration 030 removed the draft
    /// status, so no job ever arrives waiting for a decision.
    public static func sections(for jobs: [Job]) -> [JobSection] {
        let active = jobs.filter(\.isActive).sorted { left, right in
            switch (left.nextRunAt.flatMap(Format.date), right.nextRunAt.flatMap(Format.date)) {
            case (let lhs?, let rhs?): return lhs < rhs
            // A job with no scheduled time sinks below one that has one.
            case (nil, _?): return false
            case (_?, nil): return true
            case (nil, nil): return false
            }
        }
        return [
            JobSection(title: "Active", jobs: active),
            JobSection(title: "Paused", jobs: jobs.filter(\.isPaused)),
            JobSection(title: "Completed", jobs: jobs.filter(\.isCompleted)),
        ].filter { !$0.jobs.isEmpty }
    }

    /// The chip on a job row: what the job is doing, or when it next will.
    public static func rowStatus(_ job: Job, now: Date = Date()) -> String {
        switch job.status {
        case "active":
            guard let countdown = countdown(job, now: now) else { return "Active" }
            return "Next \(countdown)"
        case "paused":
            return "Paused"
        case "completed":
            return "Completed"
        default:
            return "Status unavailable"
        }
    }

    public static func tone(_ job: Job) -> StatusTone {
        switch job.status {
        case "active": return .positive
        case "paused": return .info
        case "completed": return .neutral
        default: return .unreachable
        }
    }

    /// The one word for a shared job, on a row and on its detail.
    ///
    /// Personal jobs say nothing: they are the default, and labelling the
    /// common case is how a list stops being scannable.
    public static let sharedLabel = "Shared with organization"

    /// Nil for a personal job, which is the default and says nothing.
    public static func scopeLabel(_ job: Job) -> String? {
        job.isSharedWithOrg ? sharedLabel : nil
    }

    /// What pausing or deleting this job affects. A shared job is somebody
    /// else's schedule too, and a confirmation that does not say so is asking
    /// for a decision the reader cannot actually make.
    public static func pauseConfirmation(_ job: Job) -> String {
        job.isSharedWithOrg
            ? """
                This job is shared with your organization: pausing it stops it firing for \
                everyone. Resuming it later puts it back on schedule.
                """
            : "Its schedule won’t fire until you resume it."
    }

    public static func deleteConfirmation(_ job: Job) -> String {
        job.isSharedWithOrg
            ? """
                This job is shared with your organization: deleting it removes it for \
                everyone. Pods it already launched are unaffected.
                """
            : "Its schedule stops firing. Pods it already launched are unaffected."
    }

    public static func systemImage(_ job: Job) -> String {
        switch job.status {
        case "active": return "clock"
        case "paused": return "pause.circle"
        case "completed": return "checkmark.circle"
        default: return "questionmark.circle"
        }
    }

    /// The status sentence on the detail screen, where there is room to say what
    /// the state means rather than only naming it.
    public static func detailStatus(_ job: Job) -> String {
        if job.isCompleted { return "Completed — every scheduled time has passed" }
        guard let first = job.status.first else { return "Status unavailable" }
        return first.uppercased() + job.status.dropFirst()
    }

    /// "Sep 9, 2026 at 09:30 (in 2h)" — the instant plus how long until it.
    public static func nextRun(_ isoString: String, now: Date = Date()) -> String {
        let absolute = Format.absolute(isoString) ?? isoString
        guard let countdown = JobSchedule.countdown(to: isoString, now: now) else { return absolute }
        return "\(absolute) (\(countdown))"
    }

    private static func countdown(_ job: Job, now: Date) -> String? {
        JobSchedule.countdown(to: job.nextRunAt, now: now)
    }

    // MARK: - Runs

    /// Known values map to Title Case and anything unknown degrades to Title Case
    /// too, never raw lowercase.
    public static func runStatus(_ status: String) -> String {
        let spaced = status
            .replacingOccurrences(
                of: "(?<=[a-z0-9])(?=[A-Z])", with: " ", options: .regularExpression
            )
            .replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
        let words = spaced.split(separator: " ").filter { !$0.isEmpty }
        guard !words.isEmpty else { return status }
        return words
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    public static func runVisual(_ status: String) -> (systemImage: String, tone: StatusTone) {
        switch status {
        case "running": return ("arrow.triangle.2.circlepath", .info)
        case "completed": return ("checkmark.circle.fill", .positive)
        case "failed": return ("exclamationmark.triangle.fill", .danger)
        case "interrupted": return ("stop.circle.fill", .caution)
        default: return ("questionmark.circle", .neutral)
        }
    }
}
