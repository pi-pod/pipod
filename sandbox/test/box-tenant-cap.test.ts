import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { AdmissionController } from "../src/core/admission.js";
import { Reaper } from "../src/core/reaper.js";
import type { Manager } from "../src/core/manager.js";
import type { Config } from "../src/config.js";
import { BOX_DEFAULT_TENANT_MEMORY_GB, loadConfig } from "../src/config.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import { createLogger } from "../src/log.js";
import type { CgroupTree } from "../src/runtime/cgroup.js";
import { CgroupTree as RealCgroupTree } from "../src/runtime/cgroup.js";
import type { ObjectStore } from "../src/archive/types.js";
import type { SandboxInfoWire } from "../src/wire.js";

const GB = 1024 ** 3;
const TOKEN = "box-tenant-cap-test-token-long";
const HOUR = 60 * 60 * 1000;

function boxCfg(extra: Record<string, string> = {}): Config {
  return loadConfig({
    PI_POD_SANDBOX_TOKEN: TOKEN,
    PI_POD_SANDBOX_HOST_BACKEND: "box",
    PI_POD_SANDBOX_HOST_ID: "box-tenant1",
    ...extra,
  });
}

describe("box tenant aggregate config", () => {
  it("box mode defaults to the conservative tenant memory cap and derived CPU", () => {
    assert.equal(BOX_DEFAULT_TENANT_MEMORY_GB, 5.5);
    const cfg = boxCfg();
    assert.equal(cfg.tenancy.tenantMemoryMaxBytes, Math.round(5.5 * GB));
    assert.equal(cfg.tenancy.tenantCpuMaxCores, Math.max(0.5, os.cpus().length - 0.5));
  });

  it("box mode honours an explicit larger tenant memory cap (measured large reserve)", () => {
    const cfg = boxCfg({ PI_POD_SANDBOX_TENANT_MEMORY_GB: "12" });
    assert.equal(cfg.tenancy.tenantMemoryMaxBytes, 12 * GB);
  });

  it("box mode fails closed on an explicit zero tenant memory cap (never silently unlimited)", () => {
    assert.throws(() => boxCfg({ PI_POD_SANDBOX_TENANT_MEMORY_GB: "0" }), /TENANT_MEMORY_GB > 0/);
  });

  it("box mode honours explicit tenant CPU, with explicit 0 removing the cap loudly", () => {
    assert.equal(boxCfg({ PI_POD_SANDBOX_TENANT_CPU: "6" }).tenancy.tenantCpuMaxCores, 6);
    assert.equal(boxCfg({ PI_POD_SANDBOX_TENANT_CPU: "0" }).tenancy.tenantCpuMaxCores, null);
  });

  it("static mode stays uncapped by default (contract unchanged) but allows opt-in", () => {
    const def = loadConfig({ PI_POD_SANDBOX_TOKEN: TOKEN });
    assert.equal(def.hostBackend, "static");
    assert.equal(def.tenancy.tenantMemoryMaxBytes, null);
    assert.equal(def.tenancy.tenantCpuMaxCores, null);
    const opt = loadConfig({
      PI_POD_SANDBOX_TOKEN: TOKEN,
      PI_POD_SANDBOX_TENANT_MEMORY_GB: "10",
      PI_POD_SANDBOX_TENANT_CPU: "2.5",
    });
    assert.equal(opt.tenancy.tenantMemoryMaxBytes, 10 * GB);
    assert.equal(opt.tenancy.tenantCpuMaxCores, 2.5);
  });
});

function fakeHost8GB() {
  return {
    totalmem: () => 8 * GB,
    freemem: () => 4 * GB,
    cpus: () => 4,
    loadavg1: () => 0.1,
    cpuPressureAvg10: () => -1,
  };
}

function fakeDisks(capacityBytes: number) {
  return {
    probe: (_ids: Iterable<string>) => ({ capacityBytes, allocatedBytes: 0 }),
    hasImage: (_id: string) => false,
  };
}

