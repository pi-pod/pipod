import SwiftUI

/// Everything one pod is: where it lives, how it got there, and what can be done
/// to it.
public struct PodDetailView: View {
    let podId: String
    let initialPod: Pod?

    @Environment(\.apiClient) private var api
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss

    @State private var pod: Pod?
    @State private var templateName: String?
    @State private var templateChecked = false
    @State private var loadError: String?
    @State private var notice: String?
    @State private var working: PodWorkingCommand?
    @State private var isDeleting = false
    @State private var notFound = false
    @State private var confirmsArchive = false
    @State private var confirmsStop = false
    @State private var confirmsDelete = false
    /// The children a plain delete was refused for. Presenting it re-asks the
    /// question naming them, and answering it retries with `?cascade=true`.
    @State private var confirmsCascadeDelete: LiveChildren?
    @State private var showsLaunchReport = false
    @State private var didLoad = false
    /// Live while this account's own workstation is coming up. Distinct from the
    /// capacity wait below it, which is the shared fleet running out of room.
    @State private var workstationWait: WorkstationWait?
    @State private var workstationNotice: String?
    @State private var canKeepWaiting = false

    public init(podId: String, initialPod: Pod? = nil) {
        self.podId = podId
        self.initialPod = initialPod
        _pod = State(initialValue: initialPod)
        // A pod id that cannot exist is answered here rather than by a request the
        // server is going to refuse anyway.
        _notFound = State(initialValue: !Self.isUUID(podId))
    }

    public var body: some View {
        content
            .navigationTitle(pod?.name ?? "Pod")
            .navigationBarTitleDisplayMode(.large)
            .task { await load() }
            .task { await pollWhileStarting() }
            // The wait re-issues whatever was refused — including a restore, a
            // stop or an archive. Leaving this screen must end it, or the
            // command fires minutes later against a pod that has moved on.
            .onDisappear { endWorkstationWait() }
    }

    @ViewBuilder
    private var content: some View {
        if notFound {
            EmptyStateView(
                title: "Pod unavailable",
                message: "This pod no longer exists, or you don’t have access.",
                systemImage: "questionmark.folder",
                actionTitle: "Back to pods",
                action: { router.openPods() }
            )
        } else if let pod {
            detail(pod)
        } else if let wait = workstationWait {
            ScrollView {
                WorkstationWaitCard(
                    progress: wait.progress,
                    onCheckNow: { wait.checkNow() },
                    onCancel: { wait.cancel() }
                )
                .padding(20)
            }
        } else if let workstationNotice, pod == nil {
            EmptyStateView(
                title: "Workstation starting",
                message: workstationNotice,
                systemImage: "desktopcomputer",
                actionTitle: canKeepWaiting ? "Keep waiting" : nil,
                action: keepWaitingAction
            )
        } else if let loadError {
            EmptyStateView(
                title: "Couldn’t load this pod",
                message: loadError,
                systemImage: "wifi.slash",
                actionTitle: "Try again",
                action: { Task { await refresh() } }
            )
        } else {
            LoadingView(label: "Loading pod details…")
        }
    }

