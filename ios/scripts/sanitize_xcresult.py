#!/usr/bin/env python3
"""Shared xcresult sanitizer: single copy used by the transport-check job
(secret-free, runs on PRs) and the live acceptance job.

Reads ONLY the closed `xcrun xcresulttool get test-results tests` tree
(the per-test tree endpoint — `summary` returns aggregates, not tests).
Publishes a NEW public file with closed {name, status} pairs, the SOURCE
COORDINATES of each failure (own-file basename and line number, never the
message), plus explicitly allowlisted post-auth screenshots. Raw bundles,
logs, xctestrun files and IdP-credential pixels never leave the runner.

Exit codes: 0 ok; 2 zero executed tests (fail closed); 3 xcresulttool error.
"""
import json
import os
import re
import subprocess
import sys

CLOSED = {"Passed": "Success", "Failed": "Failure", "Skipped": "Skipped",
          "Expected Failure": "Expected Failure",
          "Success": "Success", "Failure": "Failure"}


# Fixed source-known XCTest methods. The sanitizer never republishes an
# arbitrary xcresult node name, even when Xcode adds new node shapes.
SOURCE_TESTS = frozenset({
    "testEnvForwardingSentinelArrives",
    "testLiveInputsPresent",
    "testForwardedNameAllowlist",
    "testPasswordEntryEvidencePolicy",
    "testCompanionRouteContract",
    "testScopeAwareValidationMatrix",
    "testSystemConsentToIdPUsernameBoundary",
    "testLoginRealPKCE",
    "testPiPromptAssistantCorrelated",
    "testWakeReconnect4420Path",
    "testRearmRestoresAsleepPrecondition",
    "testBackgroundForegroundReconnect",
    "testWorkstationWaitCancelRetry",
    "testCancelRetryStream",
    "testFilesRoundTripStrict",
    "testBillingSurfacePerBackend",
    "testNotFoundResendsOnlyAfterExplicitContinueWithTheSameOperationID",
})
# Our own UI test sources. A failure message carries live text — element
# descriptions, labels, a pod's name — so none of it is republished; the
# `File.swift:line:` prefix it opens with is a SOURCE coordinate and is the
# only part projected. Restricting the basename to this set means an injected
# value can at worst impersonate a line number in a file we wrote.
SOURCE_FILES = frozenset({
    "AuthSystemBoundaryTests.swift",
    "GateTests.swift",
    "LifecycleDiagnostics.swift",
    "LoginTests.swift",
    "SessionLifecycleTests.swift",
    "LaunchRecoveryFakeUITests.swift",
    "SystemAuthUI.swift",
    "UITestConfig.swift",
})
FAILURE_SITE = re.compile(r"([A-Za-z0-9_+]+\.swift):([0-9]{1,6}):")
# A failed assertion is one site; a test that reports dozens is a runaway, and
# publishing all of them would only be noise.
MAX_SITES_PER_TEST = 20

SESSION_SCREENSHOT_TESTS = frozenset(
    name + "()" for name in SOURCE_TESTS
    if name not in {
        "testEnvForwardingSentinelArrives", "testLiveInputsPresent",
        "testForwardedNameAllowlist", "testPasswordEntryEvidencePolicy",
        "testCompanionRouteContract", "testScopeAwareValidationMatrix",
        "testLoginRealPKCE",
        "testSystemConsentToIdPUsernameBoundary",
        "testNotFoundResendsOnlyAfterExplicitContinueWithTheSameOperationID",
    }
)


def canonical_test_name(name):
    if not isinstance(name, str):
        return None
    base = name[:-2] if name.endswith("()") else name
    return base + "()" if base in SOURCE_TESTS else None


def failure_sites(text):
    """The own-source coordinates a failure message opens with, and nothing
    else from it. Returns closed `File.swift:line` strings."""
    if not isinstance(text, str):
        return []
    return [f"{name}:{int(line)}" for name, line in FAILURE_SITE.findall(text)
            if name in SOURCE_FILES]


