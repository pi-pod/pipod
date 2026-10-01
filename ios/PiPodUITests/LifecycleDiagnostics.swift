import XCTest

/// Values-free stage markers for the shared pod-open path.
///
/// Every marker is a FIXED enum printed as a complete line. Nothing derived
/// from live data is ever emitted: no pod name, no accessibility label, no pod
/// id or suffix, no transcript, no URL, no credential, no length. Counts are
/// published only as closed buckets, so "how many rows" can never become "which
/// rows". The classifier (`scripts/classify_lifecycle_log.py`) accepts only the
/// exact strings below and discards anything else.
///
/// Markers are emitted BEFORE the assertion they describe, so a failing,
/// `continueAfterFailure = false` test still leaves its stopping point in the
/// private log. They observe only; no marker changes control flow, query,
/// timeout or assertion, and nothing here touches the app under test.
enum LifecycleDiagnostics {
    static let stagePrefix = "PIPOD_LIFECYCLE_STAGE="
    static let fixturePrefix = "PIPOD_LIFECYCLE_FIXTURE="
    static let phasePrefix = "PIPOD_LIFECYCLE_PHASE="
    static let cellCountPrefix = "PIPOD_LIFECYCLE_CELL_COUNT="
    static let rowIdCountPrefix = "PIPOD_LIFECYCLE_ROW_ID_COUNT="
    static let containingCountPrefix = "PIPOD_LIFECYCLE_SUFFIX_CONTAINING_COUNT="
    static let matchingCountPrefix = "PIPOD_LIFECYCLE_SUFFIX_MATCHING_COUNT="
    static let buttonCountPrefix = "PIPOD_LIFECYCLE_SUFFIX_BUTTON_COUNT="
    static let filesPrefix = "PIPOD_FILES_STAGE="
    static let filesNavPrefix = "PIPOD_FILES_NAV="
    static let sheetPrefix = "PIPOD_FILES_SHEET="
    static let cancelPrefix = "PIPOD_CANCEL_STAGE="
    static let settlePrefix = "PIPOD_SETTLE="

    /// Which bound fixture a pod-open path is working on. Never an id.
    enum Fixture: String {
        case awake
        case sleeping
    }

    /// When a list snapshot was taken relative to the row's existence wait.
    enum Phase: String {
        case beforeWait = "before-wait"
        case afterWait = "after-wait"
    }

    enum Stage: String {
        case podOpenStarted = "pod-open-started"
        case podsSurfaceShown = "pods-surface-shown"
        case podsSurfaceAbsent = "pods-surface-absent"
        case refreshErrorShown = "refresh-error-shown"
        case refreshErrorAbsent = "refresh-error-absent"
        case showHiddenOffered = "show-hidden-offered"
        case showHiddenAbsent = "show-hidden-absent"
        case listSnapshotTaken = "list-snapshot-taken"
        // Label-suffix counts remain in the snapshot as a diagnostic for
        // auto-renames, but fixture identity is the stable pod.row.<uuid>
        // accessibility identifier resolved read-only from the companion API.
        case fixtureRowPresent = "fixture-row-present"
        case fixtureRowAbsent = "fixture-row-absent"
        case fixtureRowUnique = "fixture-row-unique"
        case fixtureRowNonunique = "fixture-row-nonunique"
        case rowTapPerformed = "row-tap-performed"
        case openSessionActionShown = "open-session-action-shown"
        case openSessionActionAbsent = "open-session-action-absent"
        case openSessionTapped = "open-session-tapped"
        case podDetailShown = "pod-detail-shown"
        case podDetailAbsent = "pod-detail-absent"
        case sessionSurfaceShown = "session-surface-shown"
        case sessionSurfaceAbsent = "session-surface-absent"
        case sessionBannerShown = "session-banner-shown"
        case sessionBannerAbsent = "session-banner-absent"
        case wakeActionShown = "wake-action-shown"
        case wakeActionAbsent = "wake-action-absent"
        // Did pressing the banner action change anything at all? The asleep
        // banner has no action once the wake is under way (the waking banner
        // is a spinner), so an action that survives the press says the press
        // did not move the stream out of its asleep state — which separates
        // "the app never asked the server" from "the server was slow".
        case wakeTapActionCleared = "wake-tap-action-cleared"
        case wakeTapActionPersisted = "wake-tap-action-persisted"
        // The durable half of the same question: did the bound fixture's
        // sandbox ever leave its asleep state during the wait? Seen without
        // `wake-backend-connected` is a slow start; never seen at all means
        // no attach ever reached the gateway.
        case wakeBackendStartingSeen = "wake-backend-starting-seen"
        case wakeBackendConnected = "wake-backend-connected"
        case wakeBackendNotConnected = "wake-backend-not-connected"
        case composerShown = "composer-shown"
        case composerAbsent = "composer-absent"
    }

