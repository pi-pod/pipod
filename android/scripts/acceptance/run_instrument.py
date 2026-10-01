#!/usr/bin/env python3
"""Fail-closed `am instrument` for smoke and live. adb exit 0 is not success."""
from __future__ import annotations

import argparse
import subprocess

from hosted_sdk import sdk_root, tool as hosted_tool
from instrument_result import RUNNER, classify_crash, parse_instrument

SERIAL = "emulator-5554"
DEFAULT_TIMEOUT_S = 180
LOGCAT_TIMEOUT_S = 15


def _adb() -> str:
    return str(hosted_tool(sdk_root(), "adb"))


def _run(adb: str, args: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [adb, "-s", SERIAL, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def classify_and_exit(adb: str, reason: str) -> None:
    try:
        dump = _run(
            adb,
            [
                "logcat",
                "-d",
                "-b",
                "crash",
                "-b",
                "main",
                "-s",
                "AndroidRuntime:E",
                "TestRunner:E",
                "AndroidJUnitRunner:E",
            ],
            LOGCAT_TIMEOUT_S,
        )
        blob = (dump.stdout or "") + (dump.stderr or "")
    except subprocess.TimeoutExpired:
        blob = ""
    print("crash_logcat_bytes", len(blob), flush=True)
    klass, site = classify_crash(blob)
    print("crash_class", klass, "crash_site", site, flush=True)
    raise SystemExit(reason)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--class", dest="cls", required=True)
    ap.add_argument("--test", dest="test", required=True)
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S)
    ap.add_argument("-e", action="append", default=[], metavar="KEY=VAL")
    args = ap.parse_args()
    extras: list[str] = []
    extra_keys: list[str] = []
    for item in args.e:
        if "=" not in item:
            raise SystemExit("instrument extra must be key=value")
        key, _val = item.split("=", 1)
        extras.extend(["-e", key, _val])
        extra_keys.append(key)
    if extra_keys:
        print("instrument_extras", ",".join(extra_keys), flush=True)
    adb = _adb()
    try:
        _run(adb, ["logcat", "-c"], LOGCAT_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise SystemExit("logcat clear timed out") from None
    class_arg = f"{args.cls}#{args.test}"
    cmd = [
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        *extras,
        "-e",
        "class",
        class_arg,
        RUNNER,
    ]
    try:
        proc = _run(adb, cmd, args.timeout)
    except subprocess.TimeoutExpired:
        classify_and_exit(adb, "instrument timed out")
        return
    text = (proc.stdout or "") + (proc.stderr or "")
    try:
        result = parse_instrument(text, expected_class=args.cls, expected_test=args.test)
    except SystemExit as exc:
        classify_and_exit(adb, str(exc))
        return
    print(
        "instrument_ok",
        result["class"],
        "test",
        result["test"],
        "tests",
        result["tests"],
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — fail closed, no stack dump
        raise SystemExit(f"instrument runner failed: {type(exc).__name__}") from exc
