#!/usr/bin/env python3
"""Guard lifecycle acceptance queries against XCUITest element-type assumptions.

Accessibility identifiers are the contract; the XCTest element type behind a
SwiftUI control is not. Two credentialed runs proved the cost of assuming it:

* `session.podDetails` is a toolbar Button, so otherElements/staticTexts missed
  a real SessionView surface.
* `composer.field` is a SwiftUI TextField(axis: .vertical), so textViews missed
  the real composer in all six SessionViews reached by R3.
* `session.bannerAction` is the stable Wake contract; its localized label and
  SwiftUI/XCTest element type are not fixture identity.

This fails if a guarded identifier is queried through a type-bound subscript in
either the lifecycle diagnostics or SessionLifecycleTests. It also pins the two
identifier-only query shapes so deleting the real probe/helper cannot make the
guard pass vacuously.
"""
import pathlib
import re
import sys

SOURCES = (
    "PiPodUITests/LifecycleDiagnostics.swift",
    "PiPodUITests/SessionLifecycleTests.swift",
)

GUARDED = (
    "pod.status",
    "session.podDetails",
    "session.banner",
    "pods.refreshError",
    "pods.showHidden",
    "composer.field",
    "session.bannerAction",
    # The staged thumbnail carries `.isImage`, but the transcript strip is an
    # `.accessibilityElement(children: .ignore)` group and is not an image at
    # all. Both are identifiers, neither is an element type.
    "composer.attachment",
    # `composer.attach` is the photo control the suite no longer drives and
    # `composer.attachFile` the file button it does: a real Button carrying
    # the identifier directly. Neither element type is a contract.
    "composer.attach",
    "composer.attachFile",
    # The Stop control and the spinner that replaces it are the composer's
    # running state. Their labels are localized sentences and their element
    # types are SwiftUI's business.
    "composer.interrupt",
    "composer.interrupting",
    # A status row is `.accessibilityElement(children: .combine)`, so it is one
    # collapsed element and not a static text at all.
    "session.statusMessage",
    # The wait card is a `.contain` group and Stop waiting is a bordered
    # button; neither XCTest type is a contract, exactly like the composer
    # and banner controls before them.
    "workstation.wait",
    "workstation.cancel",
)

