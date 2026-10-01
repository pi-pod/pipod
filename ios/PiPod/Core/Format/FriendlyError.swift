import Foundation

/// The transport failures worth distinct copy. Anything else stays generic.
public enum NetworkFailure {
    case offline
    case timedOut
    case cannotReachHost
    case cancelled
    case other

    /// `URLError` is authoritative on Apple platforms; nothing else is guessed at.
    public static func tryParse(_ error: Error) -> NetworkFailure? {
        guard let urlError = error as? URLError else { return nil }
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .internationalRoamingOff,
             .dataNotAllowed:
            return .offline
        case .timedOut:
            return .timedOut
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .secureConnectionFailed,
             .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot,
             .cannotLoadFromNetwork, .resourceUnavailable:
            return .cannotReachHost
        case .cancelled:
            return .cancelled
        default:
            return .other
        }
    }
}

/// One place that turns transport and server errors into copy a person can act
/// on, so raw `URLError` / HTTP strings never reach a screen.
public enum FriendlyError {
    public static let fallbackMessage =
        "Something went wrong talking to the server. Check your connection and try again."

    /// A failure the server owns: telling the person to check their connection
    /// would send them after the wrong problem.
    public static let serverFallbackMessage =
        "Something went wrong on the server. Try again in a moment."

    /// Genuine fleet pressure on the self-hosted backend, where a shared pool of
    /// sandbox hosts really is out of room and an owner really can register more.
    ///
    /// This must never be shown for a personal workstation. A workstation is one
    /// VM belonging to one person; nobody registers it, and telling its owner to
    /// ask for capacity sends them after a problem that does not exist. Those
    /// refusals are recognized by `WorkstationDemandDetail` and answered by
    /// `workstationMessage` instead.
    public static let fleetPressureMessage = """
        The fleet is at capacity and has no room for a new sandbox right now. \
        Retry shortly — stopped pods keep their files and archived pods restore later, \
        so do not create duplicates. If this persists, ask an owner to register capacity.
        """

    /// What is true of every workstation state: the disk is the workstation's
    /// own, so nothing is lost by waiting and nothing needs recreating.
    public static let workstationFilesRetained = "Your files are kept."

    /// Cancelling ends the client's wait and nothing else.
    public static let workstationWaitCancelled = """
        Stopped waiting. Your workstation keeps starting on the server and your files are \
        kept — try again whenever you like and you will get the same workstation.
        """

    /// A budget that ran out is not a workstation that failed.
    public static let workstationStillStarting = """
        Your workstation is still starting on the server. Nothing was lost — try again to \
        keep waiting, and do not launch a second pod.
        """

    /// Copy for a refusal that names the caller's own personal workstation.
    ///
    /// The reason's sentence is the anchor; the only thing added is what it means
    /// for the reader's files and their next step. No duration is promised —
    /// production spans run from under a minute on a warm host to nearly twelve
    /// on a cold one — and no fleet, capacity or duplicate-launch advice appears.
    public static func workstationMessage(_ detail: WorkstationDemandDetail) -> String {
        let anchor = detail.message
        switch detail.reason {
        case .hostDeleted, .hostRetired:
            return anchor
        default:
            break
        }
        return detail.retryable ? "\(anchor) \(workstationFilesRetained)" : anchor
    }

    public static let unsupportedShapeMessage = """
        That sandbox shape is not available on a qualified host (8 GiB is gated opt-in; \
        standard is 4 GiB). The request was not silently clamped — retry at the standard \
        shape (4 GiB) or wait for qualified capacity.
        """

    public static let temporarilyUnavailableMessage = """
        The pod is mid-transition (starting, stopping, or restoring). \
        Retry shortly without creating a duplicate pod.
        """

    public static let fairnessDegradedMessage = """
        CPU fairness is temporarily degraded. Existing sandboxes keep running — \
        retry shortly without creating duplicates.
        """

    public static let productConcurrencyPolicy = 20

