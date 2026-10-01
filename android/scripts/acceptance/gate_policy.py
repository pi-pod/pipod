"""Pure policy for live acceptance. No HTTP. Used by live_gate.py and unit tests."""

import re

DELETED_HOSTS = ("static.24-144-85-108.sslip.io", "box.24-144-85-108.sslip.io")
# GET /v1/pods/:id is the non-waking inspect. These paths start compute.
WAKING_PATH_MARKERS = ("/restore", "/ws-ticket", "/files")
# routes.ts podConnection: active + provider_state stopped|archived → asleep.
ASLEEP_SANDBOX = frozenset({"stopped", "archived"})
TRANSITIONAL_OR_DEAD = frozenset(
    {
        "started",
        "starting",
        "preparing_image",
        "provisioning",
        "error",
        "gone",
        "stopping",
        "unknown",
        "deleting",
        "deleted",
    }
)


def reject_server_url(url: str) -> str | None:
    if not url.startswith("https://"):
        return "PIPOD_SERVER_URL must be https"
    if any(h in url for h in DELETED_HOSTS):
        return "PIPOD_SERVER_URL points at a deleted stack; wait for Root fixture URL"
    return None


def dispatch_scope(scope: str) -> str | None:
    if scope not in ("auth", "full"):
        return "PIPOD_ACCEPTANCE_SCOPE must be auth or full"
    return None


def pre_wake_requirement(
    backend: str,
    pod: str,
    wake_pod: str,
    scope: str = "full",
    workstation_id: str = "",
) -> str | None:
    if backend not in ("static", "saas"):
        return "PIPOD_ACCEPTANCE_BACKEND must be static or saas"
    err = dispatch_scope(scope)
    if err:
        return err
    if scope == "auth":
        return None
    if not pod:
        return "PIPOD_ACCEPTANCE_POD_ID required"
    if backend == "saas":
        return require_workstation_input(workstation_id, {"id": pod})
    return None


# box/routes.ts: hostId is box-[A-Za-z0-9._-]{1,180}, never a pod UUID.
BOX_HOST_ID = re.compile(r"^box-[A-Za-z0-9._-]{1,180}$")


def is_box_host_id(value: str | None) -> bool:
    return bool(value) and BOX_HOST_ID.fullmatch(value or "") is not None


def is_hostpod_substitution(candidate: str | None, pod: dict) -> bool:
    """True when a candidate is the pod UUID or co-located parent pod (hostPodId)."""
    if not candidate:
        return False
    return candidate == pod.get("hostPodId") or candidate == pod.get("id")


def require_workstation_input(raw: str, pod: dict) -> str | None:
    """Protected explicit box-* input. Never guess from /v1/me or hostPodId."""
    if not is_box_host_id(raw):
        return "INCOMPLETE: PIPOD_ACCEPTANCE_WORKSTATION_ID must be box-*"
    if is_hostpod_substitution(raw, pod):
        return "workstation id must not be hostPodId or pod UUID"
    return None


def workstation_stop_body() -> dict:
    """Actual POST /v1/workstations/:hostId/stop body: optional strict {}."""
    return {}


def pod_is_asleep(
    state: str | None,
    sandbox_state: str | None,
    connection: str | None = None,
) -> bool:
    """Only the product asleep pair. Not 'anything except started'."""
    if connection is not None:
        return connection == "asleep"
    return state == "active" and sandbox_state in ASLEEP_SANDBOX


def workstation_is_stopped(state: str | None) -> bool:
    """Box workstation box_state. Only stopped; not sandbox asleep."""
    return state == "stopped"


def saas_fixture_asleep(sandbox_state: str | None) -> bool:
    """Deprecated name kept for imports; sandbox alone is not enough."""
    return pod_is_asleep("active", sandbox_state, None)
