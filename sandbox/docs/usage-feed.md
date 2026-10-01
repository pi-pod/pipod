# Usage feed

Billing telemetry. All routes need the master bearer token. The feed never contains env,
prompts, file contents, image refs, labels, or tokens; only scalar counters, ids, and
bounded reason codes cross the host boundary.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /v1/usage?cursor=&limit=&nonce=` | one page of per-sandbox samples (live tiers every poll, archived as a daily heartbeat — see cadence classes) |
| `GET /v1/usage/events?after=&limit=&nonce=` | lifecycle event outbox page |
| `POST /v1/usage/events/ack` with `{ "upTo": number }` | acknowledge (and delete) events through a seq |

## Signed evidence envelope (`PI_POD_SANDBOX_EVIDENCE_SIGNING=builtin`, default off)

When signing is on, both GET responses carry `evidence`: a domain-separated
Ed25519 envelope from a host key kept at `<stateDir>/evidence/evidence.key`
(runtime-user-private, never mounted into a pod, never derived from the control
token). It covers the endpoint, the request identity (`cursor`/`after`/`limit`/
`sequence`, plus the caller's `nonce`), the host id, a stable
`outboxIncarnation` that changes only when the outbox is recreated, the issue
time and a SHA-256 digest of exactly the returned records. A nonce proves the
response is fresh; it does not make an embedded observation fresh.

Events also carry the `bootId` that originated each row — never the boot of the
page serving it. The composite identity a consumer stores must therefore be
`(hostId, sandboxId, outboxIncarnation, seq, origin bootId, runtimeGeneration)`.
A page-boot-based key would treat a replay after restart as new evidence.

Known limits this envelope does not fix:

- `durationMs` is operation latency, not billable service duration.
- `terminal` and the following `stopped` can describe one generation's final
  state; treat equal final counters as one closure, and inconsistent ones as a
  conflict rather than taking the larger.
- The outbox is best-effort: `record()` can fail silently and dropped rows are
  reported only as `droppedBeforeSeq`, so absence of an event is not proof that
  nothing happened.
- `live`/`cpuValid`/counter deltas describe resource observation, not
  user-perceived availability. Positive-duration service intervals require the
  measured ready-predicate coverage described in the isolated small profile
  plan; until that exists, the interval is unknown, not confirmed.

## Sample fields and units

One sample per sandbox known to the host, sorted by sandbox id.

| Field | Unit / meaning |
| --- | --- |
| `sandboxId`, `ownerKey` | identity; `ownerKey` null for unowned |
| `runtimeGeneration` | increments on every launch; counters comparable only within one generation |
| `tier`, `state` | internal tier and wire state (`starting` while a transition holds the sandbox) |
| `live` | true when a cgroup existed and counters were read from it this sample |
| `cpuUsec`, `cpuUserUsec`, `cpuSystemUsec` | cumulative microseconds within this generation |
| `throttledUsec`, `nrPeriods`, `nrThrottled` | cumulative cgroup throttling counters |
| `memoryCurrentBytes`, `memoryPeakBytes` | current and peak RSS-ish bytes (0 when not live) |
| `memoryPressureAvg10`, `cpuPressureAvg10` | PSI avg10 percent; -1 when unavailable |
| `pidsCurrent` | current pid count (0 when not live) |
| `oomEvents`, `oomKillEvents` | cumulative OOM counters |
| `diskCommittedBytes` | full local quota commitment (0 when archived without a local image) |
| `diskAllocatedBytes` | sparse blocks actually allocated on the host |
| `archiveSizeBytes` | uploaded archive size, null when none |
| `lastActivityAt`, `stoppedAt` | ISO-8601 timestamps |
| `cadence` | `"full"` per-poll detail, or `"heartbeat"` for a daily archived presence sample (optional; older servers ignore it) |
| `cpuValid` | false when counters were not read from a cgroup for this sample (heartbeats, or no live runtime) |
| `serviceReady`, `predicateVersion` | explicit `pod-ready-v1` observation at sample time: the authorized execution is hot, its cgroup is readable, at least one process is inside it, and no hold or error fences it. Not application health, availability or useful work |
| `monotonicMs` | runtime monotonic reading at sample time; billable durations must come from deltas of this, never from wall timestamps |

## Dedupe key and CPU delta rules

Dedupe key on the server: `(hostId, sandboxId, bootId, runtimeGeneration, sequence)`.
A new `bootId` resets sequences and generations, so it must reset server-side baselines.

CPU deltas are valid only within one `runtimeGeneration` and only when the counter did
not decrease. A generation bump or a decreased counter means the sandbox relaunched; drop
the delta and re-baseline instead of billing a negative interval.

## Event kinds

`created`, `imported`, `started`, `restored`, `frozen`, `thawed`, `stopped`, `archived`,
`deleted`, `resized`, `failed`, `terminal`.

`stopped` and `terminal` events carry `counters` (final cumulative CPU, peak memory, OOM
counts, plus `memoryCurrentBytes`) captured before teardown. This is why a sandbox that
lived between two polls is still accounted: the final counters arrive as an event even
when no snapshot ever saw it live. `durationMs` closes an operation. `detail` holds small
bounded scalars only (at most 32 keys, strings at most 256 chars); secret-looking keys
(`token`, `secret`, `password`, `env`, `authorization`, case-insensitive) are stripped
before storage, and non-scalars are dropped.

## Terminal counters

Treat `stopped`/`terminal` counters as the authoritative close for that generation: add
the final delta from the last snapshot baseline, then retire the baseline. A later event
with a higher `runtimeGeneration` starts a new baseline at zero.

## Outbox bounds and `droppedBeforeSeq`

The outbox is best-effort telemetry that must never break lifecycle transitions or grow
the DB without limit. `record()` never throws; past either bound the oldest rows are
dropped:

| Knob | Default |
| --- | --- |
| `PI_POD_SANDBOX_USAGE_EVENT_MAX_ROWS` | 50000 rows |
| `PI_POD_SANDBOX_USAGE_EVENT_MAX_AGE_HOURS` | 168 hours |

When dropped rows were never acknowledged, `droppedBeforeSeq` reports the coverage gap.
Report the gap upstream; do not block launches on it.

## Ack semantics

`POST /v1/usage/events/ack { "upTo": <seq> }` deletes every row with `seq <= upTo` and
returns `{ acknowledgedSeq, retained }`. The watermark is persisted and monotonic: acking
below it is a no-op that still returns the higher watermark. Only drain and ack on one
consumer per host, since ack deletes rows other consumers have not seen.

Suggested cadence: snapshot every 60 s and drain events on the same poll. Snapshot pages
use an opaque `cursor` (last sandbox id, `nextCursor: null` when done; default limit 200,
hard cap `PI_POD_SANDBOX_USAGE_MAX_ROWS`, default 1000). Event pages use `?after=<seq>`
(`nextAfter` for the next page; default limit 200, max 1000).

## Cadence classes

| Class | Rows | What the server gets |
| --- | --- | --- |
| `live` | hot, warm, stopped, and anything mid-transition (including a restoring archived row) | full per-poll sample, exactly as before |
| `heartbeat` | PROVABLY archived: tier `archived` with no local image and zero disk commitment | one sample per (sandbox, UTC day) at first sighting, resampled when `archiveSize`, `archiveKey`, `archiveSha256`, tier/state, owner, or `runtimeGeneration` changes; omitted otherwise. `archiveSizeBytes` comes from the stored row, `diskCommittedBytes`/`diskAllocatedBytes` are 0, `live` is false, `cpuValid` is false, and the heartbeat path performs zero `statSync` calls |
| `error` | tier `error` | full per-poll sample, never collapsed — an ambiguous row is never imputed zero |

An archived row that still has a local image (leak/quarantine) takes the full path
until the image is gone. The snapshot reads rows with a single-round-trip lean query
(`Store.allForUsageSnapshot`: no per-row labels/layers N+1 — samples never emit
them), so poll latency stays flat as the archived inventory grows. A heartbeat counts as emitted only when its sample is
actually delivered in the returned page, so draining to `nextCursor: null` shows every
row exactly once per poll. A missing heartbeat for a known archived sandbox is a gap
flag, not zero. The snapshot also records `pps_usage_snapshot_rows{class}`
(`live`/`heartbeat`/`error`) and `pps_usage_snapshot_duration_seconds`. The gauges
report the poll's full assembly and move only on the first page (`cursor` absent),
so a paginated drain does not overwrite them toward zero as pages deliver; the
duration histogram observes every call.

## What is never included

Env vars, prompts, file contents, image pull credentials, tokens, labels, image refs,
request bodies, error free text beyond bounded codes. `detail` is sanitized at write time
so even a rich caller context cannot smuggle credentials into the outbox.