    public static func message(_ error: Error, serverHost: String? = nil) -> String {
        if let apiError = error as? APIError { return apiMessage(apiError) }
        if let rejected = error as? AuthorizationRejected {
            return authorizationMessage(rejected)
        }
        if let invalid = error as? InvalidIDTokenError {
            return "Sign-in couldn’t be completed. Try signing in again."
                + " (\(invalid.message))"
        }
        if error is SessionExpiredError {
            return "You’re signed out. Sign in again to continue."
        }
        if error is AuthContextChangedError {
            return "Your account changed while this request was running. Try again."
        }
        if let transient = error as? TransientAuthError {
            return serverText(transient.message)
        }
        return transportOrFallback(error, serverHost: serverHost)
    }

    /// The server is configured as a `URL`, which is what every call site has.
    public static func message(_ error: Error, serverHost: URL?) -> String {
        message(error, serverHost: serverHost?.host)
    }

    /// A bare server sentence, with no exception wrapper around it.
    public static func message(serverText text: String) -> String { serverText(text) }

    /// OAuth 2.0 / OIDC authorization error codes. `access_denied` is what a
    /// person taps Cancel to produce, so it must not read like a failure — and
    /// none of the codes themselves belong on screen.
    private static func authorizationMessage(_ rejected: AuthorizationRejected) -> String {
        switch rejected.code {
        case "access_denied":
            return "Sign-in was cancelled."
        case "login_required", "interaction_required", "consent_required",
             "account_selection_required":
            return "Sign-in needs to be finished in the browser. Try again."
        case "temporarily_unavailable", "server_error":
            return "The sign-in service is having trouble. Try again in a moment."
        case "invalid_scope", "invalid_request", "unauthorized_client",
             "unsupported_response_type", "invalid_client":
            // A configuration problem between this build and the provider. The
            // person cannot fix it, so do not send them round the loop again.
            return """
                This app couldn’t be signed in. Update pi pod, and contact support if it \
                keeps happening.
                """
        default:
            let detail = rejected.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let detail, !detail.isEmpty, FriendlyText.readsAsProse(detail) {
                return FriendlyText.withoutOperatorInstructions(detail)
            }
            return "Sign-in couldn’t be completed. Try signing in again."
        }
    }

    // MARK: - API failures

    private static func apiMessage(_ error: APIError) -> String {
        if error.error == "not signed in" {
            return "You’re signed out. Sign in again to continue."
        }
        if let credential = credentialMessage(error) { return credential }
        if let billing = billingRefusalMessage(error) { return billing }
        // Before the workstation branch: the fleet's capacity refusal and a
        // host-demand refusal share an envelope, and only the reason tells them
        // apart. `typedCapacityMessage` answers exactly the fleet's own reasons,
        // none of which is a workstation reason, so asking it first means a
        // shared-fleet refusal can never be worded as "your workstation is
        // starting" even if a future detail shape slips past the parser.
        if let typed = typedCapacityMessage(error) { return typed }
        if let workstation = WorkstationDemandDetail.parse(error) {
            return workstationMessage(workstation)
        }

        // A bare HTTP 5xx without a typed reason or a known fleet sentence is not
        // fleet pressure (database, auth, and upstream trouble all share the code).
        if error.error.hasPrefix("HTTP 5") {
            return "The server ran into a problem (\(error.error)). Try again in a moment."
        }
        if error.detailCode == "pod_not_attached" {
            return """
                The pod isn’t attached right now. The approval stays pending — start or \
                attach the pod, then try again.
                """
        }

        if let capacity = capacitySentence(error.error, detail: error.detailText) {
            return capacity
        }
        if let known = FriendlyText.knownServerFailure(error.error) { return known }

        let detail = error.detailText
        let friendlyDetail = (detail.map(FriendlyText.readsAsProse) ?? false) ? detail : nil
        return FriendlyText.readsAsProse(error.error)
            ? FriendlyText.failure(error.error, detail: friendlyDetail)
            : serverFallbackMessage
    }

    // MARK: - Billing refusals

