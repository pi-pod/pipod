#!/usr/bin/env python3
"""Closed projector for the public pre-credential system-auth boundary.

Reads only the xcresult test tree and emits one fixed-schema JSON summary.
No failure messages, activities, page content, URLs, attachments or arbitrary
node names can be emitted. This is explicitly not an auth/full acceptance
summary.
"""
import json
import os
import subprocess
import sys

SCHEMA = "ios-auth-system-boundary/v1"
TEST_NAME = "testSystemConsentToIdPUsernameBoundary()"
CLOSED = {
    "Passed": "Success",
    "Failed": "Failure",
    "Skipped": "Skipped",
    "Expected Failure": "Expected Failure",
    "Success": "Success",
    "Failure": "Failure",
}


def walk(node, rows):
    if isinstance(node, dict):
        name = node.get("name")
        if name == TEST_NAME[:-2]:
            name = TEST_NAME
        status = node.get("result", node.get("testStatus"))
        if (node.get("nodeType") == "Test Case" and name == TEST_NAME
                and isinstance(status, str) and status in CLOSED):
            rows.append(CLOSED[status])
        for key in ("children", "testNodes", "tests", "subtests", "devices"):
            value = node.get(key)
            if isinstance(value, list):
                for child in value:
                    walk(child, rows)
        summaries = node.get("summaries")
        if isinstance(summaries, dict):
            for child in summaries.get("_allValues") or []:
                walk(child, rows)
        elif isinstance(summaries, list):
            for child in summaries:
                walk(child, rows)
    elif isinstance(node, list):
        for child in node:
            walk(child, rows)


def project(tree):
    rows = []
    walk(tree, rows)
    statuses = set(rows)
    if len(rows) != 1 or len(statuses) != 1:
        return None
    status = rows[0]
    return {
        "schema": SCHEMA,
        "test": {"name": TEST_NAME, "status": status},
        "boundary": (
            "system-consent-to-idp-username-field"
            if status == "Success" else "not-established"
        ),
        "consent_owner": "com.apple.springboard",
        "browser_owner": "com.apple.SafariViewService",
        "credential_input": "none",
        "callback": "not-attempted",
        "auth_acceptance": "not-evaluated",
    }


def selftest() -> int:
    tree = {"testNodes": [
        {"nodeType": "Test Suite", "name": "untrusted suite",
         "result": "Passed", "children": [
             {"nodeType": "Test Case", "name": TEST_NAME,
              "result": "Failed", "children": [
                  {"nodeType": "Failure Message", "name": "secret text",
                   "result": "Failed"},
              ]},
             {"nodeType": "Test Case", "name": "arbitraryTest()",
              "result": "Passed"},
         ]},
    ]}
    out = project(tree)
    if (out is None or out["test"] != {"name": TEST_NAME, "status": "Failure"}
            or out["boundary"] != "not-established"):
        print("selftest: closed boundary projection failed", file=sys.stderr)
        return 1
    blob = json.dumps(out)
    if "secret text" in blob or "arbitraryTest" in blob:
        print("selftest: arbitrary boundary data escaped", file=sys.stderr)
        return 1
    print("selftest: boundary projection is fixed and closed")
    return 0


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        return selftest()
    xcresult = os.environ["XCRESULT_PATH"]
    out_dir = os.environ["BOUNDARY_SUMMARY_DIR"]
    proc = subprocess.run(
        ["xcrun", "xcresulttool", "get", "test-results", "tests",
         "--path", xcresult],
        capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        print("boundary projector: xcresulttool failed", file=sys.stderr)
        return 3
    try:
        tree = json.loads(proc.stdout)
    except json.JSONDecodeError:
        print("boundary projector: test tree was not JSON", file=sys.stderr)
        return 3
    summary = project(tree)
    if summary is None:
        print("boundary projector: exact test case unavailable", file=sys.stderr)
        return 2
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "summary.json"), "w") as handle:
        json.dump(summary, handle, indent=1, sort_keys=True)
        handle.write("\n")
    print("boundary projection: " + summary["test"]["status"])
    print("boundary acceptance: not-evaluated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
