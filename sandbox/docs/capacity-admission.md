# Capacity and admission

Admission is host-local and atomic: the decision and the journal write happen in one
short SQLite transaction (`src/core/admission.ts`). A health probe or capacity report is
advisory. The host's admission decision at create/start/restore/resize time is final, so
always handle `507 admission_denied`.

## Transition states on the wire

`SandboxInfoWire.state` is `starting` only while a launch or restore holds the sandbox.
A stop, archive or delete keeps reporting the tier's state (`started`, `stopped`,
`archived`) and names itself in the additive `transition` field
(`start | stop | archive | delete | null`). This matters because a control plane
that treats `starting` as a fresh provider transition may suspend polling for its start
grace window; a two-second archive must never look like a boot.

## The four budgets

| Budget | Compared against | Refusal reason |
| --- | --- | --- |
| Scheduling floor (CPU shares) | sum of live sandbox CPU floors vs host CPUs minus `PI_POD_SANDBOX_RESERVE_CPU` | `cpu_capacity` |
| Per-sandbox ceiling (memory/disk caps) | each sandbox's own ceiling, enforced by cgroup and quota image | `unsupported_shape` at request time when above max |
| Admission budget (memory/disk promises) | `budget - committed - inFlight - quarantined`, floored at 0 | `memory_capacity`, `disk_capacity` |
| Kernel backstop (fleet cap) | `PI_POD_SANDBOX_FLEET_MEMORY_GB` / `PI_POD_SANDBOX_FLEET_CPU` applied on the parent cgroup | kills/stalls, not a typed error |
| Kernel backstop (tenant aggregate) | `PI_POD_SANDBOX_TENANT_MEMORY_GB` / `PI_POD_SANDBOX_TENANT_CPU` applied on each `pps/tenant-<key>` parent | kills/stalls inside the tenant subtree, not a typed error |

The admission budget bounds guarantees (promises). The fleet and tenant caps bound actual
use. A guarantee is not a cap, so on a host shared with anything else set the fleet cap;
that is what stops a bursting sandbox from reclaiming memory out of its neighbours. On a
per-user boat host the tenant aggregate is the tighter boundary: per-sandbox ceilings
partition the tenant, the tenant cap bounds the tenant, and the kernel OOM-kills inside
the tenant subtree instead of reclaiming memory out of vendor/system services. The memory
budget folds the tenant cap in (`min(explicit ?? min(total − reserve, fleet cap), tenant
cap)`), so admission refuses past it with retryable `507`s — backpressure, not OOM.

## Ceiling vs floor memory mode

`PI_POD_SANDBOX_MEMORY_ADMISSION=ceiling` (default) reserves each live sandbox's full
memory ceiling. `floor` is the legacy mode that reserves only the 0.5 GiB reclaim floor
and lets ceilings overcommit. Set `floor` only for legacy hosts during rollout.

A 24 GiB budget therefore admits six 4 GiB sandboxes under `ceiling` mode, not forty
eight 0.5 GiB floors. Expect more `507`s after switching until placement reads capacity.

## Desired-total reservation model

Each reservation states the sandbox's desired *totals* once its transition completes, not
a delta. The charge is the delta above the row's current commitment (missing row counts
as 0), so every sandbox is counted exactly once:

- Booting create: the row is `stopped`, so the reservation carries the whole ceiling.
- Resize of a hot sandbox: the row is `hot`, so only the increase is charged.
- Only one `reserved` row per sandbox is allowed; a second concurrent transition is a
  `409 conflict`, because it would double charge the delta.

`reserve()` checks in this order: single in-flight transition, transition slots,
memory (debt first, then headroom), CPU floors, disk. Exact fit is admitted
(`delta > available` refuses; `delta == available` passes).

## Capacity report fields

`GET /v1/capacity` (master token) returns `CapacityReportV1`. The same object is embedded
as `HealthResponse.capacity` (unauthenticated, host aggregates only, no tenant data).

