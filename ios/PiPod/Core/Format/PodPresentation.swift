import Foundation

/// The only translation from the server's lifecycle fields into words and visuals.
///
/// Stopped workspaces keep their local disk and archived workspaces restore from
/// cold storage. There is a single sandbox backend, so the retained-disk wording
/// is unconditional — no provider gets a weaker variant.
public struct PodPresentation: Hashable, Sendable {
    public let lifecycle: PodLifecycle
    /// What the status row says. Usually the lifecycle label, but storage truth and
    /// a bounded capacity wait both rename it.
    public let statusLabel: String
    /// The sentence under the status, when the state has one worth reading.
    public let statusDetail: String?
    /// Why this pod failed, screened for a person rather than an operator.
    public let userFacingReason: String?
    /// The image this pod runs (or the one it could not find).
    public let image: String?

    public init(pod: Pod) {
        let lifecycle = Self.lifecycle(of: pod)
        let storage = Self.statusStorage(pod, lifecycle)
        self.lifecycle = lifecycle
        self.statusLabel = storage.label
        self.statusDetail = storage.detail
        self.userFacingReason = Self.reason(pod, lifecycle)
        self.image = pod.resolvedConfig.image ?? Self.imageFromReason(pod.stateReason)
    }

    public var label: String { lifecycle.label }
    public var tone: StatusTone { lifecycle.tone }
    public var systemImage: String { lifecycle.systemImage }
    public var isTransitional: Bool { lifecycle.isTransitional }

    // MARK: - Status line

    private static func statusStorage(
        _ pod: Pod, _ lifecycle: PodLifecycle
    ) -> (label: String, detail: String?) {
        // Bounded capacity wait (capacity contract §1) overrides storage copy: the
        // request is queued, holding one concurrency slot but no host reservation.
        let wait = pod.capacityWait
        // A stale wait snapshot must never override a subsequently successful pod:
        // once the pod is really running, the wait is history, whatever it says.
        let settled = lifecycle == .running
        if let wait, wait.isWaiting, !settled {
            let secondsLeft = min(
                1 << 30, max(0, Int(ceil(Double(wait.deadlineInMs) / 1000)))
            )
            return (
                "Waiting for capacity",
                "No room for \(waitReasonShort(wait.reason)) yet · ~\(secondsLeft)s left"
            )
        }
        // Terminal wait states are final for this wait — but the backend is
        // ambiguous (the server may have admitted late), so no copy may claim
        // nothing was created or tell the user to unconditionally launch again.
        // Every remedy routes through checking THIS pod's status first. Only a
        // wake-kind cancel may call the pre-existing workspace untouched.
        if let wait, wait.isExpired, !settled {
            let wake = wait.kind == "wake"
            return (
                lifecycle.label,
                wake
                    ? "No room before the deadline · check status, then restore or retry this pod — do not create duplicates"
                    : "No room before the deadline · check this pod’s status before retrying — do not duplicate"
            )
        }
        if let wait, wait.isCancelled, !settled {
            let wake = wait.kind == "wake"
            return (
                lifecycle.label,
                wake
                    ? "Capacity wait cancelled · check status before retrying this pod"
                    : "Cancellation requested · check status before retrying — do not assume no backend was created"
            )
        }
        if lifecycle == .archived {
            switch pod.sandboxState {
            case "stopped": return (lifecycle.label, "· disk retained")
            case "archived": return (lifecycle.label, "· cold storage")
            // A bare logically hidden row claims nothing about storage.
            default: return (lifecycle.label, nil)
            }
        }
        if lifecycle == .asleep {
            switch pod.sandboxState {
            case "stopped":
                return ("Stopped", "Local disk retained · restarts in seconds")
            case "archived":
                return (
                    "Archived",
                    "Restores on next use · seconds-to-minutes depending on size"
                )
            default:
                return (lifecycle.label, nil)
            }
        }
        return (lifecycle.label, nil)
    }

    private static func waitReasonShort(_ reason: String?) -> String {
        switch reason {
        case "memory_capacity", "memory_debt": return "memory"
        case "disk_capacity": return "disk"
        case "cpu_capacity": return "CPU"
        case "transition_capacity": return "transition"
        case "network_capacity": return "network"
        case "fairness_degraded": return "fair CPU share"
        case "fleet_capacity": return "fleet"
        default: return "capacity"
        }
    }

    // MARK: - Lifecycle

    static func lifecycle(of pod: Pod) -> PodLifecycle {
        // A queued launch/wake pulses as transitional until the wait resolves;
        // terminal wait states fall through to the underlying mapping below.
        // A stale waiting snapshot on an already-ready pod is history, not state.
        if pod.capacityWait?.isWaiting == true, !pod.ready { return .starting }
        if pod.state == "archived" { return .archived }
        if pod.sandboxState == "gone" { return .unavailable }
        if pod.state == "failed" || pod.preparationPhase == "failed"
            || pod.sandboxState == "error" {
            return .failed
        }
        // `waiting-for-capacity` is the server's promoted launch phase while a
        // bounded capacity wait is live (`capacityWaitPhase`). It belongs with
        // the other pre-ready phases: the pod is not running, and reading it as
        // anything else was how a queued launch could render as ready.
        if pod.initializing
            || ["preparing-image", "provisioning-sandbox", "waiting-for-capacity", "running-init"]
                .contains(pod.preparationPhase ?? "")
            || ["preparing_image", "provisioning", "starting"]
                .contains(pod.sandboxState ?? "") {
            return .starting
        }
        if pod.state == "asleep"
            || (pod.state == "active"
                && ["stopped", "archived"].contains(pod.sandboxState ?? "")) {
            return .asleep
        }
        if pod.state == "active" { return .running }
        return .unavailable
    }

    // MARK: - Failure reason

    private static func reason(_ pod: Pod, _ lifecycle: PodLifecycle) -> String? {
        let raw = pod.stateReason ?? ""
        let lower = raw.lowercased()
        if lifecycle == .failed, lower.contains("image"),
           lower.contains("not found") || lower.contains("registry") {
            return """
                This pod’s sandbox couldn’t be created: The selected image could not be \
                found by your organization’s sandbox provider.
                """
        }
        guard let reason = pod.friendlyStateReason, !reason.isEmpty else { return nil }
        // Every sink for this text is a screen, and the server can put a runtime
        // exception in stateReason, so it is screened here rather than at each view.
        let screened = FriendlyError.message(serverText: reason)
        guard !pod.provider.isEmpty else { return screened }
        return replacingWholeWord(pod.provider, with: "sandbox provider", in: screened)
    }

    /// The image a failed launch names, for a pod whose resolved config never got
    /// one. Both straight and curly quotes, because the server writes either.
    private static func imageFromReason(_ reason: String?) -> String? {
        guard let reason else { return nil }
        let pattern = "image\\s+[\"\u{201C}]([^\"\u{201D}]+)[\"\u{201D}]"
        return firstCapture(in: reason, pattern: pattern)
    }

    private static func replacingWholeWord(
        _ word: String, with replacement: String, in text: String
    ) -> String {
        let pattern = "\\b" + NSRegularExpression.escapedPattern(for: word) + "\\b"
        guard let expression = try? NSRegularExpression(
            pattern: pattern, options: [.caseInsensitive]
        ) else { return text }
        return expression.stringByReplacingMatches(
            in: text,
            range: NSRange(text.startIndex..<text.endIndex, in: text),
            withTemplate: NSRegularExpression.escapedTemplate(for: replacement)
        )
    }
}

extension Pod {
    /// Convenience for the many call sites that only want the words.
    public var presentation: PodPresentation { PodPresentation(pod: self) }
}
