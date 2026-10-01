# Personal workstations, and the SaaS fields the client hides

pi pod ships as one client for two products.

- **Self-hosted (open source).** The sandbox runtime runs beside the server on hardware the
  operator already pays for. There is a shared fleet, and there is no plan, no metered hour and
  no spend cap anywhere in the system.
- **SaaS.** Every user gets a whole machine of their own — a **workstation** — which sleeps when
  idle and is started again on demand. Hours are metered and capped.

The client is written so that the second product's surfaces simply do not exist under the first.
This file is the contract it implements, and it is also what a server change has to match.

## 1. Waking a workstation

A workstation that is asleep or coming up refuses any call that needs it. That refusal is
**HTTP 503** with a typed detail:

```json
{
  "error": "Your workstation is starting. This may take several minutes",
  "detail": {
    "kind": "admission",
    "reason": "host_starting",
    "resource": "transitions",
    "unit": "count",
    "retryable": true,
    "hostId": "boat-…",
    "statusHref": "/v1/workstations/boat-…",
    "state": "starting",
    "retryAfterMs": 10000,
    "operation": {
      "id": "…", "kind": "resume", "state": "running", "phase": "command:activate",
      "deadlineAt": "…", "retryAt": null, "errorCode": null
    }
  }
}
```

`kind`/`resource`/`unit` are constants and are what identify the shape. `reason` is one of
`host_starting`, `host_stopped`, `host_deleted`, `host_retired`,
`host_requires_reconciliation`, `boat_starts_disabled`; `retryable` on the wire is
authoritative. The WebSocket equivalent is close code **4420** with reason `host_starting`,
`host_stopped` or `host_archived` — the same code an idle pod uses, so the reason is what tells
them apart.

`src/account/workstation.ts` validates all of it as strictly as the server does on the way out:
the host id against the workstation route's own rule, `statusHref` **recomputed from the id and
compared** rather than trusted, `retryAfterMs` bounded to 0–300 s, the operation reduced to the
seven fields `GET /v1/workstations/:hostId` exposes. A malformed field means "no detail", never
a forged one.

Then a real launch waits: poll the durable status, re-issue the same request each cycle, and
render elapsed time plus the server's own phase. The operation deadline is not a client exit.
The wait ends when the request succeeds, the user cancels, the refusal is terminal, or two
observed start cycles end stopped without the request succeeding. It does not ask the user to
come back and run the command again. A dry run reports the demand and does not wait.
Cancelling ends the client's wait, not the machine's start.

Install a waiting client from the merged source commit (`npm ci && npm run build` in `pi-pod`,
then point the launcher at that `dist/cli.js`). `pipod update` only upgrades a git checkout or
an npm install; a release directory under `~/.local/share/pipod/releases` is neither.

### The numbers, and why the copy says "several minutes"

Measured in production on 2026-09-10 — ten operations across two hosts in one evening. These are
measurements, not an SLA:

| transition | measured |
|---|---|
| cold create → ready (host with eight pods) | 407 s |
| cold create → ready (empty host) | 708 s |
| resume → ready | 243 s, 690 s, 483 s, 312 s, 357 s |
| pod launch → ready on an already-warm workstation | 46 s |

So: no copy anywhere promises seconds, and nothing counts down to a number the server did not
send. A workstation wait must never render as fleet pressure ("the fleet has no room", "ask an
owner to register capacity") — nobody registers a workstation — and never as data loss. A
stopped workstation keeps every workspace on its own disk.

## 2. The optional plan block

`GET /v1/me` may carry a `billing` object. Every field is independently optional:

```jsonc
"billing": {
  "plan":        { "id": "standard", "name": "Standard" },
  "period":      { "start": "2026-09-01T00:00:00Z", "end": "2026-10-01T00:00:00Z" },
  "activeHours": { "used": 12.4, "included": 200 },
  "spendCap":    { "limitUsd": 40, "spentUsd": 3.2, "state": "ok" },
  "trial":       { "state": "active", "endsAt": "2026-09-24T00:00:00Z", "hoursRemaining": 8 },
  "state":       "ok"
}
```

`spendCap.state` ∈ `ok approaching reached`; `trial.state` ∈ `active expired none`; `state` ∈
`ok cap_reached trial_expired payment_failed grace`. Numbers are finite and non-negative;
`used`/`spentUsd` may exceed the allowance, because overage is a real thing that happens.

`pipod list` renders one dim footer line from it:

```
pi pod   Standard · 12.4 of 200 active hours · spend cap $40 ($3.20 used) · period ends 2026-10-01
```

Each segment is dropped independently when its data is missing.

**When the object is absent the whole surface is absent** — no zeroes, no "unknown", no empty
heading, no error. That is the edition boundary: a self-hosted operator must never be shown a
spend cap they do not have. `--quiet` is unaffected in both editions.

The client never computes, projects or prices anything. "12.4 of 200 active hours" is allowed
because the server sent both numbers; "48 hours left, about $12 more" is not.

## 3. Billing refusals

When the account's own billing state blocks a start, the refusal carries
`detail.reason` ∈ `spend_cap_reached`, `trial_expired`, `payment_required`, `billing_required`,
`payment_failed`, optionally with `limitUsd`, `spentUsd`, `periodEnd`, `endsAt`,
`hoursRemaining`, `graceDaysRemaining`.

The client says what happened, what it cost and what to do — using only the figures that
arrived, and naming no price, plan or policy of its own. These are decisions, not waits: they
never enter a retry loop.

## 4. If you are changing the server

Adding these fields is additive and safe: an older client ignores what it does not know, and a
server that omits them keeps the surface hidden. Keep `statusHref` derivable from `hostId`,
keep `reason` inside its allowlist, and keep every `billing` field optional — the client's
tests assert both the present and the absent shape, and the absent shape is the open-source
product.
