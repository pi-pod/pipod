import Foundation

/// Which side of the conversation a transcript row belongs to.
public enum StreamItemStyle: String, Hashable, Sendable {
    case user
    case assistant
    case tool
    case status
}

/// How far an outgoing turn got. Anything but `.delivered` is reported on the
/// message itself, with its recovery next to it — a banner elsewhere on screen
/// cannot say *which* message is stuck.
public enum StreamItemDelivery: String, Hashable, Sendable {
    case delivered
    case sending
    case waitingForConnection
    case savedOnServer
    /// The queue request may have committed even though the response was lost.
    /// This state never offers an automatic retry.
    case unknown
    case failed
}

/// An image that rode along with a user turn, carried on the item so the
/// transcript can thumbnail what was sent.
///
/// The server persists `user_prompt` images as descriptors (`{mimeType, bytes}`),
/// never base64, so history rows for other sessions have sizes but no pixels:
/// those are placeholders and render as size tiles. A live echo adopts the
/// outgoing bubble instead, so the local bytes stay on the item and thumbnails
/// survive the round trip.
public struct StreamImageAttachment: Identifiable, Hashable, Sendable {
    /// Stable identity carried over from the composer's `ChatAttachment`, so a
    /// retry reuses it instead of minting a colliding name-based one. Empty for
    /// history rows, which never retry.
    public let id: String
    public let name: String
    public let mimeType: String
    public let bytes: Data
    /// Decoded size the server reported. Set only on descriptor placeholders,
    /// whose bytes never left the pod.
    public let declaredBytes: Int?

    public init(
        id: String = "",
        name: String,
        mimeType: String,
        bytes: Data,
        declaredBytes: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.bytes = bytes
        self.declaredBytes = declaredBytes
    }

    /// True when there are no pixels to show: the bytes never left the pod.
    public var isPlaceholder: Bool { bytes.isEmpty }

    public var sizeBytes: Int { declaredBytes ?? bytes.count }
}

/// One transcript row as the reducer produces it.
///
/// A value type, not a reference: SwiftUI diffs the array, and an item that
/// mutates in place behind the framework's back would not repaint.
public struct StreamItem: Identifiable, Hashable, Sendable {
    public var id: String
    public var style: StreamItemStyle
    public var title: String
    public var text: String
    public var timestamp: Date?
    public var isInProgress: Bool
    public var isError: Bool
    public var delivery: StreamItemDelivery
    public var attachments: [StreamImageAttachment]

    public init(
        id: String,
        style: StreamItemStyle,
        title: String,
        text: String,
        timestamp: Date? = nil,
        isInProgress: Bool = false,
        isError: Bool = false,
        delivery: StreamItemDelivery = .delivered,
        attachments: [StreamImageAttachment] = []
    ) {
        self.id = id
        self.style = style
        self.title = title
        self.text = text
        self.timestamp = timestamp
        self.isInProgress = isInProgress
        self.isError = isError
        self.delivery = delivery
        self.attachments = attachments
    }
}

/// Which chrome a bubble needs: a run of turns from the same sender inside the
/// grouping window shares one sender label and one timestamp.
public struct MessageChrome: Hashable, Sendable {
    public let showsSender: Bool
    public let showsTimestamp: Bool
    public let isContinuation: Bool

    public init(showsSender: Bool, showsTimestamp: Bool, isContinuation: Bool) {
        self.showsSender = showsSender
        self.showsTimestamp = showsTimestamp
        self.isContinuation = isContinuation
    }

    public static let standalone = MessageChrome(
        showsSender: true, showsTimestamp: true, isContinuation: false
    )

    public static let chromeLess = MessageChrome(
        showsSender: false, showsTimestamp: false, isContinuation: false
    )
}

/// A row the transcript draws: a day header, a message, or one run of tool calls.
public enum TranscriptRow: Identifiable, Hashable, Sendable {
    /// `dayID` identifies the *header*, not the day: it carries the id of the
    /// item it sits above, because the same calendar day can open more than one
    /// header (see `TranscriptPresentation.rows`) and two rows sharing an id is
    /// a `ForEach` the framework cannot diff.
    case day(dayID: String, title: String)
    case item(StreamItem, MessageChrome)
    case tools([StreamItem])

    public var id: String {
        switch self {
        case .day(let dayID, _): return "day-\(dayID)"
        case .item(let item, _): return item.id
        case .tools(let items): return "tools-\(items.first?.id ?? "")"
        }
    }
}

/// Whether the transcript keeps chasing the newest row.
///
/// The two signals are deliberately asymmetric. Only a deliberate drag stops it
/// following, so a scroll the app itself performs while following cannot turn
/// its own behaviour off. Seeing the bottom always re-arms it, because that is
/// what being caught up means — both when the reader scrolls back down and when
/// the gesture that disarmed it turns out to have been a rubber-band bounce at
/// the end of the conversation. Without the second signal, following could only
/// ever be re-armed by sending a message.
public enum TranscriptScrollPolicy {
    /// A drag has to travel this far toward older rows before it counts as
    /// leaving the bottom. A stray few points during a tap is not a decision.
    public static let disengageDistance: CGFloat = 24

