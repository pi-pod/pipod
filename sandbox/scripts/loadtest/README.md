# Load-test harness (version-controlled copy of the on-host `/root/loadtest`)

Origin: `hetzner-1` (`pipod-sandbox-hetzner-1`, Hetzner `ccx33`, Hillsboro),
`/root/loadtest/`, copied read-only (`scp`; checksums recorded before and after).
Harness logic in `lt.mjs` is verbatim except for the flag/env adaptations noted below;
`lt.sh`, `snap.sh`, `fleetcpu.sh` accept overrides but default to the hetzner-1 layout.
`fleet-cgroup-path` is the example fleet cgroup path observed on hetzner-1
(a docker-scoped path; use `--cgroup-root` / `CG` for other hosts).

The subcommands mirror the retired Hetzner operator tool
(subcommands `ladder`, `fill`, `execlat`, `saturate`, `runall`, `churn`,
`archiveall`, `restoreall`, `s3ls`, `cleanup`, plus `stat`, `exec`, `list`, `archive`).

Origin host facts (also the flag defaults in `lib.mjs`):

| | |
| --- | --- |
| Image digest | `sha256:47e3d9b8156a7e01730ad31c389255a9f725e7b57a81b25ee83d5e7a953bbc83` |
| Kernel | `6.12.107+deb13-cloud-amd64` |
| Service endpoint | `http://10.79.0.2:8433` |
| Env file | `/etc/pipod/pi-pod-sandbox/runtime.env` |
| Checkout dir | `/root/loadtest` |
| Fleet cgroup | `/sys/fs/cgroup/pps` |

Checksum log (from `SHA256SUMS` at copy time):

```text
6f9d7fb6c6fd87ceefec0f428f6bcd2bd4769becea06530a72551e9191650858  lt.mjs
479c03c6693da4f78e4dfb3f8cbbcf5e6e8fcf8c7c5e08efc17e5fd2091687b6  lt.sh
210b6e34702b4ac5d1b49b1dc4cbf92b81b0d0e4a1a1fcee12c32e9361c243b7  snap.sh
d04607214a677e4cbcfacbe28a178ee34b94cead28128aa40e5d7606f2bd4e98  fleetcpu.sh
02178c98758884bcac471684fce9e93f480b35dc7c2d4a45a4720a14af3a3f75  fleet-cgroup-path
```

## Never run against production

This harness saturates hosts by design (CPU burners, disk fills, fleet-wide
archives). It must **never run against production hosts or the control plane**.
Run only on a disposable qualification worker per plan §5.2.3: created via the
hcloud API with label `pipod-qual=<date>`, its own fixture-only `runtime.env`,
a separate archive bucket prefix, and deleted via the API with the label guard
after the run. Nothing production ever points at it, so no rehome is needed.

Note: `scripts/loadtest.mjs` (repo root scripts dir) is a separate, smaller
legacy density script (freeze/thaw latency, archive/restore budgets). It is kept
as-is; this directory is the full qualification harness.

## How to run on a disposable worker (plan §5.2.3)

```bash
# on the disposable worker, as root:
echo "options loop max_loop=64" > /etc/modprobe.d/pipod-loop.conf
update-initramfs -u   # then ensure loop devices exist before (re)creating the service container
git checkout <this-branch-or-main>
mkdir -p out
# Every create also needs LT_OWNER_KEY in the protected environment. It must be
# the actual owner.userKey for this isolated qualification run; neither value is
# a CLI flag or committed. `lt.sh --env-file` passes both into its child. For
# direct Node use, load exactly these selected values with the approved strict
# in-memory credential reader for the target environment (never shell-source a
# native runtime env file).
./scripts/loadtest/lt.sh --env-file /etc/pipod/pi-pod-sandbox/loadtest.env -- stat
./scripts/loadtest/snap.sh before > out/snap-before.json
node scripts/loadtest/lt.mjs ladder 1,4,8,16,32 --disk 5 --out ./out
node scripts/loadtest/lt.mjs fill --cpu 2 --mem 4 --disk 20 --out ./out
node scripts/loadtest/lt.mjs execlat --n 30 --out ./out
node scripts/loadtest/lt.mjs saturate --seconds 40 --spinners 8 --out ./out
node scripts/loadtest/lt.mjs runall -- <command>
node scripts/loadtest/lt.mjs churn --n 50 --disk 5 --out ./out
node scripts/loadtest/lt.mjs archiveall --out ./out
node scripts/loadtest/lt.mjs restoreall --out ./out
node scripts/loadtest/lt.mjs s3ls --out ./out
./scripts/loadtest/snap.sh after > out/snap-after.json
./scripts/loadtest/lt.sh -- cleanup
```

