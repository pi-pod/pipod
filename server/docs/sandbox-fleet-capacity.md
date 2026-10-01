# Sandbox fleet capacity operations

Operator runbook for the fleet admission, bounded-wait, CPU-fairness, and
owner-identity controls (plan workstream 4/5). All feature flags below
default OFF; enabling any of them before its qualification gate is an
unguarded change, not a rollout.

## Feature flags and qualification gates

| Flag | Default | Enable only after |
| --- | --- | --- |
| `CAPACITY_WAIT_ENABLED` | `false` | Clients render `capacityWait` states (clients stay on immediate errors until then) |
| `CPU_FAIRNESS_ENABLED` | `false` | Wait subsystem ON (the scheduler refuses to run the allocator without it) **and** native rev3+ on all fleet hosts **and** tenancy debt zero (see below) **and** a canary tick review |
| `POD_ALLOW_8GIB_MEMORY` | `false` | Qualified 8-GiB workers exist **and** `POD_MAX_MEMORY_GB` raised; standard stays 4 GiB |

Related ceilings (unchanged by enabling anything):
`POD_MAX_CONCURRENT_PER_USER=20` (global user budget, atomic),
org `maxConcurrentPods` (separate aggregate, narrowing only),
`POD_SANDBOX_MAX_ARCHIVE_AFTER_MINUTES=60`,
`CAPACITY_WAIT_SECONDS=60` (5–600), `CAPACITY_FRESHNESS_SECONDS=30`,
`CPU_GRANT_TTL_MS=60000`, `CPU_ALLOCATOR_INTERVAL_MS=15000`.

In fleet mode (`SANDBOX_PLACEMENT_MODE=fleet`), zero reachable workers is
a typed client signal, not a server fault: `POST /pods/resolve` (and
`POST /pods` at plan time) answers HTTP 503 with
`"the sandbox fleet is unreachable; retry shortly"` plus
`detail: { code: "fleet_unavailable", reason: "fleet_unavailable",
retryable: true, retryAfterMs: 15000 }`. Retry with backoff; never 500,
never a control-plane fallback.

`PI_POD_SANDBOX_URL` is not a fleet-mode denylist. A static deployment may use
`http://pi-pod-sandbox:8433` as both its local service URL and a registered
`sandbox_hosts` URL. Fleet placement is controlled by the registered active-host
table: with no eligible host it fails closed and never falls back to that URL;
only single mode uses `PI_POD_SANDBOX_URL` when the table is empty.

## Bounded waits: reading `capacityWait`

`GET /v1/pods/:id` carries `capacityWait` (null when the pod never queued):

- `waiting` — valid, entitled, fleet full. Progress against `deadlineInMs`
  (and the additive `deadlineAt` ISO timestamp). The pod holds one user
  concurrency slot but no host reservation. While waiting, the pod's
  `preparationPhase` reads `waiting-for-capacity` instead of the generic
  `provisioning-sandbox`.
- `admitted` — a retry found room; launching/waking proceeds.
- `expired` — final deadline hit with no room. Terminal for this launch;
  a new launch may be tried. Distinct from waiting: stop progress UI.
  The pod's `stateReason` carries the typed code
  `launch_failed:capacity_wait_expired: … (waited Ns for <reason>)` and
  `stateReasonCode` reads `capacity_wait_expired`; the wait view reports
  `waitedSeconds`.
- `cancelled` — user cancel, archive, or pod deletion ended the wait
  (synchronously, metric `cancelled` — never a later `expired`).

`reason` is a stable enum (`memory_capacity`, `cpu_capacity`,
`disk_capacity`, `transition_capacity`, `network_capacity`, `memory_debt`,
`fairness_degraded`, `fleet_capacity`, `unsupported_shape` never waits);
`detail` carries validated numbers only, never host prose. The view
additionally projects validated `required`/`available`/`unit` display
fields (absent when the detail does not carry them). Host-internal wait
fields (operation key, host URL) are never on the wire.

At expiry the terminal names the LAST recorded refusal, not the reason the
wait enqueued with: a wait admitted on `fairness_degraded` whose later
attempts refused `disk_capacity` expires reporting `disk_capacity` (with
the numbers) in the log line, the `stateReason` text, and the wait view.
Only a wait with zero recorded attempts still reports the enqueue reason.

The `?wait=` long-poll wakes on any wait-state change (attempts, reason
refresh, terminal outcome), not just pod-row changes.

Cancel: `DELETE /v1/pods/:id/capacity-wait` finishes the wait as
`cancelled` synchronously (the in-flight waiter still rolls back its host
operation by key).
**Create-wait cancel** rolls back the host operation by key.
**Wake-wait cancel ends the waiting only** — workspace, archive, and active
jobs are untouched; the pod returns to stopped/archived. Deleting or
archiving the pod also ends any wait as `cancelled`.