    private func detail(_ pod: Pod) -> some View {
        List {
            workstationSection
            statusSection(pod)
            if pod.capacityWait != nil { capacityWaitSection(pod) }
            informationSection(pod)
            launchReportSection(pod)
            if let loadError {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(loadError).font(.footnote)
                        Button("Try refreshing") { Task { await refresh() } }
                            .font(.footnote.weight(.semibold))
                            .accessibilityLabel("Try refreshing pod details")
                    }
                }
                .listRowBackground(AppColors.destructiveFill)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await refresh() }
        // A banner rather than a row: a lifecycle command that reflowed the list
        // under the reader's finger would be worse than saying nothing.
        .overlay(alignment: .bottom) { noticeBanner }
        .animation(.default, value: notice)
        .toolbar { toolbarContent(pod) }
        .confirmationDialog(
            "Archive this pod?",
            isPresented: $confirmsArchive,
            titleVisibility: .visible
        ) {
            Button("Archive pod") { run(.archive) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                """
                This hides the pod without deleting it. It restores later; cold archive \
                follows after 60 stopped minutes.
                """
            )
        }
        .confirmationDialog(
            "Stop \(pod.name)’s sandbox?",
            isPresented: $confirmsStop,
            titleVisibility: .visible
        ) {
            Button("Stop sandbox") { run(.stop) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                """
                This releases the machine now and ends the conversation. The pod and its \
                files stay; sending a message wakes it again.
                """
            )
        }
        .confirmationDialog(
            "Delete \(pod.name)?",
            isPresented: $confirmsDelete,
            titleVisibility: .visible
        ) {
            Button("Delete pod permanently", role: .destructive) { delete() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                """
                This removes the remote sandbox and its uncommitted work. This can’t be \
                undone.
                """
            )
        }
        .confirmationDialog(
            "Delete \(pod.name) and what runs on it?",
            isPresented: Binding(
                get: { confirmsCascadeDelete != nil },
                set: { if !$0 { confirmsCascadeDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: confirmsCascadeDelete
        ) { children in
            Button(children.deleteTitle, role: .destructive) { delete(cascade: true) }
            Button("Cancel", role: .cancel) {}
        } message: { children in
            Text(children.message)
        }
    }

    // MARK: - Status

    private func statusSection(_ pod: Pod) -> some View {
        let presentation = PodPresentation(pod: pod)
        return Section {
            if let working {
                HStack(spacing: 12) {
                    ProgressView()
                    Text(working.progressLabel)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Status")
                        Spacer(minLength: 12)
                        PodStateIcon(presentation: presentation, size: 16)
                        Text(presentation.statusLabel)
                            .fontWeight(.bold)
                            .foregroundStyle(presentation.tone.color)
                    }
                    if let detail = presentation.statusDetail {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(AppColors.secondaryLabel)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    presentation.statusDetail.map {
                        "Status, \(presentation.statusLabel), \($0)"
                    } ?? "Status, \(presentation.statusLabel)"
                )
                .accessibilityIdentifier("pod.status")
            }

            if let reason = presentation.userFacingReason {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: presentation.systemImage)
                        .foregroundStyle(presentation.tone.color)
                        .accessibilityHidden(true)
                    Text(reason).foregroundStyle(presentation.tone.color)
                }
                .font(.subheadline)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Pod failure: \(reason)")
                .accessibilityIdentifier("pod.failureReason")
            }

            // A starting pod can still be talked to: the composer queues the prompt
            // and pi picks it up once the sandbox is up, so the door stays open.
            if pod.canOpenConversation {
                Button {
                    router.openSession(podId: podId, pod: pod)
                } label: {
                    Label("Open session", systemImage: "bubble.left.and.bubble.right")
                        .frame(maxWidth: .infinity)
                }
                .brandProminent()
                .accessibilityLabel("Open session for \(pod.name)")
                .accessibilityIdentifier("pod.openSession")
            }

            // A pod that failed to provision cannot be restored — there is nothing
            // to restore — so the way forward is launching again from the same
            // environment rather than rebuilding the choice from memory.
            if Self.canRetryLaunch(pod) {
                Button {
                    router.podsPath.append(.retryLaunch(templateId: pod.templateId))
                } label: {
                    Label("Edit & retry", systemImage: "square.and.pencil")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(working != nil)
                .accessibilityLabel("Edit and retry pod \(pod.name)")
                .accessibilityIdentifier("pod.editAndRetry")
            } else if !pod.isLive {
                VStack(spacing: 6) {
                    Button {
                        run(.restore)
                    } label: {
                        Label("Restore", systemImage: "arrow.counterclockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .disabled(working != nil)
                    .accessibilityLabel("Restore pod \(pod.name)")
                    .accessibilityIdentifier("pod.restore")
                    Text(restoreFootnote(pod))
                        .font(.footnote)
                        .foregroundStyle(AppColors.secondaryLabel)
                        .multilineTextAlignment(.center)
                }
            }
        }
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice {
            Text(notice)
                .font(.footnote.weight(.medium))
                .foregroundStyle(AppColors.label)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(AppColors.card, in: Capsule())
                .shadow(radius: 8, y: 2)
                .padding(.bottom, 12)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityAddTraits(.isStaticText)
                .accessibilityIdentifier("pod.notice")
        }
    }

    private func restoreFootnote(_ pod: Pod) -> String {
        // A pod restarts quickly — but not while the machine underneath it is
        // still coming up, which takes minutes. Promising seconds there would be
        // a number this screen invented.
        if workstationWait != nil {
            return "Restores once your workstation is up · local disk retained"
        }
        return pod.sandboxState == "stopped"
            ? "Restarts in seconds · local disk retained"
            : "Restores on next use · seconds-to-minutes depending on size"
    }

    // MARK: - Workstation wait

    @ViewBuilder
    private var workstationSection: some View {
        if let wait = workstationWait {
            Section {
                WorkstationWaitCard(
                    progress: wait.progress,
                    onCheckNow: { wait.checkNow() },
                    onCancel: { wait.cancel() }
                )
            }
        } else if let workstationNotice {
            Section {
                WorkstationNoticeTile(
                    message: workstationNotice,
                    retryTitle: canKeepWaiting ? "Keep waiting" : nil,
                    onRetry: keepWaitingAction
                )
            }
        }
    }

    /// Offered only when waiting again can still succeed. A terminal reason
    /// cannot, and a button that never works is worse than no button.
    private var keepWaitingAction: (() -> Void)? {
        guard canKeepWaiting else { return nil }
        return { Task { await refresh() } }
    }

    /// Enters the shared wait, re-issuing whichever request was refused. Only
    /// this client's wait is bounded: the workstation keeps starting regardless.
    private func beginWorkstationWait(
        _ detail: WorkstationDemandDetail,
        attempt: @escaping () async throws -> Pod
    ) {
        loadError = nil
        workstationNotice = nil
        if let existing = workstationWait, !existing.isFinished {
            existing.adopt(detail)
            return
        }
        let client = api
        let wait = WorkstationWait(
            detail: detail,
            status: { try await client.workstationStatus(hostId: $0) }
        )
        workstationWait = wait
        wait.start(attempt: attempt) { outcome in
            guard workstationWait === wait else { return }
            workstationWait = nil
            canKeepWaiting = outcome.canKeepWaiting
            switch outcome {
            case .succeeded(let refreshed):
                pod = refreshed
                loadError = nil
            case .failed(let error):
                loadError = FriendlyError.message(error, serverHost: Config.serverURL)
            default:
                workstationNotice = outcome.endingMessage
            }
        }
    }

    /// Ends the wait and the task behind it.
    private func endWorkstationWait() {
        workstationWait?.abandon()
        workstationWait = nil
    }

    // MARK: - Capacity wait

    @ViewBuilder
    private func capacityWaitSection(_ pod: Pod) -> some View {
        if let wait = pod.capacityWait {
            Section("Capacity wait") {
                DetailRow("State", value: waitStateLabel(wait), tone: waitTone(wait))
                if let reason = wait.reason, !reason.isEmpty {
                    DetailRow("Reason", value: humanised(reason))
                }
                if wait.attempts > 0 {
                    DetailRow("Attempts", value: "\(wait.attempts)")
                }
                if wait.isWaiting {
                    DetailRow(
                        "Time left",
                        value: "~\(max(0, Int((Double(wait.deadlineInMs) / 1000).rounded(.up))))s"
                    )
                    // A queued launch or wake holds one concurrency slot but no host
                    // reservation. Cancelling ends the wait cooperatively and keeps
                    // the pod row; deleting the pod ends it too.
                    Button {
                        cancelCapacityWait()
                    } label: {
                        Label("Cancel wait", systemImage: "xmark.circle")
                    }
                    .disabled(working != nil)
                    .accessibilityLabel("Cancel capacity wait for \(pod.name)")
                    .accessibilityIdentifier("pod.cancelWait")
                }
            }
        }
    }

    private func waitStateLabel(_ wait: CapacityWaitState) -> String {
        if wait.isWaiting { return wait.cancelRequested ? "Cancelling" : "Waiting" }
        if wait.isExpired { return "Expired" }
        if wait.isCancelled { return "Cancelled" }
        if wait.isAdmitted { return "Admitted" }
        return humanised(wait.state)
    }

    private func waitTone(_ wait: CapacityWaitState) -> StatusTone {
        if wait.isAdmitted { return .positive }
        if wait.isWaiting { return .caution }
        return .neutral
    }

    // MARK: - Information

    private func informationSection(_ pod: Pod) -> some View {
        let config = pod.resolvedConfig
        return Section("Pod information") {
            if let project = pod.projectName {
                DetailRow("Project", value: project)
            }
            DetailRow("Environment", value: environmentLabel(pod))
            DetailRow("Location", value: pod.displayLocation)
            if pod.isHostChild, let hostID = pod.hostPodId {
                NavigationLink(value: PodRoute.detail(podId: hostID, pod: nil)) {
                    DetailRow("Host", value: hostLabel(pod))
                }
                .accessibilityLabel("Host, \(hostLabel(pod))")
                .accessibilityIdentifier("pod.host")
            }
            DetailRow("Network", value: networkLabel(config))
            if let minutes = config.idleTimeoutMinutes {
                DetailRow("Idle timeout", value: "\(minutes) minutes")
                clamps(config.clamps, for: "idleTimeoutMinutes")
            }
            if let minutes = config.archiveAfterMinutes {
                DetailRow("Archive after", value: "\(minutes) minutes")
                clamps(config.clamps, for: "archiveAfterMinutes")
            }
            if let created = Format.absolute(pod.createdAt) {
                DetailRow("Created", value: created)
            }
            DetailRow("Last activity", value: lastActivityLabel(pod))
            Text(lifecycleFootnote(pod))
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)
        }
    }

    private func environmentLabel(_ pod: Pod) -> String {
        if let templateName { return templateName }
        if pod.templateId == nil { return "None (empty pod)" }
        // A name that never arrived is a deleted environment, not a raw id.
        return templateChecked ? "Deleted environment" : "Loading…"
    }

    private func hostLabel(_ pod: Pod) -> String {
        let name = pod.hostPodName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let name, !name.isEmpty { return name }
        return pod.hostPodId ?? "the host pod"
    }

    private func networkLabel(_ config: PodResolvedConfig) -> String {
        switch config.egress.mode {
        case "open": return "Open"
        case "none", "blocked": return "Blocked"
        default: return "Restricted"
        }
    }

    private func lastActivityLabel(_ pod: Pod) -> String {
        guard let activity = pod.lastActivityAt,
              let relative = Format.relative(activity)
        else { return "No activity yet" }
        return relative
    }

    private func lifecycleFootnote(_ pod: Pod) -> String {
        if pod.isHostChild {
            return """
                Shares \(hostLabel(pod))’s machine. The host’s idle timer governs this pod.
                """
        }
        return """
            Runs on your organization’s sandbox provider. Idle pods sleep and restore \
            automatically.
            """
    }

    @ViewBuilder
    private func clamps(_ clamps: [PolicyClamp], for field: String) -> some View {
        ForEach(clamps.filter { $0.path.split(separator: ".").last.map(String.init) == field }) {
            clamp in
            Text(clampMessage(clamp))
                .font(.caption)
                .foregroundStyle(AppColors.notice)
        }
    }

    private func clampMessage(_ clamp: PolicyClamp) -> String {
        let reason = clamp.reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty else { return "Organization policy changed this value" }
        return reason.prefix(1).uppercased() + reason.dropFirst()
    }

    // MARK: - Launch report

    private func launchReportSection(_ pod: Pod) -> some View {
        let config = pod.resolvedConfig
        let presentation = PodPresentation(pod: pod)
        let warnings = Self.userFacingWarnings(config.warnings)
        return Section {
            DisclosureGroup(isExpanded: $showsLaunchReport) {
                ForEach(config.initSteps ?? [], id: \.self) { step in
                    DetailRow(
                        "\(Self.initStepLabel(step.scope)) setup",
                        value: step.status,
                        tone: step.status == "ok" ? nil : .caution
                    )
                }
                if let settings = config.piSettings {
                    DetailRow("Your pi settings", value: Self.piSettingsLabel(settings))
                    if !settings.droppedKeys.isEmpty {
                        DetailRow(
                            "Left out", value: settings.droppedKeys.joined(separator: ", ")
                        )
                    }
                }
                if !config.secretKeys.isEmpty {
                    DetailRow("Secrets sent", value: Self.secretsLabel(config))
                }
                ForEach(config.clamps) { clamp in
                    Text(clampMessage(clamp))
                        .font(.caption)
                        .foregroundStyle(AppColors.notice)
                }
                ForEach(warnings, id: \.self) { warning in
                    Text(warning)
                        .font(.footnote)
                        .foregroundStyle(AppColors.warning)
                }
                Text("Technical details")
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, 4)
                DetailRow("Provider", value: pod.provider)
                if let image = presentation.image {
                    DetailRow("Image", value: image)
                }
                if let preparation = config.imagePreparation {
                    DetailRow(
                        "Image preparation",
                        value: "\(preparation.status) · \(preparation.provenance)",
                        tone: preparation.status == "ready" ? nil : .caution
                    )
                }
                if let bake = config.bake {
                    DetailRow("Bake", value: "\(bake.status) · \(bake.mode)")
                }
                DetailRow("Network egress", value: egressLabel(config))
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Launch report")
                    if let attention = Self.attention(config, warnings: warnings) {
                        Text(attention)
                            .font(.footnote)
                            .foregroundStyle(AppColors.secondaryLabel)
                    }
                }
            }
            .accessibilityIdentifier("pod.launchReport")
        }
    }

