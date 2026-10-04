import SwiftUI

/// The egress policy carried inside a template's config bundle, as the detail
/// screen shows it.
struct EgressPolicy: Equatable {
    var isRestricted: Bool
    var allowsBuiltins: Bool
    var allowedHosts: [String]

    static func read(from config: JSONValue) -> EgressPolicy {
        let egress = config["egress"]
        return EgressPolicy(
            isRestricted: egress?["mode"]?.stringValue == "allowlist",
            // An absent flag means built-ins are reachable; only an explicit
            // false blocks them.
            allowsBuiltins: egress?["builtins"]?.boolValue ?? true,
            allowedHosts: (egress?["allow"]?.arrayValue ?? []).compactMap(\.stringValue)
        )
    }
}

/// One environment: what it sets up, what it can reach, and the write-only
/// secrets pods launched from it receive.
///
/// Everything but the secrets is read-only here: environments are created and
/// changed in the web dashboard, which Settings links to.
public struct TemplateDetailView: View {
    let templateId: String

    @Environment(\.apiClient) private var api

    @State private var template: PodTemplate?
    @State private var secrets: [SecretMeta] = []
    @State private var unparsedSecretCount = 0
    @State private var secretName = ""
    @State private var secretValue = ""
    @State private var isSavingSecret = false
    @State private var status: StatusMessage?
    @State private var loadFailure: String?
    @State private var pendingSecretDelete: SecretMeta?

    public init(templateId: String, initialTemplate: PodTemplate? = nil) {
        self.templateId = templateId
        _template = State(initialValue: initialTemplate?.id == templateId ? initialTemplate : nil)
    }

