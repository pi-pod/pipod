import Foundation

// MARK: - Environments (templates)

/// One environment: the setup and bake scripts a pod starts from, plus its
/// config bundle.
///
/// There is no draft state. Server migration 031 dropped the column and the API
/// synthesises `status: "active"` for every row, so the field is decoded only
/// for tolerance — an older or newer server that omits it still decodes rather
/// than dropping the environment into `unparsedRows`.
public struct PodTemplate: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let description: String?
    public let status: String
    public let initScript: String?
    /// What the agent in every pod launched from this environment is told, chiefly
    /// the access its pods are meant to have. Nil when the server predates the
    /// field, which is different from "" (none): a save must not send what it
    /// never read.
    public let agentInstructions: String?
    public let config: JSONValue
    public let createdFromPod: String?
    /// The optimistic-concurrency token a save sends back as `expectedVersion`.
    /// Zero means the server reported none, and a save then goes out without the
    /// key rather than claiming to have read a version it never saw.
    public let version: Int
    public let createdAt: String
    public let updatedAt: String

    /// The version to write with, or nil when this server does not version
    /// templates at all.
    public var expectedVersion: Int? { version > 0 ? version : nil }

    public init(
        id: String,
        name: String,
        description: String? = nil,
        status: String = "active",
        initScript: String? = nil,
        agentInstructions: String? = nil,
        config: JSONValue = .object([:]),
        createdFromPod: String? = nil,
        version: Int = 0,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.status = status
        self.initScript = initScript
        self.agentInstructions = agentInstructions
        self.config = config
        self.createdFromPod = createdFromPod
        self.version = version
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "active"
        initScript = try container.decodeIfPresent(String.self, forKey: .initScript)
        agentInstructions = try container.decodeIfPresent(String.self, forKey: .agentInstructions)
        config = try container.decodeIfPresent(JSONValue.self, forKey: .config) ?? .object([:])
        createdFromPod = try container.decodeIfPresent(String.self, forKey: .createdFromPod)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 0
        createdAt = try container.decode(String.self, forKey: .createdAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}

/// Everything the environment editor sends in one write.
///
/// `bakeScript` is optional because "never loaded" and "cleared" are different
/// facts. The server's PATCH `COALESCE`s an absent key to the stored value and
/// takes an empty string literally, so a draft built before the editor data
/// arrived must omit the key rather than send "".
public struct TemplateDraft: Equatable, Sendable {
    public let name: String
    public let description: String
    public let initScript: String
    public let bakeScript: String?
    /// Nil leaves the stored instructions alone, for the same reason as
    /// `bakeScript`: a server that never reported them must not have them erased.
    public let agentInstructions: String?
    public let config: JSONValue
    /// The version the editor opened this environment at, when the server
    /// reported one. A save that carries it is refused if someone else wrote
    /// meanwhile.
    public let expectedVersion: Int?

    public init(
        name: String,
        description: String,
        initScript: String,
        bakeScript: String? = nil,
        agentInstructions: String? = nil,
        config: JSONValue,
        expectedVersion: Int? = nil
    ) {
        self.name = name
        self.description = description
        self.initScript = initScript
        self.bakeScript = bakeScript
        self.agentInstructions = agentInstructions
        self.config = config
        self.expectedVersion = expectedVersion
    }

    /// What a form's bake-script field is worth sending.
    ///
    /// `isLoaded` is false while the editor is showing an empty field because
    /// the stored script has not arrived — not because anyone cleared it. Those
    /// two look identical on screen and must not look identical on the wire.
    public static func bakeScript(typed: String, isLoaded: Bool) -> String? {
        guard isLoaded else { return nil }
        return typed.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Resolved launch configuration

public struct InitStepStatus: Codable, Hashable, Sendable {
    public let scope: String
    public let status: String

    public init(scope: String, status: String) {
        self.scope = scope
        self.status = status
    }
}

public struct PiSettingsStatus: Codable, Hashable, Sendable {
    public let files: [String]
    public let bytes: Int
    public let packageCount: Int
    public let droppedKeys: [String]
    public let status: String
    public let installedPackageCount: Int?
    public let failedPackageCount: Int?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        files = try container.decodeIfPresent([String].self, forKey: .files) ?? []
        bytes = try container.decodeIfPresent(Int.self, forKey: .bytes) ?? 0
        packageCount = try container.decodeIfPresent(Int.self, forKey: .packageCount) ?? 0
        droppedKeys = try container.decodeIfPresent([String].self, forKey: .droppedKeys) ?? []
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
        installedPackageCount = try container.decodeIfPresent(Int.self, forKey: .installedPackageCount)
        failedPackageCount = try container.decodeIfPresent(Int.self, forKey: .failedPackageCount)
    }
}

public struct ImagePreparationStatus: Codable, Hashable, Sendable {
    public let ref: String
    public let status: String
    public let managed: Bool
    public let provenance: String
    public let assetDigest: String?
}

public struct BakeStatus: Codable, Hashable, Sendable {
    public let digest: String
    public let mode: String
    public let status: String
}

/// Bounded capacity-wait view (capacity contract §1). Absent when the pod never
/// queued; older servers omit the field, which reads exactly like absent.
public struct CapacityWaitDetail: Codable, Hashable, Sendable {
    public let kind: String
    public let reason: String
    public let resource: String?
    public let unit: String?
    public let retryable: Bool?
    public let retryAfterMs: Int?
    public let required: Double?
    public let available: Double?
    public let budget: Double?
    public let committed: Double?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "admission"
        reason = try container.decodeIfPresent(String.self, forKey: .reason) ?? ""
        resource = try container.decodeIfPresent(String.self, forKey: .resource)
        unit = try container.decodeIfPresent(String.self, forKey: .unit)
        retryable = try container.decodeIfPresent(Bool.self, forKey: .retryable)
        retryAfterMs = try container.decodeIfPresent(Int.self, forKey: .retryAfterMs)
        required = try container.decodeIfPresent(Double.self, forKey: .required)
        available = try container.decodeIfPresent(Double.self, forKey: .available)
        budget = try container.decodeIfPresent(Double.self, forKey: .budget)
        committed = try container.decodeIfPresent(Double.self, forKey: .committed)
    }
}

public struct CapacityWaitState: Codable, Hashable, Sendable {
    public let state: String
    public let reason: String?
    public let detail: CapacityWaitDetail?
    public let attempts: Int
    public let deadlineInMs: Int
    public let cancelRequested: Bool
    /// Future create/wake discriminator (capacity lead, in progress). Tolerated
    /// and unused: cancel must never delete or stop on a wake-kind wait — only
    /// the cooperative cancel or an explicit delete ends it.
    public let kind: String?

    public var isWaiting: Bool { state == "waiting" }
    public var isExpired: Bool { state == "expired" }
    public var isCancelled: Bool { state == "cancelled" }
    public var isAdmitted: Bool { state == "admitted" }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(String.self, forKey: .state)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        detail = try container.decodeIfPresent(CapacityWaitDetail.self, forKey: .detail)
        attempts = try container.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
        deadlineInMs = try container.decodeIfPresent(Int.self, forKey: .deadlineInMs) ?? 0
        cancelRequested = try container.decodeIfPresent(Bool.self, forKey: .cancelRequested) ?? false
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
    }
}