function ceilingRow(id: string): { id: string; resources: { cpu: number; memoryGB: number; diskGB: number }; ceiling: { cpu: number; memoryGB: number; diskGB: number } } {
  return {
    id,
    resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 2 },
    ceiling: { cpu: 2, memoryGB: 4, diskGB: 2 },
  };
}

describe("admission folds the tenant cap into the host budget", () => {
  it("box default budget is the tenant cap, not host-minus-reserve", () => {
    const db = new Database(":memory:");
    try {
      const ctrl = new AdmissionController(db, boxCfg(), fakeDisks(40 * GB), {
        bootId: "boot-1",
        host: fakeHost8GB(),
      });
      // 8 GiB host − 1 GiB reserve = 7 GiB headroom, but the 5.5 GiB tenant cap binds.
      assert.equal(ctrl.memoryBudgetBytes(), Math.round(5.5 * GB));
      assert.equal(ctrl.capacity([]).memory.budgetBytes, Math.round(5.5 * GB));
    } finally {
      db.close();
    }
  });

  it("static default budget is unchanged (host minus reserve)", () => {
    const db = new Database(":memory:");
    try {
      const cfg = loadConfig({ PI_POD_SANDBOX_TOKEN: TOKEN });
      const ctrl = new AdmissionController(db, cfg, fakeDisks(40 * GB), {
        bootId: "boot-1",
        host: fakeHost8GB(),
      });
      assert.equal(ctrl.memoryBudgetBytes(), 7 * GB);
    } finally {
      db.close();
    }
  });

  it("an explicit budget above the tenant cap still admits only to the cap", () => {
    const db = new Database(":memory:");
    try {
      const ctrl = new AdmissionController(
        db,
        boxCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "12" }),
        fakeDisks(100 * GB),
        { bootId: "boot-1", host: fakeHost8GB() },
      );
      assert.equal(ctrl.memoryBudgetBytes(), Math.round(5.5 * GB));
    } finally {
      db.close();
    }
  });

  it("two individual 4 GiB ceiling reservations do not fit a 5.5 GiB box tenant (backpressure, not OOM)", () => {
    const db = new Database(":memory:");
    try {
      const ctrl = new AdmissionController(db, boxCfg(), fakeDisks(40 * GB), {
        bootId: "boot-1",
        host: fakeHost8GB(),
      });
      ctrl.reserve(
        { operationId: "create:k1", sandboxId: "sb-first", kind: "create", desiredMemoryBytes: 4 * GB, desiredDiskBytes: 2 * GB, desiredCpuFloor: 0.25 },
        [],
      );
      try {
        ctrl.reserve(
          { operationId: "create:k2", sandboxId: "sb-second", kind: "create", desiredMemoryBytes: 4 * GB, desiredDiskBytes: 2 * GB, desiredCpuFloor: 0.25 },
          [{ ...ceilingRow("sb-first"), tier: "hot" } as never],
        );
        assert.fail("second 4 GiB ceiling reservation should not fit a 5.5 GiB box tenant");
      } catch (err) {
        assert.ok(err instanceof Error);
        const details = (err as { details?: { reason?: string } }).details;
        assert.equal(details?.reason, "memory_capacity");
        assert.match(String(err), /4\.00 GiB requested, 1\.50 GiB available.*of 5\.50 GiB/);
      }
    } finally {
      db.close();
    }
  });
});

