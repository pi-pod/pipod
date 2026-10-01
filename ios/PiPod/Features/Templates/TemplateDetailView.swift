import SwiftUI

/// The egress policy carried inside a template's config bundle.
///
/// The editor reads and writes exactly these three controls, and everything else
/// in the bundle — keys this build has never heard of included — has to survive
/// the round trip untouched. An app that silently drops a server-side option it
/// does not render is an app that breaks environments by opening them.
struct EgressPolicy: Equatable {
    var isRestricted: Bool
    var allowsBuiltins: Bool
    var allowedHosts: [String]

    static let open = EgressPolicy(isRestricted: false, allowsBuiltins: true, allowedHosts: [])

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

    /// `config` with only the three egress keys this editor owns replaced.
    func applied(to config: JSONValue) -> JSONValue {
        var object = config.objectValue ?? [:]
        var egress = object["egress"]?.objectValue ?? [:]
        egress["mode"] = .string(isRestricted ? "allowlist" : "open")
        egress["builtins"] = .bool(allowsBuiltins)
        egress["allow"] = .array(allowedHosts.map(JSONValue.string))
        object["egress"] = .object(egress)
        return .object(object)
    }

    /// One host per line is what the field asks for, but people paste comma
    /// -separated lists, so both separators are accepted. `isNewline` rather than
    /// a comparison against "\n": Swift reads CRLF as one character, and a pasted
    /// Windows line ending would otherwise become part of a hostname.
    static func hosts(from text: String) -> [String] {
        text.split(whereSeparator: { $0.isNewline || $0 == "," })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    var hostsText: String { allowedHosts.joined(separator: "\n") }
}

/// Why an environment save did not land.
///
/// The version conflict is separated out for the same reason
/// `ConfigBundleOutcome` separates it: someone else saved, and the fix is to
/// read their change rather than to retry the same write harder. A template
/// PATCH has a second 409 — a name that is already taken — so the status alone
/// is not enough to tell them apart; the wording has to say version.
enum TemplateSaveOutcome: Equatable {
    case versionConflict
    case failed(String)

    static func classify(_ error: Error, serverHost: String? = nil) -> TemplateSaveOutcome {
        if let apiError = error as? APIError, VersionConflict.isNamed(by: apiError) {
            return .versionConflict
        }
        return .failed(FriendlyError.message(error, serverHost: serverHost))
    }

    var message: String {
        switch self {
        case .versionConflict:
            return """
                Someone else saved this environment while you were editing. Reload to see \
                their change, then re-apply yours.
                """
        case .failed(let message):
            return message
        }
    }

    /// Only a conflict is fixed by reading the other person's version.
    var offersReload: Bool { self == .versionConflict }
}

/// Everything the editor needs to draw an environment: the row from the list
/// plus the two fields only the detail read carries.
struct TemplateEditorSource: Equatable {
    let template: PodTemplate?
    let editorData: EnvironmentEditorData?

    static let blank = TemplateEditorSource(template: nil, editorData: nil)
}

/// One environment: what it sets up, what it can reach, and the write-only
/// secrets pods launched from it receive.
///
/// `templateId == nil` means this screen is creating one, and it opens straight
/// into the editor.
public struct TemplateDetailView: View {
    let templateId: String?
    let initialTemplate: PodTemplate?

    @Environment(AppRouter.self) private var router
    @Environment(\.apiClient) private var api

    @State private var template: PodTemplate?
    @State private var editorData: EnvironmentEditorData?
    @State private var isLoadingEditorData = false
    @State private var secrets: [SecretMeta] = []
    @State private var unparsedSecretCount = 0
    @State private var secretName = ""
    @State private var secretValue = ""
    @State private var isSavingSecret = false
    @State private var isDeleting = false
    @State private var status: StatusMessage?
    @State private var loadFailure: String?
    @State private var isEditing = false
    @State private var isConfirmingDelete = false
    @State private var pendingSecretDelete: SecretMeta?

    public init(templateId: String?, initialTemplate: PodTemplate? = nil) {
        self.templateId = templateId
        self.initialTemplate = initialTemplate
        _template = State(initialValue: initialTemplate?.id == templateId ? initialTemplate : nil)
    }

