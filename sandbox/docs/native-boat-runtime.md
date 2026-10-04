# Native Boat runtime (M1)

Static/container defaults are unchanged. Boat is a host capability, not another pod provider.
This release is **not production-qualified by unit tests**: an unattended real Boat hot
stop/resume with workspace hashes and real exec checks is required before template release.

## Build and install

On the deployment's Linux architecture/glibc and **same Node ABI** (Node 22 recommended):

```sh
npm ci --no-audit --no-fund
npm run check
npm run package:native
```

Requires build-essential and Python for native modules, plus a static C toolchain for
`pps-init`. Output: `artifacts/pi-pod-sandbox-native-0.1.0-linux-<arch>.tar.gz` and `.sha256`.
Extracted layout: `dist/`, production `node_modules/`, `package.json`, `package-lock.json`,
`bin/pps-init`, `BUILD.json` (source revision, dirty flag, Node version/ABI, platform/arch).
The tarball does not include Node, systemd, host credentials or networking setup. A checksum
is integrity evidence, **not a signature**; use a separately authenticated artifact channel.
CI builds/uploads the Node22 artifact on PRs. Container builds remain supported.

With the service stopped, verify the checksum and extract into `/opt/pipod-sandbox`. Set
`PI_POD_SANDBOX_INIT=/opt/pipod-sandbox/bin/pps-init`. Service executable:
`/usr/local/bin/node /opt/pipod-sandbox/dist/main.js`.

Runtime OS dependencies: crun, iproute2, nftables, e2fsprogs, mount/util-linux, tar, gzip,
zstd, attr, ca-certificates and curl. Run as root with writable cgroup v2. Systemd is the
native init/reaper; the container still uses tini.

## Ordered boot and the integrity gate

Infra owns an ordered, fail-closed boot prerequisite:

1. Load the same protected EnvironmentFile as the service. Run
   `node /opt/pipod-sandbox/dist/scripts/verify-images.js` while the runtime is stopped.
2. Create loop device nodes **on every boot**, not just at template construction.
3. Validate/configure a noncolliding bridge subnet.
4. Apply host firewall/forwarding rules.
5. Start the runtime; it independently repeats the image gate **before** cgroup/network
   reconciliation, the reaper, HTTP health or any API/WebSocket listener.

The offline CLI exits nonzero on any failure. There is no readiness-bypass flag. It creates
no loop devices, routes, firewall rules or listeners. It checks all cached refs and every
local sandbox's pinned image layers, including stopped/error pods. An unavailable registry
is not treated as readiness.

The gate re-hashes compressed cached blobs, verifies OCI uncompressed `diff_id`, extracts a
fresh comparison tree, and compares actual file contents, types, modes, owners, symlinks,
hardlinks, device nodes and xattrs (including OverlayFS whiteouts/opaque markers). Missing,
partially lost, empty-but-present or modified lowers are replaced and verified again. Real
empty OCI layers remain valid. Trees are reconstructed in temporary sibling directories;
failure leaves no successful gate. Retained legacy caches are upgraded offline using their
config/blob digest order and compression magic; absent metadata uses a **pinned manifest**
fetch, never a mutable-tag refresh. Missing/corrupt blobs are downloaded and digest-verified.
Keep `STATE_DIR/images` compressed blobs and SQLite across snapshots. Do not mount the
extracted layer cache or image metadata on tmpfs. Boot validation deliberately pays temporary
extraction space and I/O per unique layer; allow several minutes for a large cache rather
than disabling the gate. Image resolution re-checks each verified tree's fingerprint before
launch — every entry's path, type, mode, owner, size, inode, link count, mtime and ctime,
without reading file contents — so post-boot loss or modification cannot become a successful
start (a re-pull repairs it). Every change made through the filesystem moves ctime, which
userspace cannot set back. Corruption beneath the filesystem leaves the fingerprint alone, so
the runtime also re-hashes verified trees' contents every six hours and forgets any that no
longer match; their next resolve misses and a pull repairs them. Standalone image-store callers
must validate or pull before resolving cached refs. Run only one runtime/offline verifier per
state directory.

## Boat configuration

All names below have the `PI_POD_SANDBOX_` prefix:

| Name | Standard | Pro |
|---|---|---|
| HOST_BACKEND | boat | boat |
| HOST_ID | boat-<stable-safe-user-key> | same |
| MEMORY_ADMISSION | floor | floor |
| FLEET_MEMORY_GB | 6 | 12 |
| FLEET_CPU | 3.5 | 7 |
| TENANT_MEMORY_GB | 5.5 (default; explicit value optional) | measured large reserve (explicit; see below) |
| TENANT_CPU | unset (derives `max(0.5, host CPUs − reserve)` → 3.5 / 7.5) | same derivation |
| DISK_ADMISSION | sparse | sparse |
| STORAGE_QUOTA_GB | 40 | 60 |
| SPARSE_MIN_DISK_GB | 0.25 | 0.25 |
| WARM_AFTER_MINUTES | 0 | 0 |
| DR_INTERVAL_MINUTES | 0 | 0 |

