import SwiftUI

/// The workspace hub: who you are, what needs your approval, and the way in to
/// everything that configures a pod.
///
/// The Flutter build inlined every editor into one long scroll. Here each editor
/// is its own pushed screen, so the hub stays a map rather than a wall.
public struct SettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(PushController.self) private var push
    @Environment(\.apiClient) private var api
    @Environment(\.openURL) private var openURL

    @State private var proposals: [SettingsProposal] = []
    @State private var unparsedProposalCount = 0
    /// Loads run concurrently and fail independently: each section keeps its own
    /// error so one outage cannot hide or clear another's.
    @State private var sectionErrors: [String: String] = [:]
    @State private var organizationAlias = ""
    @State private var didSeedAlias = false
    @State private var isSwitchingOrganization = false
    @State private var isSwitchExpanded = false
    @State private var organizationStatus: StatusMessage?
    @State private var adminConsoleStatus: StatusMessage?
    @State private var isConfirmingSignOut = false
    @State private var isExplainingDevSignOut = false
    @State private var canSubscribe = false
    @State private var canManageBilling = false
    @State private var canChangePlan = false
    @State private var planPendingNote: String?
    @State private var billingStatus: StatusMessage?

    public init() {}

    public var body: some View {
        List {
            proposalsSection
            accountSection
            launchSection
            defaultsSection
            secretsSection
            notificationsSection
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await loadAll() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh settings")
                .accessibilityIdentifier("Refresh settings")
            }
        }
        .task {
            seedAlias()
            await loadAll()
        }
        .refreshable { await loadAll() }
        .onChange(of: router.settingsPath) { _, path in
            // A proposal applied or rejected one level deeper changes this list,
            // and a confirmed plan change rewrites the pending truth.
            guard path.isEmpty else { return }
            Task {
                await loadProposals()
                await loadBillingFlags()
            }
        }
        .confirmationDialog(
            "Sign out of pi pod?",
            isPresented: $isConfirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) { Task { await session.signOut() } }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Sign out is unavailable in this build", isPresented: $isExplainingDevSignOut) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(
                """
                This development build signs in automatically with a baked token, so signing \
                out would sign straight back in. Use a release build to switch accounts.
                """
            )
        }
    }

    // MARK: - Proposals

    @ViewBuilder
    private var proposalsSection: some View {
        if let error = sectionErrors["proposals"] {
            Section {
                SectionErrorView(message: error, retryLabel: "Retry loading proposals") {
                    await loadProposals()
                }
            }
        }
        if !proposals.isEmpty || unparsedProposalCount > 0 {
            Section {
                UnparsedRowsNotice(count: unparsedProposalCount, resourceName: "approval")
                ForEach(proposals) { proposal in
                    Button {
                        router.settingsPath.append(.proposals)
                    } label: {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Change to \(proposal.scopeLabel)")
                                    .foregroundStyle(AppColors.label)
                                if let note = proposal.note, !note.isEmpty {
                                    Text(note)
                                        .font(.subheadline)
                                        .foregroundStyle(AppColors.secondaryLabel)
                                        .lineLimit(2)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            StatusChip("Needs review", tone: .caution)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(AppColors.tertiaryLabel)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(
                        "Proposed change to \(proposal.scopeLabel), needs approval"
                    )
                    .accessibilityIdentifier("Open proposal \(proposal.id)")
                    .accessibilityAddTraits(.isButton)
                }
            } header: {
                Text("Waiting for your approval")
            } footer: {
                Text(
                    """
                    An agent drafted these from inside a pod. Nothing changes until you \
                    apply them here.
                    """
                )
            }
        }
    }

    // MARK: - Account

    @ViewBuilder
    private var accountSection: some View {
        if let user = session.user {
            Section("Account") {
                DetailRow("Signed in as", value: user.email ?? user.label)
                if let organization = session.organization {
                    DetailRow("Organization", value: organization.label)
                }

                DisclosureGroup(isExpanded: $isSwitchExpanded) {
                    switchOrganizationForm
                } label: {
                    Text("Switch organization")
                        .accessibilityLabel("Switch organization")
                }
                .accessibilityIdentifier("Switch organization")

                if let status = organizationStatus {
                    StatusBanner(status)
                }

                if let admin = session.adminConsoleUrl, let url = URL(string: admin) {
                    Button {
                        openAdminConsole(url)
                    } label: {
                        Label("Admin console", systemImage: "arrow.up.forward.square")
                    }
                    .frame(minHeight: 44)
                    .accessibilityLabel("Open admin console")
                    .accessibilityIdentifier("Open admin console")
                }
                if let status = adminConsoleStatus {
                    StatusBanner(status)
                }

                if canSubscribe {
                    Button {
                        Task { await openCheckout(paid: false) }
                    } label: {
                        Label("Start trial", systemImage: "creditcard")
                    }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("Start trial")
                    Button {
                        Task { await openCheckout(paid: true) }
                    } label: {
                        Label("Subscribe", systemImage: "creditcard.fill")
                    }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("Subscribe")
                }
                if canManageBilling {
                    Button {
                        Task { await openPortal() }
                    } label: {
                        Label("Manage billing", systemImage: "creditcard")
                    }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("Manage billing")
                }
                if canChangePlan {
                    navigationRow(
                        "Change plan", systemImage: "arrow.triangle.2.circlepath",
                        accessibilityLabel: "Open change plan"
                    ) {
                        router.settingsPath.append(.planChange)
                    }
                    if let note = planPendingNote {
                        Text(note)
                            .font(.footnote)
                            .foregroundStyle(AppColors.secondaryLabel)
                            .accessibilityLabel("Plan change status: \(note)")
                    }
                }
                if let status = billingStatus {
                    StatusBanner(status)
                }

                Button("Sign out", role: .destructive) {
                    // A development build carries a baked token that signs straight
                    // back in; sending the reader to the browser explains nothing.
                    if Config.devToken.isEmpty {
                        isConfirmingSignOut = true
                    } else {
                        isExplainingDevSignOut = true
                    }
                }
                .frame(minHeight: 44)
                .accessibilityLabel("Sign out of pi pod")
                .accessibilityIdentifier("Sign out")
            }
        }
    }

    @ViewBuilder
    private var switchOrganizationForm: some View {
        let requested = organizationAlias.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = session.organization?.alias?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let isUnchanged = !requested.isEmpty && requested == current

        VStack(alignment: .leading, spacing: 10) {
            Text("Switching organizations starts a new browser authorization for the exact alias.")
                .font(.footnote)
                .foregroundStyle(AppColors.secondaryLabel)

            TextField("Organization alias", text: $organizationAlias)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .submitLabel(.done)
                .onSubmit { Task { await switchOrganization() } }
                .accessibilityLabel("Organization alias")
                .accessibilityIdentifier("Organization alias")

            Button {
                Task { await switchOrganization() }
            } label: {
                Group {
                    if isSwitchingOrganization {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Switch organization")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .brandProminent()
            // Re-authorizing into the organization already signed in to costs a
            // browser round trip and changes nothing.
            .disabled(requested.isEmpty || isUnchanged || isSwitchingOrganization)
            .accessibilityLabel("Reauthorize organization")
            .accessibilityIdentifier("Reauthorize organization")

            if isUnchanged, !isSwitchingOrganization {
                // A disabled button with no reason reads as broken.
                Text("Already signed in to this organization.")
                    .font(.footnote)
                    .foregroundStyle(AppColors.secondaryLabel)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Navigation sections

    private var launchSection: some View {
        Section {
            navigationRow(
                "Environments", systemImage: "square.stack.3d.up",
                accessibilityLabel: "Open environments settings"
            ) {
                router.settingsPath.append(.environments)
            }
            navigationRow(
                "Model providers", systemImage: "key",
                accessibilityLabel: "Open model providers"
            ) {
                router.settingsPath.append(.credentials)
            }
        } header: {
            Text("Every pod you launch")
        } footer: {
            Text(
                """
                An environment is what a pod starts from: a setup script, a bake script and \
                a network policy. Model providers you connect work in every pod.
                """
            )
        }
    }

    @ViewBuilder
    private var defaultsSection: some View {
        if let organization = session.organization {
            Section {
                navigationRow(
                    "Organization defaults", systemImage: "building.2",
                    accessibilityLabel: "Open organization defaults"
                ) {
                    router.settingsPath.append(
                        .configBundle(scope: .organization(orgId: organization.id))
                    )
                }
            } footer: {
                Text(
                    """
                    Applied under every environment for everyone in your organization. \
                    Agents can propose changes here from inside a pod.
                    """
                )
            }
        }
        if let user = session.user {
            Section {
                navigationRow(
                    "Your defaults", systemImage: "person.crop.circle",
                    accessibilityLabel: "Open your defaults"
                ) {
                    router.settingsPath.append(.configBundle(scope: .user(userId: user.id)))
                }
            } footer: {
                Text(
                    """
                    Applied on top of the organization defaults in every pod you launch, \
                    whichever environment it uses.
                    """
                )
            }
        }
    }

    @ViewBuilder
    private var secretsSection: some View {
        if let user = session.user {
            Section {
                navigationRow(
                    "Your secrets", systemImage: "lock",
                    accessibilityLabel: "Open your secrets"
                ) {
                    router.settingsPath.append(
                        .secrets(scope: "user", scopeId: user.id, title: "Your secrets")
                    )
                }
                if let organization = session.organization,
                   session.can("secrets:org:write") || session.can("org:manage") {
                    navigationRow(
                        "Organization secrets", systemImage: "lock.square",
                        accessibilityLabel: "Open organization secrets"
                    ) {
                        router.settingsPath.append(
                            .secrets(
                                scope: "org", scopeId: organization.id,
                                title: "Organization secrets"
                            )
                        )
                    }
                }
            } footer: {
                Text(
                    """
                    Injected into every pod you launch — API keys for model providers and \
                    any other service belong here. Values can be replaced or deleted, but \
                    never read back.
                    """
                )
            }
        }
    }

    // MARK: - Notifications

    private var notificationsSection: some View {
        Section("Notifications") {
            Text(
                """
                Get an alert when pi needs approval or finishes a turn. Notifications are \
                optional and can be changed anytime.
                """
            )
            .font(.footnote)
            .foregroundStyle(AppColors.secondaryLabel)

            DetailRow("Permission", value: push.authorization.label)

            switch push.authorization {
            case .notDetermined:
                Button("Enable notifications") { Task { await push.requestAndRegister() } }
                    .frame(minHeight: 44)
                    .accessibilityLabel("Enable notifications")
                    .accessibilityIdentifier("Enable notifications")
            case .denied:
                Button("Open notification settings") { push.openSystemSettings() }
                    .frame(minHeight: 44)
                    .accessibilityLabel("Open notification settings")
                    .accessibilityIdentifier("Open notification settings")
            case .authorized, .unavailable:
                EmptyView()
            }

            if let error = push.registrationError {
                StatusBanner(.failure(error))
            }
        }
    }

    // MARK: - Rows

    private func navigationRow(
        _ title: String, systemImage: String, accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: systemImage)
                    .foregroundStyle(AppColors.label)
                Spacer(minLength: 12)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(AppColors.tertiaryLabel)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - Data

    private func seedAlias() {
        guard !didSeedAlias else { return }
        didSeedAlias = true
        organizationAlias = session.organization?.alias ?? ""
    }

    private func loadAll() async {
        await loadProposals()
        await loadBillingFlags()
        await push.refreshAuthorization()
    }

    private func loadBillingFlags() async {
        guard session.user != nil else { return }
        do {
            let account = try await api.billingAccount()
            canSubscribe = account["canSubscribe"]?.boolValue == true
            canManageBilling = account["canManageBilling"]?.boolValue == true
            // A 404 (static backend: no /v1/billing at all) lands in the
            // catch below and omits the row, exactly like the other flags.
            // An applying open quote keeps the row even though canChangePlan
            // reads false: the screen resumes that same quote id.
            let eligibility = PlanChangeEligibility.parse(account)
            let resuming = eligibility.needsResume
            canChangePlan = eligibility.canChangePlan || resuming
            if resuming {
                planPendingNote =
                    "A plan change is still being applied — open Change plan to resume its confirmation."
            } else {
                planPendingNote = eligibility.pendingNote
            }
        } catch {
            canSubscribe = false
            canManageBilling = false
            canChangePlan = false
            planPendingNote = nil
        }
    }

    private func openCheckout(paid: Bool) async {
        billingStatus = nil
        do {
            let session = try await api.createCheckoutSession(plan: "standard", trial: !paid)
            guard let url = URL(string: session.url), url.scheme == "https" else {
                billingStatus = .failure("Checkout did not return a usable URL.")
                return
            }
            billingStatus = .success("Return pages do not grant a plan; the server is the source of truth.")
            openURL(url)
        } catch {
            billingStatus = .failure(FriendlyError.message(error, serverHost: Config.serverURL.absoluteString))
        }
    }

    private func openPortal() async {
        billingStatus = nil
        do {
            let session = try await api.createPortalSession()
            guard let url = URL(string: session.url), url.scheme == "https" else {
                billingStatus = .failure("Portal did not return a usable URL.")
                return
            }
            billingStatus = .success("Return pages do not grant a plan; the server is the source of truth.")
            openURL(url)
        } catch {
            billingStatus = .failure(FriendlyError.message(error, serverHost: Config.serverURL.absoluteString))
        }
    }

    private func loadProposals() async {
        guard session.user != nil else { return }
        do {
            let decoded = try await api.settingsProposals()
            proposals = decoded.items
            unparsedProposalCount = decoded.unparsedRows.count
            sectionErrors["proposals"] = nil
        } catch {
            sectionErrors["proposals"] = """
                Some settings could not be loaded: \
                \(FriendlyError.message(error, serverHost: Config.serverURL.absoluteString))
                """
        }
    }

    private func switchOrganization() async {
        let alias = organizationAlias.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = session.organization?.alias?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !alias.isEmpty, alias != current, !isSwitchingOrganization else { return }
        isSwitchingOrganization = true
        organizationStatus = nil
        defer { isSwitchingOrganization = false }
        do {
            try await session.setOrganizationAlias(alias)
            organizationStatus = .success("Organization authorization updated.")
        } catch {
            organizationStatus = .failure(
                FriendlyError.message(error, serverHost: Config.serverURL.absoluteString)
            )
        }
    }

    private func openAdminConsole(_ url: URL) {
        adminConsoleStatus = nil
        openURL(url) { accepted in
            guard !accepted else { return }
            adminConsoleStatus = .failure(
                "Could not open the admin console. Visit \(url.absoluteString) in a browser."
            )
        }
    }
}