public struct EgressInfo: Codable, Hashable, Sendable {
    public let description: String
    public let mode: String

    public init(description: String = "", mode: String = "unknown") {
        self.description = description
        self.mode = mode
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        description = try container.decodeIfPresent(String.self, forKey: .description) ?? ""
        mode = try container.decodeIfPresent(String.self, forKey: .mode) ?? "unknown"
    }
}

public struct PodResolvedConfig: Codable, Hashable, Sendable {
    public let clamps: [PolicyClamp]
    public let secretKeys: [String]
    public let secretScopes: [String: String]?
    public let initSteps: [InitStepStatus]?
    public let piAuthProviders: [String]?
    public let piSettings: PiSettingsStatus?
    public let imagePreparation: ImagePreparationStatus?
    public let bake: BakeStatus?
    public let egress: EgressInfo
    public let warnings: [String]
    public let idleTimeoutMinutes: Int?
    public let archiveAfterMinutes: Int?
    public let image: String?

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        clamps = try container.decodeIfPresent([PolicyClamp].self, forKey: .clamps) ?? []
        secretKeys = try container.decodeIfPresent([String].self, forKey: .secretKeys) ?? []
        secretScopes = try container.decodeIfPresent([String: String].self, forKey: .secretScopes)
        initSteps = try container.decodeIfPresent([InitStepStatus].self, forKey: .initSteps)
        piAuthProviders = try container.decodeIfPresent([String].self, forKey: .piAuthProviders)
        piSettings = try container.decodeIfPresent(PiSettingsStatus.self, forKey: .piSettings)
        imagePreparation = try container.decodeIfPresent(
            ImagePreparationStatus.self, forKey: .imagePreparation
        )
        bake = try container.decodeIfPresent(BakeStatus.self, forKey: .bake)
        egress = try container.decodeIfPresent(EgressInfo.self, forKey: .egress) ?? EgressInfo()
        warnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
        idleTimeoutMinutes = try container.decodeIfPresent(Int.self, forKey: .idleTimeoutMinutes)
        archiveAfterMinutes = try container.decodeIfPresent(Int.self, forKey: .archiveAfterMinutes)
        image = try container.decodeIfPresent(String.self, forKey: .image)
    }

    public static let empty: PodResolvedConfig = {
        // Decoding an empty object exercises exactly the defaults above.
        try! JSONCoding.decode(PodResolvedConfig.self, from: .object([:]))
    }()
}