    /// Ordered, success-only checkpoints for the document-browser attach
    /// path. The classifier reports the first absent checkpoint; no system
    /// label, file name, prompt text, payload or identifier can enter the
    /// wire. The sheet census beside it says whether the browser presented
    /// at all; the nav markers below say how the file was reached.
    enum FilesStage: String {
        case baselineRead = "baseline-read"
        case attachFileShown = "attach-file-shown"
        case attachFileTapped = "attach-file-tapped"
        /// The browser answered with a picker failure (its message shows in
        /// the composer's attach-error row) instead of a file: presented
        /// but broken is a different defect from never presented, and the
        /// sheet census beside it tells those two apart.
        case filePickerFailed = "file-picker-failed"
        case fileRowTapped = "file-row-tapped"
        case attachmentStaged = "attachment-staged"
        case sendPerformed = "send-performed"
        case imagePromptPersisted = "image-prompt-persisted"
    }

    /// How the seeded file was reached inside the document browser. Fixed
    /// names only, counted but never a ladder: the filename and the app's own
    /// folder are stable repo-owned strings, and only the last-resort
    /// location row is a system label, tried after both are absent.
    enum FilesNav: String {
        case searchUsed = "search-used"
        case folderOpened = "folder-opened"
        case locationOpened = "location-opened"
        /// The browser's own Browse tab back toward the locations list.
        /// Counted, never a ladder, like the rest of the nav markers.
        case browseOpened = "browse-opened"
        /// A Back press toward Browse while picker evidence was on screen.
        /// Counted so the next run can tell whether Back ever fired.
        case backOutUsed = "back-out-used"
        /// The picker's Cancel after a committed search found no match. A
        /// matchless search parks the browser in search mode with its
        /// chrome hidden, so Cancel is the way back to navigation -- or, if
        /// it dismisses the browser, to a fresh presentation. Counted.
        case searchCancelled = "search-cancelled"
    }

    /// Whether the sleeping fixture settled to the app's own asleep rule
    /// before an open, and which column refused when it did not. Fixed
    /// names only, counted but never a ladder: the verdict lives in the
    /// test's own assertion, these say what the backend showed.
    enum SettleStage: String {
        case settled = "settled"
        case unsettled = "unsettled"
        case connAsleep = "conn-asleep"
        case connOther = "conn-other"
        case connMissing = "conn-missing"
        case sandboxStopped = "sandbox-stopped"
        case sandboxOther = "sandbox-other"
    }

    /// Checkpoints for the live-stream cancel/retry path.
    ///
    /// The interrupt control exists only while a turn is running, so a test
    /// that never saw one never cancelled anything — which a pass could not
    /// previously distinguish from a cancel that worked. Fixed markers only:
    /// no prompt, no token, no transcript, no status sentence.
    enum CancelStage: String {
        /// A short ping round-tripped before the long turn was armed: the
        /// socket is provably up, so the sends below cannot park into a dead
        /// connection and die with the per-test relaunch leaving no trace.
        case liveRoundTripShown = "live-round-trip-shown"
        case liveRoundTripAbsent = "live-round-trip-absent"
        case longTurnSent = "long-turn-sent"
        /// The long-turn prompt never left the composer (nothing landed to
        /// send, or no enabled Send to press): counted, never a ladder rung,
        /// so a press that never happened cannot read as a turn that ran.
        case longTurnSendMissed = "long-turn-send-missed"
        case interruptControlShown = "interrupt-control-shown"
        case interruptControlAbsent = "interrupt-control-absent"
        /// Present for the existence wait, gone by the time it was pressed:
        /// the turn ended on its own and was never interrupted.
        case interruptControlVanished = "interrupt-control-vanished"
        case interruptTapped = "interrupt-tapped"
        case haltShown = "halt-shown"
        case haltAbsent = "halt-absent"
        case turnEnded = "turn-ended"
        case turnStillRunning = "turn-still-running"
        case retryPromptSent = "retry-prompt-sent"
        case retryAssistantReplied = "retry-assistant-replied"
        case retryAssistantMissing = "retry-assistant-missing"
    }

