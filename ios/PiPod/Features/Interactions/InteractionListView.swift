import SwiftUI

/// The approvals inbox: everything pi is currently blocked on, across pods.
public struct InteractionListView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.apiClient) private var api
    @Environment(\.scenePhase) private var scenePhase

    @State private var interactions: [PendingInteraction] = []
    @State private var unparsedCount = 0
    @State private var isLoading = true
    @State private var refreshError: String?
    @State private var observers: [NotificationToken] = []

    public init() {}

    public var body: some View {
        List {
            if let refreshError, !interactions.isEmpty {
                Section {
                    RefreshErrorTile(message: refreshError) { Task { await refresh() } }
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                }
            }
            if unparsedCount > 0 {
                Section { UnparsedRowsNotice(count: unparsedCount, resourceName: "approval") }
            }
            ForEach(interactions) { interaction in
                Section {
                    // A value route, not a bound selection: this stack is driven
                    // by `podsPath`, and a screen the path does not know about
                    // cannot be popped when the approval is opened as a session.
                    NavigationLink(value: PodRoute.approvalDetail(interaction: interaction)) {
                        InteractionRow(interaction: interaction)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(interactions.isEmpty ? .hidden : .visible)
        .navigationTitle("Approvals")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh approvals")
                .accessibilityIdentifier("approvals.refresh")
            }
        }
        .refreshable { await refresh() }
        .overlay { overlayState }
        .task {
            observe()
            await refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            // An approval answered on another device, or from a live session on
            // this one, otherwise leaves a stale row here until the next visit.
            if phase == .active { Task { await refresh() } }
        }
    }

    @ViewBuilder
    private var overlayState: some View {
        if isLoading, interactions.isEmpty {
            LoadingView(label: "Loading approvals…")
        } else if interactions.isEmpty, unparsedCount == 0 {
            if let refreshError {
                EmptyStateView(
                    title: "Couldn’t load approvals",
                    message: refreshError,
                    systemImage: "wifi.exclamationmark",
                    actionTitle: "Try again",
                    action: { Task { await refresh() } }
                )
            } else {
                EmptyStateView(
                    title: "No pending approvals",
                    message: "When pi needs an answer, it shows up here.",
                    systemImage: "checkmark.seal"
                )
            }
        }
    }

    // MARK: - Data

    private func observe() {
        guard observers.isEmpty else { return }
        observers = [
            SessionNotifications.interactionResolved.addObserver { event in
                remove(event.id)
            },
            SessionNotifications.interactionPending.addObserver { _ in
                Task { await refresh() }
            },
        ]
    }

    private func refresh() async {
        isLoading = true
        do {
            let page = try await api.interactions(pendingOnly: true)
            interactions = page.items
            unparsedCount = page.unparsedRows.count
            refreshError = nil
            session.setPendingApprovalsCount(page.items.count)
        } catch {
            // Rows already on screen stay: a failed refresh is not an empty inbox.
            refreshError = FriendlyError.message(
                error, serverHost: Config.serverURL.absoluteString
            )
        }
        isLoading = false
    }

    private func remove(_ id: String) {
        guard interactions.contains(where: { $0.id == id }) else { return }
        interactions.removeAll { $0.id == id }
        session.setPendingApprovalsCount(interactions.count)
    }
}

/// One inbox row: which pod is blocked, on what, and for how long.
struct InteractionRow: View {
    let interaction: PendingInteraction

    var body: some View {
        let presentation = InteractionPresentation(interaction)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(interaction.podName)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 12)
                Text(presentation.title)
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
                    .lineLimit(1)
            }
            Text(presentation.message)
                .font(.subheadline)
                .foregroundStyle(AppColors.label)
                .lineLimit(3)
            HStack(spacing: 4) {
                Image(systemName: "magnifyingglass").imageScale(.small)
                Text("Review request").font(.footnote.weight(.semibold))
                Spacer()
                if let waiting = Format.duration(since: interaction.createdAt) {
                    Text("waiting \(waiting)")
                        .font(.footnote)
                        .foregroundStyle(AppColors.secondaryLabel)
                }
            }
            .foregroundStyle(AppColors.accent)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Self.rowLabel(interaction, presentation))
        .accessibilityAddTraits(.isButton)
    }

    /// Trailing punctuation is stripped before joining so a message ending in
    /// "." does not read back as "..".
    static func rowLabel(
        _ interaction: PendingInteraction, _ presentation: InteractionPresentation
    ) -> String {
        func sentence(_ value: String) -> String {
            var trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            while let last = trimmed.last, ".!?:;".contains(last) || last.isWhitespace {
                trimmed.removeLast()
            }
            return trimmed
        }
        return """
            Open approval for \(sentence(interaction.podName)). \
            \(sentence(presentation.title)). \(sentence(presentation.message)). Review request.
            """
    }
}
