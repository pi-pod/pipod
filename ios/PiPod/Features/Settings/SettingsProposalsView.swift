import SwiftUI

/// One labelled before/after pair from a settings proposal.
struct ProposalSettingRow: Equatable, Identifiable {
    let label: String
    let current: String
    let proposed: String

    var id: String { label }
}

/// Reads a proposal against the layer it would replace.
///
/// A settings bundle is a free-form object, so a raw JSON dump is the only
/// complete view of it — but nobody approves a change they can only read as
/// JSON. These are the paths worth a sentence; everything else stays behind
/// "Show raw", which is honest about being the whole truth.
enum ProposalDiff {
    private static let labels: [(path: String, label: String)] = [
        ("provider", "Sandbox provider"),
        ("image", "Image"),
        ("idleTimeoutMinutes", "Idle timeout (minutes)"),
        ("archiveAfterMinutes", "Archive after (minutes)"),
        ("autoStopOnExit", "Stop when pi exits"),
        ("reuse", "Reuse stopped pod"),
        ("workdir", "Working directory"),
        ("resources.cpu", "CPU"),
        ("resources.memoryGB", "Memory (GB)"),
        ("resources.diskGB", "Disk (GB)"),
        ("egress.mode", "Network access"),
        ("egress.builtins", "Built-in service access"),
        ("egress.allow", "Allowed hosts"),
        ("pi.model", "Default model"),
        ("pi.thinking", "Thinking level"),
        ("pi.sessionNaming", "Session naming"),
    ]

    static func rows(current: JSONValue, proposed: JSONValue) -> [ProposalSettingRow] {
        labels.compactMap { entry in
            let currentValue = value(at: entry.path, in: current)
            let proposedValue = value(at: entry.path, in: proposed)
            // A path neither side mentions is not part of this change.
            guard currentValue != nil || proposedValue != nil else { return nil }
            return ProposalSettingRow(
                label: entry.label,
                current: display(currentValue),
                proposed: display(proposedValue)
            )
        }
    }

    static func value(at path: String, in root: JSONValue) -> JSONValue? {
        var cursor: JSONValue? = root
        for part in path.split(separator: ".") {
            guard let next = cursor?[String(part)], !next.isNull else { return nil }
            cursor = next
        }
        return cursor
    }

    static func display(_ value: JSONValue?) -> String {
        guard let value, !value.isNull else { return "Not set" }
        switch value {
        case .array(let items):
            if items.isEmpty { return "None" }
            return items.compactMap(\.displayText).joined(separator: ", ")
        case .bool(let flag):
            return flag ? "On" : "Off"
        case .object:
            return value.compactPrinted()
        default:
            return value.displayText ?? "Not set"
        }
    }
}

/// Applying or rejecting a proposal writes the organization's defaults, which is
/// the same administrative act `ConfigBundleEditorView` asks `org:manage` for.
/// Offering the buttons to someone the server will refuse is a decision they
/// cannot make.
func canResolveProposal(scope: String, canManageOrg: Bool) -> Bool {
    scope == "org_defaults" && canManageOrg
}

/// The settings changes agents have proposed from inside pods.
public struct SettingsProposalsView: View {
    @Environment(AppRouter.self) private var router
    @Environment(\.apiClient) private var api

    @State private var proposals: [SettingsProposal] = []
    @State private var unparsedCount = 0
    @State private var hasLoaded = false
    @State private var loadError: String?

    public init() {}

    public var body: some View {
        content
            .navigationTitle("Proposals")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
            .refreshable { await load() }
            .onChange(of: router.settingsPath) { _, path in
                // A proposal applied or rejected one level deeper changes this
                // list; returning is when to find out.
                guard hasLoaded, path.last == .proposals else { return }
                Task { await load() }
            }
    }