    /// Closed buckets. A raw count is never printed: 3+ collapses so a pod
    /// census can never be reconstructed from the diagnostic.
    static func bucket(_ count: Int) -> String {
        switch count {
        case ..<1: return "count-0"
        case 1: return "count-1"
        case 2: return "count-2"
        default: return "count-3plus"
        }
    }

    /// Two-way bucket for "did exactly one thing match": the uniqueness
    /// question only has three interesting answers.
    static func pairBucket(_ count: Int) -> String {
        switch count {
        case ..<1: return "count-0"
        case 1: return "count-1"
        default: return "count-2plus"
        }
    }

    static func emit(_ stage: Stage) { print(stagePrefix + stage.rawValue) }
    static func emit(_ fixture: Fixture) { print(fixturePrefix + fixture.rawValue) }
    static func emit(_ phase: Phase) { print(phasePrefix + phase.rawValue) }
    static func emit(_ stage: FilesStage) { print(filesPrefix + stage.rawValue) }
    static func emit(_ nav: FilesNav) { print(filesNavPrefix + nav.rawValue) }
    static func emit(_ settle: SettleStage) { print(settlePrefix + settle.rawValue) }

    /// How many sheets the app had up shortly after the attach tap. Zero
    /// means the press presented nothing at all; one or more with no
    /// readable grid is a different defect. A closed bucket, never content.
    static func emitSheetCount(_ count: Int) { print(sheetPrefix + bucket(count)) }
    static func emit(_ stage: CancelStage) { print(cancelPrefix + stage.rawValue) }

    /// Non-blocking, type-agnostic existence probe.
    ///
    /// The accessibility identifier is the contract; the element TYPE is not.
    /// `session.podDetails` is a toolbar `Button`, so a probe written as
    /// `app.otherElements[...]` or `app.staticTexts[...]` reports absent even
    /// inside a live session — a false negative on a progress rung, which
    /// would make a SUCCESSFUL run read as having stopped. Matching on the
    /// identifier alone cannot produce that class of error.
    ///
    /// `exists` does not wait: the caller's own bounded wait owns all timing.
    static func probeExists(_ app: XCUIApplication, _ identifier: String) -> Bool {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch.exists
    }

    /// Existence probes that must not add waiting: the caller's own bounded
    /// wait owns the timing. `exists` is a non-blocking read of current state.
    static func observeListSurface(app: XCUIApplication) {
        emit(app.navigationBars["Pods"].exists ? Stage.podsSurfaceShown : Stage.podsSurfaceAbsent)
        emit(probeExists(app, "pods.refreshError") ? Stage.refreshErrorShown : Stage.refreshErrorAbsent)
        emit(probeExists(app, "pods.showHidden") ? Stage.showHiddenOffered : Stage.showHiddenAbsent)
    }