    public var body: some View {
        Group {
            if templateId == nil {
                TemplateEditorView(
                    source: .blank,
                    isPushed: true,
                    save: create,
                    reload: nil,
                    cancel: pop
                )
            } else {
                detailContent
            }
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var detailContent: some View {
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
        .toolbar {
            if let template {
                ToolbarItem(placement: .topBarTrailing) {
                    // Editing before the bake script has arrived is how a bake
                    // script gets erased: the form would show an empty field and
                    // save it over the stored one. The button waits for the read,
                    // and takes the read itself if the first one failed.
                    Button(isLoadingEditorData ? "Loading…" : "Edit") {
                        Task { await beginEditing() }
                    }
                    .disabled(isDeleting || isLoadingEditorData)
                    .accessibilityLabel("Edit environment \(template.name)")
                    .accessibilityIdentifier("Edit environment")
                }
            }
        }
        .task { await loadAll() }
        .refreshable { await loadAll() }
        .sheet(isPresented: $isEditing) {
            NavigationStack {
                TemplateEditorView(
                    source: TemplateEditorSource(template: template, editorData: editorData),
                    isPushed: false,
                    save: update,
                    reload: reloadForEditor,
                    cancel: { isEditing = false }
                )
            }
        }
        .confirmationDialog(
            template.map { "Delete “\($0.name)”?" } ?? "Delete environment?",
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete environment", role: .destructive) { Task { await deleteTemplate() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("New pods can no longer be launched from it. Pods already running are unaffected.")
        }
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
            setupScriptSection(template)
            bakeScriptSection
            networkSection
            secretsSection
            Section {
                Button("Delete environment", role: .destructive) { isConfirmingDelete = true }
                    .disabled(isDeleting)
                    .frame(minHeight: 44)
                    .accessibilityLabel("Delete environment \(template.name)")
                    .accessibilityIdentifier("Delete environment")
            }
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
        }
    }

    private func setupScriptSection(_ template: PodTemplate) -> some View {
        Section {
            if let script = template.initScript, !script.isEmpty {
                Text(script)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .accessibilityLabel("Setup script: \(script)")
            } else {
                Text("No setup script — pods from this environment start empty.")
                    .foregroundStyle(AppColors.secondaryLabel)
            }
        } header: {
            Text("Setup script")
        } footer: {
            Text("This runs with your secrets in every pod launched from this environment.")
        }
    }

    @ViewBuilder
    private var bakeScriptSection: some View {
        Section {
            if let editorData {
                if let script = editorData.bakeScript, !script.isEmpty {
                    Text(script)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityLabel("Bake script: \(script)")
                } else {
                    Text("No bake script.").foregroundStyle(AppColors.secondaryLabel)
                }
            } else {
                ProgressView().accessibilityLabel("Loading bake script")
            }
        } header: {
            Text("Bake script")
        } footer: {
            Text("Runs when the environment image is built, not each time a pod launches.")
        }
    }

    @ViewBuilder
    private var networkSection: some View {
        Section {
            if let config = editorData?.config ?? template?.config {
                let policy = EgressPolicy.read(from: config)
                DetailRow("Network access", value: policy.isRestricted ? "Restricted" : "Open")
                DetailRow(
                    "Built-in services", value: policy.allowsBuiltins ? "Allowed" : "Blocked"
                )
                DetailRow(
                    "Allowed hosts",
                    value: policy.allowedHosts.isEmpty
                        ? "None" : policy.allowedHosts.joined(separator: ", ")
                )
            } else {
                ProgressView().accessibilityLabel("Loading network policy")
            }
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
        guard let templateId else { return }
        do {
            template = try await api.template(id: templateId)
            loadFailure = nil
        } catch {
            let message = FriendlyError.message(
                error, serverHost: Config.serverURL.absoluteString
            )
            if template == nil { loadFailure = message } else { status = .failure(message) }
        }
        await loadEditorData()
        await loadSecrets()
    }

    @discardableResult
    private func loadEditorData() async -> EnvironmentEditorData? {
        guard let templateId else { return nil }
        isLoadingEditorData = true
        defer { isLoadingEditorData = false }
        do {
            let data = try await api.templateEditorData(id: templateId)
            editorData = data
            return data
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
            return nil
        }
    }

    /// Opens the editor only once the bake script is in hand.
    private func beginEditing() async {
        if editorData == nil, await loadEditorData() == nil { return }
        isEditing = true
    }

    /// Re-reads both halves for the editor's conflict recovery.
    private func reloadForEditor() async -> TemplateEditorSource? {
        guard let templateId else { return nil }
        do {
            let fresh = try await api.template(id: templateId)
            template = fresh
            let data = await loadEditorData()
            return TemplateEditorSource(template: fresh, editorData: data)
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
            return nil
        }
    }

    private func loadSecrets() async {
        guard let templateId else { return }
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
        guard let templateId else { return }
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
        guard let templateId else { return }
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

    private func deleteTemplate() async {
        guard let templateId else { return }
        isDeleting = true
        do {
            try await api.deleteTemplate(id: templateId)
            pop()
        } catch {
            isDeleting = false
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }

    private func create(_ draft: TemplateDraft) async -> TemplateSaveOutcome? {
        do {
            _ = try await api.createTemplate(
                name: draft.name,
                description: draft.description.isEmpty ? nil : draft.description,
                initScript: draft.initScript.isEmpty ? nil : draft.initScript,
                bakeScript: (draft.bakeScript?.isEmpty == false) ? draft.bakeScript : nil,
                config: draft.config
            )
            pop()
            return nil
        } catch {
            return .classify(error, serverHost: Config.serverURL.absoluteString)
        }
    }

    private func update(_ draft: TemplateDraft) async -> TemplateSaveOutcome? {
        guard let templateId else { return nil }
        do {
            let saved = try await api.updateTemplate(id: templateId, draft: draft)
            template = saved
            // Only a bake script that actually travelled becomes the new one; a
            // save that omitted the key left the stored script alone.
            if let bakeScript = draft.bakeScript {
                editorData = try? JSONCoding.decode(
                    EnvironmentEditorData.self,
                    from: .object([
                        "bakeScript": .string(bakeScript), "config": draft.config,
                    ])
                )
            }
            isEditing = false
            status = .success("Environment updated.")
            return nil
        } catch {
            return .classify(error, serverHost: Config.serverURL.absoluteString)
        }
    }

    private func pop() {
        if !router.settingsPath.isEmpty { router.settingsPath.removeLast() }
    }
}

/// The environment form, used both as the create screen and as the edit sheet.
private struct TemplateEditorView: View {
    /// True when this is the create screen pushed onto the stack rather than the
    /// edit sheet. A pushed screen has a system Back button that cannot be
    /// intercepted, so it is hidden and Cancel becomes the only exit.
    let isPushed: Bool
    /// Nil means the write landed.
    let save: (TemplateDraft) async -> TemplateSaveOutcome?
    /// Re-reads the environment after a version conflict. Absent on the create
    /// screen, which has nothing to conflict with.
    let reload: (() async -> TemplateEditorSource?)?
    let cancel: () -> Void

    @State private var source: TemplateEditorSource
    @State private var name: String
    @State private var description: String
    @State private var initScript: String
    @State private var bakeScript: String
    @State private var hostsText: String
    @State private var isRestricted: Bool
    @State private var allowsBuiltins: Bool
    @State private var isSaving = false
    @State private var isReloading = false
    @State private var outcome: TemplateSaveOutcome?
    @State private var isConfirmingDiscard = false

    /// Every key the form does not render, carried through the save untouched.
    @State private var baseConfig: JSONValue
    @State private var original: TemplateSnapshot

    init(
        source: TemplateEditorSource,
        isPushed: Bool,
        save: @escaping (TemplateDraft) async -> TemplateSaveOutcome?,
        reload: (() async -> TemplateEditorSource?)?,
        cancel: @escaping () -> Void
    ) {
        self.isPushed = isPushed
        self.save = save
        self.reload = reload
        self.cancel = cancel

        let config = source.editorData?.config ?? source.template?.config ?? .object([:])
        let snapshot = TemplateSnapshot(source)
        _source = State(initialValue: source)
        _baseConfig = State(initialValue: config)
        _original = State(initialValue: snapshot)
        _name = State(initialValue: snapshot.name)
        _description = State(initialValue: snapshot.description)
        _initScript = State(initialValue: snapshot.initScript)
        _bakeScript = State(initialValue: snapshot.bakeScript)
        _hostsText = State(initialValue: snapshot.hostsText)
        _isRestricted = State(initialValue: snapshot.isRestricted)
        _allowsBuiltins = State(initialValue: snapshot.allowsBuiltins)
    }

    private var isEditingExisting: Bool { source.template != nil }
    private var subject: String { isEditingExisting ? "Edit environment" : "New environment" }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var isDirty: Bool { current != original }
    private var exit: UnsavedEditsExit {
        .decide(isDirty: isDirty, isSaving: isSaving || isReloading)
    }

    private var current: TemplateSnapshot {
        TemplateSnapshot(
            name: name,
            description: description,
            initScript: initScript,
            bakeScript: bakeScript,
            hostsText: hostsText,
            isRestricted: isRestricted,
            allowsBuiltins: allowsBuiltins
        )
    }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityLabel("\(subject) name")
                    .accessibilityIdentifier("\(subject) name")
                TextField("What it's for (optional)", text: $description)
                    .autocorrectionDisabled()
                    .accessibilityLabel("\(subject) description")
                    .accessibilityIdentifier("\(subject) description")
            }

            Section {
                PlainTextEditor(
                    text: $initScript,
                    minHeight: 140,
                    accessibilityLabel: "\(subject) setup script",
                    isEnabled: !isSaving
                )
            } header: {
                Text("Setup script")
            } footer: {
                Text(
                    isEditingExisting
                        ? """
                        Runs at pod launch with your secrets available. Pods already running \
                        keep the script they started with.
                        """
                        : """
                        Runs at pod launch with your secrets available. Leave it empty to \
                        start pods bare.
                        """
                )
            }

            Section {
                PlainTextEditor(
                    text: $bakeScript,
                    minHeight: 140,
                    accessibilityLabel: "\(subject) bake script",
                    isEnabled: !isSaving
                )
            } header: {
                Text("Bake script")
            } footer: {
                Text("Runs when the environment image is built, not each time a pod launches.")
            }

            Section {
                Picker("Network access", selection: $isRestricted) {
                    Text("Open").tag(false)
                    Text("Restricted to allowed hosts").tag(true)
                }
                .accessibilityLabel("\(subject) network access")
                .accessibilityIdentifier("\(subject) network access")

                Toggle("Allow built-in services", isOn: $allowsBuiltins)
                    .tint(AppColors.accent)
                    .accessibilityLabel("\(subject) allow built-in services")
                Text("Keeps pi pod and configured model services reachable.")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)

                PlainTextEditor(
                    text: $hostsText,
                    minHeight: 100,
                    accessibilityLabel: "\(subject) allowed network hosts",
                    isEnabled: !isSaving
                )
                Text("One hostname per line. Used when network access is restricted.")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            } header: {
                Text("Network / egress")
            } footer: {
                Text("Controls which hosts pods launched from this environment can reach.")
            }

            if let outcome {
                Section {
                    StatusBanner(.failure(outcome.message))
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowBackground(Color.clear)
                    if outcome.offersReload, reload != nil {
                        Button("Reload and see their change") { Task { await reloadFromServer() } }
                            .frame(minHeight: 44)
                            .disabled(isReloading || isSaving)
                            .accessibilityLabel("Reload environment after conflict")
                            .accessibilityIdentifier("Reload environment after conflict")
                    }
                }
            }
        }
        .navigationTitle(subject)
        .navigationBarTitleDisplayMode(.inline)
        // A swipe-down that drops typed edits without asking is the fastest way
        // to lose a setup script.
        .interactiveDismissDisabled(exit.interceptsNavigation)
        .navigationBarBackButtonHidden(isPushed)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") {
                    if exit == .confirmDiscard { isConfirmingDiscard = true } else { cancel() }
                }
                .disabled(exit == .stay)
                .accessibilityLabel("Cancel \(subject.lowercased())")
                .accessibilityIdentifier("Cancel \(subject)")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(isSaving ? "Saving…" : (isEditingExisting ? "Save" : "Create")) {
                    Task { await performSave() }
                }
                .disabled(trimmedName.isEmpty || isSaving || isReloading)
                .accessibilityLabel(
                    "\(isEditingExisting ? "Save" : "Create") environment form"
                )
                .accessibilityIdentifier("Save environment")
            }
        }
        .confirmationDialog(
            "Discard changes?",
            isPresented: $isConfirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) { cancel() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text(
                isEditingExisting
                    ? "Your edits to this environment will be lost."
                    : "This new environment will be lost."
            )
        }
    }

    /// A new environment has nothing stored to lose; an existing one has read
    /// its bake script only once the editor data arrived.
    private var hasLoadedBakeScript: Bool { !isEditingExisting || source.editorData != nil }

    private func performSave() async {
        isSaving = true
        outcome = nil
        defer { isSaving = false }
        let policy = EgressPolicy(
            isRestricted: isRestricted,
            allowsBuiltins: allowsBuiltins,
            allowedHosts: EgressPolicy.hosts(from: hostsText)
        )
        let draft = TemplateDraft(
            name: trimmedName,
            description: description.trimmingCharacters(in: .whitespacesAndNewlines),
            initScript: initScript.trimmingCharacters(in: .whitespacesAndNewlines),
            bakeScript: TemplateDraft.bakeScript(
                typed: bakeScript, isLoaded: hasLoadedBakeScript
            ),
            config: policy.applied(to: baseConfig),
            expectedVersion: source.template?.expectedVersion
        )
        // The sheet stays open with every typed value intact: a failed save that
        // also loses the work is two failures.
        outcome = await save(draft)
    }

    /// Takes the other person's version. There is no safe merge of two setup
    /// scripts, so the honest offer is to show theirs.
    private func reloadFromServer() async {
        guard let reload else { return }
        isReloading = true
        defer { isReloading = false }
        guard let fresh = await reload() else { return }
        source = fresh
        baseConfig = fresh.editorData?.config ?? fresh.template?.config ?? .object([:])
        let snapshot = TemplateSnapshot(fresh)
        original = snapshot
        name = snapshot.name
        description = snapshot.description
        initScript = snapshot.initScript
        bakeScript = snapshot.bakeScript
        hostsText = snapshot.hostsText
        isRestricted = snapshot.isRestricted
        allowsBuiltins = snapshot.allowsBuiltins
        outcome = nil
    }
}

/// The editable surface of an environment, so "has anything changed?" is one
/// comparison rather than seven.
struct TemplateSnapshot: Equatable {
    let name: String
    let description: String
    let initScript: String
    let bakeScript: String
    let hostsText: String
    let isRestricted: Bool
    let allowsBuiltins: Bool

    init(
        name: String,
        description: String,
        initScript: String,
        bakeScript: String,
        hostsText: String,
        isRestricted: Bool,
        allowsBuiltins: Bool
    ) {
        self.name = name
        self.description = description
        self.initScript = initScript
        self.bakeScript = bakeScript
        self.hostsText = hostsText
        self.isRestricted = isRestricted
        self.allowsBuiltins = allowsBuiltins
    }

    init(_ source: TemplateEditorSource) {
        let config = source.editorData?.config ?? source.template?.config ?? .object([:])
        let policy = EgressPolicy.read(from: config)
        self.init(
            name: source.template?.name ?? "",
            description: source.template?.description ?? "",
            initScript: source.template?.initScript ?? "",
            bakeScript: source.editorData?.bakeScript ?? "",
            hostsText: policy.hostsText,
            isRestricted: policy.isRestricted,
            allowsBuiltins: policy.allowsBuiltins
        )
    }
}