    private func egressLabel(_ config: PodResolvedConfig) -> String {
        let description = config.egress.description
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return description.isEmpty ? config.egress.mode : description
    }

    /// Whether a failed pod can be launched again.
    ///
    /// A pod whose sandbox vanished is failed too, but there is nothing to retry —
    /// its environment is gone with it. Only a provisioning failure, which is a
    /// choice that did not work rather than a resource that disappeared, offers
    /// the same choice back.
    static func canRetryLaunch(_ pod: Pod) -> Bool {
        PodPresentation(pod: pod).lifecycle == .failed
            && (pod.sandboxState == "error" || pod.preparationPhase == "failed"
                || pod.state == "failed")
    }

    /// The warnings written for whoever runs the control plane are not actionable
    /// from a phone and read as though the pod is broken.
    static func userFacingWarnings(_ warnings: [String]) -> [String] {
        let operatorMarkers = ["PUBLIC_URL", "call back to the server", "is not configured"]
        return warnings.filter { warning in
            let lower = warning.lowercased()
            return !operatorMarkers.contains { lower.contains($0.lowercased()) }
        }
    }

    /// What the collapsed report is worth opening for.
    static func attention(_ config: PodResolvedConfig, warnings: [String]) -> String? {
        if !warnings.isEmpty {
            return warnings.count == 1 ? "1 warning" : "\(warnings.count) warnings"
        }
        if config.initSteps?.contains(where: { $0.status != "ok" }) == true {
            return "A setup script didn’t finish cleanly"
        }
        if config.piSettings?.status == "degraded" {
            return "Some of your pi settings were left out"
        }
        return nil
    }

