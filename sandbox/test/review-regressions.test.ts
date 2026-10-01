import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createObjectStore } from "../src/archive/objectstore.js";
import type { ListedObject, ObjectStore } from "../src/archive/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { AdmissionController } from "../src/core/admission.js";
import { Manager } from "../src/core/manager.js";
import { OperationLedger } from "../src/core/operations.js";
import { ephemeralHostSecret, type HostSecret } from "../src/core/secrets.js";
import { CpuGrants } from "../src/core/tenancy.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import { ServiceError } from "../src/errors.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
import { CgroupTree } from "../src/runtime/cgroup.js";
import { SandboxDisks } from "../src/runtime/disk.js";
import type { Runtime } from "../src/runtime/crun.js";
import type { Network } from "../src/runtime/netns.js";

const GB = 1024 ** 3;

const IMAGE: ResolvedImage = {
  ref: "ghcr.io/pi-pod/pi-pod-base:test",
  manifestDigest: "sha256:feed",
  layers: ["sha256:layer"],
  config: { env: ["PATH=/usr/bin"], entrypoint: [], cmd: [], workingDir: "/work" },
  pulledAt: new Date(0).toISOString(),
};

function images(dir: string): ImageStore {
  return {
    resolve: async () => IMAGE,
    pull: async () => IMAGE,
    layerDir: (digest: string) => path.join(dir, digest),
    gc: async () => [],
    list: async () => [IMAGE],
  };
}

function row(partial: Partial<SandboxRow> & Pick<SandboxRow, "id" | "tier" | "netIndex">): SandboxRow {
  const now = Date.now();
  return {
    image: IMAGE.ref,
    imageDigest: IMAGE.manifestDigest,
    workdir: "/workspace",
    createdAt: now,
    lastActivityAt: now,
    stoppedAt: partial.tier === "stopped" || partial.tier === "archived" ? now - 60_000 : null,
    archiveAfterMinutes: 60,
    idleTimeoutMinutes: 0,
    resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 0.05 },
    ceiling: { cpu: 2, memoryGB: 4, diskGB: 0.05 },
    egress: { mode: "allowlist", hosts: [] },
    error: null,
    archiveKey: null,
    archiveSha256: null,
    archiveSize: null,
    lastCpuUsec: 0,
    labels: {},
    layers: IMAGE.layers,
    ownerKey: null,
    revision: 0,
    runtimeGeneration: 0,
    cgroupRel: null,
    hold: null,
    archiveShared: false,
    ...partial,
  };
}

/** A cgroup root the CgroupTree can `ensure()` without touching /sys/fs/cgroup. */
function fakeCgroupRoot(dir: string): CgroupTree {
  const root = path.join(dir, "cgroup");
  fs.mkdirSync(path.join(root, "pps"), { recursive: true });
  fs.writeFileSync(path.join(root, "cgroup.controllers"), "cpu memory pids\n");
  fs.writeFileSync(path.join(root, "pps", "cgroup.controllers"), "cpu memory pids\n");
  return new CgroupTree("pps", root);
}

