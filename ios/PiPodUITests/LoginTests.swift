import XCTest

/// Real-backend PKCE login against production Zitadel with the provisioned
/// project-owned test identity (currently the coordinated A2 lease — the
/// test reads whatever identity Root stages into UITEST_USERNAME/PASSWORD;
/// no identity is invented here). No stub, no fixture JWT, no dev-token
/// path (devToken is Debug-only in the app, the app under test runs
/// Release, and these tests never set it).
///
/// Secrecy contract: credentials travel environment -> in-memory fill only.
/// No test prints, logs, or attaches usernames, passwords, or any URL (the
/// callback carries ?code=). Failure output is limited to element COUNTS
/// and kinds, never values or page text. NO screenshots are taken during
/// login or callback handling; post-auth diagnostics use explicit
/// "postauth-"-prefixed attachments only (see SessionLifecycleTests).
final class LoginTests: XCTestCase {
    private var app: XCUIApplication!
    private var systemAuth: SystemAuthUI!

    override func setUpWithError() throws {
        continueAfterFailure = false
        UITestConfig.requireLiveInputs()
        app = XCUIApplication()
        systemAuth = SystemAuthUI()
        app.launch()
    }

    /// Fills the Zitadel login page inside the system-owned authentication
    /// web view. The SafariViewService proxy is queried without launching or
    /// activating it, preserving the ASWebAuthenticationSession in flight.
    /// Matches by element KIND (never by secret content); fails with a
    /// structure-only diagnostic when the page shape is unrecognized.
    private func fillZitadelLogin(username: String, password: String, file: StaticString = #filePath, line: UInt = #line) {
        let usernamePhaseComplete = systemAuth.completeUsernamePhase(
            username: username)
        XCTAssertTrue(usernamePhaseComplete,
            "username staged phase completed", file: file, line: line)
        guard usernamePhaseComplete else { return }

        let passwordEntry = systemAuth.enterPasswordAndRequireDelivery(password)
        XCTAssertNotNil(passwordEntry,
            "password entry gate accepted", file: file, line: line)
        guard let passwordBoundary = passwordEntry else { return }

        let submittedPasswordField = systemAuth.submitPasswordWithReturnOnce(
            after: passwordBoundary)
        XCTAssertNotNil(submittedPasswordField,
            "single password Return submit performed", file: file, line: line)
        guard let passField = submittedPasswordField else { return }

        systemAuth.observeSinglePasswordEnterEffect(passwordField: passField)

        let callbackReceived = systemAuth.waitForAuthCallback(
            podsNavigationBar: app.navigationBars["Pods"])
        XCTAssertTrue(callbackReceived, "auth callback boundary received after password Enter", file: file, line: line)
        guard callbackReceived else { return }
    }

    func testLoginRealPKCE() throws {
        // 1. App sign-in entry (existing accessibility identifier, no app change).
        let signIn = app.buttons["sign_in_button"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 30), "sign-in screen shown")
        signIn.tap()

        // 2. SpringBoard-owned system consent (absent after prior consent).
        //    Any presented but unknown alert shape fails closed.
        _ = systemAuth.acceptConsentIfPresented()

        // 3. Real Zitadel PKCE in the system browser sheet.
        fillZitadelLogin(username: UITestConfig.username, password: UITestConfig.password)

        // 4. Post-login: pod list is the authenticated landing surface.
        //    MFA/consent variations that still land here pass; anything else
        //    fails closed WITHOUT dumping page content or capturing pixels.
        // The Pods navigation bar specifically: any other bar (settings,
        // consent leftovers, error sheets) must NOT satisfy this assert.
        let podList = app.navigationBars["Pods"]
        var podsVisible = systemAuth.waitForPodsLanding(podList)
        // A lost callback (browser dismissed, app never landed) is the same
        // real PKCE round re-driven, not a different path: the IdP session
        // usually completes it without retyping. Bounded to one retry; a
        // persistently broken callback still fails closed below.
        if !podsVisible, app.buttons["sign_in_button"].waitForExistence(timeout: 10) {
            // The retry re-drives the full round: tap sign-in to open a new
            // browser session before filling it, exactly like the first
            // round above. Checking existence without tapping would fill a
            // login page that was never opened.
            app.buttons["sign_in_button"].tap()
            _ = systemAuth.acceptConsentIfPresented()
            fillZitadelLogin(username: UITestConfig.username, password: UITestConfig.password)
            podsVisible = systemAuth.waitForPodsLanding(podList)
        }
        XCTAssertTrue(podsVisible, "authenticated pod list shown after PKCE")
    }
}
