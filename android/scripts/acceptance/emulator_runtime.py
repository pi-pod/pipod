#!/usr/bin/env python3
"""Owned pipod-ci AVD create/list/launch/boot/stop. Fail closed; no 45m hang."""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time
from pathlib import Path

from hosted_sdk import sdk_root, tool as hosted_tool

AVD_NAME = os.environ.get("PIPOD_AVD_NAME") or "pipod-ci-34"
IMAGE = os.environ.get("PIPOD_AVD_IMAGE") or "system-images;android-34;google_apis;x86_64"
BOOT_TIMEOUT_S = 1500
STALL_ABORT_S = 300
CHECKPOINT_S = 60
DEVICE_WAIT_S = 10
ADB_PORT = 5555


def avd_home() -> Path:
    home = Path(os.environ.get("ANDROID_AVD_HOME") or (Path.home() / ".android" / "avd"))
    home.mkdir(parents=True, exist_ok=True)
    os.environ["ANDROID_AVD_HOME"] = str(home)
    os.environ.setdefault("ANDROID_SDK_HOME", str(Path.home()))
    return home


def _tool(name: str, override: Path | None = None) -> Path:
    if override is not None:
        return override
    return hosted_tool(sdk_root(), name)


def pid_file() -> Path:
    return Path(os.environ.get("RUNNER_TEMP") or "/tmp") / "pipod-emu.pid"