def walk(node, rows, sites=None, test_name=""):
    """Project only typed Test Case nodes with allowlisted names/results.

    A failed Test Case is emitted even when it has Failure Message children;
    those children and every container type are only traversed, never emitted.
    Their text is read for source coordinates alone, under the current test.
    """
    if isinstance(node, dict):
        name = canonical_test_name(node.get("name"))
        status = node.get("result", node.get("testStatus"))
        current = test_name
        if (node.get("nodeType") == "Test Case" and name is not None
                and isinstance(status, str) and status in CLOSED):
            rows.append({"name": name, "status": CLOSED[status]})
            current = name
        if sites is not None and current:
            for site in failure_sites(node.get("name")):
                if node.get("nodeType") != "Test Case":
                    sites.setdefault(current, set()).add(site)
        for key in ("children", "testNodes", "tests", "subtests", "devices"):
            value = node.get(key)
            if isinstance(value, list):
                for child in value:
                    walk(child, rows, sites, current)
        summaries = node.get("summaries")
        if isinstance(summaries, dict):
            for item in (summaries.get("_allValues") or []):
                walk(item, rows, sites, current)
        elif isinstance(summaries, list):
            for item in summaries:
                walk(item, rows, sites, current)
    elif isinstance(node, list):
        for child in node:
            walk(child, rows, sites, test_name)