    public static func shouldFollow(wasFollowing: Bool, bottomIsVisible: Bool) -> Bool {
        bottomIsVisible ? true : wasFollowing
    }

    public static func shouldFollow(wasFollowing: Bool, draggedBy translation: CGFloat) -> Bool {
        translation > disengageDistance ? false : wasFollowing
    }

    /// The gesture ended. Whatever the drag decided mid-flight, still seeing the
    /// bottom means the reader never left it.
    public static func shouldFollowAfterDrag(
        wasFollowing: Bool, bottomIsVisible: Bool
    ) -> Bool {
        shouldFollow(wasFollowing: wasFollowing, bottomIsVisible: bottomIsVisible)
    }
}

/// Transcript rows cached against the items they were built from.
///
/// The reducer bumps its scroll revision many times a second while a turn
/// streams, and plenty of those bumps change no items at all — a reconnect, a
/// resolved approval, a re-anchor. Deriving the rows inside `body` rebuilt and
/// re-identified the whole transcript for every one of them.
public struct TranscriptRowCache {
    public private(set) var items: [StreamItem] = []
    public private(set) var rows: [TranscriptRow] = []

    public init() {}

    /// Rebuilds only when the conversation actually changed. Returns whether it
    /// did.
    @discardableResult
    public mutating func update(
        _ newItems: [StreamItem],
        now: Date = Date(),
        calendar: Calendar = .autoupdatingCurrent
    ) -> Bool {
        guard newItems != items || (rows.isEmpty && !newItems.isEmpty) else { return false }
        items = newItems
        rows = TranscriptPresentation.rows(newItems, now: now, calendar: calendar)
        return true
    }
}

/// Turns the flat event stream into the rows a chat transcript actually shows:
/// day headers, grouped consecutive turns, and which chrome each bubble needs.
///
/// Grouping is a display concern, not a protocol one — the stream stays a list
/// of events so reconnect and replay can keep matching by id.
public enum TranscriptPresentation {
    /// Consecutive same-sender turns closer than this share one label and one
    /// timestamp.
    public static let groupingInterval: TimeInterval = 5 * 60

    public static func rows(
        _ items: [StreamItem],
        now: Date = Date(),
        calendar: Calendar = .autoupdatingCurrent
    ) -> [TranscriptRow] {
        var rows: [TranscriptRow] = []
        var lastDayID: String?
        var index = 0
        while index < items.count {
            let item = items[index]
            if let timestamp = item.timestamp {
                let dayID = dayIdentifier(timestamp, calendar: calendar)
                if dayID != lastDayID {
                    // Timestamps are not monotonic: an optimistic local send is
                    // stamped with this device's clock and the server's echo
                    // with the server's, so a transcript can cross midnight and
                    // come back. Keying the header on the day alone then
                    // produced two rows with one id, which SwiftUI renders by
                    // dropping one and mis-animating the rest.
                    rows.append(
                        .day(
                            dayID: "\(dayID)@\(item.id)",
                            title: Format.transcriptDay(
                                timestamp, now: now, calendar: calendar
                            )
                        )
                    )
                    lastDayID = dayID
                }
            }
            if item.style == .tool {
                var run: [StreamItem] = []
                while index < items.count, items[index].style == .tool {
                    run.append(items[index])
                    index += 1
                }
                rows.append(.tools(run))
                continue
            }
            let previous = index > 0 ? items[index - 1] : nil
            let next = index + 1 < items.count ? items[index + 1] : nil
            rows.append(
                .item(
                    item,
                    chrome(item, previous: previous, next: next, calendar: calendar)
                )
            )
            index += 1
        }
        return rows
    }

    public static func chrome(
        _ item: StreamItem,
        previous: StreamItem? = nil,
        next: StreamItem? = nil,
        calendar: Calendar = .autoupdatingCurrent
    ) -> MessageChrome {
        guard item.style == .user || item.style == .assistant else {
            return .chromeLess
        }
        let isContinuation = previous.map { groups($0, item, calendar) } ?? false
        let continuesAfter = next.map { groups(item, $0, calendar) } ?? false
        return MessageChrome(
            showsSender: !isContinuation,
            showsTimestamp: !continuesAfter,
            isContinuation: isContinuation
        )
    }

    /// True when the last row is already a live assistant or tool bubble — a
    /// second "pi is working" indicator under it would repeat the same fact.
    public static func showsTypingIndicator(isRunning: Bool, lastItem: StreamItem?) -> Bool {
        guard isRunning else { return false }
        if let lastItem, lastItem.isInProgress,
           lastItem.style == .assistant || lastItem.style == .tool {
            return false
        }
        return true
    }

    private static func groups(
        _ lhs: StreamItem, _ rhs: StreamItem, _ calendar: Calendar
    ) -> Bool {
        guard lhs.style == rhs.style else { return false }
        guard lhs.style == .user || lhs.style == .assistant else { return false }
        switch (lhs.timestamp, rhs.timestamp) {
        case (let left?, let right?):
            return abs(right.timeIntervalSince(left)) < groupingInterval
                && calendar.isDate(left, inSameDayAs: right)
        case (nil, nil):
            return true
        default:
            return false
        }
    }

    private static func dayIdentifier(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return "\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
    }
}
