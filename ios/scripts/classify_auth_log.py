#!/usr/bin/env python3
"""Values-free classifier for ONE archived auth-run log (job-scoped).

Reads the log from STDIN into process memory only. NEVER writes the log,
never prints lines/context/URLs/credentials/screenshots/hashes. Output is
a fixed JSON object of closed enums, booleans and counts.

Scope: LoginTests start/finish plus known Xcode/runner/test-bundle
failure categories and the source-known assertion sites of
PiPodUITests/LoginTests.swift. Unrecognized content is discarded and never
emitted or retained in the result.

Usage (Root only, after reviewing this file):
    gh run view <run> --log --job <job-id> 2>/dev/null | python3 classify_auth_log.py
    python3 classify_auth_log.py --selftest   # hostile-string proof, no log needed
"""
import json
import re
import sys

SCHEMA = "ios-auth-diagnostic/v9"

# --- fixed matchers: known xcodebuild/xctest runner lines (structure only)
RE_TEST_STARTED = re.compile(
    r"Test Case '-\[\w+\.LoginTests test\w+\]' started\.?")
RE_TEST_PASSED = re.compile(
    r"Test Case '-\[\w+\.LoginTests test\w+\]' passed \([^)]*\)\.?")
RE_TEST_FAILED = re.compile(
    r"Test Case '-\[\w+\.LoginTests test\w+\]' failed \([^)]*\)\.?")
RE_SUITE_STARTED = re.compile(r"Test Suite 'LoginTests' started")
RE_SUITE_FINISHED = re.compile(r"Test Suite 'LoginTests' (finished|failed)")

# --- known failure categories (runner/toolchain/bundle level)
CATEGORIES = (
    ("build_error", re.compile(r"\berror:\s.*SwiftCompile|error: cannot |error: type .* has no member|Command CodeSign failed|Code Signing Error")),
    # Must match genuine signing FAILURES only. The bare tokens `CodeSign`,
    # `CODE_SIGN` and `provisioning profile` also occur in the workflow's own
    # build settings (`CODE_SIGN_IDENTITY=-`, `CODE_SIGNING_REQUIRED=NO`,
    # `CODE_SIGNING_ALLOWED=YES`), which xcodebuild echoes into the log. Run
    # 35109477223 reported signing_error=7 purely from that echo while the app
    # built, installed and completed nine real logins, so the counter has to
    # require failing context or it misdirects every future triage.
    ("signing_error", re.compile(
        r"Command CodeSign failed|Code Signing Error|code signing is required"
        r"|No signing certificate|no valid provisioning profile"
        r"|requires a provisioning profile|requires a development team"
        r"|Failed to code ?sign|errSecInternalComponent")),
    ("simulator_error", re.compile(r"Unable to find a device|simulator.*(unavailable|failed|error)|SimDevice|bootstatus|xcrun simctl")),
    ("bundle_load_error", re.compile(r"bundle.*(could not be loaded|failed to load|not found)|dlopen.*PiPodUITests|test bundle.*(error|fail)")),
    ("test_runner_crash", re.compile(r"xctest.*(crashed|terminated|abort)|Test runner exited|early unexpected exit|Lost connection to testmanagerd")),
    ("timeout_cancelled", re.compile(r"cancelled|canceling|timed out|Timeout|deadline|maximum execution time")),
    ("no_tests_executed", re.compile(r"No tests (were )?executed|Executed 0 tests|Test session results.*0 tests|nothing to test")),
    ("scheme_selection", re.compile(r"test plan.*(not found|error)|scheme .* (not found|error)|-only-testing.*(invalid|error|not found)|Unable to find (a )?test")),
    ("xcodebuild_failed", re.compile(r"xcodebuild.*(failed|error)|error: Process completed with exit code|BUILD FAILED")),
)

# --- source-known assertion sites (LoginTests.swift failure messages) ---
ASSERT_SITES = (
    ("assert_signin_screen", "sign-in screen shown"),
    ("assert_webview", "auth web view appeared"),
    ("assert_username_field", "username field present"),
    ("assert_username_ready", "username field enabled and hittable"),
    ("assert_username_committed", "username input committed"),
    ("assert_username_advance", "username transition exact control ready"),
    ("assert_username_advance_effect", "username advance tap produced navigation effect"),
    ("assert_username_staged", "username staged phase completed"),
    ("assert_password_field", "password field present"),
    ("assert_password_ready", "password field enabled and hittable"),
    ("assert_password_entry", "password entry gate accepted"),
    ("assert_enter_submit", "single password Return submit performed"),
    ("assert_callback", "auth callback boundary received after password Enter"),
    ("assert_landing", "authenticated pod list shown after PKCE"),
)


