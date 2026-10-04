import Foundation
import Observation

/// What pi has spent in a pod's current session: the totals its TUI footer
/// shows, read from pi's own `get_session_stats`.
///
/// pi is the authority because it sums the whole session log, including
/// history compacted out of the conversation and abandoned branches. The
/// transcript this app holds is neither: replay is bounded and compaction
/// removes messages, so totals summed here would shrink as the session grew.
public struct SessionUsage: Hashable, Sendable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let cacheReadTokens: Int
    public let cacheWriteTokens: Int
    /// pi's estimate at the model's list price, in US dollars. A provider
    /// subscription may cover it; pi's stats do not say whether one does.
    public let cost: Double
    /// Tokens in the context pi will send next. Nil right after a compaction,
    /// until the next reply measures it again.
    public let contextTokens: Int?
    public let contextWindow: Int?
    public let contextPercent: Double?
    public let userMessages: Int
    public let assistantMessages: Int
    public let toolCalls: Int

    public init(
        inputTokens: Int, outputTokens: Int, cacheReadTokens: Int, cacheWriteTokens: Int,
        cost: Double, contextTokens: Int? = nil, contextWindow: Int? = nil,
        contextPercent: Double? = nil, userMessages: Int = 0, assistantMessages: Int = 0,
        toolCalls: Int = 0
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.cost = cost
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.contextPercent = contextPercent
        self.userMessages = userMessages
        self.assistantMessages = assistantMessages
        self.toolCalls = toolCalls
    }

    /// Decodes the `data` of a successful `get_session_stats` response; nil when
    /// it carries no token totals.
    public init?(stats: JSONValue?) {
        guard let tokens = stats?["tokens"], tokens.objectValue != nil else { return nil }
        let context = stats?["contextUsage"]
        let window = context?["contextWindow"]?.intValue
        self.init(
            inputTokens: tokens["input"]?.intValue ?? 0,
            outputTokens: tokens["output"]?.intValue ?? 0,
            cacheReadTokens: tokens["cacheRead"]?.intValue ?? 0,
            cacheWriteTokens: tokens["cacheWrite"]?.intValue ?? 0,
            cost: stats?["cost"]?.doubleValue ?? 0,
            contextTokens: context?["tokens"]?.intValue,
            contextWindow: window.flatMap { $0 > 0 ? $0 : nil },
            contextPercent: context?["percent"]?.doubleValue,
            userMessages: stats?["userMessages"]?.intValue ?? 0,
            assistantMessages: stats?["assistantMessages"]?.intValue ?? 0,
            toolCalls: stats?["toolCalls"]?.intValue ?? 0
        )
    }

    public var totalTokens: Int {
        inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
    }

    /// Nothing has been spent yet, so there is nothing worth a line on screen.
    public var isEmpty: Bool { totalTokens == 0 && cost <= 0 }

    // MARK: - Compact readout

    /// The token half of the footer line: `↑12k ↓3.4k`, nonzero parts only.
    public var tokenSummary: String? {
        var parts: [String] = []
        if inputTokens > 0 { parts.append("↑\(Self.tokens(inputTokens))") }
        if outputTokens > 0 { parts.append("↓\(Self.tokens(outputTokens))") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// `$0.042`, with pi's three decimals, or nil when nothing was priced.
    public var costSummary: String? { cost > 0 ? Self.money(cost) : nil }

    /// `12.3%/200k`, or `?/200k` while pi cannot measure the context.
    public var contextSummary: String? {
        guard let contextWindow else { return nil }
        let percent = contextPercent.map { String(format: "%.1f%%", $0) } ?? "?"
        return "\(percent)/\(Self.tokens(contextWindow))"
    }

    /// How close the context is to full, with pi's own thresholds: past 70%
    /// compaction is coming, past 90% it is imminent.
    public var contextTone: StatusTone? {
        guard let contextPercent else { return nil }
        if contextPercent > 90 { return .danger }
        if contextPercent > 70 { return .caution }
        return nil
    }

    public var accessibilitySummary: String {
        var parts = [
            "\(Self.tokens(inputTokens)) input tokens",
            "\(Self.tokens(outputTokens)) output tokens",
        ]
        if let costSummary { parts.append("estimated cost \(costSummary)") }
        if let contextDetail { parts.append("context \(contextDetail.lowercased())") }
        return "Session usage: " + parts.joined(separator: ", ")
    }

    // MARK: - Breakdown

    /// `12.3% of 200k tokens`, or why it is unknown.
    public var contextDetail: String? {
        guard let contextWindow else { return nil }
        guard let contextPercent else { return "Unknown until pi’s next reply" }
        return String(format: "%.1f%% of ", contextPercent) + "\(Self.tokens(contextWindow)) tokens"
    }

    /// What the breakdown's numbers cover, and what the cost is not.
    public static let footnote = """
        Totals for this pod’s current pi session, including history compacted out of the \
        conversation. Cost is pi’s estimate at the model’s list price; a provider \
        subscription may cover it.
        """

    // MARK: - Formatting

    /// pi's footer spelling: `950`, `1.2k`, `12k`, `1.2M`, `12M`.
    public static func tokens(_ count: Int) -> String {
        if count < 1000 { return "\(count)" }
        if count < 10_000 { return String(format: "%.1fk", Double(count) / 1000) }
        if count < 1_000_000 { return "\(Int((Double(count) / 1000).rounded()))k" }
        if count < 10_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        return "\(Int((Double(count) / 1_000_000).rounded()))M"
    }

    /// A count with grouping separators, for the breakdown where precision is
    /// the point.
    public static func exact(_ count: Int) -> String {
        count.formatted(.number.grouping(.automatic))
    }

    public static func money(_ dollars: Double) -> String {
        String(format: "$%.3f", dollars)
    }
}

/// Keeps a session's `SessionUsage` current while its stream is attached.
///
/// The stream says when totals may have moved — an attach, a finished reply, a
/// compaction — and this asks pi through the gateway's `rpc` passthrough.
/// Requests are coalesced: while one is unanswered, further refreshes collapse
/// into a single follow-up, so a replayed transcript full of finished replies
/// costs two requests rather than one per reply.
@MainActor
@Observable
public final class SessionUsageTracker {
    /// The newest totals pi reported. Kept across disconnects: what was spent
    /// does not change while the pod sleeps.
    public private(set) var latest: SessionUsage?

    /// Sends one `rpc` frame; false when there is no connected transport. Set
    /// by the stream that owns this tracker.
    @ObservationIgnored public var sender: ((_ id: String, _ command: JSONValue) -> Bool)?
    @ObservationIgnored private var inFlightID: String?
    @ObservationIgnored private var refreshQueued = false

    public init() {}

    /// Asks pi for fresh totals, or queues one more ask behind an unanswered one.
    public func refresh() {
        guard inFlightID == nil else {
            refreshQueued = true
            return
        }
        // pi retires every request id once answered, and the gateway shares one
        // pi among every attached client, so each ask needs an id of its own.
        let id = "app-usage-\(UUID().uuidString.lowercased())"
        guard sender?(id, .object(["type": .string("get_session_stats")])) == true else { return }
        inFlightID = id
        refreshQueued = false
    }

    /// A new transport answers only its own requests: forget what the old one
    /// owed and ask afresh.
    public func attached() {
        inFlightID = nil
        refreshQueued = false
        refresh()
    }

    /// Takes an `rpc_result`. False when it answers some other request.
    @discardableResult
    public func accept(id: String, response: JSONValue) -> Bool {
        guard id == inFlightID else { return false }
        inFlightID = nil
        // A failed ask keeps the last totals; the next boundary asks again.
        if response["success"]?.boolValue == true,
           let usage = SessionUsage(stats: response["data"]) {
            latest = usage
        }
        if refreshQueued { refresh() }
        return true
    }
}