    static func piSettingsLabel(_ settings: PiSettingsStatus) -> String {
        guard !settings.files.isEmpty else { return "None" }
        let files = settings.files.count == 1 ? "1 file" : "\(settings.files.count) files"
        return settings.status == "degraded" ? "\(files), partly applied" : files
    }

    static func secretsLabel(_ config: PodResolvedConfig) -> String {
        config.secretKeys
            .map { key in
                guard let scope = config.secretScopes?[key] else { return key }
                return "\(key) (\(scope))"
            }
            .joined(separator: ", ")
    }

    static func initStepLabel(_ scope: String) -> String {
        switch scope {
        case "org": return "Organization"
        case "template": return "Environment"
        case "repo": return "Project"
        default:
            guard !scope.isEmpty else { return scope }
            return scope.prefix(1).uppercased() + scope.dropFirst()
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private func toolbarContent(_ pod: Pod) -> some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if isDeleting {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Deleting pod")
            } else {
                Menu {
                    Button {
                        Task { await refresh() }
                    } label: {
                        Label("Refresh status", systemImage: "arrow.clockwise")
                    }
                    if Self.offersStop(pod) {
                        Button {
                            confirmsStop = true
                        } label: {
                            Label("Stop sandbox", systemImage: "stop.circle")
                        }
                        .accessibilityIdentifier("pod.stop")
                    }
                    if pod.isLive {
                        Button {
                            confirmsArchive = true
                        } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                    } else {
                        Button {
                            run(.restore)
                        } label: {
                            Label("Restore", systemImage: "arrow.counterclockwise")
                        }
                    }
                    Button(role: .destructive) {
                        confirmsDelete = true
                    } label: {
                        Label("Delete pod", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(working != nil)
                .accessibilityLabel("Pod actions")
                .accessibilityIdentifier("pod.actions")
            }
        }
    }

    // MARK: - Loading and commands

    private func load() async {
        guard !notFound, !didLoad else { return }
        didLoad = true
        await refresh()
        guard let templateId = pod?.templateId else { return }
        do {
            templateName = try await api.template(id: templateId).name
        } catch {
            // A missing environment keeps the name nil so the row can say it was
            // deleted instead of leaking the raw id.
        }
        templateChecked = true
    }

    private func refresh() async {
        do {
            pod = try await api.pod(id: podId)
            loadError = nil
            // The pod answered, so the wait is spent. Dropping the reference
            // without ending it would leave the refused command — a restore or
            // a stop — re-issued every 10 s for the rest of its budget.
            endWorkstationWait()
            workstationNotice = nil
        } catch {
            if Self.isNotFound(error) {
                pod = nil
                loadError = nil
                notFound = true
                return
            }
            if let apiError = error as? APIError,
               let demand = WorkstationDemandDetail.parse(apiError) {
                let client = api
                let id = podId
                beginWorkstationWait(demand) { try await client.pod(id: id) }
                return
            }
            loadError = "Could not refresh pod status: "
                + FriendlyError.message(error, serverHost: Config.serverURL)
        }
    }

    private func pollWhileStarting() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(4))
            guard pod?.initializing == true || pod?.capacityWait?.isWaiting == true else {
                continue
            }
            await refresh()
        }
    }

