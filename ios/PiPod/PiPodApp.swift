import SwiftUI
import UIKit
import UserNotifications

/// Forwards APNs registration callbacks to the push controller.
final class AppDelegate: NSObject, UIApplicationDelegate {
    @MainActor var push: PushController { AppEnvironment.shared.push }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // The notification delegate has to exist before launching finishes. A tap
        // that cold-starts the app delivers its response immediately, and a
        // delegate installed later from a SwiftUI `.task` misses it entirely — the
        // app opens on the pod list instead of the conversation you tapped.
        MainActor.assumeIsolated {
            UNUserNotificationCenter.current().delegate = AppEnvironment.shared.push
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in push.didRegister(tokenData: deviceToken) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in push.didFailToRegister(error: error) }
    }
}

/// Everything long-lived, wired once.
///
/// Constructed here rather than inside views so the API client, the token store
/// and the session state machine are the same instances everywhere — a second
/// `APIClient` would carry its own tokens and quietly sign the user out.
@MainActor
final class AppEnvironment {
    /// One instance, reachable from the UIKit delegate as well as the scene. The
    /// delegate needs the push controller before any view exists.
    static let shared = AppEnvironment()

    let api: APIClient
    let session: SessionStore
    let push: PushController
    let router = AppRouter()
    let auth: ZitadelAuthService

    init() {
        let storage = KeychainTokenStorage()
        let oidc = OIDCClient()
        let api = APIClient(refresher: oidc)
        let push = PushController(api: api)
        self.api = api
        self.push = push
        self.auth = ZitadelAuthService(oidc: oidc, storage: storage)
        self.session = SessionStore(
            api: api,
            storage: storage,
            authenticator: auth
        )
        // Navigation belongs to the session that opened it. Without this, signing
        // out and back in — or switching organization — came back to whatever
        // pod, job or settings screen the last session had stacked, which then
        // fetched rows the new session may not even be allowed to see.
        session.onSessionReset = { [router, push] in
            router.reset()
            push.resetForNewSession()
        }
        session.onSignOut = { [push] cleanupClient in
            await push.unregister(using: cleanupClient)
        }
    }
}

@main
struct PiPodApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var environment = AppEnvironment.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(environment.session)
                .environment(environment.router)
                .environment(environment.push)
                .environment(\.apiClient, environment.api)
                .environment(\.authService, environment.auth)
                .tint(AppColors.accent)
                .task {
                    await environment.push.refreshAuthorization()
                    await environment.session.startup()
                }
                .onChange(of: scenePhase) { _, phase in
                    // A restore that failed on a dead network at launch leaves a
                    // usable refresh token and a sign-in screen. Coming back to
                    // the foreground is the moment to try it again — that is
                    // what "Will retry" promises.
                    guard phase == .active else { return }
                    Task {
                        guard await environment.session.needsRestoreRetry() else { return }
                        await environment.session.restore()
                    }
                }
        }
    }
}

// MARK: - Environment plumbing

private struct APIClientKey: EnvironmentKey {
    static let defaultValue = APIClient()
}

private struct AuthServiceKey: EnvironmentKey {
    static let defaultValue: AuthService? = nil
}

extension EnvironmentValues {
    var apiClient: APIClient {
        get { self[APIClientKey.self] }
        set { self[APIClientKey.self] = newValue }
    }

    var authService: AuthService? {
        get { self[AuthServiceKey.self] }
        set { self[AuthServiceKey.self] = newValue }
    }
}