    @ViewBuilder
    private var content: some View {
        if !hasLoaded {
            LoadingView(label: "Loading proposals…")
        } else if proposals.isEmpty, unparsedCount == 0 {
            if let loadError {
                EmptyStateView(
                    title: "Couldn’t load proposals",
                    message: loadError,
                    systemImage: "wifi.slash",
                    actionTitle: "Try again",
                    action: { Task { await load() } }
                )
            } else {
                EmptyStateView(
                    title: "Nothing waiting",
                    message: """
                        When an agent proposes a change to your organization defaults from \
                        inside a pod, it appears here for your approval.
                        """,
                    systemImage: "checkmark.seal"
                )
            }
        } else {
            List {
                if let loadError {
                    Section {
                        RefreshErrorTile(message: loadError) { Task { await load() } }
                            .listRowInsets(
                                EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16)
                            )
                            .listRowBackground(Color.clear)
                    }
                }
                Section {
                    UnparsedRowsNotice(count: unparsedCount, resourceName: "settings proposal")
                    ForEach(proposals) { proposal in
                        // A value route: a closure link pushes a screen this
                        // stack's path never learns about.
                        NavigationLink(
                            value: SettingsRoute.proposalDetail(proposal: proposal)
                        ) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Change to \(proposal.scopeLabel)")
                                if let note = proposal.note, !note.isEmpty {
                                    Text(note)
                                        .font(.subheadline)
                                        .foregroundStyle(AppColors.secondaryLabel)
                                        .lineLimit(2)
                                }
                            }
                        }
                        .accessibilityLabel(
                            "Proposed change to \(proposal.scopeLabel), needs approval"
                        )
                        .accessibilityIdentifier("Open proposal \(proposal.id)")
                    }
                } footer: {
                    Text(
                        """
                        An agent drafted these from inside a pod. Nothing changes until you \
                        apply them here.
                        """
                    )
                }
            }
            .listStyle(.insetGrouped)
        }
    }

    private func load() async {
        do {
            let decoded = try await api.settingsProposals()
            proposals = decoded.items
            unparsedCount = decoded.unparsedRows.count
            loadError = nil
        } catch {
            loadError = FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
        }
        hasLoaded = true
    }
}

// MARK: - Detail

struct ProposalDetailView: View {
    let proposal: SettingsProposal

    @Environment(AppRouter.self) private var router
    @Environment(SessionStore.self) private var session
    @Environment(\.apiClient) private var api

    @State private var current: SettingsLayer?
    @State private var isLoadingCurrent = true
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var appliedSecretNames: [String]?
    @State private var showsRaw = false
    @State private var isConfirmingApply = false
    @State private var isConfirmingReject = false

    /// Only organization defaults have a layer this build can read and diff.
    private var isSupportedScope: Bool { proposal.scope == "org_defaults" }