    private func run(_ command: PodWorkingCommand) {
        guard command != .cancelWait else { return cancelCapacityWait() }
        working = command
        loadError = nil
        Task {
            defer { working = nil }
            do {
                pod = try await api.podCommand(id: podId, command: command.rawValue)
                // These otherwise signal only through the status row changing,
                // which is easy to miss on a slow connection.
                show(notice: command.completionNotice)
            } catch {
                // The same action, re-issued on the wait's schedule: the
                // workstation being down is a delay, not a refusal of the action.
                if let apiError = error as? APIError,
                   let demand = WorkstationDemandDetail.parse(apiError) {
                    let client = api
                    let id = podId
                    let action = command.rawValue
                    beginWorkstationWait(demand) {
                        try await client.podCommand(id: id, command: action)
                    }
                    return
                }
                await refresh()
                loadError = "The pod action failed: "
                    + FriendlyError.message(error, serverHost: Config.serverURL)
            }
        }
    }

    private func cancelCapacityWait() {
        working = .cancelWait
        loadError = nil
        Task {
            defer { working = nil }
            do {
                let cancelled = try await api.cancelCapacityWait(id: podId)
                // Cooperative cancel: the waiter observes it on its next heartbeat,
                // so this reports the request, not the outcome. A pod that never
                // queued is not a failure — there was simply nothing to cancel.
                show(
                    notice: cancelled
                        ? "Cancellation requested." : "No capacity wait to cancel."
                )
                await refresh()
            } catch {
                await refresh()
                loadError = "Could not cancel the capacity wait: "
                    + FriendlyError.message(error, serverHost: Config.serverURL)
            }
        }
    }