def create_avd(*, avdmanager: Path | None = None, mkfs: Path | None = None) -> Path:
    home = avd_home()
    mgr = _tool("avdmanager", avdmanager)
    # Bounded "no" for the custom-hardware prompt. Empty stdin makes avdmanager
    # throw Range [0, 0 + -1) and exit 1 (R4 empty-stdin / echo-no -d pixel_7 miss).
    proc = subprocess.run(
        [str(mgr), "create", "avd", "--force", "-n", AVD_NAME, "-k", IMAGE],
        input=b"no\n",
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        sys.stderr.buffer.write(proc.stderr or b"")
        raise SystemExit(f"avd create failed rc={proc.returncode}")
    listed = subprocess.run(
        [str(mgr), "list", "avd"],
        capture_output=True,
        text=True,
        check=False,
    )
    if listed.returncode != 0 or AVD_NAME not in (listed.stdout or ""):
        raise SystemExit(f"avd list missing {AVD_NAME}")
    ini = home / f"{AVD_NAME}.ini"
    if not ini.is_file():
        raise SystemExit(f"avd ini missing: {ini}")
    _limit_avd_disk(home, ini, mkfs=mkfs)
    print("avd_ok", AVD_NAME, ini, flush=True)
    return ini


def _emulator_mkfs() -> Path:
    return _tool("emulator").parent / "bin64" / "mkfs.ext4"


def _assert_ext4(userdata: Path) -> None:
    with userdata.open("rb") as fh:
        fh.seek(1080)
        magic = fh.read(2)
    if magic != b"\x53\xef":
        raise SystemExit(f"userdata not ext4 magic={magic.hex() or 'empty'}")


def _format_userdata(
    userdata: Path, *, mkfs: Path | None = None, timeout_s: int = 30
) -> None:
    if mkfs is None:
        mkfs = _emulator_mkfs()
    if not os.access(mkfs, os.X_OK):
        raise SystemExit(f"emulator mkfs.ext4 missing: {mkfs}")
    try:
        formatted = subprocess.run(
            [str(mkfs), "-q", "-F", "-L", "data", "-m", "0", str(userdata)],
            capture_output=True,
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise SystemExit("userdata format timed out") from exc
    if formatted.returncode != 0:
        sys.stderr.buffer.write(formatted.stderr or b"")
        raise SystemExit(f"userdata format failed rc={formatted.returncode}")
    _assert_ext4(userdata)
    print("userdata_ext4", "53ef", flush=True)


def _limit_avd_disk(home: Path, ini: Path, *, mkfs: Path | None = None) -> None:
    """Hosted runners have ~6GiB free; default userdata wants ~7.4GiB."""
    avd_dir = home / f"{AVD_NAME}.avd"
    for line in ini.read_text(encoding="utf-8").splitlines():
        if line.startswith("path="):
            avd_dir = Path(line.split("=", 1)[1].strip())
            break
    cfg = avd_dir / "config.ini"
    if not cfg.is_file():
        raise SystemExit(f"avd config.ini missing: {cfg}")
    body = cfg.read_text(encoding="utf-8")
    drop = ("disk.dataPartition.size", "hw.ramSize", "sdcard.size")
    lines = [
        ln for ln in body.splitlines()
        if ln.split("=", 1)[0].strip() not in drop
    ]
    lines.append("disk.dataPartition.size=2048M")
    lines.append("hw.ramSize=2048")
    lines.append("sdcard.size=0")
    cfg.write_text("\n".join(lines) + "\n", encoding="utf-8")
    userdata = avd_dir / "userdata-qemu.img"
    if userdata.is_file():
        userdata.unlink()
    fd = os.open(str(userdata), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        os.ftruncate(fd, 2048 * 1024 * 1024)
    finally:
        os.close(fd)
    _format_userdata(userdata, mkfs=mkfs)
    print("avd_disk", "2048M", "userdata", userdata.stat().st_size, flush=True)
    _inspect_avd(avd_dir, cfg)


def _inspect_avd(avd_dir: Path, cfg: Path) -> None:
    want = ("disk.dataPartition.size", "hw.gpu.mode", "hw.cpu.arch", "image.sysdir.1", "image.sysdir")
    found: dict[str, str] = {}
    for ln in cfg.read_text(encoding="utf-8").splitlines():
        if "=" not in ln:
            continue
        k, v = ln.split("=", 1)
        k, v = k.strip(), v.strip()
        if k in want:
            found[k] = v
    print(
        "cfg_disk",
        found.get("disk.dataPartition.size", "missing"),
        "cfg_gpu",
        found.get("hw.gpu.mode", "missing"),
        "cfg_arch",
        found.get("hw.cpu.arch", "missing"),
        "cfg_sysdir",
        found.get("image.sysdir.1") or found.get("image.sysdir") or "missing",
        flush=True,
    )
    df = subprocess.run(
        ["df", "-Pm", str(avd_dir)],
        capture_output=True,
        text=True,
        check=False,
    )
    avail = "unknown"
    rows = [ln for ln in df.stdout.splitlines() if ln and not ln.startswith("Filesystem")]
    if rows:
        parts = rows[0].split()
        if len(parts) >= 4:
            avail = parts[3]
    print("avd_df_avail_mb", avail, flush=True)


def emulator_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def emu_log_path() -> Path:
    return Path(os.environ.get("RUNNER_TEMP") or "/tmp") / "pipod-emu.log"


def classify_error_lines(text: str) -> dict[str, int]:
    cats = {"kvm": 0, "gpu": 0, "memory": 0, "snapshot": 0, "adb": 0, "other": 0}
    for ln in text.splitlines():
        if "ERROR" not in ln and "FATAL" not in ln:
            continue
        low = ln.lower()
        if "kvm" in low or "/dev/kvm" in low or "hardware acceleration" in low:
            cats["kvm"] += 1
        elif "gpu" in low or "swiftshader" in low or "gfxstream" in low or "vulkan" in low:
            cats["gpu"] += 1
        elif (
            "partition" in low
            or "userdata" in low
            or "memory" in low
            or "ram size" in low
            or "disk space" in low
        ):
            cats["memory"] += 1
        elif "snapshot" in low or "quickboot" in low:
            cats["snapshot"] += 1
        elif "adb" in low or "serial" in low or "device/emulator" in low:
            cats["adb"] += 1
        else:
            cats["other"] += 1
    return cats


def log_counts(path: Path) -> dict[str, int]:
    try:
        raw = path.read_bytes()
    except OSError:
        print("emu_log_missing", flush=True)
        return {"kvm": 0, "gpu": 0, "memory": 0, "snapshot": 0, "adb": 0, "other": 0}
    text = raw.decode("utf-8", "replace")
    cats = classify_error_lines(text)
    print(
        "emu_log_lines",
        text.count("\n"),
        "INFO",
        text.count("INFO"),
        "ERROR",
        text.count("ERROR"),
        "FATAL",
        text.count("FATAL"),
        "sha25616",
        hashlib.sha256(raw).hexdigest()[:16],
        flush=True,
    )
    print(
        "emu_err_kvm",
        cats["kvm"],
        "gpu",
        cats["gpu"],
        "memory",
        cats["memory"],
        "snapshot",
        cats["snapshot"],
        "adb",
        cats["adb"],
        "other",
        cats["other"],
        flush=True,
    )
    tail = [ln for ln in text.splitlines() if ln.strip()][-5:]
    tail_cats = []
    for ln in tail:
        low = ln.lower()
        if "adbd" in low or "adb" in low:
            tail_cats.append("adb")
        elif "kvm" in low:
            tail_cats.append("kvm")
        elif "gpu" in low or "swiftshader" in low or "gfxstream" in low or "angle" in low:
            tail_cats.append("gpu")
        elif "partition" in low or "userdata" in low or "memory" in low:
            tail_cats.append("memory")
        elif "snapshot" in low:
            tail_cats.append("snapshot")
        else:
            tail_cats.append("other")
    print("emu_tail5", ",".join(tail_cats) if tail_cats else "empty", flush=True)
    low = text.lower()
    adbd = "yes" if "adbd" in low else "no"
    print("adbd_guest", adbd, flush=True)
    head = [ln for ln in text.splitlines() if ln.strip()][:20]
    head_cats = []
    for ln in head:
        low = ln.lower()
        if "error" in low or "fatal" in low:
            head_cats.append("error")
        elif "adbd" in low or "adb" in low:
            head_cats.append("adb")
        elif "boot" in low:
            head_cats.append("boot")
        elif "gpu" in low or "gles" in low or "gfx" in low or "vulkan" in low:
            head_cats.append("gpu")
        elif "kernel" in low or "panic" in low:
            head_cats.append("kernel")
        else:
            head_cats.append("other")
    print("emu_head20", ",".join(head_cats) if head_cats else "empty", flush=True)
    lowall = text.lower()
    print(
        "tok_emulator_error",
        lowall.count("emulator: error"),
        "tok_adbd",
        lowall.count("adbd"),
        "tok_boot_completed",
        lowall.count("boot completed") + lowall.count("boot_completed"),
        "tok_guest_crash",
        lowall.count("guest crash"),
        "tok_kernel_panic",
        lowall.count("kernel panic"),
        "tok_kernel",
        lowall.count("linux version") + lowall.count("kernel"),
        "tok_init",
        sum(1 for ln in text.splitlines() if "init:" in ln.lower() or " init " in ln.lower()),
        "tok_goldfish",
        lowall.count("goldfish"),
        "tok_selinux",
        lowall.count("selinux"),
        "tok_vsync",
        lowall.count("vsync"),
        flush=True,
    )
    return cats


def launch(*, emulator: Path | None = None, adb: Path | None = None, accel: str = "on") -> int:
    home = avd_home()
    os.environ["ANDROID_EMULATOR_HOME"] = str(Path.home() / ".android")
    os.environ["ANDROID_AVD_HOME"] = str(home)
    emu = _tool("emulator", emulator)
    extra: list[str] = ["-ports", "5554,5555"]
    log = emu_log_path()
    log_f = log.open("w")
    data_img = home / f"{AVD_NAME}.avd" / "userdata-qemu.img"
    print(
        "launch_flags",
        "-no-window -no-snapshot -gpu swiftshader_indirect -no-audio -no-boot-anim",
        "-memory 2048 -partition-size 2048 -ports 5554,5555 -data 2G -accel", accel,
        flush=True,
    )
    proc = subprocess.Popen(
        [
            str(emu),
            "-avd",
            AVD_NAME,
            "-no-window",
            "-no-snapshot",
            "-gpu",
            "swiftshader_indirect",
            "-no-audio",
            "-no-boot-anim",
            "-memory",
            "2048",
            "-partition-size",
            "2048",
            "-accel",
            accel,
            "-data",
            str(data_img),
            *extra,
        ],
        stdout=log_f,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
    )
    time.sleep(2)
    if proc.poll() is not None:
        log_f.close()
        log_counts(log)
        raise SystemExit(f"emulator exited early rc={proc.returncode}")
    pid_file().write_text(str(proc.pid), encoding="utf-8")
    print("emu_pid", proc.pid, "ports", "5554,5555", flush=True)
    return proc.pid


def _adb_serial(adb_bin: Path) -> str | None:
    out = subprocess.run(
        [str(adb_bin), "devices"],
        capture_output=True,
        text=True,
        timeout=DEVICE_WAIT_S,
        check=False,
    )
    names: list[str] = []
    for ln in out.stdout.splitlines():
        if "\tdevice" in ln or "\toffline" in ln:
            names.append(ln.split()[0])
    if "emulator-5554" in names:
        return "emulator-5554"
    return None


def wait_boot(*, adb: Path | None = None, timeout_s: int = BOOT_TIMEOUT_S) -> None:
    adb_bin = _tool("adb", adb)
    subprocess.run([str(adb_bin), "start-server"], check=False, capture_output=True)
    deadline = time.time() + timeout_s
    pid_txt = pid_file()
    pid = int(pid_txt.read_text(encoding="utf-8")) if pid_txt.is_file() else None
    attached = False
    serial = None
    t0 = time.time()
    last_chk = 0
    logp = emu_log_path()
    last_size = logp.stat().st_size if logp.is_file() else 0
    last_growth = t0
    while time.time() < deadline:
        if pid is not None and not emulator_alive(pid):
            print("cold_boot", "exited", flush=True)
            log_counts(logp)
            raise SystemExit("emulator exited during boot wait")
        elapsed = int(time.time() - t0)
        if elapsed >= last_chk + CHECKPOINT_S:
            last_chk = elapsed - (elapsed % CHECKPOINT_S)
            size = logp.stat().st_size if logp.is_file() else 0
            delta = size - last_size
            alive = pid is not None and emulator_alive(pid)
            print(
                "chk",
                last_chk,
                "emu_alive",
                "yes" if alive else "no",
                "log_bytes",
                size,
                "delta",
                delta,
                flush=True,
            )
            if last_chk == CHECKPOINT_S:
                print("cold_boot_60s", "running" if alive else "exited", flush=True)
                log_counts(logp)
            if delta > 0:
                last_growth = time.time()
            last_size = size
            if time.time() - last_growth >= STALL_ABORT_S:
                log_counts(logp)
                raise SystemExit("emu log stalled >5min")
        remaining = max(1, int(deadline - time.time()))
        try:
            subprocess.run(
                [str(adb_bin), "disconnect", f"127.0.0.1:{ADB_PORT}"],
                check=False,
                capture_output=True,
                timeout=min(DEVICE_WAIT_S, remaining),
            )
        except subprocess.TimeoutExpired:
            pass
        serial = _adb_serial(adb_bin)
        if serial is None:
            try:
                subprocess.run(
                    [str(adb_bin), "connect", f"127.0.0.1:{ADB_PORT}"],
                    check=False,
                    capture_output=True,
                    timeout=min(DEVICE_WAIT_S, remaining),
                )
            except subprocess.TimeoutExpired:
                continue
            try:
                subprocess.run(
                    [str(adb_bin), "disconnect", f"127.0.0.1:{ADB_PORT}"],
                    check=False,
                    capture_output=True,
                    timeout=min(DEVICE_WAIT_S, remaining),
                )
            except subprocess.TimeoutExpired:
                pass
            serial = _adb_serial(adb_bin)
        if serial != "emulator-5554":
            time.sleep(2)
            continue
        try:
            subprocess.run(
                [str(adb_bin), "-s", "emulator-5554", "wait-for-device"],
                timeout=min(30, remaining),
                check=True,
            )
            attached = True
            break
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
            continue
    if not attached or serial is None:
        log_counts(emu_log_path())
        raise SystemExit("adb wait-for-device timed out")
    print("adb_attached", True, "serial_set", True, flush=True)
    while time.time() < deadline:
        if pid is not None and not emulator_alive(pid):
            raise SystemExit("emulator exited during boot wait")
        remaining = max(1, int(deadline - time.time()))
        prop = subprocess.run(
            [str(adb_bin), "-s", serial, "shell", "getprop", "sys.boot_completed"],
            capture_output=True,
            text=True,
            timeout=min(DEVICE_WAIT_S, remaining),
            check=False,
        )
        if prop.stdout.strip().replace("\r", "") == "1":
            print("boot_ok", flush=True)
            return
        time.sleep(2)
    log_counts(emu_log_path())
    raise SystemExit("boot wait timed out")


def boot() -> None:
    print("launch_variant", "r10-api34-2g-1500s", flush=True)
    launch(accel="on")
    wait_boot(timeout_s=BOOT_TIMEOUT_S)


def _kill_emu_pid() -> None:
    pf = pid_file()
    if not pf.is_file():
        return
    try:
        pid = int(pf.read_text(encoding="utf-8").strip())
    except ValueError:
        pf.unlink(missing_ok=True)
        return
    if emulator_alive(pid):
        os.kill(pid, 15)
        for _ in range(20):
            if not emulator_alive(pid):
                break
            time.sleep(0.2)
        if emulator_alive(pid):
            os.kill(pid, 9)
    pf.unlink(missing_ok=True)


def stop(*, avdmanager: Path | None = None) -> None:
    _kill_emu_pid()
    mgr = _tool("avdmanager", avdmanager)
    subprocess.run(
        [str(mgr), "delete", "avd", "-n", AVD_NAME],
        check=False,
        capture_output=True,
    )
    print("emu_stop_ok", AVD_NAME, flush=True)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: emulator_runtime.py create|launch|wait-boot|boot|stop")
    cmd = sys.argv[1]
    if cmd == "create":
        create_avd()
    elif cmd == "launch":
        launch()
    elif cmd == "wait-boot":
        wait_boot()
    elif cmd == "boot":
        boot()
    elif cmd == "stop":
        stop()
    else:
        raise SystemExit("usage: emulator_runtime.py create|launch|wait-boot|boot|stop")


if __name__ == "__main__":
    main()
