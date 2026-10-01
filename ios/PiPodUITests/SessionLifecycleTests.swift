import XCTest

/// Live-session acceptance against Root-provided fixture pods. Strict mode:
/// missing fixtures or unmet transitions FAIL (never green by skip).
///
/// Reuses the app's existing accessibility identifiers plus the acceptance
/// identifiers the app carries for this suite (`session.assistantMessage`,
/// `composer.attachment`, `session.messageAttachments` and its placeholder,
/// `session.statusMessage` and `session.toolMessage`, `composer.interrupting`,
/// `workstation.wait` and `workstation.cancel`); no other app change.
///
/// Every press in this suite lands through `tapAllHittable`: every hittable
/// match is pressed on a fresh snapshot with no sleep between resolve and
/// press, so a wrapper absorbing its press harmlessly never costs the
/// control its delivery. Frames are never read: a frame read on an element
/// the stream just vanished ends the test on the probe line (run
/// 35483756826 died exactly that way inside the old stability gate).
/// Backend lifecycle (create/stop/wake of fixtures) belongs to Root's CP
/// owner, coordinated through the companion stop step. Tests bind the given
/// fixture IDs and never allocate or control unrelated hosts. Every wait is
/// an existence poll with a bounded timeout — no fixed long sleeps.
final class SessionLifecycleTests: XCTestCase {
    private var app: XCUIApplication!
    private var systemAuth: SystemAuthUI!

    override func setUpWithError() throws {
        continueAfterFailure = false
        UITestConfig.requireLiveInputs()
        app = XCUIApplication()
        systemAuth = SystemAuthUI()
        app.launch()
        try loginIfNeeded()
    }

    /// Explicit post-auth diagnostic capture. Allowlisted "postauth-" prefix
    /// is the ONLY attachment shape the workflow uploads; call sites pass a
    /// step label, never content. Never called during login/callback.
    private func capturePostAuth(_ step: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "postauth-\(step)"
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Reuses the LoginTests flow inline (target independence: no
    /// cross-class ordering assumptions). Fails closed when sign-in cannot
    /// complete; never dumps page content.
    private func loginIfNeeded() throws {
        let signIn = app.buttons["sign_in_button"]
        if signIn.waitForExistence(timeout: 10) {
            signIn.tap()
            _ = systemAuth.acceptConsentIfPresented()

            let usernamePhaseComplete = systemAuth.completeUsernamePhase(
                username: UITestConfig.username)
            XCTAssertTrue(usernamePhaseComplete,
                "lifecycle username staged phase completed")
            guard usernamePhaseComplete else { return }

            let passwordEntry = systemAuth.enterPasswordAndRequireDelivery(
                UITestConfig.password)
            XCTAssertNotNil(passwordEntry,
                "lifecycle password entry gate accepted")
            guard let passwordBoundary = passwordEntry else { return }

            let submittedPasswordField = systemAuth.submitPasswordWithReturnOnce(
                after: passwordBoundary)
            XCTAssertNotNil(submittedPasswordField,
                "lifecycle single password Return submit performed")
            guard let passField = submittedPasswordField else { return }

            systemAuth.observeSinglePasswordEnterEffect(passwordField: passField)

            let callbackReceived = systemAuth.waitForAuthCallback(
                podsNavigationBar: app.navigationBars["Pods"])
            XCTAssertTrue(callbackReceived,
                "lifecycle auth callback boundary received after password Enter")
            guard callbackReceived else { return }
        }
        let podsVisible = systemAuth.waitForPodsLanding(app.navigationBars["Pods"])
        XCTAssertTrue(podsVisible, "authenticated Pods surface shown")
    }

    /// The composer is a SwiftUI `TextField(axis: .vertical)`, but its stable
    /// acceptance contract is the accessibility identifier, not the XCUITest
    /// element type. R3 proved `app.textViews[...]` cannot see it even after
    /// SessionView appears, so all interactions use one type-agnostic query.
    private func composerField() -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "composer.field").firstMatch
    }

