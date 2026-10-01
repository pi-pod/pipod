#!/usr/bin/env python3
"""Tell a runner that never started from a test that ran and failed.

`xcodebuild test` answers rc=65 for both "your assertion failed" and "the
XCTest runner could not initialize UI testing on this simulator". The second is
a GitHub-hosted simulator fault — the canonical shape is

    Failed to initialize for UI testing: Error Domain=XCTDaemonErrorDomain
    Code=19 "Failed call to AXDisableAccessibilityOnTermination:
    kAXErrorCannotComplete"

— and no test case ever executed, so retrying costs nothing and loses nothing.
An assertion failure must never be retried, so the verdict is retryable ONLY
when an init marker is present AND the log shows no executed test case at all.

Values-free: the log is read from stdin (it may carry credentials in other
jobs) and only counts of FIXED marker strings are printed. No log line, no
error text, no path and no identifier can leave this script.

Exit 0 = retryable runner-init failure. Any other exit = do not retry.
"""
import json
import sys

SCHEMA = "ios-test-runner-init/v1"

# Fixed substrings. Presence is counted; nothing around them is read.
INIT_MARKERS = {
    "ui-testing-init": "Failed to initialize for UI testing",
    "ax-disable-on-termination": "AXDisableAccessibilityOnTermination",
    "ax-cannot-complete": "kAXErrorCannotComplete",
    "runner-never-began": "Test runner never began executing tests",
    "lost-connection": "Lost connection to the test manager service",
}

# Evidence that the runner DID come up and tests actually ran. Any of these
# makes the failure a real result, never an infrastructure retry.
EXECUTION_MARKERS = {
    "test-case-line": "Test Case '",
    "test-suite-line": "Test Suite '",
}


def classify(text):
    init = {name: text.count(marker) for name, marker in INIT_MARKERS.items()}
    executed = {name: text.count(marker) for name, marker in EXECUTION_MARKERS.items()}
    any_init = any(count > 0 for count in init.values())
    any_executed = any(count > 0 for count in executed.values())
    if any_executed:
        outcome = "tests-executed"
    elif any_init:
        outcome = "runner-init-failure"
    else:
        outcome = "no-init-marker"
    return {
        "schema": SCHEMA,
        "outcome": outcome,
        "retryable": outcome == "runner-init-failure",
        "init_markers": init,
        "execution_markers": executed,
    }


def selftest() -> int:
    hostile = "\n".join([
        "UITEST_PASSWORD=do-not-print https://example.invalid/?code=secret",
        "Authorization: Bearer private-value",
        "2026-01-01 PiPodUITests-Runner[1:2] [Default] Failed to initialize for "
        "UI testing: Error Domain=XCTDaemonErrorDomain Code=19 \"Failed call to "
        "AXDisableAccessibilityOnTermination: kAXErrorCannotComplete\"",
        "** TEST FAILED **",
    ])
    out = classify(hostile)
    blob = json.dumps(out)
    for trap in ("do-not-print", "example.invalid", "secret", "Bearer",
                 "XCTDaemonErrorDomain", "TEST FAILED"):
        if trap in blob:
            print("selftest: runner-init value escaped", file=sys.stderr)
            return 1
    if out["outcome"] != "runner-init-failure" or not out["retryable"]:
        print("selftest: AX init failure was not recognised", file=sys.stderr)
        return 1

    # An init marker beside a test that actually ran is a real failure: the
    # runner came up, so a retry would re-run a genuine assertion result.
    ran = hostile + "\nTest Case '-[GateTests testLiveInputsPresent]' started.\n"
    out = classify(ran)
    if out["outcome"] != "tests-executed" or out["retryable"]:
        print("selftest: executed tests must never be retried", file=sys.stderr)
        return 1

    # An ordinary assertion failure carries no init marker and is not retried.
    plain = "Test Suite 'PiPodUITests' started at 2026-01-01\n** TEST FAILED **\n"
    out = classify(plain)
    if out["outcome"] != "tests-executed" or out["retryable"]:
        print("selftest: plain failure must never be retried", file=sys.stderr)
        return 1

    # A silent log is not an init failure either: fail closed, do not retry.
    out = classify("")
    if out["outcome"] != "no-init-marker" or out["retryable"]:
        print("selftest: empty log must not be retried", file=sys.stderr)
        return 1

    print("selftest: runner-init verdict is values-free and retries only pre-test faults")
    return 0


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        return selftest()
    verdict = classify(sys.stdin.read())
    print(json.dumps(verdict, indent=1, sort_keys=True))
    return 0 if verdict["retryable"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