## Refused launches: reading `state_reason`

With the wait subsystem OFF (or a refusal no wait can converge), a host
admission refusal is terminal for the launch immediately. The pod's
`stateReason` then carries the typed code
`launch_failed:admission_denied: <sentence>: <numbers>` and
`stateReasonCode` reads `admission_denied` — for example

```
launch_failed:admission_denied: sandbox hosts at capacity (memory_capacity):
4.00 GiB required, 2.83 GiB available of 2.83 GiB budget
```

The same string is the server log line, the `resolved_config.warnings`
entry the client polls, and the launch-failed push body. It is composed
inside the leakage boundary — static copy plus the enums and numbers the
host sent in `error.details` and the server re-validated — so the host's
own `message` and `hint` are still dropped, and a refusal whose `details`
is absent, malformed, or unrecognized falls back to the generic
`operation failed (507)`.

Read it as: shrink the request (`resources` in the launch config), free the
named resource on the host, or place the launch elsewhere. `memory_debt`
and `fairness_degraded` clear on their own; `unsupported_shape` names the
requested shape against the host maximum and never clears by retrying.

## Failed launches that never acquired compute

A launch that fails before any workspace exists (`provider_state='gone'`,
no `provider_sandbox_id`) converges to `state='archived'` with its
`state_reason` intact — it never lingers as an `active` row no listing can
show (`listPods` excludes `provider_state='gone'` unless `GET /v1/pods`
passes `includeGone=true`, which `pipod gc` uses). Rows that predate this
convergence are swept by the operator command:

```
node dist/fleet.js reconcile-gone --dry-run   # print every gone row + decision
node dist/fleet.js reconcile-gone --yes        # archive the workspace-less rows
```

Every row is printed with its decision. Rows naming a provider sandbox are
REFUSED (a workspace may exist — confirm the provider 404s first); nothing
is ever deleted, only converged to `archived` (still addressable by id and
deletable via the normal DELETE route).

## pod.create_unresolved (ambiguous create, assignment retained)

A lost create response MUST NOT become a second create on another host.
The server retains the original assignment and records:

1. Find: `SELECT * FROM audit_log WHERE action='pod.create_unresolved'`
   (detail carries `kind` [`unresolved`|`quarantined`], `hostUrl`,
   `operationKey`). The pod row keeps its frozen host URL; nothing was
   created elsewhere — that is the invariant, not a stuck state.
2. Ask the ORIGINAL host only:
   `GET /v1/operations/<key>` (platform token).
   - `pending` → wait/re-poll; do NOT create elsewhere.
   - `succeeded` → adopt `sandboxId` (record it on the pod; no new create).
   - `failed`/`cancelled` + `crossHostRetrySafe:true` → a same-key attempt
     on another host is safe.
   - `failed`/`cancelled` + quarantined (or host unreachable/unknown key
     with a live host) → STOP. Keep the assignment; escalate with the
     audit row + host response attached.
3. Cleanup is by key on the ORIGINAL host only:
   `DELETE /v1/operations/<key>` (host deletes by recovered id or rolls
   back; verify via re-GET). NEVER delete-and-recreate the pod to "fix" it
   (new pod id = new operation key = orphaned original + possible duplicate).
4. Tombstones expire after 72h; unknown-key 404 past that horizon means the
   host never persisted (or already forgot) the create.

## Gated rollout (allocator / fairness, when qualified)

1. Preconditions: wait subsystem ON (`CAPACITY_WAIT_ENABLED=true`) first —
   the scheduler refuses to run the allocator without it; native rev3+ on
   all fleet hosts (contract check fails closed otherwise); tenancy debt
   zero (`unownedLive`+`unownedInitializable` drained via owner-init sweep).
2. Enable `CPU_FAIRNESS_ENABLED=true` on ONE canary server; watch
   `pipod_cpu_grants_total`, `fairness.mode` per host (`grants`, not
   `degraded`), and capacity-wait `reason="fairness_degraded"` rate (expect
   only first-create/first-cold-wake transients ≤ ~1 tick).
3. Roll forward host by host. Rollback = the host-side gate knob below —
   NEVER just the server flag (see warning). Watch per-host fairness with
   `fleet list` (fairness: managed/gate line) and `fleet doctor`.

### ⚠ Disabling the CPU controller after native managed mode is sticky is NOT a clean rollback