REQUIRED = {
    "PiPodUITests/LifecycleDiagnostics.swift": (
        'probeExists(app, "session.podDetails")',
        'probeExists(app, "composer.field")',
    ),
    "PiPodUITests/SessionLifecycleTests.swift": (
        '.matching(identifier: "composer.field").firstMatch',
        '.matching(identifier: "session.bannerAction").firstMatch',
        '.matching(identifier: "pod.row.\\(uuid)").firstMatch',
        'waitForFixtureConnected(',
        # Backend truth for a wake is the supported pod projection's own
        # fields. Naming both halves keeps "durably started" and "socket
        # attached" distinguishable after the tuple was relaxed to accept a
        # started+ready pod whose connection is still catching up.
        'pod["sandboxState"] as? String',
        'connection == "connected"',
        # A wake that changed nothing and a wake the server was slow to honour
        # are different defects; a run that emits neither marker cannot tell
        # them apart, which is how three wake failures stayed unexplained.
        'tapBannerActionAndObserve(',
        'LifecycleDiagnostics.emit(.wakeBackendStartingSeen)',
        # The open runs only on a settled fixture: an exhausted gate fails
        # with the refusing column named instead of dying later at the
        # banner wait and blaming the UI for a backend state.
        'LifecycleDiagnostics.emit(.settled)',
        'LifecycleDiagnostics.emit(.unsettled)',
        'UITestConfig.Companion.podsPath()',
        'UITestConfig.Companion.conversationPath(uuid: uuid)',
        # The billing SURFACE, never one entry: which entry a SaaS account is
        # offered is its own subscription state.
        'UITestConfig.Companion.billingEntryIdentifiers',
        # Staged in the composer and accepted into the transcript are two
        # different facts with two different identifiers; neither is a label
        # and neither is an element type.
        '.matching(identifier: "composer.attachment").firstMatch',
        '.matching(identifier: "session.messageAttachments").firstMatch',
        'LifecycleDiagnostics.emit(.attachmentStaged)',
        'LifecycleDiagnostics.emit(.sendPerformed)',
        'LifecycleDiagnostics.emit(.imagePromptPersisted)',
        # The document-browser attach path names every rung from the durable
        # baseline to the picked row, including the picker's own failure as
        # a terminal branch, so a files run says where it stopped.
        '.matching(identifier: "composer.attachFile").firstMatch',
        '.matching(identifier: "composer.attachError").firstMatch',
        'LifecycleDiagnostics.emit(.baselineRead)',
        'LifecycleDiagnostics.emit(.attachFileShown)',
        'LifecycleDiagnostics.emit(.attachFileTapped)',
        'LifecycleDiagnostics.emit(.filePickerFailed)',
        'LifecycleDiagnostics.emit(.fileRowTapped)',
        # A committed search and Browse/Back navigation drive a browser
        # that opened into the wrong location; the Back run is gated on
        # picker evidence so it can never pop the session underneath.
        'app.keyboards.buttons["Search"]',
        'hittableLabelled("Browse")',
        'LifecycleDiagnostics.emit(.browseOpened)',
        'LifecycleDiagnostics.emit(.backOutUsed)',
        # A matchless search hides the browser chrome; Cancel exits search
        # mode (or dismisses to a fresh presentation), bounded once and
        # search-gated so it can never be something else's Cancel.
        'hittableLabelled("Cancel")',
        'LifecycleDiagnostics.emit(.searchCancelled)',
        # The cancel gate has to cancel something: the Stop control exists
        # only while a turn runs, so a pass that never saw one interrupted
        # nothing, and the halt is a status row rather than a static text.
        # The cancel gate proves a live round trip before arming the long
        # turn: sends park silently while the socket is still coming up and
        # die with the per-test relaunch, leaving no backend trace.
        'LifecycleDiagnostics.CancelStage.liveRoundTripShown',
        'LifecycleDiagnostics.CancelStage.liveRoundTripAbsent',
        'LifecycleDiagnostics.CancelStage.longTurnSendMissed',
        # A press that never happened must never read as a turn that ran:
        # the send resolves hittable-only and reports the miss.
        'tapAllHittable(identifier: "composer.send"',
        # The long turn is sequential tool work, not output text: a model
        # asked for lines answers in a second with a shorthand, while tool
        # round-trips are unshortcuttable wall time for the press to land in.
        'three largest text files',
        # Failure exits capture the post-auth screen they stopped on --
        # never login pixels -- so the next run reads state, not guesses.
        'capturePostAuth("wake-no-banner")',
        'capturePostAuth("cancel-no-interrupt")',
        'capturePostAuth("files-not-picked")',
        # Quiescence uses the app's own asleep rule, connection first:
        # opening on a stale column shows no banner with no 4420 to come.
        'podAsleepByAppDefinition',
        '.matching(identifier: "composer.interrupt").firstMatch',
        # Every press hits every hittable match with no sleep between resolve
        # and press and no frame read anywhere: the old gate died on its own
        # guard when the turn ended mid-gate, and wrapper presses report
        # success while doing nothing. Effect is always verified after.
        'tapAllHittable(identifier: "session.bannerAction"',
        'tapAllHittable(identifier: "composer.interrupt"',
        'tapAllHittable(identifier: "composer.attachFile"',
        'tapAllHittable(identifier: "workstation.retry"',
        'tapAllHittable(identifier: "workstation.cancel"',
        'hittableMatches(',
        'hittableLabelled(',
        'waitForSheetsGone(',
        '.matching(identifier: "workstation.wait").firstMatch',
        '.matching(identifier: "workstation.cancel").firstMatch',
        # The sheet census separates a press that presented nothing from a
        # grid that is present and unreadable.
        'emitSheetCount(',
        '.matching(identifier: "session.statusMessage")',
        'LifecycleDiagnostics.CancelStage.interruptTapped',
        'waitForTurnIdle(',
    ),
}

TYPE_BOUND = re.compile(
    r'\.(buttons|otherElements|staticTexts|textViews|textFields|images|cells|switches)'
    r'\[\s*"([^"]+)"\s*\]')
MUTABLE_ROW_LABEL = re.compile(
    r'app\.cells\.containing\(\s*NSPredicate\(format:\s*"label CONTAINS %@"')
WAKE_LABEL_QUERY = re.compile(
    r'NSPredicate\(format:\s*"label CONTAINS\[c\] %@",\s*"Wake"\)')
PHOTO_SOURCE_QUERY = re.compile(
    r'"Photo Library"|let\s+photosRow\s*=')
