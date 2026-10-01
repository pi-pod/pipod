import SwiftUI

/// Every scheduled job in the organization, grouped by lifecycle.
///
/// A job is a prompt on a schedule: at each tick the server launches a pod and
/// hands the prompt to pi. Nothing here waits for approval — the server dropped
/// the draft status — so the groups are simply active, paused and completed.
public struct JobsListView: View {
    @Environment(AppRouter.self) private var router
    @Environment(\.apiClient) private var api

    @State private var jobs: [Job] = []
    @State private var unparsedCount = 0
    @State private var hasLoaded = false
    @State private var loadError: String?
    @State private var deletingIDs: Set<String> = []
    @State private var pendingDelete: Job?

    public init() {}

    public var body: some View {
        content
            .navigationTitle("Jobs")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh jobs")
                    .accessibilityIdentifier("Refresh jobs")
                }
            }
            .task { await load() }
            .refreshable { await load() }
            // A job deleted or activated on the detail screen changes this list.
            // Coming back is the moment to find out.
            .onChange(of: router.jobsPath) { _, path in
                guard path.isEmpty, hasLoaded else { return }
                Task { await load() }
            }
            .confirmationDialog(
                pendingDelete.map { "Delete \($0.name)?" } ?? "Delete job?",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { job in
                Button("Delete job", role: .destructive) { Task { await delete(job) } }
                Button("Cancel", role: .cancel) {}
            } message: { job in
                Text(JobPresentation.deleteConfirmation(job))
            }
    }

    @ViewBuilder
    private var content: some View {
        if !hasLoaded {
            LoadingView(label: "Loading jobs…")
        } else if jobs.isEmpty, unparsedCount == 0 {
            emptyState
        } else {
            list
        }
    }

    private var list: some View {
        List {
            if let loadError {
                Section {
                    RefreshErrorTile(message: loadError) { Task { await load() } }
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowBackground(Color.clear)
                }
            }
            if unparsedCount > 0 {
                Section {
                    UnparsedRowsNotice(count: unparsedCount, resourceName: "schedule")
                }
            }
            ForEach(JobPresentation.sections(for: jobs)) { section in
                Section {
                    ForEach(section.jobs) { job in
                        row(job)
                    }
                } header: {
                    Text(section.title)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var emptyState: some View {
        Group {
            if let loadError {
                EmptyStateView(
                    title: "Couldn’t load jobs",
                    message: loadError,
                    systemImage: "wifi.slash",
                    actionTitle: "Try again",
                    action: { Task { await load() } }
                )
            } else {
                EmptyStateView(
                    title: "No jobs yet",
                    message: """
                        A job is a prompt on a schedule: at each tick the server launches a \
                        pod and hands the prompt to pi. Ask pi inside a pod to schedule one \
                        — it appears here and starts running.
                        """,
                    systemImage: "calendar.badge.clock"
                )
            }
        }
    }

    @ViewBuilder
    private func row(_ job: Job) -> some View {
        let isDeleting = deletingIDs.contains(job.id)
        let schedule = JobSchedule.summary(for: job.trigger)
        let status = JobPresentation.rowStatus(job)

        HStack(spacing: 8) {
            Button {
                router.jobsPath.append(.detail(jobId: job.id, job: job))
            } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(job.name)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(AppColors.label)
                        Text(schedule)
                            .font(.subheadline)
                            .foregroundStyle(AppColors.secondaryLabel)
                        // Whose job this is decides who a pause or a delete
                        // affects, so it belongs on the row, not two taps away.
                        if job.isSharedWithOrg {
                            Label(JobPresentation.sharedLabel, systemImage: "person.2")
                                .font(.caption)
                                .foregroundStyle(AppColors.secondaryLabel)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    StatusChip(
                        status,
                        tone: JobPresentation.tone(job),
                        systemImage: JobPresentation.systemImage(job)
                    )
                    .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isDeleting)
            // The label and the tap belong to one node: a screen reader should meet
            // an actionable row, not static text beside an unlabelled button.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "Open job \(job.name), \(schedule), \(status)"
                    + (job.isSharedWithOrg ? ", \(JobPresentation.sharedLabel)" : "")
            )
            .accessibilityIdentifier("Open job \(job.name)")
            .accessibilityAddTraits(.isButton)

            if isDeleting {
                ProgressView()
                    .frame(width: 44, height: 44)
                    .accessibilityLabel("Removing job \(job.name)")
            } else {
                Menu {
                    Button("Delete job", systemImage: "trash", role: .destructive) {
                        pendingDelete = job
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("More actions for job \(job.name)")
                .accessibilityIdentifier("More actions for job \(job.name)")
            }
        }
        .opacity(isDeleting ? 0.5 : 1)
        .swipeActions(edge: .trailing) {
            Button("Delete", systemImage: "trash", role: .destructive) {
                pendingDelete = job
            }
            .accessibilityLabel("Delete job \(job.name)")
        }
    }

    // MARK: - Data

    private func load() async {
        do {
            let decoded = try await api.jobs()
            jobs = decoded.items
            unparsedCount = decoded.unparsedRows.count
            loadError = nil
        } catch {
            // Keep whatever is already on screen: an empty list would claim the
            // jobs went away, which is a different and much worse story.
            loadError = FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
        }
        hasLoaded = true
    }

    private func delete(_ job: Job) async {
        deletingIDs.insert(job.id)
        defer { deletingIDs.remove(job.id) }
        do {
            try await api.deleteJob(id: job.id)
            jobs.removeAll { $0.id == job.id }
        } catch {
            loadError = """
                Could not delete \(job.name): \
                \(FriendlyError.message(error, serverHost: Config.serverURL.absoluteString))
                """
            await load()
        }
    }
}
