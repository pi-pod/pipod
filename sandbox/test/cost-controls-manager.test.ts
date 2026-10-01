import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import { createObjectStore } from "../src/archive/objectstore.js";
import type { ObjectStore } from "../src/archive/types.js";
import { loadConfig, unknownSandboxEnv, type Config } from "../src/config.js";
import { Manager } from "../src/core/manager.js";
import { ephemeralHostSecret } from "../src/core/secrets.js";
import { CpuGrants } from "../src/core/tenancy.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import { ServiceError } from "../src/errors.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
import { CgroupTree } from "../src/runtime/cgroup.js";
import type { Runtime } from "../src/runtime/crun.js";
import type { Network } from "../src/runtime/netns.js";
import { SandboxDisks } from "../src/runtime/disk.js";

const GB = 1024 ** 3;

const IMAGE: ResolvedImage = {
  ref: "ghcr.io/pi-pod/pi-pod-base:test",
  manifestDigest: "sha256:feed",
  layers: ["sha256:layer"],
  config: { env: ["PATH=/usr/bin"], entrypoint: [], cmd: [], workingDir: "/work" },
  pulledAt: new Date(0).toISOString(),
};

function images(dir: string, overrides: Partial<ImageStore> = {}): ImageStore {
  return {
    resolve: async () => IMAGE,
    pull: async () => IMAGE,
    layerDir: (digest: string) => path.join(dir, digest),
    gc: async () => [],
    list: async () => [IMAGE],
    ...overrides,
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

describe("cost controls in the manager", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;
  let objects: ObjectStore;
  let cgroups: CgroupTree;

  beforeEach(async (t) => {
    // These tests assert admission, not mounts. Remain unprivileged even after native
    // packaging produced bin/pps-init (formerly the accidental stopping point).
    (t as TestContext).mock.method(SandboxDisks.prototype, "ensureMounted", async () => {
      throw new ServiceError("unit-test disk boundary", "test_disk_boundary", 500);
    });
    dir = await mkdtemp(path.join(os.tmpdir(), "cost-controls-"));
    store = new Store(path.join(dir, "db"));
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "cost-controls-token-long-enough",
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_MEMORY_BUDGET_GB: "8",
      PI_POD_SANDBOX_RESERVE_CPU: "0",
      PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
      PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.05",
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
      PI_POD_SANDBOX_HOST_ID: "host-test",
    });
    fs.mkdirSync(cfg.paths.sandboxes, { recursive: true });
    objects = createObjectStore(cfg.archive);
    // A cgroup tree rooted in the temp dir: nothing here touches /sys/fs/cgroup.
    cgroups = new CgroupTree("pps", path.join(dir, "cgroup"));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const manager = (opts: { images?: ImageStore; grants?: CpuGrants; cfgOverride?: Config } = {}): Manager =>
    new Manager(
      opts.cfgOverride ?? cfg,
      store,
      opts.images ?? images(dir),
      {} as Runtime,
      {} as Network,
      cgroups,
      objects,
      createLogger("silent"),
      undefined,
      { bootId: "boot-1", secret: ephemeralHostSecret(), serviceVersion: "test", ...(opts.grants ? { grants: opts.grants } : {}) },
    );

  const failure = async <T>(p: Promise<T>): Promise<ServiceError> => {
    try {
      await p;
    } catch (err) {
      assert.ok(err instanceof ServiceError, `expected ServiceError, got ${String(err)}`);
      return err;
    }
    assert.fail("expected the call to fail");
  };

  describe("capacity report", () => {
    it("reports ceiling-first commitments, budgets and capabilities from one computation", () => {
      store.insert(row({ id: "sb-hot00000000000000001", tier: "hot", netIndex: 1 }));
      store.insert(row({ id: "sb-stopped0000000000001", tier: "stopped", netIndex: 2 }));
      const report = manager().capacityReport();
      assert.equal(report.contractVersion, 1);
      assert.equal(report.hostId, "host-test");
      assert.equal(report.bootId, "boot-1");
      assert.equal(report.capabilities.memoryAdmission, "ceiling");
      assert.deepEqual(report.capabilities.maxShape, { cpu: 2, memoryGB: 4, diskGB: 20 });
      assert.equal(report.memory.budgetBytes, 8 * GB);
      // Only the live sandbox pins memory, and it pins its whole ceiling.
      assert.equal(report.memory.committedBytes, 4 * GB);
      assert.equal(report.memory.availableBytes, 4 * GB);
      // Both local workspaces commit their full quota; nothing is archived.
      assert.equal(report.disk.committedBytes, 2 * 0.05 * GB);
      assert.equal(report.fairness.mode, "local-weights");
      assert.equal(report.fairness.managed, false);
      // Additive wire field: the host always states its admission-gate setting (default on).
      assert.equal(report.fairness.gateAdmissions, true);
      assert.equal(report.transitions.maxConcurrentArchives, 2);
      const again = manager().capacityReport();
      assert.ok(again.generation >= 1);
    });

    it("charges a leaked archived image as quarantined disk", () => {
      store.insert(row({ id: "sb-leaked00000000000001", tier: "archived", netIndex: 1, archiveKey: "k", archiveSha256: "0".repeat(64), archiveSize: 1 }));
      const image = path.join(cfg.paths.sandboxes, "sb-leaked00000000000001", "writable.ext4");
      fs.mkdirSync(path.dirname(image), { recursive: true });
      fs.writeFileSync(image, "");
      const report = manager().capacityReport();
      assert.equal(report.disk.committedBytes, 0);
      assert.equal(report.disk.quarantinedBytes, 0.05 * GB);
    });
  });

  describe("shape validation", () => {
    it("refuses oversized shapes on create, import and resize without changing anything", async () => {
      const service = manager();
      const create = await failure(service.create({ image: IMAGE.ref, workdir: "/w", resources: { memoryGB: 8 } }));
      assert.equal(create.code, "unsupported_shape");
      assert.equal(create.status, 400);
      store.insert(row({ id: "sb-stopped0000000000001", tier: "stopped", netIndex: 1 }));
      const resize = await failure(service.setResourceCeiling("sb-stopped0000000000001", { cpu: 16 }));
      assert.equal(resize.code, "unsupported_shape");
      assert.deepEqual(store.get("sb-stopped0000000000001")!.ceiling, { cpu: 2, memoryGB: 4, diskGB: 0.05 });
      assert.equal(service.admission.active().length, 0);
    });

    it("keeps the legacy clamp behind an explicit knob", async () => {
      const clamped = loadConfig({
        PI_POD_SANDBOX_TOKEN: "cost-controls-token-long-enough",
        PI_POD_SANDBOX_STATE_DIR: dir,
        PI_POD_SANDBOX_CLAMP_OVERSIZED_SHAPES: "1",
        PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
      });
      store.insert(row({ id: "sb-stopped0000000000001", tier: "stopped", netIndex: 1 }));
      const service = manager({ cfgOverride: clamped });
      // A stopped sandbox holds no memory, so only disk admission runs; 16 cpu clamps to 2.
      const result = await service.setResourceCeiling("sb-stopped0000000000001", { cpu: 16 });
      assert.equal(result.ceiling.cpu, 2);
    });
  });

  describe("resize admission", () => {
    it("refuses a memory shrink while running and a growth that does not fit, leaving limits intact", async () => {
      store.insert(row({ id: "sb-hot00000000000000001", tier: "hot", netIndex: 1, ceiling: { cpu: 2, memoryGB: 2, diskGB: 0.05 } }));
      store.insert(row({ id: "sb-hot00000000000000002", tier: "hot", netIndex: 2, ceiling: { cpu: 2, memoryGB: 4, diskGB: 0.05 } }));
      const service = manager();
      const shrink = await failure(service.setResourceCeiling("sb-hot00000000000000001", { memoryGB: 1 }));
      assert.equal(shrink.code, "conflict");
      // 2 + 4 committed of 8: growing the first to 4 fits exactly (+2), so ask for more via the
      // second sandbox in a 6 GiB budget instead: replace the budget and try +4.
      const tight = loadConfig({
        PI_POD_SANDBOX_TOKEN: "cost-controls-token-long-enough",
        PI_POD_SANDBOX_STATE_DIR: dir,
        PI_POD_SANDBOX_MEMORY_BUDGET_GB: "7",
        PI_POD_SANDBOX_RESERVE_CPU: "0",
        PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
        PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
      });
      const grow = await failure(manager({ cfgOverride: tight }).setResourceCeiling("sb-hot00000000000000001", { memoryGB: 4 }));
      assert.equal(grow.code, "admission_denied");
      assert.equal(grow.details?.kind === "admission" && grow.details.reason, "memory_capacity");
      assert.equal(grow.details?.kind === "admission" && grow.details.required, 2 * GB);
      assert.equal(grow.details?.kind === "admission" && grow.details.available, 1 * GB);
      assert.deepEqual(store.get("sb-hot00000000000000001")!.ceiling, { cpu: 2, memoryGB: 2, diskGB: 0.05 });
      assert.equal(service.admission.active().length, 0);
    });
  });

  describe("archive-if-stopped guards", () => {
    it("never packs a running sandbox and reports each guard outcome", async () => {
      store.insert(row({ id: "sb-hot00000000000000001", tier: "hot", netIndex: 1 }));
      store.insert(row({ id: "sb-archived000000000001", tier: "archived", netIndex: 2, archiveKey: "k", archiveSha256: "0".repeat(64), archiveSize: 1 }));
      store.insert(row({ id: "sb-stopped0000000000001", tier: "stopped", netIndex: 3 }));
      const service = manager();

      const hot = await service.archiveIfStopped("sb-hot00000000000000001");
      assert.deepEqual([hot.archived, hot.outcome, hot.sandbox.state], [false, "not_stopped", "started"]);

      const archived = await service.archiveIfStopped("sb-archived000000000001");
      assert.deepEqual([archived.archived, archived.outcome], [false, "already_archived"]);

      const stopped = store.get("sb-stopped0000000000001")!;
      const stale = await service.archiveIfStopped("sb-stopped0000000000001", { expectedRevision: stopped.revision + 1 });
      assert.deepEqual([stale.archived, stale.outcome], [false, "revision_mismatch"]);
      const wrongStop = await service.archiveIfStopped("sb-stopped0000000000001", { expectedStoppedAt: new Date(0).toISOString() });
      assert.deepEqual([wrongStop.archived, wrongStop.outcome], [false, "revision_mismatch"]);
      // Nothing above changed the row: the guards read, they do not write.
      assert.equal(store.get("sb-stopped0000000000001")!.revision, stopped.revision);
      assert.equal(store.get("sb-stopped0000000000001")!.tier, "stopped");
    });

    it("applying retention never resets the authoritative stop timestamp", () => {
      const stoppedAt = Date.now() - 3_600_000;
      store.insert(row({ id: "sb-stopped0000000000001", tier: "stopped", netIndex: 1, stoppedAt }));
      const service = manager();
      assert.equal(service.applyRetention("sb-stopped0000000000001", 60), false);
      assert.equal(service.applyRetention("sb-stopped0000000000001", 30), true);
      assert.equal(store.get("sb-stopped0000000000001")!.stoppedAt, stoppedAt);
    });
  });

  describe("owner identity", () => {
    it("is set at import, immutable through labels, and validated", async () => {
      const service = manager();
      const id = "sb-1234567890abcdef1234";
      const listing = { key: `${id}/upper-${"a".repeat(64)}.tar.zst`, size: 3, lastModified: 1 };
      const withArchive: ObjectStore = { ...objects, kind: "s3", list: async () => [listing] };
      const importer = new Manager(cfg, store, images(dir), {} as Runtime, {} as Network, cgroups, withArchive, createLogger("silent"), undefined, {
        bootId: "boot-1",
        secret: ephemeralHostSecret(),
      });
      const info = await importer.importArchived({ id, image: IMAGE.ref, workdir: "/w", owner: { userKey: "user_42" } });
      assert.deepEqual(info.owner, { userKey: "user_42" });
      assert.equal(info.runtimeGeneration, 0);
      service.setLabels(id, { "pi-pod-server/owner": "someone-else", owner: "x" });
      assert.deepEqual(service.info(id)!.owner, { userKey: "user_42" });
      assert.equal(store.byOwner("user_42").length, 1);
      // An import reserves nothing until a restore actually starts.
      assert.equal(service.admission.active().length, 0);
      assert.equal(service.capacityReport().disk.committedBytes, 0);

      const bad = await failure(importer.importArchived({ id: "sb-abcdefabcdef12345678", image: IMAGE.ref, workdir: "/w", owner: { userKey: "../etc" } }));
      assert.equal(bad.status, 400);
    });
  });

  describe("one-time owner initialization", () => {
    it("sets an owner once on a stopped row, replays the same owner, and refuses a different one", async () => {
      store.insert(row({ id: "sb-legacy00000000000001", tier: "stopped", netIndex: 1 }));
      const service = manager();
      const before = store.get("sb-legacy00000000000001")!.revision;
      const set = await service.initializeOwner("sb-legacy00000000000001", "user_owner");
      assert.equal(set.changed, true);
      assert.deepEqual(set.sandbox.owner, { userKey: "user_owner" });
      assert.equal(set.sandbox.revision, before + 1, "owner initialization is a guarded transition");
      const again = await service.initializeOwner("sb-legacy00000000000001", "user_owner");
      assert.equal(again.changed, false);
      const other = await failure(service.initializeOwner("sb-legacy00000000000001", "user_other"));
      assert.equal(other.code, "owner_conflict");
      assert.equal(other.status, 409);
      assert.deepEqual(service.info("sb-legacy00000000000001")!.owner, { userKey: "user_owner" });
      assert.ok(service.usage.events(0, 10).events.some((e) => e.kind === "owner_initialized" && e.ownerKey === "user_owner"));
    });

    it("refuses to initialize a live (grandfathered) row, validates keys, and ignores labels", async () => {
      store.insert(row({ id: "sb-live0000000000000001", tier: "hot", netIndex: 1, labels: { "pi-pod-server/user": "user_label" } }));
      const service = manager();
      const live = await failure(service.initializeOwner("sb-live0000000000000001", "user_owner"));
      assert.equal(live.code, "owner_conflict");
      assert.equal(service.info("sb-live0000000000000001")!.owner, null);
      const bad = await failure(service.initializeOwner("sb-live0000000000000001", "../x"));
      assert.equal(bad.status, 400);
      const report = service.capacityReport();
      assert.deepEqual(report.tenancy, { ownedSandboxes: 0, unownedLive: 1, unownedInitializable: 0, unownedUncertain: 0, requireOwner: false });
    });

    it("can require owners for launches once the control plane has initialized them", async () => {
      const strict = loadConfig({
        PI_POD_SANDBOX_TOKEN: "cost-controls-token-long-enough",
        PI_POD_SANDBOX_STATE_DIR: dir,
        PI_POD_SANDBOX_MEMORY_BUDGET_GB: "8",
        PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
        PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.05",
        PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
        PI_POD_SANDBOX_REQUIRE_OWNER: "1",
      });
      store.insert(row({ id: "sb-legacy00000000000001", tier: "stopped", netIndex: 1 }));
      const service = manager({ cfgOverride: strict });
      const create = await failure(service.create({ image: IMAGE.ref, workdir: "/w" }));
      assert.equal(create.code, "owner_required");
      assert.equal(create.status, 400);
      const start = await failure(service.start("sb-legacy00000000000001", {}));
      assert.equal(start.code, "owner_required");
      assert.equal(store.get("sb-legacy00000000000001")!.tier, "stopped", "a refused start changes nothing");
      assert.equal(service.admission.active().length, 0);
      await service.initializeOwner("sb-legacy00000000000001", "user_owner");
      const owned = await failure(service.start("sb-legacy00000000000001", {}));
      assert.notEqual(owned.code, "owner_required", "once owned, the launch proceeds past the gate");
      assert.equal(service.capacityReport().tenancy.requireOwner, true);
    });
  });

  describe("create idempotency", () => {
    const request = { image: IMAGE.ref, workdir: "/workspace", operationKey: "pod-0001:create:1" };

    it("records a pre-allocation failure as safe to retry elsewhere and replays it by key", async () => {
      const service = manager({ images: images(dir, { resolve: async () => null, pull: async () => { throw new Error("registry unreachable"); } }) });
      await assert.rejects(service.create(request), /registry unreachable/);
      const status = service.operationStatus(request.operationKey);
      assert.equal(status.status, "failed");
      assert.equal(status.resolution, "preallocation");
      assert.equal(status.crossHostRetrySafe, true);
      assert.equal(status.sandboxId, null);
      // Same key + same request replays the recorded outcome instead of pulling again.
      const replay = await failure(service.create(request));
      assert.equal(replay.code, "internal");
      assert.equal(replay.status, 500);
    });

    it("treats the same key with a different request as a conflict", async () => {
      const service = manager({ images: images(dir, { resolve: async () => null, pull: async () => { throw new Error("nope"); } }) });
      await assert.rejects(service.create(request));
      const conflict = await failure(service.create({ ...request, workdir: "/elsewhere" }));
      assert.equal(conflict.code, "idempotency_conflict");
      assert.equal(conflict.status, 409);
      assert.equal(conflict.details?.kind, "operation");
    });

    it("a refusal by admission is a pre-allocation failure with typed details", async () => {
      const service = manager();
      const refusal = await failure(service.create({ ...request, resources: { memoryGB: 8 } }));
      assert.equal(refusal.code, "unsupported_shape");
      const status = service.operationStatus(request.operationKey);
      assert.equal(status.resolution, "preallocation");
      assert.equal(status.error?.details?.kind, "admission");
      assert.equal(status.crossHostRetrySafe, true);
    });

    it("a launch failure whose cleanup is uncertain stays charged and is not retry-safe until cleaned up by key", async () => {
      // `{}` as Runtime makes teardown throw, which is exactly an uncertain cleanup.
      const service = manager();
      const original = await service.create(request).then(() => null, (err: unknown) => err as Error);
      assert.ok(original);
      const originalCode = original instanceof ServiceError ? original.code : "internal";
      const status = service.operationStatus(request.operationKey);
      assert.equal(status.status, "failed");
      assert.equal(status.error?.code, originalCode);
      assert.equal(status.resolution, "quarantined");
      assert.equal(status.crossHostRetrySafe, false);
      assert.ok(status.sandboxId);
      const charged = service.admission.active();
      assert.equal(charged.length, 1);
      assert.equal(charged[0]!.status, "quarantined");
      assert.equal(service.capacityReport().memory.quarantinedBytes, 4 * GB);
      assert.equal(service.capacityReport().transitions.quarantinedOperations, 1);

      // Same key again replays the recorded failure and does not create a second sandbox
      // while the first is unresolved.
      const again = await failure(service.create(request));
      assert.equal(again.code, originalCode);
      assert.equal(store.all().length, 0);

      // Cleanup by operation key resolves the quarantine once nothing is left on disk.
      const cancelled = await service.cancelOperation(request.operationKey);
      assert.equal(cancelled.resolution, "cleaned");
      assert.equal(cancelled.crossHostRetrySafe, true);
      assert.equal(service.admission.active().length, 0);
      assert.equal(service.capacityReport().memory.quarantinedBytes, 0);
    });

    it("rejects malformed keys and unknown lookups", async () => {
      const service = manager();
      const bad = await failure(service.create({ ...request, operationKey: "short" }));
      assert.equal(bad.status, 400);
      assert.throws(() => service.operationStatus("pod-does-not-exist-1"), (err: unknown) => (err as ServiceError).status === 404);
    });
  });

  describe("tenant CPU grants", () => {
    it("records grants before the tenant has a cgroup, rejects stale revisions, and gates degraded tenants", async () => {
      let now = 0;
      const grants = new CpuGrants(store.database, { fallbackCores: null, bootId: "boot-1", clock: () => now });
      const service = manager({ grants });
      const applied = service.applyCpuGrant("user_a", { revision: 3, cpuCores: 1.5, ttlMs: 10_000 });
      assert.equal(applied.applied, false, "no live sandbox yet, so no parent cgroup to cap");
      assert.equal(applied.grant.state, "active");
      const stale = await failure(Promise.resolve().then(() => service.applyCpuGrant("user_a", { revision: 3, cpuCores: 1, ttlMs: 10_000 })));
      assert.equal(stale.code, "stale_revision");
      assert.deepEqual(stale.details, { kind: "revision", expected: 3, actual: 3 });

      const report = service.capacityReport();
      assert.equal(report.fairness.managed, true);
      assert.equal(report.fairness.mode, "grants");
      assert.equal(report.fairness.gateAdmissions, true);

      // Another owner without a grant is degraded on a grant-managed host: new launches for
      // that owner are refused (retryable) while user_a is still admitted past the gate.
      const gated = await failure(service.create({ image: IMAGE.ref, workdir: "/w", owner: { userKey: "user_b" } }));
      assert.equal(gated.code, "admission_denied");
      assert.equal(gated.details?.kind === "admission" && gated.details.reason, "fairness_degraded");
      assert.equal(gated.details?.kind === "admission" && gated.details.retryable, true);
      assert.equal(store.all().length, 0);

      const passed = await failure(service.create({ image: IMAGE.ref, workdir: "/w", owner: { userKey: "user_a" } }));
      assert.notEqual(passed.details?.kind === "admission" && passed.details.reason, "fairness_degraded");

      now = 20_000;
      const status = service.tenantStatus("user_a");
      assert.equal(status.grant?.state, "expired");
      assert.equal(status.degraded, true);
      assert.equal(status.effectiveCpuCores, Math.max(0.5, Math.min(os.cpus().length, os.cpus().length / 1)));
      assert.equal(service.expireGrants(), 1);
      assert.equal(service.capacityReport().fairness.mode, "grants", "no live tenants means nothing is degraded");
    });

    it("never gates unowned sandboxes or hosts that were never grant-managed", async () => {
      const service = manager();
      const unowned = await failure(service.create({ image: IMAGE.ref, workdir: "/w" }));
      assert.notEqual(unowned.details?.kind === "admission" && unowned.details.reason, "fairness_degraded");
      const owned = await failure(service.create({ image: IMAGE.ref, workdir: "/w", owner: { userKey: "user_z" } }));
      assert.notEqual(owned.details?.kind === "admission" && owned.details.reason, "fairness_degraded");
    });
  });

  describe("usage feed", () => {
    it("pages samples by sandbox id with per-boot sequence and records lifecycle events", async () => {
      for (let i = 0; i < 3; i++) {
        store.insert(row({ id: `sb-usage000000000000000${i}`, tier: "stopped", netIndex: i, ownerKey: "user_u" }));
      }
      const service = manager();
      const first = service.usageSnapshot({ cursor: null, limit: 2 });
      assert.equal(first.contractVersion, 1);
      assert.equal(first.sequence, 1);
      assert.equal(first.samples.length, 2);
      assert.equal(first.nextCursor, "sb-usage0000000000000001");
      assert.equal(first.samples[0]!.ownerKey, "user_u");
      assert.equal(first.samples[0]!.live, false);
      assert.equal(first.samples[0]!.diskCommittedBytes, 0.05 * GB);
      const second = service.usageSnapshot({ cursor: first.nextCursor, limit: 2 });
      assert.equal(second.sequence, 2);
      assert.equal(second.samples.length, 1);
      assert.equal(second.nextCursor, null);

      await assert.rejects(service.create({ image: IMAGE.ref, workdir: "/w", owner: { userKey: "user_u" } }));
      const events = service.usage.events(0, 100);
      assert.ok(events.events.some((e) => e.kind === "failed" && e.ownerKey === "user_u"));
      assert.ok(events.events.every((e) => JSON.stringify(e).includes("PATH=") === false));
      const ack = service.usage.ack(events.nextAfter);
      assert.equal(ack.retained, 0);
    });
  });

  describe("configuration hygiene", () => {
    it("names PI_POD_SANDBOX_* variables the service does not parse", () => {
      assert.deepEqual(
        unknownSandboxEnv({ PI_POD_SANDBOX_TOKEN: "x", PI_POD_SANDBOX_MAX_SANDBOXES: "9", PI_POD_SANDBOX_INIT: "/bin", HOME: "/" }),
        ["PI_POD_SANDBOX_MAX_SANDBOXES"],
      );
    });

    it("derives the memory budget from host total, reserve and fleet cap when unset", () => {
      const derived = loadConfig({
        PI_POD_SANDBOX_TOKEN: "cost-controls-token-long-enough",
        PI_POD_SANDBOX_STATE_DIR: dir,
        PI_POD_SANDBOX_RESERVE_MEMORY_GB: "1",
        PI_POD_SANDBOX_FLEET_MEMORY_GB: "2",
        PI_POD_SANDBOX_ARCHIVE_DRIVER: "none",
      });
      const service = new Manager(derived, store, images(dir), {} as Runtime, {} as Network, cgroups, objects, createLogger("silent"), undefined, {
        secret: ephemeralHostSecret(),
      });
      assert.equal(service.capacityReport().memory.budgetBytes, Math.min(os.totalmem() - GB, 2 * GB));
    });
  });
});
