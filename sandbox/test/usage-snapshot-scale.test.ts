import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createObjectStore } from "../src/archive/objectstore.js";
import type { ObjectStore } from "../src/archive/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { Manager } from "../src/core/manager.js";
import { ephemeralHostSecret } from "../src/core/secrets.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
import { Metrics } from "../src/metrics.js";
import { CgroupTree } from "../src/runtime/cgroup.js";
import type { Runtime } from "../src/runtime/crun.js";
import type { Network } from "../src/runtime/netns.js";
import type { UsageSampleWire } from "../src/wire.js";

/**
 * Scale fixture for §8.1.1: 5,000 provably-archived rows plus live/error rows.
 * The archived rows have store metadata (archiveKey/sha/size) but no local image,
 * exactly the state a successful archive leaves behind.
 */
const ARCHIVED = 5000;
const LIVE_HOT = 10;
const LIVE_STOPPED = 10;
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
    ownerKey: "user_scale",
    revision: 0,
    runtimeGeneration: 0,
    cgroupRel: null,
    hold: null,
    archiveShared: false,
    ...partial,
  };
}

const archivedId = (i: number): string => `sb-a-${String(i).padStart(6, "0")}`;

function drain(service: Manager, limit: number): UsageSampleWire[] {
  const out: UsageSampleWire[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = service.usageSnapshot({ cursor, limit });
    out.push(...page.samples);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
}

describe("usage snapshot at archived scale (§8.1.1)", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;
  let objects: ObjectStore;
  let cgroups: CgroupTree;
  let metrics: Metrics;
  let statPaths: string[];
  let nowMs: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "usage-snapshot-scale-"));
    store = new Store(path.join(dir, "db"));
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "usage-snapshot-scale-token-long",
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
      PI_POD_SANDBOX_HOST_ID: "host-scale",
      // Non-default cap proves the knob is genuinely parsed end to end.
      PI_POD_SANDBOX_USAGE_MAX_ROWS: "20000",
    });
    fs.mkdirSync(cfg.paths.sandboxes, { recursive: true });
    objects = createObjectStore(cfg.archive);
    cgroups = new CgroupTree("pps", path.join(dir, "cgroup"));
    metrics = new Metrics();
    statPaths = [];
    nowMs = Date.now();

    let netIndex = 1;
    for (let i = 0; i < ARCHIVED; i += 1) {
      store.insert(
        row({
          id: archivedId(i),
          tier: "archived",
          netIndex: netIndex++,
          archiveKey: `archives/${archivedId(i)}.tar.zst`,
          archiveSha256: "0".repeat(64),
          archiveSize: 424242 + i,
        }),
      );
    }
    for (let i = 0; i < LIVE_HOT; i += 1) {
      store.insert(row({ id: `sb-live-hot-${String(i).padStart(4, "0")}`, tier: "hot", netIndex: netIndex++ }));
    }
    for (let i = 0; i < LIVE_STOPPED; i += 1) {
      store.insert(row({ id: `sb-live-stopped-${String(i).padStart(4, "0")}`, tier: "stopped", netIndex: netIndex++ }));
    }
    store.insert(
      row({ id: "sb-err-000001", tier: "error", netIndex: netIndex++, error: "boom", stoppedAt: nowMs }),
    );
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const service = (): Manager =>
    new Manager(
      cfg,
      store,
      images(dir),
      {} as Runtime,
      {} as Network,
      cgroups,
      objects,
      createLogger("silent"),
      metrics,
      {
        bootId: "boot-scale",
        secret: ephemeralHostSecret(),
        serviceVersion: "test",
        now: () => nowMs,
        statSync: (p: string): fs.Stats => {
          statPaths.push(p);
          return fs.statSync(p);
        },
      },
    );

  const statId = (p: string): string => path.basename(path.dirname(p));
  const archivedStats = (): string[] => statPaths.filter((p) => statId(p).startsWith("sb-a-"));

  /** Count existence checks behind `disks.hasImage` (fs.existsSync per call). */
  const countHasImage = (svc: Manager): { calls: () => number } => {
    const disks = (svc as unknown as { disks: { hasImage: (id: string) => boolean } }).disks;
    const orig = disks.hasImage.bind(disks);
    let n = 0;
    disks.hasImage = (id: string): boolean => {
      n += 1;
      return orig(id);
    };
    return { calls: () => n };
  };

  const benchEnv = (): string => {
    const load = os.loadavg().map((v) => v.toFixed(2)).join("/");
    const memGb = (os.totalmem() / 1024 ** 3).toFixed(1);
    return `node=${process.version} ${os.platform()}-${os.arch()} cpus=${os.cpus().length} load=${load} mem=${memGb}GB`;
  };

  const summarize = (xs: number[]): string => {
    const sorted = [...xs].sort((a, b) => a - b);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    return `n=${xs.length} min=${sorted[0]!.toFixed(1)}ms p50=${pick(0.5).toFixed(1)}ms max=${sorted[sorted.length - 1]!.toFixed(1)}ms mean=${mean.toFixed(1)}ms`;
  };

  it("first poll emits one heartbeat per archived row with zero stats for them, within budget", () => {
    const svc = service();
    const hasImage = countHasImage(svc);
    const started = process.hrtime.bigint();
    const samples = drain(svc, 20000);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`usage snapshot full drain (${samples.length} samples): ${ms.toFixed(1)} ms [${benchEnv()}]`);
    // Hard semantic bounds for the first drain, before the repeat loop clears statPaths.
    const firstArchivedStats = archivedStats();
    const firstStatCount = statPaths.length;
    const firstHasImageCalls = hasImage.calls();
    assert.equal(samples.filter((s) => s.cadence === "heartbeat").length, ARCHIVED);
    assert.deepEqual(firstArchivedStats, []);
    assert.equal(firstStatCount, LIVE_HOT + LIVE_STOPPED + 1);
    // One existence proof per archived row on first sighting; live/error rows
    // never touch hasImage (short-circuit), so exactly ARCHIVED calls.
    assert.equal(firstHasImageCalls, ARCHIVED);
    // Repeat distribution on fresh boots (each re-emits heartbeats): proves flat
    // poll latency without turning shared-CI noise into a hard <50ms failure.
    // The design target is <50ms on the pinned image; CI asserts a generous
    // regression bound only. Semantic bounds (counts, zero stats) are the hard asserts.
    const repeats: number[] = [ms];
    for (let i = 0; i < 5; i += 1) {
      statPaths.length = 0;
      const cold = service();
      const t0 = process.hrtime.bigint();
      const out = drain(cold, 20000);
      repeats.push(Number(process.hrtime.bigint() - t0) / 1e6);
      assert.equal(out.filter((s) => s.cadence === "heartbeat").length, ARCHIVED);
      assert.deepEqual(archivedStats(), []);
      assert.equal(statPaths.length, LIVE_HOT + LIVE_STOPPED + 1);
    }
    console.log(`usage snapshot cold-drain distribution: ${summarize(repeats)} [${benchEnv()}]`);
    assert.ok(
      repeats.every((v) => v < 1000),
      `cold drain regression: ${summarize(repeats)} (bound 1000 ms; design target <50 ms)`,
    );

    const heartbeats = samples.filter((s) => s.cadence === "heartbeat");
    assert.equal(heartbeats.length, ARCHIVED);
    // (statSync bounds already asserted above on firstStatCount/firstArchivedStats;
    // statPaths now reflects the last repeat drain, which carries the same shape.)

    const first = heartbeats[0]!;
    assert.equal(first.tier, "archived");
    assert.equal(first.state, "archived");
    assert.equal(first.live, false);
    assert.equal(first.cpuValid, false);
    assert.equal(first.diskCommittedBytes, 0);
    assert.equal(first.diskAllocatedBytes, 0);
    assert.equal(first.archiveSizeBytes, 424242);
    assert.equal(first.cpuUsec, 0);
    assert.equal(first.memoryCurrentBytes, 0);
    assert.equal(first.memoryPressureAvg10, -1);
    assert.equal(first.pidsCurrent, 0);

    const full = samples.filter((s) => s.cadence !== "heartbeat");
    assert.equal(full.length, LIVE_HOT + LIVE_STOPPED + 1);
    assert.ok(full.every((s) => s.cadence === "full"));
    const err = samples.find((s) => s.sandboxId === "sb-err-000001")!;
    assert.equal(err.cadence, "full");
    assert.equal(err.tier, "error");
    assert.equal(err.state, "error");
  });

  it("second poll the same day emits zero heartbeat rows; live and error rows stay full cadence", () => {
    const svc = service();
    const hasImage = countHasImage(svc);
    drain(svc, 20000);
    const firstCalls = hasImage.calls();
    assert.equal(firstCalls, ARCHIVED);
    statPaths.length = 0;

    const t0 = process.hrtime.bigint();
    const samples = drain(svc, 20000);
    const steadyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`usage snapshot steady-state drain (${samples.length} samples): ${steadyMs.toFixed(1)} ms [${benchEnv()}]`);
    // Steady state performs zero existence checks: the dedup cache short-circuits
    // before hasImage, so archived rows cost no filesystem calls at all.
    assert.equal(samples.filter((s) => s.cadence === "heartbeat").length, 0);
    assert.equal(samples.length, LIVE_HOT + LIVE_STOPPED + 1);
    assert.ok(samples.some((s) => s.sandboxId === "sb-err-000001" && s.cadence === "full"));
    assert.ok(samples.filter((s) => s.sandboxId.startsWith("sb-live-")).every((s) => s.cadence === "full"));
    // Full-cadence rows still stat every poll; archived rows cost nothing now.
    assert.deepEqual(archivedStats(), []);
    assert.equal(statPaths.length, LIVE_HOT + LIVE_STOPPED + 1);
    assert.equal(hasImage.calls(), firstCalls);
  });

  it("an archiveSize change resamples exactly that row; day rollover resamples all", () => {
    const svc = service();
    drain(svc, 20000);
    assert.equal(drain(svc, 20000).filter((s) => s.cadence === "heartbeat").length, 0);

    const target = archivedId(123);
    const before = store.get(target)!;
    store.setArchive(target, {
      key: before.archiveKey!,
      sha256: before.archiveSha256!,
      size: (before.archiveSize ?? 0) + 1,
    });
    const changed = drain(svc, 20000);
    const heartbeats = changed.filter((s) => s.cadence === "heartbeat");
    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0]!.sandboxId, target);
    assert.equal(heartbeats[0]!.archiveSizeBytes, (before.archiveSize ?? 0) + 1);

    nowMs += 26 * 3_600_000; // next UTC day
    const rolled = drain(svc, 20000);
    assert.equal(rolled.filter((s) => s.cadence === "heartbeat").length, ARCHIVED);
  });

  it("an archived row that still has a local image stays full cadence", () => {
    const svc = service();
    const leaked = archivedId(7);
    const image = path.join(cfg.paths.sandboxes, leaked, "writable.ext4");
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(image, "x".repeat(4096));
    statPaths.length = 0;

    const samples = drain(svc, 20000);
    const row = samples.find((s) => s.sandboxId === leaked)!;
    assert.equal(row.cadence, "full");
    assert.equal(row.tier, "archived");
    assert.equal(row.diskCommittedBytes, 0.05 * GB);
    assert.ok(row.diskAllocatedBytes > 0);
    assert.ok(
      statPaths.some((p) => statId(p) === leaked),
      "leaked archived images take the full path, including its stat",
    );
    // One ambiguous row fewer collapses; the rest still heartbeat.
    assert.equal(
      samples.filter((s) => s.cadence === "heartbeat").length,
      ARCHIVED - 1,
    );
    // A leaked row is never deduped as a heartbeat: it reappears every poll,
    // while the genuine heartbeats — all delivered above — stay quiet.
    const again = drain(svc, 20000);
    assert.ok(again.some((s) => s.sandboxId === leaked && s.cadence === "full"));
    assert.equal(again.filter((s) => s.cadence === "heartbeat").length, 0);
  });

  it("records snapshot cadence metrics over the assembly, not the page", async () => {
    const svc = service();
    const snapshotLines = (text: string): string =>
      text.split("\n").filter((l) => l.startsWith("pps_usage_snapshot")).join("\n");
    // One limited page out of a 5021-row poll: the gauge must report what the poll
    // assembled (5000 heartbeats + 20 live + 1 error), not what the page delivered
    // (200 heartbeats) — counting the page would corrupt the gauge on every poll.
    const first = svc.usageSnapshot({ cursor: null, limit: 200 });
    assert.equal(first.samples.length, 200);
    let text = await metrics.scrape();
    assert.ok(
      text.includes(`pps_usage_snapshot_rows{class="heartbeat"} ${ARCHIVED}`),
      snapshotLines(text),
    );
    assert.ok(text.includes(`pps_usage_snapshot_rows{class="live"} ${LIVE_HOT + LIVE_STOPPED}`));
    assert.ok(text.includes('pps_usage_snapshot_rows{class="error"} 1'));
    assert.ok(text.includes("pps_usage_snapshot_duration_seconds_count 1"));
    // Draining the rest of the poll, then polling again, owes no heartbeats;
    // the gauge follows the latest assembly.
    const rest = drain(svc, 20000);
    assert.equal(
      rest.filter((s) => s.cadence === "heartbeat").length,
      ARCHIVED - 200,
    );
    assert.equal(drain(svc, 20000).filter((s) => s.cadence === "heartbeat").length, 0);
    text = await metrics.scrape();
    assert.ok(text.includes('pps_usage_snapshot_rows{class="heartbeat"} 0'), snapshotLines(text));
    assert.ok(text.includes("pps_usage_snapshot_duration_seconds_count 3"));
  });

  it("snapshot gauges hold the poll assembly steady across a paginated drain", async () => {
    const svc = service();
    const snapshotLines = (text: string): string =>
      text.split("\n").filter((l) => l.startsWith("pps_usage_snapshot")).join("\n");
    const assertAssembly = async (): Promise<void> => {
      const text = await metrics.scrape();
      assert.ok(
        text.includes(`pps_usage_snapshot_rows{class="heartbeat"} ${ARCHIVED}`),
        snapshotLines(text),
      );
      assert.ok(text.includes(`pps_usage_snapshot_rows{class="live"} ${LIVE_HOT + LIVE_STOPPED}`));
      assert.ok(text.includes('pps_usage_snapshot_rows{class="error"} 1'));
    };
    // 5021 rows at 2000 per page: three pages, one poll. Follow-up pages
    // assemble only the unmarked remainder, but the gauges must keep reporting
    // the poll's full assembly — not decay toward zero as pages deliver.
    let cursor: string | null = null;
    const ids: string[] = [];
    for (;;) {
      const page = svc.usageSnapshot({ cursor, limit: 2000 });
      ids.push(...page.samples.map((s) => s.sandboxId));
      await assertAssembly();
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.equal(ids.length, ARCHIVED + LIVE_HOT + LIVE_STOPPED + 1);
    assert.equal(new Set(ids).size, ids.length);
    await assertAssembly();
    // The next poll owes no heartbeats; its first page resets the gauge.
    const quiet = svc.usageSnapshot({ cursor: null, limit: 2000 });
    assert.equal(quiet.samples.filter((s) => s.cadence === "heartbeat").length, 0);
    const text = await metrics.scrape();
    assert.ok(text.includes('pps_usage_snapshot_rows{class="heartbeat"} 0'), snapshotLines(text));
  });

  it("parses the payload cap and pages stably so each row appears once per poll", () => {
    assert.equal(cfg.usage.maxSnapshotRows, 20000);
    assert.equal(
      loadConfig({
        PI_POD_SANDBOX_TOKEN: "usage-snapshot-scale-token-long",
        PI_POD_SANDBOX_STATE_DIR: dir,
      }).usage.maxSnapshotRows,
      1000,
    );
    const svc = service();
    // Ask far above the cap: the page is clamped and the cursor continues the poll.
    const page = svc.usageSnapshot({ cursor: null, limit: 1_000_000 });
    assert.ok(page.samples.length <= 20000);
    assert.equal(page.limit, 20000);

    // Fresh boot re-emits heartbeats: drain in small pages and require each row once, in order.
    const samples = drain(service(), 2000);
    assert.equal(samples.length, ARCHIVED + LIVE_HOT + LIVE_STOPPED + 1);
    const ids = samples.map((s) => s.sandboxId);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual([...ids].sort(), ids);
  });
});
