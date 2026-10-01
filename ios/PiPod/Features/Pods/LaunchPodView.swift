import SwiftUI

private struct LaunchStatusCheckOwner: Equatable {
    let requestID: UUID
    let viewOwnerID: UUID
    let operation: LaunchOperationRecord
    let authGeneration: UUID
    let accountScope: String
    let pollingID: UUID?
}

private struct LaunchStatusReconcileRequest: Equatable {
    let id: UUID
    let viewOwnerID: UUID
    let operation: LaunchOperationRecord
    let authGeneration: UUID
    let accountScope: String
}

private struct LaunchStatusPollingRun: Equatable {
    let id: UUID
    let operation: LaunchOperationRecord
    let ownerID: UUID
    let authGeneration: UUID
    let accountScope: String
}

private enum LaunchStatusCheckResult {
    case status(String)
    case busy
    case skipped
}

/// Picks an environment and launches a pod from it.
///
/// The launch is the commitment: once the server answers, this screen is done and
/// the new conversation takes over. Policy clamps, saved-secret counts, and
/// warnings travel with that conversation as a non-blocking launch notice.
public struct LaunchPodView: View {
    @Environment(\.apiClient) private var api
    @Environment(AppRouter.self) private var router
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase

    @State private var templates: [PodTemplate] = []
    @State private var unparsedTemplateCount = 0
    @State private var isLoadingTemplates = true
    @State private var templateLoadError: String?
    /// The empty string is "no environment" — the built-in default, not a missing
    /// choice, so it is a real option rather than a nil selection.
    @State private var selection = ""
    @State private var launchingOwnerID: UUID?
    @State private var launchError: String?
    @State private var launchOutcomeUnknown = false
    /// Frozen request identity: a catalog refresh cannot alter an in-flight launch.
    @State private var launchOperationRecord: LaunchOperationRecord?
    @State private var launchOperationAccountScope: String?
    /// Invalidates all callbacks owned by a launch screen that has disappeared.
    @State private var launchOwnerID = UUID()
    @State private var launchStatusCheckOwner: LaunchStatusCheckOwner?
    @State private var launchStatusPendingReconcile: LaunchStatusReconcileRequest?
    @State private var manualStatusCheckQueued = false
    @State private var launchStatusPollingTask: Task<Void, Never>?
    @State private var launchStatusPollingTaskID: UUID?
    @State private var launchStatusPollingRun: LaunchStatusPollingRun?
    @State private var launchStatusPollNeedsResume = false
    @State private var launchStatusPollingChecks = 0
    @State private var launchStatusState: String?
    /// A launch refused because this account's own workstation is not up. The
    /// launch is not lost: the same request is re-issued on the wait's schedule.
    @State private var workstationWait: WorkstationWait?
    @State private var workstationNotice: String?
    @State private var canKeepWaiting = false

    /// The environment the failed pod used, preselected so a retry starts from
    /// what was tried rather than from nothing.
    private let templateId: String?
    /// True when this arrived from a failed pod's Edit & retry, which is the only
    /// thing that separates this screen from an ordinary new launch.
    private let isRetry: Bool

    public init(templateId: String? = nil, isRetry: Bool = false) {
        self.templateId = templateId
        self.isRetry = isRetry
        _selection = State(initialValue: templateId ?? "")
    }

    public var body: some View {
        content
            .navigationTitle(isRetry ? "Retry pod" : "New pod")
            .navigationBarBackButtonHidden(isLaunching)
            .task {
                let ownerID = launchOwnerID
                let authGeneration = session.validatedAuthGeneration
                let accountScope = launchAccountScope
                await restoreLaunchOperation(
                    ownerID: ownerID,
                    authGeneration: authGeneration,
                    accountScope: accountScope
                )
                guard ownerID == launchOwnerID else { return }
                await loadTemplates()
            }
            .onAppear {
                let ownerID = launchOwnerID
                guard let authGeneration = session.validatedAuthGeneration,
                      let accountScope = launchAccountScope,
                      launchOperationID != nil, !isLaunching
                else { return }
                Task {
                    await checkLaunchOperation(
                        ownerID: ownerID, authGeneration: authGeneration,
                        accountScope: accountScope
                    )
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    resumeAutomaticLaunchStatusPolling()
                } else {
                    stopAutomaticLaunchStatusPolling()
                }
            }
            // Leaving invalidates this view's callbacks before stopping its wait.
            // The durable operation stays available for the next view to reconcile.
            .onDisappear {
                launchOwnerID = UUID()
                stopAutomaticLaunchStatusPolling()
                endWorkstationWait()
            }
    }

    @ViewBuilder
    private var content: some View {
        // The built-in empty environment is always usable. Loading optional
        // environments must never put a blank screen between New pod and Start.
        form.overlay { launchingOverlay }
    }