| Field | Meaning |
| --- | --- |
| `memory.committed` | steady state promises of live (hot/warm) sandboxes |
| `memory.inFlight` | deltas held by transitions not yet at steady state |
| `memory.quarantined` | reservations whose runtime state could not be resolved; charged until resolved |
| `memory.debt` | `committed - budget` when pre-upgrade workloads exceed the budget; blocks all increases |
| `memory.available` | `max(0, budget - committed - inFlight - quarantined)`; a new request's ceiling is compared to this |
| `disk.committed` | full quota of every local (non-archived) workspace, including stopped/error |
| `disk.quarantined` | archived rows that still hold a local image, plus unresolved reservations |
| `disk.allocated` | blocks sparse images actually occupy on the host (informational, not charged) |
| `transitions.inFlight/maxInFlight` | launch/restore slots held vs `PI_POD_SANDBOX_MAX_CONCURRENT_TRANSITIONS` (default 8) |
| `transitions.archivesInFlight/maxConcurrentArchives` | archive packs/uploads running vs bound (default 2) |
| `fairness.mode` | `local-weights`, `grants`, or `degraded` (see `docs/tenancy-cpu.md`) |
| `capabilities.tenantLimits` | kernel aggregate caps on every tenant parent (`memoryMaxBytes`, `cpuMaxCores`; `null` = uncapped). A boat host must report a finite memory cap |

Example (abbreviated):

```json
{
  "contractVersion": 1,
  "hostId": "host-1",
  "bootId": "9f2c…",
  "generation": 42,
  "capabilities": {
    "maxShape": { "cpu": 2, "memoryGB": 4, "diskGB": 20 },
    "memoryAdmission": "ceiling"
  },
  "memory": {
    "budgetBytes": 25769803776,
    "committedBytes": 12884901888,
    "inFlightBytes": 0,
    "quarantinedBytes": 0,
    "debtBytes": 0,
    "availableBytes": 12884901888
  },
  "disk": { "committedBytes": 107374182400, "quarantinedBytes": 0, "availableBytes": 322122547200 },
  "transitions": { "inFlight": 1, "maxInFlight": 8, "archivesInFlight": 0, "maxConcurrentArchives": 2, "pendingOperations": 1, "quarantinedOperations": 0 },
  "fairness": { "mode": "local-weights", "managed": false, "activeGrants": 0, "expiredGrants": 0, "degradedTenants": 0 }
}
```

Validate on the server: `contractVersion === 1`, all numbers finite and >= 0, a smaller
`generation` for the same `bootId` is stale, and a `sampledAt` older than the freshness
window means assume no headroom.

Disk rule: compare the full requested quota in bytes. 19.9 GiB free refuses a 20 GiB
request; exact fit is admitted. A restore of an archived sandbox reserves its full disk
quota (and memory ceiling) before download; imports of archived metadata reserve nothing
until restore.

Malformed shapes (`resources.*` not a finite number greater than zero) are `400 bad_request` on
create, import and resize in both clamp modes: a negative quota would otherwise be stored and
subtract from committed capacity.

## Disk quarantine of leaked archived images

An archived row should hold no local state. If one still has a quota image (local cleanup
failed after a verified upload), its full quota stays charged as `disk.quarantined` until
an operator resolves it. The row is already `archived`, so the data is safe in the object
store; deleting the sandbox releases the leaked local image.

Journal reservations that recovery could not resolve are also charged (memory and disk)
until resolved. They are never silently deleted.

## Transition capacity

Create/start/restore hold a launch slot while in flight; resize and import never do. Past
`PI_POD_SANDBOX_MAX_CONCURRENT_TRANSITIONS` the host refuses with `transition_capacity`
(retryable, `retryAfterMs` 5000). Archive concurrency is bounded separately by
`PI_POD_SANDBOX_MAX_CONCURRENT_ARCHIVES` (default 2); a saturated host answers
`archive_busy` immediately instead of queueing uploads.

## Journal recovery rules

On startup, reservations from earlier boots are resolved by inspecting the runtime, mounts
and quota image. A failing probe counts as `unknown`, never `gone`, because releasing on
a probe error could free resources a live sandbox still holds.

| Probe verdict | Action |
| --- | --- |
| live | commit (the row already carries the commitment after reconcile) |
| gone | release, only after cleanup is confirmed |
| unknown | quarantine with reason `unresolved after restart`; stays charged |