    var body: some View {
        List {
            summarySection
            if !isSupportedScope {
                Section {
                    StatusBanner(
                        .failure(
                            """
                            This proposal changes something this version of the app doesn’t \
                            understand. Review it from the web console.
                            """
                        )
                    )
                }
            }
            if isLoadingCurrent, isSupportedScope {
                Section {
                    ProgressView().accessibilityLabel("Loading current settings")
                }
            }
            initScriptSection
            bakeScriptSection
            configSection
            secretNamesSection
            actionsSection
            if let errorMessage {
                Section {
                    StatusBanner(.failure(errorMessage))
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Proposal")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadCurrent() }
        .confirmationDialog(
            "Apply this change to \(proposal.scopeLabel)?",
            isPresented: $isConfirmingApply,
            titleVisibility: .visible
        ) {
            Button("Apply changes") { Task { await apply() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                proposal.initScript != nil
                    ? "The proposed init script will run in every pod launched at this level."
                    : "The proposed settings take effect for every pod launched at this level."
            )
        }
        .confirmationDialog(
            "Reject this proposal?",
            isPresented: $isConfirmingReject,
            titleVisibility: .visible
        ) {
            Button("Reject proposal", role: .destructive) { Task { await reject() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                """
                The proposed change to \(proposal.scopeLabel) will be discarded. This cannot \
                be undone.
                """
            )
        }
    }

    private var summarySection: some View {
        Section {
            DetailRow("Changes", value: proposal.scopeLabel)
            Label("Drafted by an agent inside a pod", systemImage: "shippingbox")
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)
            if let note = proposal.note, !note.isEmpty {
                Text(note)
            }
        }
    }

    @ViewBuilder
    private var initScriptSection: some View {
        if let proposed = proposal.initScript {
            Section {
                comparison(
                    current: scriptLabel(current?.initScript), proposed: scriptLabel(proposed)
                )
            } header: {
                Text("Default init script: current → proposed")
            } footer: {
                Text(
                    """
                    Runs at the start of every pod launch at this level, before any \
                    environment script.
                    """
                )
            }
        }
    }

    @ViewBuilder
    private var bakeScriptSection: some View {
        if let proposed = proposal.bakeScript {
            Section {
                comparison(
                    current: scriptLabel(current?.bakeScript), proposed: scriptLabel(proposed)
                )
            } header: {
                Text("Default bake script: current → proposed")
            } footer: {
                Text("Runs when an environment image is built.")
            }
        }
    }

    @ViewBuilder
    private var configSection: some View {
        if let proposed = proposal.config {
            let currentConfig = current?.config ?? .object([:])
            let rows = ProposalDiff.rows(current: currentConfig, proposed: proposed)
            Section {
                if current == nil {
                    Text("Current settings are unavailable.")
                        .foregroundStyle(AppColors.secondaryLabel)
                } else if rows.isEmpty {
                    Text("No labelled settings in this proposal. Show raw to review it.")
                        .foregroundStyle(AppColors.secondaryLabel)
                } else {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.label).font(.callout.weight(.medium))
                            comparison(current: row.current, proposed: row.proposed)
                        }
                        .padding(.vertical, 2)
                    }
                }
                DisclosureGroup("Show raw", isExpanded: $showsRaw) {
                    comparison(
                        current: currentConfig.prettyPrinted(),
                        proposed: proposed.prettyPrinted(),
                        monospaced: true
                    )
                }
                .accessibilityLabel("Show raw settings")
            } header: {
                Text("Settings: current → proposed")
            } footer: {
                Text("The proposed settings replace the current settings at this level.")
            }
        }
    }

    @ViewBuilder
    private var secretNamesSection: some View {
        if !proposal.secretNames.isEmpty {
            Section {
                Text(proposal.secretNames.joined(separator: ", "))
                    .font(.system(.footnote, design: .monospaced))
            } header: {
                Text("Secrets it asks you to set")
            } footer: {
                Text(
                    """
                    Only the names travel with the proposal. You enter the values yourself \
                    after applying — the agent never sees them.
                    """
                )
            }
        }
    }

    @ViewBuilder
    private var actionsSection: some View {
        if let names = appliedSecretNames {
            Section {
                StatusBanner(.success("Applied."))
                ForEach(names, id: \.self) { name in
                    Button {
                        openSecrets()
                    } label: {
                        Label("Now set: \(name)", systemImage: "key")
                    }
                    .frame(minHeight: 44)
                    .accessibilityLabel("Now set secret \(name)")
                    .accessibilityIdentifier("Now set secret \(name)")
                }
                Button("Done") { pop() }
                    .frame(minHeight: 44)
                    .accessibilityLabel("Done reviewing proposal")
            }
        } else if canResolve {
            Section {
                Button {
                    isConfirmingApply = true
                } label: {
                    Group {
                        if isWorking {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Apply changes")
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .brandProminent()
                .disabled(isWorking || isLoadingCurrent)
                .accessibilityLabel("Apply proposal to \(proposal.scopeLabel)")
                .accessibilityIdentifier("Apply proposal")

                Button("Reject", role: .destructive) { isConfirmingReject = true }
                    .frame(minHeight: 44)
                    .disabled(isWorking)
                    .accessibilityLabel("Reject proposal for \(proposal.scopeLabel)")
                    .accessibilityIdentifier("Reject proposal")
            }
        } else if isSupportedScope {
            Section {
                Text("Only organization managers can apply or reject this.")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
        }
    }

    private var canResolve: Bool {
        canResolveProposal(scope: proposal.scope, canManageOrg: session.can("org:manage"))
    }

    // MARK: - Pieces

    private func comparison(
        current: String, proposed: String, monospaced: Bool = false
    ) -> some View {
        // At phone widths two columns turn JSON into alphabet soup: current
        // stacks over proposed instead.
        VStack(alignment: .leading, spacing: 6) {
            Text("Current").font(.caption).foregroundStyle(AppColors.secondaryLabel)
            Text(current)
                .font(monospaced ? .system(.footnote, design: .monospaced) : .footnote)
                .textSelection(.enabled)
            Image(systemName: "arrow.down")
                .font(.caption)
                .foregroundStyle(AppColors.tertiaryLabel)
                .accessibilityLabel("changes to")
            Text("Proposed").font(.caption).foregroundStyle(AppColors.secondaryLabel)
            Text(proposed)
                .font(monospaced ? .system(.footnote, design: .monospaced) : .footnote)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func scriptLabel(_ script: String?) -> String {
        guard let script, !script.isEmpty else { return "(none)" }
        return script
    }

    // MARK: - Data

    private func loadCurrent() async {
        defer { isLoadingCurrent = false }
        guard isSupportedScope else { return }
        do {
            current = try await api.orgSettings(orgId: proposal.scopeId)
        } catch {
            errorMessage = """
                Could not load current settings: \
                \(FriendlyError.message(error, serverHost: Config.serverURL.absoluteString))
                """
        }
    }

    private func apply() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            appliedSecretNames = try await api.applyProposal(id: proposal.id)
        } catch {
            errorMessage = FriendlyError.message(
                error, serverHost: Config.serverURL.absoluteString
            )
        }
    }

    private func reject() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await api.rejectProposal(id: proposal.id)
            pop()
        } catch {
            errorMessage = FriendlyError.message(
                error, serverHost: Config.serverURL.absoluteString
            )
        }
    }

    private func openSecrets() {
        guard let userId = session.user?.id else { return }
        router.settingsPath.append(
            .secrets(scope: "user", scopeId: userId, title: "Your secrets")
        )
    }

    private func pop() {
        if !router.settingsPath.isEmpty { router.settingsPath.removeLast() }
    }
}
