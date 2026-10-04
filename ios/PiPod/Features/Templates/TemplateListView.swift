import SwiftUI

/// The environments pods can be launched from.
///
/// An environment is a template config bundle — a setup script, a bake script
/// and a network policy. Every one of them is launchable: the server dropped the
/// draft/approval state, so an environment an agent wrote inside a pod arrives
/// here ready to use, which is why the list is one flat group.
///
/// The list only reads: environments are created, changed and deleted in the
/// web dashboard, which Settings links to.
public struct TemplateListView: View {
    @Environment(AppRouter.self) private var router
    @Environment(\.apiClient) private var api

    @State private var templates: [PodTemplate] = []
    @State private var unparsedCount = 0
    @State private var hasLoaded = false
    @State private var loadError: String?

    public init() {}

    public var body: some View {
        content
            .navigationTitle("Environments")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh environments")
                    .accessibilityIdentifier("Refresh environments")
                }
            }
            .task { await load() }
            .refreshable { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if !hasLoaded {
            LoadingView(label: "Loading environments…")
        } else if templates.isEmpty, unparsedCount == 0 {
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
                    UnparsedRowsNotice(count: unparsedCount, resourceName: "environment")
                }
            }
            if !templates.isEmpty {
                Section {
                    ForEach(templates) { row($0) }
                } footer: {
                    Text(
                        """
                        Each of these runs its setup script, with your secrets, in every pod \
                        launched from it. Open one to read the script before you use it. \
                        Environments are created and changed in the web dashboard.
                        """
                    )
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var emptyState: some View {
        Group {
            if let loadError {
                EmptyStateView(
                    title: "Couldn’t load environments",
                    message: loadError,
                    systemImage: "wifi.slash",
                    actionTitle: "Try again",
                    action: { Task { await load() } }
                )
            } else {
                EmptyStateView(
                    title: "No environments yet",
                    message: """
                        An environment is a setup script, a bake script and a network policy \
                        your pods start from. Write one in the web dashboard, which Settings \
                        opens, or ask pi inside a pod to build one — it appears here ready to \
                        launch from.
                        """,
                    systemImage: "square.stack.3d.up"
                )
            }
        }
    }

    private func row(_ template: PodTemplate) -> some View {
        Button {
            router.settingsPath.append(
                .environmentDetail(templateId: template.id, template: template)
            )
        } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(template.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(AppColors.label)
                    if let description = template.description, !description.isEmpty {
                        Text(description)
                            .font(.subheadline)
                            .foregroundStyle(AppColors.secondaryLabel)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(AppColors.tertiaryLabel)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Open environment \(template.name)")
        .accessibilityIdentifier("Open environment \(template.name)")
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - Data

    private func load() async {
        do {
            let decoded = try await api.templates()
            templates = decoded.items
            unparsedCount = decoded.unparsedRows.count
            loadError = nil
        } catch {
            loadError = FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
        }
        hasLoaded = true
    }
}