    public var body: some View {
        Group {
            if let template {
                detail(template)
            } else if let loadFailure {
                EmptyStateView(
                    title: "Couldn’t load this environment",
                    message: loadFailure,
                    systemImage: "wifi.slash",
                    actionTitle: "Try again",
                    action: { Task { await loadAll() } }
                )
            } else {
                LoadingView(label: "Loading environment…")
            }
        }
        .navigationTitle(template?.name ?? "Environment")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadAll() }
        .refreshable { await loadAll() }
        .confirmationDialog(
            pendingSecretDelete.map { "Delete \($0.name)?" } ?? "Delete secret?",
            isPresented: Binding(
                get: { pendingSecretDelete != nil },
                set: { if !$0 { pendingSecretDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingSecretDelete
        ) { secret in
            Button("Delete secret", role: .destructive) { Task { await deleteSecret(secret) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Pods launched from this environment will no longer receive it.")
        }
    }

    private func detail(_ template: PodTemplate) -> some View {
        List {
            if let status {
                Section {
                    StatusBanner(status)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowBackground(Color.clear)
                }
            }
            summarySection(template)
            agentInstructionsSection(template)
            scriptSection(
                "Setup script", script: template.initScript,
                empty: "No setup script — pods from this environment start empty.",
                footer: "This runs with your secrets in every pod launched from this environment."
            )
            scriptSection(
                "Bake script", script: template.bakeScript,
                empty: "No bake script.",
                footer: "Runs when the environment image is built, not each time a pod launches."
            )
            networkSection(template)
            secretsSection
        }
        .listStyle(.insetGrouped)
    }

    /// No status row: every environment is launchable, so a "Status: Active"
    /// that can never say anything else is furniture, not information.
    @ViewBuilder
    private func summarySection(_ template: PodTemplate) -> some View {
        Section {
            if let description = template.description, !description.isEmpty {
                DetailRow("Description", value: description)
            }
            if template.createdFromPod != nil {
                Label("Created by an agent inside a pod", systemImage: "shippingbox")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
        } footer: {
            Text("To change this environment, open the web dashboard from Settings.")
        }
    }

    /// Absent on a server that predates the field: nothing to show.
    @ViewBuilder
    private func agentInstructionsSection(_ template: PodTemplate) -> some View {
        if let instructions = template.agentInstructions {
            Section {
                if instructions.isEmpty {
                    Text("No agent instructions.").foregroundStyle(AppColors.secondaryLabel)
                } else {
                    Text(instructions)
                        .font(.footnote)
                        .textSelection(.enabled)
                        .accessibilityLabel("Agent instructions: \(instructions)")
                }
            } header: {
                Text("Agent instructions")
            } footer: {
                Text(
                    """
                    Added to the agent's system prompt in every pod launched from this \
                    environment, with the hosts and secrets the pod actually has. Nothing \
                    enforces them: the secrets and network policy decide what a pod can reach.
                    """
                )
            }
        }
    }

    private func scriptSection(
        _ title: String, script: String?, empty: String, footer: String
    ) -> some View {
        Section {
            if let script, !script.isEmpty {
                Text(script)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .accessibilityLabel("\(title): \(script)")
            } else {
                Text(empty).foregroundStyle(AppColors.secondaryLabel)
            }
        } header: {
            Text(title)
        } footer: {
            Text(footer)
        }
    }

    private func networkSection(_ template: PodTemplate) -> some View {
        let policy = EgressPolicy.read(from: template.config)
        return Section {
            DetailRow("Network access", value: policy.isRestricted ? "Restricted" : "Open")
            DetailRow("Built-in services", value: policy.allowsBuiltins ? "Allowed" : "Blocked")
            DetailRow(
                "Allowed hosts",
                value: policy.allowedHosts.isEmpty
                    ? "None" : policy.allowedHosts.joined(separator: ", ")
            )
        } header: {
            Text("Network / egress")
        } footer: {
            Text("Controls which hosts pods launched from this environment can reach.")
        }
    }

    @ViewBuilder
    private var secretsSection: some View {
        Section {
            UnparsedRowsNotice(count: unparsedSecretCount, resourceName: "secret")
            ForEach(secrets) { secret in
                HStack {
                    Text(secret.name)
                        .font(.system(.body, design: .monospaced))
                    Spacer(minLength: 12)
                    Button {
                        pendingSecretDelete = secret
                    } label: {
                        Image(systemName: "trash")
                            .foregroundStyle(AppColors.destructive)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Delete environment secret \(secret.name)")
                    .accessibilityIdentifier("Delete environment secret \(secret.name)")
                }
            }
            SecretEntryFields(
                name: $secretName,
                value: $secretValue,
                accessibilityPrefix: "Environment secret",
                isSaving: isSavingSecret,
                save: { Task { await saveSecret() } }
            )
        } header: {
            Text("Environment secrets (write-only)")
        } footer: {
            Text(
                """
                Values can be replaced or deleted but never read back — not even by the \
                agent that wrote this environment. They are injected into pods launched \
                from it.
                """
            )
        }
    }

    // MARK: - Data

    private func loadAll() async {
        do {
            template = try await api.template(id: templateId)
            loadFailure = nil
        } catch {
            let message = FriendlyError.message(
                error, serverHost: Config.serverURL.absoluteString
            )
            if template == nil { loadFailure = message } else { status = .failure(message) }
        }
        await loadSecrets()
    }

    private func loadSecrets() async {
        do {
            let decoded = try await api.secrets(scope: "template", scopeId: templateId)
            secrets = decoded.items
            unparsedSecretCount = decoded.unparsedRows.count
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }

    private func saveSecret() async {
        isSavingSecret = true
        defer { isSavingSecret = false }
        do {
            try await api.putSecret(
                scope: "template",
                scopeId: templateId,
                name: SecretName.normalized(secretName),
                value: secretValue.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            secretName = ""
            secretValue = ""
            status = .success("Secret saved. Its value can never be read back.")
            await loadSecrets()
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }

    private func deleteSecret(_ secret: SecretMeta) async {
        do {
            try await api.deleteSecret(scope: "template", scopeId: templateId, name: secret.name)
            status = .success("Secret deleted.")
            await loadSecrets()
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }
}
