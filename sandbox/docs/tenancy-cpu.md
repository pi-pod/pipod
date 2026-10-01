# Tenancy and CPU grants

## Owner identity

The owner is an immutable column set at create (`owner.userKey`) or import time. There is
no update route, and `PUT /labels` cannot touch it, because labels are mutable and must
never be consulted for ownership, quota, cgroup placement, or cost attribution.

- Format `^[A-Za-z0-9._-]{1,64}$`; anything else is `400 bad_request`. The key is an
  opaque platform user key chosen by the server, not an email or display name.
- `SandboxInfoWire.owner` is `{ userKey }` or `null` for legacy/unowned sandboxes.
- Rehome by passing the same `owner` on `POST /v1/sandboxes/import`.
- Owner identity, CPU grants, and idempotency routes are control-plane only (master
  token); per-sandbox activity tokens can only post activity for their own id.

## One-time owner initialization (legacy rows)

A legacy unowned row sits flat beside tenant parents, so it competes with a whole tenant for
CPU. Stop/start alone never creates an owner. The control plane maps the authoritative pod
owner and calls `PUT /v1/sandboxes/:id/owner` `{ "owner": { "userKey": "..." } }` (master token):

| Row | Result |
| --- | --- |
| unowned, stopped/archived/error | set (`changed: true`, revision +1, event `owner_initialized`); next start is placed under the tenant parent |
| same owner | `changed: false` |
| different owner | `409 owner_conflict` (immutable; rehome via archive + import) |
| unowned but running | `409 owner_conflict`; grandfathered until it stops, never moved live |

`capacity.tenancy` reports the debt: `unownedLive` (grandfathered) and `unownedInitializable`.
`PI_POD_SANDBOX_REQUIRE_OWNER=1` then refuses unowned launches (`400 owner_required`) without
stopping anything already running.

## Cgroup layout

| Sandbox | Placement |
| --- | --- |
| Owned | `pps/tenant-<userKey>/<id>` under the tenant parent |
| Unowned | legacy flat `pps/<id>` |

Every tenant parent gets equal `cpu.weight` (100) regardless of how many sandboxes it
holds, and every sandbox keeps its own 2 vCPU cap and memory ceiling. The parent is also
a memory kill boundary wherever `PI_POD_SANDBOX_TENANT_MEMORY_GB` is set (required in box
mode, default 5.5 GiB; unset/uncapped in static mode): per-sandbox ceilings partition the
tenant, the parent's `memory.high`/`memory.max` bound the tenant, so a bursting tenant
OOM-kills inside its own subtree instead of reclaiming memory out of neighbouring
services. Both files are set to the cap with no headroom — a box host has no spare RAM
for headroom, unlike the fleet scope's 10% `memory.max` margin. The cap is applied and
read-back-verified on every launch (a rejected write refuses the launch), re-applied on
restart adoption, and reported in `capabilities.tenantLimits`. When tenant usage passes
90% of the cap the reaper sheds that tenant's idle sandboxes (freeze, then stop) before
the kernel fires; workspaces are never touched. User keys double as directory components
and are matched against the owner pattern, never trusted raw.

Running sandboxes are never moved live. The new layout applies at the next start: launch
creates the tenant parent if missing and records the placement (`cgroupRel`), so after a
restart teardown still finds a nested sandbox. Per-sandbox caps are re-applied on adopt.

## CPU grants

`PUT /v1/tenants/:userKey/cpu-grant` applies `cpu.max` on the tenant parent:

```json
{ "revision": 41, "cpuCores": 4, "ttlMs": 60000 }
```

- `revision` is the allocator epoch and must be strictly greater than the current one
  for that tenant, else `409 stale_revision`. A newer revision always un-expires the
  grant, because the allocator has reasserted it.
- `cpuCores: null` removes the cap (equal weights plus per-sandbox caps only).
- `ttlMs` range is 1 s to 1 h and is measured on a host-local monotonic clock, never
  wall time, so NTP steps cannot move grant boundaries.
- Response: `{ userKey, applied, grant: { revision, cpuCores, expiresInMs, state } }`.
  `applied: false` means the parent cgroup does not exist yet (no live sandbox); the
  grant is still recorded and applied when the tenant's next sandbox launches.

## Revision high-water and monotonic ttl

Grant state per tenant is `none`, `active`, `expired`, or `restart-expired`. Expiry uses
`performance.now()`, and same-boot rows share the process-local origin. A restart cannot
observe the previous boot's monotonic clock, so adopted rows read as `restart-expired`
with `expiresInMs: 0`, but their revision high-water is kept: a delayed pre-restart grant
is rejected as stale rather than resurrected.

## Managed mode and the bounded fallback

Once the first grant is applied the host is grant-managed (persisted in `tenancy_meta`;
it never silently leaves). Expiry then falls back to a bounded local share, never an
uncapped `cpu.max`:

- `PI_POD_SANDBOX_TENANT_CPU_FALLBACK_CORES` when set, else
  `clamp(budget / max(1, activeOwners), 0.5, budget)`, so the derived fallback never
  squeezes a tenant below a runnable share.
- The reaper is the clock that applies the fallback, and it also re-derives the fallback
  for already-degraded tenants as the owner count changes. Each expiry is applied and
  reported exactly once.

## Degraded state and the admission gate

`capacity.fairness` reports `{ mode, managed, activeGrants, expiredGrants,
degradedTenants }` where mode is `local-weights` (never managed), `grants` (every live
tenant holds an active grant), or `degraded` (managed, but at least one live tenant runs
on the fallback).

With `PI_POD_SANDBOX_GRANT_GATE_ADMISSION=1` (default), a grant-managed host refuses new
launches, and memory/disk growth through `POST /resources`, for a tenant with no active grant: `507 admission_denied` with
`details.reason: fairness_degraded` (retryable, `retryAfterMs` 15000). Existing sandboxes
keep running either way, and unowned sandboxes or never-managed hosts are never gated.
Set the knob to `0` to admit through an allocator outage at the cost of fairness.

## Restart behaviour

- Grants are persisted. After a restart, adopted rows read `restart-expired` and the
  fallback is applied on the first reaper pass; the allocator must re-issue.
- `managed` mode survives restarts. `forget` (tenant delete path) removes the row but
  keeps managed mode deliberately.
- Cgroup placement survives via the recorded `cgroupRel`; empty tenant parents left by a
  crash are removed, populated ones belong to adopted sandboxes.

## Tenant status route

`GET /v1/tenants/:userKey` returns:

```json
{
  "userKey": "alice",
  "sandboxIds": ["sb-abc", "sb-def"],
  "liveSandboxIds": ["sb-abc"],
  "cgroupPresent": true,
  "grant": { "revision": 41, "cpuCores": 4, "expiresInMs": 12000, "state": "active" },
  "effectiveCpuCores": 4,
  "degraded": false
}
```

`effectiveCpuCores` is what the parent carries right now: grant cores, the bounded
fallback, or `null` (no cap on a never-managed host). `degraded` is true when the tenant
runs on the fallback while the host is grant-managed.
