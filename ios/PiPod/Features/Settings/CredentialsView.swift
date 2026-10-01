import SwiftUI

/// How a stored model credential reads on screen.
enum CredentialPresentation {
    /// The three states the broker defines get written labels; anything newer
    /// Title-Cases rather than printing a raw enum token at a person.
    static func stateLabel(_ state: String) -> String {
        switch state {
        case "ready": return "Ready"
        case "reconnect_required": return "Reconnect required"
        case "temporarily_unavailable": return "Temporarily unavailable"
        default: return titleCased(state)
        }
    }

    static func tone(_ state: String) -> StatusTone {
        switch state {
        case "ready": return .positive
        case "reconnect_required": return .caution
        case "temporarily_unavailable": return .info
        default: return .neutral
        }
    }

    /// Providers the control plane can still connect: brokered, and not already
    /// holding a credential.
    static func connectable(
        credentials: [CredentialStatus], providers: [ConnectableProvider]
    ) -> [ConnectableProvider] {
        let stored = Set(credentials.map(\.providerId))
        return providers.filter { $0.brokerSupported && !stored.contains($0.id) }
    }

    static func connectable(_ response: ModelCredentialsResponse) -> [ConnectableProvider] {
        connectable(credentials: response.credentials, providers: response.providers)
    }

    /// The sign-in methods a provider offers. One entry means there is nothing
    /// to ask about.
    static func authTypes(for provider: ConnectableProvider) -> [String] {
        var types: [String] = []
        if provider.hasOauth { types.append("oauth") }
        if provider.apiKey { types.append("api_key") }
        return types
    }

    static func provider(
        _ providerId: String, in providers: [ConnectableProvider]
    ) -> ConnectableProvider? {
        providers.first { $0.id == providerId }
    }

    static func displayName(
        _ providerId: String, in providers: [ConnectableProvider]
    ) -> String {
        provider(providerId, in: providers)?.name ?? providerId
    }

    private static func titleCased(_ raw: String) -> String {
        let spaced = raw
            .replacingOccurrences(
                of: "(?<=[a-z0-9])(?=[A-Z])", with: " ", options: .regularExpression
            )
            .replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
        let words = spaced.split(separator: " ").filter { !$0.isEmpty }
        guard !words.isEmpty else { return raw }
        return words
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }
}

/// The account-scoped provider sign-ins the control plane holds, so every pod
/// boots already signed in.
public struct CredentialsView: View {
    @Environment(\.apiClient) private var api

    @State private var credentials: [CredentialStatus] = []
    @State private var providers: [ConnectableProvider] = []
    @State private var hasLoaded = false
    @State private var loadError: String?
    @State private var busyProviderIDs: Set<String> = []
    @State private var status: StatusMessage?
    @State private var isChoosingProvider = false
    @State private var providerChoosingAuth: ConnectableProvider?
    @State private var login: LoginRequest?
    @State private var pendingRemoval: CredentialStatus?

    public init() {}

