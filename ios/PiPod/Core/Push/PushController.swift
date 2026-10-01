import Foundation
import Observation
import OSLog
import UIKit
import UserNotifications

public enum NotificationAuthorization: String, Sendable {
    case notDetermined
    case authorized
    case denied
    /// The platform cannot register at all — a simulator without a push
    /// entitlement, for instance. Saying so is better than reporting "Unknown".
    case unavailable

    public var label: String {
        switch self {
        case .notDetermined: return "Not enabled"
        case .authorized: return "Enabled"
        case .denied: return "Turned off in iOS Settings"
        case .unavailable: return "Not available on this device"
        }
    }
}

/// APNs registration, permission state, and the local banner shown when the
/// number of waiting approvals goes up while the app is open.
@MainActor
@Observable
public final class PushController: NSObject, UNUserNotificationCenterDelegate {
    public private(set) var authorization: NotificationAuthorization = .notDetermined
    public private(set) var registrationError: String?
    public private(set) var deviceToken: String?

    /// The destination a notification tap asked for, consumed by the router.
    public var pendingDestination: DeepLinkDestination?

    /// The pod whose conversation is on screen. Its own approvals do not deserve
    /// a banner — the card is already visible.
    public var visiblePodId: String?

    private let api: APIClient
    private let center: UNUserNotificationCenter
    private let environment: String
    private let defaults: UserDefaults
    private let log = Logger(subsystem: "com.pipod.app", category: "push")

    private var lastPending = 0
    private var seenFirst = false
    /// Tests have no `UIApplication` worth talking to.
    let skipsRemoteRegistration: Bool

    /// Where the last APNs token is kept between launches.
    ///
    /// A device token is not a credential — it addresses this install of this
    /// app on Apple's gateway and proves nothing — so `UserDefaults` is the
    /// right home for it. It is persisted because sign-out has to be able to
    /// tell the server to stop pushing here, and `didRegister` may not have
    /// landed in this process at all.
    static let deviceTokenKey = "push.apns_device_token"

    public init(
        api: APIClient,
        center: UNUserNotificationCenter = .current(),
        environment: String? = nil,
        skipsRemoteRegistration: Bool = false,
        defaults: UserDefaults = .standard
    ) {
        self.skipsRemoteRegistration = skipsRemoteRegistration
        self.api = api
        self.center = center
        self.defaults = defaults
        // Which APNs a token belongs to is not a detail: registering a sandbox
        // token as production silently drops every push. The value is read from
        // Info.plist rather than the entitlement, because entitlements are not in
        // the info dictionary — that read always returns nil — and both are fed by
        // the same `APS_ENVIRONMENT` build setting, so they cannot disagree.
        self.environment = environment
            ?? Self.serverEnvironment(
                apsEnvironment: Bundle.main.object(forInfoDictionaryKey: "APS_ENVIRONMENT")
                    as? String
            )
        super.init()
        deviceToken = defaults.string(forKey: Self.deviceTokenKey)
    }

    /// Translates Apple's entitlement vocabulary into the server's.
    ///
    /// `aps-environment` is `development | production`; `POST /v1/devices` accepts
    /// `sandbox | production` and rejects anything else outright. They name the
    /// same two APNs hosts. Anything unrecognised is treated as sandbox: sending a
    /// development token to the production gateway is the failure that cannot be
    /// diagnosed from the device.
    public nonisolated static func serverEnvironment(apsEnvironment: String?) -> String {
        apsEnvironment == "production" ? "production" : "sandbox"
    }

    public func refreshAuthorization() async {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: authorization = .authorized
        case .denied: authorization = .denied
        case .notDetermined: authorization = .notDetermined
        @unknown default: authorization = .unavailable
        }
        // Re-register on every launch that is already authorized. A device token
        // is not permanent — restoring from a backup, reinstalling, or an OS
        // update can change it — and registering only at the moment permission is
        // granted leaves the server holding a token that stopped working, with no
        // symptom on the device beyond notifications quietly never arriving.
        if authorization == .authorized, !skipsRemoteRegistration {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    /// Asks for permission, then registers with APNs. Both halves have to succeed
    /// before a closed app can be woken.
    @discardableResult
    public func requestAndRegister() async -> NotificationAuthorization {
        registrationError = nil
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            authorization = granted ? .authorized : .denied
        } catch {
            authorization = .unavailable
            registrationError = FriendlyError.message(error)
            return authorization
        }
        guard authorization == .authorized else { return authorization }
        if !skipsRemoteRegistration { UIApplication.shared.registerForRemoteNotifications() }
        return authorization
    }

    public func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    // MARK: - APNs callbacks

    public func didRegister(tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        defaults.set(token, forKey: Self.deviceTokenKey)
        Task { await register(token: token) }
    }

    public func didFailToRegister(error: Error) {
        // Domain and code only, for the same reason the session socket logs that
        // way: an error's description carries whatever the failing request held.
        log.error("APNs registration failed: \(logSafeDescription(error), privacy: .public)")
        registrationError = """
            Notifications are enabled, but this device could not be registered: \
            \(FriendlyError.message(error))
            """
    }

    private func register(token: String) async {
        do {
            try await api.registerDevice(
                token: token, tokenKind: "apns", platform: "ios", environment: environment
            )
            registrationError = nil
        } catch {
            registrationError = """
                Notifications are enabled, but this device could not be registered: \
                \(FriendlyError.message(error))
                """
        }
    }

