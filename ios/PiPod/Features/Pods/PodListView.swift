import SwiftUI

/// The screen people open the app to.
///
/// Every pod they can reach, the ones that need attention first, with co-located
/// children folded under the machine they share. What the list is showing is always
/// said out loud: a narrowed list names its filter and offers one tap out of it.
public struct PodListView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.apiClient) private var api
    @Environment(\.scenePhase) private var scenePhase

    @State private var pods: [Pod] = []
    @State private var templates: [PodTemplate] = []
    @State private var unparsedPodCount = 0
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var filter = PodFilter()
    @State private var showsFilterSheet = false
    /// Pull-to-refresh during the initializing poll (or a double tap on refresh)
    /// must not stack requests: last-writer-wins can briefly show older data.
    @State private var isFetching = false
    @State private var didLoadOnce = false
    /// Live while this account's own workstation is coming up. A distinct state:
    /// not a pod asleep, and not the fleet running out of room.
    @State private var workstationWait: WorkstationWait?
    @State private var workstationNotice: String?
    @State private var canKeepWaiting = false
    /// When the plan line was last re-read, so the four-second poll that watches
    /// a starting pod does not also poll billing.
    @State private var lastBillingRead: Date?
    /// True once the server has answered "there is no billing here" — the
    /// self-hosted case, which is stable for the whole session.
    @State private var billingAbsent = false

    public init() {}

    public var body: some View {
        searchableList
            .navigationTitle("Pods")
            .toolbar { toolbarContent }
            .refreshable { await refresh() }
            .task { await initialLoad() }
            .task { await pollWhileStarting() }
            .onAppear {
                // Coming back from a detail that archived, deleted or launched
                // something: the list must show what happened without a pull.
                guard didLoadOnce else { return }
                Task { await refreshPods() }
            }
            // Pushing a detail or switching tabs takes this screen away; a wait
            // polling behind it is work nobody is looking at. Coming back starts
            // it again from the refusal that is still true.
            .onDisappear { endWorkstationWait() }
            .onChange(of: scenePhase) { _, phase in
                // Sleep/wake transitions that happened in the background leave
                // stale statuses on screen until something asks the server.
                guard phase == .active, didLoadOnce else { return }
                // Coming back is exactly when a cap may have tripped or a trial
                // ended, so the plan line is re-read without waiting out the
                // throttle below.
                lastBillingRead = nil
                Task { await refreshPods() }
                // Approvals raised or answered while the app was away leave the
                // badge and the notice row stale until something asks.
                Task { await session.refreshApprovalsBadge() }
            }
            .sheet(isPresented: $showsFilterSheet) {
                PodFilterSheet(
                    filter: filter,
                    projects: PodFilter.projects(in: pods),
                    environments: PodFilter.environments(in: pods, named: templates),
                    hasUnassignedProject: pods.contains { $0.projectName == nil },
                    hasPodsWithoutEnvironment: pods.contains { $0.templateId == nil },
                    showsOwnerFilter: showsOwnerFilter,
                    apply: { applied in
                        filter.status = applied.status
                        filter.project = applied.project
                        filter.environment = applied.environment
                        filter.onlyMine = applied.onlyMine
                    }
                )
            }
    }

    /// The search field only exists when there is something to search.
    @ViewBuilder
    private var searchableList: some View {
        if pods.isEmpty {
            list
        } else {
            list
                .searchable(
                    text: $filter.search,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Search pods and projects"
                )
                // A pod name is an identifier, not prose: an autocapitalised "On"
                // or a corrected "pi-pod" would be searching for something else.
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
    }

    private var list: some View {
        List {
            if session.pendingApprovalsCount > 0 { approvalsSection }
            blockedBillingSection
            workstationSection
            if let loadError, !pods.isEmpty {
                Section {
                    RefreshErrorTile(message: loadError) { Task { await refresh() } }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .accessibilityIdentifier("pods.refreshError")
                }
            }
            if unparsedPodCount > 0 {
                Section {
                    UnparsedRowsNotice(count: unparsedPodCount, resourceName: "pod")
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            if !filter.isDefault, !pods.isEmpty { filterSummarySection }

            if isLoading, pods.isEmpty {
                fullScreenRow {
                    LoadingView(label: "Loading pods…").frame(height: 220)
                }
            } else if pods.isEmpty, unparsedPodCount == 0 {
                fullScreenRow { emptyState }
            } else if visiblePods.isEmpty {
                fullScreenRow { noMatchesState }
            } else {
                ForEach(visibleGroups) { group in
                    Section { groupRows(group) }
                }
                if let breakdown = hiddenBreakdown { showEverythingSection(breakdown) }
            }
            billingSection
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Sections

    /// The whole billing surface. It exists only when the server sent fields to
    /// render: under the self-hosted backend this builds nothing at all, so
    /// there is no header, no placeholder and no reserved space.
    ///
    /// An account that cannot start machines is not a footer statistic, so that
    /// one state is drawn at the top instead — see `blockedBillingSection`.
    @ViewBuilder
    private var billingSection: some View {
        if let billing = session.billing, !billing.startsBlocked {
            Section { BillingSummaryRow(summary: billing) }
        }
    }

    /// The plan line, promoted to the top of the list while it is the reason
    /// "New pod" does nothing. A disabled button whose explanation is below the
    /// fold is a dead end.
    @ViewBuilder
    private var blockedBillingSection: some View {
        if let billing = session.billing, billing.startsBlocked {
            Section {
                BillingSummaryRow(summary: billing)
                    .accessibilityIdentifier("pods.billingBlocked")
            }
            .listRowBackground(AppColors.destructiveFill)
        }
    }

    /// True when the server has already said this account's machines will not
    /// start. Launching would spend a round trip to be refused with a 402.
    private var isLaunchBlocked: Bool { session.billing?.startsBlocked ?? false }

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

    /// Offered only when waiting again can still succeed.
    private var keepWaitingAction: (() -> Void)? {
        guard canKeepWaiting else { return nil }
        return { Task { await refreshPods() } }
    }

    private var approvalsSection: some View {
        Section {
            Button {
                router.openApprovals()
            } label: {
                HStack {
                    Label("Waiting for your approval", systemImage: "shield.lefthalf.filled")
                        .foregroundStyle(AppColors.label)
                    Spacer()
                    Text("\(session.pendingApprovalsCount)")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(AppColors.notice)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(AppColors.noticeFill, in: Capsule())
                }
            }
            .listRowBackground(AppColors.noticeFill)
            .accessibilityLabel(
                "Open pending approvals, \(session.pendingApprovalsCount) pending"
            )
            .accessibilityIdentifier("pods.approvals")
        }
    }

    private var filterSummarySection: some View {
        Section {
            HStack {
                Text("Showing \(filter.summary)")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
                Spacer(minLength: 12)
                Button("Clear") { clearFilters() }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(AppColors.accent)
                    // A .plain footnote button is ~13pt tall; recovery actions
                    // carry the same 44pt minimum as every other control here.
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Clear pod filters")
                    .accessibilityIdentifier("pods.clearFilters")
            }
        }
    }

    @ViewBuilder
    private func groupRows(_ group: PodGroup) -> some View {
        podRow(group.root, depth: 0)
        ForEach(group.children) { child in
            // A child always says where it lives: "on <host>" is the whole point
            // of showing it indented under that host.
            podRow(child, depth: 1, forcesLocation: true)
        }
    }

    private func podRow(
        _ pod: Pod, depth: Int, forcesLocation: Bool = false
    ) -> some View {
        NavigationLink(value: PodRoute.detail(podId: pod.id, pod: pod)) {
            PodRowView(
                pod: pod,
                depth: depth,
                showsLocation: forcesLocation || showsLocation,
                showsOwner: showsOwnerMetadata && pod.userId != session.user?.id
            )
        }
        .accessibilityIdentifier("pod.row.\(pod.id)")
        // Deliberately not a full swipe: a stray drag across the list must reveal
        // the shortcut, not take you into a conversation.
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if pod.canOpenSession {
                Button {
                    router.openSession(podId: pod.id, pod: pod)
                } label: {
                    Label("Open session", systemImage: "bubble.left.and.bubble.right")
                }
                .tint(AppColors.accent)
            }
        }
    }

    private func showEverythingSection(_ breakdown: String) -> some View {
        Section {
            Button {
                filter.status = .all
            } label: {
                Label("Show \(breakdown)", systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(AppColors.accent)
            }
            .accessibilityIdentifier("pods.showHidden")
        }
    }

    private var emptyState: some View {
        let failed = loadError != nil
        // Offering "New pod" to an account the server will refuse is a button
        // that can only fail; the reason takes its place.
        let blocked = !failed && isLaunchBlocked
        let action: (() -> Void)? = blocked
            ? nil
            : { if failed { Task { await refresh() } } else { openLaunch() } }
        let actionTitle: String?
        if failed {
            actionTitle = "Try again"
        } else {
            actionTitle = blocked ? nil : "New pod"
        }
        let message: String
        if let loadError {
            message = loadError
        } else {
            message = blocked
                ? blockedLaunchMessage : "Launch a pod to start a remote pi session."
        }
        return EmptyStateView(
            title: failed ? "Couldn’t load pods" : "No pods yet",
            message: message,
            systemImage: failed ? "wifi.slash" : (blocked ? "creditcard" : "shippingbox"),
            actionTitle: actionTitle,
            action: action
        )
    }

    private var blockedLaunchMessage: String {
        session.billing?.startBlockedSentence
            ?? "New pods can’t start on this account right now."
    }

    private var noMatchesState: some View {
        EmptyStateView(
            title: "No pods match",
            message: filter.search.isEmpty
                ? "No pods match “\(filter.summary)”."
                : "Nothing matches “\(filter.search)”.",
            systemImage: "doc.text.magnifyingglass",
            actionTitle: filter.isDefault
                ? hiddenBreakdown.map { "Show \($0)" }
                : "Clear filters",
            action: {
                if filter.isDefault {
                    filter.status = .all
                } else {
                    clearFilters()
                }
            }
        )
    }

    /// A row that is really a whole screen: no card, no separator, no inset.
    private func fullScreenRow<Content: View>(
        @ViewBuilder _ content: () -> Content
    ) -> some View {
        content()
            .frame(maxWidth: .infinity)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                Task { await refresh() }
            } label: {
                if isLoading && !pods.isEmpty {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .disabled(isLoading)
            .accessibilityLabel("Refresh pods")
            .accessibilityIdentifier("pods.refresh")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showsFilterSheet = true
            } label: {
                // The icon never changes: an active filter is said with a badge, so
                // the control stays recognisable as the way back to the sheet.
                Image(systemName: "line.3.horizontal.decrease")
                    .overlay(alignment: .topTrailing) {
                        if !filter.isDefault {
                            Circle()
                                .fill(AppColors.accent)
                                .frame(width: 8, height: 8)
                                .offset(x: 5, y: -3)
                        }
                    }
            }
            .disabled(pods.isEmpty)
            .accessibilityLabel(
                filter.isDefault ? "Filter pods" : "Filter pods, showing \(filter.summary)"
            )
            .accessibilityIdentifier("pods.filter")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button(action: openLaunch) {
                Image(systemName: "plus")
            }
            // The server has already answered: a launch from here would come
            // back a 402. The sentence sits at the top of the list.
            .disabled(isLaunchBlocked)
            .accessibilityLabel(
                isLaunchBlocked ? "New pod, unavailable" : "New pod"
            )
            .accessibilityHint(isLaunchBlocked ? blockedLaunchMessage : "")
            .accessibilityIdentifier("pods.new")
        }
    }

    // MARK: - What the list is showing

    private var visibleGroups: [PodGroup] {
        attentionFirst(groupPods(filter.apply(to: pods, currentUserID: session.user?.id)))
    }

    private var visiblePods: [Pod] { visibleGroups.flatMap(\.members) }

    /// Location is noise when every visible pod lives in the same place.
    private var showsLocation: Bool {
        Set(visiblePods.map(\.displayLocation)).count > 1
            || visiblePods.contains(where: \.isHostChild)
    }

    /// Pods the status filter alone is holding back: they match the search and
    /// everything else, so the list can offer them rather than pretend they are gone.
    private var hiddenByStatus: [Pod] {
        var everyStatus = filter
        everyStatus.status = .all
        let shown = Set(visiblePods.map(\.id))
        return everyStatus.apply(to: pods, currentUserID: session.user?.id)
            .filter { !shown.contains($0.id) }
    }

    private var hiddenBreakdown: String? { PodFilter.statusBreakdown(of: hiddenByStatus) }

    private var showsOwnerMetadata: Bool { Set(pods.map(\.userId)).count > 1 }

    /// Only worth offering when there is more than one person's work in the list.
    private var showsOwnerFilter: Bool {
        guard let me = session.user?.id else { return false }
        return pods.contains { $0.userId == me } && pods.contains { $0.userId != me }
    }

    // MARK: - Actions

    private func openLaunch() {
        router.podsPath.append(.launch)
    }

    private func clearFilters() { filter.clear() }

    private func initialLoad() async {
        guard !didLoadOnce else { return }
        await refresh()
        didLoadOnce = true
    }

    private func refresh() async {
        isLoading = true
        await refreshPods()
        do {
            let loaded = try await api.templates()
            templates = loaded.items
        } catch {
            // Naming an environment is a nicety; a failure here must not hide a
            // healthy pod list. The launch screen reports its own load failure.
        }
        isLoading = false
    }

    private func refreshPods() async {
        if isFetching { return }
        isFetching = true
        defer { isFetching = false }
        do {
            apply(try await api.podsPage())
            await refreshBilling()
        } catch {
            // The account's own workstation being down is not a load failure: the
            // list is not broken, it is not yet servable, and it comes back on its
            // own. It is also never fleet pressure.
            if let apiError = error as? APIError,
               let demand = WorkstationDemandDetail.parse(apiError) {
                beginWorkstationWait(demand)
                return
            }
            loadError = FriendlyError.message(error, serverHost: Config.serverURL)
        }
    }

    private func apply(_ page: PodsPage) {
        pods = page.pods.items
        unparsedPodCount = page.pods.unparsedRows.count
        loadError = nil
        // The list came back, so the wait has its answer. Clearing it without
        // ending it would leave the loop walking the paged list every 10 s for
        // the rest of its budget with nobody reading the result.
        endWorkstationWait()
        workstationNotice = nil
        session.applyBilling(page.billing)
        reconcileFilters()
    }

    /// The SaaS billing state, re-read alongside the list.
    ///
    /// `/v1/pods` carries no billing block, so signing in was the only time the
    /// plan line was ever read: a cap that tripped mid-session, or a trial that
    /// ended, stayed invisible until the next launch was refused.
    ///
    /// Throttled, because this screen also refreshes every four seconds while a
    /// pod is starting and an entitlement does not change that fast. A nil
    /// answer is the self-hosted backend saying it has no billing surface at
    /// all (404 / 403), which will not change under a running app — so it is
    /// asked once and then left alone.
    private func refreshBilling() async {
        guard !billingAbsent else { return }
        let now = Date()
        if let last = lastBillingRead, now.timeIntervalSince(last) < 60 { return }
        lastBillingRead = now
        do {
            guard let summary = try await api.billingSummary() else {
                billingAbsent = true
                return
            }
            session.applyBilling(summary)
        } catch {
            // A transient failure says nothing about whether this deployment
            // has billing, and nothing about the account either: keep the line
            // that is on screen and ask again on the next refresh.
            lastBillingRead = nil
        }
    }

    // MARK: - Workstation wait

    private func beginWorkstationWait(_ detail: WorkstationDemandDetail) {
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
        wait.start {
            try await client.podsPage()
        } completion: { outcome in
            guard workstationWait === wait else { return }
            workstationWait = nil
            canKeepWaiting = outcome.canKeepWaiting
            switch outcome {
            case .succeeded(let page):
                apply(page)
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

    private func pollWhileStarting() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(4))
            guard pods.contains(where: \.initializing) else { continue }
            await refreshPods()
        }
    }

    /// A project or environment filter outlives the pods that named it — after a
    /// delete or an org switch, keeping it would show an empty list for something
    /// that no longer exists.
    private func reconcileFilters() {
        switch filter.project {
        case .any:
            break
        case .named(let name):
            if !PodFilter.projects(in: pods).contains(name) { filter.project = .any }
        case .unassigned:
            if !pods.contains(where: { $0.projectName == nil }) { filter.project = .any }
        }
        switch filter.environment {
        case .any:
            break
        case .named(let id, _):
            // Adopting the current option rather than keeping the old one carries a
            // rename through: the selection is the id, the name is only how it reads.
            filter.environment =
                PodFilter.environments(in: pods, named: templates)
                .first { $0.templateID == id } ?? .any
        case .withoutEnvironment:
            if !pods.contains(where: { $0.templateId == nil }) { filter.environment = .any }
        }
    }
}
