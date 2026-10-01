import Foundation

/// The durable state of a personal workstation, as the server reports it.
///
/// A workstation is a whole VM belonging to one person, not a slot in a shared
/// fleet. Nobody registers it, nobody else waits behind it, and starting one is
/// measured in minutes.
public enum WorkstationState: String, Sendable, Hashable, CaseIterable {
    case provisioning
    case starting
    case running
    case stopping
    case stopped
    case error
    case unknown
    case deleting
    case deleted

    /// Present tense, for a line that already says which workstation it is.
    public var label: String {
        switch self {
        case .provisioning: return "provisioning"
        case .starting: return "starting"
        case .running: return "running"
        case .stopping: return "stopping"
        case .stopped: return "stopped"
        case .error: return "error"
        case .unknown: return "unknown"
        case .deleting: return "deleting"
        case .deleted: return "deleted"
        }
    }
}

public enum WorkstationOperationKind: String, Sendable, Hashable, CaseIterable {
    case create
    case resume
    case stop
    case delete
    case publish
    case activate
    case ttl
}

public enum WorkstationOperationState: String, Sendable, Hashable, CaseIterable {
    case pending
    case running
    case uncertain
    case succeeded
    case failed
    case cancelled
}

/// The seven fields `GET /v1/workstations/:hostId` exposes, and the same seven
/// the host-demand 503 carries. Every one of them is optional here: a field the
/// client cannot validate is treated as absent rather than shown as a guess.
public struct WorkstationOperation: Sendable, Hashable {
    public let id: String?
    public let kind: WorkstationOperationKind?
    public let state: WorkstationOperationState?
    public let phase: String?
    public let deadlineAt: Date?
    public let retryAt: Date?
    public let errorCode: String?

    public init(
        id: String? = nil,
        kind: WorkstationOperationKind? = nil,
        state: WorkstationOperationState? = nil,
        phase: String? = nil,
        deadlineAt: Date? = nil,
        retryAt: Date? = nil,
        errorCode: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.state = state
        self.phase = phase
        self.deadlineAt = deadlineAt
        self.retryAt = retryAt
        self.errorCode = errorCode
    }

    /// Nothing renderable and nothing to schedule from: the same as absent.
    public var isEmpty: Bool {
        kind == nil && state == nil && phase == nil && deadlineAt == nil && errorCode == nil
    }

    /// Parses the operation object. Anything malformed reads as absent — the
    /// enums are the server's own contract, so an unrecognized one means this
    /// object is not the shape it claims to be.
    public static func parse(_ value: JSONValue?) -> WorkstationOperation? {
        guard let value, !value.isNull else { return nil }
        guard case .object = value else { return nil }

        // Identity and the two enums fail the whole object. The free-form fields
        // below only fail themselves: a deadline this build cannot parse must not
        // cost the reader the phase they could have seen.
        guard let id = optionalBounded(value["id"], limit: 128) else { return nil }
        guard let kind = optionalEnum(value["kind"], WorkstationOperationKind.self) else {
            return nil
        }
        guard let state = optionalEnum(value["state"], WorkstationOperationState.self) else {
            return nil
        }

        let operation = WorkstationOperation(
            id: id,
            kind: kind,
            state: state,
            phase: WorkstationDemandDetail.slug(value["phase"]),
            deadlineAt: WorkstationDemandDetail.timestamp(value["deadlineAt"]),
            retryAt: WorkstationDemandDetail.timestamp(value["retryAt"]),
            errorCode: WorkstationDemandDetail.slug(value["errorCode"])
        )
        return operation.isEmpty && operation.id == nil ? nil : operation
    }

    /// `.some(nil)` for an absent or null key, `.none` for a value that is
    /// present and wrong — the caller drops the whole object on the latter.
    private static func optionalEnum<T: RawRepresentable>(
        _ value: JSONValue?, _ type: T.Type
    ) -> T?? where T.RawValue == String {
        guard let value, !value.isNull else { return .some(nil) }
        guard let raw = value.stringValue, let parsed = T(rawValue: raw) else { return nil }
        return .some(parsed)
    }

    private static func optionalBounded(_ value: JSONValue?, limit: Int) -> String?? {
        guard let value, !value.isNull else { return .some(nil) }
        guard let text = value.stringValue, !text.isEmpty, text.count <= limit,
              text.unicodeScalars.allSatisfy({ $0.isASCII && $0.value >= 0x20 && $0.value != 0x7F })
        else { return nil }
        return .some(text)
    }
}

