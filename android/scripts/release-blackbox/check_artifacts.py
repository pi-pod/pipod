#!/usr/bin/env python3
"""Prove Release identity and the independent blackbox APK boundary."""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "acceptance"))

from hosted_sdk import sdk_root, tool as hosted_tool  # noqa: E402

TARGET_PACKAGE = "com.pipod"
HOST_PACKAGE = "com.pipod.releaseblackbox.runner"
TEST_PACKAGE = "com.pipod.releaseblackbox.runner.test"
RUNNER = "androidx.test.runner.AndroidJUnitRunner"
SIGNER_RE = re.compile(r"Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]+)")
PACKAGE_RE = re.compile(r"^package: name='([^']+)'", re.MULTILINE)
CLASS_MAPPING_RE = re.compile(r"^(\S+) -> (\S+):$")


def run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=60)
    if result.returncode != 0:
        raise SystemExit(f"artifact tool failed: {Path(command[0]).name} rc={result.returncode}")
    return (result.stdout or "") + (result.stderr or "")


def build_tool(name: str) -> Path:
    root = sdk_root()
    if name == "apksigner":
        return hosted_tool(root, name)
    found = sorted((root / "build-tools").glob(f"*/{name}"))
    if not found or not os.access(found[-1], os.X_OK):
        raise SystemExit(f"hosted {name} missing")
    return found[-1]


def package_name(aapt: Path, apk: Path) -> tuple[str, str]:
    badging = run([str(aapt), "dump", "badging", str(apk)])
    match = PACKAGE_RE.search(badging)
    if match is None:
        raise SystemExit(f"package identity missing: {apk.name}")
    return match.group(1), badging


def signer(apksigner: Path, apk: Path) -> str:
    output = run([str(apksigner), "verify", "--verbose", "--print-certs", str(apk)])
    match = SIGNER_RE.search(output)
    if match is None:
        raise SystemExit(f"signer digest missing: {apk.name}")
    return match.group(1).lower()


def instrumentation_identity(aapt: Path, test_apk: Path) -> tuple[str, str]:
    xml = run([str(aapt), "dump", "xmltree", str(test_apk), "AndroidManifest.xml"])
    target = re.search(r'android:targetPackage[^=]*="([^"]+)"', xml)
    runner = re.search(r'android:name[^=]*="([^"]*AndroidJUnitRunner)"', xml)
    if target is None or runner is None:
        raise SystemExit("test APK instrumentation identity missing")
    return target.group(1), runner.group(1)


def verify_r8_mapping(mapping: Path) -> int:
    obfuscated = 0
    saw_r8 = False
    with mapping.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream):
            if line_number < 20 and line.rstrip() == "# compiler: R8":
                saw_r8 = True
            match = CLASS_MAPPING_RE.match(line.rstrip())
            if match is not None and match.group(1) != match.group(2):
                obfuscated += 1
    if not saw_r8:
        raise SystemExit("Release mapping is not identified as R8 output")
    if obfuscated == 0:
        raise SystemExit("Release mapping has no changed class names")
    return obfuscated


def verify_resource_shrinker_report(resources: Path) -> int:
    lines = 0
    reachable = 0
    with resources.open(encoding="utf-8") as stream:
        for line in stream:
            lines += 1
            if " reachable from " in line:
                reachable += 1
    if lines == 0 or reachable == 0:
        raise SystemExit("Release resource shrinker report lacks reachability evidence")
    return lines


def apk_contains(apk: Path, needles: tuple[bytes, ...]) -> bool:
    with zipfile.ZipFile(apk) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            data = archive.read(entry)
            if any(needle in data for needle in needles):
                return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--host", type=Path, required=True)
    parser.add_argument("--test", type=Path, required=True)
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--resources", type=Path, required=True)
    args = parser.parse_args()

    for artifact in (args.release, args.host, args.test, args.mapping, args.resources):
        if not artifact.is_file() or artifact.stat().st_size == 0:
            raise SystemExit(f"required artifact missing or empty: {artifact}")

    obfuscated_classes = verify_r8_mapping(args.mapping)
    resource_report_lines = verify_resource_shrinker_report(args.resources)

    aapt = build_tool("aapt")
    apksigner = build_tool("apksigner")
    release_package, release_badging = package_name(aapt, args.release)
    host_package, _ = package_name(aapt, args.host)
    test_package, _ = package_name(aapt, args.test)
    if release_package != TARGET_PACKAGE:
        raise SystemExit(f"Release package is {release_package}, want {TARGET_PACKAGE}")
    if "application-debuggable" in release_badging:
        raise SystemExit("production Release APK is debuggable")
    if host_package != HOST_PACKAGE or test_package != TEST_PACKAGE:
        raise SystemExit("blackbox host/test package identity mismatch")

    target_package, runner = instrumentation_identity(aapt, args.test)
    if target_package != HOST_PACKAGE or runner != RUNNER:
        raise SystemExit("blackbox test must instrument only its disposable host")
    if target_package == TARGET_PACKAGE:
        raise SystemExit("blackbox test falsely injects into com.pipod")

    release_xml = run([str(aapt), "dump", "xmltree", str(args.release), "AndroidManifest.xml"])
    if "androidx.activity.ComponentActivity" in release_xml:
        raise SystemExit("production Release contains the Compose test host")

    release_signer = signer(apksigner, args.release)
    host_signer = signer(apksigner, args.host)
    test_signer = signer(apksigner, args.test)
    if host_signer != test_signer:
        raise SystemExit("blackbox host and test APK signers differ")
    if release_signer == host_signer:
        raise SystemExit("Release and blackbox runner must use independent signers")

    if apk_contains(args.test, (b"Lcom/pipod/app/", b"com.pipod.app.")):
        raise SystemExit("blackbox test APK contains a production-app class reference")

    print("release_package", TARGET_PACKAGE, flush=True)
    print("release_nondebuggable", "ok", flush=True)
    print("release_r8_mapping", "ok", "changed_classes", obfuscated_classes, flush=True)
    print("release_resource_shrinker_report", "ok", "lines", resource_report_lines, flush=True)
    print("release_signer_verified", release_signer, flush=True)
    print("blackbox_host", HOST_PACKAGE, flush=True)
    print("blackbox_test", TEST_PACKAGE, flush=True)
    print("blackbox_targetPackage", HOST_PACKAGE, flush=True)
    print("blackbox_runner_signer_verified", host_signer, flush=True)
    print("release_runner_signers_independent", "ok", flush=True)
    print("blackbox_app_class_references", "none", flush=True)


if __name__ == "__main__":
    main()
