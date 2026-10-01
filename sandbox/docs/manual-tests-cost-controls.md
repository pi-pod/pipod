# Manual tests for cost controls

Reproducible privileged plan for a **disposable** Linux host. Never run this on
production: scenarios fill disks, kill the service mid-create, and delete sandboxes.
None of this has been executed on production.

## Prerequisites

- Disposable Linux host with cgroup v2, root shell, `crun`, `zstd`, `mkfs.ext4`/loop devices, Node 22+, this repo (`npm ci && npm run build`).
- `scripts/build-init.sh` must have produced `bin/pps-init` (the harness builds it if
  missing).
- `PI_POD_SANDBOX_NETWORK_TESTS=1` is required for the privileged suite; it exercises
  real netns bridges.

```bash
sudo -i
export PI_POD_SANDBOX_TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
export PI_POD_SANDBOX_NETWORK_TESTS=1
export PI_POD_SANDBOX_STATE_DIR=/tmp/pps-manual/state
export BASE=http://127.0.0.1:8433
auth() { curl -s -H "Authorization: Bearer $PI_POD_SANDBOX_TOKEN" "$@"; }
```

Run the automated privileged suite first; the curl scenarios below assume it passes:

```bash
PI_POD_SANDBOX_NETWORK_TESTS=1 npm run test:root
# or, the CI gate (fails if any root test is skipped instead of executed):
sudo --preserve-env=PATH,PI_POD_SANDBOX_NETWORK_TESTS env PATH="$PATH" ./scripts/root-test-gate.sh
```

CI runs exactly this gate (`root-tests` job in `.github/workflows/deploy.yml`) on an
isolated, ephemeral GitHub-hosted `ubuntu-24.04` runner before any image is built or
signed. The gate refuses to pass when the suites skip themselves, so a runner missing
`crun`, loop devices or cgroup v2 controllers fails the build rather than reporting green.
The production workers are never used for root or stress tests; the full 1000-cycle churn
qualification (plan §5.2) remains a separate, still-gated exercise on disposable hardware.

Scenarios that need more than 24 GiB RAM are marked SIMULATE: use a smaller
`PI_POD_SANDBOX_MEMORY_BUDGET_GB` to get the same admission arithmetic on a small host.

## 1. Exact-fit memory admission (SIMULATE on small hosts)

Needs 24 GiB budget for full fidelity; on a smaller host substitute e.g.
`PI_POD_SANDBOX_MEMORY_BUDGET_GB=4` with six 0.5 GiB floors replaced by 4 GiB ceilings
scaled down (e.g. budget 6, six 1 GiB ceilings, 7th refused).

```bash
export PI_POD_SANDBOX_MEMORY_BUDGET_GB=24
export PI_POD_SANDBOX_MEMORY_ADMISSION=ceiling
node dist/main.js & echo $! > /tmp/pps-manual/pid
for i in $(seq 1 6); do
  auth -X POST $BASE/v1/sandboxes -H 'Content-Type: application/json' \
    -d '{"image":"<img>","workdir":"/work","resources":{"memoryGB":4}}'
done
auth $BASE/v1/capacity | jq .memory.availableBytes
# 7th create: expect 507 with details.reason == memory_capacity
auth -X POST $BASE/v1/sandboxes -H 'Content-Type: application/json' \
  -d '{"image":"<img>","workdir":"/work","resources":{"memoryGB":4}}' | jq .error.details
```

Expected: six `200`s, `availableBytes` near 0, 7th returns `507 admission_denied` with
`details: { kind: admission, reason: memory_capacity, retryable: true }`. Exact fit is
admitted, so six is not seven: the boundary is the test.

## 2. Disk byte-exact admission

```bash
FREE=$(auth $BASE/v1/capacity | jq .disk.availableBytes)
# Request 20 GiB when only ~19.9 GiB is free: expect 507 disk_capacity.
auth -X POST $BASE/v1/sandboxes -H 'Content-Type: application/json' \
  -d '{"image":"<img>","workdir":"/work","resources":{"diskGB":20}}' | jq .error.details
```

Expected: `reason: disk_capacity`. A request exactly equal to `availableBytes` succeeds;
0.1 GiB over fails. That strictness is why quota math must use bytes, not rounded GiB.

## 3. Oversized shape refused, never clamped

```bash
auth -X POST $BASE/v1/sandboxes -H 'Content-Type: application/json' \
  -d '{"image":"<img>","workdir":"/work","resources":{"memoryGB":8}}' | jq .error
```

Expected: `400 unsupported_shape` with `details.requested.memoryGB == 8` and
`details.maximum.memoryGB == 4`. The sandbox must not be created at 4 GiB silently; a
caller that asked for 8 GiB and received 4 would OOM later and blame the fleet.

## 4. Create idempotency

```bash
KEY="manual-$(date +%s)-abcdef"
auth -X POST $BASE/v1/sandboxes -H 'Content-Type: application/json' \
  -d "{\"image\":\"<img>\",\"workdir\":\"/work\",\"operationKey\":\"$KEY\"}" | tee /tmp/pps-manual/a.json
ID=$(jq -r .id /tmp/pps-manual/a.json)
# Same key, same body: replays the original result, no second sandbox.
auth -X POST $BASE/v1/sandboxes -H 'Content-Type: application/json' \
  -d "{\"image\":\"<img>\",\"workdir\":\"/work\",\"operationKey\":\"$KEY\"}" | jq .id
# Same key, different body: 409.
auth -X POST $BASE/v1/sandboxes -H 'Content-Type: application/json' \
  -d "{\"image\":\"<img>\",\"workdir\":\"/other\",\"operationKey\":\"$KEY\"}" | jq .error.code
# Status route.
auth $BASE/v1/operations/$KEY | jq '{status,crossHostRetrySafe,resolution}'
```