    /// A refusal the server owns because of billing: an HTTP 402 whose detail
    /// carries `kind: "billing"` and one of the five `StartBlockedReason`
    /// values. Each case is anchored on the server's own `startBlockedMessage`
    /// sentence, plus only validated numbers from the allowlisted detail
    /// fields — never a price, a tier or a policy the server did not send.
    ///
    /// None of these is a retryable wait: they do not poll, they never suggest
    /// retrying in a loop, and the workstation wait never adopts them (see
    /// `WorkstationDemandDetail.nonWaitReasons`). An unrecognized reason is not
    /// a billing refusal at all and falls through to the generic copy.
    public static func billingRefusalMessage(_ error: APIError) -> String? {
        // The contract in full: the status the server refuses billing with, the
        // discriminator on the detail, and a machine reason read only from the
        // detail. Switching on `error.error` as well let any response at any
        // status whose prose happened to read `trial_expired` print billing copy
        // — dollar figures included — for something that was never a refusal.
        guard error.transportStatus == 402,
              error.detail?["kind"]?.stringValue == "billing",
              let reason = error.detailString("reason") ?? error.detailCode
        else { return nil }
        // The 402 detail contract: cent amounts, hour floats, an ISO date.
        let capUsd = billingUsdCents(error, "spendCapUsdCents")
        let projectedUsd = billingUsdCents(error, "projectedSpendUsdCents")
        let used = billingAmount(error, "activeHoursUsed")
        let included = billingAmount(error, "includedActiveHours")
        let periodEnd = billingDate(error, "currentPeriodEnd")

        switch reason {
        case "subscription_required":
            return "Your workstation needs an active subscription before it "
                + "can start. \(workstationFilesRetained)"
        case "trial_expired":
            var text = "Your trial has ended; subscribe to start your "
                + "workstation again."
            if let used, let included {
                text += " (\(BillingSummary.hours(used)) of "
                    + "\(BillingSummary.hours(included)) active hours used.)"
            }
            return "\(text) \(workstationFilesRetained)"
        case "trial_hours_exhausted":
            // A trial's hour grant replaces the plan allowance, so the
            // included figure beside a trialing refusal is the trial grant.
            if let included {
                return "Your trial includes \(BillingSummary.hours(included)) "
                    + "active hours and they are used up; subscribe to "
                    + "continue. \(workstationFilesRetained)"
            }
            return "Your trial hours are used up; subscribe to continue. "
                + "\(workstationFilesRetained)"
        case "payment_past_due":
            return "Your last payment failed and the grace period has ended; "
                + "update your payment method to start again. "
                + "\(workstationFilesRetained)"
        case "spend_cap_reached":
            guard let capUsd else {
                var text = "Your monthly spend cap is reached; raise it to "
                    + "start your workstation again"
                text += periodClause(periodEnd)
                return "\(text) \(workstationFilesRetained)"
            }
            var text = "Your monthly spend cap of "
                + "\(BillingSummary.money(capUsd)) is reached"
            if let projectedUsd {
                text += " (projected \(BillingSummary.money(projectedUsd)))"
            }
            text += "; raise it to start your workstation again"
            text += periodClause(periodEnd)
            return "\(text) \(workstationFilesRetained)"
        default:
            return nil
        }
    }

    // MARK: - Plan changes

    /// Copy for a plan-change preview/confirm refusal. Only the plan-change
    /// screen calls this, with failures from its own endpoints; every other
    /// screen keeps using `message(_:)`. Nil when the failure is not one of
    /// the plan-change reasons, and then the caller falls back to `message`.
    /// A 402 here is deliberately not worded as a grant: the plan has not
    /// changed and `/v1/me` still reports the old one until payment succeeds.
    public static func planChangeMessage(_ error: APIError) -> String? {
        PlanChangeFailure.classify(error)?.message
    }

    private static func periodClause(_ periodEnd: Date?) -> String {
        if let periodEnd {
            return " or wait for the period to reset on "
                + "\(Format.shortDay(periodEnd))."
        }
        return "."
    }

