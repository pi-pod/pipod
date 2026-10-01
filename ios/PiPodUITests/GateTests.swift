import XCTest

/// Environment-forwarding and input-presence gates. These run FIRST and
/// FAIL the acceptance job when the runner did not deliver what the live
/// tests require — a green run can never mean "inputs were missing".
final class GateTests: XCTestCase {
    func testEnvForwardingSentinelArrives() {
        // Nonsecret end-to-end proof that workflow step env reaches the
        // test process. Ordinary env inheritance is the mechanism; this
        // test pins it so a silent delivery break cannot green the suite.
        XCTAssertEqual(UITestConfig.sentinel, UITestConfig.expectedSentinel,
            "UITEST_SENTINEL did not arrive; env forwarding is broken")
    }

    func testLiveInputsPresent() {
        UITestConfig.requireLiveInputs()
    }

    /// Focused delivery-mapping check: exactly the allowlisted UITEST_*
    /// names may arrive — nothing extra, nothing missing silently. Names
    /// only; values are never read here.
    func testForwardedNameAllowlist() {
        let allowlisted: Set<String> = [
            "UITEST_BACKEND", "UITEST_SENTINEL", "UITEST_SERVER_URL",
            "UITEST_FIXTURE_POD_ID", "UITEST_SLEEPING_POD_ID",
            "UITEST_USERNAME", "UITEST_PASSWORD", "UITEST_COMPANION_BEARER",
            "UITEST_SCOPE",
        ]
        let present = Set(ProcessInfo.processInfo.environment.keys.filter { $0.hasPrefix("UITEST_") })
        XCTAssertTrue(present.isSubset(of: allowlisted),
            "unexpected UITEST_* names: \(present.subtracting(allowlisted).sorted())")
        XCTAssertTrue(present.isSuperset(of: ["UITEST_BACKEND", "UITEST_SENTINEL", "UITEST_SERVER_URL", "UITEST_SCOPE"]),
            "core forwarded names absent")
    }

    /// Secret-free pure-policy checks for the password-entry gate. Assertions
    /// compare only closed enum cases; input strings and lengths are never
    /// assertion values or messages.
    func testPasswordEntryEvidencePolicy() {
        let plaintext = SystemAuthUI.passwordEntryEvidence(
            preEntryValue: "", placeholderValue: nil,
            postEntryValue: "sample", expected: "sample")
        XCTAssertEqual(plaintext, .plaintextEquality)

        let maskedDelivery = SystemAuthUI.passwordEntryEvidence(
            preEntryValue: "Passcode", placeholderValue: "Passcode",
            postEntryValue: "••••", expected: "demo")
        XCTAssertEqual(maskedDelivery, .changedMaskedOccupancyDelivery)

        let mismatch = SystemAuthUI.passwordEntryEvidence(
            preEntryValue: "", placeholderValue: nil,
            postEntryValue: "other", expected: "sample")
        XCTAssertEqual(mismatch, .mismatch)

        let unobservable = SystemAuthUI.passwordEntryEvidence(
            preEntryValue: "", placeholderValue: nil,
            postEntryValue: nil, expected: "sample")
        XCTAssertEqual(unobservable, .unobservable)

        let placeholder = SystemAuthUI.passwordEntryEvidence(
            preEntryValue: "Passcode", placeholderValue: "Passcode",
            postEntryValue: "Passcode", expected: "sample")
        XCTAssertEqual(placeholder, .placeholder)

        let noChange = SystemAuthUI.passwordEntryEvidence(
            preEntryValue: "", placeholderValue: nil,
            postEntryValue: "", expected: "sample")
        XCTAssertEqual(noChange, .noChange)

        let prefilled = SystemAuthUI.passwordEntryEvidence(
            preEntryValue: "•", placeholderValue: nil,
            postEntryValue: "••••••", expected: "sample")
        XCTAssertEqual(prefilled, .prefilled)
    }

    /// Focused contract checks for the companion server-API paths used by
    /// the workflow companion step and the in-test re-arm helper. Pins the
    /// bound `/v1/` routes (bare `/pods` 404s) and the app's asleep rule
    /// (live pod with stopped/archived sandbox) so a route/field drift
    /// fails here instead of timing out live.
    func testCompanionRouteContract() {
        XCTAssertEqual(UITestConfig.Companion.podsPath(), "/v1/pods")
        let uuid = "01a09fce-6ce4-772f-bf61-5d1cb26e8970"
        XCTAssertEqual(UITestConfig.Companion.podPath(uuid: uuid), "/v1/pods/" + uuid)
        XCTAssertEqual(UITestConfig.Companion.conversationPath(uuid: uuid),
            "/v1/pods/" + uuid + "/conversation/events?limit=1000")
        XCTAssertEqual(UITestConfig.Companion.stopPath(uuid: uuid), "/v1/pods/" + uuid + "/stop")
        XCTAssertTrue(UITestConfig.Companion.isAsleep(state: "active", sandboxState: "stopped"))
        XCTAssertTrue(UITestConfig.Companion.isAsleep(state: "active", sandboxState: "archived"))
        XCTAssertFalse(UITestConfig.Companion.isAsleep(state: "active", sandboxState: "running"))
        XCTAssertFalse(UITestConfig.Companion.isAsleep(state: "archived", sandboxState: "stopped"))
        XCTAssertFalse(UITestConfig.Companion.isAsleep(state: nil, sandboxState: "stopped"))
        XCTAssertFalse(UITestConfig.Companion.isAsleep(state: "active", sandboxState: nil))
    }

    /// Focused scope matrix: auth with no fixture IDs passes validation
    /// while full with the same inputs fails. Pure function, no live
    /// environment touched — proves the scope gate lives in the TEST
    /// BINARY, not just the workflow.
    func testScopeAwareValidationMatrix() {
        let noFixtures = UITestConfig.missingInputs(scope: "auth", username: "u", password: "p",
            sentinel: UITestConfig.expectedSentinel, fixturePod: "", sleepingPod: "", companion: "")
        XCTAssertTrue(noFixtures.isEmpty, "auth mode needs no fixtures: \(noFixtures)")
        let fullMissing = UITestConfig.missingInputs(scope: "full", username: "u", password: "p",
            sentinel: UITestConfig.expectedSentinel, fixturePod: "", sleepingPod: "", companion: "")
        XCTAssertEqual(fullMissing.sorted(), ["UITEST_COMPANION_BEARER", "UITEST_FIXTURE_POD_ID", "UITEST_SLEEPING_POD_ID"])
        let fullReady = UITestConfig.missingInputs(scope: "full", username: "u", password: "p",
            sentinel: UITestConfig.expectedSentinel, fixturePod: "p-1", sleepingPod: "p-2", companion: "b")
        XCTAssertTrue(fullReady.isEmpty, "full mode passes with all inputs")
        let authNoCreds = UITestConfig.missingInputs(scope: "auth", username: "", password: "",
            sentinel: "wrong", fixturePod: "", sleepingPod: "", companion: "")
        XCTAssertEqual(authNoCreds.sorted(), ["UITEST_PASSWORD", "UITEST_SENTINEL", "UITEST_USERNAME"])
    }
}