def selftest() -> int:
    """Synthetic hostile-shape checks plus source/allowlist synchronization."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    discovered = set()
    source_re = re.compile(r"^\s*func\s+(test[A-Za-z0-9_]+)\s*\(", re.MULTILINE)
    tests_dir = os.path.join(root, "PiPodUITests")
    for filename in os.listdir(tests_dir):
        if filename.endswith("Tests.swift"):
            with open(os.path.join(tests_dir, filename)) as handle:
                discovered.update(source_re.findall(handle.read()))
    if discovered != SOURCE_TESTS:
        print("selftest: source test allowlist is out of sync", file=sys.stderr)
        return 1

    files = {name for name in os.listdir(tests_dir) if name.endswith(".swift")}
    if files != SOURCE_FILES:
        print("selftest: source file allowlist is out of sync", file=sys.stderr)
        return 1

    # Source coordinates project; the message they are attached to does not,
    # and neither does a coordinate in a file we did not write.
    hostile = ("SessionLifecycleTests.swift:612: XCTAssertTrue failed - "
               "pod p-9d289a8341 named hunter2 Bearer SUPERSECRET "
               "/Users/runner/Secrets.swift:3: "
               "SessionLifecycleTests.swift:99999999:")
    if failure_sites(hostile) != ["SessionLifecycleTests.swift:612"]:
        print("selftest: failure site projection is not closed", file=sys.stderr)
        return 1
    if failure_sites(None) != [] or failure_sites("no coordinates here") != []:
        print("selftest: failure site projection invented a site", file=sys.stderr)
        return 1

    rows = []
    sites = {}
    walk({
        "nodeType": "Test Plan", "name": "arbitrary-container-name",
        "result": "Failed", "children": [
            {"nodeType": "Test Case",
             "name": "testEnvForwardingSentinelArrives()",
             "result": "Failed", "children": [
                 {"nodeType": "Failure Message",
                  "name": "untrusted failure text must not project",
                  "result": "Failed"},
                 {"nodeType": "Failure Message",
                  "name": "GateTests.swift:41: XCTAssertTrue failed - hunter2",
                  "result": "Failed"},
             ]},
            {"nodeType": "Failure Message",
             "name": "testLoginRealPKCE()", "result": "Failed"},
            {"nodeType": "Test Case", "name": "arbitraryTestName()",
             "result": "Passed"},
            {"name": "testLoginRealPKCE()", "result": "Passed"},
            {"nodeType": "Test Case", "name": "testLoginRealPKCE()",
             "result": "Unreviewed Status"},
        ],
    }, rows, sites)
    if rows != [{"name": "testEnvForwardingSentinelArrives()",
                 "status": "Failure"}]:
        print("selftest: typed closed projection failed", file=sys.stderr)
        return 1
    if sites != {"testEnvForwardingSentinelArrives()": {"GateTests.swift:41"}}:
        print("selftest: failure sites did not follow their test case",
              file=sys.stderr)
        return 1
    if "hunter2" in json.dumps(projected_sites(sites)):
        print("selftest: failure message text leaked", file=sys.stderr)
        return 1
    print("selftest: typed allowlist and closed projection passed")
    return 0


def projected_sites(sites):
    """Sorted, capped, de-duplicated coordinates per test."""
    return {name: sorted(found)[:MAX_SITES_PER_TEST]
            for name, found in sorted(sites.items()) if found}


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        return selftest()
    xcresult = os.environ["XCRESULT_PATH"]
    out_dir = os.environ["SANITIZED_DIR"]
    os.makedirs(out_dir, exist_ok=True)
    proc = subprocess.run(
        ["xcrun", "xcresulttool", "get", "test-results", "tests",
         "--path", xcresult],
        capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        print("xcresulttool tests command failed", file=sys.stderr)
        return 3
    try:
        tree = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print("tests output is not JSON", file=sys.stderr)
        return 3
    if isinstance(tree, dict):
        print("tree top-level keys: " + ",".join(sorted(tree.keys())))
    rows: list = []
    sites: dict = {}
    walk(tree, rows, sites)
    # Typed, allowlisted rows already exclude containers and messages. Same
    # test seen twice with CONFLICTING statuses fails (first-wins would hide
    # a rerun/flake); identical repeats de-duplicate.
    best: dict = {}
    for row in rows:
        prev = best.get(row["name"])
        if prev is not None and prev != row["status"]:
            print(f"conflicting statuses for {row['name']}: {prev} vs {row['status']}; failing closed",
                  file=sys.stderr)
            return 2
        best.setdefault(row["name"], row["status"])
    uniq = [{"name": name, "status": best[name]} for name in sorted(best)]
    if not uniq:
        print("projection found zero executed tests; failing closed", file=sys.stderr)
        return 2
    EXECUTED = {"Success", "Failure", "Expected Failure"}
    if not any(r["status"] in EXECUTED for r in uniq):
        print("projection is all-Skipped: zero executed tests; failing closed", file=sys.stderr)
        return 2
    # Only the coordinates of tests this projection actually reports.
    failed = {row["name"] for row in uniq if row["status"] == "Failure"}
    published_sites = {name: found for name, found
                       in projected_sites(sites).items() if name in failed}
    with open(os.path.join(out_dir, "summary.json"), "w") as handle:
        json.dump({"schema": "ios-ui-live-summary/v2", "tests": uniq,
                   "failure_sites": published_sites},
                  handle, indent=1, sort_keys=True)
        handle.write("\n")
    print(f"sanitized tests={len(uniq)}")
    for row in uniq:
        print(f"- {row['name']}: {row['status']}")
    # The assertion that stopped each failed test, as source coordinates. A
    # closed stage marker says how far a path got; this says which line ended
    # it, without republishing a word of the message it carried.
    for name in sorted(published_sites):
        print(f"- {name} failed at: {', '.join(published_sites[name])}")
    allowlisted = export_allowlisted(tree, out_dir)
    print(f"allowlisted post-auth screenshots: {allowlisted}")
    return 0


def export_allowlisted(tree, out_dir) -> int:
    """Copy ONLY postauth- PNGs owned by source-known session tests.
    Login/callback pixels, gate attachments and action logs stay on-runner."""
    kept = []

    def visit(node, test_name=""):
        if isinstance(node, dict):
            current = test_name
            if node.get("nodeType") == "Test Case":
                current = canonical_test_name(node.get("name")) or ""
            for att in (node.get("attachments") or []):
                if not isinstance(att, dict):
                    continue
                att_name = att.get("name") or att.get("filename") or ""
                if (att_name.startswith("postauth-")
                        and att.get("uti") == "public.png"
                        and current in SESSION_SCREENSHOT_TESTS):
                    ident = att.get("uuid") or att.get("id") or att.get("identifier") or ""
                    if (ident and re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.~-]*", ident)
                            and "/" not in ident and ident not in (".", "..")):
                        kept.append((current, ident))
            for key in ("children", "testNodes", "tests", "subtests", "devices"):
                value = node.get(key)
                if isinstance(value, list):
                    for child in value:
                        visit(child, current)
            summaries = node.get("summaries")
            if isinstance(summaries, dict):
                for item in (summaries.get("_allValues") or []):
                    visit(item, current)
        elif isinstance(node, list):
            for child in node:
                visit(child, test_name)

    visit(tree)
    count = 0
    # The xcresult path is re-derived by the caller via env; kept minimal here.
    import os as _os
    xcresult = _os.environ["XCRESULT_PATH"]
    for _, ident in kept:
        dest = os.path.join(out_dir, f"{ident}.png")
        proc = subprocess.run(
            ["xcrun", "xcresulttool", "get", "attachment", "--path",
             xcresult, "--id", ident, "--output-path", dest],
            capture_output=True, timeout=120)
        if proc.returncode == 0:
            count += 1
    return count


if __name__ == "__main__":
    sys.exit(main())