    /// Allowlisted numeric fields only, and only when they are a real number.
    private static func billingAmount(_ error: APIError, _ key: String) -> Double? {
        BillingSummary.number(error.detail?[key])
    }

    /// Allowlisted cent fields only, scaled to dollars for display.
    private static func billingUsdCents(_ error: APIError, _ key: String) -> Double? {
        BillingSummary.usd(cents: error.detail?[key])
    }

    private static func billingDate(_ error: APIError, _ key: String) -> Date? {
        BillingSummary.timestamp(error.detail?[key])
    }

    private static func typedCapacityMessage(_ error: APIError) -> String? {
        guard let reason = error.detailString("reason") else { return nil }
        switch reason {
        // Capacity contract §1–2: every fleet-side pressure reason maps to the
        // fleet copy, except degraded fairness which names itself so a retry
        // pause reads as temporary rather than broken. Allowlisted amounts
        // (`required`/`available`/`budget` with a known `unit`) append as a
        // numeric clause; unbounded `error` prose is never copied.
        case "disk_capacity", "memory_capacity", "transition_capacity", "cpu_capacity",
             "network_capacity", "memory_debt", "fleet_capacity":
            if let amounts = capacityAmountsClause(error) {
                return "\(fleetPressureMessage) \(amounts)"
            }
            return fleetPressureMessage
        case "fairness_degraded":
            return fairnessDegradedMessage
        case "unsupported_shape":
            return unsupportedShapeMessage
        default:
            return nil
        }
    }

    /// Finite non-negative numbers only. NaN, infinity and negatives are dropped
    /// rather than shown — the same gate billing amounts use.
    private static func capacityAmount(_ error: APIError, _ key: String) -> Double? {
        guard let raw = error.detail?[key]?.doubleValue, raw.isFinite, raw >= 0 else {
            return nil
        }
        return raw
    }

    private static let gibibyte: Double = 1024 * 1024 * 1024

    /// `bytes` → GiB via 1024³; `gb` and `cores` keep their unit. Unknown units
    /// drop the clause rather than inventing a label.
    private static func capacityFormattedAmount(_ value: Double, unit: String) -> String? {
        switch unit {
        case "bytes":
            return String(format: "%.2f GiB", value / gibibyte)
        case "gb":
            return String(format: "%.2f GB", value)
        case "cores":
            return String(format: "%.2f cores", value)
        case "count":
            if value == value.rounded(), abs(value) < 1e15 { return String(Int(value)) }
            return String(format: "%.2f", value)
        default:
            return nil
        }
    }

    /// `4.00 GiB required, 0.00 GiB available of 4.00 GiB budget` — only the
    /// fields the server actually sent, and only when the unit is known.
    private static func capacityAmountsClause(_ error: APIError) -> String? {
        guard let unit = error.detailString("unit") else { return nil }
        func part(_ key: String, _ label: String) -> String? {
            guard let value = capacityAmount(error, key),
                  let text = capacityFormattedAmount(value, unit: unit)
            else { return nil }
            return "\(text) \(label)"
        }
        let required = part("required", "required")
        let available = part("available", "available")
        let budget = part("budget", "budget")
        var head: [String] = []
        if let required { head.append(required) }
        if let available { head.append(available) }
        if head.isEmpty {
            return budget
        }
        if let budget {
            return "\(head.joined(separator: ", ")) of \(budget)"
        }
        return head.joined(separator: ", ")
    }

