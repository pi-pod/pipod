import XCTest

/// Fixed system-process boundary for ASWebAuthenticationSession UI.
///
/// The consent alert belongs to SpringBoard and the browser sheet belongs to
/// SafariViewService, not to the application under test. These are proxies for
/// already-running system processes: never launch or activate either one,
/// because doing so would replace/cancel the authentication session.
struct SystemAuthUI {
    static let consentHostBundleIdentifier = "com.apple.springboard"
    static let browserHostBundleIdentifier = "com.apple.SafariViewService"

    private static let exactAdvanceLabels = ["Next", "Continue", "Sign in"]

    private enum PasswordInterstitialControlObservation {
        case absent
        case presentNotReady
        case ready(XCUIElement)
    }

    private enum UsernameAdvanceEffect {
        case usernameFieldGone
        case passwordFieldPresent
        case webViewReloadObserved
    }

    private enum UsernameAdvanceEffectCheckResult {
        case effect(UsernameAdvanceEffect)
        case noEffect
        case waitFailed
    }

    private enum UsernameValueCheckResult: Equatable {
        case matched
        case timeoutMismatch
        case webViewMissing
        case webViewNonunique
        case fieldMissing
        case fieldNonunique
        case fieldNotReady
        case valueUnobservable
    }

    private enum OwnedWebViewCountCategory {
        case one
        case two
        case threeOrMore
    }

    private enum PasswordEnterEffect {
        case passwordFieldGone
        case callbackBoundary
    }

    private enum PasswordEnterEffectCheckResult {
        case effect(PasswordEnterEffect)
        case noEffect
        case waitFailed
    }

    private enum PasswordEnterRevalidationPhase {
        case preFocus
        case postFocus
    }

    private enum PasswordEnterRevalidationStage {
        case started
        case webViewOwned
        case fieldUnique
        case fieldReady
        case boundaryUnchanged
        case completed
    }

    enum PasswordEntryEvidence: Equatable {
        case plaintextEquality
        case changedMaskedOccupancyDelivery
        case mismatch
        case unobservable
        case placeholder
        case noChange
        case prefilled
        case nonunique
        case notReady
        case waitFailed
    }

    struct PasswordEntryBoundary {
        fileprivate let acceptedValue: String
    }

    private static let safePasswordMaskCharacters: Set<Character> = ["•"]

    private struct UsernamePhaseBudget {
        let deadline: Date

        init(totalTimeout: TimeInterval) {
            deadline = Date().addingTimeInterval(totalTimeout)
        }

        func timeout(maximum: TimeInterval) -> TimeInterval {
            max(0, min(maximum, deadline.timeIntervalSinceNow))
        }

        var hasTimeRemaining: Bool {
            deadline.timeIntervalSinceNow > 0
        }
    }

    private let consentHost = XCUIApplication(
        bundleIdentifier: SystemAuthUI.consentHostBundleIdentifier)
    private let browserHost = XCUIApplication(
        bundleIdentifier: SystemAuthUI.browserHostBundleIdentifier)

    var webView: XCUIElement {
        browserHost.webViews.firstMatch
    }

    private var ownedTextFields: XCUIElementQuery {
        browserHost.descendants(matching: .textField)
    }

    private var ownedSecureTextFields: XCUIElementQuery {
        browserHost.descendants(matching: .secureTextField)
    }