Interrupted creates get special handling (see `docs/operations-idempotency.md`): a still
running create is adopted (row becomes hot, operation succeeds); otherwise the workspace
is retained as a stopped row and the operation fails with resolution `quarantined`. The
service never deletes a workspace on a restart alone.

## Typed error table

`ErrorResponse.error.details` is discriminated on `kind`. Render user messages from
`details`, not from `message`; the sanitizer may drop `message`/`hint` and keep `details`
(it contains no paths, URLs, env or tokens by construction).

| HTTP | `code` | `details.reason` | Retryable |
| --- | --- | --- | --- |
| 507 | `admission_denied` | `memory_capacity` | usually true (`retryAfterMs` 15000 when other reservations are in flight) |
| 507 | `admission_denied` | `cpu_capacity` | true |
| 507 | `admission_denied` | `disk_capacity` | true (same 15000 ms hint when in flight) |
| 507 | `admission_denied` | `transition_capacity` | true (`retryAfterMs` 5000) |
| 507 | `admission_denied` | `network_capacity` | true (no network slots left) |
| 507 | `admission_denied` | `memory_debt` | true (`retryAfterMs` 30000; drains only when grandfathered workloads leave) |
| 507 | `admission_denied` | `fairness_degraded` | true (`retryAfterMs` 15000; allocator must re-issue a grant) |
| 400 | `unsupported_shape` | `unsupported_shape` | false; shrink the request or place elsewhere (`details.requested` / `details.maximum`) |
| 409 | `idempotency_conflict` | n/a (`kind: operation`) | false with the same key; use a new key |
| 409 | `stale_revision` | n/a (`kind: revision`) | re-read and retry with the current revision |
| 409 | `conflict` | n/a | legacy semantic conflicts (transition already in flight, disk shrink, memory shrink while live) |

## Inspecting and resolving quarantine

Quarantine is visible and never silent:

- Gauges: `pps_admission_memory_quarantined_bytes`,
  `pps_admission_disk_quarantined_bytes`, `pps_admission_quarantined_operations`,
  plus `pps_admission_memory_debt_bytes` and `pps_admission_memory_available_bytes`.
- `GET /v1/capacity`: `memory.quarantinedBytes`, `disk.quarantinedBytes`,
  `transitions.quarantinedOperations`.
- Logs: `reservations quarantined pending operator review` with the operation ids.

Resolution: `DELETE /v1/sandboxes/:id` removes the sandbox and its local image, which
releases the charge. For an interrupted create, `DELETE /v1/operations/:key` deletes by
the recovered sandbox id and marks the resolution `cleaned` when nothing remains.
Quarantined operation rows stay until recovery or an operator resolves them.

## Rollout notes

| Knob | Default | Note |
| --- | --- | --- |
| `PI_POD_SANDBOX_MEMORY_ADMISSION` | `ceiling` | set `floor` for legacy overcommit behaviour during rollout |
| `PI_POD_SANDBOX_MEMORY_BUDGET_GB` | unset (derives `min(total - reserve, fleet cap, tenant cap)`) | set to the validated safe threshold per host class; the tenant cap still binds tighter |
| `PI_POD_SANDBOX_TENANT_MEMORY_GB` / `PI_POD_SANDBOX_TENANT_CPU` | uncapped static; `5.5` GiB + derived CPU in boat mode | boat refuses to start on an explicit memory `0`; multi-tenant static hosts should size with the fleet cap instead |
| `PI_POD_SANDBOX_CLAMP_OVERSIZED_SHAPES` | `0` (off) | legacy silent clamp; an advertised 8 GiB request must be honoured or refused, never shrunk |
| `PI_POD_SANDBOX_MAX_CPU` / `_MAX_MEMORY_GB` / `_MAX_DISK_GB` | 2 / 4 / 20 | advertised as `capabilities.maxShape` |

Grandfathering: pre-upgrade workloads that exceed a new budget appear as
`memory.debtBytes > 0`. Nothing is killed to clear debt; the host refuses new admissions
(`memory_debt`) until the debt drains. Unknown `PI_POD_SANDBOX_*` variables are named in
a startup warning so a misspelled knob is found instead of silently ignored.