The host ID is object-key-safe: `boat:<userId>` is **invalid**. In boat mode the service
fails closed at startup unless `HOST_ID` is explicitly set to `boat-<userId>` — the hostname
default is static-mode only, so a missing identity file can never boot "healthy" with
`capabilities.boat=true` while the server rejects every report as identity-mismatch.
Use the per-host bearer token,
never the Boat provisioning credential. The server must request `archiveAfterMinutes: 0` for
Boat pods; cold local data is free while the VM sleeps. DR pre-stop coordination is a server /
infra responsibility; setting the interval to zero does not itself make a snapshot.

Capacity advertises `capabilities.boat=true` only on Boat hosts; sparse mode adds
`diskAdmission: "sparse"` and `storageQuotaBytes`. Shape ceilings remain 2 CPU / 4 GiB / 20 GiB.
CPU floor admission now respects the configured fleet CPU cap as well as host reserves.
`capabilities.tenantLimits` reports the kernel tenant aggregate caps; a boat host must
report a finite memory cap (startup fails closed on an explicit 0, so a boat host can
never silently run unlimited).

The tenant aggregate is the boundary that keeps vendor/system services alive: an 8 GiB
`default` boat loses ~2.5 GiB to the vendor desktop image before any pod runs, so the
5.5 GiB default leaves the host its headroom plus swap. Per-sandbox `memory.max` never
fired for lack of this cap — eight 4 GiB ceilings burst past RAM+swap and the global OOM
killer took vendor session services, not pods. Do not raise per-pod ceilings to "use" the
tenant cap, and do not promise individual 4 GiB reservations on a boat host: the tenant
cap is shared bytes, so admission refuses past it with retryable `507`s. Size the `large`
reserve by measurement (host RAM minus observed vendor/desktop overhead minus runtime
headroom), then set it explicitly; the 5.5 GiB default stays safe-but-small there.

Sparse admission charges `max(actual allocated workspace blocks, per-pod minimum)` for all
local rows, including stopped/error; archived leaks and untracked images are quarantined
charges. Pending transitions retain minimums in the durable reservation journal. Capacity is
the lesser of the configured storage quota and physical space after reserve; the same
calculation drives admission/reporting. Missing block measurements fail closed. Legacy upper
directories count until migrated. Default committed admission still reserves complete quotas.

**Admission quota is not a kernel per-write quota.** Infra must enforce a hard shared workspace
filesystem limit (for example, a dedicated quota-sized ext4 loop/volume at
`STATE_DIR/sandboxes`), keeping `images`, `layers`, DB and spool outside that filesystem.
Otherwise already-running workloads can write past the admission quota between requests.
Per-pod ext4 ceilings remain hard limits. Keep filesystem reserve/headroom for metadata;
the configured quota is not a promise that every byte is available for user files.

The G0 Boat network already occupied `10.77.0.0/16`; observed working bridge/API configuration
was `10.78.0.0/16` / `10.78.0.1`. Boat mode defaults to that subnet; static defaults stay
unchanged. Actual-route collision detection, bind/forwarding and private hosted-port auth belong to infra.
The observed hosted transport needed a non-loopback listener and the vendor cookie handshake.

## Resume and lineage

Existing reconcile marks vanished hot/warm containers stopped and retains their workspace.
Boat startup then grants all local idle/archive clocks fresh grace. While running, a backward
wall jump, suspend discrepancy or long tick gap (> max(60s, four reaper intervals)) does the
same. This rebases deadlines rather than just skipping one tick; the next tick cannot unleash
the overdue archive wave. Static timer behavior is unchanged, and CPU veto/pressure logic
still runs. Created timestamps, usage events, AUTOINCREMENT sequence, boot IDs, runtime
generation and archived rows are not rewritten by timer rebasing. Each service restart keeps
its new boot ID and the SQLite outbox's existing retention/acknowledgement policy.

## Release safety

Production deployment now requires an explicit `workflow_dispatch` with `deploy=true`, the
main branch and `DEPLOY_ENABLED=true`. A merge may build/sign an image but cannot deploy it.
M1 authorizes no production deployment. Before qualification, verify real shell execution,
workspace hashes and old/new usage lineage after an unattended vendor stop/resume; health
counts alone did not detect the original missing-lowerdir failure.