    public var body: some View {
        content
            .navigationTitle("Model providers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh model providers")
                    .accessibilityIdentifier("Refresh model providers")
                }
            }
            .task { await load() }
            .refreshable { await load() }
            .confirmationDialog(
                "Connect a model provider",
                isPresented: $isChoosingProvider,
                titleVisibility: .visible
            ) {
                ForEach(connectableProviders) { provider in
                    Button(provider.name) { begin(provider) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(
                providerChoosingAuth.map { "Connect \($0.name)" } ?? "Connect",
                isPresented: Binding(
                    get: { providerChoosingAuth != nil },
                    set: { if !$0 { providerChoosingAuth = nil } }
                ),
                titleVisibility: .visible,
                presenting: providerChoosingAuth
            ) { provider in
                Button(provider.oauthLoginLabel ?? "Sign in with \(provider.name)") {
                    login = LoginRequest(provider: provider, authType: "oauth")
                }
                Button("Connect with API key") {
                    login = LoginRequest(provider: provider, authType: "api_key")
                }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(
                pendingRemoval.map {
                    let name = CredentialPresentation.displayName($0.providerId, in: providers)
                    return "Delete the saved \(name) sign-in?"
                } ?? "Delete sign-in?",
                isPresented: Binding(
                    get: { pendingRemoval != nil },
                    set: { if !$0 { pendingRemoval = nil } }
                ),
                titleVisibility: .visible,
                presenting: pendingRemoval
            ) { credential in
                Button("Delete sign-in", role: .destructive) {
                    Task { await remove(credential) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("Pods using it will need a reconnect.")
            }
            .sheet(item: $login) { request in
                CredentialLoginView(provider: request.provider, authType: request.authType) {
                    connected in
                    login = nil
                    guard connected != nil else { return }
                    Task {
                        await load()
                        status = .success("\(request.provider.name) connected.")
                    }
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if !hasLoaded {
            LoadingView(label: "Loading model providers…")
        } else if !credentials.isEmpty {
            list
        } else if let loadError {
            EmptyStateView(
                title: "Couldn’t load model providers",
                message: loadError,
                systemImage: "wifi.slash",
                actionTitle: "Try again",
                action: { Task { await load() } }
            )
        } else {
            EmptyStateView(
                title: "No providers connected",
                message: """
                    Connect a model provider so every pod you launch boots signed in. Do not \
                    run /login inside a pod for these providers.
                    """,
                systemImage: "key",
                actionTitle: connectableProviders.isEmpty ? nil : "Connect",
                action: connectableProviders.isEmpty ? nil : { isChoosingProvider = true }
            )
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
            if let status {
                Section {
                    StatusBanner(status)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowBackground(Color.clear)
                }
            }
            Section("Connected") {
                ForEach(credentials) { credential in
                    credentialRow(credential)
                }
            }
            Section {
                Button {
                    connect()
                } label: {
                    Label("Connect", systemImage: "plus")
                        .frame(maxWidth: .infinity)
                }
                .brandProminent()
                .accessibilityLabel("Connect model provider")
                .accessibilityIdentifier("Connect model provider")
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func credentialRow(_ credential: CredentialStatus) -> some View {
        let name = CredentialPresentation.displayName(credential.providerId, in: providers)
        let stateLabel = CredentialPresentation.stateLabel(credential.state)
        let tone = CredentialPresentation.tone(credential.state)
        let isBusy = busyProviderIDs.contains(credential.providerId)
        let provider = CredentialPresentation.provider(credential.providerId, in: providers)

        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(name).font(.headline)
                Spacer(minLength: 12)
                StatusChip(stateLabel, tone: tone)
            }
            DetailRow(credential.type == "api_key" ? "API key" : "OAuth", value: stateLabel)
            if let expires = credential.expiresAt.flatMap(Format.absolute) {
                DetailRow("Expires", value: expires)
            }
            if let refreshed = credential.lastRefreshAt.flatMap(Format.absolute) {
                DetailRow("Last refreshed", value: refreshed)
            }
            if credential.state != "ready", let reason = credential.reason, !reason.isEmpty {
                Text(FriendlyError.message(serverText: reason))
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            }

            HStack(spacing: 12) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Working on \(name)")
                }
                if let provider {
                    Button("Reconnect") { begin(provider) }
                        .buttonStyle(.bordered)
                        .disabled(isBusy)
                        .accessibilityLabel("Reconnect \(name) model provider")
                        .accessibilityIdentifier("Reconnect \(name)")
                }
                Button("Test") { Task { await test(credential) } }
                    .buttonStyle(.bordered)
                    .disabled(isBusy)
                    .accessibilityLabel("Test \(name) model provider")
                    .accessibilityIdentifier("Test \(name)")
                Button("Delete", role: .destructive) { pendingRemoval = credential }
                    .buttonStyle(.bordered)
                    .disabled(isBusy)
                    .accessibilityLabel("Delete \(name) model provider sign-in")
                    .accessibilityIdentifier("Delete \(name)")
            }
            .frame(minHeight: 44)
        }
        .padding(.vertical, 4)
    }

    private var connectableProviders: [ConnectableProvider] {
        CredentialPresentation.connectable(credentials: credentials, providers: providers)
    }

    // MARK: - Actions

    private func connect() {
        guard !connectableProviders.isEmpty else {
            status = .success("Every supported model provider is already connected.")
            return
        }
        isChoosingProvider = true
    }

    private func begin(_ provider: ConnectableProvider) {
        let types = CredentialPresentation.authTypes(for: provider)
        switch types.count {
        case 0:
            status = .failure(
                """
                This provider can't be connected from the app. Store an API key as a user \
                secret if it has one.
                """
            )
        case 1:
            login = LoginRequest(provider: provider, authType: types[0])
        default:
            providerChoosingAuth = provider
        }
    }

    private func load() async {
        do {
            let response = try await api.modelCredentials()
            credentials = response.credentials
            providers = response.providers
            loadError = nil
        } catch {
            loadError = FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
        }
        hasLoaded = true
    }

    private func test(_ credential: CredentialStatus) async {
        let name = CredentialPresentation.displayName(credential.providerId, in: providers)
        busyProviderIDs.insert(credential.providerId)
        status = nil
        defer { busyProviderIDs.remove(credential.providerId) }
        do {
            let updated = try await api.testModelCredential(providerId: credential.providerId)
            replace(updated)
            let label = CredentialPresentation.stateLabel(updated.state).lowercased()
            status = StatusMessage(
                "\(name) sign-in is \(label).", isError: updated.state != "ready"
            )
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }

    private func remove(_ credential: CredentialStatus) async {
        let name = CredentialPresentation.displayName(credential.providerId, in: providers)
        busyProviderIDs.insert(credential.providerId)
        status = nil
        defer { busyProviderIDs.remove(credential.providerId) }
        do {
            try await api.deleteModelCredential(providerId: credential.providerId)
            await load()
            status = .success("\(name) sign-in deleted.")
        } catch {
            status = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }

    /// Swaps one row's status in place so a Test does not reorder or reload the
    /// whole list under the reader's thumb.
    private func replace(_ credential: CredentialStatus) {
        credentials = credentials.map {
            $0.providerId == credential.providerId ? credential : $0
        }
    }
}

/// The provider and method a login sheet was opened for.
struct LoginRequest: Identifiable {
    let provider: ConnectableProvider
    let authType: String

    var id: String { "\(provider.id)/\(authType)" }
}
