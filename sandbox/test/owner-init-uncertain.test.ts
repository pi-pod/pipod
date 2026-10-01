import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createObjectStore } from "../src/archive/objectstore.js";
import { loadConfig, type Config } from "../src/config.js";
import { AdmissionController } from "../src/core/admission.js";
import { Manager } from "../src/core/manager.js";
import { ephemeralHostSecret } from "../src/core/secrets.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import { ServiceError } from "../src/errors.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
import { CgroupTree } from "../src/runtime/cgroup.js";
import { Runtime, RuntimeProbeError } from "../src/runtime/crun.js";
import { SandboxDisks } from "../src/runtime/disk.js";
import type { Network } from "../src/runtime/netns.js";

const GB = 1024 ** 3;

const IMAGE: ResolvedImage = {
  ref: "ghcr.io/pi-pod/pi-pod-base:test",
  manifestDigest: "sha256:feed",
  layers: ["sha256:layer"],
  config: { env: ["PATH=/usr/bin"], entrypoint: [], cmd: [], workingDir: "/work" },
  pulledAt: new Date(0).toISOString(),
};

function row(partial: Partial<SandboxRow> & Pick<SandboxRow, "id" | "tier" | "netIndex">): SandboxRow {
  const now = Date.now();
  return {
    image: IMAGE.ref,
    imageDigest: IMAGE.manifestDigest,
    workdir: "/workspace",
    createdAt: now,
    lastActivityAt: now,
    stoppedAt: partial.tier === "hot" ? null : now - 60_000,
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

/** A stand-in `crun` whose `state` answer is scripted per container id. */
function fakeRuntimeBinary(dir: string, script: string): string {
  const file = path.join(dir, "fake-crun");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

describe("runtime state: absent vs unknown", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "runtime-state-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null only for container-scoped absence evidence; every other failure or oddity throws", async () => {
    const binary = fakeRuntimeBinary(
      dir,
      [
        'case "$2" in',
        // Genuine crun wording for a container that does not exist in its state directory.
        '  sb-missing) echo "error opening file \\`/run/crun/sb-missing/status\\`: No such file or directory" >&2; exit 1;;',
        // runsc wording.
        '  sb-gone) echo "container \\"sb-gone\\" does not exist" >&2; exit 1;;',
        // An ENOENT about something else entirely while the guest may be alive.
        '  sb-loader) echo "error opening file \\`/usr/lib/libseccomp.so.2\\`: No such file or directory" >&2; exit 1;;',
        '  sb-config) echo "cannot open config.json: No such file or directory" >&2; exit 1;;',
        '  sb-other) echo "error opening file \\`/run/crun/sb-someone-else/status\\`: No such file or directory" >&2; exit 1;;',
        '  sb-notfound) echo "crun: executable file not found in $PATH" >&2; exit 127;;',
        '  sb-running) echo \'{"id":"sb-running","status":"running","pid":4242}\'; exit 0;;',
        '  sb-stopped) echo \'{"id":"sb-stopped","status":"stopped","pid":0}\'; exit 0;;',
        '  sb-stoppednopid) echo \'{"id":"sb-stoppednopid","status":"stopped"}\'; exit 0;;',
        '  sb-creating) echo \'{"id":"sb-creating","status":"creating","pid":77}\'; exit 0;;',
        '  sb-unknown) echo \'{"id":"sb-unknown","status":"zombie","pid":5}\'; exit 0;;',
        '  sb-nopid) echo \'{"id":"sb-nopid","status":"running"}\'; exit 0;;',
        '  sb-badpid) echo \'{"id":"sb-badpid","status":"running","pid":"4242"}\'; exit 0;;',
        '  sb-zeropid) echo \'{"id":"sb-zeropid","status":"running","pid":0}\'; exit 0;;',
        '  sb-wrongid) echo \'{"id":"sb-elsewhere","status":"running","pid":9}\'; exit 0;;',
        '  sb-noid) echo \'{"status":"stopped","pid":0}\'; exit 0;;',
        '  sb-numid) echo \'{"id":42,"status":"stopped","pid":0}\'; exit 0;;',
        '  sb-stoppedbadpid) echo \'{"id":"sb-stoppedbadpid","status":"stopped","pid":"0"}\'; exit 0;;',
        '  sb-stoppednegpid) echo \'{"id":"sb-stoppednegpid","status":"stopped","pid":-1}\'; exit 0;;',
        '  sb-stoppedfloatpid) echo \'{"id":"sb-stoppedfloatpid","status":"stopped","pid":1.5}\'; exit 0;;',
        '  sb-null) echo "null"; exit 0;;',
        '  sb-array) echo \'[{"id":"sb-array","status":"stopped"}]\'; exit 0;;',
        '  sb-string) echo \'"stopped"\'; exit 0;;',
        '  sb-garbage) echo "not json"; exit 0;;',
        '  *) echo "permission denied" >&2; exit 1;;',
        "esac",
      ].join("\n"),
    );
    const runtime = new Runtime(binary);
    assert.equal(await runtime.state("sb-missing"), null);
    assert.equal(await runtime.state("sb-gone"), null);
    assert.deepEqual(await runtime.state("sb-running"), { status: "running", pid: 4242 });
    assert.deepEqual(await runtime.state("sb-stopped"), { status: "stopped", pid: 0 });
    assert.deepEqual(await runtime.state("sb-stoppednopid"), { status: "stopped", pid: 0 }, "pid is optional for a stopped container");
    assert.deepEqual(await runtime.state("sb-creating"), { status: "creating", pid: 77 });
    // Unrelated ENOENT / not-found diagnostics are not absence.
    for (const id of ["sb-loader", "sb-config", "sb-other", "sb-notfound", "sb-broken"]) {
      await assert.rejects(runtime.state(id), RuntimeProbeError, id);
    }
    // A success answer that cannot be reasoned about is not a stopped/zero-pid result.
    // Malformed "stopped" evidence must never authorise a release either.
    for (const id of [
      "sb-unknown", "sb-nopid", "sb-badpid", "sb-zeropid", "sb-wrongid", "sb-garbage",
      "sb-noid", "sb-numid", "sb-stoppedbadpid", "sb-stoppednegpid", "sb-stoppedfloatpid",
      "sb-null", "sb-array", "sb-string",
    ]) {
      await assert.rejects(runtime.state(id), RuntimeProbeError, id);
    }
  });
});

describe("retention changes are fenced by a hold", () => {
  it("refuses a retention change on a held source and leaves the manifest unchanged; same value stays a no-op", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "held-retention-"));
    const store = new Store(path.join(dir, "db"));
    try {
      const cfg = loadConfig({
        PI_POD_SANDBOX_TOKEN: "held-retention-token-long-enough",
        PI_POD_SANDBOX_STATE_DIR: dir,
        PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
      });
      for (const p of Object.values(cfg.paths)) fs.mkdirSync(p, { recursive: true });
      const id = "sb-held000000000000001";
      store.insert(row({ id, tier: "archived", netIndex: 1, archiveKey: "k", archiveSha256: "0".repeat(64), archiveSize: 1, archiveAfterMinutes: 60 }));
      const service = new Manager(cfg, store, { resolve: async () => IMAGE, pull: async () => IMAGE, layerDir: () => dir, gc: async () => [], list: async () => [IMAGE] }, {} as Runtime, {} as Network, new CgroupTree("pps", path.join(dir, "cgroup")), createObjectStore(cfg.archive), createLogger("silent"), undefined, {
        bootId: "boot-ret",
        secret: ephemeralHostSecret(),
      });
      await service.hold(id, "retirement:test");
      const before = await service.archiveReference(id, false);
      assert.throws(() => service.applyRetention(id, 30), (err: unknown) => (err as ServiceError).code === "sandbox_held");
      assert.equal(service.applyRetention(id, 60), false, "same-value replay is still an idempotent no-op");
      const after = await service.archiveReference(id, false);
      assert.deepEqual(after.config, before.config, "manifest unchanged under the fence");
      assert.equal(after.revision, before.revision);
      await service.releaseHold(id, "retirement:test", false);
      assert.equal(service.applyRetention(id, 30), true);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("owner initialization defers uncertain runtimes", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "owner-uncertain-"));
    store = new Store(path.join(dir, "db"));
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "owner-uncertain-token-long-enough",
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_MEMORY_BUDGET_GB: "8",
      PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
      PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.05",
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
    });
    for (const p of Object.values(cfg.paths)) fs.mkdirSync(p, { recursive: true });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const images = (): ImageStore => ({
    resolve: async () => IMAGE,
    pull: async () => IMAGE,
    layerDir: (digest: string) => path.join(dir, digest),
    gc: async () => [],
    list: async () => [IMAGE],
  });

  const manager = (runtime: Partial<Runtime> = {}): Manager =>
    new Manager(cfg, store, images(), runtime as Runtime, { destroy: async () => undefined } as unknown as Network, new CgroupTree("pps", path.join(dir, "cgroup")), createObjectStore(cfg.archive), createLogger("silent"), undefined, {
      bootId: "boot-owner",
      secret: ephemeralHostSecret(),
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

  it("refuses an error row (its runtime may be retained) and reports it as uncertain debt", async () => {
    // The fixture a failed start leaves behind: tier error after a teardown that may not have
    // succeeded. Nothing about the row proves the process is gone.
    store.insert(row({ id: "sb-err000000000000000001", tier: "error", netIndex: 1, error: "simulated launch failure" }));
    const service = manager();
    const refused = await failure(service.initializeOwner("sb-err000000000000000001", "user_a"));
    assert.equal(refused.code, "owner_conflict");
    assert.match(refused.message, /in error/);
    assert.equal(store.get("sb-err000000000000000001")!.ownerKey, null);
    const tenancy = service.capacityReport().tenancy;
    assert.equal(tenancy.unownedUncertain, 1);
    assert.equal(tenancy.unownedInitializable, 0, "an uncertain runtime is never counted as migratable");
  });

  it("refuses a stopped row that still holds a quarantined reservation, and allows it once resolved", async () => {
    const id = "sb-qua000000000000000001";
    store.insert(row({ id, tier: "stopped", netIndex: 1 }));
    // A failed wake whose cleanup was uncertain leaves a quarantined reservation: the memory
    // ceiling is still charged because the process may still exist.
    const admission = new AdmissionController(store.database, cfg, new SandboxDisks(cfg.paths.sandboxes, 0), { bootId: "boot-owner" });
    admission.reserve(
      { operationId: `start:${id}:x`, sandboxId: id, kind: "start", desiredMemoryBytes: 4 * GB, desiredDiskBytes: 0.05 * GB, desiredCpuFloor: 0.25 },
      store.all(),
    );
    admission.quarantine(`start:${id}:x`, "failed start left resources behind");
    const service = manager();
    const refused = await failure(service.initializeOwner(id, "user_a"));
    assert.equal(refused.code, "owner_conflict");
    assert.match(refused.message, /unresolved reservation/);
    assert.equal(service.capacityReport().tenancy.unownedUncertain, 1);
    assert.equal(service.capacityReport().memory.quarantinedBytes, 4 * GB, "the charge stays while ownership is deferred");

    // A supported reconciliation resolves it; then initialization proceeds normally.
    service.admission.release(`start:${id}:x`);
    const set = await service.initializeOwner(id, "user_a");
    assert.equal(set.changed, true);
    assert.equal(service.capacityReport().tenancy.unownedUncertain, 0);
  });

  it("keeps idempotent same-owner replay and normal archived/stopped initialization", async () => {
    store.insert(row({ id: "sb-ok0000000000000000001", tier: "archived", netIndex: 1, archiveKey: "k", archiveSha256: "0".repeat(64), archiveSize: 1 }));
    store.insert(row({ id: "sb-ok0000000000000000002", tier: "stopped", netIndex: 2 }));
    store.insert(row({ id: "sb-ok0000000000000000003", tier: "error", netIndex: 3, ownerKey: "user_a" }));
    const service = manager();
    assert.equal((await service.initializeOwner("sb-ok0000000000000000001", "user_a")).changed, true);
    assert.equal((await service.initializeOwner("sb-ok0000000000000000002", "user_a")).changed, true);
    assert.equal((await service.initializeOwner("sb-ok0000000000000000001", "user_a")).changed, false);
    // An error row that already carries this owner replays idempotently; nothing is relabeled.
    assert.equal((await service.initializeOwner("sb-ok0000000000000000003", "user_a")).changed, false);
    assert.equal((await failure(service.initializeOwner("sb-ok0000000000000000003", "user_b"))).code, "owner_conflict");
  });

  it("a transitional (created) runtime after restart is kept, never torn down or released", async () => {
    const id = "sb-created000000000001";
    store.insert(row({ id, tier: "hot", netIndex: 1, runtimeGeneration: 1 }));
    const pending = "sb-pending000000000001";
    store.insert(row({ id: pending, tier: "stopped", netIndex: 2 }));
    const admission = new AdmissionController(store.database, cfg, new SandboxDisks(cfg.paths.sandboxes, 0), { bootId: "boot-previous" });
    admission.reserve(
      { operationId: `create:pod-c:create:1`, sandboxId: pending, kind: "create", desiredMemoryBytes: 4 * GB, desiredDiskBytes: 0.05 * GB, desiredCpuFloor: 0.25 },
      store.all(),
    );
    const root = path.join(dir, "cgroup");
    fs.mkdirSync(path.join(root, "pps"), { recursive: true });
    fs.writeFileSync(path.join(root, "cgroup.controllers"), "cpu memory pids\n");
    fs.writeFileSync(path.join(root, "pps", "cgroup.controllers"), "cpu memory pids\n");
    let kills = 0;
    const service = new Manager(
      cfg,
      store,
      images(),
      { state: async () => ({ status: "created", pid: 31 }), kill: async () => { kills += 1; }, delete: async () => undefined } as unknown as Runtime,
      { ensureBridge: async () => undefined, destroy: async () => undefined } as unknown as Network,
      new CgroupTree("pps", root),
      createObjectStore(cfg.archive),
      createLogger("silent"),
      undefined,
      { bootId: "boot-new", secret: ephemeralHostSecret() },
    );
    await service.init();
    assert.equal(kills, 0, "a created container is never killed on a guess");
    assert.equal(store.get(id)!.tier, "hot");
    assert.equal(store.get(pending)!.tier, "stopped", "the interrupted create is retained");
    assert.equal(service.admission.get("create:pod-c:create:1")?.status, "quarantined", "transitional is unknown: charged, not released");
    assert.equal(service.capacityReport().memory.quarantinedBytes, 4 * GB);
  });

  it("restart recovery treats a failed runtime probe as unknown: nothing is freed, nothing marked stopped", async () => {
    const id = "sb-probe0000000000000001";
    store.insert(row({ id, tier: "hot", netIndex: 1, runtimeGeneration: 1 }));
    const admission = new AdmissionController(store.database, cfg, new SandboxDisks(cfg.paths.sandboxes, 0), { bootId: "boot-previous" });
    admission.reserve(
      { operationId: `start:${id}:prev`, sandboxId: id, kind: "start", desiredMemoryBytes: 4 * GB, desiredDiskBytes: 0.05 * GB, desiredCpuFloor: 0.25 },
      store.all(),
    );
    const root = path.join(dir, "cgroup");
    fs.mkdirSync(path.join(root, "pps"), { recursive: true });
    fs.writeFileSync(path.join(root, "cgroup.controllers"), "cpu memory pids\n");
    fs.writeFileSync(path.join(root, "pps", "cgroup.controllers"), "cpu memory pids\n");
    const service = new Manager(
      cfg,
      store,
      images(),
      { state: async () => { throw new RuntimeProbeError(id, "crun: permission denied"); }, kill: async () => undefined, delete: async () => undefined } as unknown as Runtime,
      { ensureBridge: async () => undefined, destroy: async () => undefined } as unknown as Network,
      new CgroupTree("pps", root),
      createObjectStore(cfg.archive),
      createLogger("silent"),
      undefined,
      { bootId: "boot-new", secret: ephemeralHostSecret() },
    );
    await service.init();
    assert.equal(store.get(id)!.tier, "hot", "an unknown probe never marks a row stopped");
    // The row stayed hot, so its tier now carries the charge and the journal row commits
    // to it; either way the 4 GiB is still owed and nothing was released.
    assert.equal(service.admission.get(`start:${id}:prev`)?.status, "committed");
    assert.equal(service.capacityReport().memory.committedBytes, 4 * GB, "unknown is charged, not released");
    assert.equal(service.capacityReport().tenancy.unownedUncertain, 0, "live rows are grandfathered, not uncertain");
    assert.equal(service.capacityReport().tenancy.unownedLive, 1);
  });
});