/// Why the server will not serve this request yet, when the reason is the
/// caller's own personal workstation.
///
/// The six reasons the server documents each carry their own static copy. A
/// reason this build does not know — a newer server, or the gateway's
/// `host_archived` close code — keeps its wire value and falls back to the
/// server's own sentence; the client never invents a reason or a promise.
public enum WorkstationReason: Sendable, Hashable {
    case hostStarting
    case hostStopped
    case hostRequiresReconciliation
    case boatStartsDisabled
    case hostDeleted
    case hostRetired
    case other(String)

    public init(wire: String) {
        switch wire {
        case "host_starting": self = .hostStarting
        case "host_stopped": self = .hostStopped
        case "host_requires_reconciliation": self = .hostRequiresReconciliation
        case "boat_starts_disabled": self = .boatStartsDisabled
        case "host_deleted": self = .hostDeleted
        case "host_retired": self = .hostRetired
        default: self = .other(wire)
        }
    }

    public var wire: String {
        switch self {
        case .hostStarting: return "host_starting"
        case .hostStopped: return "host_stopped"
        case .hostRequiresReconciliation: return "host_requires_reconciliation"
        case .boatStartsDisabled: return "boat_starts_disabled"
        case .hostDeleted: return "host_deleted"
        case .hostRetired: return "host_retired"
        case .other(let value): return value
        }
    }

    /// Whether the condition clears on its own. The server's `retryable` boolean
    /// is authoritative over this; it is only the fallback when the field is
    /// missing, and an unknown reason is never assumed to clear.
    public var defaultRetryable: Bool {
        switch self {
        case .hostStarting, .hostStopped, .hostRequiresReconciliation, .boatStartsDisabled:
            return true
        case .hostDeleted, .hostRetired, .other:
            return false
        }
    }

    /// The one sentence this state is allowed to claim. Nil for a reason this
    /// build does not know, whose copy is the server's own sentence instead.
    ///
    /// None of these promise a duration. Production spans from intent to a
    /// usable runtime run from 46 s on a warm host to 708 s on a cold one, so
    /// "several minutes" is the honest ceiling and a number would be a lie.
    public var message: String? {
        switch self {
        case .hostStarting:
            return "Your workstation is starting. This may take several minutes."
        case .hostStopped:
            return """
                Your workstation is asleep. Starting it now — this may take several minutes.
                """
        case .hostRequiresReconciliation:
            return "Your workstation is being checked. Retrying shortly."
        case .boatStartsDisabled:
            return """
                Workstation starts are paused right now. Your files are safe; try again shortly.
                """
        case .hostDeleted:
            return "Your workstation was deleted. A new one is created on your next launch."
        case .hostRetired:
            return "Your workstation was retired. A new one is created on your next launch."
        case .other:
            return nil
        }
    }
}

/// A validated `detail` from a host-demand refusal.
///
/// The server builds this object from an allowlist and recomputes `statusHref`
/// itself; the client repeats every check rather than trusting that, because a
/// forged path here would be a path this app then dials with the caller's token.
public struct WorkstationDemandDetail: Sendable, Hashable {
    /// Reasons that are never a workstation wait, whatever markers they arrive
    /// wearing. The first five are the server's `StartBlockedReason` billing
    /// contract, then legacy billing names; the rest are the shared fleet's own
    /// admission vocabulary (`sandboxfleet.ts`), which rides the identical
    /// `kind: "admission"` / `resource: "transitions"` / `unit: "count"`
    /// envelope and means the opposite thing: a pool with no room, not one
    /// person's VM coming up.
    static let nonWaitReasons: Set<String> = [
        "subscription_required", "trial_expired", "trial_hours_exhausted",
        "payment_past_due", "spend_cap_reached",
        "payment_required", "billing_required", "payment_failed",
        "transition_capacity", "fleet_capacity", "stale_capacity", "memory_debt",
        "memory_capacity", "cpu_capacity", "disk_capacity", "network_capacity",
        "fairness_degraded", "unsupported_shape", "unsupported_admission",
        "legacy_contract", "malformed_capacity", "host_mismatch",
        "host_unregistered", "fleet_unavailable", "capacity_wait_expired",
        "capacity_wait_orphaned",
    ]

