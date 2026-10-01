#!/usr/bin/env python3
"""One-use credential delivery to the disposable runner host; never logs values."""
from __future__ import annotations

import argparse
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "acceptance"))

from hosted_sdk import sdk_root, tool as hosted_tool  # noqa: E402

SERIAL = "emulator-5554"
HOST_PACKAGE = "com.pipod.releaseblackbox.runner"
REMOTE_FILE = "files/pipod-acceptance.env"
MAX_BYTES = 16 * 1024


def _adb(args: list[str], *, data: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    adb = str(hosted_tool(sdk_root(), "adb"))
    return subprocess.run(
        [adb, "-s", SERIAL, *args],
        input=data,
        capture_output=True,
        check=False,
        timeout=30,
    )


def _checked(args: list[str], *, data: bytes | None = None, action: str) -> None:
    result = _adb(args, data=data)
    if result.returncode != 0:
        # stdout/stderr are intentionally suppressed: credential bytes must
        # never be reflected if a remote shell behaves unexpectedly.
        raise SystemExit(f"credential {action} failed rc={result.returncode}")


def validated_source(path: Path) -> bytes:
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit("credential source must be a regular file")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise SystemExit("credential source mode must be 0600")
    if info.st_size <= 0 or info.st_size > MAX_BYTES:
        raise SystemExit("credential source size rejected")
    data = path.read_bytes()
    if b"\x00" in data or b"\r" in data:
        raise SystemExit("credential source contains a rejected control byte")
    if not data.endswith(b"\n") or b"LOGIN=" not in data or b"PASSWORD=" not in data:
        raise SystemExit("credential source is missing the protected file contract")
    return data


def install(path: Path) -> None:
    data = validated_source(path)

    _checked(["shell", "run-as", HOST_PACKAGE, "mkdir", "-p", "files"], action="mkdir")
    command = f"'umask 077; cat > {REMOTE_FILE}'"
    _checked(
        ["shell", "run-as", HOST_PACKAGE, "sh", "-c", command],
        data=data,
        action="install",
    )
    _checked(["shell", "run-as", HOST_PACKAGE, "chmod", "600", REMOTE_FILE], action="chmod")
    print("credential_install ok", flush=True)


def remove() -> None:
    _checked(["shell", "run-as", HOST_PACKAGE, "rm", "-f", REMOTE_FILE], action="remove")
    print("credential_remove ok", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--install", type=Path)
    group.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    if args.install is not None:
        install(args.install)
    else:
        remove()


if __name__ == "__main__":
    main()