# The PHPicker asset grid is system UI: a credentialed run proved the app's
# own `.image` query reports the seeded asset absent with the sheet on screen.
# Binding the picker to one process AND one element type is the same class of
# mistake the guarded identifiers above exist to prevent.
APP_ONLY_PICKER_QUERY = re.compile(
    r'app\.images\.matching\(\s*\n?\s*NSPredicate\(format:\s*"isHittable')
# The stream's own "You stopped this turn." is a status row, and a status row
# is `.accessibilityElement(children: .combine)`: one collapsed element, not a
# static text. Matching a localized sentence through a type-bound query is both
# assumptions at once.
STOPPED_LABEL_QUERY = re.compile(
    r'app\.staticTexts\.matching\(\s*\n?\s*'
    r'NSPredicate\(format:\s*"label CONTAINS\[c\] %@",\s*"stopped"\)')


def violations(text):
    """Every guarded identifier reached through a type-bound subscript."""
    found = []
    for match in TYPE_BOUND.finditer(text):
        # Code-shaped prose in a Swift line comment is not a query. Keep line
        # count intact and reject only executable occurrences.
        line_start = text.rfind("\n", 0, match.start()) + 1
        comment = text.find("//", line_start, match.start())
        if comment != -1:
            continue
        element_type, identifier = match.group(1), match.group(2)
        if identifier in GUARDED:
            line = text[:match.start()].count("\n") + 1
            found.append((line, identifier, element_type))
    return found


def check(source, text, require=True):
    problems = []
    for line, identifier, element_type in violations(text):
        problems.append(
            f"{source}:{line}: '{identifier}' queried as .{element_type}[...]; "
            "match its accessibility identifier without assuming an element type")
    if source == "PiPodUITests/SessionLifecycleTests.swift":
        for match in MUTABLE_ROW_LABEL.finditer(text):
            line = text[:match.start()].count("\n") + 1
            problems.append(
                f"{source}:{line}: fixture identity depends on mutable row label; "
                "resolve the short id and match pod.row.<full uuid>")
        for match in WAKE_LABEL_QUERY.finditer(text):
            line = text[:match.start()].count("\n") + 1
            problems.append(
                f"{source}:{line}: Wake depends on a localized label; "
                "match session.bannerAction by identifier")
        for match in PHOTO_SOURCE_QUERY.finditer(text):
            line = text[:match.start()].count("\n") + 1
            problems.append(
                f"{source}:{line}: PhotosPicker depends on an optional source row; "
                "select the seeded asset directly")
        for match in APP_ONLY_PICKER_QUERY.finditer(text):
            line = text[:match.start()].count("\n") + 1
            problems.append(
                f"{source}:{line}: the PHPicker grid is bound to one process and "
                "one element type; poll every owner and both shapes")
        for match in STOPPED_LABEL_QUERY.finditer(text):
            line = text[:match.start()].count("\n") + 1
            problems.append(
                f"{source}:{line}: the halt depends on a localized sentence in a "
                "static text; match session.statusMessage by identifier")
    if require:
        for fragment in REQUIRED.get(source, ()):
            if fragment not in text:
                problems.append(f"{source}: missing required identifier-only query: {fragment}")
    return problems