    private var form: some View {
        Form {
            if unparsedTemplateCount > 0 {
                Section {
                    UnparsedRowsNotice(
                        count: unparsedTemplateCount, resourceName: "environment"
                    )
                }
            }
            workstationSection
            if let templateLoadError {
                Section {
                    RefreshErrorTile(message: templateLoadError) {
                        Task { await loadTemplates(force: true) }
                    }
                }
            }
            environmentSection
            Section {
                Button {
                    guard let authGeneration = session.validatedAuthGeneration,
                          let accountScope = launchAccountScope
                    else { return }
                    let ownerID = launchOwnerID
                    Task {
                        await launch(
                            ownerID: ownerID, authGeneration: authGeneration,
                            accountScope: accountScope
                        )
                    }
                } label: {
                    Label(launchOperationID == nil ? "Start pod" : "Continue launch", systemImage: "plus")
                        .frame(maxWidth: .infinity)
                }
                .brandProminent()
                // A live wait is already re-issuing this launch. A second tap
                // would be a second admission, and two admissions are two pods.
                .disabled(!hasValidatedLaunchContext || isLaunching || isCheckingLaunchStatus
                    || isWaitingForWorkstation || launchOutcomeUnknown)
                .accessibilityLabel(launchOperationID == nil ? "Start new pod" : "Continue pod launch")
                .accessibilityIdentifier("launch.submit")
            }
            if let launchError {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(AppColors.destructive)
                                .accessibilityHidden(true)
                            Text(launchError).foregroundStyle(AppColors.destructive)
                        }
                        if launchOutcomeUnknown {
                            Button(
                                isCheckingLaunchStatus
                                    ? "Checking launch…"
                                    : (launchOperationID == nil ? "Check pod list" : "Check launch status")
                            ) {
                                if launchOperationID == nil {
                                    // A list check cannot establish that an
                                    // unreadable launch record never committed.
                                    router.openPods()
                                } else {
                                    checkLaunchStatusAction()
                                }
                            }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppColors.accent)
                            .frame(minHeight: 44)
                            .disabled(isCheckingLaunchStatus)
                            .accessibilityIdentifier("launch.checkPods")
                        }
                    }
                    .font(.subheadline)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("launch.error")
                }
                .listRowBackground(AppColors.destructiveFill)
            }
        }
    }

    private var environmentSection: some View {
        Section {
            if isLoadingTemplates {
                Label("Loading saved environments…", systemImage: "arrow.triangle.2.circlepath")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
            if Self.showsEnvironmentMenu(templateCount: launchable.count, selection: selection) {
                Picker("Environment", selection: $selection) {
                    Text("Empty environment").tag("")
                    // A retry's exact ID stays visible if the optional list failed.
                    // Never silently substitute an empty pod for that environment.
                    if !selection.isEmpty, !launchable.contains(where: { $0.id == selection }) {
                        Text("Selected environment").tag(selection)
                    }
                    ForEach(launchable) { template in
                        Text(template.name).tag(template.id)
                    }
                }
                .pickerStyle(.menu)
                // The wait relaunches its original environment; this choice is locked.
                .disabled(isLaunching || isWaitingForWorkstation || launchOperationID != nil)
                .accessibilityIdentifier("launch.environment")
            } else {
                LabeledContent("Environment") { Text("Empty environment") }
                    .accessibilityIdentifier("launch.environment")
            }
        } header: {
            Text("Environment")
        } footer: {
            Text(launchOperationID != nil ? Self.pickerLockedFooter : environmentFooter)
        }
    }

    static let pickerLockedFooter = """
        Stopping the wait does not cancel the launch. Check its status before starting another pod or choosing a different environment.
        """

    static let automaticLaunchStatusPollLimit = 5
    static let automaticLaunchStatusPollInterval: TimeInterval = 2

    static func shouldPollLaunchStatus(_ state: String?) -> Bool {
        state == "pending" || state == "unknown"
    }

    struct LaunchStatusRecovery: Equatable {
        let outcomeUnknown: Bool
        let canKeepWaiting: Bool
        let notice: String
    }

    /// Nonterminal replies keep the same durable operation ID; not_found only
    /// permits a user-initiated resend, never an implicit POST from a status GET.
    static func launchStatusRecovery(for state: String) -> LaunchStatusRecovery? {
        switch state {
        case "pending":
            return .init(outcomeUnknown: false, canKeepWaiting: true, notice: launchPendingMessage)
        case "unknown":
            return .init(
                outcomeUnknown: false, canKeepWaiting: true,
                notice: "This launch is unresolved. Continue the same operation; don’t start a new pod yet."
            )
        case "not_found":
            return .init(
                outcomeUnknown: false, canKeepWaiting: true,
                notice: "The server has no record of this launch yet. Continue launch resends the same request ID, or check your pod list first."
            )
        default:
            return nil
        }
    }

    static func canOfferContinueLaunch(
        canKeepWaiting: Bool, outcomeUnknown: Bool, isChecking: Bool
    ) -> Bool {
        canKeepWaiting && !outcomeUnknown && !isChecking
    }

    /// True while a workstation wait is re-issuing the launch. Every manual
    /// launch path is closed for the duration — the wait owns the request.
    private var isWaitingForWorkstation: Bool {
        guard let workstationWait else { return false }
        return !workstationWait.isFinished
    }

    private var launchOperationID: String? { launchOperationRecord?.operationID }

    private var isLaunching: Bool { launchingOwnerID == launchOwnerID }

    private var isCheckingLaunchStatus: Bool {
        launchStatusCheckOwner != nil || launchStatusPendingReconcile != nil
            || manualStatusCheckQueued
    }

    private var launchAccountScope: String? {
        guard let userID = session.user?.id, let orgID = session.currentOrgId else { return nil }
        return "\(Config.serverURL.absoluteString)|\(orgID)|\(userID)"
    }

    private var hasValidatedLaunchContext: Bool {
        session.validatedAuthGeneration != nil && launchAccountScope != nil
    }

    static func templateIDForLaunch(
        operation: LaunchOperationRecord?, selection: String
    ) -> String? {
        if let operation { return operation.templateID }
        return selection.isEmpty ? nil : selection
    }

    static func isCurrentLaunchOperation(
        _ current: LaunchOperationRecord?,
        expected: LaunchOperationRecord,
        expectedAccountScope: String,
        currentAccountScope: String?,
        currentRecordAccountScope: String?,
        expectedOwnerID: UUID,
        currentOwnerID: UUID,
        expectedAuthGeneration: UUID,
        currentAuthGeneration: UUID?
    ) -> Bool {
        current == expected
            && currentAccountScope == expectedAccountScope
            && currentRecordAccountScope == expectedAccountScope
            && currentOwnerID == expectedOwnerID
            && currentAuthGeneration == expectedAuthGeneration
    }

    private func restoreLaunchOperation(
        ownerID: UUID, authGeneration: UUID?, accountScope: String?
    ) async {
        guard let authGeneration, let accountScope,
              ownerID == launchOwnerID,
              authGeneration == session.validatedAuthGeneration,
              accountScope == launchAccountScope
        else { return }
        guard launchOperationRecord == nil || launchOperationAccountScope == accountScope else {
            launchOutcomeUnknown = true
            launchError = "A previous launch belongs to a different account. Reopen New pod to continue."
            return
        }
        do {
            guard let record = try LaunchOperationStore.read(accountScope: accountScope),
                  ownerID == launchOwnerID,
                  authGeneration == session.validatedAuthGeneration,
                  accountScope == launchAccountScope
            else { return }
            launchOperationRecord = record
            launchOperationAccountScope = accountScope
            selection = record.templateID ?? ""
            await checkLaunchOperation(
                operation: record, ownerID: ownerID,
                authGeneration: authGeneration, accountScope: accountScope
            )
        } catch {
            guard ownerID == launchOwnerID,
                  authGeneration == session.validatedAuthGeneration,
                  accountScope == launchAccountScope
            else { return }
            // A corrupt/unreadable operation record is not the same as no
            // operation. Fail closed instead of creating a fresh pod ID.
            launchOutcomeUnknown = true
            launchError = "A previous launch record couldn’t be read. Check the pod list before starting another pod."
        }
    }

    private func ensureLaunchOperationID(accountScope: String) -> String? {
        guard accountScope == launchAccountScope,
              session.validatedAuthGeneration != nil
        else {
            launchError = "Your account is still loading. Try starting the pod again."
            return nil
        }
        if let launchOperationRecord {
            guard launchOperationAccountScope == accountScope else {
                launchOutcomeUnknown = true
                launchError = "A previous launch belongs to a different account. Reopen New pod to continue."
                return nil
            }
            return launchOperationRecord.operationID
        }
        do {
            if let record = try LaunchOperationStore.read(accountScope: accountScope) {
                launchOperationRecord = record
                launchOperationAccountScope = accountScope
                selection = record.templateID ?? ""
                return record.operationID
            }
        } catch {
            launchOutcomeUnknown = true
            launchError = "A previous launch record couldn’t be read. Check the pod list before starting another pod."
            return nil
        }
        let operationID = UUID().uuidString.lowercased()
        guard LaunchOperationStore.write(
            LaunchOperationRecord(
                operationID: operationID, templateID: selection.isEmpty ? nil : selection
            ),
            accountScope: accountScope
        ) else {
            launchError = "Couldn’t save this launch safely. Try again before starting the pod."
            return nil
        }
        launchOperationRecord = LaunchOperationRecord(
            operationID: operationID, templateID: selection.isEmpty ? nil : selection
        )
        launchOperationAccountScope = accountScope
        launchStatusState = nil
        launchStatusPollingChecks = 0
        launchStatusPendingReconcile = nil
        return operationID
    }

    private func clearLaunchOperation(
        _ operation: LaunchOperationRecord,
        accountScope: String,
        ownerID: UUID,
        authGeneration: UUID
    ) {
        guard Self.isCurrentLaunchOperation(
            launchOperationRecord,
            expected: operation,
            expectedAccountScope: accountScope,
            currentAccountScope: launchAccountScope,
            currentRecordAccountScope: launchOperationAccountScope,
            expectedOwnerID: ownerID,
            currentOwnerID: launchOwnerID,
            expectedAuthGeneration: authGeneration,
            currentAuthGeneration: session.validatedAuthGeneration
        ) else { return }
        LaunchOperationStore.remove(
            accountScope: accountScope, operationID: operation.operationID
        )
        stopAutomaticLaunchStatusPolling()
        launchOperationRecord = nil
        launchOperationAccountScope = nil
        launchStatusState = nil
        launchStatusPollingChecks = 0
        launchStatusPendingReconcile = nil
    }

    @discardableResult
    private func checkLaunchOperation(
        operation expectedOperation: LaunchOperationRecord? = nil,
        ownerID: UUID,
        authGeneration: UUID,
        accountScope: String,
        pollingID: UUID? = nil,
        reconcileID: UUID? = nil,
        schedulesAutomaticPolling: Bool = true
    ) async -> LaunchStatusCheckResult {
        guard scenePhase == .active,
              router.selectedTab == .pods, router.podsPath.last?.isLaunch == true,
              ownerID == launchOwnerID,
              authGeneration == session.validatedAuthGeneration,
              accountScope == launchAccountScope,
              launchOperationAccountScope == accountScope,
              let operation = launchOperationRecord,
              expectedOperation == nil || operation == expectedOperation
        else {
            if let reconcileID, launchStatusPendingReconcile?.id == reconcileID {
                launchStatusPendingReconcile = nil
                if launchStatusPollNeedsResume {
                    startAutomaticLaunchStatusTaskIfReady()
                }
            }
            return .skipped
        }

        if let pollingID {
            guard launchStatusPollingRun?.id == pollingID, !Task.isCancelled else {
                return .skipped
            }
        }
        guard launchStatusCheckOwner == nil else {
            if let pollingID, launchStatusPollingRun?.id == pollingID {
                launchStatusPollNeedsResume = true
            } else if pollingID == nil,
                      let currentOwner = launchStatusCheckOwner {
                let existingRequestCoversContext = currentOwner.viewOwnerID == ownerID
                    && currentOwner.operation == operation
                    && currentOwner.authGeneration == authGeneration
                    && currentOwner.accountScope == accountScope
                    && (currentOwner.pollingID == nil
                        || launchStatusPollingRun?.id == currentOwner.pollingID)
                if existingRequestCoversContext {
                    if let reconcileID, launchStatusPendingReconcile?.id == reconcileID {
                        launchStatusPendingReconcile = nil
                    }
                } else {
                    let pendingID: UUID
                    if let reconcileID,
                       launchStatusPendingReconcile?.id == reconcileID {
                        pendingID = reconcileID
                    } else if let pending = launchStatusPendingReconcile,
                              pending.viewOwnerID == ownerID,
                              pending.operation == operation,
                              pending.authGeneration == authGeneration,
                              pending.accountScope == accountScope {
                        pendingID = pending.id
                    } else {
                        pendingID = UUID()
                    }
                    launchStatusPendingReconcile = LaunchStatusReconcileRequest(
                        id: pendingID, viewOwnerID: ownerID, operation: operation,
                        authGeneration: authGeneration, accountScope: accountScope
                    )
                }
            }
            return .busy
        }

        let requestOwner = LaunchStatusCheckOwner(
            requestID: UUID(), viewOwnerID: ownerID, operation: operation,
            authGeneration: authGeneration, accountScope: accountScope,
            pollingID: pollingID
        )
        launchStatusCheckOwner = requestOwner
        if let reconcileID, launchStatusPendingReconcile?.id == reconcileID {
            launchStatusPendingReconcile = nil
        }
        if pollingID != nil { launchStatusPollingChecks += 1 }
        defer { finishLaunchStatusCheck(requestOwner) }

        let status: LaunchOperationSnapshot
        do {
            status = try await api.launchOperation(
                operationID: operation.operationID, expectedGeneration: authGeneration
            )
        } catch {
            guard canApplyLaunchStatusResponse(
                requestOwner, operation: operation,
                authGeneration: authGeneration, accountScope: accountScope
            ) else { return .skipped }
            launchOutcomeUnknown = true
            launchError = "Couldn’t check this launch yet. Do not start another pod until its status is known."
            launchStatusState = "unknown"
            if schedulesAutomaticPolling {
                startAutomaticLaunchStatusPolling(
                    operation: operation, ownerID: ownerID,
                    authGeneration: authGeneration, accountScope: accountScope
                )
            }
            return .status("unknown")
        }

        // A delayed answer for a prior operation/account or canceled poll cannot
        // alter the current launch or schedule work for an obsolete poll run.
        guard canApplyLaunchStatusResponse(
            requestOwner, operation: operation,
            authGeneration: authGeneration, accountScope: accountScope
        ) else { return .skipped }

        launchStatusState = status.state
        switch status.state {
        case "admitted":
            if let launch = status.launch {
                apply(
                    launch, operation: operation, accountScope: accountScope,
                    ownerID: ownerID, authGeneration: authGeneration
                )
            } else if status.podDeleted == true {
                clearLaunchOperation(
                    operation, accountScope: accountScope,
                    ownerID: ownerID, authGeneration: authGeneration
                )
                launchError = "This launch’s pod is no longer available. Start a new pod if you still want one."
                launchOutcomeUnknown = false
            } else {
                launchOutcomeUnknown = true
                launchError = Self.unconfirmedLaunchMessage
            }
        case "waiting":
            launchOutcomeUnknown = false
            canKeepWaiting = true
            launchError = nil
            workstationNotice = status.errorCode
                .flatMap { WorkstationReason(wire: $0).message }
                ?? FriendlyError.workstationStillStarting
        case "rejected":
            clearLaunchOperation(
                operation, accountScope: accountScope,
                ownerID: ownerID, authGeneration: authGeneration
            )
            launchOutcomeUnknown = false
            workstationNotice = nil
            launchError = "The previous launch was refused. Review the reason, then start a new pod if you want to retry."
        case "pending", "unknown", "not_found":
            if let recovery = Self.launchStatusRecovery(for: status.state) {
                launchOutcomeUnknown = recovery.outcomeUnknown
                canKeepWaiting = recovery.canKeepWaiting
                launchError = nil
                workstationNotice = recovery.notice
            }
        default:
            launchOutcomeUnknown = true
            launchError = Self.unconfirmedLaunchMessage
        }

        if Self.shouldPollLaunchStatus(status.state) {
            if schedulesAutomaticPolling {
                startAutomaticLaunchStatusPolling(
                    operation: operation, ownerID: ownerID,
                    authGeneration: authGeneration, accountScope: accountScope
                )
            }
        } else {
            stopAutomaticLaunchStatusPolling()
        }
        return .status(status.state)
    }

    private func canApplyLaunchStatusResponse(
        _ requestOwner: LaunchStatusCheckOwner,
        operation: LaunchOperationRecord,
        authGeneration: UUID,
        accountScope: String
    ) -> Bool {
        guard !Task.isCancelled,
              scenePhase == .active,
              router.selectedTab == .pods, router.podsPath.last?.isLaunch == true,
              launchStatusCheckOwner == requestOwner,
              Self.isCurrentLaunchOperation(
                launchOperationRecord,
                expected: operation,
                expectedAccountScope: accountScope,
                currentAccountScope: launchAccountScope,
                currentRecordAccountScope: launchOperationAccountScope,
                expectedOwnerID: requestOwner.viewOwnerID,
                currentOwnerID: launchOwnerID,
                expectedAuthGeneration: authGeneration,
                currentAuthGeneration: session.validatedAuthGeneration
              )
        else { return false }

        guard let pollingID = requestOwner.pollingID else { return true }
        return !Task.isCancelled
            && scenePhase == .active
            && launchStatusPollingRun?.id == pollingID
    }

    private func finishLaunchStatusCheck(_ requestOwner: LaunchStatusCheckOwner) {
        guard launchStatusCheckOwner?.requestID == requestOwner.requestID else { return }
        launchStatusCheckOwner = nil

        if let pending = launchStatusPendingReconcile {
            guard isCurrentLaunchStatusReconcile(pending) else {
                launchStatusPendingReconcile = nil
                if launchStatusPollNeedsResume {
                    startAutomaticLaunchStatusTaskIfReady()
                }
                return
            }
            Task { @MainActor in
                await checkLaunchOperation(
                    operation: pending.operation, ownerID: pending.viewOwnerID,
                    authGeneration: pending.authGeneration, accountScope: pending.accountScope,
                    reconcileID: pending.id
                )
            }
            return
        }

        if launchStatusPollNeedsResume {
            startAutomaticLaunchStatusTaskIfReady()
        }
    }

    private func isCurrentLaunchStatusReconcile(
        _ request: LaunchStatusReconcileRequest
    ) -> Bool {
        scenePhase == .active
            && router.selectedTab == .pods
            && router.podsPath.last?.isLaunch == true
            && request.viewOwnerID == launchOwnerID
            && request.authGeneration == session.validatedAuthGeneration
            && request.accountScope == launchAccountScope
            && launchOperationRecord == request.operation
            && launchOperationAccountScope == request.accountScope
    }

    private func startAutomaticLaunchStatusPolling(
        operation: LaunchOperationRecord,
        ownerID: UUID,
        authGeneration: UUID,
        accountScope: String
    ) {
        guard Self.shouldPollLaunchStatus(launchStatusState),
              launchStatusPollingChecks < Self.automaticLaunchStatusPollLimit,
              scenePhase == .active,
              router.selectedTab == .pods, router.podsPath.last?.isLaunch == true,
              !isLaunching,
              !isWaitingForWorkstation,
              ownerID == launchOwnerID,
              authGeneration == session.validatedAuthGeneration,
              accountScope == launchAccountScope,
              launchOperationRecord == operation,
              launchOperationAccountScope == accountScope
        else { return }

        if let run = launchStatusPollingRun {
            if run.operation == operation,
               run.ownerID == ownerID,
               run.authGeneration == authGeneration,
               run.accountScope == accountScope {
                guard launchStatusPollingTask == nil else { return }
                launchStatusPollNeedsResume = true
                startAutomaticLaunchStatusTaskIfReady()
                return
            }
            stopAutomaticLaunchStatusPolling()
        }

        launchStatusPollingRun = LaunchStatusPollingRun(
            id: UUID(), operation: operation, ownerID: ownerID,
            authGeneration: authGeneration, accountScope: accountScope
        )
        launchStatusPollNeedsResume = true
        startAutomaticLaunchStatusTaskIfReady()
    }

    private func startAutomaticLaunchStatusTaskIfReady() {
        guard launchStatusPollNeedsResume,
              let run = launchStatusPollingRun,
              launchStatusPollingTask == nil,
              launchStatusPollingTaskID == nil,
              launchStatusCheckOwner == nil,
              launchStatusPendingReconcile == nil,
              launchStatusPollingChecks < Self.automaticLaunchStatusPollLimit,
              Self.shouldPollLaunchStatus(launchStatusState),
              scenePhase == .active,
              router.selectedTab == .pods, router.podsPath.last?.isLaunch == true,
              !isLaunching,
              !isWaitingForWorkstation,
              run.ownerID == launchOwnerID,
              run.authGeneration == session.validatedAuthGeneration,
              run.accountScope == launchAccountScope,
              launchOperationRecord == run.operation,
              launchOperationAccountScope == run.accountScope
        else { return }

        launchStatusPollNeedsResume = false
        launchStatusPollingTaskID = run.id
        launchStatusPollingTask = Task { @MainActor in
            defer {
                if launchStatusPollingTaskID == run.id {
                    launchStatusPollingTaskID = nil
                    launchStatusPollingTask = nil
                    let runIsCurrent = launchStatusPollingRun == run
                        && run.ownerID == launchOwnerID
                        && run.authGeneration == session.validatedAuthGeneration
                        && run.accountScope == launchAccountScope
                        && launchOperationRecord == run.operation
                        && launchOperationAccountScope == run.accountScope
                        && scenePhase == .active
                        && router.selectedTab == .pods
                        && router.podsPath.last?.isLaunch == true
                        && !isLaunching && !isWaitingForWorkstation
                    if !runIsCurrent
                        || !Self.shouldPollLaunchStatus(launchStatusState)
                        || launchStatusPollingChecks >= Self.automaticLaunchStatusPollLimit {
                        launchStatusPollingRun = nil
                        launchStatusPollNeedsResume = false
                    } else if launchStatusPollNeedsResume {
                        startAutomaticLaunchStatusTaskIfReady()
                    }
                }
            }

            while !Task.isCancelled,
                  launchStatusPollingTaskID == run.id,
                  launchStatusPollingRun == run,
                  launchStatusPollingChecks < Self.automaticLaunchStatusPollLimit,
                  Self.shouldPollLaunchStatus(launchStatusState),
                  scenePhase == .active,
                  !isLaunching,
                  !isWaitingForWorkstation,
                  run.ownerID == launchOwnerID,
                  run.authGeneration == session.validatedAuthGeneration,
                  run.accountScope == launchAccountScope,
                  launchOperationRecord == run.operation,
                  launchOperationAccountScope == run.accountScope
            {
                do {
                    try await Task.sleep(
                        nanoseconds: UInt64(
                            Self.automaticLaunchStatusPollInterval * 1_000_000_000
                        )
                    )
                } catch {
                    break
                }
                guard !Task.isCancelled,
                      launchStatusPollingTaskID == run.id,
                      launchStatusPollingRun == run,
                      scenePhase == .active
                else { break }

                switch await checkLaunchOperation(
                    operation: run.operation, ownerID: run.ownerID,
                    authGeneration: run.authGeneration, accountScope: run.accountScope,
                    pollingID: run.id
                ) {
                case .status(let state):
                    if !Self.shouldPollLaunchStatus(state) { return }
                case .busy:
                    launchStatusPollNeedsResume = true
                    return
                case .skipped:
                    return
                }
            }
        }
    }

    private func stopAutomaticLaunchStatusPolling() {
        launchStatusPollNeedsResume = false
        launchStatusPollingRun = nil
        launchStatusPollingTask?.cancel()
        launchStatusPollingTask = nil
        launchStatusPollingTaskID = nil
    }

    private func resumeAutomaticLaunchStatusPolling() {
        guard scenePhase == .active,
              let operation = launchOperationRecord,
              let authGeneration = session.validatedAuthGeneration,
              let accountScope = launchOperationAccountScope,
              router.selectedTab == .pods, router.podsPath.last?.isLaunch == true,
              !isLaunching, !isWaitingForWorkstation
        else { return }
        if Self.shouldPollLaunchStatus(launchStatusState) {
            startAutomaticLaunchStatusPolling(
                operation: operation, ownerID: launchOwnerID,
                authGeneration: authGeneration, accountScope: accountScope
            )
        } else if launchStatusState == nil {
            Task {
                await checkLaunchOperation(
                    operation: operation, ownerID: launchOwnerID,
                    authGeneration: authGeneration, accountScope: accountScope
                )
            }
        }
    }

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
                    retryTitle: Self.canOfferContinueLaunch(
                        canKeepWaiting: canKeepWaiting,
                        outcomeUnknown: launchOutcomeUnknown,
                        isChecking: isCheckingLaunchStatus
                    ) ? "Continue launch" : nil,
                    onRetry: Self.canOfferContinueLaunch(
                        canKeepWaiting: canKeepWaiting,
                        outcomeUnknown: launchOutcomeUnknown,
                        isChecking: isCheckingLaunchStatus
                    ) ? keepWaitingAction : nil,
                    secondaryTitle: launchOperationID != nil
                        && (launchOutcomeUnknown || Self.shouldPollLaunchStatus(launchStatusState))
                        ? (isCheckingLaunchStatus ? "Checking launch…" : "Check status") : nil,
                    onSecondary: checkLaunchStatusAction,
                    secondaryDisabled: isCheckingLaunchStatus || isLaunching || isWaitingForWorkstation
                )
            }
        }
    }

    private var checkLaunchStatusAction: () -> Void {
        guard let authGeneration = session.validatedAuthGeneration,
              let accountScope = launchAccountScope
        else { return {} }
        let ownerID = launchOwnerID
        return {
            guard scenePhase == .active,
                  router.selectedTab == .pods, router.podsPath.last?.isLaunch == true,
                  ownerID == launchOwnerID,
                  authGeneration == session.validatedAuthGeneration,
                  accountScope == launchAccountScope,
                  launchOperationAccountScope == accountScope,
                  launchOperationRecord != nil,
                  !isLaunching, !isWaitingForWorkstation, !isCheckingLaunchStatus
            else { return }
            stopAutomaticLaunchStatusPolling()
            manualStatusCheckQueued = true
            Task { @MainActor in
                defer { manualStatusCheckQueued = false }
                await checkLaunchOperation(
                    ownerID: ownerID, authGeneration: authGeneration,
                    accountScope: accountScope, schedulesAutomaticPolling: false
                )
            }
        }
    }

    private var keepWaitingAction: (() -> Void)? {
        guard canKeepWaiting,
              let authGeneration = session.validatedAuthGeneration,
              let accountScope = launchAccountScope
        else { return nil }
        let ownerID = launchOwnerID
        return {
            Task {
                await launch(
                    ownerID: ownerID, authGeneration: authGeneration,
                    accountScope: accountScope
                )
            }
        }
    }

    @ViewBuilder
    private var launchingOverlay: some View {
        if isLaunching {
            ZStack {
                Color.black.opacity(0.08).ignoresSafeArea()
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Launching pod…")
                }
                .padding(20)
                .background(AppColors.card, in: RoundedRectangle(cornerRadius: 14))
                .shadow(radius: 12, y: 4)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Launching pod")
            .accessibilityAddTraits(.updatesFrequently)
        }
    }

    /// Every environment the server returns is launchable: there is no draft or
    /// approval state left to hold one back.
    private var launchable: [PodTemplate] { templates }

    static func showsEnvironmentMenu(templateCount: Int, selection: String) -> Bool {
        templateCount > 0 || !selection.isEmpty
    }

    private var environmentFooter: String {
        Self.environmentFooter(templates: launchable, selection: selection,
                               isLoading: isLoadingTemplates)
    }

    static func environmentFooter(
        templates: [PodTemplate], selection: String, isLoading: Bool
    ) -> String {
        let start: String
        if let template = templates.first(where: { $0.id == selection }) {
            start = (template.initScript?.isEmpty == false)
                ? "Runs this environment’s setup script before you connect."
                : "This environment has no setup script, so the pod starts empty."
        } else if !selection.isEmpty {
            start = isLoading
                ? "Loading this saved environment so it can be used for the pod."
                : "This saved environment will be used if it is still available."
        } else if templates.isEmpty {
            start = "Starts a pod with an empty filesystem."
        } else {
            start = """
                Starts a pod with an empty filesystem. Pick an environment to have its \
                setup script run first.
                """
        }
        return "\(start) Your saved secrets and connected model providers travel into it."
    }

    // MARK: - Actions

    private func loadTemplates(force: Bool = false) async {
        guard force || templates.isEmpty else { return }
        isLoadingTemplates = true
        defer { isLoadingTemplates = false }
        do {
            let loaded = try await api.templates()
            templates = loaded.items
            unparsedTemplateCount = loaded.unparsedRows.count
            templateLoadError = nil
            // An environment that has since been deleted must not stay selected
            // after a successful list read. A failed read leaves the exact retry
            // selection intact rather than silently switching to empty.
            if launchOperationRecord == nil,
               !selection.isEmpty, !launchable.contains(where: { $0.id == selection }) {
                selection = ""
            }
        } catch {
            templateLoadError = FriendlyError.message(error, serverHost: Config.serverURL)
        }
    }

    private func launch(
        ownerID: UUID, authGeneration: UUID, accountScope: String
    ) async {
        // The wait owns repeated admissions. This action is single-flight even
        // before SwiftUI redraws the disabled button, and every retry keeps the
        // same durable operation UUID.
        guard ownerID == launchOwnerID,
              authGeneration == session.validatedAuthGeneration,
              accountScope == launchAccountScope,
              !isWaitingForWorkstation, !isLaunching, !isCheckingLaunchStatus,
              !launchOutcomeUnknown,
              let operationID = ensureLaunchOperationID(accountScope: accountScope),
              let operation = launchOperationRecord,
              operation.operationID == operationID
        else { return }
        stopAutomaticLaunchStatusPolling()
        launchStatusState = nil
        launchingOwnerID = ownerID
        launchError = nil
        launchOutcomeUnknown = false
        workstationNotice = nil
        defer {
            if launchingOwnerID == ownerID { launchingOwnerID = nil }
            if Self.shouldPollLaunchStatus(launchStatusState) {
                Task { @MainActor in
                    await Task.yield()
                    resumeAutomaticLaunchStatusPolling()
                }
            }
        }
        do {
            handle(
                try await api.launch(
                    templateId: Self.templateIDForLaunch(
                        operation: operation, selection: selection
                    ),
                    operationID: operation.operationID,
                    expectedGeneration: authGeneration
                ),
                operation: operation,
                accountScope: accountScope,
                ownerID: ownerID,
                authGeneration: authGeneration
            )
        } catch {
            guard Self.isCurrentLaunchOperation(
                launchOperationRecord,
                expected: operation,
                expectedAccountScope: accountScope,
                currentAccountScope: launchAccountScope,
                currentRecordAccountScope: launchOperationAccountScope,
                expectedOwnerID: ownerID,
                currentOwnerID: launchOwnerID,
                expectedAuthGeneration: authGeneration,
                currentAuthGeneration: session.validatedAuthGeneration
            ) else { return }
            if let apiError = error as? APIError,
               let demand = WorkstationDemandDetail.parse(apiError) {
                beginWorkstationWait(
                    demand, operation: operation, accountScope: accountScope,
                    ownerID: ownerID, authGeneration: authGeneration
                )
                return
            }
            if Self.isAmbiguousLaunchError(error) {
                launchOutcomeUnknown = true
                launchError = Self.unconfirmedLaunchMessage
            } else {
                launchError = FriendlyError.message(error, serverHost: Config.serverURL)
            }
            // A request-level refusal does not prove the logical operation is
            // terminal: another owner may already hold a newer generation.
            // Only its scoped status may release the persisted operation ID.
            await checkLaunchOperation(
                operation: operation, ownerID: ownerID,
                authGeneration: authGeneration, accountScope: accountScope
            )
        }
    }

    private func handle(
        _ attempt: LaunchAttempt,
        operation: LaunchOperationRecord,
        accountScope: String,
        ownerID: UUID,
        authGeneration: UUID
    ) {
        guard Self.isCurrentLaunchOperation(
            launchOperationRecord,
            expected: operation,
            expectedAccountScope: accountScope,
            currentAccountScope: launchAccountScope,
            currentRecordAccountScope: launchOperationAccountScope,
            expectedOwnerID: ownerID,
            currentOwnerID: launchOwnerID,
            expectedAuthGeneration: authGeneration,
            currentAuthGeneration: session.validatedAuthGeneration
        ) else { return }
        switch attempt {
        case .admitted(let response):
            apply(
                response, operation: operation, accountScope: accountScope,
                ownerID: ownerID, authGeneration: authGeneration
            )
        case .pending:
            launchOutcomeUnknown = false
            canKeepWaiting = true
            launchError = nil
            workstationNotice = Self.launchPendingMessage
            launchStatusState = "pending"
            if !isLaunching { resumeAutomaticLaunchStatusPolling() }
        }
    }

    private func apply(
        _ response: LaunchResponse,
        operation: LaunchOperationRecord,
        accountScope: String,
        ownerID: UUID,
        authGeneration: UUID
    ) {
        // A delayed response may not navigate or clear a replacement operation.
        guard Self.isCurrentLaunchOperation(
            launchOperationRecord,
            expected: operation,
            expectedAccountScope: accountScope,
            currentAccountScope: launchAccountScope,
            currentRecordAccountScope: launchOperationAccountScope,
            expectedOwnerID: ownerID,
            currentOwnerID: launchOwnerID,
            expectedAuthGeneration: authGeneration,
            currentAuthGeneration: session.validatedAuthGeneration
        ) else { return }
        // The operation is durable even if this view disappeared while the
        // request was in flight. Never navigate back from another tab/route.
        guard router.selectedTab == .pods, router.podsPath.last?.isLaunch == true else { return }
        // A launch that landed answers the wait: ending it here is what stops the
        // loop from POSTing one more pod after this screen is done with it.
        endWorkstationWait()
        workstationNotice = nil
        // Creation is complete. The conversation is the next useful screen;
        // any report is carried there as a non-blocking notice instead of a
        // second acknowledgement step.
        open(response)
        clearLaunchOperation(
            operation, accountScope: accountScope,
            ownerID: ownerID, authGeneration: authGeneration
        )
    }

    /// The launch is re-issued every cycle, because the server's admission is
    /// the only thing that proves the workstation can take a pod.
    private func beginWorkstationWait(
        _ detail: WorkstationDemandDetail,
        operation: LaunchOperationRecord,
        accountScope: String,
        ownerID: UUID,
        authGeneration: UUID
    ) {
        guard Self.isCurrentLaunchOperation(
            launchOperationRecord,
            expected: operation,
            expectedAccountScope: accountScope,
            currentAccountScope: launchAccountScope,
            currentRecordAccountScope: launchOperationAccountScope,
            expectedOwnerID: ownerID,
            currentOwnerID: launchOwnerID,
            expectedAuthGeneration: authGeneration,
            currentAuthGeneration: session.validatedAuthGeneration
        ) else { return }
        launchError = nil
        workstationNotice = nil
        if let existing = workstationWait, !existing.isFinished {
            existing.adopt(detail)
            return
        }
        let client = api
        let templateId = operation.templateID
        let wait = WorkstationWait(
            detail: detail,
            status: {
                try await client.workstationStatus(
                    hostId: $0, expectedGeneration: authGeneration
                )
            }
        )
        workstationWait = wait
        // `.create`: every attempt uses the same server operation ID. A lost
        // response is reconciled against that admission, never a fresh pod.
        wait.start(policy: .create) {
            guard Self.isCurrentLaunchOperation(
                launchOperationRecord,
                expected: operation,
                expectedAccountScope: accountScope,
                currentAccountScope: launchAccountScope,
                currentRecordAccountScope: launchOperationAccountScope,
                expectedOwnerID: ownerID,
                currentOwnerID: launchOwnerID,
                expectedAuthGeneration: authGeneration,
                currentAuthGeneration: session.validatedAuthGeneration
            ) else { throw CancellationError() }
            return try await client.launch(
                templateId: templateId,
                operationID: operation.operationID,
                expectedGeneration: authGeneration
            )
        } completion: { outcome in
            guard workstationWait === wait,
                  Self.isCurrentLaunchOperation(
                    launchOperationRecord,
                    expected: operation,
                    expectedAccountScope: accountScope,
                    currentAccountScope: launchAccountScope,
                    currentRecordAccountScope: launchOperationAccountScope,
                    expectedOwnerID: ownerID,
                    currentOwnerID: launchOwnerID,
                    expectedAuthGeneration: authGeneration,
                    currentAuthGeneration: session.validatedAuthGeneration
                  )
            else { return }
            workstationWait = nil
            canKeepWaiting = outcome.canKeepWaiting
            switch outcome {
            case .succeeded(let attempt):
                handle(
                    attempt, operation: operation, accountScope: accountScope,
                    ownerID: ownerID, authGeneration: authGeneration
                )
            case .failed(let error):
                if Self.isAmbiguousLaunchError(error) {
                    launchOutcomeUnknown = true
                    launchError = Self.unconfirmedLaunchMessage
                } else {
                    launchError = FriendlyError.message(error, serverHost: Config.serverURL)
                }
                Task {
                    await checkLaunchOperation(
                        operation: operation, ownerID: ownerID,
                        authGeneration: authGeneration, accountScope: accountScope
                    )
                }
            case .unconfirmed:
                launchOutcomeUnknown = true
                workstationNotice = Self.unconfirmedLaunchMessage
            case .terminal:
                // A refusal can belong to an expired owner while a newer one
                // is still active. Reconcile before clearing the durable ID.
                launchOutcomeUnknown = true
                workstationNotice = outcome.endingMessage
                Task {
                    await checkLaunchOperation(
                        operation: operation, ownerID: ownerID,
                        authGeneration: authGeneration, accountScope: accountScope
                    )
                }
            default:
                workstationNotice = outcome.endingMessage
            }
        }
    }

    /// A launch whose answer was lost. Reconcile the same operation ID rather
    /// than creating a fresh pod.
    static let launchPendingMessage = """
        A pod launch is still being processed. Check status to read progress. Continue launch resends the same request ID.
        """

    static let unconfirmedLaunchMessage = """
        The connection dropped before the server answered. Check this launch's status before \
        starting another pod.
        """

    /// A response without a usable HTTP verdict does not prove that creation
    /// failed. A server may have committed the pod before a timeout, decode
    /// failure, or connection loss reached the phone.
    static func isAmbiguousLaunchError(_ error: Error) -> Bool {
        if error is AuthContextChangedError { return true }
        if let apiError = error as? APIError {
            guard let status = apiError.transportStatus else { return true }
            return status == 408 || status >= 500
        }
        if error is DecodingError { return true }
        return (error as NSError).domain == NSURLErrorDomain
    }

    /// Ends the wait and the task behind it. One call, everywhere the wait stops
    /// being this screen's business.
    private func endWorkstationWait() {
        workstationWait?.abandon()
        workstationWait = nil
    }

    static func hasSomethingToSay(_ report: LaunchReport) -> Bool {
        !report.clamps.isEmpty || !report.secretKeys.isEmpty
            || !PodDetailView.userFacingWarnings(report.warnings).isEmpty
    }

    /// Replaces this screen with the new pod's conversation: the launch is spent,
    /// and leaving it on the stack would invite a second one.
    private func open(_ response: LaunchResponse) {
        router.openSessionFromLaunch(response)
    }
}