    /// The six wire reasons the server's `BOAT_HOST_DEMAND_REASONS` allowlist
    /// admits (`safe-errors.ts`). A host-demand 503 carries one of these and
    /// nothing else, so they are the positive evidence this is a workstation.
    /// `host_archived` rides along because the gateway's own 4420 path
    /// allowlists it beside `host_starting` and `host_stopped`
    /// (`gateway/routes.ts`), and that frame is not run through the REST
    /// allowlist.
    static let waitReasons: Set<String> = Set(
        [
            WorkstationReason.hostStarting, .hostStopped, .hostRequiresReconciliation,
            .boatStartsDisabled, .hostDeleted, .hostRetired,
        ].map(\.wire)
    ).union(["host_archived"])

    /// The server's own sentence, kept because it is the documented fallback
    /// copy for a reason this build does not know.
    public let serverMessage: String
    public let reason: WorkstationReason
    public let retryable: Bool
    /// Present only when it matched the host-id grammar *and* its `statusHref`
    /// agreed with the path recomputed from it.
    public let hostId: String?
    public let state: WorkstationState?
    public let retryAfterMs: Int?
    public let operation: WorkstationOperation?

    public init(
        serverMessage: String,
        reason: WorkstationReason,
        retryable: Bool,
        hostId: String? = nil,
        state: WorkstationState? = nil,
        retryAfterMs: Int? = nil,
        operation: WorkstationOperation? = nil
    ) {
        self.serverMessage = serverMessage
        self.reason = reason
        self.retryable = retryable
        self.hostId = hostId
        self.state = state
        self.retryAfterMs = retryAfterMs
        self.operation = operation
    }

    /// The copy this state is allowed to show: the reason's own sentence, or the
    /// server's sentence when the reason is one this build does not know.
    public var message: String {
        if let known = reason.message { return known }
        let trimmed = serverMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, FriendlyText.readsAsProse(trimmed) else {
            return "Your workstation is not available yet."
        }
        return trimmed.hasSuffix(".") ? trimmed : "\(trimmed)."
    }

    /// The status path to dial, rebuilt from the validated id. Never the string
    /// the server sent.
    public var statusPath: String? {
        hostId.map { "/v1/workstations/\(WorkstationDemandDetail.encodeURIComponent($0))" }
    }

    // MARK: - Parsing

    /// Reads a REST failure. Nil for anything that is not this shape, including
    /// a 503 that names fleet capacity — a workstation wait is never a capacity
    /// wait, and misreading one as the other is the whole point of the check.
    public static func parse(_ error: APIError) -> WorkstationDemandDetail? {
        // The transport's own status, which a body cannot forge. A server that
        // omits it entirely (or a socket frame, which has no status) is still
        // read, because the three shape markers below are what identify this.
        if let status = error.transportStatus, status != 503 { return nil }
        return parse(detail: error.detail, serverMessage: error.error)
    }

    /// Reads a `detail` object straight off the wire — the REST body's `detail`,
    /// or the gateway `error` frame's, which carry the identical shape.
    /// A 4420 close whose *reason string* is a host reason, with no preceding
    /// error frame. Same wait as REST, unhosted (no status poll until attach).
    public static func fromCloseReason(_ reason: String) -> WorkstationDemandDetail? {
        guard WorkstationCloseReason.names(reason) else { return nil }
        let parsed = WorkstationReason(wire: reason)
        return WorkstationDemandDetail(
            serverMessage: parsed.message ?? "Your workstation is starting. This may take several minutes.",
            reason: parsed,
            retryable: parsed.defaultRetryable
        )
    }

    public static func parse(
        detail: JSONValue?, serverMessage: String
    ) -> WorkstationDemandDetail? {
        guard let detail, case .object = detail else { return nil }
        // `kind`/`resource`/`unit` are fixed by the server for exactly this
        // refusal — but they are *not* sufficient. The shared fleet's own
        // capacity refusal carries the identical three markers (a
        // `transition_capacity` throw from `sandboxfleet.ts` is byte-for-byte
        // this envelope), and reading that as "your workstation is starting"
        // puts a personal-workstation card, and a twenty-minute retry loop, in
        // front of a pool that is simply full.
        guard detail["kind"]?.stringValue == "admission",
              detail["resource"]?.stringValue == "transitions",
              detail["unit"]?.stringValue == "count",
              let rawReason = slug(detail["reason"]),
              // Billing refusals ride the same typed-detail mechanism but are
              // never waits: they are terminal, unpollable, and owned by the
              // billing copy. Without this, a spend-cap refusal carrying the
              // admission markers would parse as an unknown workstation
              // reason and steal the billing copy.
              !Self.nonWaitReasons.contains(rawReason)
        else { return nil }

        // Positive evidence that this refusal is about one person's workstation:
        // either the server named one of its six host-demand reasons, or it
        // named the workstation itself. The fleet detail carries neither — it
        // has no `hostId` and no `statusHref` — so an unknown reason without a
        // host id is left to the capacity copy rather than adopted as a wait.
        let validatedHost = validatedHostId(detail)
        guard Self.waitReasons.contains(rawReason) || validatedHost != nil else { return nil }

        let reason = WorkstationReason(wire: rawReason)
        let retryable = detail["retryable"]?.boolValue ?? reason.defaultRetryable

        return WorkstationDemandDetail(
            serverMessage: serverMessage,
            reason: reason,
            retryable: retryable,
            hostId: validatedHost,
            state: state(detail["state"]),
            retryAfterMs: retryAfterMs(detail["retryAfterMs"]),
            operation: WorkstationOperation.parse(detail["operation"])
        )
    }

