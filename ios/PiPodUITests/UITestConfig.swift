import Foundation
import XCTest

/// Shared configuration for live-backend UI tests.
///
/// Values arrive ONLY through the test runner's environment (GitHub Secrets
/// mapped to step env by the workflow). Nothing here touches argv, files,
/// screenshots, logs, or the app under test. Backend/server/issuer/client
/// selection is a BUILD setting (Info.plist), never a runtime secret.
///
/// Acceptance posture: these tests run ONLY in the live acceptance job,
/// where every input below is required. Missing inputs FAIL (INCOMPLETE),
/// never skip-green. The secret-free compile job never executes tests.
enum UITestConfig {
    /// "saas" or "static". Anything else refuses before launch.
    static var backend: String {
        let raw = (ProcessInfo.processInfo.environment["UITEST_BACKEND"] ?? "").lowercased()
        return raw == "static" ? "static" : "saas"
    }

    static var isStatic: Bool { backend == "static" }

    /// Project-owned test identity staged by Root under a coordinated
    /// fixture lease (currently the owned A2 identity). Empty FAILS.
    /// Read per use; never printed, logged, screenshotted, or attached.
    static var username: String {
        ProcessInfo.processInfo.environment["UITEST_USERNAME"] ?? ""
    }

    static var password: String {
        ProcessInfo.processInfo.environment["UITEST_PASSWORD"] ?? ""
    }

    /// Nonsecret forwarding sentinel. The workflow sets a fixed public
    /// value; the sentinel test below FAILS when it does not arrive,
    /// proving step-env -> test-process delivery end to end.
    static var sentinel: String {
        ProcessInfo.processInfo.environment["UITEST_SENTINEL"] ?? ""
    }

    static let expectedSentinel = "acceptance-env-probe-v1"

    /// Root-provided fixture pod (awake, owned by the test identity).
    static var fixturePodID: String {
        ProcessInfo.processInfo.environment["UITEST_FIXTURE_POD_ID"] ?? ""
    }

    /// Root-provided fixture pod that the companion forces asleep before
    /// the run (server API stop with a provisioned ordinary bearer; the
    /// app under test still does real PKCE and never sees that bearer).
    static var sleepingPodID: String {
        ProcessInfo.processInfo.environment["UITEST_SLEEPING_POD_ID"] ?? ""
    }

    /// Exact isolated API origin under test (workflow-mapped from the
    /// allowlisted dispatch input; non-secret, used for companion calls).
    static var serverURL: String {
        ProcessInfo.processInfo.environment["UITEST_SERVER_URL"] ?? ""
    }

    /// Ordinary OIDC bearer for the companion server-API calls (stop +
    /// state asserts that re-arm the sleeping fixture). Root-provisioned;
    /// the app under test still does real PKCE and never sees it.
    /// In-memory only; never printed, logged, or attached.
    static var companionBearer: String {
        ProcessInfo.processInfo.environment["UITEST_COMPANION_BEARER"] ?? ""
    }

    /// Dispatch scope mirrored from the workflow (`auth` runs GateTests +
    /// real-PKCE LoginTests only; anything else runs the full suite).
    static var scope: String {
        (ProcessInfo.processInfo.environment["UITEST_SCOPE"] ?? "full").lowercased()
    }

    static var isAuthScope: Bool { scope == "auth" }

    /// Pure input matrix: returns the missing-field names for a scope.
    /// Auth requires credentials + sentinel only; full additionally
    /// requires both fixtures and the companion bearer. Unit-testable
    /// without touching the live environment (see GateTests).
    static func missingInputs(scope: String, username: String, password: String,
                              sentinel: String, fixturePod: String,
                              sleepingPod: String, companion: String) -> [String] {
        var missing: [String] = []
        if username.isEmpty { missing.append("UITEST_USERNAME") }
        if password.isEmpty { missing.append("UITEST_PASSWORD") }
        if sentinel != expectedSentinel { missing.append("UITEST_SENTINEL") }
        if scope != "auth" {
            if fixturePod.isEmpty { missing.append("UITEST_FIXTURE_POD_ID") }
            if sleepingPod.isEmpty { missing.append("UITEST_SLEEPING_POD_ID") }
            if companion.isEmpty { missing.append("UITEST_COMPANION_BEARER") }
        }
        return missing
    }

    /// Companion server-API contract (mirrors the app's AccountClient
    /// basePath `/v1/` and Pod.isAsleep rule: live pod whose sandboxState
    /// is stopped or archived). Single source for the workflow companion
    /// step and the in-test re-arm helper below.
    enum Companion {
        /// The sandbox states the app's own `isAsleep` rule calls asleep.
        /// Anything else means the sandbox is on its way up or already up.
        static let asleepSandboxStates = ["stopped", "archived"]
        static func podsPath() -> String { "/v1/pods" }
        static func podPath(uuid: String) -> String { "/v1/pods/\(uuid)" }
        static func conversationPath(uuid: String) -> String {
            "/v1/pods/\(uuid)/conversation/events?limit=1000"
        }
        static func stopPath(uuid: String) -> String { "/v1/pods/\(uuid)/stop" }
        static func isAsleep(state: String?, sandboxState: String?) -> Bool {
            state == "active" && asleepSandboxStates.contains(sandboxState ?? "")
        }

        /// Accessibility identifiers of the SaaS billing entries.
        ///
        /// Which one a SaaS account is offered is the ACCOUNT's state, not the
        /// backend's: `GET /v1/billing/account` answers `canManageBilling`
        /// only once the account has a billing customer, and an account with
        /// no subscription is offered the trial/subscribe pair instead. The
        /// per-backend contract under test is that SaaS exposes a billing
        /// surface at all and static exposes none, so all three entries are
        /// the surface and demanding one particular entry would assert Root's
        /// choice of subscription state rather than the app's behaviour.
        static let billingEntryIdentifiers = ["Manage billing", "Subscribe", "Start trial"]
    }

    static func requireLiveInputs(file: StaticString = #filePath, line: UInt = #line) {
        let missing = missingInputs(scope: scope, username: username, password: password,
                                    sentinel: sentinel, fixturePod: fixturePodID,
                                    sleepingPod: sleepingPodID, companion: companionBearer)
        XCTAssertTrue(missing.isEmpty, "missing acceptance inputs: \(missing.joined(separator: ", "))", file: file, line: line)
    }
}
