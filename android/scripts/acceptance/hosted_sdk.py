#!/usr/bin/env python3
"""Use the GitHub-hosted Android SDK (Play/CI). Do not invent a custom root."""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GRADLE = ROOT / "app" / "build.gradle.kts"
CUSTOM_ROOT_NAME = "android-sdk"
EMU_PACKAGES = ("emulator",)
SMOKE_IMAGES = (
    "system-images;android-34;google_apis;x86_64",
    "system-images;android-33;google_apis;x86_64",
)


def compile_sdk() -> str:
    text = GRADLE.read_text(encoding="utf-8")
    m = re.search(r"compileSdk\s*=\s*(\d+)", text)
    if not m:
        raise SystemExit("compileSdk missing from app/build.gradle.kts")
    return m.group(1)


def sdk_root() -> Path:
    raw = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or ""
    if not raw:
        raise SystemExit("hosted ANDROID_HOME/ANDROID_SDK_ROOT is unset")
    root = Path(raw)
    if root.name == CUSTOM_ROOT_NAME and root.parent == Path.home():
        raise SystemExit(f"refusing custom SDK root {root}")
    if not (root / "platforms").is_dir():
        raise SystemExit(f"hosted SDK has no platforms: {root}")
    return root


def platform_covers(root: Path, sdk: str) -> bool:
    names = [p.name for p in (root / "platforms").iterdir() if p.is_dir()]
    if f"android-{sdk}" in names:
        return True
    return any(n.startswith(f"android-{sdk}.") for n in names)


def tool(root: Path, name: str) -> Path:
    if name == "adb":
        path = root / "platform-tools" / "adb"
    elif name == "emulator":
        path = root / "emulator" / "emulator"
    elif name in ("sdkmanager", "avdmanager"):
        latest = root / "cmdline-tools" / "latest" / "bin" / name
        if latest.is_file():
            path = latest
        else:
            found = sorted((root / "cmdline-tools").glob(f"*/bin/{name}"))
            if not found:
                raise SystemExit(f"hosted {name} missing under {root}")
            path = found[-1]
    elif name == "apksigner":
        path = root / "build-tools" / "36.0.0" / "apksigner"
    else:
        raise SystemExit(f"unknown tool {name}")
    if not os.access(path, os.X_OK):
        raise SystemExit(f"hosted tool not executable: {path}")
    return path


def assert_compile_platform() -> None:
    root = sdk_root()
    sdk = compile_sdk()
    plats = sorted(p.name for p in (root / "platforms").iterdir() if p.is_dir())
    print("hosted_sdk", root, "compileSdk", sdk, "platforms", ",".join(plats), flush=True)
    if not platform_covers(root, sdk):
        raise SystemExit(f"hosted SDK missing compile platform for compileSdk={sdk}")


def prepare_emulator() -> None:
    assert_compile_platform()
    root = sdk_root()
    mgr = tool(root, "sdkmanager")
    lic = ROOT / "scripts" / "acceptance" / "license_pipe.py"
    st = subprocess.run([sys.executable, str(lic), str(mgr)], check=False)
    if st.returncode != 0:
        raise SystemExit(st.returncode)
    inst = subprocess.run([str(mgr), *EMU_PACKAGES], check=False)
    if inst.returncode != 0:
        raise SystemExit(inst.returncode)
    print("emulator_packages_ok", flush=True)
    img, avd = _install_smoke_image(mgr)
    print("smoke_image", img, "avd", avd, flush=True)
    gh = os.environ.get("GITHUB_ENV")
    if gh:
        with open(gh, "a", encoding="utf-8") as envf:
            envf.write(f"PIPOD_AVD_IMAGE={img}\nPIPOD_AVD_NAME={avd}\n")


def _install_smoke_image(mgr: Path) -> tuple[str, str]:
    for img in SMOKE_IMAGES:
        try:
            proc = subprocess.run(
                [str(mgr), img],
                capture_output=True,
                timeout=240,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise SystemExit("sdkmanager system-image install timed out") from exc
        if proc.returncode == 0:
            avd = "pipod-ci-34" if "android-34" in img else "pipod-ci-33"
            return img, avd
    raise SystemExit("no android-34/33 google_apis x86_64 system image")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: hosted_sdk.py assert-compile-platform|prepare-emulator|tool <name>")
    cmd = sys.argv[1]
    if cmd == "assert-compile-platform":
        assert_compile_platform()
    elif cmd == "prepare-emulator":
        prepare_emulator()
    elif cmd == "tool" and len(sys.argv) == 3:
        print(tool(sdk_root(), sys.argv[2]))
    else:
        raise SystemExit("usage: hosted_sdk.py assert-compile-platform|prepare-emulator|tool <name>")


if __name__ == "__main__":
    main()