    static func capacitySentence(_ error: String, detail: String? = nil) -> String? {
        let text = (detail?.isEmpty == false) ? "\(error) \(detail!)" : error
        let lower = text.lowercased()

        // 1. Per-user limit: 'caps concurrent pods per user at N'
        if let cap = firstCapture(in: text, pattern: #"caps concurrent pods per user at (\d+)"#) {
            return """
                You are at the concurrent pod limit of \(cap). Product policy allows up to \
                \(productConcurrencyPolicy) concurrent pods per user, with the server limit \
                authoritative. Stop a running pod or wait for idle sleep under your idle \
                policy, then retry.
                """
        }

        // 2. Org limit: 'org policy caps concurrent pods at N'
        if let cap = firstCapture(in: text, pattern: #"org policy caps concurrent pods at (\d+)"#) {
            return """
                Your organization is at its concurrent pod limit (\(cap)). Stop a running pod \
                or wait for idle sleep under your idle policy, then retry — or ask an owner to \
                raise the org policy.
                """
        }
        if lower.contains("org policy caps concurrent pods") {
            return """
                Your organization is at its concurrent pod limit. Stop a running pod or wait \
                for idle sleep under your idle policy, then retry — or ask an owner to raise \
                the org policy.
                """
        }

        // 3. Restore required.
        if lower.contains("restore the pod") {
            return "This pod is archived. Restore it from the pod screen to continue."
        }

        // 4. Fleet pressure.
        if lower.contains("fleet is at capacity")
            || matches(text, pattern: #"no sandbox host .*room for a sandbox"#)
            || lower.contains("every active sandbox host refused") {
            return fleetPressureMessage
        }

        // 5. Mid-transition.
        if lower.contains("pod is temporarily unavailable") {
            return temporarilyUnavailableMessage
        }

        // A genuine shape refusal names itself unsupported. A "supports at most …
        // — using …" message is the opposite — a clamp the server applied — and
        // must never map to the not-clamped refusal.
        if lower.contains("unsupported"),
           matches(text, pattern: #"shape|memory|disk|cpu|8\s*gi?b"#) {
            return unsupportedShapeMessage
        }

        return nil
    }

    private static func credentialMessage(_ error: APIError) -> String? {
        let code = error.detailCode ?? error.error
        let provider = error.detailString("provider") ?? "model provider"
        switch code {
        case "credential_reconnect_required":
            return reconnectMessage(error, provider: provider)
        case "credential_temporarily_unavailable":
            return "The \(provider) sign-in is temporarily unavailable. Retry shortly."
        case "credential_provider_unsupported":
            return """
                This provider can't be connected from the app. Store an API key as a user \
                secret if it has one.
                """
        case "client_upgrade_required":
            return "This app is too old for the server. Update pi pod."
        default:
            return nil
        }
    }

    private static func reconnectMessage(_ error: APIError, provider: String) -> String {
        let detail = error.detailString("message")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let detail, !detail.isEmpty, !detail.lowercased().contains("/login") {
            return detail
        }
        return "Reconnect \(provider) in Settings, then retry."
    }

    private static func serverText(_ error: String) -> String {
        // A bare 5xx string names no cause; claiming fleet pressure would misdirect.
        if error.hasPrefix("HTTP 5") { return serverFallbackMessage }
        if let known = FriendlyText.knownServerFailure(error) { return known }
        return FriendlyText.readsAsProse(error)
            ? FriendlyText.failure(error)
            : serverFallbackMessage
    }

    /// Unknown thrown values use the terminal fallback rather than exposing
    /// their implementation text.
    private static func transportOrFallback(_ error: Error, serverHost: String?) -> String {
        guard let kind = NetworkFailure.tryParse(error) else { return fallbackMessage }
        // Callers pass either a bare host or a whole URL; both name the same server.
        let parsedHost = serverHost.flatMap { URL(string: $0)?.host ?? $0 }
        let destination = (parsedHost?.isEmpty == false)
            ? "the pi pod server at \(parsedHost!)"
            : "the pi pod server"
        switch kind {
        case .offline:
            return "You appear to be offline. Check your connection and try again."
        case .timedOut:
            return "The server took too long to respond. Try again."
        case .cannotReachHost:
            return "Couldn’t reach \(destination). Try again in a moment."
        case .cancelled:
            return "The request was cancelled."
        case .other:
            return "A network problem kept that from finishing. Try again."
        }
    }
}

/// Reads whether a server refusal is the optimistic-concurrency one.
///
/// It is the only failure whose fix is to read the other person's change rather
/// than to retry the same write harder, so every editor that sends a version
/// asks the same question of its error.
public enum VersionConflict {
    /// True when the refusal names a version that moved. The server puts the
    /// reason in `error` on some routes and under `detail` on others, so both
    /// are read rather than guessing which one this was.
    public static func isNamed(by error: APIError) -> Bool {
        let text = ([error.error, error.detail?.compactPrinted()]
            .compactMap { $0 }
            .joined(separator: " "))
            .lowercased()
        guard text.contains("version") else { return false }
        return ["conflict", "stale", "changed", "mismatch", "modified"]
            .contains { text.contains($0) }
    }
}

/// Server and provider messages are written for whoever runs the control plane:
/// they name permission slugs, vendor dashboards and internal identifiers. This
/// turns them into sentences the person holding the phone can act on.
public enum FriendlyText {
    /// Our server answers anticipated failures with a sentence written for the
    /// person holding the phone, and those are worth showing. What must never
    /// reach a screen is machine output that escaped: a runtime exception from
    /// the server process, or a validator's field path.
    public static func readsAsProse(_ error: String) -> Bool {
        let text = error.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty || text.count > 240 { return false }
        if text.contains("\n") { return false }
        let leaks = [
            "cannot read propert", "typeerror", "referenceerror", "syntaxerror",
            "undefined", "null pointer", "exception:", "stack trace", "at object.",
            "_$", "solved by the library",
        ]
        let lower = text.lowercased()
        if leaks.contains(where: { lower.contains($0) }) { return false }
        // Zod reports `body/templateId Expected string, received null`.
        if matches(text, pattern: #"^(body|params|query|headers)/"#) { return false }
        return true
    }

    public static func knownServerFailure(_ error: String) -> String? {
        if let capacity = FriendlyError.capacitySentence(error) { return capacity }
        if let permission = missingPermission(error) { return permission }
        if let image = unavailableImage(error) { return image }
        if let abandoned = abandonedProvisioning(error) { return abandoned }
        if let children = liveChildPods(error) { return children }
        if isSignInFailure(error) {
            return "Sign-in couldn’t be completed. Try signing in again."
        }
        let trimmed = error.trimmingCharacters(in: .whitespacesAndNewlines)
        if let provider = firstCapture(
            in: trimmed, pattern: #"^no ([a-z0-9_-]+) credential(\b|$)"#
        ) {
            // There is a single sandbox backend, so its missing credential reads
            // without a vendor name. Anything else is a retired provider name
            // surviving in an old row — still actionable, never raw.
            if provider.lowercased() == "sandbox" {
                return """
                    This organization doesn’t have a sandbox credential. Ask an owner to add \
                    it in Settings, then try again.
                    """
            }
            let displayName = provider.lowercased() == "boat" ? "Boat" : provider
            return """
                This organization doesn’t have a \(displayName) sandbox credential. Ask an \
                owner to add it in Settings, then try again.
                """
        }
        return nil
    }

    /// `requires pods:launch` and friends — the slug means nothing to the person
    /// refused.
    public static func missingPermission(_ error: String) -> String? {
        guard error.hasPrefix("requires ") else { return nil }
        let slug = String(error.dropFirst("requires ".count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let action: String?
        switch slug {
        case "pods:launch": action = "launch pods"
        case "pods:manage_any": action = "manage other people’s pods"
        case "templates:write": action = "create or change environments"
        case "secrets:org:write": action = "change organization secrets"
        case "secrets:own:write", "settings:own:write": action = "change your saved settings"
        case "policy:write", "org:manage", "members:manage": action = "administer this organization"
        case "audit:read": action = "read the audit log"
        default: action = nil
        }
        guard let action else { return nil }
        return """
            Your account isn’t allowed to \(action) in this organization. Ask an owner for access.
            """
    }

    public static func isSignInFailure(_ error: String) -> Bool {
        let lower = error.lowercased()
        return lower.contains("code exchange") || lower.contains("authorization code")
    }

    /// The server reaps a launch whose provisioning process died before it
    /// recorded a sandbox. Its sentence names the internal owner heartbeat, which
    /// describes pi pod's bookkeeping rather than anything the reader can act on.
    public static func abandonedProvisioning(_ error: String) -> String? {
        guard error.lowercased().contains("provisioning stopped before the sandbox") else {
            return nil
        }
        return """
            This pod stopped while it was starting up and never got a sandbox. Launch it again.
            """
    }

    /// `pod <uuid> has 2 live child pod(s); pass ?cascade=true to delete them
    /// too` names a database id and a query parameter. The pod screen offers the
    /// cascade as a button and names the children, so this only has to say what
    /// is in the way — and it must never be the raw sentence.
    public static func liveChildPods(_ error: String) -> String? {
        guard let captured = firstCapture(in: error, pattern: #"has (\d+) live child pod"#),
              let count = Int(captured)
        else { return nil }
        return count == 1
            ? """
                Another pod is running on this pod’s machine. Delete it together with this \
                one, or delete it first.
                """
            : """
                \(count) other pods are running on this pod’s machine. Delete them together \
                with this one, or delete them first.
                """
    }

    /// The launch preflight for an image the provider does not have. The server
    /// answers this one with control-plane advice — pin a different image — and
    /// neither the image ref nor the provider it is missing from means anything
    /// to the person holding the phone.
    public static func unavailableImage(_ error: String) -> String? {
        let lower = error.lowercased()
        if lower.contains("cannot build managed image") {
            return """
                Your sandbox host can’t build pi pod’s runtime image, so the pod can’t start. \
                Ask an owner to check the runtime image configuration.
                """
        }
        guard lower.hasPrefix("image \""), lower.contains("not found in the") else { return nil }
        return """
            The container image this environment pins doesn’t exist on your sandbox provider, \
            so the pod can’t start. Remove the image pin from the environment or organization \
            settings and try again.
            """
    }

    /// The failure, then the fix — each stripped of operator instructions. The
    /// pair gets a longer budget than a lone message: cutting the remedy is
    /// better than losing the failure.
    public static func failure(_ error: String, detail: String? = nil) -> String {
        let failure = withoutOperatorInstructions(error)
        let advice = withoutOperatorInstructions(detail ?? "")
        if failure.isEmpty {
            return advice.isEmpty ? FriendlyError.serverFallbackMessage : advice
        }
        if advice.isEmpty || failure.lowercased().contains(advice.lowercased()) {
            return failure
        }
        let joined = failure.hasSuffix(".") ? "\(failure) \(advice)" : "\(failure) — \(advice)"
        return truncated(joined, limit: 280)
    }

    /// Provider failures append a support URL and dashboard directions the user
    /// cannot follow from a phone, and reading them as part of the failure makes
    /// a recoverable state look like a broken account.
    public static func withoutOperatorInstructions(_ raw: String) -> String {
        var text = raw
        if let urlRange = text.range(of: "http", options: .caseInsensitive) {
            text = String(text[text.startIndex..<urlRange.lowerBound])
            // The sentence introducing the link ("Visit the API Keys tab at") goes with it.
            if let sentenceEnd = text.lastIndex(of: ".") {
                text = String(text[text.startIndex...sentenceEnd])
            } else {
                // No sentence before the link: the whole string was directions to
                // it, and the dangling "check the key at" left behind says less
                // than nothing.
                text = ""
            }
        }
        text = text.replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: " +", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return truncated(text, limit: 200)
    }

    static func truncated(_ text: String, limit: Int) -> String {
        guard text.count > limit else { return text }
        let cut = String(text.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(cut)…"
    }
}

// MARK: - Regex helpers

private func regex(_ pattern: String) -> NSRegularExpression? {
    try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
}

func matches(_ text: String, pattern: String) -> Bool {
    guard let expression = regex(pattern) else { return false }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return expression.firstMatch(in: text, range: range) != nil
}

func firstCapture(in text: String, pattern: String) -> String? {
    guard let expression = regex(pattern) else { return nil }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    guard let match = expression.firstMatch(in: text, range: range), match.numberOfRanges > 1,
          let captured = Range(match.range(at: 1), in: text)
    else { return nil }
    return String(text[captured])
}