def classify(text):
    counts = {name: 0 for name, _ in CATEGORIES}
    sites = {name: 0 for name, _ in ASSERT_SITES}
    started = finished = 0
    passed = failed = 0
    suite_started = suite_finished = False
    for line in text.split("\n"):
        if RE_TEST_STARTED.search(line):
            started += 1
        if RE_TEST_PASSED.search(line):
            passed += 1
        if RE_TEST_FAILED.search(line):
            failed += 1
        if RE_SUITE_STARTED.search(line):
            suite_started = True
        if RE_SUITE_FINISHED.search(line):
            suite_finished = True
        for name, pattern in CATEGORIES:
            if pattern.search(line):
                counts[name] += 1
        for name, needle in ASSERT_SITES:
            if needle in line:
                sites[name] += 1
    login_result = "absent"
    if passed and not failed:
        login_result = "passed"
    elif failed:
        login_result = "failed"
    elif started:
        login_result = "unfinished"
    return {
        "schema": SCHEMA,
        "login_started": started,
        "login_finished": passed + failed,
        "login_result": login_result,
        "suite_started": suite_started,
        "suite_finished": suite_finished,
        "categories": counts,
        "assertion_sites": sites,
    }


def selftest() -> int:
    """Hostile-string proof: injected secrets/URLs/traps must never surface."""
    hostile = [
        "https://auth.example.com/oauth/v2/authorize?code=SUPERSECRETCODE123",
        "password=hunter2-hunter2 password=correct-horse hunter2",
        "UITEST_PASSWORD=s3cr3t-value-never-print",
        "Test Case '-[PiPodUITests.LoginTests testLoginRealPKCE]' started.",
        "Test Case '-[PiPodUITests.LoginTests testLoginRealPKCE]' passed (1.234 seconds).",
        "error: password hunter2 failed",
        "Command CodeSign failed with a nonzero exit code hunter2",
        # The harness's OWN build settings: these must NOT be counted as a
        # signing error (regression guard for the v8 false positive).
        "CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES",
        "    CODE_SIGNING_ALLOWED = YES;",
        "/Users/runner/work/secret-path/mysecret.mobileprovision hunter2",
        "sign-in screen shown hunter2",
        "username field enabled and hittable hunter2",
        "username input committed hunter2",
        "username transition exact control ready hunter2",
        "username advance tap produced navigation effect hunter2",
        "username staged phase completed hunter2",
        "password field present hunter2",
        "password field enabled and hittable hunter2",
        "password entry gate accepted hunter2",
        "single password Return submit performed hunter2",
        "auth callback boundary received after password Enter hunter2",
        "Bearer hunter2-token-value",
        "screenshot login.png hunter2",
        "a" * 5000,
        "",
        "Test Suite 'LoginTests' started",
        "Test Suite 'LoginTests' finished",
        "Executed 0 tests, with 0 failures",
        "error: SwiftCompile hunter2",
    ]
    out = classify("\n".join(hostile))
    blob = json.dumps(out)
    for trap in ("SUPERSECRETCODE123", "hunter2", "s3cr3t", "Bearer",
                 "mobileprovision", "secret-path", "aaaa"):
        if trap in blob:
            print(f"SELFTEST FAIL: trapped value leaked: {trap[:12]}")
            return 1
    assert out["login_started"] == 1, out
    assert out["login_finished"] == 1, out
    assert out["login_result"] == "passed", out
    assert out["suite_started"] is True and out["suite_finished"] is True
    assert out["categories"]["build_error"] >= 1, out
    # exactly the one genuine failure line, not the three benign flag lines
    assert out["categories"]["signing_error"] == 1, out
    benign = classify("\n".join((
        "CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES",
        "    CODE_SIGN_IDENTITY = -;",
        "    CODE_SIGNING_REQUIRED = NO;",
        "    CODE_SIGNING_ALLOWED = YES;",
        "    PROVISIONING_PROFILE_SPECIFIER = ;",
    )))
    assert benign["categories"]["signing_error"] == 0, benign
    assert out["categories"]["no_tests_executed"] >= 1, out
    assert out["assertion_sites"]["assert_signin_screen"] >= 1, out
    assert out["assertion_sites"]["assert_username_ready"] == 1, out
    assert out["assertion_sites"]["assert_username_committed"] == 1, out
    assert out["assertion_sites"]["assert_username_advance"] == 1, out
    assert out["assertion_sites"]["assert_username_advance_effect"] == 1, out
    assert out["assertion_sites"]["assert_username_staged"] == 1, out
    assert out["assertion_sites"]["assert_password_field"] == 1, out
    assert out["assertion_sites"]["assert_password_ready"] == 1, out
    assert out["assertion_sites"]["assert_password_entry"] == 1, out
    assert out["assertion_sites"]["assert_enter_submit"] == 1, out
    assert out["assertion_sites"]["assert_callback"] == 1, out
    # empty input: all zeros, absent result, still closed shape
    empty = classify("")
    assert empty["login_started"] == 0 and empty["login_result"] == "absent"
    assert all(v == 0 for v in empty["categories"].values())
    assert all(v == 0 for v in empty["assertion_sites"].values())
    assert set(empty["assertion_sites"]) == {name for name, _ in ASSERT_SITES}
    assert set(empty) == {"schema", "login_started", "login_finished",
                          "login_result", "suite_started", "suite_finished",
                          "categories", "assertion_sites"}
    print("selftest: hostile strings contained, counts exact, shape closed")
    return 0


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        return selftest()
    text = sys.stdin.read()
    print(json.dumps(classify(text), indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