// MARK: - Pod

public struct Pod: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let templateId: String?
    public let userId: String
    public let parentPodId: String?
    public let hostPodId: String?
    public let hostPodName: String?
    public let location: String?
    public let name: String
    public let project: String?
    public let provider: String
    public let state: String
    public let ready: Bool
    public let initializing: Bool
    public let preparationPhase: String?
    public let sandboxState: String?
    /// The server's own verdict about the live transport: `connected`,
    /// `reconnecting`, `detached` or `asleep`. It is computed from the gateway
    /// session and the heartbeat lease (`podConnection` in `pods/routes.ts`),
    /// which is knowledge no client can derive — `reconnecting` in particular
    /// has no local equivalent. Optional: a server that does not send it leaves
    /// the derived predicates below exactly as they were.
    public let connection: String?
    public let capacityWait: CapacityWaitState?
    public let stateReason: String?
    /// The typed launch-failure classification when the failure recorder made
    /// one — `capacity_wait_expired`, `capacity_wait_orphaned` or
    /// `admission_denied`. Nil for every other failure.
    public let stateReasonCode: String?
    public let lastActivityAt: String?
    public let createdAt: String
    public let resolvedConfig: PodResolvedConfig

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        templateId = try container.decodeIfPresent(String.self, forKey: .templateId)
        userId = try container.decode(String.self, forKey: .userId)
        parentPodId = try container.decodeIfPresent(String.self, forKey: .parentPodId)
        hostPodId = try container.decodeIfPresent(String.self, forKey: .hostPodId)
        hostPodName = try container.decodeIfPresent(String.self, forKey: .hostPodName)
        location = try container.decodeIfPresent(String.self, forKey: .location)
        name = try container.decode(String.self, forKey: .name)
        project = try container.decodeIfPresent(String.self, forKey: .project)
        provider = try container.decode(String.self, forKey: .provider)
        state = try container.decode(String.self, forKey: .state)
        ready = try container.decodeIfPresent(Bool.self, forKey: .ready) ?? false
        initializing = try container.decodeIfPresent(Bool.self, forKey: .initializing) ?? false
        preparationPhase = try container.decodeIfPresent(String.self, forKey: .preparationPhase)
        sandboxState = try container.decodeIfPresent(String.self, forKey: .sandboxState)
        connection = try container.decodeIfPresent(String.self, forKey: .connection)
        capacityWait = try container.decodeIfPresent(CapacityWaitState.self, forKey: .capacityWait)
        stateReason = try container.decodeIfPresent(String.self, forKey: .stateReason)
        stateReasonCode = try container.decodeIfPresent(String.self, forKey: .stateReasonCode)
        lastActivityAt = try container.decodeIfPresent(String.self, forKey: .lastActivityAt)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        resolvedConfig = try container.decodeIfPresent(
            PodResolvedConfig.self, forKey: .resolvedConfig
        ) ?? .empty
    }

    public var projectName: String? {
        let trimmed = project?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    /// Where the pod lives: the provider for a machine-backed pod, `on <host>`
    /// for a co-located child. Prefers the server's derived field and falls back
    /// so an older payload still has something to print.
    public var displayLocation: String {
        if let value = location?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
            return value
        }
        if hostPodId != nil {
            let host = hostPodName?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let host, !host.isEmpty { return "on \(host)" }
            return "on host"
        }
        return provider
    }

    public var isHostChild: Bool { hostPodId != nil }
    public var isLive: Bool { state == "active" }
    public var isArchived: Bool { state == "archived" }
    public var isGone: Bool { sandboxState == "gone" }
    public var didFail: Bool { state == "failed" || preparationPhase == "failed" || isGone }
    /// The server's verdict when it sent one — it computes the same condition
    /// from the same two columns — and the derived one otherwise.
    public var isAsleep: Bool {
        if let connection { return connection == "asleep" }
        return isLive && (sandboxState == "stopped" || sandboxState == "archived")
    }

    /// The gateway lost this pod's session and is bringing it back. Only the
    /// server knows this; there is no local signal for it.
    public var isReconnecting: Bool { connection == "reconnecting" }

    public var canOpenSession: Bool { isLive && !initializing && !didFail }
    public var canOpenConversation: Bool { isLive && !didFail }

    /// A sentence about why this pod failed, with the operator instructions the
    /// server writes for whoever runs the control plane taken back out.
    public var friendlyStateReason: String? {
        // A gone sandbox whose launch was refused for admission still carries
        // the host's allowlisted amounts. The generic "no longer exists"
        // sentence would hide them (POST 201, then gone with
        // `launch_failed:admission_denied` and GiB figures).
        let typedCode = stateReasonCode ?? stateReason.flatMap(Pod.launchFailureCode)
        if isGone, typedCode != "admission_denied" {
            return """
                This pod’s sandbox no longer exists, so it can’t be opened. Launch a new \
                pod to keep working.
                """
        }
        guard didFail, let reason = stateReason, !reason.isEmpty else { return nil }
        // A typed failure carries its code inline as `launch_failed:<code>: …`,
        // which is bookkeeping rather than a sentence: showing it raw put
        // "launch_failed:capacity_wait_expired:" in front of the reader.
        let stripped = Pod.withoutLaunchFailureCode(reason)
        switch typedCode {
        case "capacity_wait_expired":
            return """
                This pod waited for sandbox capacity and the wait ran out before a host had \
                room. Nothing is running yet — launch it again when you like.
                """
        case "admission_denied":
            // "sandbox hosts at capacity (memory_capacity): 4.00 GiB required, 0.12 GiB
            // available of 12.12 GiB budget" — the figures are worth keeping, the jargon is not.
            let figures = stripped.range(
                of: #"([0-9.]+) GiB required, ([0-9.]+) GiB available"#, options: .regularExpression
            ).map { String(stripped[$0]) }
            let numbers = figures?.split(separator: " ").compactMap { Double($0) } ?? []
            let need = numbers.count == 2
                ? " (\(Self.gib(numbers[0])) needed, \(Self.gib(numbers[1])) free)"
                : ""
            return """
                No room to start this pod: the server is full\(need). Stop a pod you \
                aren’t using, then launch again.
                """
        case "capacity_wait_orphaned":
            return """
                This pod’s capacity wait stopped being tracked before a host had room. \
                Nothing is running yet — launch it again when you like.
                """
        default:
            break
        }
        let cleaned = FriendlyText.withoutOperatorInstructions(stripped)
        if cleaned.isEmpty { return nil }
        let prefix = "provisioning failed:"
        guard cleaned.lowercased().hasPrefix(prefix) else { return cleaned }
        let detail = String(cleaned.dropFirst(prefix.count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return detail.isEmpty
            ? "This pod’s sandbox couldn’t be created."
            : "This pod’s sandbox couldn’t be created: \(detail)"
    }

    private static func gib(_ value: Double) -> String {
        value == value.rounded() ? "\(Int(value)) GiB" : String(format: "%.1f GiB", value)
    }

    /// The codes `formatLaunchFailure` prefixes onto `state_reason`. The
    /// allowlist is closed on the server, so it is closed here too: anything
    /// else is prose that happens to start with a colon-separated word.
    static let launchFailureCodes: Set<String> = [
        "capacity_wait_expired", "capacity_wait_orphaned", "admission_denied",
    ]

    private static let launchFailurePrefix = "launch_failed:"

    /// The typed code a `state_reason` carries inline, for a server that writes
    /// the prefix without also sending `stateReasonCode`.
    static func launchFailureCode(_ stateReason: String) -> String? {
        guard stateReason.hasPrefix(launchFailurePrefix) else { return nil }
        let code = stateReason.dropFirst(launchFailurePrefix.count)
            .prefix { $0 != ":" }
            .trimmingCharacters(in: .whitespaces)
        return launchFailureCodes.contains(code) ? code : nil
    }

    /// The human half of a typed `state_reason`, with the `launch_failed:<code>:`
    /// bookkeeping taken off the front.
    static func withoutLaunchFailureCode(_ stateReason: String) -> String {
        guard launchFailureCode(stateReason) != nil else { return stateReason }
        let afterPrefix = stateReason.dropFirst(launchFailurePrefix.count)
        guard let colon = afterPrefix.firstIndex(of: ":") else { return stateReason }
        return String(afterPrefix[afterPrefix.index(after: colon)...])
            .trimmingCharacters(in: .whitespaces)
    }
}

/// `GET /v1/pods` — the rows plus whatever else rode the envelope.
public struct PodsPage: Sendable {
    public let pods: DecodedList<Pod>
    /// SaaS only. Nil under the self-hosted backend, which does not send it.
    public let billing: BillingSummary?

    public init(pods: DecodedList<Pod>, billing: BillingSummary? = nil) {
        self.pods = pods
        self.billing = billing
    }
}

// MARK: - Launch

public struct LaunchReport: Codable, Hashable, Sendable {
    public let clamps: [PolicyClamp]
    public let secretKeys: [String]
    public let warnings: [String]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        clamps = try container.decodeIfPresent([PolicyClamp].self, forKey: .clamps) ?? []
        secretKeys = try container.decodeIfPresent([String].self, forKey: .secretKeys) ?? []
        warnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
    }
}

public struct LaunchResponse: Codable, Hashable, Sendable {
    public let pod: Pod
    public let report: LaunchReport
}

public enum LaunchAttempt: Sendable {
    case admitted(LaunchResponse)
    case pending
}

public struct LaunchOperationSnapshot: Codable, Hashable, Sendable {
    public let operationId: String
    public let state: String
    public let launch: LaunchResponse?
    public let podDeleted: Bool?
    public let errorStatus: Int?
    public let errorCode: String?
}