    /// Runs the username phase as separately bounded, fixed-marker stages under
    /// one 60-second page budget. The username remains in memory only.
    func completeUsernamePhase(
        username: String,
        totalTimeout: TimeInterval = 60
    ) -> Bool {
        let budget = UsernamePhaseBudget(totalTimeout: totalTimeout)
        guard waitForIdPPageLoad(budget: budget) else { return false }

        guard let usernameField = waitForUsernameFieldExists(
            budget: budget) else {
            return false
        }
        guard waitForUsernameFieldEnabled(usernameField, budget: budget) else {
            return false
        }
        guard waitForUsernameFieldHittable(usernameField, budget: budget) else {
            return false
        }
        guard let readyUsernameField = uniqueReadyUsernameField() else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-field-not-ready")
            return false
        }
        guard focusUsernameField(readyUsernameField, budget: budget) else {
            return false
        }
        guard typeUsername(
            username,
            into: readyUsernameField,
            budget: budget
        ) else {
            return false
        }
        guard waitForCommittedUsername(
            expected: username,
            timeout: budget.timeout(maximum: 15)
        ) else {
            return false
        }
        guard let advanceControl = waitForUsernameAdvanceControl(
            in: webView,
            timeout: budget.timeout(maximum: 15)
        ) else {
            return false
        }
        return tapUsernameAdvanceAndRequireEffect(
            usernameField: readyUsernameField,
            control: advanceControl,
            budget: budget)
    }

    private func waitForIdPPageLoad(budget: UsernamePhaseBudget) -> Bool {
        print("PIPOD_USERNAME_TRANSITION_STAGE=idp-page-load-started")
        let result = waitForCondition(timeout: budget.timeout(maximum: 30)) {
            self.webView.exists
        }
        switch result {
        case .completed:
            print("PIPOD_USERNAME_TRANSITION_STAGE=idp-page-load-completed")
            return true
        case .timedOut:
            print("PIPOD_USERNAME_TRANSITION_ERROR=idp-page-load-timeout")
            return false
        default:
            print("PIPOD_USERNAME_TRANSITION_ERROR=idp-page-load-wait-failed")
            return false
        }
    }

    private func waitForUsernameFieldExists(
        budget: UsernamePhaseBudget
    ) -> XCUIElement? {
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-field-exists-started")
        var observedField: XCUIElement?
        var webViewCountCategory: OwnedWebViewCountCategory?
        let result = waitForCondition(timeout: budget.timeout(maximum: 20)) {
            let webViewCount = self.browserHost.webViews.count
            webViewCountCategory = self.ownedWebViewCountCategory(webViewCount)
            guard webViewCount >= 1 else { return false }
            let fields = self.ownedTextFields
            guard fields.count == 1 else { return false }
            let field = fields.element(boundBy: 0)
            guard field.exists else { return false }
            observedField = field
            return true
        }
        if let webViewCountCategory {
            recordOwnedWebViewCountCategory(webViewCountCategory)
        }
        switch result {
        case .completed:
            guard let observedField else {
                print("PIPOD_USERNAME_TRANSITION_ERROR=username-field-exists-wait-failed")
                return nil
            }
            print("PIPOD_USERNAME_TRANSITION_STAGE=username-field-exists-completed")
            return observedField
        case .timedOut:
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-field-exists-timeout")
            return nil
        default:
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-field-exists-wait-failed")
            return nil
        }
    }

    private func uniqueReadyUsernameField() -> XCUIElement? {
        guard browserHost.webViews.count >= 1 else { return nil }
        let fields = ownedTextFields
        guard fields.count == 1 else { return nil }
        let field = fields.element(boundBy: 0)
        guard field.exists, field.isEnabled, field.isHittable else { return nil }
        return field
    }

    private func waitForUsernameFieldEnabled(
        _ field: XCUIElement,
        budget: UsernamePhaseBudget
    ) -> Bool {
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-field-enabled-started")
        let result = waitForCondition(timeout: budget.timeout(maximum: 15)) {
            field.exists && field.isEnabled
        }
        switch result {
        case .completed:
            print("PIPOD_USERNAME_TRANSITION_STAGE=username-field-enabled-completed")
            return true
        case .timedOut:
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-field-enabled-timeout")
            return false
        default:
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-field-enabled-wait-failed")
            return false
        }
    }

    private func waitForUsernameFieldHittable(
        _ field: XCUIElement,
        budget: UsernamePhaseBudget
    ) -> Bool {
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-field-hittable-started")
        let result = waitForCondition(timeout: budget.timeout(maximum: 15)) {
            field.exists && field.isHittable
        }
        switch result {
        case .completed:
            print("PIPOD_USERNAME_TRANSITION_STAGE=username-field-hittable-completed")
            print("PIPOD_USERNAME_TRANSITION_STAGE=username-field-visible-ready")
            return true
        case .timedOut:
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-field-hittable-timeout")
            return false
        default:
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-field-hittable-wait-failed")
            return false
        }
    }

    private func focusUsernameField(
        _ field: XCUIElement,
        budget: UsernamePhaseBudget
    ) -> Bool {
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-focus-started")
        let timeout = budget.timeout(maximum: 10)
        guard timeout > 0 else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-focus-timeout")
            return false
        }
        let deadline = Date().addingTimeInterval(timeout)
        field.tap()
        guard Date() <= deadline else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-focus-timeout")
            return false
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-focus-completed")
        return true
    }

    private func typeUsername(
        _ username: String,
        into field: XCUIElement,
        budget: UsernamePhaseBudget
    ) -> Bool {
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-typing-started")
        let timeout = budget.timeout(maximum: 15)
        guard timeout > 0 else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-typing-timeout")
            return false
        }
        let deadline = Date().addingTimeInterval(timeout)
        field.typeText(username)
        guard Date() <= deadline else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-typing-timeout")
            return false
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-typing-completed")
        return true
    }

    private func waitForCondition(
        timeout: TimeInterval,
        condition: @escaping () -> Bool
    ) -> XCTWaiter.Result {
        let predicate = NSPredicate { _, _ in condition() }
        let expectation = XCTNSPredicateExpectation(
            predicate: predicate,
            object: NSObject())
        return XCTWaiter().wait(for: [expectation], timeout: timeout)
    }

    /// Boundedly verifies the committed username against a freshly reacquired
    /// field across all web views owned by the SafariViewService proxy. At least
    /// one owned web view and exactly one ready text field are required. The
    /// expected username remains private in memory and every normal return
    /// records one fixed result plus the common completion marker.
    func waitForCommittedUsername(
        expected: String,
        timeout: TimeInterval = 15
    ) -> Bool {
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-value-check-started")
        let deadline = Date().addingTimeInterval(timeout)
        var result: UsernameValueCheckResult = .fieldMissing
        var webViewCountCategory: OwnedWebViewCountCategory?

        repeat {
            let currentWebViews = browserHost.webViews
            let webViewCount = currentWebViews.count
            if webViewCount == 0 {
                webViewCountCategory = nil
                result = .webViewMissing
            } else {
                webViewCountCategory = ownedWebViewCountCategory(webViewCount)
                let fields = browserHost.descendants(matching: .textField)
                let fieldCount = fields.count
                if fieldCount == 0 {
                    result = .fieldMissing
                } else if fieldCount != 1 {
                    result = .fieldNonunique
                } else {
                    let field = fields.element(boundBy: 0)
                    if !field.exists || !field.isEnabled || !field.isHittable {
                        result = .fieldNotReady
                    } else if let value = field.value as? String {
                        if value == expected {
                            result = .matched
                            break
                        }
                        result = .timeoutMismatch
                    } else {
                        result = .valueUnobservable
                    }
                }
            }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline

        if let webViewCountCategory {
            recordOwnedWebViewCountCategory(webViewCountCategory)
        }
        recordUsernameValueCheckResult(result)
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-value-check-completed")
        if result == .matched {
            print("PIPOD_USERNAME_TRANSITION_STAGE=username-value-matched")
            return true
        }
        return false
    }

    private func ownedWebViewCountCategory(
        _ count: Int
    ) -> OwnedWebViewCountCategory? {
        switch count {
        case 1: return .one
        case 2: return .two
        case 3...: return .threeOrMore
        default: return nil
        }
    }

    private func recordOwnedWebViewCountCategory(
        _ category: OwnedWebViewCountCategory
    ) {
        switch category {
        case .one:
            print("PIPOD_OWNED_WEBVIEW_COUNT=webview-count-1")
        case .two:
            print("PIPOD_OWNED_WEBVIEW_COUNT=webview-count-2")
        case .threeOrMore:
            print("PIPOD_OWNED_WEBVIEW_COUNT=webview-count-3+")
        }
    }

    private func recordUsernameValueCheckResult(
        _ result: UsernameValueCheckResult
    ) {
        switch result {
        case .matched:
            print("PIPOD_USERNAME_VALUE_CHECK_RESULT=matched")
        case .timeoutMismatch:
            print("PIPOD_USERNAME_VALUE_CHECK_RESULT=timeout-mismatch")
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-value-check-timeout")
        case .webViewMissing:
            print("PIPOD_USERNAME_VALUE_CHECK_RESULT=webview-missing")
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-value-check-webview-missing")
        case .webViewNonunique:
            print("PIPOD_USERNAME_VALUE_CHECK_RESULT=webview-nonunique")
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-value-check-webview-nonunique")
        case .fieldMissing:
            print("PIPOD_USERNAME_VALUE_CHECK_RESULT=field-missing")
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-value-check-field-missing")
        case .fieldNonunique:
            print("PIPOD_USERNAME_VALUE_CHECK_RESULT=field-nonunique")
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-value-check-field-nonunique")
        case .fieldNotReady:
            print("PIPOD_USERNAME_VALUE_CHECK_RESULT=field-not-ready")
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-value-check-field-not-ready")
        case .valueUnobservable:
            print("PIPOD_USERNAME_VALUE_CHECK_RESULT=value-unobservable")
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-value-check-value-unobservable")
        }
    }

    /// Selects only exact provider controls, in deterministic priority order.
    /// A transition cannot silently fall through: missing, disabled and
    /// non-hittable shapes have separate fixed error categories.
    func waitForUsernameAdvanceControl(
        in webView: XCUIElement,
        timeout: TimeInterval = 15
    ) -> XCUIElement? {
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-exact-control-started")
        let deadline = Date().addingTimeInterval(timeout)
        var sawControl = false
        var sawEnabled = false
        repeat {
            for label in Self.exactAdvanceLabels {
                let button = webView.buttons[label]
                guard button.exists else { continue }
                sawControl = true
                guard button.isEnabled else { continue }
                sawEnabled = true
                guard button.isHittable else { continue }
                switch label {
                case "Next": print("PIPOD_USERNAME_TRANSITION_CONTROL=next")
                case "Continue": print("PIPOD_USERNAME_TRANSITION_CONTROL=continue")
                default: print("PIPOD_USERNAME_TRANSITION_CONTROL=sign-in")
                }
                print("PIPOD_USERNAME_TRANSITION_STAGE=username-exact-control-completed")
                print("PIPOD_USERNAME_TRANSITION_STAGE=exact-control-ready")
                return button
            }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline

        print("PIPOD_USERNAME_TRANSITION_ERROR=username-exact-control-timeout")
        if !sawControl {
            print("PIPOD_USERNAME_TRANSITION_ERROR=control-missing")
        } else if !sawEnabled {
            print("PIPOD_USERNAME_TRANSITION_ERROR=control-disabled")
        } else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=control-not-hittable")
        }
        return nil
    }

    /// Revalidates the already-selected exact control immediately before its
    /// tap. No label or element value is emitted.
    func usernameAdvanceControlRemainsReady(_ control: XCUIElement) -> Bool {
        guard control.exists else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=control-missing")
            return false
        }
        guard control.isEnabled else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=control-disabled")
            return false
        }
        guard control.isHittable else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=control-not-hittable")
            return false
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=exact-control-revalidated")
        return true
    }

    private func recordUsernameAdvanceTapped() {
        print("PIPOD_USERNAME_TRANSITION_STAGE=exact-control-tapped")
    }

    private func tapUsernameAdvanceAndRequireEffect(
        usernameField: XCUIElement,
        control: XCUIElement,
        budget: UsernamePhaseBudget
    ) -> Bool {
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-tap-effect-started")
        guard budget.hasTimeRemaining else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-timeout")
            return false
        }
        guard usernameAdvanceControlRemainsReady(control) else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-failed")
            return false
        }
        control.tap()
        recordUsernameAdvanceTapped()
        guard budget.hasTimeRemaining else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-timeout")
            return false
        }
        guard ensureUsernameAdvanceEffect(
            usernameField: usernameField,
            control: control,
            budget: budget
        ) else {
            return false
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=username-tap-effect-completed")
        return true
    }

    /// Requires one observable effect from the exact username advance tap.
    /// When the first five-second check has no effect, the same exact control
    /// is revalidated and tapped exactly once before one final check.
    private func ensureUsernameAdvanceEffect(
        usernameField: XCUIElement,
        control: XCUIElement,
        budget: UsernamePhaseBudget
    ) -> Bool {
        let firstTimeout = budget.timeout(maximum: 5)
        guard firstTimeout > 0 else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-timeout")
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-no-effect")
            return false
        }
        switch waitForUsernameAdvanceEffect(
            usernameField: usernameField,
            timeout: firstTimeout
        ) {
        case .effect(_):
            return true
        case .waitFailed:
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-failed")
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-no-effect")
            return false
        case .noEffect:
            print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-retry-required")
        }

        guard budget.hasTimeRemaining else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-timeout")
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-no-effect")
            return false
        }
        guard usernameAdvanceControlRemainsReadyForRetry(control) else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-failed")
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-no-effect")
            return false
        }
        control.tap()
        print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-retry-tapped")

        let secondTimeout = budget.timeout(maximum: 5)
        guard secondTimeout > 0 else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-timeout")
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-no-effect")
            return false
        }
        switch waitForUsernameAdvanceEffect(
            usernameField: usernameField,
            timeout: secondTimeout
        ) {
        case .effect(_):
            return true
        case .noEffect:
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-timeout")
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-no-effect")
            return false
        case .waitFailed:
            print("PIPOD_USERNAME_TRANSITION_ERROR=username-tap-effect-failed")
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-no-effect")
            return false
        }
    }

    private func waitForUsernameAdvanceEffect(
        usernameField: XCUIElement,
        timeout: TimeInterval
    ) -> UsernameAdvanceEffectCheckResult {
        print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-check-started")
        var observedEffect: UsernameAdvanceEffect?
        var sawWebViewGap = false
        let effectObserved = NSPredicate { _, _ in
            let usernameFieldExists = usernameField.exists
            let currentWebView = self.webView
            guard currentWebView.exists else {
                if !sawWebViewGap {
                    print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-webview-gap-seen")
                    sawWebViewGap = true
                }
                if !usernameFieldExists {
                    observedEffect = .usernameFieldGone
                    return true
                }
                return false
            }
            if sawWebViewGap {
                observedEffect = .webViewReloadObserved
                return true
            }
            if self.ownedSecureTextFields.firstMatch.exists {
                observedEffect = .passwordFieldPresent
                return true
            }
            if !usernameFieldExists {
                observedEffect = .usernameFieldGone
                return true
            }
            return false
        }
        let expectation = XCTNSPredicateExpectation(
            predicate: effectObserved,
            object: NSObject())
        let result = XCTWaiter().wait(for: [expectation], timeout: timeout)
        print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-check-completed")

        switch result {
        case .completed:
            guard let effect = observedEffect else {
                print("PIPOD_USERNAME_TRANSITION_ERROR=tap-effect-wait-failed")
                return .waitFailed
            }
            switch effect {
            case .usernameFieldGone:
                print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-username-field-gone")
            case .passwordFieldPresent:
                print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-password-field-present")
            case .webViewReloadObserved:
                print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-webview-reload-observed")
            }
            return .effect(effect)
        case .timedOut:
            print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-check-no-effect")
            return .noEffect
        default:
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-effect-wait-failed")
            return .waitFailed
        }
    }

    private func usernameAdvanceControlRemainsReadyForRetry(
        _ control: XCUIElement
    ) -> Bool {
        guard control.exists else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-effect-retry-control-missing")
            return false
        }
        guard control.isEnabled else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-effect-retry-control-disabled")
            return false
        }
        guard control.isHittable else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=tap-effect-retry-control-not-hittable")
            return false
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=tap-effect-retry-control-revalidated")
        return true
    }

    /// Boundedly follows the post-username provider surface to a ready secure
    /// password field. The SafariViewService web-view query is reacquired on
    /// every poll so an observable reload cannot strand the test on one proxy.
    /// The preceding effect check has already prevented a no-op username tap.
    /// At most one later fieldless exact-control interstitial may be advanced;
    /// a nonsecure challenge is observed but never receives the password.
    func waitForPasswordField(timeout: TimeInterval = 30) -> XCUIElement? {
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-wait-started")
        let deadline = Date().addingTimeInterval(timeout)
        var sawWebView = false
        var sawWebViewGap = false
        var recordedWebViewReacquired = false
        var recordedNonsecureForm = false
        var recordedNonsecureExactControl = false
        var recordedInterstitial = false
        var interstitialAdvanced = false
        var sawInterstitialNotReady = false
        var sawPasswordNotReady = false

        repeat {
            let currentWebViews = browserHost.webViews
            guard currentWebViews.count >= 1 else {
                if !sawWebViewGap {
                    print("PIPOD_USERNAME_TRANSITION_STAGE=password-webview-gap-seen")
                    sawWebViewGap = true
                }
                Thread.sleep(forTimeInterval: 0.1)
                continue
            }
            let currentWebView = currentWebViews.firstMatch
            guard currentWebView.exists else {
                if !sawWebViewGap {
                    print("PIPOD_USERNAME_TRANSITION_STAGE=password-webview-gap-seen")
                    sawWebViewGap = true
                }
                Thread.sleep(forTimeInterval: 0.1)
                continue
            }

            if !sawWebView {
                print("PIPOD_USERNAME_TRANSITION_STAGE=password-webview-present")
                sawWebView = true
            }
            if sawWebViewGap && !recordedWebViewReacquired {
                print("PIPOD_USERNAME_TRANSITION_STAGE=password-webview-reacquired")
                recordedWebViewReacquired = true
            }

            let passwordFields = browserHost.descendants(
                matching: .secureTextField)
            if passwordFields.count > 0 {
                if passwordFields.count == 1 {
                    let passwordField = passwordFields.element(boundBy: 0)
                    if passwordField.exists,
                       passwordField.isEnabled,
                       passwordField.isHittable {
                        print("PIPOD_USERNAME_TRANSITION_STAGE=password-field-visible-ready")
                        return passwordField
                    }
                }
                sawPasswordNotReady = true
                Thread.sleep(forTimeInterval: 0.1)
                continue
            }

            if browserHost.descendants(
                matching: .textField).firstMatch.exists {
                if !recordedNonsecureForm {
                    print("PIPOD_USERNAME_TRANSITION_STAGE=password-nonsecure-form-seen")
                    recordedNonsecureForm = true
                }
                if !recordedNonsecureExactControl,
                   hasReadyExactAdvanceControl(in: currentWebView) {
                    print("PIPOD_USERNAME_TRANSITION_STAGE=password-nonsecure-form-exact-control-seen")
                    recordedNonsecureExactControl = true
                }
                Thread.sleep(forTimeInterval: 0.1)
                continue
            }

            if !interstitialAdvanced {
                switch passwordInterstitialControl(in: currentWebView) {
                case .absent:
                    break
                case .presentNotReady:
                    if !recordedInterstitial {
                        print("PIPOD_USERNAME_TRANSITION_STAGE=password-interstitial-seen")
                        recordedInterstitial = true
                    }
                    sawInterstitialNotReady = true
                case .ready(let control):
                    if !recordedInterstitial {
                        print("PIPOD_USERNAME_TRANSITION_STAGE=password-interstitial-seen")
                        recordedInterstitial = true
                    }
                    guard passwordInterstitialControlRemainsReady(control) else {
                        print("PIPOD_USERNAME_TRANSITION_ERROR=password-field-missing")
                        return nil
                    }
                    control.tap()
                    print("PIPOD_USERNAME_TRANSITION_STAGE=password-interstitial-advanced")
                    interstitialAdvanced = true
                }
            }

            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline

        if !sawWebView {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-webview-missing")
        }
        if sawPasswordNotReady {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-field-not-ready")
        }
        if sawInterstitialNotReady && !interstitialAdvanced {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-interstitial-control-not-ready")
        }
        if interstitialAdvanced {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-interstitial-stalled")
        }
        print("PIPOD_USERNAME_TRANSITION_ERROR=password-field-missing")
        return nil
    }

    /// Pure, values-free decision used by the bounded live gate and focused
    /// GateTests. Changed masked occupancy with the expected character count
    /// is evidence of keyboard delivery, not proof of plaintext equality.
    static func passwordEntryEvidence(
        preEntryValue: String?,
        placeholderValue: String?,
        postEntryValue: String?,
        expected: String
    ) -> PasswordEntryEvidence {
        guard !expected.isEmpty else { return .mismatch }
        guard let preEntryValue else { return .unobservable }
        let knownEmptyPlaceholder = placeholderValue.map {
            !$0.isEmpty && preEntryValue == $0
        } ?? false
        guard preEntryValue.isEmpty || knownEmptyPlaceholder else {
            return .prefilled
        }
        guard let postEntryValue else { return .unobservable }
        if let placeholderValue,
           !placeholderValue.isEmpty,
           postEntryValue == placeholderValue {
            return .placeholder
        }
        guard postEntryValue != preEntryValue else { return .noChange }
        if postEntryValue == expected { return .plaintextEquality }
        if postEntryValue.count == expected.count,
           postEntryValue.allSatisfy({
               Self.safePasswordMaskCharacters.contains($0)
           }) {
            return .changedMaskedOccupancyDelivery
        }
        return .mismatch
    }

    /// Waits for the password page, then requires one current SafariViewService
    /// secure field and bounded post-entry evidence before any submit action.
    /// Accessibility values and character counts stay in memory only.
    func enterPasswordAndRequireDelivery(
        _ expected: String,
        fieldTimeout: TimeInterval = 30,
        commitTimeout: TimeInterval = 10
    ) -> PasswordEntryBoundary? {
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-started")
        guard waitForPasswordField(timeout: fieldTimeout) != nil else {
            recordPasswordEntryFailure(.unobservable)
            return nil
        }

        guard browserHost.webViews.count >= 1 else {
            recordPasswordEntryFailure(.unobservable)
            return nil
        }
        let initialFields = ownedSecureTextFields
        guard initialFields.count == 1 else {
            recordPasswordEntryFailure(.nonunique)
            return nil
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-field-unique")
        let initialField = initialFields.element(boundBy: 0)
        guard initialField.exists,
              initialField.isEnabled,
              initialField.isHittable else {
            recordPasswordEntryFailure(.notReady)
            return nil
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-field-ready")

        let placeholderValue = initialField.placeholderValue
        guard let preEntryValue = initialField.value as? String else {
            recordPasswordEntryFailure(.unobservable)
            return nil
        }
        let knownEmptyPlaceholder = placeholderValue.map {
            !$0.isEmpty && preEntryValue == $0
        } ?? false
        guard preEntryValue.isEmpty || knownEmptyPlaceholder else {
            recordPasswordEntryFailure(.prefilled)
            return nil
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-prestate-accepted")

        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-focus-started")
        initialField.tap()
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-focus-completed")

        guard browserHost.webViews.count >= 1 else {
            recordPasswordEntryFailure(.unobservable)
            return nil
        }
        let focusedFields = ownedSecureTextFields
        guard focusedFields.count == 1 else {
            recordPasswordEntryFailure(.nonunique)
            return nil
        }
        let focusedField = focusedFields.element(boundBy: 0)
        guard focusedField.exists,
              focusedField.isEnabled,
              focusedField.isHittable else {
            recordPasswordEntryFailure(.notReady)
            return nil
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-typing-started")
        focusedField.typeText(expected)
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-typing-completed")

        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-commit-check-started")
        var observedEvidence: PasswordEntryEvidence?
        var lastEvidence: PasswordEntryEvidence = .unobservable
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                guard self.browserHost.webViews.count >= 1 else {
                    lastEvidence = .unobservable
                    return false
                }
                let liveFields = self.ownedSecureTextFields
                guard liveFields.count == 1 else {
                    lastEvidence = .nonunique
                    return false
                }
                let liveField = liveFields.element(boundBy: 0)
                guard liveField.exists,
                      liveField.isEnabled,
                      liveField.isHittable else {
                    lastEvidence = .notReady
                    return false
                }
                let evidence = Self.passwordEntryEvidence(
                    preEntryValue: preEntryValue,
                    placeholderValue: placeholderValue,
                    postEntryValue: liveField.value as? String,
                    expected: expected)
                lastEvidence = evidence
                switch evidence {
                case .plaintextEquality, .changedMaskedOccupancyDelivery:
                    observedEvidence = evidence
                    return true
                default:
                    return false
                }
            },
            object: NSObject())
        let waitResult = XCTWaiter.wait(
            for: [expectation],
            timeout: commitTimeout)
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-commit-check-completed")
        guard waitResult == .completed, observedEvidence != nil else {
            if waitResult == .timedOut {
                print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-commit-timeout")
                recordPasswordEntryFailure(lastEvidence)
            } else {
                recordPasswordEntryFailure(.waitFailed)
            }
            return nil
        }

        // Re-query and revalidate the one live field before returning the
        // accepted boundary; do not rely on the element used for tap/type.
        guard browserHost.webViews.count >= 1 else {
            recordPasswordEntryFailure(.unobservable)
            return nil
        }
        let finalFields = ownedSecureTextFields
        guard finalFields.count == 1 else {
            recordPasswordEntryFailure(.nonunique)
            return nil
        }
        let finalField = finalFields.element(boundBy: 0)
        guard finalField.exists,
              finalField.isEnabled,
              finalField.isHittable else {
            recordPasswordEntryFailure(.notReady)
            return nil
        }
        let finalValue = finalField.value as? String
        let finalEvidence = Self.passwordEntryEvidence(
            preEntryValue: preEntryValue,
            placeholderValue: placeholderValue,
            postEntryValue: finalValue,
            expected: expected)
        guard finalEvidence == .plaintextEquality
                || finalEvidence == .changedMaskedOccupancyDelivery,
              let acceptedValue = finalValue else {
            recordPasswordEntryFailure(finalEvidence)
            return nil
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-live-field-revalidated")
        recordPasswordEntrySuccess(finalEvidence)
        return PasswordEntryBoundary(acceptedValue: acceptedValue)
    }

    private func recordPasswordEntrySuccess(_ evidence: PasswordEntryEvidence) {
        switch evidence {
        case .plaintextEquality:
            print("PIPOD_PASSWORD_ENTRY_RESULT=plaintext-equality")
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-plaintext-equality")
        case .changedMaskedOccupancyDelivery:
            print("PIPOD_PASSWORD_ENTRY_RESULT=changed-masked-occupancy-delivery")
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-masked-occupancy-delivery")
        default:
            print("PIPOD_PASSWORD_ENTRY_RESULT=wait-failed")
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-wait-failed")
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-completed")
    }

    private func recordPasswordEntryFailure(_ evidence: PasswordEntryEvidence) {
        switch evidence {
        case .mismatch:
            print("PIPOD_PASSWORD_ENTRY_RESULT=mismatch")
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-mismatch")
        case .unobservable:
            print("PIPOD_PASSWORD_ENTRY_RESULT=unobservable")
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-unobservable")
        case .placeholder:
            print("PIPOD_PASSWORD_ENTRY_RESULT=placeholder")
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-placeholder")
        case .noChange:
            print("PIPOD_PASSWORD_ENTRY_RESULT=no-change")
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-no-change")
        case .prefilled:
            print("PIPOD_PASSWORD_ENTRY_RESULT=prefilled")
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-prefilled")
        case .nonunique:
            print("PIPOD_PASSWORD_ENTRY_RESULT=nonunique")
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-field-nonunique")
        case .notReady:
            print("PIPOD_PASSWORD_ENTRY_RESULT=not-ready")
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-field-not-ready")
        case .waitFailed, .plaintextEquality, .changedMaskedOccupancyDelivery:
            print("PIPOD_PASSWORD_ENTRY_RESULT=wait-failed")
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-entry-wait-failed")
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-entry-completed")
    }

    /// Performs the one intentional password submission through Return. The
    /// pinned ZITADEL image's password page is a POST form containing one
    /// required password input and one enabled `button[type=submit]`; its submit
    /// listener disables only subsequent submits. HTML implicit submission
    /// therefore defines Return as a real form submit, not a dismissal trick.
    ///
    /// The accepted password boundary remains private in memory. The field is
    /// reacquired across all web views owned by the SafariViewService proxy,
    /// revalidated, deliberately focused once, and revalidated again before the
    /// sole newline input. No Next/Done/button tap or submission retry follows.
    func submitPasswordWithReturnOnce(
        after boundary: PasswordEntryBoundary
    ) -> XCUIElement? {
        guard let passwordField = revalidateUnchangedPasswordBoundary(
            boundary,
            phase: .preFocus) else {
            return nil
        }

        print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-focus-started")
        passwordField.tap()
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-focus-completed")

        guard let focusedPasswordField = revalidateUnchangedPasswordBoundary(
            boundary,
            phase: .postFocus) else {
            return nil
        }

        print("PIPOD_PASSWORD_ENTER_ACTION=return")
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-action-started")
        focusedPasswordField.typeText("\n")
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-action-completed")
        return focusedPasswordField
    }

    private func revalidateUnchangedPasswordBoundary(
        _ boundary: PasswordEntryBoundary,
        phase: PasswordEnterRevalidationPhase
    ) -> XCUIElement? {
        recordPasswordEnterRevalidationStage(phase, stage: .started)
        let currentWebViews = browserHost.webViews
        let webViewCount = currentWebViews.count
        guard webViewCount >= 1 else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-enter-webview-nonunique")
            recordPasswordEnterRevalidationStage(phase, stage: .completed)
            return nil
        }
        if let webViewCountCategory = ownedWebViewCountCategory(webViewCount) {
            recordOwnedWebViewCountCategory(webViewCountCategory)
        }
        let currentWebView = currentWebViews.element(boundBy: 0)
        guard currentWebView.exists else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-enter-webview-not-ready")
            recordPasswordEnterRevalidationStage(phase, stage: .completed)
            return nil
        }
        recordPasswordEnterRevalidationStage(phase, stage: .webViewOwned)

        let liveFields = browserHost.descendants(
            matching: .secureTextField)
        guard liveFields.count == 1 else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-enter-field-nonunique")
            recordPasswordEnterRevalidationStage(phase, stage: .completed)
            return nil
        }
        recordPasswordEnterRevalidationStage(phase, stage: .fieldUnique)
        let liveField = liveFields.element(boundBy: 0)
        guard liveField.exists,
              liveField.isEnabled,
              liveField.isHittable else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-enter-field-not-ready")
            recordPasswordEnterRevalidationStage(phase, stage: .completed)
            return nil
        }
        recordPasswordEnterRevalidationStage(phase, stage: .fieldReady)
        guard let liveValue = liveField.value as? String else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-enter-boundary-unobservable")
            recordPasswordEnterRevalidationStage(phase, stage: .completed)
            return nil
        }
        guard liveValue == boundary.acceptedValue else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-enter-boundary-changed")
            recordPasswordEnterRevalidationStage(phase, stage: .completed)
            return nil
        }
        recordPasswordEnterRevalidationStage(
            phase,
            stage: .boundaryUnchanged)
        recordPasswordEnterRevalidationStage(phase, stage: .completed)
        return liveField
    }

    private func recordPasswordEnterRevalidationStage(
        _ phase: PasswordEnterRevalidationPhase,
        stage: PasswordEnterRevalidationStage
    ) {
        switch (phase, stage) {
        case (.preFocus, .started):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-precheck-started")
        case (.preFocus, .webViewOwned):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-precheck-webview-owned")
        case (.preFocus, .fieldUnique):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-precheck-field-unique")
        case (.preFocus, .fieldReady):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-precheck-field-ready")
        case (.preFocus, .boundaryUnchanged):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-precheck-boundary-unchanged")
        case (.preFocus, .completed):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-precheck-completed")
        case (.postFocus, .started):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-postfocus-started")
        case (.postFocus, .webViewOwned):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-postfocus-webview-owned")
        case (.postFocus, .fieldUnique):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-postfocus-field-unique")
        case (.postFocus, .fieldReady):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-postfocus-field-ready")
        case (.postFocus, .boundaryUnchanged):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-postfocus-boundary-unchanged")
        case (.postFocus, .completed):
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-postfocus-completed")
        }
    }

    private func hasReadyExactAdvanceControl(in webView: XCUIElement) -> Bool {
        for label in Self.exactAdvanceLabels {
            let button = webView.buttons[label]
            if button.exists, button.isEnabled, button.isHittable {
                return true
            }
        }
        return false
    }

    private func passwordInterstitialControl(
        in webView: XCUIElement
    ) -> PasswordInterstitialControlObservation {
        var sawControl = false
        for label in Self.exactAdvanceLabels {
            let button = webView.buttons[label]
            guard button.exists else { continue }
            sawControl = true
            guard button.isEnabled, button.isHittable else { continue }
            switch label {
            case "Next": print("PIPOD_PASSWORD_INTERSTITIAL_CONTROL=next")
            case "Continue": print("PIPOD_PASSWORD_INTERSTITIAL_CONTROL=continue")
            default: print("PIPOD_PASSWORD_INTERSTITIAL_CONTROL=sign-in")
            }
            return .ready(button)
        }
        return sawControl ? .presentNotReady : .absent
    }

    private func passwordInterstitialControlRemainsReady(
        _ control: XCUIElement
    ) -> Bool {
        guard control.exists else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-interstitial-control-missing")
            return false
        }
        guard control.isEnabled else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-interstitial-control-disabled")
            return false
        }
        guard control.isHittable else {
            print("PIPOD_USERNAME_TRANSITION_ERROR=password-interstitial-control-not-hittable")
            return false
        }
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-interstitial-control-revalidated")
        return true
    }

    /// Observes one bounded structural page-change effect after the sole Return
    /// action. This is diagnostic only: it is not auth acceptance, and timeout
    /// never causes a second Return or any control tap.
    func observeSinglePasswordEnterEffect(
        passwordField: XCUIElement,
        timeout: TimeInterval = 5
    ) {
        _ = waitForPasswordEnterEffect(
            passwordField: passwordField,
            timeout: timeout)
    }

    private func waitForPasswordEnterEffect(
        passwordField: XCUIElement,
        timeout: TimeInterval
    ) -> PasswordEnterEffectCheckResult {
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-effect-check-started")
        var observedEffect: PasswordEnterEffect?
        let effectObserved = NSPredicate { _, _ in
            if !self.webView.exists {
                observedEffect = .callbackBoundary
                return true
            }
            if !passwordField.exists {
                observedEffect = .passwordFieldGone
                return true
            }
            return false
        }
        let expectation = XCTNSPredicateExpectation(
            predicate: effectObserved,
            object: NSObject())
        let result = XCTWaiter().wait(for: [expectation], timeout: timeout)
        print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-effect-check-completed")

        switch result {
        case .completed:
            guard let effect = observedEffect else {
                print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-effect-wait-failed")
                return .waitFailed
            }
            switch effect {
            case .passwordFieldGone:
                print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-effect-password-field-gone")
            case .callbackBoundary:
                print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-effect-callback-boundary")
            }
            return .effect(effect)
        case .timedOut:
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-effect-unobserved")
            return .noEffect
        default:
            print("PIPOD_USERNAME_TRANSITION_STAGE=password-enter-effect-wait-failed")
            return .waitFailed
        }
    }

    /// Treats the exact Pods navigation bar in the app process as authoritative
    /// callback completion. SafariViewService is a separate process whose web
    /// view can remain visible to XCTest after ASWebAuthenticationSession has
    /// already completed in the app; its disappearance is diagnostic only.
    /// Valid sequences are direct Pods visibility or browser disappearance then
    /// Pods. Browser disappearance alone never satisfies this boundary.
    func waitForAuthCallback(
        podsNavigationBar: XCUIElement,
        timeout: TimeInterval = 120
    ) -> Bool {
        print("PIPOD_USERNAME_TRANSITION_STAGE=callback-wait-started")
        var browserDisappeared = false
        let podsAuthenticated = NSPredicate { _, _ in
            if podsNavigationBar.exists { return true }
            if !self.webView.exists, !browserDisappeared {
                browserDisappeared = true
                print("PIPOD_USERNAME_TRANSITION_STAGE=callback-browser-disappeared")
            }
            return false
        }
        let expectation = XCTNSPredicateExpectation(
            predicate: podsAuthenticated,
            object: NSObject())
        let result = XCTWaiter().wait(for: [expectation], timeout: timeout)
        switch result {
        case .completed:
            if browserDisappeared {
                print("PIPOD_CALLBACK_OBSERVATION=browser-disappeared-then-pods")
            } else {
                print("PIPOD_CALLBACK_OBSERVATION=pods-direct")
            }
            print("PIPOD_USERNAME_TRANSITION_STAGE=callback-pods-authoritative")
            print("PIPOD_USERNAME_TRANSITION_STAGE=callback-received")
            print("PIPOD_USERNAME_TRANSITION_STAGE=callback-wait-completed")
            return true
        case .timedOut:
            if browserDisappeared {
                print("PIPOD_CALLBACK_OBSERVATION=timeout-after-browser-disappeared")
            } else {
                print("PIPOD_CALLBACK_OBSERVATION=timeout-browser-present")
            }
            print("PIPOD_USERNAME_TRANSITION_ERROR=callback-wait-timeout")
            return false
        default:
            print("PIPOD_CALLBACK_OBSERVATION=wait-failed")
            print("PIPOD_USERNAME_TRANSITION_ERROR=callback-wait-failed")
            return false
        }
    }

    /// Waits only for the fixed authenticated Pods navigation-bar query.
    func waitForPodsLanding(
        _ podsNavigationBar: XCUIElement,
        timeout: TimeInterval = 30
    ) -> Bool {
        print("PIPOD_USERNAME_TRANSITION_STAGE=pods-wait-started")
        let podsVisible = NSPredicate { _, _ in
            podsNavigationBar.exists
        }
        let expectation = XCTNSPredicateExpectation(
            predicate: podsVisible,
            object: NSObject())
        let result = XCTWaiter().wait(for: [expectation], timeout: timeout)
        switch result {
        case .completed:
            print("PIPOD_USERNAME_TRANSITION_STAGE=pods-visible-ready")
            print("PIPOD_PODS_ASSERTION_RESULT=success")
            return true
        case .timedOut:
            print("PIPOD_USERNAME_TRANSITION_ERROR=pods-wait-timeout")
            print("PIPOD_PODS_ASSERTION_RESULT=failure")
            return false
        default:
            print("PIPOD_USERNAME_TRANSITION_ERROR=pods-wait-failed")
            print("PIPOD_PODS_ASSERTION_RESULT=failure")
            return false
        }
    }

    /// Accept the normal ASWebAuthenticationSession consent prompt when shown.
    /// An alert with any shape other than the fixed Cancel/Continue pair fails
    /// closed. Absence is allowed only for a previously consented live flow.
    @discardableResult
    func acceptConsentIfPresented(
        required: Bool = false,
        timeout: TimeInterval = 15,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> Bool {
        let alert = consentHost.alerts.firstMatch
        guard alert.waitForExistence(timeout: timeout) else {
            if required {
                XCTFail("system auth consent presented", file: file, line: line)
            }
            return false
        }

        let cancel = alert.buttons["Cancel"]
        let proceed = alert.buttons["Continue"]
        guard cancel.waitForExistence(timeout: 2),
              proceed.waitForExistence(timeout: 2) else {
            XCTFail("system auth consent shape recognized", file: file, line: line)
            return false
        }
        proceed.tap()
        return true
    }
}
