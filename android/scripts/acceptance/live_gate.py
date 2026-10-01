#!/usr/bin/env python3
"""API companion for Android live acceptance. Secrets from env; never printed.

Modes (required argv):
  pre       Non-waking inspect + OpenRouter bind on the *session* pod only.
  snapshot  After UI session: write marker, record sha+mtime_ns.
  fence     After native Stop: non-waking GET must be product asleep.
  verify    After native resume: same sha+mtime_ns on the same pod.
  custody   After second sandbox fence: no owned pod still started.
  arm-wait  SaaS last: POST /v1/workstations/{boat-*}/stop with {}.

Bearer /me is not native PKCE proof. 503 host_starting is SaaS-only and is
caused by the UI, not this script.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from gate_policy import (
    pod_is_asleep,
    pre_wake_requirement,
    reject_server_url,
    require_workstation_input,
    workstation_is_stopped,
    workstation_stop_body,
)

SERVER = os.environ.get("PIPOD_SERVER_URL", "").rstrip("/")
TOKEN = os.environ.get("PIPOD_ACCEPTANCE_ACCESS_TOKEN", "")
POD = os.environ.get("PIPOD_ACCEPTANCE_POD_ID", "")
WAKE_POD = os.environ.get("PIPOD_ACCEPTANCE_WAKE_POD_ID", "")
USER = os.environ.get("PIPOD_ACCEPTANCE_USER_ID", "")
BACKEND = os.environ.get("PIPOD_ACCEPTANCE_BACKEND", "static")
SCOPE = os.environ.get("PIPOD_ACCEPTANCE_SCOPE", "full")
OR_KEY = os.environ.get("PIPOD_OPENROUTER_API_KEY", "")
SNAPSHOT = os.environ.get("PIPOD_ACCEPTANCE_SNAPSHOT", "")
NONCE = os.environ.get("PIPOD_ACCEPTANCE_NONCE", "")
WS_ID = os.environ.get("PIPOD_ACCEPTANCE_WORKSTATION_ID", "")
MARKER = f"android-ci-live-marker-{NONCE or 'missing'}\n".encode()
MARKER_PATH = f"android-ci-live-marker-{NONCE or 'missing'}.txt"


def fail(msg: str) -> None:
    print("LIVE_GATE_FAIL", msg, flush=True)
    sys.exit(1)


ctx = ssl.create_default_context()
BASE = SERVER + "/v1" if SERVER else ""


def http(method: str, path: str, body=None, timeout: int = 120):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Authorization": "Bearer " + TOKEN, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw.decode()) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {"_error": e.read()[:240].decode("utf-8", "replace")}


def require_common(*, need_or: bool = True) -> None:
    err = reject_server_url(SERVER)
    if err:
        fail(err)
    if SCOPE == "auth":
        fail("live_gate is not the auth-scope path")
    if not TOKEN or not POD or not USER:
        fail("missing required live env (names only; values not printed)")
    if need_or and not OR_KEY:
        fail("missing PIPOD_OPENROUTER_API_KEY")
    if need_or and not NONCE:
        fail("missing PIPOD_ACCEPTANCE_NONCE")
    err = pre_wake_requirement(BACKEND, POD, WAKE_POD, SCOPE, WS_ID)
    if err:
        fail(err)


def inspect_pod(pod_id: str) -> dict:
    st, body = http("GET", f"/pods/{pod_id}")
    print(
        "pod_get_nonwaking",
        st,
        "state",
        body.get("state"),
        "sandbox",
        body.get("sandboxState"),
        "connection",
        body.get("connection"),
        "has_host",
        bool(body.get("hostPodId")),
        flush=True,
    )
    if st != 200:
        fail(f"owned pod not visible {st}")
    return body


def ws_open(path_qs: str):
    host = urllib.parse.urlparse(SERVER).hostname or ""
    raw = socket.create_connection((host, 443), timeout=60)
    ss = ctx.wrap_socket(raw, server_hostname=host)
    key = base64.b64encode(os.urandom(16)).decode()
    ss.sendall(
        (
            f"GET {path_qs} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
    )
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = ss.recv(4096)
        if not chunk:
            raise RuntimeError("ws eof")
        head += chunk
    if b" 101 " not in head.split(b"\r\n", 1)[0]:
        raise RuntimeError("ws not 101")
    return ss


def ws_send(ss, obj):
    data = json.dumps(obj).encode()
    n = len(data)
    hdr = bytes([0x81])
    if n < 126:
        hdr += struct.pack("!B", 0x80 | n)
    elif n < 65536:
        hdr += struct.pack("!BH", 0x80 | 126, n)
    else:
        hdr += struct.pack("!BQ", 0x80 | 127, n)
    mask = os.urandom(4)
    ss.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def ws_recv(ss):
    def rn(n):
        b = b""
        while len(b) < n:
            c = ss.recv(n - len(b))
            if not c:
                raise RuntimeError("closed")
            b += c
        return b

    h = rn(2)
    op = h[0] & 0x0F
    ln = h[1] & 0x7F
    if ln == 126:
        ln = struct.unpack("!H", rn(2))[0]
    elif ln == 127:
        ln = struct.unpack("!Q", rn(8))[0]
    payload = rn(ln)
    if op == 0x9:
        ss.sendall(bytes([0x8A, len(payload)]) + payload)
        return {"type": "_ping"}
    if op != 0x1:
        return {"type": "_other"}
    return json.loads(payload.decode())


def me_and_session_pod() -> tuple[dict, dict]:
    st, me = http("GET", "/me")
    if st != 200:
        fail(f"/me {st}")
    uid = (me.get("user") or {}).get("id")
    print("me_user_match", uid == USER, "workstation_present", "workstation" in me, flush=True)
    if uid != USER:
        fail("user id mismatch vs PIPOD_ACCEPTANCE_USER_ID")
    if BACKEND == "static" and "workstation" in me:
        fail("static backend unexpectedly has me.workstation")
    if BACKEND == "saas" and "workstation" not in me:
        fail("saas backend missing me.workstation")
    st, pod = http("GET", f"/pods/{POD}")
    print("pod_get", st, "state", pod.get("state"), "sandbox", pod.get("sandboxState"), flush=True)
    if st != 200:
        fail("owned session pod not visible to this user")
    return me, pod


def bind_openrouter_on_session_pod() -> None:
    """login-ticket WITH podId, then stop/restore *session* pod so Pi reloads.

    Does not touch the SaaS wake fixture.
    """
    st, minted = http(
        "POST",
        "/model-credentials/openrouter/login-ticket",
        {"authType": "api_key", "podId": POD},
    )
    print("login_ticket", st, "ticket", "ticket" in minted, flush=True)
    if st not in (200, 201) or "ticket" not in minted:
        fail("login-ticket with podId failed")
    ticket = minted["ticket"]
    ss = ws_open(
        "/v1/model-credentials/openrouter/login?ticket=" + urllib.parse.quote(ticket, safe="")
    )
    del ticket
    done = None
    deadline = time.time() + 90
    while time.time() < deadline:
        ss.settimeout(30)
        frame = ws_recv(ss)
        if frame.get("type") == "_ping":
            continue
        if frame.get("type") == "prompt":
            ws_send(ss, {"type": "response", "id": frame["id"], "value": OR_KEY})
            continue
        if frame.get("type") == "done":
            done = frame
            break
    ss.close()
    if not done or done.get("ok") is not True:
        fail("openrouter login-ticket(podId) not ok")
    print("openrouter_ready", True, flush=True)
    http("POST", f"/pods/{POD}/stop")
    time.sleep(2)
    http("POST", f"/pods/{POD}/restore")
    print("session_pod_bind_reload", True, flush=True)


def session_ws():
    st, tix = http("POST", f"/pods/{POD}/ws-ticket")
    ticket = (tix or {}).get("ticket")
    if st not in (200, 201) or not ticket:
        fail("ws-ticket failed on session pod")
    ss = ws_open("/v1/pods/" + POD + "/session?ticket=" + urllib.parse.quote(ticket, safe=""))
    deadline = time.time() + 20
    while time.time() < deadline:
        ss.settimeout(20)
        frame = ws_recv(ss)
        if frame.get("type") == "hello":
            return ss
    fail("session hello missing")


def bash_marker(ss) -> tuple[str, str, str]:
    want = hashlib.sha256(MARKER).hexdigest()
    cmd = (
        "python3 -c \"import os,hashlib; p=%r; b=open(p,'rb').read(); st=os.stat(p); "
        "print(hashlib.sha256(b).hexdigest(), st.st_mtime_ns, st.st_size)\"" % MARKER_PATH
    )
    ws_send(
        ss,
        {
            "type": "rpc",
            "id": "bash1",
            "command": {"type": "bash", "command": cmd, "excludeFromContext": True},
        },
    )
    deadline = time.time() + 40
    while time.time() < deadline:
        ss.settimeout(15)
        try:
            frame = ws_recv(ss)
        except Exception:
            break
        pl = frame.get("payload") if isinstance(frame.get("payload"), dict) else {}
        out = pl.get("output") or pl.get("stdout") or pl.get("delta")
        if isinstance(out, str) and out.strip():
            parts = out.strip().split()
            if len(parts) >= 3 and parts[0] == want and parts[1].isdigit():
                return parts[0], parts[1], parts[2]
            fail("bash hash mismatch vs marker")
        if frame.get("type") == "rpc_result":
            break
    fail("readiness bash hash/mtime_ns not confirmed")


def write_marker() -> None:
    contents = base64.b64encode(MARKER).decode()
    st, _ = http(
        "POST",
        f"/pods/{POD}/files",
        {"entries": [{"relPath": MARKER_PATH, "kind": "file", "contents": contents, "mode": 0o644}]},
    )
    if st not in (200, 201, 204):
        fail(f"marker write {st}")


def catalog(ss) -> int:
    ws_send(ss, {"type": "get_models"})
    deadline = time.time() + 30
    while time.time() < deadline:
        ss.settimeout(20)
        frame = ws_recv(ss)
        if frame.get("type") == "models":
            return len(frame.get("models") or [])
    return 0


def owned_workstation_id(pod: dict) -> str:
    err = require_workstation_input(WS_ID, pod)
    if err:
        fail(err)
    return WS_ID


def cmd_pre() -> None:
    require_common()
    _me, pod = me_and_session_pod()
    if BACKEND == "saas":
        hid = owned_workstation_id(pod)
        st, wstat = http("GET", f"/workstations/{hid}")
        print("workstation_get", st, "state", (wstat or {}).get("state"), flush=True)
        if st != 200:
            fail("INCOMPLETE: owner-bound GET /v1/workstations/:id failed")
    bind_openrouter_on_session_pod()
    print("LIVE_GATE_PRE_OK", "backend", BACKEND, flush=True)


def cmd_fence() -> None:
    require_common(need_or=False)
    pod = inspect_pod(POD)
    if not pod_is_asleep(pod.get("state"), pod.get("sandboxState"), pod.get("connection")):
        fail("INCOMPLETE: native stop did not leave session pod asleep (stopped/archived)")
    print("LIVE_GATE_FENCE_OK", "asleep", True, flush=True)


def cmd_custody() -> None:
    require_common(need_or=False)
    st, listing = http("GET", "/pods?mine=true")
    if st != 200:
        fail(f"pods mine {st}")
    active = []
    for row in listing.get("pods") or []:
        if row.get("sandboxState") == "started" or row.get("connection") in (
            "connected",
            "reconnecting",
        ):
            active.append("started")
    print("custody_started", len(active), flush=True)
    if active:
        fail("INCOMPLETE: owned fixture still has active sandbox custody")
    print("LIVE_GATE_CUSTODY_OK", True, flush=True)


def cmd_arm_wait() -> None:
    require_common(need_or=False)
    if BACKEND != "saas":
        fail("arm-wait is saas-only")
    pod = inspect_pod(POD)
    hid = owned_workstation_id(pod)
    st, body = http("POST", f"/workstations/{hid}/stop", body=workstation_stop_body())
    print("workstation_stop", st, "state", (body or {}).get("state"), flush=True)
    if st not in (200, 202):
        fail("INCOMPLETE: POST /v1/workstations/:id/stop {} failed")
    deadline = time.time() + 90
    stopped = False
    while time.time() < deadline:
        st, wstat = http("GET", f"/workstations/{hid}")
        print("workstation_get", st, "state", (wstat or {}).get("state"), flush=True)
        if st == 200 and workstation_is_stopped((wstat or {}).get("state")):
            stopped = True
            break
        time.sleep(2)
    if not stopped:
        fail("INCOMPLETE: workstation did not reach stopped after POST stop")
    print("LIVE_GATE_ARM_WAIT_OK", "workstation_stopped", True, flush=True)


def cmd_snapshot() -> None:
    require_common()
    if not SNAPSHOT:
        fail("PIPOD_ACCEPTANCE_SNAPSHOT path required")
    write_marker()
    ss = session_ws()
    n = catalog(ss)
    print("catalog_n", n, flush=True)
    if n < 1:
        fail("empty model catalog after podId bind")
    sha, mtime_ns, size = bash_marker(ss)
    ss.close()
    with open(SNAPSHOT, "w", encoding="utf-8") as f:
        json.dump(
            {"sha256": sha, "mtime_ns": mtime_ns, "size": size, "path": MARKER_PATH, "pod": POD},
            f,
        )
    print("LIVE_GATE_SNAPSHOT_OK", "mtime_ns_present", True, flush=True)


def cmd_verify() -> None:
    require_common()
    if not SNAPSHOT or not os.path.isfile(SNAPSHOT):
        fail("snapshot missing; UI+companion were not coordinated")
    with open(SNAPSHOT, encoding="utf-8") as f:
        snap = json.load(f)
    if snap.get("pod") != POD:
        fail("snapshot pod does not match session pod")
    ss = session_ws()
    sha, mtime_ns, size = bash_marker(ss)
    ss.close()
    if (sha, mtime_ns, size) != (snap["sha256"], snap["mtime_ns"], snap["size"]):
        fail("native stop/cancel/retry did not preserve marker sha/mtime_ns/size")
    print("LIVE_GATE_VERIFY_OK", "sha_match", True, "mtime_match", True, flush=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=("pre", "snapshot", "fence", "verify", "custody", "arm-wait"))
    args = p.parse_args()
    {
        "pre": cmd_pre,
        "snapshot": cmd_snapshot,
        "fence": cmd_fence,
        "verify": cmd_verify,
        "custody": cmd_custody,
        "arm-wait": cmd_arm_wait,
    }[args.mode]()


if __name__ == "__main__":
    main()
