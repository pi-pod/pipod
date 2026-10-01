#!/usr/bin/env python3
"""Fail-closed parse of `am instrument -r` output. adb exit 0 is not success."""
from __future__ import annotations

import re

EXPECTED_CLASS = "com.pipod.app.features.auth.AuthGateRestoreTest"
EXPECTED_TEST = "navigatingBetweenTabsDoesNotRestoreAgain"
RUNNER = "com.pipod.test/androidx.test.runner.AndroidJUnitRunner"

_STATUS_CLASS = re.compile(r"^INSTRUMENTATION_STATUS: class=(.+)$", re.M)
_STATUS_TEST = re.compile(r"^INSTRUMENTATION_STATUS: test=(.+)$", re.M)
_NUMTESTS = re.compile(r"^INSTRUMENTATION_STATUS: numtests=(\d+)$", re.M)
_STATUS_CODE = re.compile(r"^INSTRUMENTATION_STATUS_CODE:\s*(-?\d+)\s*$", re.M)
_SESSION_CODE = re.compile(r"^INSTRUMENTATION_CODE:\s*(-?\d+)\s*$", re.M)
_OK_TESTS = re.compile(r"^OK \((\d+) tests?\)$", re.M)
_PROCESS_LINE = re.compile(r"Process: ([a-zA-Z0-9._]+)")


def parse_instrument(
    text: str,
    expected_class: str = EXPECTED_CLASS,
    expected_test: str = EXPECTED_TEST,
    expected_count: int = 1,
) -> dict[str, str | int]:
    blob = text.replace("\r\n", "\n")
    if not blob.strip():
        raise SystemExit("instrument output empty")
    if "Process crashed" in blob:
        raise SystemExit("instrument process crashed")
    if "INSTRUMENTATION_FAILED" in blob:
        raise SystemExit("instrumentation failed")
    if "INSTRUMENTATION_RESULT: shortMsg=" in blob:
        raise SystemExit("instrument shortMsg without passing tests")
    if re.search(r"FAILURES!!!", blob) or re.search(r"^Error in ", blob, re.M):
        hint = ""
        lines = blob.splitlines()
        for i, ln in enumerate(lines):
            low = ln.strip()
            if not low.startswith("Error in ") and "AssertionError" not in ln:
                continue
            nxt = ""
            for nln in lines[i + 1 : i + 8]:
                if any(
                    s in nln
                    for s in (
                        "java.",
                        "IllegalState",
                        "AssertionError",
                        "NoSuchMethod",
                        "ActivityNotFound",
                    )
                ):
                    nxt = nln.strip()[:160]
                    break
            hint = (low + " " + nxt).strip()[:220]
            break
        if hint:
            print("instrument_error", hint, flush=True)
        raise SystemExit("instrument reported failures")
    if re.search(r"tests? ignored", blob, re.I):
        raise SystemExit("instrument ignored tests")

    codes = [int(x) for x in _SESSION_CODE.findall(blob)]
    if not codes:
        raise SystemExit("instrument missing completion")
    if codes[-1] != -1:
        raise SystemExit(f"instrument session code {codes[-1]} (want -1)")

    classes = [c.strip() for c in _STATUS_CLASS.findall(blob)]
    if expected_class not in classes:
        raise SystemExit(f"instrument did not run {expected_class}")

    tests = [t.strip() for t in _STATUS_TEST.findall(blob)]
    if expected_test not in tests:
        raise SystemExit(f"instrument did not run {expected_test}")

    nums = [int(n) for n in _NUMTESTS.findall(blob)]
    if not nums or max(nums) < 1:
        raise SystemExit("instrument zero tests")
    if max(nums) != expected_count:
        raise SystemExit(f"instrument numtests {max(nums)} want {expected_count}")

    status_codes = [int(x) for x in _STATUS_CODE.findall(blob)]
    if 0 not in status_codes:
        raise SystemExit("instrument test did not complete OK")
    if any(c in (-1, -2, -3) for c in status_codes):
        raise SystemExit("instrument test status not OK")

    ok = _OK_TESTS.search(blob)
    if not ok:
        raise SystemExit("instrument missing OK test count")
    if int(ok.group(1)) != expected_count:
        raise SystemExit(f"instrument OK count {ok.group(1)} want {expected_count}")

    return {
        "class": expected_class,
        "test": expected_test,
        "tests": int(ok.group(1)),
        "code": -1,
    }


def classify_crash(logcat: str) -> tuple[str, str]:
    """Return (crash_class, crash_site) from app/test FATAL only. No dump."""
    blob = logcat.replace("\r\n", "\n")
    procs = set(_PROCESS_LINE.findall(blob))
    if procs and not (("com.pipod" in procs) or ("com.pipod.test" in procs)):
        return "unknown", "none"
    fatal = None
    for m in re.finditer(
        r"FATAL EXCEPTION:.*?(?=\n[A-Z]|\Z)",
        blob,
        re.S,
    ):
        block = m.group(0)
        if "com.pipod" not in block and "AndroidJUnitRunner" not in block:
            continue
        fatal = block
        break
    if fatal is None:
        if "FATAL EXCEPTION" in blob and "com.pipod" in blob:
            fatal = blob
        else:
            return "unknown", "none"
    caused = list(
        re.finditer(
            r"(?:Caused by: )?((?:[a-zA-Z0-9_$.]+)(?:Error|Exception|Throwable))([^\n]*)",
            fatal,
        )
    )
    crash_class = "unknown"
    if caused:
        crash_class = caused[-1].group(1).rsplit(".", 1)[-1]
        if crash_class in {"Exception", "RuntimeException"} and len(caused) > 1:
            crash_class = caused[-1].group(1).rsplit(".", 1)[-1]
        # Prefer innermost specific class.
        crash_class = caused[-1].group(1).rsplit(".", 1)[-1]
    site = "none"
    miss = re.search(r"Didn't find class \"([^\"]+)\"", fatal)
    if miss:
        site = miss.group(1)
    elif (cnf := re.search(r"ClassNotFoundException: ([^\n]+)", fatal)):
        site = cnf.group(1).strip().strip(".")
    elif (app := re.search(r"at (com\.pipod\.[a-zA-Z0-9_$.]+)\(", fatal)):
        site = app.group(1)
    elif (lib := re.search(
        r"at ((?:androidx\.(?:compose|test|activity)\.)[a-zA-Z0-9_$.]+)\(",
        fatal,
    )):
        site = lib.group(1)
    return crash_class, site