describe("tenant parent memory cap on a fake cgroupfs", () => {
  async function withTenantDir(fn: (tenant: ReturnType<RealCgroupTree["tenant"]>) => void): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tenant-cap-unit-"));
    try {
      const tree = new RealCgroupTree("pps", dir);
      const tenant = tree.tenant("u1");
      fs.mkdirSync(tenant.dir, { recursive: true });
      for (const f of ["memory.high", "memory.max", "memory.current", "memory.pressure"]) {
        fs.writeFileSync(path.join(tenant.dir, f), f === "memory.pressure" ? "some avg10=0.00 total=0\nfull avg10=0.00 total=0\n" : "max");
      }
      fs.writeFileSync(path.join(tenant.dir, "memory.current"), "123456");
      fn(tenant);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("setMemoryMax writes high and max together with read-back verification", async () => {
    await withTenantDir((tenant) => {
      assert.equal(tenant.setMemoryMax(2 * GB), true);
      assert.equal(fs.readFileSync(path.join(tenant.dir, "memory.high"), "utf8"), String(2 * GB));
      assert.equal(tenant.currentMemoryMax(), 2 * GB);
      const usage = tenant.memoryUsage()!;
      assert.equal(usage.current, 123456);
      assert.equal(usage.max, 2 * GB);
    });
  });

  it("setMemoryMax(null) removes the cap", async () => {
    await withTenantDir((tenant) => {
      assert.equal(tenant.setMemoryMax(2 * GB), true);
      assert.equal(tenant.setMemoryMax(null), true);
      assert.equal(tenant.currentMemoryMax(), null);
    });
  });

  it("a missing tenant dir reports null usage instead of throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tenant-cap-missing-"));
    try {
      const tree = new RealCgroupTree("pps", dir);
      assert.equal(tree.tenant("ghost").setMemoryMax(GB), false);
      assert.equal(tree.tenant("ghost").memoryUsage(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function insertLive(
  store: Store,
  id: string,
  tier: "hot" | "warm",
  opts: { ownerKey: string | null; lastActivityAt: number; netIndex: number; idleTimeoutMinutes?: number },
): void {
  const row: SandboxRow = {
    id,
    image: "busybox",
    imageDigest: "sha256:dead",
    workdir: "/workspace",
    tier,
    createdAt: opts.lastActivityAt,
    lastActivityAt: opts.lastActivityAt,
    stoppedAt: null,
    archiveAfterMinutes: 0,
    // 0 disables the ordinary idle stop so the tests isolate pressure shedding.
    idleTimeoutMinutes: opts.idleTimeoutMinutes ?? 0,
    resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 5 },
    ceiling: { cpu: 2, memoryGB: 4 },
    egress: { mode: "open" },
    netIndex: opts.netIndex,
    error: null,
    archiveKey: null,
    archiveSha256: null,
    archiveSize: null,
    lastCpuUsec: 0,
    labels: {},
    layers: [],
    ownerKey: opts.ownerKey,
    revision: 0,
    runtimeGeneration: 1,
    cgroupRel: null,
    hold: null,
    archiveShared: false,
  };
  store.insert(row);
}

function makeTenantReaper(
  store: Store,
  usage: { current: number; max: number | null },
  calls: { frozen: string[]; stopped: string[] },
): { reaper: Reaper; tickNow: () => number } {
  const manager = {
    isTransitioning: (_id: string) => false,
    archiveIfStopped: async () => {
      throw new Error("no archiving expected in tenant-pressure tests");
    },
    stop: async (id: string) => {
      calls.stopped.push(id);
      store.setTier(id, "stopped", { stoppedAt: Date.now() });
      return { id } as SandboxInfoWire;
    },
    freeze: async (id: string) => {
      calls.frozen.push(id);
      return true;
    },
    cgroupOf: (_id: string) => ({ exists: () => false, stats: () => ({ cpuUsec: 0, memoryCurrent: 0 }) }),
    expireGrants: () => 0,
    housekeeping: () => undefined,
  } as unknown as Manager;
  const cfg = {
    hostBackend: "box",
    warmAfterMinutes: 10,
    cpuVetoMs: 200,
    pressureThreshold: 20,
    admission: { maxConcurrentArchives: 2 },
    hostId: "pps-test",
    drIntervalMinutes: 0,
    reaperIntervalMs: 15_000,
    paths: { spool: path.join(os.tmpdir(), "unused-spool") },
  } as unknown as Config;
  const cgroups = {
    hostPressure: () => -1,
    listTenantKeys: () => ["u1"],
    tenant: (_key: string) => ({ memoryUsage: () => ({ ...usage, pressure: -1 }) }),
  } as unknown as CgroupTree;
  const objects = { kind: "none" } as unknown as ObjectStore;
  const reaper = new Reaper(cfg, store, manager, cgroups, objects, createLogger("silent"));
  // Tick with a fresh clock: the box resume guard rebases every timer when the tick wall
  // time jumps (or runs backward) past its threshold, which would flatten test fixtures.
  return { reaper, tickNow: () => Date.now() };
}

describe("reaper tenant-pressure shedding", () => {
  async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tenant-shed-unit-"));
    const store = new Store(dir);
    try {
      await fn(store);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("freezes the tenant's longest-idle hot sandbox at 95% of cap with healthy host PSI", async () => {
    await withStore(async (store) => {
      // Recent enough to dodge the ordinary warm-freeze/idle-stop paths; the tenant
      // shed still picks the longest-idle first.
      const now = Date.now();
      insertLive(store, "sb-old", "hot", { ownerKey: "u1", lastActivityAt: now - 2 * 60_000, netIndex: 1 });
      insertLive(store, "sb-new", "hot", { ownerKey: "u1", lastActivityAt: now - 60_000, netIndex: 2 });
      const calls = { frozen: [] as string[], stopped: [] as string[] };
      const { reaper, tickNow } = makeTenantReaper(store, { current: Math.round(5.5 * GB * 0.95), max: Math.round(5.5 * GB) }, calls);
      await reaper.tick(tickNow());
      assert.deepEqual(calls.frozen, ["sb-old"]);
      assert.deepEqual(calls.stopped, []);
    });
  });

  it("stops a genuinely-idle warm sandbox when no hot candidate remains", async () => {
    await withStore(async (store) => {
      const now = Date.now();
      // idleTimeoutMinutes stays 0 (no ordinary idle stop); the warm window makes it
      // genuinely idle for the pressure path.
      insertLive(store, "sb-warm", "warm", { ownerKey: "u1", lastActivityAt: now - 2 * HOUR, netIndex: 1 });
      const calls = { frozen: [] as string[], stopped: [] as string[] };
      const { reaper, tickNow } = makeTenantReaper(store, { current: 6 * GB, max: Math.round(5.5 * GB) }, calls);
      await reaper.tick(tickNow());
      assert.deepEqual(calls.frozen, []);
      assert.deepEqual(calls.stopped, ["sb-warm"]);
    });
  });

  it("leaves unowned flat sandboxes alone during tenant shedding", async () => {
    await withStore(async (store) => {
      const now = Date.now();
      insertLive(store, "sb-flat", "hot", { ownerKey: null, lastActivityAt: now - 60_000, netIndex: 1 });
      const calls = { frozen: [] as string[], stopped: [] as string[] };
      const { reaper, tickNow } = makeTenantReaper(store, { current: Math.round(5.5 * GB * 0.95), max: Math.round(5.5 * GB) }, calls);
      await reaper.tick(tickNow());
      assert.deepEqual(calls.frozen, []);
      assert.deepEqual(calls.stopped, []);
    });
  });

  it("does nothing below the shedding ratio", async () => {
    await withStore(async (store) => {
      const now = Date.now();
      insertLive(store, "sb-old", "hot", { ownerKey: "u1", lastActivityAt: now - 60_000, netIndex: 1 });
      const calls = { frozen: [] as string[], stopped: [] as string[] };
      const { reaper, tickNow } = makeTenantReaper(store, { current: Math.round(5.5 * GB * 0.5), max: Math.round(5.5 * GB) }, calls);
      await reaper.tick(tickNow());
      assert.deepEqual(calls.frozen, []);
      assert.deepEqual(calls.stopped, []);
    });
  });

  it("reports instead of touching active sandboxes past their idle window", async () => {
    await withStore(async (store) => {
      const now = Date.now();
      insertLive(store, "sb-warm-busy", "warm", { ownerKey: "u1", lastActivityAt: now, netIndex: 1 });
      const calls = { frozen: [] as string[], stopped: [] as string[] };
      const { reaper, tickNow } = makeTenantReaper(store, { current: 6 * GB, max: Math.round(5.5 * GB) }, calls);
      await reaper.tick(tickNow());
      assert.deepEqual(calls.frozen, []);
      assert.deepEqual(calls.stopped, []);
    });
  });
});