    /// Tells the server to stop pushing to this device.
    ///
    /// The token is read from the persisted copy when this process never saw a
    /// `didRegister` callback — registration is asynchronous, so signing out
    /// shortly after launch, or after any registration failure, used to make
    /// this a silent no-op that left the `devices` row in place and the server
    /// pushing a signed-out person's approvals to their phone. The stored copy
    /// is dropped only once the server has accepted the delete, so a failed
    /// attempt is still there for the next attempt to retry.
    public func unregister(using cleanupClient: APIClient? = nil) async {
        guard let token = deviceToken ?? defaults.string(forKey: Self.deviceTokenKey),
              !token.isEmpty
        else { return }
        do {
            try await (cleanupClient ?? api).unregisterDevice(token: token)
        } catch {
            log.error(
                "device unregistration failed: \(logSafeDescription(error), privacy: .public)"
            )
            return
        }
        deviceToken = nil
        defaults.removeObject(forKey: Self.deviceTokenKey)
    }

    /// Forgets what this process has already announced, for a session that is
    /// over. Without it the first count of the *next* session is compared
    /// against the previous person's: a cold count of 1 after signing in as
    /// someone with none would banner, and a genuine rise would not.
    public func resetBadgeState() {
        lastPending = 0
        seenFirst = false
        visiblePodId = nil
    }

    /// What this process has already announced, for tests that pin the
    /// first-observation-is-silent rule.
    var lastAnnouncedPendingCount: Int { lastPending }
    var hasAnnouncedAPendingCount: Bool { seenFirst }

    // MARK: - Local banners

    /// Called whenever the signed-in store learns a new pending-approval count.
    /// The first observation is silent so a cold start does not replay history.
    /// `announce` is false when the rise was raised by a session this app is
    /// rendering: the icon badge still moves, but a banner over a card that is
    /// already on screen only repeats it.
    public func onPendingCount(_ count: Int, announce: Bool = true) async {
        defer {
            seenFirst = true
            lastPending = count
        }
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
        guard announce, seenFirst, count > lastPending, authorization == .authorized
        else { return }
        let request = UNNotificationRequest(
            identifier: "approvals-\(count)-\(Date().timeIntervalSince1970)",
            content: PushController.approvalsContent(count: count),
            trigger: nil
        )
        try? await center.add(request)
    }

    /// The banner itself, built apart from delivering it so its payload is
    /// testable — a notification with no `userInfo` reaches the router with
    /// nothing to route, and tapping it merely reopens whatever was on screen.
    nonisolated static func approvalsContent(count: Int) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Approval needed"
        content.body = count == 1 ? "1 request is waiting" : "\(count) requests are waiting"
        content.sound = .default
        // The count names no single approval, so it opens the inbox listing all
        // of them — the same destination `pipod://…/pods/approvals` resolves to.
        content.userInfo = ["interaction_id": "inbox"]
        return content
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Completion-handler signatures, never the async alternatives. The async
    /// variants are exposed to ObjC through a generated shim, and that shim
    /// hands control back to UIKit off the main thread once the body hops
    /// actors. On a cold launch from a notification tap UIKit then asserts
    /// inside `_performBlockAfterCATransactionCommitSynchronizes` (`Call must
    /// be made on main thread`) and the app dies before it draws. Hopping to
    /// the main actor inside and calling the completion handler there keeps
    /// every path — valid payload or not — on the main thread, exactly once.
    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        willPresentPayload(
            notification.request.content.userInfo, completionHandler: completionHandler)
    }

    nonisolated public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        didReceivePayload(
            response.notification.request.content.userInfo, completionHandler: completionHandler)
    }

    /// Payload in, completion out — without the unconstructible
    /// `UNNotification` / `UNNotificationResponse` types, so tests can drive
    /// the exact code the delegate runs, from any thread.
    nonisolated func willPresentPayload(
        _ payload: [AnyHashable: Any],
        completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Everything the decision needs that is not main-actor state is computed
        // before the hop, so only a Sendable pod id crosses isolation.
        let podId = DeepLinkDestination.from(payload: normalize(payload))?.podId
        Task { @MainActor in
            // A push about the conversation already on screen would be noise.
            if let podId, podId == self.visiblePodId {
                completionHandler([])
            } else {
                completionHandler([.banner, .sound, .badge])
            }
        }
    }

    nonisolated func didReceivePayload(
        _ payload: [AnyHashable: Any],
        completionHandler: @escaping () -> Void
    ) {
        let destination = DeepLinkDestination.from(payload: normalize(payload))
        Task { @MainActor in
            if let destination {
                self.pendingDestination = destination
            }
            completionHandler()
        }
    }

    /// APNs nests the app's keys next to `aps`; a local notification puts them at
    /// the top level. Both spellings reach the router the same way.
    nonisolated func normalize(_ payload: [AnyHashable: Any]) -> [String: Any] {
        var flat: [String: Any] = [:]
        for (key, value) in payload {
            guard let key = key as? String else { continue }
            if key == "aps" { continue }
            flat[key] = value
        }
        if let data = payload["data"] as? [String: Any] {
            for (key, value) in data where flat[key] == nil { flat[key] = value }
        }
        return flat
    }
}