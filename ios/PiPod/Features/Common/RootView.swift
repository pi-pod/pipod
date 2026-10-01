import SwiftUI

/// Holds every authenticated screen behind session restoration and sign-in.
public struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(PushController.self) private var push

    public init() {}

    public var body: some View {
        content
            .onOpenURL(perform: handle)
            // A tap that cold-starts the app resolves its destination before this
            // view exists, so `onChange` alone never sees it: the pending value
            // was already there. Both entry points drain the same slot.
            .task { consumePendingNotification() }
            .onChange(of: push.pendingDestination) { _, _ in consumePendingNotification() }
            .onChange(of: session.isSignedIn) { _, signedIn in
                guard signedIn, let pending = session.pendingDeepLink else { return }
                session.pendingDeepLink = nil
                router.handle(pending)
            }
    }

    @ViewBuilder
    private var content: some View {
        if session.isRestoringSession {
            LoadingView(label: "Restoring session…")
        } else if !session.isSignedIn {
            SignInView(
                notice: session.authNotice,
                signIn: { try await session.signIn() }
            )
        } else {
            AppShell()
        }
    }

    private func consumePendingNotification() {
        guard let destination = push.pendingDestination else { return }
        push.pendingDestination = nil
        deliver(destination)
        // A notification is the server telling us something changed while the
        // app was away. The payload carries no `aps.badge`, so the tab badge,
        // the app icon and the pod list's approvals row are all stale until
        // something asks — and this is the moment we know to ask.
        Task { await session.refreshApprovalsBadge() }
    }

    private func handle(_ url: URL) {
        if DeepLinkDestination.isAuthCallback(url) {
            // A browser that completed sign-in outside `ASWebAuthenticationSession`
            // — a cold start, or Safari finishing after the app was killed —
            // delivers the redirect here instead.
            guard ZitadelAuthService.isAuthorizationResult(url) else { return }
            Task {
                do {
                    try await session.signIn(callback: url)
                } catch {
                    // A redirect that cannot be completed — a replayed link, a
                    // proof this device no longer holds — must say so. Swallowing
                    // it leaves the sign-in screen looking like the tap did
                    // nothing at all.
                    session.reportAuthorizationFailure(error)
                }
            }
            return
        }
        guard let destination = DeepLinkDestination.from(url: url) else { return }
        deliver(destination)
    }

    private func deliver(_ destination: DeepLinkDestination) {
        guard session.isSignedIn else {
            // Hold it until sign-in finishes rather than dropping it.
            session.pendingDeepLink = destination
            return
        }
        router.handle(destination)
    }
}

/// The signed-in tab shell.
struct AppShell: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router

    /// Where the live conversations announce themselves, so a value route can
    /// build a screen that needs one.
    @State private var streams = SessionStreamRegistry()

    var body: some View {
        @Bindable var router = router
        return TabView(selection: $router.selectedTab) {
            NavigationStack(path: $router.podsPath) {
                PodListView()
                    .navigationDestination(for: PodRoute.self, destination: podDestination)
            }
            .tabItem { Label(AppTab.pods.title, systemImage: AppTab.pods.systemImage) }
            .badge(session.pendingApprovalsCount)
            .tag(AppTab.pods)

            NavigationStack(path: $router.jobsPath) {
                JobsListView()
                    .navigationDestination(for: JobRoute.self, destination: jobDestination)
            }
            // No badge: jobs have no draft state left to wait for a decision on.
            .tabItem { Label(AppTab.jobs.title, systemImage: AppTab.jobs.systemImage) }
            .tag(AppTab.jobs)

            NavigationStack(path: $router.settingsPath) {
                SettingsView()
                    .navigationDestination(for: SettingsRoute.self, destination: settingsDestination)
            }
            .tabItem { Label(AppTab.settings.title, systemImage: AppTab.settings.systemImage) }
            .tag(AppTab.settings)
        }
        .environment(streams)
        .task { await session.refreshApprovalsBadge() }
    }

    @ViewBuilder
    private func podDestination(_ route: PodRoute) -> some View {
        switch route {
        case .detail(let podId, let pod):
            PodDetailView(podId: podId, initialPod: pod)
        case .session(let podId, let pod, let fromSeq, let sessionId):
            // The route travels with the screen: it is the identity the session
            // uses to tell a real pop from being replaced by another entry for
            // the same pod.
            SessionView(
                podId: podId, initialPod: pod, fromSeq: fromSeq, sessionId: sessionId,
                route: route
            )
            // A conversation is a focused screen; the tab bar goes away with it.
            .toolbar(.hidden, for: .tabBar)
        case .launch:
            LaunchPodView()
        case .retryLaunch(let templateId):
            LaunchPodView(templateId: templateId, isRetry: true)
        case .approvals:
            InteractionListView()
        case .approvalDetail(let interaction):
            InteractionDetailView(interaction: interaction)
        case .modelPicker(let podId):
            modelPicker(podId: podId)
        }
    }

    @ViewBuilder
    private func modelPicker(podId: String) -> some View {
        if let stream = streams.stream(for: podId) {
            ModelPickerView(model: stream) {
                if !router.podsPath.isEmpty { router.podsPath.removeLast() }
            }
            .toolbar(.hidden, for: .tabBar)
        } else {
            // The conversation this belongs to is gone, so there is nothing to
            // switch models on. Say so rather than showing an empty catalog.
            EmptyStateView(
                title: "Conversation closed",
                message: "Open the pod again to change its model.",
                systemImage: "cpu",
                actionTitle: "Back",
                action: { if !router.podsPath.isEmpty { router.podsPath.removeLast() } }
            )
        }
    }

    @ViewBuilder
    private func jobDestination(_ route: JobRoute) -> some View {
        switch route {
        case .detail(let jobId, let job):
            JobDetailView(jobId: jobId, initialJob: job)
        }
    }

    @ViewBuilder
    private func settingsDestination(_ route: SettingsRoute) -> some View {
        switch route {
        case .environments:
            TemplateListView()
        case .environmentDetail(let templateId, let template):
            TemplateDetailView(templateId: templateId, initialTemplate: template)
        case .newEnvironment:
            TemplateDetailView(templateId: nil, initialTemplate: nil)
        case .credentials:
            CredentialsView()
        case .proposals:
            SettingsProposalsView()
        case .proposalDetail(let proposal):
            ProposalDetailView(proposal: proposal)
        case .configBundle(let scope):
            ConfigBundleEditorView(scope: scope)
        case .secrets(let scope, let scopeId, let title):
            SecretsView(scope: scope, scopeId: scopeId, title: title)
        case .planChange:
            PlanChangeView()
        }
    }
}