    private func delete(cascade: Bool = false) {
        isDeleting = true
        loadError = nil
        Task {
            do {
                try await api.deletePod(id: podId, cascade: cascade)
                dismiss()
            } catch {
                isDeleting = false
                // A pod hosting live co-located children is not a failed delete,
                // it is a delete that has to be asked differently. Re-ask it
                // naming them rather than reporting a dead end.
                if !cascade, let children = Self.liveChildren(from: error) {
                    confirmsCascadeDelete = children
                    return
                }
                loadError = "Could not delete this pod: "
                    + FriendlyError.message(error, serverHost: Config.serverURL)
            }
        }
    }

    private func show(notice text: String) {
        notice = text
        Task {
            try? await Task.sleep(for: .seconds(5))
            if notice == text { notice = nil }
        }
    }

    // MARK: - Stopping and cascading

    /// Stopping releases the machine now, which only means anything while the
    /// sandbox is actually running. The server refuses every other state, so
    /// offering it there would be an action that can only fail.
    static func offersStop(_ pod: Pod) -> Bool {
        pod.isLive && pod.sandboxState == "started" && !pod.didFail
    }

    /// The co-located pods a delete was refused for, read out of the server's
    /// 409. `detail` is the array of children it named.
    struct LiveChildren: Equatable {
        let count: Int
        let names: [String]

