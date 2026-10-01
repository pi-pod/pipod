# Sandbox cost controls — client behavior

Product policy (the server enforces; this client only presents it):

- **Standard shape:** 2 shared vCPU / 4 GiB memory / 20 GiB writable disk per sandbox.
  Shared image layers are not charged repeatedly; usable space is slightly under quota
  (filesystem metadata).
  The `sandbox` fleet holds a documented full local-disk
  reservation per stopped workspace, so stopped rows render `local disk retained`.
  A cold-storage claim additionally needs
  sandbox-confirmed archive (`sandboxState=archived`); a bare logically-hidden row claims
  nothing about storage.
- **Concurrency:** up to **20 concurrent sandboxes per platform user**,
  across organizations. Co-located (`--on`) children share the host's machine and hold no
  extra slot. The server's configured value is authoritative — when the client names a cap
  number it always quotes the server's refusal, never a local constant.
- **Retention:** 15 minutes of genuine inactivity stops a pod (waiting on a model,
  approval, network, or detached build is not idle); 60 stopped minutes archives it.
  Archive uploads and verifies before local disk is released. (Durations are the
  platform defaults; an organization policy may set its own — clients never hardcode
  them into refusal copy.)
- **Larger memory:** 8 GiB is capability-gated opt-in. The standard stays 4 GiB. The client
  never clamps an 8-GiB request down itself: it either receives 8 GiB on a qualified host
  or a clear unsupported/capacity refusal, and any server clamp is printed verbatim.

## Statuses the client shows

| What you see | Meaning | Cost to wake |
| --- | --- | --- |
| `active` | Running sandbox | — |
| `Stopped — local disk retained` | Active row, stopped sandbox; workspace files kept | `attach` restarts in seconds |
| `Archived — restores on next use` | Archived sandbox under an active row | Restores in seconds-to-minutes depending on workspace size |
| `Archived — hidden …` | Logically archived row (`list --archived` shows it); suffix names the sandbox layer when known (`disk retained` still consumes capacity, `cold storage` is uploaded and verified) | `restore`, then attach as above |
| `preparing` / `provisioning-sandbox` / `running-init` | Still starting | Wait; do not create a duplicate |

Logical archive is hide, not delete. `stop` releases compute now and keeps the disk.
`archive` hides now; cold archive follows the 60-minute policy. `restore` returns the row;
attach starts the sandbox when needed. There is no universal 10-second restore promise:
expect seconds for stopped disks and seconds-to-minutes for archived workspaces depending on size, longer near quota.

## Capacity errors

- **Per-user / org concurrency (409):** stop a running pod (`pipod stop <pod>`) or wait for
  idle sleep, then retry. Do not relaunch in a loop.
- **Fleet at capacity (503):** retry shortly without creating duplicates; stopped pods keep
  disks and archived pods restore later. Persistent pressure needs registered capacity
  (an owner action), not client retries.
- **Temporarily unavailable (409):** the pod is mid-transition — retry shortly.
- **Unsupported shape (400):** the worker shape is not available; retry at standard size.
- **Restore-first (409):** `pipod restore <pod>`, then retry.

The client renders these from validated codes and numbers only. Raw backend text, URLs
with credentials, and secrets stay redacted. A lost launch reply is resolved by listing
first (adopt the landed pod) rather than blindly relaunching.

## Bounded capacity wait (capacity contract §1)

When the fleet is full, a valid entitled launch/wake queues instead of failing at once
(rollout-gated server-side; older servers omit the field and keep immediate errors):

- `waiting` — the pod holds one concurrency slot but no host reservation. The launch
  narrates `waiting for capacity — …` once per reason with time left on the final
  deadline (default 60s total). Ctrl-C before Pi starts keeps its existing meaning:
  the fresh pod is deleted, which ends the wait. `DELETE /v1/pods/:id/capacity-wait`
  (client `cancelCapacityWait`) ends the wait cooperatively and keeps the pod row.
- `admitted` — a retry found room; provisioning continues normally.
- `expired` — FINAL failure for this launch: no room before the deadline. The client
  reports the reason copy and stops; launch again by hand, never auto-duplicate.
- `cancelled` — the wait was cancelled (or the pod deleted); the row survives deletion
  only if it was not the thing deleted.

Wait progress reuses the existing `GET /v1/pods/:id?wait=<ms>` long poll — no new
client request fields. Typed `detail.reason` values (`memory/cpu/disk/transition/network_capacity`,
`memory_debt`, `fairness_degraded`, `fleet_capacity`, `unsupported_shape`) map to the
same actionable copy as the immediate errors.
