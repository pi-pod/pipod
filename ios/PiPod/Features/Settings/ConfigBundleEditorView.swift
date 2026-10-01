import SwiftUI

/// Why a config-bundle save did not land.
///
/// The version conflict is separated out because it is the only failure with a
/// specific remedy: someone else saved, and the fix is to read their change
/// rather than to retry the same write harder.
enum ConfigBundleOutcome: Equatable {
    case versionConflict
    case invalidConfig
    case failed(String)

    static func classify(_ error: Error, serverHost: String? = nil) -> ConfigBundleOutcome {
        if let apiError = error as? APIError, isVersionConflict(apiError) {
            return .versionConflict
        }
        return .failed(FriendlyError.message(error, serverHost: serverHost))
    }

    /// A settings PUT has exactly one 409 — the version check — so the status
    /// alone is enough here, and the wording is read as well for a server that
    /// answers with a different code.
    private static func isVersionConflict(_ error: APIError) -> Bool {
        error.httpStatus == 409 || VersionConflict.isNamed(by: error)
    }

    var message: String {
        switch self {
        case .versionConflict:
            return """
                Someone else saved this bundle while you were editing. Reload to see their \
                change, then re-apply yours.
                """
        case .invalidConfig:
            return "Config must be a JSON object, such as {}."
        case .failed(let message):
            return message
        }
    }

    /// Only a conflict is fixed by reading the other person's version.
    var offersReload: Bool { self == .versionConflict }
}