    /// The decisive census. Publishes, as closed buckets only:
    ///  - how many cells the list exposes at all;
    ///  - how many elements carry the app's own `pod.row.<id>` identifier
    ///    (type-agnostic: SwiftUI exposes NavigationLink rows as buttons, not
    ///    necessarily cells);
    ///  - how many cells CONTAIN a descendant whose label holds the suffix
    ///    (the query the suite actually uses);
    ///  - how many cells' OWN label holds the suffix (the alternative that a
    ///    `.accessibilityElement(children: .combine)` row would satisfy);
    ///  - how many buttons' labels hold the suffix.
    ///
    /// The suffix is used only inside predicates; it is never printed.
    static func snapshotList(app: XCUIApplication, suffix: String, phase: Phase) {
        emit(phase)
        let label = NSPredicate(format: "label CONTAINS %@", suffix)
        let rowIdentifier = NSPredicate(format: "identifier BEGINSWITH %@", "pod.row.")
        print(cellCountPrefix + bucket(app.cells.count))
        print(rowIdCountPrefix + bucket(
            app.descendants(matching: .any).matching(rowIdentifier).count))
        print(containingCountPrefix + pairBucket(app.cells.containing(label).count))
        print(matchingCountPrefix + pairBucket(app.cells.matching(label).count))
        print(buttonCountPrefix + pairBucket(app.buttons.matching(label).count))
        emit(.listSnapshotTaken)
    }

    /// Which surface we are actually on, reported as two independent facts
    /// rather than one ambiguous "detail" bit.
    ///
    /// `pod-detail-shown` is `pod.status`, which belongs to `PodDetailView`
    /// (where a row tap lands). `session-surface-shown` is
    /// `session.podDetails`, which belongs to `SessionView`. Reporting them
    /// separately is what distinguishes "stalled on the pod detail screen"
    /// from "in a session that has not finished attaching" — a single OR'd
    /// marker cannot, and previously could only be resolved by reading the
    /// app's routing.
    ///
    /// `composer-shown` is UI-readiness evidence only. It does not prove a
    /// sleeping fixture is connected: wake tests separately poll the exact
    /// fixture's supported backend projection and emit a closed connected/not-
    /// connected stage. A UI test cannot observe the ws-ticket HTTP call itself
    /// without changing app behaviour, so no marker claims to.
    static func observeDetail(app: XCUIApplication) {
        emit(probeExists(app, "pod.status") ? Stage.podDetailShown : Stage.podDetailAbsent)
        emit(probeExists(app, "session.podDetails")
            ? Stage.sessionSurfaceShown : Stage.sessionSurfaceAbsent)
        emit(probeExists(app, "session.banner")
            ? Stage.sessionBannerShown : Stage.sessionBannerAbsent)
        // Uses the same identifier-only contract as SessionLifecycleTests.
        // ComposerBar renders a SwiftUI TextField; R3 proved the former
        // `app.textViews[...]` assumption reports absent inside SessionView.
        emit(probeExists(app, "composer.field") ? Stage.composerShown : Stage.composerAbsent)
    }

    /// The shared pod-open census used by every fixture-row site. Emits the
    /// surface state and one snapshot, runs the caller's own existence wait,
    /// and on failure emits a second snapshot so a timeout is distinguishable
    /// from a list that never had rows. Returns the wait's own result; the
    /// caller still owns the assertion.
    @discardableResult
    static func awaitFixtureRow(
        app: XCUIApplication, row: XCUIElement, suffix: String,
        fixture: Fixture, timeout: TimeInterval
    ) -> Bool {
        emit(.podOpenStarted)
        emit(fixture)
        observeListSurface(app: app)
        snapshotList(app: app, suffix: suffix, phase: .beforeWait)
        // The account accumulates pods across runs and the list is
        // virtualized, so a stale fixture row can sit below the fold where
        // XCTest reports no existence at all. Scroll like a user, bounded
        // by the same timeout, before calling it absent. A stray swipe on
        // a non-list screen bounces harmlessly; the deadline bounds it.
        let deadline = Date().addingTimeInterval(timeout)
        var present = row.waitForExistence(timeout: 5)
        while !present, Date() < deadline {
            app.swipeUp()
            present = row.waitForExistence(timeout: 2)
        }
        if !present {
            observeListSurface(app: app)
            snapshotList(app: app, suffix: suffix, phase: .afterWait)
        }
        emit(present ? Stage.fixtureRowPresent : Stage.fixtureRowAbsent)
        if present {
            // The row query is exact on pod.row.<full uuid>; XCUITest should
            // expose one element, never firstMatch over an ambiguous set.
            let exact = app.descendants(matching: .any)
                .matching(identifier: row.identifier)
            emit(exact.count == 1 ? Stage.fixtureRowUnique : Stage.fixtureRowNonunique)
        }
        return present
    }
}
