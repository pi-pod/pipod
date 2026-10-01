#!/usr/bin/env python3
"""Fail if protected login/password values occur in any built APK entry."""
from __future__ import annotations

import argparse
import os
import zipfile
from pathlib import Path

ENV_KEYS = ("PIPOD_ACCEPTANCE_LOGIN", "PIPOD_ACCEPTANCE_PASSWORD")


def encodings(value: str) -> tuple[bytes, ...]:
    return (value.encode("utf-8"), value.encode("utf-16le"), value.encode("utf-16be"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", nargs="+", type=Path)
    args = parser.parse_args()
    values = [os.environ.get(key, "") for key in ENV_KEYS]
    if any(not value for value in values):
        raise SystemExit("credential absence scan requires both protected environment values")
    if any(len(value) < 8 for value in values):
        raise SystemExit("credential absence scan requires values at least eight characters long")
    needles = tuple(needle for value in values for needle in encodings(value))

    for apk in args.apk:
        if not apk.is_file():
            raise SystemExit(f"APK missing: {apk}")
        with zipfile.ZipFile(apk) as archive:
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                data = archive.read(entry)
                if any(needle in data for needle in needles):
                    raise SystemExit(f"protected credential value found in APK entry: {apk.name}")
    print("embedded_credentials", "none", "apks", len(args.apk), flush=True)


if __name__ == "__main__":
    main()
