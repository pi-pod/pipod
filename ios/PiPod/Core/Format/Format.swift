import Foundation

/// Display helpers for ISO timestamps and transcript cluster headers.
public enum Format {
    /// The server writes fractional seconds on some rows and not others, so both
    /// spellings are tried before a timestamp is called unparseable.
    public static func date(_ isoString: String) -> Date? {
        if let parsed = fractionalParser.date(from: isoString) { return parsed }
        if let parsed = plainParser.date(from: isoString) { return parsed }
        return nil
    }

    public static func iso(_ date: Date) -> String {
        fractionalParser.string(from: date)
    }

    /// "3m ago" / "2d ago" for an ISO timestamp; nil when it does not parse.
    public static func relative(_ isoString: String?, now: Date = Date()) -> String? {
        guard let isoString, let parsed = date(isoString) else { return nil }
        // "in 0s" for timestamps a clock skew puts slightly in the future reads
        // as a bug.
        if parsed > now { return "just now" }
        guard let bare = duration(since: isoString, now: now) else { return nil }
        return "\(bare) ago"
    }

    public static func absolute(_ isoString: String) -> String? {
        guard let parsed = date(isoString) else { return nil }
        return absoluteFormatter.string(from: parsed)
    }

    /// Bare elapsed duration — "3m", "2h", "5d" — for "waiting 3m" phrasing where
    /// "waiting since 3m ago" would read twice.
    public static func duration(since isoString: String?, now: Date = Date()) -> String? {
        guard let isoString, let parsed = date(isoString) else { return nil }
        let seconds = max(0, Int(now.timeIntervalSince(parsed)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86_400)d"
    }

    /// Elapsed time that has to stay readable while it grows for ten minutes:
    /// "8s", "2m 14s", "1h 3m". Coarser than a stopwatch, finer than
    /// `duration(since:)`, which rounds a nine-minute wait down to "9m" and
    /// then looks frozen.
    public static func elapsed(_ seconds: TimeInterval) -> String {
        let whole = max(0, Int(seconds))
        if whole < 60 { return "\(whole)s" }
        if whole < 3600 { return "\(whole / 60)m \(whole % 60)s" }
        return "\(whole / 3600)h \(whole % 3600 / 60)m"
    }

    /// "24 Sep" — a day without a year, for a date inside the current period.
    public static func shortDay(
        _ date: Date,
        calendar: Calendar = .autoupdatingCurrent,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return formatter.string(from: date)
    }

    /// Timestamp for a transcript row: time only for today, day + time once older.
    public static func transcriptTime(
        _ date: Date,
        now: Date = Date(),
        calendar: Calendar = .autoupdatingCurrent
    ) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return timeFormatter.string(from: date)
        }
        return absoluteFormatter.string(from: date)
    }

    /// Day header for a transcript cluster. The calendar is injectable so tests
    /// can pin GMT and a fixed locale instead of depending on the host region.
    public static func transcriptDay(
        _ date: Date,
        now: Date = Date(),
        calendar: Calendar = .autoupdatingCurrent,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        let sameYear = calendar.component(.year, from: date)
            == calendar.component(.year, from: now)
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
        return formatter.string(from: date)
    }

    /// "1.2 MB" for an attachment or a settings payload.
    public static func bytes(_ count: Int) -> String {
        byteFormatter.string(fromByteCount: Int64(count))
    }

    // MARK: - Formatters

    private static let fractionalParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let absoluteFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static let byteFormatter: ByteCountFormatter = {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter
    }()
}