        var deleteTitle: String {
            count == 1
                ? "Delete pod and its co-located pod"
                : "Delete pod and its \(count) co-located pods"
        }

        var message: String {
            let subject = count == 1
                ? "One pod runs on this pod’s machine"
                : "\(count) pods run on this pod’s machine"
            let named = names.isEmpty ? "" : " (\(names.joined(separator: ", ")))"
            return """
                \(subject)\(named). Deleting this one deletes them too, with their \
                uncommitted work. This can’t be undone.
                """
        }
    }

    static func liveChildren(from error: Error) -> LiveChildren? {
        guard let apiError = error as? APIError,
              let captured = firstCapture(
                  in: apiError.error, pattern: #"has (\d+) live child pod"#
              ),
              let count = Int(captured)
        else { return nil }
        let names = (apiError.detail?.arrayValue ?? []).compactMap { child in
            child["name"]?.stringValue ?? child["id"]?.stringValue
        }
        return LiveChildren(count: count, names: names)
    }

    // MARK: - Identity

    static func isUUID(_ value: String) -> Bool {
        matches(
            value,
            pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
        )
    }

    /// A pod someone else deleted, or one this account cannot see, is the same
    /// answer: it is not here. Both read as gone rather than as a failure to retry.
    static func isNotFound(_ error: Error) -> Bool {
        if let apiError = error as? APIError {
            if let status = apiError.transportStatus { return status == 403 || status == 404 }
            let text = "\(apiError.error) \(apiError.detailText ?? "")".lowercased()
            return text.contains("not found") || text.contains("forbidden")
        }
        return false
    }
}

/// A lifecycle request in flight. Its label is what the status row says while the
/// server works.
enum PodWorkingCommand: String {
    case archive
    case restore
    /// Releases the machine now while keeping the pod row and its disk. Archive
    /// is the logical hide and does not free compute at the moment it is asked.
    case stop
    case cancelWait

    var progressLabel: String {
        switch self {
        case .archive: return "Archiving pod…"
        case .restore: return "Restoring pod…"
        case .stop: return "Stopping sandbox…"
        case .cancelWait: return "Cancelling capacity wait…"
        }
    }

    var completionNotice: String {
        switch self {
        case .archive: return "Pod archived."
        case .restore: return "Pod restored."
        case .stop: return "Sandbox stopped. The pod and its files are still here."
        case .cancelWait: return "Cancellation requested."
        }
    }
}

/// "memory_capacity" is a wire value; a person reads "Memory capacity".
private func humanised(_ value: String) -> String {
    let words = value.replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
    guard !words.isEmpty else { return value }
    return words.prefix(1).uppercased() + words.dropFirst()
}