Or via npm from the repo root: `npm run loadtest -- <subcommand> [args]`
(`--out` defaults to `./out`). The master token is **only** read from
`PI_POD_SANDBOX_TOKEN` and the required owner key only from `LT_OWNER_KEY`
(normally via a protected `--env-file`); neither is a CLI flag or committed.
The owner key is validated against the runtime's existing `owner.userKey`
contract before any network request. Host/kernel/imageDigest come from flags
(`--host`, `--kernel`, `--image-digest`, `--class`) or `os`/defaults —
never by SSH into another host.

Every subcommand writes its detailed payload (`<subcommand>-<ts>.json`) **and**
a unified result envelope (`result-<subcommand>-<ts>.json`) with shape
`{schemaVersion:1, host, class, imageDigest, kernel, config, subcommand, n,
p50, p90, p95, p99, max, wallMs, errors, startedAt, finishedAt}`
(see `schema.json`; validated by `lib.mjs validateResult()`).
Keep human-readable reports with the deployment they measured, not in this repository.

## SLO → subcommand table (plan §5.2.3)

| §8.5 SLO | Harness subcommand | Metric source |
| --- | --- | --- |
| User-visible capacity failure <0.1% | `ladder`, `fill`, `saturate` | `pps_sandbox_admissions_total` (native `src/metrics.ts`), server typed capacity errors |
| Zero fleet-induced OOM/stall at envelope | `saturate`, mixed 4/8-GiB shapes | usage-sample `oomEvents`/`oomKillEvents` fields, `pps_admission_memory_debt_bytes` |
| Capacity wait p95 <10 s, deadline 60 s | queue drill under `saturate` | `pipod_capacity_waits_total{outcome}` (server `src/server/metrics.ts`) |
| Exec transport p99 <250 ms | `execlat` | `pps_sandbox_exec_duration_seconds` / `pps_sandbox_execs_total` |
| Restore p95 by size bucket | `archiveall` / `restoreall` | `pps_archive_operation_duration_seconds`, usage-event `duration_ms` by kind |
| Metering ≥99% coverage, rollup lag p99 <5 min | `churn` + `runall` with collector on | `usage-ledger coverage`, `pipod_usage_rollup_lag_seconds` (server #236) |

## Zombie-reap regression (`test/root/zombie-reap.test.ts`)

The current image leaks 2 zombies (`crun`, `.pps-init`) per sandbox lifecycle
because the service container's PID 1 (Node) never reaps reparented children;
the fix is `init: true` on the service (docker-init/tini becomes PID 1).
A Node subreaper via `prctl(PR_SET_CHILD_SUBREAPER)` was considered and
rejected: it is not exposed to Node.

The regression runs ≥100 create→stop→delete cycles and requires the delta of
state-`Z` processes in the service's PID namespace to be 0. It is gated by
`ZOMBIE_REAP_EXPECT_FIXED`: when unset, the test records the count and passes
with a warning (expected to observe the leak on the current image); when `=1`,
it asserts delta 0 (run after `init: true` lands, on a disposable privileged
worker via `npm run test:root` — never here without privileges).