/// One settings layer — organization defaults or your own — read, edited and
/// written back with the version it was read at.
public struct ConfigBundleEditorView: View {
    let scope: ConfigBundleScope

    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.apiClient) private var api

    @State private var configText = ""
    @State private var initScript = ""
    @State private var bakeScript = ""
    /// The contents last read or written. Save arms only against this.
    @State private var baseline: Baseline?
    @State private var version: Int?
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var loadFailure: String?
    @State private var outcome: ConfigBundleOutcome?
    @State private var savedNotice: String?
    @State private var isConfirmingReload = false
    @State private var isConfirmingDiscard = false

    public init(scope: ConfigBundleScope) {
        self.scope = scope
    }

    public var body: some View {
        content
            .navigationTitle(scope.title)
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
            // The system Back button cannot be intercepted: by the time this
            // view hears about it the pop has happened and a rewritten init
            // script is gone. So it is hidden while there is something to lose,
            // and Cancel becomes the only way out.
            .navigationBarBackButtonHidden(exit.interceptsNavigation)
            .interactiveDismissDisabled(exit.interceptsNavigation)
            .toolbar {
                if exit.interceptsNavigation {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            if exit == .confirmDiscard { isConfirmingDiscard = true }
                        }
                        .disabled(exit == .stay)
                        .accessibilityLabel("Cancel editing \(subject)")
                        .accessibilityIdentifier("Cancel \(subject)")
                    }
                }
            }
            .confirmationDialog(
                "Discard changes?",
                isPresented: $isConfirmingReload,
                titleVisibility: .visible
            ) {
                Button("Reload", role: .destructive) { Task { await load() } }
                Button("Keep editing", role: .cancel) {}
            } message: {
                Text("Reloading this \(subject) will discard your unsaved edits.")
            }
            .confirmationDialog(
                "Discard changes?",
                isPresented: $isConfirmingDiscard,
                titleVisibility: .visible
            ) {
                Button("Discard", role: .destructive) { pop() }
                Button("Keep editing", role: .cancel) {}
            } message: {
                Text("Your unsaved edits to this \(subject) will be lost.")
            }
    }

    private func pop() {
        if !router.settingsPath.isEmpty { router.settingsPath.removeLast() }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading, version == nil {
            LoadingView(label: "Loading \(scope.title.lowercased())…")
        } else if let loadFailure, version == nil {
            EmptyStateView(
                title: "Couldn’t load \(scope.title.lowercased())",
                message: loadFailure,
                systemImage: "wifi.slash",
                actionTitle: "Try again",
                action: { Task { await load() } }
            )
        } else {
            editor
        }
    }

    private var editor: some View {
        Form {
            if !canEdit {
                Section {
                    Text("Only organization managers can save changes here.")
                        .font(.footnote)
                        .foregroundStyle(AppColors.secondaryLabel)
                }
            }

            Section("Config (JSON)") {
                PlainTextEditor(
                    text: $configText,
                    minHeight: 140,
                    accessibilityLabel: "\(capitalizedSubject) config JSON",
                    isEnabled: canEdit && !isBusy
                )
            }

            Section("Setup script") {
                PlainTextEditor(
                    text: $initScript,
                    minHeight: 110,
                    accessibilityLabel: "\(capitalizedSubject) setup script",
                    isEnabled: canEdit && !isBusy
                )
            }

            Section("Bake script") {
                PlainTextEditor(
                    text: $bakeScript,
                    minHeight: 110,
                    accessibilityLabel: "\(capitalizedSubject) bake script",
                    isEnabled: canEdit && !isBusy
                )
            }

            Section {
                Button {
                    Task { await save() }
                } label: {
                    Group {
                        if isSaving {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Save")
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .brandProminent()
                .disabled(!canSave)
                .accessibilityLabel("Save \(subject)")
                .accessibilityIdentifier("Save \(subject)")

                Button("Reload") {
                    if isDirty { isConfirmingReload = true } else { Task { await load() } }
                }
                .frame(minHeight: 44)
                .disabled(isBusy)
                .accessibilityLabel("Reload \(subject)")
                .accessibilityIdentifier("Reload \(subject)")

                if let outcome {
                    StatusBanner(.failure(outcome.message))
                    if outcome.offersReload {
                        Button("Reload and see their change") { Task { await load() } }
                            .frame(minHeight: 44)
                            .disabled(isBusy)
                            .accessibilityLabel("Reload \(subject) after conflict")
                            .accessibilityIdentifier("Reload after conflict")
                    }
                }
                if let savedNotice {
                    StatusBanner(.success(savedNotice))
                }
            } footer: {
                if let version {
                    Text(
                        """
                        Version \(version). Saving is refused if someone else changed this \
                        bundle since it was loaded; reload to pick up their change.
                        """
                    )
                }
            }
        }
    }

    // MARK: - Derived state

    private var subject: String {
        switch scope {
        case .organization: return "organization config bundle"
        case .user: return "user config bundle"
        }
    }

    private var capitalizedSubject: String {
        subject.prefix(1).uppercased() + subject.dropFirst()
    }

    /// Writing organization defaults is an administrative act; the user layer is
    /// always your own.
    private var canEdit: Bool {
        switch scope {
        case .organization: return session.can("org:manage")
        case .user: return true
        }
    }

    private var isBusy: Bool { isLoading || isSaving }

    private var exit: UnsavedEditsExit { .decide(isDirty: isDirty, isSaving: isSaving) }

    private var isDirty: Bool {
        guard let baseline else { return false }
        return baseline != Baseline(config: configText, initScript: initScript, bakeScript: bakeScript)
    }

    /// A pristine save would round-trip version N to N+1 with no diff.
    private var canSave: Bool { version != nil && isDirty && !isBusy && canEdit }

    // MARK: - Data

    private func load() async {
        isLoading = true
        outcome = nil
        savedNotice = nil
        defer { isLoading = false }
        do {
            let layer: SettingsLayer
            switch scope {
            case .organization(let orgId): layer = try await api.orgSettings(orgId: orgId)
            case .user(let userId): layer = try await api.userSettings(userId: userId)
            }
            configText = layer.config.prettyPrinted()
            initScript = layer.initScript
            bakeScript = layer.bakeScript
            version = layer.version
            baseline = Baseline(
                config: configText, initScript: initScript, bakeScript: bakeScript
            )
            loadFailure = nil
        } catch {
            loadFailure = FriendlyError.message(
                error, serverHost: Config.serverURL.absoluteString
            )
            if version != nil { outcome = .failed(loadFailure!) }
        }
    }

    private func save() async {
        guard let version else { return }
        let trimmed = configText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let config = JSONValue.parse(trimmed.isEmpty ? "{}" : trimmed),
              case .object = config
        else {
            outcome = .invalidConfig
            savedNotice = nil
            return
        }

        isSaving = true
        outcome = nil
        savedNotice = nil
        defer { isSaving = false }
        do {
            let saved: Int
            switch scope {
            case .organization(let orgId):
                saved = try await api.putOrgSettings(
                    orgId: orgId, config: config, initScript: initScript,
                    bakeScript: bakeScript, version: version
                )
            case .user(let userId):
                saved = try await api.putUserSettings(
                    userId: userId, config: config, initScript: initScript,
                    bakeScript: bakeScript, version: version
                )
            }
            configText = config.prettyPrinted()
            self.version = saved
            // A failed save leaves the previous baseline — and the typed edits —
            // in place; only a successful one becomes the new clean state.
            baseline = Baseline(
                config: configText, initScript: initScript, bakeScript: bakeScript
            )
            savedNotice = "\(capitalizedSubject) saved."
        } catch {
            outcome = ConfigBundleOutcome.classify(
                error, serverHost: Config.serverURL.absoluteString
            )
        }
    }

    private struct Baseline: Equatable {
        let config: String
        let initScript: String
        let bakeScript: String
    }
}