def selftest() -> int:
    # Both credentialed-run regressions must be caught exactly.
    regressed = '''
        let session = app.otherElements["session.podDetails"].exists
            || app.staticTexts["session.podDetails"].exists
        let composer = app.textViews["composer.field"]
    '''
    problems = check("fixture.swift", regressed, require=False)
    assert sum("session.podDetails" in p for p in problems) == 2, problems
    assert sum("composer.field" in p for p in problems) == 1, problems
    assert any("textViews" in p for p in problems), problems

    # Every guarded identifier is protected for every common query type.
    for identifier in GUARDED:
        assert violations(f'app.buttons["{identifier}"].exists'), identifier
        assert violations(f'app.textFields["{identifier}"].exists'), identifier

    # Identifier-only lookups pass.
    fixed = '''
        emit(probeExists(app, "session.podDetails") ? .shown : .absent)
        emit(probeExists(app, "composer.field") ? .shown : .absent)
        let composer = app.descendants(matching: .any)
            .matching(identifier: "composer.field").firstMatch
    '''
    assert check("fixture.swift", fixed, require=False) == []

    # R4 regression: a first prompt auto-renames the durable pod row, so a
    # suffix-label locator cannot be fixture identity.
    mutable = '''
        let row = app.cells.containing(
            NSPredicate(format: "label CONTAINS %@", tail)).firstMatch
    '''
    assert any("mutable row label" in p for p in check(
        "PiPodUITests/SessionLifecycleTests.swift", mutable, require=False))

    sleeping_and_files_regressed = '''
        let wake = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Wake")).firstMatch
        let photosRow = app.cells.firstMatch
        let source = "Photo Library"
    '''
    regressed_problems = check(
        "PiPodUITests/SessionLifecycleTests.swift",
        sleeping_and_files_regressed, require=False)
    assert any("localized label" in p for p in regressed_problems), regressed_problems
    assert any("optional source row" in p for p in regressed_problems), regressed_problems

    # The exact query a credentialed run proved blind to the seeded asset,
    # on one line and wrapped, because it was wrapped when it shipped.
    for regressed in (
        'let firstPhoto = app.images.matching(NSPredicate(format: "isHittable == true"))',
        'let firstPhoto = app.images.matching(\n'
        '            NSPredicate(format: "isHittable == true")).firstMatch',
    ):
        problems = check("PiPodUITests/SessionLifecycleTests.swift",
                         regressed, require=False)
        assert any("one element type" in p for p in problems), regressed

    # R5 regressions: the PhotosPicker read as a Button, and the interrupt's
    # halt read as a static text carrying an English sentence.
    files_and_cancel_regressed = '''
        let attach = app.buttons["composer.attach"]
        let interrupt = app.buttons["composer.interrupt"]
        let halted = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "stopped")).firstMatch
    '''
    regressed_problems = check("PiPodUITests/SessionLifecycleTests.swift",
                               files_and_cancel_regressed, require=False)
    assert sum("composer.attach" in p for p in regressed_problems) == 1, regressed_problems
    assert sum("composer.interrupt" in p for p in regressed_problems) == 1, regressed_problems
    assert any("localized sentence" in p for p in regressed_problems), regressed_problems

    # Required-shape checks prevent a vacuous pass after deleting the query.
    for source, fragments in REQUIRED.items():
        assert check(source, "", require=True), source
        assert check(source, "\n".join(fragments), require=True) == [], source

    # Code-shaped comments and unrelated identifiers remain out of scope.
    assert violations('// app.textViews["composer.field"].exists') == []
    assert violations('app.cells["pod.row.01a0"].exists') == []

    workflow_good = '''
      ui-live:
      - name: Closed assistant fixture readiness (full mode only)
        run: |
          python3 scripts/check_assistant_fixture.py
      - name: Force sleeping fixture asleep (server-API companion, full mode only)
      - name: Build and run live UI tests (Release app behavior)
    '''
    assert check_workflow("workflow.yml", workflow_good) == []
    assert check_workflow("workflow.yml", workflow_good.replace(
        "      - name: Closed assistant fixture readiness (full mode only)\n        run: |\n          python3 scripts/check_assistant_fixture.py\n", ""))

    print("selftest: lifecycle queries use stable identifiers without type assumptions")
    return 0


def check_workflow(source, text):
    problems = []
    job = text.find("  ui-live:")
    preflight = text.find("- name: Closed assistant fixture readiness", job)
    runtime = text.find("python3 scripts/check_assistant_fixture.py", preflight)
    sleeping = text.find("- name: Force sleeping fixture asleep", job)
    xctest = text.find("- name: Build and run live UI tests", job)
    if min(job, preflight, runtime, sleeping, xctest) < 0:
        problems.append(f"{source}: missing closed assistant fixture preflight wiring")
    elif not (job < preflight <= runtime < sleeping < xctest):
        problems.append(f"{source}: assistant fixture preflight must precede fixture mutation and XCTest")
    return problems


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        return selftest()
    paths = sys.argv[1:] or list(SOURCES)
    problems = []
    for value in paths:
        path = pathlib.Path(value)
        problems.extend(check(value, path.read_text(), require=value in REQUIRED))
    workflow = pathlib.Path(".github/workflows/ui-live.yml")
    if workflow.exists():
        problems.extend(check_workflow(str(workflow), workflow.read_text()))
    if problems:
        for problem in problems:
            print(problem)
        return 1
    print("lifecycle queries: stable identifiers, no guarded type assumptions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