describe("review regressions", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;
  let objects: ObjectStore;
  let secret: HostSecret;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "review-regressions-"));
    store = new Store(path.join(dir, "db"));
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "review-regressions-token-long-enough",
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_MEMORY_BUDGET_GB: "8",
      PI_POD_SANDBOX_RESERVE_CPU: "0",
      PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
      PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.05",
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
    });
    for (const p of Object.values(cfg.paths)) fs.mkdirSync(p, { recursive: true });
    objects = createObjectStore(cfg.archive);
    secret = ephemeralHostSecret();
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const failure = async <T>(p: Promise<T>): Promise<ServiceError> => {
    try {
      await p;
    } catch (err) {
      assert.ok(err instanceof ServiceError, `expected ServiceError, got ${String(err)}`);
      return err;
    }
    assert.fail("expected the call to fail");
  };

  describe("F1: crash between reservation commit and operation success", () => {
    const key = "pod-f1:create:1";
    const id = "sb-f1000000000000000001";

    /** Journal state as a previous boot left it: op pending, reservation committed, row as given. */
    const leaveCrashState = (tier: SandboxRow["tier"], generation: number): void => {
      const previous = "boot-previous";
      const ledger = new OperationLedger(store.database, { secret: "x".repeat(32), retentionMs: 3_600_000, bootId: previous });
      assert.equal(ledger.begin(key, "v1:abcd:fp").outcome, "started");
      store.insert(row({ id, tier, netIndex: 1, runtimeGeneration: generation }));
      const disks = new SandboxDisks(cfg.paths.sandboxes, 0);
      const admission = new AdmissionController(store.database, cfg, disks, { bootId: previous });
      admission.reserve(
        { operationId: `create:${key}`, sandboxId: id, kind: "create", desiredMemoryBytes: 4 * GB, desiredDiskBytes: 0.05 * GB, desiredCpuFloor: 0.25 },
        store.all(),
      );
      admission.commit(`create:${key}`);
    };

    const bootManager = (runtimeState: { status: string } | null): Manager =>
      new Manager(
        cfg,
        store,
        images(dir),
        { state: async () => (runtimeState ? { ...runtimeState, pid: 1 } : null), kill: async () => undefined, delete: async () => undefined } as unknown as Runtime,
        { ensureBridge: async () => undefined, destroy: async () => undefined } as unknown as Network,
        fakeCgroupRoot(dir),
        objects,
        createLogger("silent"),
        undefined,
        { bootId: "boot-new", secret },
      );

    it("links a still-running committed create to its operation instead of replaying interrupted", async () => {
      leaveCrashState("hot", 1);
      // reconcile() adopts only when the runtime reports the process and the workspace is mounted.
      fs.mkdirSync(path.join(cfg.paths.sandboxes, id, "merged"), { recursive: true });
      fs.writeFileSync(path.join(cfg.paths.sandboxes, id, "writable.ext4"), "");
      const manager = bootManager({ status: "running" });
      await manager.init();

      const status = manager.operationStatus(key);
      assert.equal(status.status, "succeeded");
      assert.equal(status.sandboxId, id);
      assert.equal(status.crossHostRetrySafe, false);
      assert.equal(status.result?.runtimeGeneration, 1);
      assert.equal(store.get(id)!.tier, "hot", "the live process was adopted, not killed");
      assert.equal(manager.admission.get(`create:${key}`)?.status, "committed", "the charge is preserved");
      assert.equal(manager.capacityReport().memory.committedBytes, 4 * GB);
    });

    it("retains a committed create whose process did not survive and says so by id", async () => {
      leaveCrashState("hot", 1);
      const manager = bootManager(null);
      await manager.init();
      // reconcile marked the row stopped (process gone); the workspace is kept.
      assert.equal(store.get(id)!.tier, "stopped");
      const status = manager.operationStatus(key);
      assert.equal(status.status, "failed");
      assert.equal(status.error?.code, "interrupted");
      assert.equal(status.resolution, "quarantined");
      assert.equal(status.sandboxId, id);
      assert.equal(status.crossHostRetrySafe, false);
      assert.ok(fs.existsSync(path.join(cfg.paths.sandboxes, id)) || store.get(id) !== null, "nothing deleted on restart alone");
    });
  });

  it("Boat cold resume stops vanished hot pods, rebases local timers and retains boot usage lineage/workspaces", async () => {
    cfg.hostBackend = "boat";
    const now = Date.now();
    const id = "sb-boatresume0000000001";
    store.insert(row({ id, tier: "hot", netIndex: 1, lastActivityAt: now - 86_400_000, runtimeGeneration: 3 }));
    const stoppedId = "sb-boatstopped00000001";
    store.insert(row({ id: stoppedId, tier: "stopped", netIndex: 2, stoppedAt: now - 86_400_000 }));
    fs.mkdirSync(path.join(cfg.paths.sandboxes, id), { recursive: true });
    const workspace = path.join(cfg.paths.sandboxes, id, "writable.ext4");
    fs.writeFileSync(workspace, "retained workspace marker");
    const make = (bootId: string) => new Manager(cfg, store, images(dir),
      { state: async () => null, kill: async () => undefined, delete: async () => undefined } as unknown as Runtime,
      { ensureBridge: async () => undefined, destroy: async () => undefined } as unknown as Network,
      fakeCgroupRoot(dir), objects, createLogger("silent"), undefined, { bootId, secret, now: () => now });
    const old = make("boot-before-sleep");
    const seq = old.usage.record({ kind: "started", sandboxId: id, ownerKey: null, runtimeGeneration: 3 });
    assert.ok(seq);
    const resumed = make("boot-after-resume");
    await resumed.init();
    assert.equal(store.get(id)!.tier, "stopped");
    assert.equal(store.get(id)!.lastActivityAt, now);
    assert.equal(store.get(stoppedId)!.stoppedAt, now);
    assert.equal(fs.readFileSync(workspace, "utf8"), "retained workspace marker");
    const events = resumed.usage.events(0, 100);
    assert.equal(events.bootId, "boot-after-resume");
    const boots = store.database.prepare("SELECT boot_id FROM usage_events ORDER BY seq").all() as Array<{ boot_id: string }>;
    assert.deepEqual(boots.map((r) => r.boot_id), ["boot-before-sleep", "boot-after-resume"]);
    assert.ok(events.events[1]!.seq > seq);
    assert.equal(resumed.capacityReport().capabilities.boat, true);
  });

  describe("F3: malformed shapes are refused, never stored", () => {
    it("rejects non-positive or non-finite disk/cpu/memory on import, create and resize", async () => {
      const listed: ListedObject[] = [{ key: "sb-f3000000000000000001/upper-" + "a".repeat(64) + ".tar.zst", size: 1, lastModified: 1 }];
      const withArchive: ObjectStore = { ...objects, kind: "s3", list: async () => listed };
      const manager = new Manager(cfg, store, images(dir), {} as Runtime, {} as Network, fakeCgroupRoot(dir), withArchive, createLogger("silent"), undefined, { bootId: "b", secret });
      const negative = await failure(manager.importArchived({ id: "sb-f3000000000000000001", image: IMAGE.ref, workdir: "/w", resources: { diskGB: -1 } }));
      assert.equal(negative.status, 400);
      const nan = await failure(manager.create({ image: IMAGE.ref, workdir: "/w", resources: { cpu: Number.NaN } }));
      assert.equal(nan.status, 400);
      const zero = await failure(manager.create({ image: IMAGE.ref, workdir: "/w", resources: { memoryGB: 0 } }));
      assert.equal(zero.status, 400);
      assert.equal(store.all().length, 0);
      const before = manager.capacityReport().disk;
      store.insert(row({ id: "sb-f3000000000000000002", tier: "stopped", netIndex: 2 }));
      const resize = await failure(manager.setResourceCeiling("sb-f3000000000000000002", { diskGB: -5 }));
      assert.equal(resize.status, 400);
      assert.equal(manager.capacityReport().disk.committedBytes, before.committedBytes + 0.05 * GB);
    });
  });

  describe("F4: concurrent duplicate imports", () => {
    it("produce one row and identical idempotent success, never a raw constraint error", async () => {
      const id = "sb-f4000000000000000001";
      const listed: ListedObject[] = [{ key: `${id}/upper-${"b".repeat(64)}.tar.zst`, size: 3, lastModified: 1 }];
      const withArchive: ObjectStore = {
        ...objects,
        kind: "s3",
        // Both callers pass the existence check before either inserts.
        list: async () => new Promise((resolve) => setTimeout(() => resolve(listed), 20)),
        head: async (k: string) =>
          new Promise((resolve) => setTimeout(() => resolve(listed.find((o) => o.key === k) ?? null), 20)),
      };
      const manager = new Manager(cfg, store, images(dir), {} as Runtime, {} as Network, fakeCgroupRoot(dir), withArchive, createLogger("silent"), undefined, { bootId: "b", secret });
      // With the explicit object reference the loser of the race can prove it is the same
      // request; a legacy retry without one is refused as ambiguous (typed 409, never 500).
      const request = {
        id,
        image: IMAGE.ref,
        workdir: "/w",
        owner: { userKey: "user_f4" },
        archive: { key: `${id}/upper-${"b".repeat(64)}.tar.zst`, sha256: "b".repeat(64), size: 3 },
      };
      const [a, b] = await Promise.all([manager.importArchived(request), manager.importArchived(request)]);
      assert.equal(a.id, id);
      assert.equal(b.id, id);
      assert.equal(store.all().length, 1);

      const other = await failure(manager.importArchived({ ...request, owner: { userKey: "user_other" } }));
      assert.equal(other.code, "conflict");
      assert.equal(other.status, 409);
    });
  });

  describe("F6: growth on a degraded tenant is gated like a launch", () => {
    it("refuses memory/disk growth with fairness_degraded and leaves shrink/no-op alone", async () => {
      let now = 0;
      const grants = new CpuGrants(store.database, { fallbackCores: null, bootId: "b", clock: () => now });
      store.insert(row({ id: "sb-f6000000000000000001", tier: "hot", netIndex: 1, ownerKey: "user_b", ceiling: { cpu: 2, memoryGB: 2, diskGB: 0.05 } }));
      const manager = new Manager(cfg, store, images(dir), {} as Runtime, {} as Network, fakeCgroupRoot(dir), objects, createLogger("silent"), undefined, { bootId: "b", secret, grants });
      manager.applyCpuGrant("user_a", { revision: 1, cpuCores: 1, ttlMs: 10_000 });
      assert.equal(manager.grants.managedMode(), true);

      const grow = await failure(manager.setResourceCeiling("sb-f6000000000000000001", { memoryGB: 4 }));
      assert.equal(grow.details?.kind === "admission" && grow.details.reason, "fairness_degraded");
      assert.deepEqual(store.get("sb-f6000000000000000001")!.ceiling, { cpu: 2, memoryGB: 2, diskGB: 0.05 });
      assert.equal(manager.admission.active().length, 0);

      // Pure CPU decrease is not footprint growth and is not gated.
      const shrink = await manager.setResourceCeiling("sb-f6000000000000000001", { cpu: 1 });
      assert.equal(shrink.ceiling.cpu, 1);

      manager.applyCpuGrant("user_b", { revision: 1, cpuCores: 1, ttlMs: 10_000 });
      const allowed = await manager.setResourceCeiling("sb-f6000000000000000001", { memoryGB: 4 });
      assert.equal(allowed.ceiling.memoryGB, 4);
      now = 20_000;
      const expired = await failure(manager.setResourceCeiling("sb-f6000000000000000001", { diskGB: 0.06 }));
      assert.equal(expired.details?.kind === "admission" && expired.details.reason, "fairness_degraded");
    });
  });
});
