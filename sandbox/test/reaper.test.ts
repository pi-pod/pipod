import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Config } from "../src/config.js";
import type { Manager } from "../src/core/manager.js";
import { Reaper } from "../src/core/reaper.js";
import type { CgroupTree } from "../src/runtime/cgroup.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import { createLogger } from "../src/log.js";
import type { ObjectStore } from "../src/archive/types.js";
import type { SandboxInfoWire } from "../src/wire.js";

const HOUR = 60 * 60 * 1000;

describe("reaper archive decisions", () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "reaper-unit-"));
    store = new Store(dir);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("archives a long-stopped sandbox and skips one whose stop clock was reset", async () => {
    const now = Date.now();
    insertStopped(store, "sb-old", { stoppedAt: now - 2 * HOUR, archiveAfterMinutes: 60, netIndex: 1 });
    insertStopped(store, "sb-restored", { stoppedAt: now - 2 * HOUR, archiveAfterMinutes: 60, netIndex: 2 });
    store.setTier("sb-restored", "stopped", { stoppedAt: now });

    const archived: string[] = [];
    const guards: Array<{ id: string; expectedRevision?: number; expectedStoppedAt?: string }> = [];
    const reaper = makeReaper(store, { archived, guards });
    const before = store.get("sb-old")!;
    await reaper.tick(now);
    await settled(reaper);

    assert.deepEqual(archived, ["sb-old"]);
    // The revision and stop instant the reaper read travel with the request, so the pack
    // becomes a no-op if a wake lands in between.
    assert.deepEqual(guards, [
      { id: "sb-old", expectedRevision: before.revision, expectedStoppedAt: new Date(before.stoppedAt!).toISOString() },
    ]);
    // The archive itself is a tier write, so the revision moved on afterwards.
    assert.equal(store.get("sb-old")!.revision, before.revision + 1);
  });

  it("Boat wall-clock jumps grant full grace instead of merely skipping one overdue tick", async () => {
    const before = Date.now();
    insertStopped(store, "sb-resume", { stoppedAt: before - 2 * HOUR, archiveAfterMinutes: 60, netIndex: 1 });
    insertStopped(store, "sb-hot", { stoppedAt: before - 2 * HOUR, archiveAfterMinutes: 60, netIndex: 2 });
    store.setTier("sb-hot", "hot", { stoppedAt: null });
    const archived: string[] = [];
    const stopped: string[] = [];
    const reaper = makeReaper(store, { archived, stopped, boat: true });
    const resumed = before + 24 * HOUR;
    await reaper.tick(resumed);
    await reaper.tick(resumed + 15_000);
    assert.equal(archived.length, 0);
    assert.equal(stopped.length, 0);
    assert.equal(store.get("sb-resume")!.stoppedAt, resumed);
    assert.equal(store.get("sb-hot")!.lastActivityAt, resumed);
    // Keep normal 15s ticks so this is real elapsed idle time, not another resume gap.
    for (let at = resumed + 30_000; at <= resumed + 61 * 60_000; at += 15_000) await reaper.tick(at);
    await settled(reaper);
    assert.ok(archived.includes("sb-resume"));
    assert.ok(stopped.includes("sb-hot"));
  });

  it("bounds how many archives one tick launches and never double-launches one in flight", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      insertStopped(store, `sb-overdue-${i}`, { stoppedAt: now - 2 * HOUR, archiveAfterMinutes: 60, netIndex: 10 + i });
    }
    const archived: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reaper = makeReaper(store, { archived, maxConcurrentArchives: 2, block: gate });

    await reaper.tick(now);
    assert.equal(reaper.archivesInFlight, 2);
    // A second tick while both slots are busy launches nothing more for the same ids.
    await reaper.tick(now);
    assert.equal(reaper.archivesInFlight, 2);
    release();
    await settled(reaper);
    assert.equal(archived.length, 2);

    await reaper.tick(now);
    await settled(reaper);
    assert.equal(archived.length, 4);
    assert.equal(new Set(archived).size, 4);
  });

  it("does not archive a sandbox that is mid-restore", async () => {
    const now = Date.now();
    insertStopped(store, "sb-waking", { stoppedAt: now - 2 * HOUR, archiveAfterMinutes: 60, netIndex: 3 });
    const archived: string[] = [];
    const reaper = makeReaper(store, { archived, transitioning: new Set(["sb-waking"]) });
    await reaper.tick(now);
    assert.deepEqual(archived, []);
  });

  it("under host pressure never stops a warm sandbox that is busy or inside its idle window", async () => {
    const now = Date.now();
    // Quiet but working: no keepalive for an hour, but CPU moved this tick.
    insertStopped(store, "sb-busy", { stoppedAt: now - 2 * HOUR, archiveAfterMinutes: 0, netIndex: 1 });
    store.setTier("sb-busy", "warm", { stoppedAt: null });
    store.touch("sb-busy", now - HOUR);
    // Recently active: inside its 15 minute idle window.
    insertStopped(store, "sb-recent", { stoppedAt: now - 2 * HOUR, archiveAfterMinutes: 0, netIndex: 2 });
    store.setTier("sb-recent", "warm", { stoppedAt: null });
    store.touch("sb-recent", now - 60_000);
    // Genuinely idle: silent for an hour and no CPU movement.
    insertStopped(store, "sb-idle", { stoppedAt: now - 2 * HOUR, archiveAfterMinutes: 0, netIndex: 3 });
    store.setTier("sb-idle", "warm", { stoppedAt: null });
    store.touch("sb-idle", now - 2 * HOUR);

    const stopped: string[] = [];
    const reaper = makeReaper(store, { archived: [], stopped, pressure: 90, cpuUsec: { "sb-busy": 5_000_000 } });
    await reaper.tick(now);
    assert.deepEqual(stopped, ["sb-idle"]);

    // Only active candidates left: pressure relief reports instead of guessing.
    store.setTier("sb-idle", "stopped", { stoppedAt: now });
    const none: string[] = [];
    const cautious = makeReaper(store, { archived: [], stopped: none, pressure: 90, cpuUsec: { "sb-busy": 9_000_000 } });
    await cautious.tick(now);
    assert.deepEqual(none, []);
  });

  it("scopes disaster-recovery snapshots to this host so a shared bucket cannot lose one", async () => {
    const uploaded: string[] = [];
    const reaper = makeReaper(store, {
      archived: [],
      dr: { hostId: "pps-2", spool: dir, uploaded },
    });

    await reaper.tick(Date.parse("2026-08-31T12:00:00.000Z"));

    assert.deepEqual(uploaded, ["_dr/pps-2/sandbox-2026-08-31T12:00:00.000Z.sqlite"]);
  });
});