    /// The host id, but only when the `statusHref` beside it is exactly the path
    /// this client would have built. A disagreement drops both and the wait
    /// falls back to re-issuing the original request, which is safe.
    private static func validatedHostId(_ detail: JSONValue) -> String? {
        guard let raw = detail["hostId"]?.stringValue, isValidHostId(raw) else { return nil }
        guard let href = detail["statusHref"] else { return raw }
        // Present but not a string is malformed, not absent.
        guard let text = href.stringValue,
              text == "/v1/workstations/\(encodeURIComponent(raw))"
        else { return nil }
        return raw
    }

    /// `^boat-[A-Za-z0-9._-]{1,180}$`, the server's own grammar.
    public static func isValidHostId(_ value: String) -> Bool {
        guard value.count >= 6, value.count <= 185, value.hasPrefix("boat-") else { return false }
        let rest = value.dropFirst(5)
        guard !rest.isEmpty, rest.count <= 180 else { return false }
        return rest.allSatisfy { character in
            character.isASCII
                && (character.isLetter || character.isNumber || character == "."
                    || character == "_" || character == "-")
        }
    }

    /// JavaScript's `encodeURIComponent`, so the recomputed path is compared
    /// against the same spelling the server produced.
    static func encodeURIComponent(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    static func state(_ value: JSONValue?) -> WorkstationState? {
        guard let raw = value?.stringValue else { return nil }
        return WorkstationState(rawValue: raw)
    }

    /// 0–300000 ms, per the server's own bound. Anything else is absent, so the
    /// wait falls back to its default interval instead of adopting a bad number.
    static func retryAfterMs(_ value: JSONValue?) -> Int? {
        guard let number = value?.doubleValue, number.isFinite,
              number >= 0, number <= 300_000
        else { return nil }
        return Int(number.rounded())
    }

    /// A bounded lowercase technical token: `vendor`, `command:install`,
    /// `poll:activate`, `confirm-ready`. Rendered as a detail, never as copy.
    static func slug(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue, !text.isEmpty, text.count <= 64 else { return nil }
        let allowed = text.allSatisfy { character in
            character.isASCII
                && (character.isLowercase && character.isLetter || character.isNumber
                    || character == "_" || character == "-" || character == ":"
                    || character == ".")
        }
        return allowed ? text : nil
    }

    static func timestamp(_ value: JSONValue?) -> Date? {
        guard let text = value?.stringValue else { return nil }
        return Format.date(text)
    }
}

/// The answer from `GET /v1/workstations/:hostId` — the durable truth, which
/// answers immediately and never blocks on the vendor.
public struct WorkstationStatus: Sendable, Hashable {
    public let hostId: String
    public let state: WorkstationState?
    public let operation: WorkstationOperation?

    public init(hostId: String, state: WorkstationState?, operation: WorkstationOperation?) {
        self.hostId = hostId
        self.state = state
        self.operation = operation
    }

    public var isRunning: Bool { state == .running }

    /// Parses a status body against the id that was asked for. A body naming a
    /// different workstation is not an answer to this question.
    public static func parse(_ value: JSONValue, requested: String) -> WorkstationStatus? {
        guard case .object = value else { return nil }
        if let reported = value["hostId"]?.stringValue, reported != requested { return nil }
        return WorkstationStatus(
            hostId: requested,
            state: WorkstationDemandDetail.state(value["state"]),
            operation: WorkstationOperation.parse(value["operation"])
        )
    }
}