Expected: second call returns the same `ID` (list sandboxes to confirm only one new
row); third returns `409 idempotency_conflict`; status shows `succeeded` with
`crossHostRetrySafe: false`.

## 5. Archive-if-stopped with a stale revision

```bash
ID=<a stopped sandbox id>
REV=$(auth $BASE/v1/sandboxes/$ID | jq .revision)
auth -X POST $BASE/v1/sandboxes/$ID/stop | jq .state
# Stale guard: expect 200 with outcome revision_mismatch, sandbox still stopped.
auth -X POST $BASE/v1/sandboxes/$ID/archive-if-stopped -H 'Content-Type: application/json' \
  -d "{\"expectedRevision\":$REV,\"expectedStoppedAt\":\"1970-01-01T00:00:00.000Z\"}" | jq .outcome
# Fresh guard archives (needs a configured archive driver; driver none returns 409).
auth $BASE/v1/sandboxes/$ID | jq '{revision,stoppedAt}'
```

Expected: `revision_mismatch` (a 200, not an error; the timer worker re-reads and
decides again). A racing wake that wins the transition yields `not_stopped`, never a
re-archive of a running sandbox.

## 6. Bounded archive wave (`archive_busy`)

Set `PI_POD_SANDBOX_MAX_CONCURRENT_ARCHIVES=1`, stop three sandboxes past their
`archiveAfterMinutes`, and fire three `archive-if-stopped` calls concurrently. Expected:
at least one answers `200 outcome: archive_busy`, and `capacity.transitions` shows
`archivesInFlight: 1, maxConcurrentArchives: 1`. Overdue work stays visible and is
picked up on the next tick, not dropped.

## 7. Owner and tenant cgroup layout

```bash
auth -X POST $BASE/v1/sandboxes -H 'Content-Type: application/json' \
  -d '{"image":"<img>","workdir":"/work","owner":{"userKey":"alice"}}' | jq '{id,owner}'
ID=<new id>; auth -X POST $BASE/v1/sandboxes/$ID/start | jq .state
ls /sys/fs/cgroup/pps/
ls /sys/fs/cgroup/pps/tenant-alice/
cat /sys/fs/cgroup/pps/tenant-alice/cpu.weight
```

Expected: `pps/tenant-alice/<id>` exists with `cpu.weight` 100 (equal parent weights);
an unowned sandbox lands at flat `pps/<id>`. A running sandbox is never moved live; the
layout applies at the next start.

## 8. CPU grant apply, expire, stale

```bash
auth -X PUT $BASE/v1/tenants/alice/cpu-grant -H 'Content-Type: application/json' \
  -d '{"revision":1,"cpuCores":2,"ttlMs":5000}' | jq .
auth $BASE/v1/tenants/alice | jq '{grant,effectiveCpuCores,degraded}'
sleep 6
auth $BASE/v1/tenants/alice | jq '{grant,effectiveCpuCores,degraded}'
# Stale revision: expect 409 stale_revision.
auth -X PUT $BASE/v1/tenants/alice/cpu-grant -H 'Content-Type: application/json' \
  -d '{"revision":1,"cpuCores":2,"ttlMs":5000}' | jq .error.code
```

Expected: first grant `applied: true` (or `false` with no live sandbox; still recorded),
after 5 s the grant reads `expired` with the bounded fallback in `effectiveCpuCores` and
`degraded: true` on a managed host; the repeat at revision 1 is `409 stale_revision`.

## 9. Usage snapshot, events, ack

```bash
auth "$BASE/v1/usage?limit=2" | jq '{sequence, samples: (.samples | length), nextCursor}'
CURSOR=$(auth "$BASE/v1/usage?limit=2" | jq -r .nextCursor)
auth "$BASE/v1/usage?cursor=$CURSOR&limit=2" | jq '.samples | length'
auth "$BASE/v1/usage/events?after=0" | jq '{n: (.events | length), nextAfter, droppedBeforeSeq}'
auth -X POST $BASE/v1/usage/events/ack -H 'Content-Type: application/json' \
  -d '{"upTo":<nextAfter>}' | jq .
```

Expected: pages chain via `nextCursor`; events drain via `nextAfter`; ack returns the
watermark and deletes acked rows (`retained` drops). `droppedBeforeSeq` non-null means
the outbox shed unacknowledged rows: report the gap, do not block launches.

## 10. Restart during create

Start a create, then kill the service between `crun run` and the row going hot (add a
temporary sleep in the launch path or SIGKILL the service process mid-create). Restart
the service with the same state dir and check:

```bash
auth $BASE/v1/operations/$KEY | jq '{status,resolution,sandboxId}'
auth $BASE/v1/sandboxes/<id-from-status> | jq '{state,tier}'
```

Expected: either the create is adopted (operation `succeeded`, sandbox hot) or the
workspace is retained stopped with the operation `failed/interrupted` and resolution
`quarantined`. Never a deleted workspace: a restart alone must not destroy data. Clean
up the retained workspace with `DELETE /v1/operations/$KEY` (deletes by recovered id).

## Cleanup

```bash
for id in $(auth $BASE/v1/sandboxes | jq -r '.sandboxes[].id'); do
  auth -X DELETE $BASE/v1/sandboxes/$id
done
kill $(cat /tmp/pps-manual/pid)
rm -rf /tmp/pps-manual /tmp/pps-manual/state
```

Confirm `pps/` holds no tenant or sandbox cgroups and the state dir is gone. Leave the
host as found; it was disposable.
