import SwiftUI

/// One scope's secrets: the names, and a form to add another.
///
/// Values are write-only. The server never returns one, this screen never asks
/// for one back, and nothing here copies one to the pasteboard — a secret you
/// can read on a phone is a secret in a screenshot.
public struct SecretsView: View {
    let scope: String
    let scopeId: String
    let title: String

    @Environment(\.apiClient) private var api

    @State private var secrets: [SecretMeta] = []
    @State private var unparsedCount = 0
    @State private var hasLoaded = false
    @State private var loadError: String?
    @State private var name = ""
    @State private var value = ""
    @State private var isSaving = false
    @State private var status: StatusMessage?
    @State private var pendingDelete: SecretMeta?

    public init(scope: String, scopeId: String, title: String) {
        self.scope = scope
        self.scopeId = scopeId
        self.title = title
    }

    public var body: some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
            .refreshable { await load() }
            .confirmationDialog(
                pendingDelete.map { "Delete \($0.name)?" } ?? "Delete secret?",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { secret in
                Button("Delete secret permanently", role: .destructive) {
                    Task { await delete(secret) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("The value is write-only and cannot be recovered after deletion.")
            }
    }

    @ViewBuilder
    private var content: some View {
        if !hasLoaded {
            LoadingView(label: "Loading secrets…")
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
                if let status {
                    Section {
                        StatusBanner(status)
                            .listRowInsets(
                                EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16)
                            )
                            .listRowBackground(Color.clear)
                    }
                }
                storedSection
                addSection
            }
            .listStyle(.insetGrouped)
        }
    }

    @ViewBuilder
    private var storedSection: some View {
        if secrets.isEmpty, unparsedCount == 0 {
            Section {
                EmptyStateView(
                    title: "No secrets yet",
                    message: """
                        Secrets are injected into pods as environment variables. Add one below.
                        """,
                    systemImage: "key"
                )
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .listRowBackground(Color.clear)
            }
        } else {
            Section("Stored") {
                UnparsedRowsNotice(count: unparsedCount, resourceName: "secret")
                ForEach(secrets) { secret in
                    row(secret)
                }
            }
        }
    }

    private func row(_ secret: SecretMeta) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(secret.name)
                    .font(.system(.body, design: .monospaced))
                if let updated = Format.relative(secret.updatedAt) {
                    Text("Updated \(updated)")
                        .font(.footnote)
                        .foregroundStyle(AppColors.secondaryLabel)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Menu {
                Button("Delete secret", systemImage: "trash", role: .destructive) {
                    pendingDelete = secret
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("More actions for secret \(secret.name)")
            .accessibilityIdentifier("More actions for secret \(secret.name)")
        }
        .swipeActions(edge: .trailing) {
            Button("Delete", systemImage: "trash", role: .destructive) {
                pendingDelete = secret
            }
            .accessibilityLabel("Delete secret \(secret.name)")
        }
    }

    private var addSection: some View {
        Section {
            SecretEntryFields(
                name: $name,
                value: $value,
                accessibilityPrefix: "Secret",
                isSaving: isSaving,
                save: { Task { await save() } }
            )
        } header: {
            Text("Add a secret")
        } footer: {
            Text("To replace a value, save again with the same name.")
        }
    }

    // MARK: - Data

    private func load() async {
        do {
            let decoded = try await api.secrets(scope: scope, scopeId: scopeId)
            secrets = decoded.items
            unparsedCount = decoded.unparsedRows.count
            loadError = nil
        } catch {
            loadError = FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
        }
        hasLoaded = true
    }

    private func save() async {
        isSaving = true
        status = nil
        defer { isSaving = false }
        do {
            try await api.putSecret(
                scope: scope,
                scopeId: scopeId,
                name: SecretName.normalized(name),
                value: value.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            name = ""
            value = ""
            status = .success("Secret saved. Its value can never be read back.")
            await load()
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }

    private func delete(_ secret: SecretMeta) async {
        do {
            try await api.deleteSecret(scope: scope, scopeId: scopeId, name: secret.name)
            secrets.removeAll { $0.id == secret.id }
            status = .success("\(secret.name) deleted.")
        } catch {
            status = .failure(
                """
                Could not delete \(secret.name): \
                \(FriendlyError.message(error, serverHost: Config.serverURL.absoluteString))
                """
            )
        }
    }
}
