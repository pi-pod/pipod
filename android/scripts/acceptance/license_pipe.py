#!/usr/bin/env python3
"""Accept SDK licenses with a bounded public y\\n payload on stdin.

No `yes` producer. sdkmanager's own exit status is propagated.
"""
from __future__ import annotations

import subprocess
import sys

# Finite replies. sdkmanager --licenses asks a handful of questions.
BOUNDED_Y = ("y\n" * 64).encode()


def run_sdkmanager_licenses(sdkmanager: str) -> int:
    try:
        proc = subprocess.run(
            [sdkmanager, "--licenses"],
            input=BOUNDED_Y,
            stdout=subprocess.DEVNULL,
            check=False,
        )
    except FileNotFoundError:
        return 127
    return proc.returncode


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: license_pipe.py <sdkmanager>", file=sys.stderr)
        sys.exit(2)
    sys.exit(run_sdkmanager_licenses(sys.argv[1]))


if __name__ == "__main__":
    main()
