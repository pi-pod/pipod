"""M5 manual-evidence stub: just enough pi-pod API to screenshot the
workstation wait (503), the billing row (present / absent) and a blocked
account (startsBlocked).

Usage: python3 tools/m5-stub.py [pods503|billing|plain|real|blocked] [port]
       (default: billing on 18083)
`real` serves the exact production GET /v1/me workstation envelope captured
2026-09-10 (a no-subscription principal: status none, $40 cap) so the row can
be proved against real field values; the other scenarios stay labelled fixtures.
`blocked` serves `startsBlocked: true` with a `startBlockedReason` — the state
the fake backend cannot produce — on both /v1/me and /v1/billing/account.
Then: ./tools/remote-build.sh run -PIPOD_SERVER_URL http://127.0.0.1:18083 \\
        -PIPOD_DEV_TOKEN <dev-token>

Port 18083 by default, not 18081: the shared Mac already serves other agents'
fixtures on the neighbouring ports, so pass your own port if 18083 is taken.
Secret-free by construction: bearer tokens are accepted but never logged.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

SCENARIO = sys.argv[1] if len(sys.argv) > 1 else "billing"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 18083

HOST_ID = "boat-9622f2fa-48d5-493f-82e4-4c0dee0d54f9"

# The hosted edition's flat `workstation` block shape: cents, hour floats, real
# enums. The figures are fixtures, not plan terms. Served under the `workstation` key on /v1/me (and, like
# the client parser, on the pods envelope for screenshot evidence — production
# serves it on /v1/me only).
WORKSTATION = {
    "planKey": "standard", "planName": "Standard", "status": "trialing",
    "activeHoursUsed": 12.4, "includedActiveHours": 60,
    "overageHours": 0, "overageUsdCentsPerHour": 150,
    "spendCapUsdCents": 5000, "projectedSpendUsdCents": 320,
    "uncappedSpendUsdCents": 320,
    "spendCapState": "ok", "startsBlocked": False,
    "startBlockedReason": None,
    "parallelSandboxes": 4, "workspaceStorageGb": 50,
    "currentPeriodEnd": "2026-10-01T00:00:00Z",
    "trialEndsAt": "2026-09-24T00:00:00Z",
}

# Exact production envelope (GET /v1/me, 2026-09-10) for the `real` scenario.
REAL_WORKSTATION = {
    "activeHoursUsed": 6.2,
    "currentPeriodEnd": "2026-10-01T00:00:00.000Z",
    "includedActiveHours": 200, "overageHours": 0,
    "overageUsdCentsPerHour": 6, "parallelSandboxes": 8,
    "planKey": "standard", "planName": "Standard",
    "projectedSpendUsdCents": 0, "spendCapState": "ok",
    "spendCapUsdCents": 4000, "startBlockedReason": None,
    "startsBlocked": False, "status": "none", "trialEndsAt": None,
    "uncappedSpendUsdCents": 0, "workspaceStorageGb": 40,
}

# An account the server will refuse to start machines for. Same flat block,
# with the two fields the client used to parse away. The reason is contract
# (`StartBlockedReason`, billing/entitlements.ts).
BLOCKED_WORKSTATION = dict(
    WORKSTATION,
    status="past_due",
    activeHoursUsed=61.5,
    spendCapState="reached",
    startsBlocked=True,
    startBlockedReason="payment_past_due",
    trialEndsAt=None,
)

DEMAND_503 = {
    "error": "Your workstation is starting. This may take several minutes",
    "detail": {
        "kind": "admission",
        "reason": "host_starting",
        "resource": "transitions",
        "unit": "count",
        "retryable": True,
        "hostId": HOST_ID,
        "statusHref": f"/v1/workstations/{HOST_ID}",
        "state": "starting",
        "retryAfterMs": 10000,
        "operation": {
            "id": "6ce83b85-2ba3-4384-a201-202a922dc2dc",
            "kind": "resume",
            "state": "running",
            "phase": "command:activate",
            "deadlineAt": "2026-09-10T04:01:09.000Z",
            "retryAt": None,
            "errorCode": None,
        },
    },
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Method + path only. Never headers (Authorization) or bodies (tokens).
        sys.stderr.write("stub: %s %s\n" % (self.command, self.path.split("?")[0]))

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _workstation(self):
        if SCENARIO == "plain":
            return None
        if SCENARIO == "real":
            return REAL_WORKSTATION
        if SCENARIO == "blocked":
            return BLOCKED_WORKSTATION
        return WORKSTATION

    def _route(self):
        path = self.path.split("?")[0]
        workstation = self._workstation()
        if path == "/v1/me":
            me = {"user": {"id": "user-1", "email": "dev@example.com",
                           "displayName": "Dev"},
                  "permissions": []}
            if workstation is not None:
                me["workstation"] = workstation
            return 200, me
        if path == "/v1/billing/account":
            # The self-hosted server never registers this route at all, which is
            # what the client's 404 => nil branch exists for.
            if workstation is None:
                return 404, {"error": "Not Found",
                             "message": "Route GET:/v1/billing/account not found"}
            return 200, dict(workstation, canSubscribe=True, canManageBilling=True,
                             availablePlans=[])
        if path == "/v1/pods" and self.command == "GET":
            if SCENARIO == "pods503":
                return 503, DEMAND_503
            pods = {"pods": []}
            if workstation is not None:
                pods["workstation"] = workstation
            return 200, pods
        if path == f"/v1/workstations/{HOST_ID}":
            return 200, {"hostId": HOST_ID, "state": "starting",
                         "operation": DEMAND_503["detail"]["operation"]}
        return 200, {}

    def do_GET(self):
        status, body = self._route()
        self._send(status, body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)  # drain; never logged
        if self.path.split("?")[0] == "/v1/pods":
            status, body = self._route()
            self._send(status, body)
            return
        status, body = self._route()
        self._send(status, body)


if __name__ == "__main__":
    print(f"m5 stub on :{PORT} scenario={SCENARIO}", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
