import Foundation

/// Human labels for job schedules. Cron fires in UTC on the server, so cron text
/// keeps its UTC qualifier; `at` times are instants and format in the reader's
/// local time zone.
public enum JobSchedule {
    public static func summary(for trigger: JobTrigger, now: Date = Date()) -> String {
        switch trigger {
        case .cron(let expression):
            return humanizeCron(expression) ?? "cron “\(expression)” (UTC)"
        case .at(let times):
            return atSummary(times: times, now: now)
        }
    }

    /// The schedule sentence a detail screen shows. A cron the client understands
    /// gains the local wall-clock time beside it, because "09:30 UTC" is not what
    /// the reader's morning looks like.
    public static func detailSummary(
        for trigger: JobTrigger,
        localOffset: TimeInterval? = nil,
        now: Date = Date()
    ) -> String {
        let summary = summary(for: trigger, now: now)
        guard case .cron(let expression) = trigger, humanizeCron(expression) != nil else {
            return summary
        }
        let fields = expression.split(whereSeparator: \.isWhitespace).map(String.init)
        guard fields.count == 5, let minute = Int(fields[0]), let hour = Int(fields[1]) else {
            return summary
        }
        let offsetMinutes = Int(
            (localOffset ?? Double(TimeZone.current.secondsFromGMT(for: now))) / 60
        )
        let shifted = ((hour * 60 + minute + offsetMinutes) % 1440 + 1440) % 1440
        let localTime = String(format: "%02d:%02d local", shifted / 60, shifted % 60)
        return "\(summary) (\(localTime))"
    }

    public static func atSummary(times: [String], now: Date) -> String {
        if times.count == 1 {
            return "Once, \(Format.absolute(times[0]) ?? times[0])"
        }
        let remaining = remainingCount(times: times, now: now)
        return "\(times.count) times, \(remaining == 0 ? "all done" : "\(remaining) remaining")"
    }

    /// Times strictly in the future; unparseable entries count as past so they
    /// never inflate what the schedule still owes.
    public static func remainingCount(times: [String], now: Date) -> Int {
        times.filter { (Format.date($0) ?? .distantPast) > now }.count
    }

    /// "in 3m" / "in 2h" for an upcoming instant. `Format.relative` clamps future
    /// timestamps to "just now", which is exactly wrong for a next run.
    public static func countdown(to isoString: String?, now: Date = Date()) -> String? {
        guard let isoString, let date = Format.date(isoString) else { return nil }
        let seconds = date.timeIntervalSince(now)
        if seconds <= 0 { return "now" }
        if seconds < 60 { return "in \(Int(seconds))s" }
        if seconds < 3600 { return "in \(Int(seconds / 60))m" }
        if seconds < 86_400 { return "in \(Int(seconds / 3600))h" }
        return "in \(Int(seconds / 86_400))d"
    }

    /// Plain-shape crons ("30 9 * * 1") become words; anything richer returns nil
    /// and the raw expression stands, because a wrong paraphrase is worse than
    /// cron syntax.
    public static func humanizeCron(_ cron: String) -> String? {
        let fields = cron.split(whereSeparator: \.isWhitespace).map(String.init)
        guard fields.count == 5,
              let minute = Int(fields[0]), (0...59).contains(minute),
              let hour = Int(fields[1]), (0...23).contains(hour),
              fields[3] == "*"
        else { return nil }
        let time = String(format: "%02d:%02d UTC", hour, minute)
        let dayOfMonth = fields[2]
        let dayOfWeek = fields[4]
        if dayOfMonth == "*", dayOfWeek == "*" { return "Every day at \(time)" }
        if dayOfMonth == "*", let days = dayNames(dayOfWeek) { return "Every \(days) at \(time)" }
        if dayOfWeek == "*", let day = Int(dayOfMonth), (1...31).contains(day) {
            return "Monthly on the \(ordinal(day)) at \(time)"
        }
        return nil
    }

    private static func dayNames(_ field: String) -> String? {
        if field == "1-5" { return "weekday" }
        let names = [
            "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
        ]
        var days: [String] = []
        for part in field.split(separator: ",") {
            // Cron accepts both 0 and 7 for Sunday.
            guard let number = Int(part), (0...7).contains(number) else { return nil }
            days.append(names[number % 7])
        }
        guard let last = days.last else { return nil }
        if days.count == 1 { return last }
        return days.dropLast().joined(separator: ", ") + " and " + last
    }

    private static func ordinal(_ number: Int) -> String {
        let suffix: String
        switch number % 100 {
        case 11, 12, 13:
            suffix = "th"
        default:
            switch number % 10 {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }
        return "\(number)\(suffix)"
    }
}