async function settled(reaper: Reaper): Promise<void> {
  for (let i = 0; i < 200 && reaper.archivesInFlight > 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeReaper(
  store: Store,
  opts: {
    archived: string[];
    guards?: Array<{ id: string; expectedRevision?: number; expectedStoppedAt?: string }>;
    transitioning?: Set<string>;
    maxConcurrentArchives?: number;
    boat?: boolean;
    block?: Promise<void>;
    stopped?: string[];
    pressure?: number;
    /** cgroup cpu.stat usage_usec per sandbox id this tick (absent = 0, i.e. no movement). */
    cpuUsec?: Record<string, number>;
    dr?: { hostId: string; spool: string; uploaded: string[] };
  },
): Reaper {
  const manager = {
    isTransitioning: (id: string) => opts.transitioning?.has(id) ?? false,
    archiveIfStopped: async (id: string, guard: { expectedRevision?: number; expectedStoppedAt?: string }) => {
      opts.guards?.push({ id, ...guard });
      if (opts.block) await opts.block;
      opts.archived.push(id);
      store.setTier(id, "archived");
      return { archived: true, outcome: "archived", sandbox: { id } as SandboxInfoWire };
    },
    archiveStopped: async () => {
      throw new Error("reaper must pack via archiveIfStopped with the revision it read");
    },
    archive: async () => {
      throw new Error("reaper must pack via archiveIfStopped, not archive()");
    },
    stop: async (id: string) => {
      if (!opts.stopped) throw new Error("reaper must not stop a sandbox in the archive path");
      opts.stopped.push(id);
      store.setTier(id, "stopped", { stoppedAt: Date.now() });
      return { id } as SandboxInfoWire;
    },
    freeze: async () => false,
    cgroupOf: (id: string) => ({
      exists: () => opts.cpuUsec !== undefined,
      stats: () => ({ cpuUsec: opts.cpuUsec?.[id] ?? 0, memoryCurrent: 0 }),
    }),
    expireGrants: () => 0,
    housekeeping: () => undefined,
  } as unknown as Manager;

  const cfg = {
    hostBackend: opts.boat ? "boat" : "static",
    warmAfterMinutes: 10,
    cpuVetoMs: 200,
    pressureThreshold: 20,
    admission: { maxConcurrentArchives: opts.maxConcurrentArchives ?? 2 },
    hostId: opts.dr?.hostId ?? "pps-test",
    drIntervalMinutes: opts.dr ? 60 : 0,
    reaperIntervalMs: 15_000,
    paths: { spool: opts.dr?.spool ?? path.join(os.tmpdir(), "unused-spool") },
  } as unknown as Config;

  const objects = {
    kind: "local",
    put: async (key: string) => {
      opts.dr?.uploaded.push(key);
      return { key, size: 0 };
    },
  } as unknown as ObjectStore;

  return new Reaper(
    cfg,
    store,
    manager,
    { hostPressure: () => opts.pressure ?? -1 } as unknown as CgroupTree,
    objects,
    createLogger("silent"),
  );
}

function insertStopped(
  store: Store,
  id: string,
  opts: { stoppedAt: number; archiveAfterMinutes: number; netIndex: number },
): void {
  const row: SandboxRow = {
    id,
    image: "busybox",
    imageDigest: "sha256:dead",
    workdir: "/workspace",
    tier: "stopped",
    createdAt: opts.stoppedAt,
    lastActivityAt: opts.stoppedAt,
    stoppedAt: opts.stoppedAt,
    archiveAfterMinutes: opts.archiveAfterMinutes,
    idleTimeoutMinutes: 15,
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
    ownerKey: null,
    revision: 0,
    runtimeGeneration: 0,
    cgroupRel: null,
    hold: null,
    archiveShared: false,
  };
  store.insert(row);
}