Native `managed_mode` is set-once and persisted; NO API clears it — verified,
no unmanaged/reset endpoint exists and none should be invented ad hoc.
Consequences of turning the allocator off after any grant was ever PUT:
- Hosts stay grant-managed: existing grants keep working until their TTL,
  then tenants fall to the bounded fallback and new launches for grantless
  tenants fail `fairness_degraded` — with no issuer left, these NEVER
  converge. This looks like an outage, not a rollback.
- There is NO supported "unmanage" operation. Do NOT invent one, do NOT
  hand-edit `tenancy_meta`/SQLite, and do NOT "fix" it with ad-hoc SQL.
Safe currently-supported options: (a) ROLL FORWARD — re-enable the allocator
and let it re-issue (recovery is automatic; degraded clears as grants land);
(b) if the allocator itself is the problem, keep it enabled but pointed at a
known-good build/config — the grants, not the flag, are the control plane;
(c) HOST-SIDE GATE ROLLBACK (the documented break-glass when admissions must
flow NOW and the allocator cannot be restored quickly) — set on EACH managed
host `PI_POD_SANDBOX_GRANT_GATE_ADMISSION=0` and recreate/restart the sandbox
container so the host process re-reads its env. Effect: the host stops
refusing grantless tenants (`fairness_degraded` off) while STAYING managed —
existing grants keep enforcing, live sandboxes are untouched, and new launches
are admitted onto the bounded local fallback until the allocator re-issues.
This is intentionally per-host and explicit: flipping one server flag must not
silently un-cap a fleet. Confirm with `fleet list` / `fleet doctor` (gate=off
is flagged as the rollback state). The gate state reaches the server inside
the capacity report (`fairness.gateAdmissions`, see the native companion
patch proposed alongside this change): on hosts predating
that report the server conservatively assumes gate-ON, so placement still
waits out the deadline instead of flowing — deploy the reporting native
build before relying on this rollback. To restore: re-enable the allocator,
wait for grants to land (`fairness.mode` back to `grants`, degradedTenants 0),
then set the knob back to `1` (or unset) and recreate the container again.
(d) per-tenant LAST RESORT via existing APIs only: issue a correct-revision
grant through the normal allocator path. What is NOT supported: flipping
managed hosts back to `local-weights`, resetting revisions, or deleting
ledger rows to "start over" (stale-revision guards + tombstones make this
actively harmful — delayed pre-reset grants would be rejected or, worse,
misapplied).

### Enablement non-blessing

Production enablement of fairness/grants is NOT blessed here: it requires
real native+controller qualification (multi-host grant lifecycle, TTL-lapse
recovery, first-create/first-wake convergence under the real allocator).
Defaults remain OFF.

## Legacy owner migration (before fairness)

Unowned sandboxes sit flat beside tenant parents and each competes with a
whole tenant for CPU once fairness is on. Sequence:
1. Deploy native rev3+ on all fleet hosts.
2. The server `owner-init` worker maps `pods.user_id` → canonical key and
   initializes stopped/archived/error sandboxes exactly once (CAS
   null→userKey; live sandboxes grandfather until they stop — never moved;
   foreign keys park in `conflict` + audit, never overwritten).
3. Watch host `tenancy` until `unownedInitializable` is 0.
4. Operator enables `PI_POD_SANDBOX_REQUIRE_OWNER=1` natively (unowned
   launches → `400 owner_required`); `unownedLive` drains as legacy pods
   stop and relaunch owned.

## Fleet membership operations

- `fleet list` — hosts with live health/headroom (empty fleet fails closed
  in `fleet` placement mode; never falls back to `PI_POD_SANDBOX_URL`). A
  registered local host may use the same URL as the static deployment service.
- Legacy hosts (no capacity contract): excluded from fleet placement by
  default. Rolling upgrades may set `SANDBOX_ALLOW_LEGACY_HOSTS=true`
  explicitly (ranked last, host admission final); malformed or
  misidentified reports are never eligible regardless. Floor-mode hosts
  refuse platform placement until configured for ceiling admission.
  Pinned wakes on platform fleet hosts require the same evidence gate
  (validated, fresh, identity-matched ceiling contract) and refuse with a
  typed non-destructive error otherwise — mapping and data stay intact,
  zero native start calls, never queued, never migrated. BYOK/single-host
  and unregistered URLs keep deliberate compat (host admission final).

- `fleet drain <id>` — stop placing new pods; existing pods empty via their
  own retention timers. `fleet archive <id>` empties now (interrupts work).
- `fleet rehome <id>` — moves ARCHIVED pods only, preserving the pod owner
  on import. Live workspaces never move. (Hold-based guarded rehome is
  retirement scope once native v5 + PR226 land; until then this legacy path
  is the only move operation — use it only for drained hosts.)
- Image preloads (`fleet preload-image`) use the platform token every fleet
  host accepts; registry auth rides that request only and is never stored.
