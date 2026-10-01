import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ObjectStore } from "../src/archive/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { Reaper } from "../src/core/reaper.js";
import type { Manager } from "../src/core/manager.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import type { ImageStore } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
import {
  EMPTY_SNAPSHOT,
  HTTP_ROUTE_TEMPLATES,
  METRICS_PATH,
  Metrics,
  UNMATCHED_ROUTE,
  admissionResource,
  httpMethodLabel,
  httpRouteLabel,
  httpStatusLabel,
  instrumentImageStore,
  instrumentObjectStore,
  instrumentRuntime,
  isMetricsPath,
} from "../src/metrics.js";
import type { CgroupTree } from "../src/runtime/cgroup.js";
import type { Runtime } from "../src/runtime/crun.js";
import type { SandboxInfoWire } from "../src/wire.js";

describe("reaper metrics", () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "metrics-reaper-"));
    store = new Store(dir);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("counts a long-stopped archive without naming the sandbox", async () => {
    const now = Date.now();
    const row: SandboxRow = {
      id: "sb-oldsandbox00000001",
      image: "busybox",
      imageDigest: "sha256:dead",
      workdir: "/workspace",
      tier: "stopped",
      createdAt: now,
      lastActivityAt: now,
      stoppedAt: now - 2 * 60 * 60 * 1000,
      archiveAfterMinutes: 60,
      idleTimeoutMinutes: 15,
      resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 5 },
      ceiling: { cpu: 2, memoryGB: 4 },
      egress: { mode: "open" },
      netIndex: 1,
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

    const metrics = new Metrics();
    const archived: string[] = [];
    const manager = {
      isTransitioning: () => false,
      archiveIfStopped: async (id: string) => {
        archived.push(id);
        return { archived: true, outcome: "archived", sandbox: { id } as SandboxInfoWire };
      },
      archive: async () => {
        throw new Error("reaper must pack via archiveIfStopped");
      },
      stop: async () => {
        throw new Error("must not stop");
      },
      freeze: async () => undefined,
      cgroupOf: () => ({ exists: () => false, stats: () => ({ cpuUsec: 0, memoryCurrent: 0 }) }),
      expireGrants: () => 0,
      housekeeping: () => undefined,
    } as unknown as Manager;

    const cfg = {
      warmAfterMinutes: 10,
      cpuVetoMs: 200,
      pressureThreshold: 20,
      admission: { maxConcurrentArchives: 2 },
      hostId: "pps-test",
      drIntervalMinutes: 0,
      reaperIntervalMs: 15_000,
      paths: { spool: dir },
    } as unknown as Config;

    const objects = { kind: "local", put: async () => ({ key: "", size: 0 }) } as unknown as ObjectStore;
    const reaper = new Reaper(
      cfg,
      store,
      manager,
      { hostPressure: () => -1 } as unknown as CgroupTree,
      objects,
      createLogger("silent"),
      metrics,
    );
    await reaper.tick(now);
    for (let i = 0; i < 200 && reaper.archivesInFlight > 0; i++) await new Promise((r) => setTimeout(r, 5));

    assert.deepEqual(archived, ["sb-oldsandbox00000001"]);
    const text = await metrics.scrape();
    assert.match(text, /pps_reaper_ticks_total\{result="ok"\} 1/);
    assert.match(text, /pps_reaper_actions_total\{action="archive",result="ok"\} 1/);
    assert.doesNotMatch(text, /sb-oldsandbox00000001/);
  });
});
