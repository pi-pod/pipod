import SwiftUI

/// One scheduled job: when it fires, what it will say to pi, and what happened
/// the last few times it ran.
public struct JobDetailView: View {
    let jobId: String
    let initialJob: Job?

    @Environment(AppRouter.self) private var router
    @Environment(\.apiClient) private var api

    @State private var job: Job?
    @State private var runs: [JobRun] = []
    @State private var unparsedRunCount = 0
    @State private var templateName: String?
    /// Whether the environment lookup has answered. Until it has, the row says
    /// "Loading…"; after it has, a still-missing name means the environment is
    /// gone — which is a sentence, not a UUID.
    @State private var templateChecked = false
    @State private var isWorking = false
    @State private var isConfirmingPause = false
    @State private var status: StatusMessage?
    @State private var loadFailure: String?
    @State private var isConfirmingDelete = false

    public init(jobId: String, initialJob: Job? = nil) {
        self.jobId = jobId
        self.initialJob = initialJob
        _job = State(initialValue: initialJob?.id == jobId ? initialJob : nil)
    }

    public var body: some View {
        content
            .navigationTitle(job?.name ?? "Job")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
            .refreshable { await load() }
            .confirmationDialog(
                job.map { "Delete “\($0.name)”?" } ?? "Delete job?",
                isPresented: $isConfirmingDelete,
                titleVisibility: .visible
            ) {
                Button("Delete job", role: .destructive) { Task { await deleteJob() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(job.map(JobPresentation.deleteConfirmation) ?? "")
            }
            .confirmationDialog(
                job.map { "Pause “\($0.name)”?" } ?? "Pause job?",
                isPresented: $isConfirmingPause,
                titleVisibility: .visible
            ) {
                Button("Pause job") { Task { await command("pause") } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(job.map(JobPresentation.pauseConfirmation) ?? "")
            }
    }

    @ViewBuilder
    private var content: some View {
        if let job {
            detail(job)
        } else if let loadFailure {
            EmptyStateView(
                title: "Couldn’t load this job",
                message: loadFailure,
                systemImage: "wifi.slash",
                actionTitle: "Try again",
                action: { Task { await load() } }
            )
        } else {
            LoadingView(label: "Loading job…")
        }
    }

    private func detail(_ job: Job) -> some View {
        List {
            if let status {
                Section {
                    StatusBanner(status)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowBackground(Color.clear)
                }
            }
            statusSection(job)
            scheduleSection(job)
            promptSection(job)
            configSection(job)
            runsSection
            actionsSection(job)
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Sections

    @ViewBuilder
    private func statusSection(_ job: Job) -> some View {
        Section {
            DetailRow("Status", value: JobPresentation.detailStatus(job), tone: JobPresentation.tone(job))
            if job.isActive, let next = job.nextRunAt {
                DetailRow("Next run", value: JobPresentation.nextRun(next))
            }
            if let last = Format.relative(job.lastRunAt) {
                DetailRow("Last run", value: last)
            }
            if let description = job.description, !description.isEmpty {
                Text(description)
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
            if job.isSharedWithOrg {
                // Sharing is one-way and changes who a pause or a delete
                // affects, so it is stated plainly rather than implied.
                Label(JobPresentation.sharedLabel, systemImage: "person.2")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
                    .accessibilityIdentifier("job.scope")
            }
            if job.createdFromPod != nil {
                Label("Created by an agent inside a pod", systemImage: "shippingbox")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
            if isWorking {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Working…")
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            }
        }
    }

    @ViewBuilder
    private func scheduleSection(_ job: Job) -> some View {
        switch job.trigger {
        case .cron(let expression):
            Section {
                Text(JobSchedule.detailSummary(for: job.trigger))
                // The summary already carries the raw expression when the client
                // could not read it; printing it twice says nothing extra.
                if JobSchedule.humanizeCron(expression) != nil {
                    Text(expression)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(AppColors.secondaryLabel)
                        .textSelection(.enabled)
                }
            } header: {
                Text("Schedule")
            } footer: {
                Text("Cron schedules are evaluated in UTC.")
            }
        case .at(let times):
            Section {
                ForEach(Array(times.enumerated()), id: \.offset) { _, time in
                    scheduledTimeRow(time)
                }
            } header: {
                Text(times.count == 1 ? "Scheduled time" : "Scheduled times")
            } footer: {
                Text("Shown in your local time zone.")
            }
        }
    }

    private func scheduledTimeRow(_ time: String) -> some View {
        let parsed = Format.date(time)
        let isPast = parsed.map { $0 <= Date() } ?? false
        let label = Format.absolute(time) ?? time
        return HStack {
            Text(label)
                .foregroundStyle(isPast ? AppColors.secondaryLabel : AppColors.label)
            Spacer(minLength: 12)
            if isPast {
                Image(systemName: "checkmark")
                    .foregroundStyle(AppColors.secondaryLabel)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isPast ? "\(label), scheduled time already passed" : label)
    }

    private func promptSection(_ job: Job) -> some View {
        Section {
            Text(job.prompt)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .accessibilityLabel("Prompt: \(job.prompt)")
        } header: {
            Text("Prompt")
        } footer: {
            Text("pi receives exactly this text in a fresh pod at every run.")
        }
    }

    private func configSection(_ job: Job) -> some View {
        Section("Runs with") {
            DetailRow("Environment", value: environmentLabel(job))
            DetailRow("Model", value: job.model.isEmpty ? "Default" : job.model)
        }
    }

    private func environmentLabel(_ job: Job) -> String {
        Self.environmentLabel(
            templateId: job.templateId,
            templateName: templateName,
            templateChecked: templateChecked
        )
    }

    /// What the Environment row reads, from the three things that decide it.
    ///
    /// A name that never arrived is a deleted environment, not a raw id — the
    /// same answer `PodDetailView` gives for the same case. Until the lookup has
    /// answered there is nothing to claim either way, so it says so.
    static func environmentLabel(
        templateId: String?, templateName: String?, templateChecked: Bool
    ) -> String {
        guard templateId != nil else { return "Default (empty pod)" }
        if let templateName { return templateName }
        return templateChecked ? "Deleted environment" : "Loading…"
    }

    @ViewBuilder
    private var runsSection: some View {
        if !runs.isEmpty || unparsedRunCount > 0 {
            Section("Recent runs") {
                ForEach(runs) { run in
                    runRow(run)
                }
                UnparsedRowsNotice(count: unparsedRunCount, resourceName: "job run")
            }
        }
    }

    @ViewBuilder
    private func runRow(_ run: JobRun) -> some View {
        let when = Format.relative(run.startedAt) ?? run.startedAt
        let statusLabel = JobPresentation.runStatus(run.status)
        let visual = JobPresentation.runVisual(run.status)
        let failure = (run.error?.isEmpty == false)
            ? FriendlyError.message(serverText: run.error!) : nil
        let summary = "Run \(when), \(statusLabel)" + (failure.map { ", \($0)" } ?? "")

        let body = HStack(spacing: 10) {
            Image(systemName: visual.systemImage)
                .foregroundStyle(visual.tone.color)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(when).foregroundStyle(AppColors.label)
                if let failure {
                    Text(failure)
                        .font(.footnote)
                        .foregroundStyle(StatusTone.danger.color)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Text(statusLabel)
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)
            if run.podId != nil {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(AppColors.tertiaryLabel)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())

        if let podId = run.podId {
            Button { router.openSession(podId: podId) } label: { body }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Open pod for \(summary)")
                .accessibilityIdentifier("Open pod for run \(run.id)")
                .accessibilityAddTraits(.isButton)
        } else {
            body
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(summary)
        }
    }

    @ViewBuilder
    private func actionsSection(_ job: Job) -> some View {
        Section {
            if job.isActive {
                Button("Pause job") { isConfirmingPause = true }
                    .disabled(isWorking)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Pause job \(job.name)")
                    .accessibilityIdentifier("Pause job")
            } else if job.isPaused {
                Button("Resume job") { Task { await command("resume") } }
                    .disabled(isWorking)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Resume job \(job.name)")
                    .accessibilityIdentifier("Resume job")
            }
            Button("Delete job", role: .destructive) { isConfirmingDelete = true }
                .disabled(isWorking)
                .frame(minHeight: 44)
                .accessibilityLabel("Delete job \(job.name)")
                .accessibilityIdentifier("Delete job")
        }
    }

    // MARK: - Data

    private func load() async {
        var failure: Error?
        do {
            job = try await api.job(id: jobId)
            loadFailure = nil
        } catch {
            failure = error
            if job == nil {
                loadFailure = FriendlyError.message(
                    error, serverHost: Config.serverURL.absoluteString
                )
            }
        }
        do {
            let decoded = try await api.jobRuns(id: jobId)
            runs = decoded.items
            unparsedRunCount = decoded.unparsedRows.count
        } catch {
            failure = failure ?? error
        }
        await loadTemplateName()

        // A pull-to-refresh that silently keeps stale data reads as fresh.
        if let failure {
            status = .failure(
                """
                Could not refresh this job: \
                \(FriendlyError.message(failure, serverHost: Config.serverURL.absoluteString))
                """
            )
        } else if status?.isError == true {
            status = nil
        }
    }

    private func loadTemplateName() async {
        guard let templateId = job?.templateId, templateName == nil else { return }
        do {
            templateName = try await api.template(id: templateId).name
        } catch {
            // The environment name is supplementary: a failure here must not
            // fail the whole refresh, and it must not leak the raw id either.
            // Leaving the name nil lets the row say the environment is gone.
        }
        templateChecked = true
    }

    private func command(_ action: String) async {
        isWorking = true
        status = nil
        defer { isWorking = false }
        do {
            let updated = try await api.jobCommand(id: jobId, command: action)
            job = updated
            switch updated.status {
            case "active":
                let countdown = JobSchedule.countdown(to: updated.nextRunAt)
                status = .success(
                    "Job is active." + (countdown.map { " Next run \($0)." } ?? "")
                )
            case "paused":
                status = .success("Job paused. Its schedule won’t fire until you resume it.")
            default:
                status = .success("Job is \(updated.status).")
            }
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }

    private func deleteJob() async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await api.deleteJob(id: jobId)
            if !router.jobsPath.isEmpty { router.jobsPath.removeLast() }
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }
}
