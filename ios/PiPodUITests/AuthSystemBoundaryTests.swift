import XCTest

/// Public, credential-free boundary proof for the system-owned half of normal
/// ASWebAuthenticationSession. This stops at the IdP username field: it never
/// types, submits, follows a callback, or asserts authenticated app state.
final class AuthSystemBoundaryTests: XCTestCase {
    func testSystemConsentToIdPUsernameBoundary() throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        guard environment["UITEST_AUTH_BOUNDARY_PROBE"] == "public-system-ui-v1" else {
            throw XCTSkip("public system-auth boundary probe is not armed")
        }
        guard environment["UITEST_USERNAME"] == nil,
              environment["UITEST_PASSWORD"] == nil,
              environment["UITEST_COMPANION_BEARER"] == nil else {
            XCTFail("public boundary credential inputs absent")
            return
        }
        print("PIPOD_AUTH_BOUNDARY_STAGE=probe-armed")

        let app = XCUIApplication()
        app.launch()
        let signIn = app.buttons["sign_in_button"]
        guard signIn.waitForExistence(timeout: 30) else {
            XCTFail("public boundary sign-in entry shown")
            return
        }
        signIn.tap()
        print("PIPOD_AUTH_BOUNDARY_STAGE=app-signin-tapped")

        let systemAuth = SystemAuthUI()
        guard systemAuth.acceptConsentIfPresented(required: true) else { return }
        print("PIPOD_AUTH_BOUNDARY_STAGE=system-consent-accepted")
        let webView = systemAuth.webView
        // Sixty seconds, not thirty: SafariViewService cold-starts on a
        // fresh simulator, and two consecutive dispatches accepted consent
        // and then never saw the browser inside thirty. Same proof -- the
        // real system browser, then the real IdP field below -- with a
        // bound a cold system service can meet on a loaded runner.
        guard webView.waitForExistence(timeout: 60) else {
            XCTFail("public boundary system browser shown")
            return
        }
        print("PIPOD_AUTH_BOUNDARY_STAGE=system-browser-visible")
        guard webView.textFields.firstMatch.waitForExistence(timeout: 30) else {
            XCTFail("public boundary IdP username field shown")
            return
        }
        print("PIPOD_AUTH_BOUNDARY_STAGE=idp-username-field-visible")
    }
}