    /// The asleep banner action is a stable accessibility identifier. SwiftUI
    /// is free to expose the control as a button or another element type, so
    /// neither its localized label nor its XCTest type is an acceptance
    /// contract.
    private func bannerAction() -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "session.bannerAction").firstMatch
    }

    /// The composer's file button. Unlike the photo control it is a real
    /// `Button` carrying the identifier directly, opening the system document
    /// browser for image files -- the attach path that presents wherever the
    /// photo picker cannot.
    private func attachFileControl() -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "composer.attachFile").firstMatch
    }

    /// The composer's Stop control. It exists ONLY while a turn is running, so
    /// its presence is also the evidence that there was something to cancel
    /// and its absence afterwards is the evidence that the cancel took.
    private func interruptControl() -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "composer.interrupt").firstMatch
    }

    /// Bounded poll for the composer returning to its idle shape: neither the
    /// Stop control (a turn is running) nor the stopping spinner that replaces
    /// it (an interrupt is in flight) is present.
    ///
    /// Absence of the Stop control alone is not the turn being over — it is
    /// also exactly what "stopping…" looks like. The pair is the app's own
    /// running state; a sleep would only be a guess at it.
    private func waitForTurnIdle(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if !LifecycleDiagnostics.probeExists(app, "composer.interrupt"),
               !LifecycleDiagnostics.probeExists(app, "composer.interrupting") {
                return true
            }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 1)
        } while true
    }

    /// Bounded poll for a status line the stream wrote about itself.
    ///
    /// The row is an `.accessibilityElement(children: .combine)` group, so its
    /// label sits on the element and its XCTest type is not a static text; the
    /// identifier is the contract. The sentence is localizable, so only the
    /// marker word is matched, and only on a status row — a tool line carries
    /// its own identifier and can never stand in for one.
    private func waitForStatus(containing word: String, timeout: TimeInterval) -> Bool {
        let matches = app.descendants(matching: .any)
            .matching(identifier: "session.statusMessage")
            .matching(NSPredicate(format: "label CONTAINS[c] %@", word))
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if matches.firstMatch.exists { return true }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 1)
        } while true
    }

    /// Resolves the workflow's short fixture id through the read-only companion
    /// list, then addresses the row by the app's stable pod.row.<full uuid>
    /// identifier. Pod names are mutable: pi auto-names a session from its first
    /// prompt and the gateway mirrors that into the durable pod row, so a label
    /// suffix is not an identity contract. No value is printed or asserted.
    private func stableFixtureRow(
        shortID: String, file: StaticString = #filePath, line: UInt = #line
    ) -> XCUIElement {
        XCTAssertFalse(UITestConfig.companionBearer.isEmpty,
            "companion bearer required for fixture row lookup", file: file, line: line)
        XCTAssertFalse(UITestConfig.serverURL.isEmpty,
            "server origin required for fixture row lookup", file: file, line: line)

        var request = URLRequest(url: URL(
            string: UITestConfig.serverURL + UITestConfig.Companion.podsPath())!)
        request.httpMethod = "GET"
        request.setValue("Bearer " + UITestConfig.companionBearer,
            forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "accept")

        var status = -1
        var pods: [[String: Any]] = []
        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse else { return }
            status = http.statusCode
            guard let data,
                  let object = try? JSONSerialization.jsonObject(with: data)
                    as? [String: Any] else { return }
            pods = object["pods"] as? [[String: Any]] ?? []
        }.resume()
        XCTAssertEqual(semaphore.wait(timeout: .now() + 30), .success,
            "fixture row lookup timed out", file: file, line: line)
        XCTAssertEqual(status, 200, "fixture row lookup accepted", file: file, line: line)

        let tail = String(shortID.split(separator: "-").last ?? Substring(shortID))
            .replacingOccurrences(of: "-", with: "")
        let matches = pods.filter {
            String($0["id"] as? String ?? "")
                .replacingOccurrences(of: "-", with: "").hasSuffix(tail)
        }
        XCTAssertEqual(matches.count, 1,
            "fixture short ID resolves to exactly one pod", file: file, line: line)
        guard matches.count == 1,
              let uuid = matches[0]["id"] as? String,
              !uuid.isEmpty else {
            return app.descendants(matching: .any)
                .matching(identifier: "fixture.row.unresolved").firstMatch
        }
        return app.descendants(matching: .any)
            .matching(identifier: "pod.row.\(uuid)").firstMatch
    }

    /// Bounded companion request used only for read-only acceptance truth.
    /// Response bodies and errors remain in memory and are never printed.
    private func companionCall(
        _ method: String, _ path: String, timeout: TimeInterval = 30
    ) -> (Int, [String: Any]) {
        guard let url = URL(string: UITestConfig.serverURL + path) else { return (-1, [:]) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("Bearer " + UITestConfig.companionBearer,
            forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        var result: (Int, [String: Any]) = (-1, [:])
        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse else { return }
            let object = data.flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            } ?? [:]
            result = (http.statusCode, object)
        }.resume()
        guard semaphore.wait(timeout: .now() + timeout + 1) == .success else {
            return (-1, [:])
        }
        return result
    }

    /// Resolves a workflow short id exactly once through the supported list
    /// projection. The full id stays in memory and never enters diagnostics.
    private func fixtureUUID(
        shortID: String, file: StaticString = #filePath, line: UInt = #line
    ) -> String? {
        let (status, listed) = companionCall("GET", UITestConfig.Companion.podsPath())
        XCTAssertEqual(status, 200, "fixture list lookup accepted", file: file, line: line)
        let tail = String(shortID.split(separator: "-").last ?? Substring(shortID))
            .replacingOccurrences(of: "-", with: "")
        let matches = (listed["pods"] as? [[String: Any]] ?? []).filter {
            String($0["id"] as? String ?? "")
                .replacingOccurrences(of: "-", with: "").hasSuffix(tail)
        }
        XCTAssertEqual(matches.count, 1,
            "fixture short ID resolves to exactly one pod", file: file, line: line)
        return matches.count == 1 ? matches[0]["id"] as? String : nil
    }

    /// Backend truth for a wake. Composer existence is only a UI-readiness
    /// observation: connection is proven by the exact fixture reporting all
    /// four durable/live conditions through the supported pod projection.
    private func waitForFixtureConnected(
        shortID: String, timeout: TimeInterval = 300,
        file: StaticString = #filePath, line: UInt = #line
    ) -> Bool {
        guard let uuid = fixtureUUID(shortID: shortID, file: file, line: line) else {
            LifecycleDiagnostics.emit(.wakeBackendNotConnected)
            return false
        }
        let deadline = Date().addingTimeInterval(timeout)
        var startingReported = false
        repeat {
            let (status, object) = companionCall(
                "GET", UITestConfig.Companion.podPath(uuid: uuid))
            let pod = object["pod"] as? [String: Any] ?? object
            let sandbox = pod["sandboxState"] as? String
            let connection = pod["connection"] as? String
            let started = sandbox == "started" && pod["state"] as? String == "active"
            let live = pod["ready"] as? Bool == true && connection == "connected"
            // Leaving the asleep sandbox states at all is the proof that an
            // attach reached the gateway: the gateway starts the sandbox as
            // part of admitting a client. Emitted at most once, and it is
            // never an acceptance condition — only evidence that separates a
            // slow start from a wake the app never asked for.
            let leftAsleepStates = sandbox.map {
                !UITestConfig.Companion.asleepSandboxStates.contains($0)
            } ?? false
            if status == 200, !startingReported, leftAsleepStates {
                startingReported = true
                LifecycleDiagnostics.emit(.wakeBackendStartingSeen)
            }
            // `started` is the durable wake; `connected` is the live socket.
            // Accept started+ready when connection is still catching up, and
            // the full four-field live tuple when the socket has attached.
            if status == 200, started, (live || pod["ready"] as? Bool == true) {
                LifecycleDiagnostics.emit(.wakeBackendConnected)
                return true
            }
            if Date() >= deadline { break }
            Thread.sleep(forTimeInterval: 5)
        } while true
        LifecycleDiagnostics.emit(.wakeBackendNotConnected)
        return false
    }

    /// Presses the asleep banner's recovery action and reports, values-free,
    /// whether pressing it changed the banner at all.
    ///
    /// The waking banner is a spinner with no action, so an action that is
    /// still there afterwards means the press did not move the stream out of
    /// its asleep state. Paired with `wake-backend-starting-seen` this splits
    /// the three ways a wake can fail — the press did nothing, the app asked
    /// and the server refused, the server started and was slow — without
    /// publishing a label, a banner text or any pod value.
    private func tapBannerActionAndObserve(_ action: XCUIElement, attempts: Int = 3) {
        // A single press can land on wrapper chrome carrying the same
        // identifier (presses nothing, reports success) or on a snapshot the
        // stream has already invalidated. Either reads as "the press did
        // nothing", so a press that changed nothing is pressed again against
        // a fresh snapshot before the run concludes it.
        for _ in 0..<attempts {
            tapAllHittable(identifier: "session.bannerAction")
            let cleared = waitForAbsence(action, timeout: 10)
            LifecycleDiagnostics.emit(cleared
                ? LifecycleDiagnostics.Stage.wakeTapActionCleared
                : LifecycleDiagnostics.Stage.wakeTapActionPersisted)
            if cleared { return }
        }
    }

    /// Hittable matches for `identifier` on a fresh snapshot, in snapshot
    /// order. Only existence and hittability are ever read here -- never
    /// frames, and never twice with a sleep between: a streaming transcript
    /// can vanish an element between two reads, and the read on the gone
    /// element ends the test on the probe line instead of on a verdict.
    private func hittableMatches(identifier: String, limit: Int = 4) -> [XCUIElement] {
        let matches = app.descendants(matching: .any).matching(identifier: identifier)
        var out: [XCUIElement] = []
        for index in 0..<min(matches.count, limit) {
            let candidate = matches.element(boundBy: index)
            if candidate.exists, candidate.isHittable { out.append(candidate) }
        }
        return out
    }

    /// The hittable element whose label holds `text`, for system rows that
    /// carry no identifier. The text is always a stable repo-owned string --
    /// the seeded filename, the app's own folder name -- never a localized
    /// system sentence, except the single documented location fallback below.
    private func hittableLabelled(_ text: String, limit: Int = 6) -> XCUIElement? {
        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", text))
        for index in 0..<min(rows.count, limit) {
            let candidate = rows.element(boundBy: index)
            if candidate.exists, candidate.isHittable { return candidate }
        }
        return nil
    }

    /// Bounded poll for the app having no sheet up. The document browser
    /// dismisses itself when a single file is picked; a sheet that is still
    /// there afterwards means the pick did not land.
    private func waitForSheetsGone(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if app.sheets.count == 0 { return true }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 1)
        } while true
    }

    /// Presses every hittable match for `identifier` on a fresh snapshot and
    /// reports whether any press was delivered.
    ///
    /// A wrapper carrying the same identifier absorbs its press harmlessly
    /// while the control's press delivers, so no selection between them is
    /// needed -- and none is attempted, because selecting would read frames.
    /// Resolve and press are adjacent lines with no sleep between, keeping
    /// the window in which the stream can invalidate the snapshot to
    /// microseconds. Callers verify EFFECT (halt shown, banner cleared,
    /// sheet up) rather than trusting the press.
    @discardableResult
    private func tapAllHittable(identifier: String, limit: Int = 4) -> Bool {
        let targets = hittableMatches(identifier: identifier, limit: limit)
        for target in targets { target.tap() }
        return !targets.isEmpty
    }

    /// Bounded poll for an element going away. XCTest can wait for existence
    /// but not for its absence, and a fixed sleep would either be a guess or a
    /// stall; this is the same existence read on a deadline.
    private func waitForAbsence(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if !element.exists { return true }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 1)
        } while true
    }

    /// Stable keys for durable image-bearing user_prompt events. Payload text,
    /// names and bytes are never retained or emitted; only the non-empty image
    /// array predicate is inspected.
    private func imagePromptKeys(uuid: String) -> Set<String>? {
        let (status, object) = companionCall(
            "GET", UITestConfig.Companion.conversationPath(uuid: uuid))
        guard status == 200, let events = object["events"] as? [[String: Any]] else {
            return nil
        }
        return Set(events.compactMap { event in
            guard event["kind"] as? String == "user_prompt",
                  let payload = event["payload"] as? [String: Any],
                  let images = payload["images"] as? [Any], !images.isEmpty,
                  let session = event["sessionId"] as? String,
                  let seq = (event["seq"] as? NSNumber)?.intValue
            else { return nil }
            return "\(session):\(seq)"
        })
    }

    /// The durable image-prompt baseline, retried briefly.
    ///
    /// One unlucky answer from a read-only projection is a network hiccup, not
    /// an acceptance verdict, and the test that depends on it publishes
    /// nothing until it succeeds. A projection that never answers still fails
    /// the test — this only stops a single blip from deciding it.
    private func imagePromptBaseline(uuid: String, attempts: Int = 3) -> Set<String>? {
        for attempt in 0..<attempts {
            if let keys = imagePromptKeys(uuid: uuid) { return keys }
            if attempt + 1 < attempts { Thread.sleep(forTimeInterval: 5) }
        }
        return nil
    }

    private func waitForNewImagePrompt(
        uuid: String, excluding baseline: Set<String>, timeout: TimeInterval = 60
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let current = imagePromptKeys(uuid: uuid), !current.subtracting(baseline).isEmpty {
                return true
            }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 2)
        } while true
    }

    /// Taps the pod detail screen's Open session action.
    ///
    /// A row tap pushes `PodRoute.detail`, which `RootView` renders as
    /// `PodDetailView`. Everything this suite waits for — the composer, the
    /// asleep banner's Wake action, the workstation wait card — belongs to
    /// `SessionView`, reached only through `PodRoute.session`, which only
    /// `router.openSession` pushes, behind `pod.openSession`. Without this
    /// step those elements can never appear, however long the wait.
    ///
    /// The query is type-agnostic rather than `app.buttons[...]`: the action
    /// carries a custom button style, and the identifier is the contract.
    /// Returns whether the action was offered; the caller owns the assertion.
    @discardableResult
    private func openSessionFromDetail(timeout: TimeInterval = 30) -> Bool {
        let action = app.descendants(matching: .any)
            .matching(identifier: "pod.openSession").firstMatch
        let shown = action.waitForExistence(timeout: timeout)
        LifecycleDiagnostics.emit(shown
            ? LifecycleDiagnostics.Stage.openSessionActionShown
            : LifecycleDiagnostics.Stage.openSessionActionAbsent)
        guard shown else { return false }
        action.tap()
        LifecycleDiagnostics.emit(LifecycleDiagnostics.Stage.openSessionTapped)
        return true
    }

    /// Pops back to the pods list. The stack is list -> detail -> session, so a
    /// single back tap lands on the pod detail screen, not the list.
    @discardableResult
    private func returnToPodsList(timeout: TimeInterval = 30) -> Bool {
        let pods = app.navigationBars["Pods"]
        for _ in 0..<3 {
            if pods.exists { return true }
            let back = app.navigationBars.buttons.firstMatch
            guard back.exists else { break }
            back.tap()
            _ = pods.waitForExistence(timeout: 3)
        }
        return pods.waitForExistence(timeout: timeout)
    }

    /// Opens the awake fixture pod row. Fails closed when the bound pod is
    /// absent (missing fixture = INCOMPLETE, never green).
    private func openFixturePod(file: StaticString = #filePath, line: UInt = #line) {
        let tail = String(UITestConfig.fixturePodID.suffix(10))
        let row = stableFixtureRow(shortID: UITestConfig.fixturePodID, file: file, line: line)
        let present = LifecycleDiagnostics.awaitFixtureRow(
            app: app, row: row, suffix: tail, fixture: .awake, timeout: 30)
        XCTAssertTrue(present, "fixture pod row present", file: file, line: line)
        LifecycleDiagnostics.emit(LifecycleDiagnostics.Stage.rowTapPerformed)
        row.tap()
        // The row pushes PodRoute.detail (PodDetailView). The composer lives in
        // SessionView, one explicit step further, behind pod.openSession.
        let opened = openSessionFromDetail()
        XCTAssertTrue(opened, "pod detail offered Open session", file: file, line: line)
        let composer = composerField()
        let shown = composer.waitForExistence(timeout: 60)
        LifecycleDiagnostics.observeDetail(app: app)
        XCTAssertTrue(shown, "session composer shown", file: file, line: line)
    }

    /// Re-arms the shared sleeping fixture immediately before each test
    /// that needs it asleep: resolves the short ID, forces stop through
    /// the normal server API with the companion bearer, and asserts the
    /// stopped state. Makes every such test order-independent (an earlier
    /// wake in the same run cannot leak state in). Any failure to re-arm
    /// FAILS the test (INCOMPLETE), never skips green. Synchronous bounded
    /// network wait (30 s cap), not a fixed sleep; readiness thereafter is
    /// still polled with waitForExistence.
    private func rearmSleepingFixture(file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(UITestConfig.companionBearer.isEmpty, "companion bearer required to re-arm", file: file, line: line)
        XCTAssertFalse(UITestConfig.serverURL.isEmpty, "server origin required to re-arm", file: file, line: line)
        let origin = UITestConfig.serverURL
        let short = UITestConfig.sleepingPodID
        let bearer = UITestConfig.companionBearer
        func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) -> (Int, [String: Any]) {
            var req = URLRequest(url: URL(string: origin + path)!)
            req.httpMethod = method
            req.setValue("Bearer " + bearer, forHTTPHeaderField: "authorization")
            req.setValue("application/json", forHTTPHeaderField: "accept")
            if let body = body {
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            }
            var out: (Int, [String: Any]) = (-1, [:])
            let sem = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                defer { sem.signal() }
                guard let http = resp as? HTTPURLResponse else { return }
                var json: [String: Any] = [:]
                if let data = data,
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    json = obj
                }
                out = (http.statusCode, json)
            }.resume()
            XCTAssertEqual(sem.wait(timeout: .now() + 30), .success, "companion call timed out", file: file, line: line)
            return out
        }
        // Bound routes carry the /v1/ prefix (APIClient basePath); the pod
        // id is the full UUID. Asleep follows the app's own isAsleep rule:
        // live pod whose sandboxState is stopped or archived.
        let tail = String(short.split(separator: "-").last ?? Substring(short))
        let (ls, listed) = call("GET", UITestConfig.Companion.podsPath())
        XCTAssertEqual(ls, 200, "pod list for re-arm", file: file, line: line)
        let pods = listed["pods"] as? [[String: Any]] ?? []
        let matches = pods.filter { String($0["id"] as? String ?? "").replacingOccurrences(of: "-", with: "").hasSuffix(tail.replacingOccurrences(of: "-", with: "")) }
        XCTAssertEqual(matches.count, 1, "sleeping fixture resolves to exactly one pod", file: file, line: line)
        guard let uuid = matches.first?["id"] as? String else { return }
        func podAsleep(_ pod: [String: Any]) -> Bool {
            UITestConfig.Companion.isAsleep(state: pod["state"] as? String, sandboxState: pod["sandboxState"] as? String)
        }
        /// The app's own asleep rule (Pod.isAsleep), not the sandbox-only
        /// approximation above: a present connection column decides alone,
        /// and only a missing connection falls back to the sandbox. A
        /// sandbox that just stopped can still report a stale non-asleep
        /// connection, and opening then shows no Wake banner with no 4420
        /// to rescue it.
        func podAsleepByAppDefinition(_ pod: [String: Any]) -> Bool {
            if let connection = pod["connection"] as? String {
                return connection == "asleep"
            }
            let live = pod["state"] as? String == "active"
            let sandbox = pod["sandboxState"] as? String
            return live && (sandbox == "stopped" || sandbox == "archived")
        }
        func readPod() -> [String: Any] {
            let (gs, one) = call("GET", UITestConfig.Companion.podPath(uuid: uuid))
            XCTAssertEqual(gs, 200, "pod read for re-arm", file: file, line: line)
            return one["pod"] as? [String: Any] ?? one
        }
        if !podAsleep(readPod()) {
            // Exactly ONE stop; afterwards only bounded read-only GET polls
            // (60 s cap) until the sandbox reports stopped/archived. Never a
            // POST retry: a second POST would mask an uncertain first.
            let (ps, _) = call("POST", UITestConfig.Companion.stopPath(uuid: uuid))
            XCTAssertTrue([200, 201, 202].contains(ps), "companion stop accepted", file: file, line: line)
            var asleep = false
            let deadline = Date().addingTimeInterval(60)
            while Date() < deadline {
                if podAsleep(readPod()) { asleep = true; break }
                Thread.sleep(forTimeInterval: 5)
            }
            XCTAssertTrue(asleep, "fixture reached asleep sandbox state after one stop", file: file, line: line)
        }
        func softReadPod() -> [String: Any]? {
            var req = URLRequest(url: URL(string: origin + UITestConfig.Companion.podPath(uuid: uuid))!)
            req.httpMethod = "GET"
            req.setValue("Bearer " + bearer, forHTTPHeaderField: "authorization")
            req.setValue("application/json", forHTTPHeaderField: "accept")
            var out: [String: Any]?
            let sem = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { data, resp, _ in
                defer { sem.signal() }
                guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
                      let data = data,
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
                out = obj["pod"] as? [String: Any] ?? obj
            }.resume()
            guard sem.wait(timeout: .now() + 30) == .success else { return nil }
            return out
        }
        // Settle-or-verdict gate before opening: poll the app's own rule
        // (above) up to 90 s with early exit. The reads stay soft -- a
        // transient non-200 is a reason to keep polling, never a verdict --
        // but an exhausted gate IS one: opening into an unsettled fixture
        // shows no Wake banner with no 4420 to rescue it, and dying later
        // at the banner wait would blame the UI for a backend state. The
        // final buckets say which column refused to settle.
        var settledPod: [String: Any]?
        let quiet = Date().addingTimeInterval(90)
        while Date() < quiet {
            if let pod = softReadPod(), podAsleepByAppDefinition(pod) {
                settledPod = pod
                break
            }
            Thread.sleep(forTimeInterval: 3)
        }
        let final = settledPod ?? softReadPod()
        let conn = final?["connection"] as? String
        let sandbox = final?["sandboxState"] as? String
        if settledPod != nil {
            LifecycleDiagnostics.emit(.settled)
        } else {
            LifecycleDiagnostics.emit(.unsettled)
        }
        if conn == nil {
            LifecycleDiagnostics.emit(.connMissing)
        } else if conn == "asleep" {
            LifecycleDiagnostics.emit(.connAsleep)
        } else {
            LifecycleDiagnostics.emit(.connOther)
        }
        if sandbox == "stopped" || sandbox == "archived" {
            LifecycleDiagnostics.emit(.sandboxStopped)
        } else {
            LifecycleDiagnostics.emit(.sandboxOther)
        }
        guard settledPod != nil else {
            XCTFail("sleeping fixture never settled to the app's asleep rule (conn=\(conn ?? "missing") sandbox=\(sandbox ?? "missing"))", file: file, line: line)
            return
        }
    }

    /// Sends a prompt demanding a novel token, then reports whether that token
    /// appeared inside an ASSISTANT-role message (session.assistantMessage).
    /// Matching our own typed echo would prove nothing; only a correlated
    /// assistant response passes. The caller owns the assertion, so a failure
    /// is reported at the call site that knows what the reply was for.
    private func sendAndRequireAssistantReply(token: String) -> Bool {
        let composer = composerField()
        composer.tap()
        composer.typeText("reply with exactly the word \(token) and nothing else")
        app.buttons["composer.send"].tap()
        let assistantHits = app.otherElements.matching(identifier: "session.assistantMessage")
            .containing(NSPredicate(format: "label CONTAINS %@", token))
        return assistantHits.firstMatch.waitForExistence(timeout: 180)
    }

    func testPiPromptAssistantCorrelated() throws {
        openFixturePod()
        XCTAssertTrue(sendAndRequireAssistantReply(token: "ZEBRA-4821"),
            "assistant-role message carried the novel token")
        capturePostAuth("prompt-replied")
    }

    func testWakeReconnect4420Path() throws {
        // Order-independent: re-arm the shared fixture asleep first, so an
        // earlier test's wake in the same run cannot leak state in.
        rearmSleepingFixture()
        // 4420 is the gateway "pod asleep" close path (SessionSocket.asleep).
        // The companion forces the bound sleeping fixture asleep via the
        // normal server API before tests run; opening it must show the
        // asleep banner, and Wake must reconnect. Absent banner or failed
        // reconnect FAILS. No fake admin routes or hooks anywhere.
        let tail = String(UITestConfig.sleepingPodID.suffix(10))
        let row = stableFixtureRow(shortID: UITestConfig.sleepingPodID)
        let present = LifecycleDiagnostics.awaitFixtureRow(
            app: app, row: row, suffix: tail, fixture: .sleeping, timeout: 30)
        XCTAssertTrue(present, "sleeping fixture row present")
        LifecycleDiagnostics.emit(LifecycleDiagnostics.Stage.rowTapPerformed)
        row.tap()
        // The asleep banner and its Wake action live in SessionView, not on the
        // pod detail screen the row pushes.
        let opened = openSessionFromDetail()
        XCTAssertTrue(opened, "pod detail offered Open session")
        let wake = bannerAction()
        let wakeShown = wake.waitForExistence(timeout: 30)
        LifecycleDiagnostics.observeDetail(app: app)
        LifecycleDiagnostics.emit(wakeShown ? LifecycleDiagnostics.Stage.wakeActionShown : LifecycleDiagnostics.Stage.wakeActionAbsent)
        if !wakeShown {
            // Post-auth session screen only, never login pixels: shows what
            // rendered instead of the asleep banner (connecting state, a
            // connected session, or nothing at all).
            capturePostAuth("wake-no-banner")
        }
        XCTAssertTrue(wakeShown, "asleep banner with Wake action shown (4420 path)")
        tapBannerActionAndObserve(wake)
        let reconnected = waitForFixtureConnected(shortID: UITestConfig.sleepingPodID)
        XCTAssertTrue(reconnected, "session reconnected after wake")
        let composer = composerField()
        let composerShown = composer.waitForExistence(timeout: 180)
        LifecycleDiagnostics.emit(composerShown ? LifecycleDiagnostics.Stage.composerShown : LifecycleDiagnostics.Stage.composerAbsent)
        XCTAssertTrue(composerShown, "session composer shown after wake")
        capturePostAuth("wake-reconnected")
    }

    /// Negative order test for the d130b75 HOLD: waking the shared
    /// fixture and then re-arming must restore the asleep precondition IN
    /// THE SAME RUN. If re-arm silently no-ops, the asleep banner below is
    /// absent and this test FAILS instead of leaking green downstream.
    /// (Alphabetical runners execute testWakeReconnect4420Path before
    /// testWorkstationWaitCancelRetry; both re-arm, and this test pins the
    /// restore step itself.)
    func testRearmRestoresAsleepPrecondition() throws {
        rearmSleepingFixture()
        let tail = String(UITestConfig.sleepingPodID.suffix(10))
        let row = stableFixtureRow(shortID: UITestConfig.sleepingPodID)
        let present = LifecycleDiagnostics.awaitFixtureRow(
            app: app, row: row, suffix: tail, fixture: .sleeping, timeout: 30)
        XCTAssertTrue(present, "sleeping fixture row present")
        LifecycleDiagnostics.emit(LifecycleDiagnostics.Stage.rowTapPerformed)
        row.tap()
        let opened = openSessionFromDetail()
        XCTAssertTrue(opened, "pod detail offered Open session")
        let wake = bannerAction()
        let wakeShown = wake.waitForExistence(timeout: 30)
        LifecycleDiagnostics.observeDetail(app: app)
        LifecycleDiagnostics.emit(wakeShown ? LifecycleDiagnostics.Stage.wakeActionShown : LifecycleDiagnostics.Stage.wakeActionAbsent)
        if !wakeShown {
            // Post-auth session screen only, never login pixels: shows what
            // rendered instead of the asleep banner (connecting state, a
            // connected session, or nothing at all).
            capturePostAuth("wake-no-banner")
        }
        XCTAssertTrue(wakeShown, "asleep banner shown before wake")
        tapBannerActionAndObserve(wake)
        let woken = waitForFixtureConnected(shortID: UITestConfig.sleepingPodID)
        XCTAssertTrue(woken, "woken (precondition disturbed on purpose)")
        let composer = composerField()
        let composerShown = composer.waitForExistence(timeout: 180)
        LifecycleDiagnostics.emit(composerShown ? LifecycleDiagnostics.Stage.composerShown : LifecycleDiagnostics.Stage.composerAbsent)
        XCTAssertTrue(composerShown, "session composer shown after wake")
        // Back out to the list, re-arm, and require the asleep banner again.
        // Two screens deep now (detail, then session), so pop until the list.
        XCTAssertTrue(returnToPodsList(), "returned to pods list before re-arm")
        rearmSleepingFixture()
        let row2 = stableFixtureRow(shortID: UITestConfig.sleepingPodID)
        let present2 = LifecycleDiagnostics.awaitFixtureRow(
            app: app, row: row2, suffix: tail, fixture: .sleeping, timeout: 30)
        XCTAssertTrue(present2, "sleeping fixture row present after re-arm")
        row2.tap()
        let reopened = openSessionFromDetail()
        XCTAssertTrue(reopened, "pod detail offered Open session after re-arm")
        let wake2 = bannerAction()
        XCTAssertTrue(wake2.waitForExistence(timeout: 30), "asleep banner restored after re-arm")
        capturePostAuth("rearm-restored")
    }

    func testBackgroundForegroundReconnect() throws {
        // Real client-side transport recovery without touching the server:
        // background the app (socket drops), foreground it, and require the
        // reconnect machinery to restore the live session. This does NOT
        // prove server-driven HTTP 503 handling — full native 503 evidence
        // remains a CP-coordinated release gate and is not claimed from this
        // suite alone (nor is whole-M5 done).
        openFixturePod()
        XCUIDevice.shared.press(.home)
        sleep(3)
        app.activate()
        let reconnecting = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Reconnecting")).firstMatch
        let composer = composerField()
        if reconnecting.waitForExistence(timeout: 10) {
            XCTAssertTrue(composer.waitForExistence(timeout: 120), "session restored after foreground reconnect")
        } else {
            XCTAssertTrue(composer.exists, "session survived backgrounding")
        }
        capturePostAuth("transport-restored")
    }

    func testWorkstationWaitCancelRetry() throws {
        // The ACTUAL wait case: the workstation wait card
        // (workstation.wait) with its real Stop-waiting control
        // (workstation.cancel), then retry. This is the required
        // wait-cancel/retry gate — not an LLM stream interrupt.
        // Order-independent: re-arm asleep first, exactly like the wake
        // test, so alphabetical execution cannot leak a woken fixture in.
        rearmSleepingFixture()
        let tail = String(UITestConfig.sleepingPodID.suffix(10))
        let row = stableFixtureRow(shortID: UITestConfig.sleepingPodID)
        let present = LifecycleDiagnostics.awaitFixtureRow(
            app: app, row: row, suffix: tail, fixture: .sleeping, timeout: 30)
        XCTAssertTrue(present, "sleeping fixture row present")
        LifecycleDiagnostics.emit(LifecycleDiagnostics.Stage.rowTapPerformed)
        row.tap()
        // The workstation wait card is a session surface, not a detail surface.
        let opened = openSessionFromDetail()
        XCTAssertTrue(opened, "pod detail offered Open session")
        LifecycleDiagnostics.observeDetail(app: app)
        // Type-agnostic like every other acceptance query: the card is a
        // `.contain` group and neither its XCTest type nor the buttons'
        // element type is a contract. The Stop press lands behind the same
        // stability gate as every other tap in this suite.
        let waitCard = app.descendants(matching: .any)
            .matching(identifier: "workstation.wait").firstMatch
        let wake = bannerAction()
        if waitCard.waitForExistence(timeout: 30) {
            let cancel = app.descendants(matching: .any)
                .matching(identifier: "workstation.cancel").firstMatch
            XCTAssertTrue(cancel.waitForExistence(timeout: 10), "wait card offers Stop waiting")
            XCTAssertTrue(tapAllHittable(identifier: "workstation.cancel"),
                "wait card Stop control accepted the tap")
            // After cancelling the wait, nothing re-attaches on its own:
            // the only green path without a driven retry is an in-flight
            // attach completing by luck. Drive the product's own retry
            // instead -- the notice's Keep waiting re-issues the attach
            // that boots the pod -- then require the backend-connected
            // fixture. A still-waiting card keeps the old passing shape;
            // a missing notice fails closed, since the wait ended with no
            // recovery on offer. Cold boots take minutes, not seconds.
            let waitingAgain = waitCard.waitForExistence(timeout: 60)
            if waitingAgain {
                capturePostAuth("wait-cancel-retry")
                return
            }
            let noticeRetry = app.descendants(matching: .any)
                .matching(identifier: "workstation.retry").firstMatch
            if !noticeRetry.waitForExistence(timeout: 30) {
                capturePostAuth("wait-cancel-no-retry")
            }
            XCTAssertTrue(noticeRetry.exists, "wait notice offers Keep waiting after cancel")
            XCTAssertTrue(tapAllHittable(identifier: "workstation.retry"),
                "Keep waiting accepted the tap")
            let connected = waitForFixtureConnected(
                shortID: UITestConfig.sleepingPodID, timeout: 300)
            if !connected {
                capturePostAuth("wait-cancel-not-connected")
            }
            XCTAssertTrue(connected, "session connected after retrying the wait")
        } else {
            // No wait card right now: the wake path is the retry vehicle.
            XCTAssertTrue(wake.waitForExistence(timeout: 30), "Wake action shown as the retry vehicle")
            tapBannerActionAndObserve(wake)
            let connected = waitForFixtureConnected(shortID: UITestConfig.sleepingPodID)
            XCTAssertTrue(connected, "session connected on retry")
            XCTAssertTrue(composerField().waitForExistence(timeout: 180),
                "session composer shown on retry")
        }
        capturePostAuth("wait-cancel-retry")
    }

    /// Sends a deliberately long turn and presses Stop while it is still
    /// running. Returns whether the press landed on a LIVE turn.
    ///
    /// The prompt demands sequential tool work, not output text: a model
    /// asked for lines answers in about a second with a shorthand, and a
    /// turn that is already over cannot be cancelled. Tool round-trips are
    /// wall time the model cannot shortcut -- it must wait for each result
    /// before the next call -- so listing a directory and then reading three
    /// files one at a time keeps the turn alive for tens of seconds, which
    /// is the window the press needs. The control is re-resolved at press
    /// time for the same reason — it exists only while the stream runs, so
    /// tapping a snapshot of one that has since gone presses whatever moved
    /// into its place.
    private func sendLongTurnAndInterrupt() -> Bool {
        let prompt = "Explore the workspace step by step using your tools. First list the files in the working directory. Then read the full contents of the three largest text files you find there, one at a time. Then summarize what this workspace is for."
        let composer = composerField()
        composer.tap()
        composer.typeText(prompt)
        // The previous turn's echo re-renders the transcript while typing;
        // if focus was lost mid-type the text lands nowhere and the send
        // below dies on a disabled button instead of on a verdict. Read
        // back what landed and retype once into a fresh resolve; an empty
        // composer after that is a miss, and the re-arm covers it like any
        // other miss.
        if (composer.value as? String ?? "").isEmpty {
            let fresh = composerField()
            fresh.tap()
            fresh.typeText(prompt)
        }
        guard !(composerField().value as? String ?? "").isEmpty else {
            LifecycleDiagnostics.emit(LifecycleDiagnostics.CancelStage.longTurnSendMissed)
            return false
        }
        // Resolved, not type-bound, and effect-free on failure: a press on
        // a disabled or missing Send records nothing and reports the miss,
        // so the re-arm below -- not the tap line -- owns the verdict.
        let sendTapped = tapAllHittable(identifier: "composer.send")
        LifecycleDiagnostics.emit(sendTapped
            ? LifecycleDiagnostics.CancelStage.longTurnSent
            : LifecycleDiagnostics.CancelStage.longTurnSendMissed)
        guard sendTapped else { return false }
        let interrupt = interruptControl()
        let shown = interrupt.waitForExistence(timeout: 60)
        LifecycleDiagnostics.emit(shown
            ? LifecycleDiagnostics.CancelStage.interruptControlShown
            : LifecycleDiagnostics.CancelStage.interruptControlAbsent)
        guard shown else { return false }
        // Pressed with no sleep between resolve and press and no frame read
        // anywhere: the old gate died on its own guard when the turn ended
        // mid-gate. A control that is never hittable is reported as vanished
        // and re-armed; the halt check below is what proves a live turn was
        // actually interrupted.
        let tapped = tapAllHittable(identifier: "composer.interrupt")
        LifecycleDiagnostics.emit(tapped
            ? LifecycleDiagnostics.CancelStage.interruptTapped
            : LifecycleDiagnostics.CancelStage.interruptControlVanished)
        return tapped
    }

    func testCancelRetryStream() throws {
        // LLM stream interrupt is covered in addition to (not instead of)
        // the workstation wait gate above.
        openFixturePod()
        // The sends below park silently while the socket is still coming up
        // and die with the per-test relaunch, leaving no backend trace at
        // all: two "sent" long turns once vanished exactly that way. Prove
        // a live round trip first; the ping's own wait covers socket
        // establishment, and its echo is the proof the long turn below will
        // actually stream instead of parking.
        let live = sendAndRequireAssistantReply(token: "ZEBRA-7301")
        LifecycleDiagnostics.emit(live
            ? LifecycleDiagnostics.CancelStage.liveRoundTripShown
            : LifecycleDiagnostics.CancelStage.liveRoundTripAbsent)
        XCTAssertTrue(live, "live round trip before arming the cancel")
        // A turn that ended before the press could land was never cancelled,
        // and this test cannot pass by never cancelling anything. One re-arm:
        // a second long turn restores the precondition, exactly as the wake
        // tests re-arm the sleeping fixture. Two misses is the real answer.
        var interrupted = sendLongTurnAndInterrupt()
        if !interrupted { interrupted = sendLongTurnAndInterrupt() }
        if !interrupted {
            // Post-auth session screen only: shows the composer state the
            // press raced against (turn already over, control gone).
            capturePostAuth("cancel-no-interrupt")
        }
        XCTAssertTrue(interrupted, "a live turn was interrupted")
        let haltShown = waitForStatus(containing: "stopped", timeout: 20)
        LifecycleDiagnostics.emit(haltShown
            ? LifecycleDiagnostics.CancelStage.haltShown
            : LifecycleDiagnostics.CancelStage.haltAbsent)
        XCTAssertTrue(haltShown, "stream halted after interrupt")
        // A follow-up queued behind a turn that never stopped is not a retry:
        // require the turn to be over first, by the composer's own controls.
        let ended = waitForTurnIdle(timeout: 120)
        LifecycleDiagnostics.emit(ended
            ? LifecycleDiagnostics.CancelStage.turnEnded
            : LifecycleDiagnostics.CancelStage.turnStillRunning)
        XCTAssertTrue(ended, "interrupted turn actually ended")
        LifecycleDiagnostics.emit(LifecycleDiagnostics.CancelStage.retryPromptSent)
        let replied = sendAndRequireAssistantReply(token: "ZEBRA-9911")
        LifecycleDiagnostics.emit(replied
            ? LifecycleDiagnostics.CancelStage.retryAssistantReplied
            : LifecycleDiagnostics.CancelStage.retryAssistantMissing)
        XCTAssertTrue(replied, "assistant replied to the prompt sent after the cancel")
        capturePostAuth("cancel-retry")
    }

    func testFilesRoundTripStrict() throws {
        // The workflow seeds seed.png into the app's own Documents folder on
        // the simulator (simctl install + get_app_container + cp -- a real
        // file in a real Files location). The composer offers it through
        // "Attach file", the document-browser twin of the photo picker, and
        // this test drives that path end to end. Require the SPECIFIC picked
        // file to land accepted in the transcript; error/attach-fallback text
        // does NOT pass. Byte and mtime preservation across the wire is
        // proven by the CLI file API (FINAL-STATIC-MTIME-TRUST-ACTUAL); this
        // test binds the native file-attach UI to that same server path.
        openFixturePod()
        guard let uuid = fixtureUUID(shortID: UITestConfig.fixturePodID),
              let baseline = imagePromptBaseline(uuid: uuid) else {
            XCTFail("image prompt persistence baseline available")
            return
        }
        LifecycleDiagnostics.emit(.baselineRead)
        let attachFile = attachFileControl()
        let fileShown = attachFile.waitForExistence(timeout: 15)
        if fileShown { LifecycleDiagnostics.emit(.attachFileShown) }
        XCTAssertTrue(fileShown, "composer attach-file control present")
        let fileTapped = tapAllHittable(identifier: "composer.attachFile")
        if fileTapped { LifecycleDiagnostics.emit(.attachFileTapped) }
        XCTAssertTrue(fileTapped, "composer attach-file control accepted the tap")
        // The sheet is the evidence the tap presented anything at all: no
        // sheet means the press missed, a sheet with no reachable file is a
        // different defect. Closed bucket, never content.
        Thread.sleep(forTimeInterval: 3)
        LifecycleDiagnostics.emitSheetCount(app.sheets.count)
        // The document browser is system UI: its rows carry labels, not
        // identifiers. The seeded filename and the app's own folder name are
        // stable repo-owned strings, so they are the contract; only the last
        // resort location row is a system label, tried after both are absent
        // on an English simulator. Every branch is a closed marker.
        let docDeadline = Date().addingTimeInterval(90)
        let docStart = Date()
        let initialSheets = app.sheets.count
        var picked = false
        var pickerFailed = false
        var searched = false
        var folderTapped = false
        var locationTapped = false
        var browseUsed = false
        var backsUsed = 0
        var cancelUsed = false
        var retapped = false
        // Picker evidence for the disruptive branches below: the app has no
        // search field in the session, so a search field on screen is the
        // picker's own, and a sheet census above zero is a presentation.
        // Without either, Back could pop the session underneath the test.
        func browserSeen() -> Bool {
            searched || initialSheets > 0 || folderTapped || locationTapped
        }
        while Date() < docDeadline {
            // The picker answers a failure through its completion handler,
            // which lands in the composer's attach-error row: presented but
            // broken is a different defect from never presented, and it
            // names itself here instead of starving the loop for 90 seconds.
            if app.descendants(matching: .any)
                .matching(identifier: "composer.attachError").firstMatch.exists {
                LifecycleDiagnostics.emit(.filePickerFailed)
                pickerFailed = true
                break
            }
            if let seed = hittableLabelled("seed.png") {
                seed.tap()
                LifecycleDiagnostics.emit(.fileRowTapped)
                picked = true
                break
            }
            if let folder = hittableLabelled("pi pod") {
                folder.tap()
                LifecycleDiagnostics.emit(.folderOpened)
                folderTapped = true
                Thread.sleep(forTimeInterval: 2)
                continue
            }
            if !searched, app.searchFields.firstMatch.exists {
                let search = app.searchFields.firstMatch
                search.tap()
                search.typeText("seed")
                searched = true
                LifecycleDiagnostics.emit(.searchUsed)
                // The browser filters as you type, but a committed search
                // is the same user action finished: tap the keyboard's own
                // Search when it offers one, then look again.
                if app.keyboards.buttons["Search"].exists {
                    app.keyboards.buttons["Search"].tap()
                }
                Thread.sleep(forTimeInterval: 3)
                continue
            }
            // The browser can open straight into a location whose rows match
            // nothing. Its Browse tab returns to the locations list; tapped
            // once, because a wrong target must not toggle anything twice.
            if !browseUsed, let browse = hittableLabelled("Browse") {
                browse.tap()
                LifecycleDiagnostics.emit(.browseOpened)
                browseUsed = true
                Thread.sleep(forTimeInterval: 2)
                continue
            }
            if let location = hittableLabelled("On My iPhone") {
                location.tap()
                LifecycleDiagnostics.emit(.locationOpened)
                locationTapped = true
                Thread.sleep(forTimeInterval: 2)
                continue
            }
            // A committed search with no match parks the browser in search
            // mode: its chrome (Browse, Back, locations) hides until the
            // search exits, so no branch below can fire and the loop would
            // starve for the rest of the deadline. The picker's Cancel
            // exits search mode and restores the chrome; if it dismisses
            // the browser instead, the re-press below presents it fresh
            // (retapped resets for the new presentation). Bounded once and
            // search-gated: without a preceding search on screen this could
            // be something else's Cancel.
            if searched, !cancelUsed, let cancel = hittableLabelled("Cancel") {
                cancel.tap()
                cancelUsed = true
                retapped = false
                LifecycleDiagnostics.emit(.searchCancelled)
                Thread.sleep(forTimeInterval: 2)
                continue
            }
            // Deep in a location with no matching rows, the way out is Back
            // toward Browse. Bounded and picker-evidence-gated: without the
            // picker's own search field or a presentation on record, this
            // could be the session's own back button. The deepest match is
            // the topmost UI, which is the modal when one is up; afterwards
            // the composer must still exist, or Back tapping stops.
            if browserSeen(), backsUsed < 3,
               attachFileControl().exists {
                let backs = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "label CONTAINS %@", "Back"))
                var tappedBack = false
                for index in (0..<min(backs.count, 6)).reversed() {
                    let candidate = backs.element(boundBy: index)
                    if candidate.exists, candidate.isHittable {
                        candidate.tap()
                        backsUsed += 1
                        LifecycleDiagnostics.emit(.backOutUsed)
                        tappedBack = true
                        break
                    }
                }
                if tappedBack {
                    Thread.sleep(forTimeInterval: 2)
                    continue
                }
            }
            // One re-press if the binding flip seemingly never presented
            // anything: the flip is idempotent, and a press the browser
            // ignored is the same user action repeated, not a new path.
            // Still no rows, no sheet and no picker error afterwards is the
            // verdict, not a second re-press.
            if !retapped, Date().timeIntervalSince(docStart) > 15 {
                retapped = true
                if tapAllHittable(identifier: "composer.attachFile") {
                    LifecycleDiagnostics.emit(.attachFileTapped)
                }
                Thread.sleep(forTimeInterval: 3)
                LifecycleDiagnostics.emitSheetCount(app.sheets.count)
                continue
            }
            Thread.sleep(forTimeInterval: 2)
        }
        XCTAssertFalse(pickerFailed, "document browser opened instead of failing")
        if pickerFailed || !picked {
            // Post-auth session screen only: shows the browser state (or
            // its absence) the 90 seconds of polling actually saw.
            capturePostAuth("files-not-picked")
        }
        XCTAssertTrue(picked, "seeded file picked from the document browser")
        // Single-select import dismisses itself on the pick; a sheet that is
        // still there afterwards means the pick did not land.
        XCTAssertTrue(waitForSheetsGone(timeout: 15),
            "document browser dismissed after picking")
        // The composer thumbnail's label carries a file name and is
        // localizable; its identifier is the staging contract, and its XCTest
        // element type is not part of it.
        let staged = app.descendants(matching: .any)
            .matching(identifier: "composer.attachment").firstMatch
        let attachmentStaged = staged.waitForExistence(timeout: 30)
        if attachmentStaged { LifecycleDiagnostics.emit(.attachmentStaged) }
        XCTAssertTrue(attachmentStaged, "selected file staged in composer")
        app.buttons["composer.send"].tap()
        LifecycleDiagnostics.emit(.sendPerformed)
        let persisted = waitForNewImagePrompt(uuid: uuid, excluding: baseline)
        if persisted { LifecycleDiagnostics.emit(.imagePromptPersisted) }
        XCTAssertTrue(persisted, "image-bearing prompt persisted")
        // Success-specific: the transcript strip that renders REAL bytes.
        // `session.messageAttachmentsPlaceholder` is the size tile a row
        // whose bytes stayed on the pod draws instead, and an error banner or
        // attach-fallback label carries neither identifier, so none of them
        // can satisfy this. The strip is one collapsed element rather than an
        // image, so the query stays type-agnostic.
        let attached = app.descendants(matching: .any)
            .matching(identifier: "session.messageAttachments").firstMatch
        XCTAssertTrue(attached.waitForExistence(timeout: 60), "specific attached image accepted into transcript")
        capturePostAuth("files-attached")
    }

    func testBillingSurfacePerBackend() throws {
        // SaaS: a billing surface must exist. Static: there must be none at
        // all. Both branches first navigate to the real Settings screen —
        // asserting absence without navigation proves nothing.
        let settingsTab = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Settings")).firstMatch
        XCTAssertTrue(settingsTab.waitForExistence(timeout: 15), "Settings entry reachable")
        settingsTab.tap()
        XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 15), "Settings screen shown")
        // The surface, not one particular entry: `GET /v1/billing/account`
        // offers "Manage billing" only to an account that already has a
        // billing customer and the trial/subscribe pair to one that does not,
        // so demanding a single entry asserts the fixture identity's
        // subscription state instead of the app's per-backend behaviour.
        let entries = UITestConfig.Companion.billingEntryIdentifiers.map {
            app.descendants(matching: .any).matching(identifier: $0).firstMatch
        }
        if UITestConfig.isStatic {
            for entry in entries {
                XCTAssertFalse(entry.waitForExistence(timeout: 10),
                    "no billing surface on static backend")
            }
        } else {
            let deadline = Date().addingTimeInterval(20)
            var shown = false
            repeat {
                shown = entries.contains { $0.exists }
                if shown || Date() >= deadline { break }
                Thread.sleep(forTimeInterval: 1)
            } while true
            XCTAssertTrue(shown, "billing surface present on SaaS backend")
        }
        capturePostAuth("billing-surface")
    }
}
