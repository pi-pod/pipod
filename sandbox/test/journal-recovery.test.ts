import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  AdmissionController,
  type AdmissionOptions,
  type RuntimeProbe,
} from "../src/core/admission.js";
import { loadConfig, type Config } from "../src/config.js";
import type { SandboxRow } from "../src/db/index.js";

const GB = 1024 ** 3;

function makeCfg(extra: Record<string, string> = {}): Config {
  return loadConfig({ PI_POD_SANDBOX_TOKEN: "journal-test-token-long-enough", ...extra });
}

function fakeHost() {
  return {
    totalmem: () => 64 * GB,
    freemem: () => 32 * GB,
    cpus: () => 8,
    loadavg1: () => 0.1,
    cpuPressureAvg10: () => -1,
  };
}

function fakeDisks(capacityBytes: number = 1024 * GB) {
  return {
    probe: (_ids: Iterable<string>) => ({ capacityBytes, allocatedBytes: 0 }),
    hasImage: (_id: string) => false,
  };
}

function opts(over: Partial<AdmissionOptions> = {}): AdmissionOptions {
  return { bootId: "boot-new", host: fakeHost(), ...over };
}

function row(id: string, tier: SandboxRow["tier"]): SandboxRow {
  return {
    id,
    image: "ghcr.io/pi-pod/pi-pod-base:test",
    imageDigest: "sha256:feed",
    workdir: "/workspace",
    tier,
    createdAt: 0,
    lastActivityAt: 0,
    stoppedAt: null,
    archiveAfterMinutes: 60,
    idleTimeoutMinutes: 10,
    resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 10 },
    ceiling: { cpu: 2, memoryGB: 4, diskGB: 10 },
    egress: { mode: "allowlist", hosts: [] },
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
  } as SandboxRow;
}

/** Reserve from an earlier boot: its rows are recovery candidates for the new boot. */
function seedOldBoot(
  db: Database.Database,
  cfg: Config,
  opIds: string[],
  nowValue = 1000,
): void {
  const old = new AdmissionController(db, cfg, fakeDisks(), {
    bootId: "boot-old",
    host: fakeHost(),
    now: () => nowValue,
  });
  for (const op of opIds) {
    old.reserve(
      {
        operationId: op,
        sandboxId: op.replace(/^op-/, "sb-"),
        kind: "create",
        desiredMemoryBytes: GB,
        desiredDiskBytes: GB,
        desiredCpuFloor: 0.25,
      },
      [],
    );
  }
}

describe("admission journal recovery", () => {
  it("resolves earlier-boot rows by probe: live commits, gone releases, unknown/throw quarantines charged", async () => {
    const db = new Database(":memory:");
    try {
      const cfg = makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64" });
      seedOldBoot(db, cfg, ["op-live", "op-gone", "op-unknown", "op-throws"]);

      const c = new AdmissionController(db, cfg, fakeDisks(), opts());
      const probe: RuntimeProbe = async (reservation) => {
        if (reservation.operationId === "op-live") return "live";
        if (reservation.operationId === "op-gone") return "gone";
        if (reservation.operationId === "op-throws") throw new Error("probe blew up");
        return "unknown";
      };
      const summary = await c.recover(probe, [row("sb-live", "hot")]);

      assert.deepEqual(summary.committed, ["op-live"]);
      assert.deepEqual(summary.released, ["op-gone"]);
      assert.deepEqual(summary.quarantined.sort(), ["op-throws", "op-unknown"]);
      assert.equal(c.get("op-live")?.status, "committed");
      assert.equal(c.get("op-gone")?.status, "released");
      assert.equal(c.get("op-unknown")?.status, "quarantined");
      assert.equal(c.get("op-throws")?.status, "quarantined");

      // Quarantined rows stay charged: two 1 GiB desires with no covering rows.
      const totals = c.capacity([]);
      assert.equal(totals.memory.quarantinedBytes, 2 * GB);
      assert.equal(totals.transitions.quarantinedOperations, 2);
      assert.equal(totals.transitions.pendingOperations, 0);
    } finally {
      db.close();
    }
  });

  it("leaves current-boot reservations untouched", async () => {
    const db = new Database(":memory:");
    try {
      const cfg = makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64" });
      seedOldBoot(db, cfg, ["op-old"]);
      const c = new AdmissionController(db, cfg, fakeDisks(), opts());
      c.reserve(
        {
          operationId: "op-current",
          sandboxId: "sb-current",
          kind: "create",
          desiredMemoryBytes: GB,
          desiredDiskBytes: GB,
          desiredCpuFloor: 0.25,
        },
        [],
      );

      // Even a probe that reports everything gone must not touch this boot's rows.
      const summary = await c.recover(async () => "gone", []);
      assert.deepEqual(summary.released, ["op-old"]);
      assert.equal(c.get("op-current")?.status, "reserved");
      assert.equal(c.capacity([]).memory.inFlightBytes, GB);
    } finally {
      db.close();
    }
  });

  it("never releases an old-but-live reservation merely because time passed", async () => {
    const db = new Database(":memory:");
    try {
      const cfg = makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64" });
      seedOldBoot(db, cfg, ["op-ancient"], 1000);
      const c = new AdmissionController(db, cfg, fakeDisks(), opts({ now: () => 10_000_000_000 }));
      const summary = await c.recover(async () => "live", []);
      assert.deepEqual(summary.committed, ["op-ancient"]);
      assert.deepEqual(summary.released, []);
      assert.equal(c.get("op-ancient")?.status, "committed");
    } finally {
      db.close();
    }
  });

  it("purges only terminal rows older than the cutoff", () => {
    const db = new Database(":memory:");
    try {
      const cfg = makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64" });
      let nowValue = 1000;
      const c = new AdmissionController(db, cfg, fakeDisks(), opts({ now: () => nowValue }));
      for (const [op, sb] of [
        ["op-old-committed", "sb-old-committed"],
        ["op-old-released", "sb-old-released"],
        ["op-old-active", "sb-old-active"],
      ] as const) {
        c.reserve(
          { operationId: op, sandboxId: sb, kind: "create", desiredMemoryBytes: 0, desiredDiskBytes: 0, desiredCpuFloor: 0 },
          [],
        );
      }
      c.commit("op-old-committed");
      c.release("op-old-released");

      // A recent terminal row must survive the same purge.
      nowValue = 1_000_000;
      c.reserve(
        { operationId: "op-new", sandboxId: "sb-new", kind: "import", desiredMemoryBytes: 0, desiredDiskBytes: 0, desiredCpuFloor: 0 },
        [],
      );
      c.commit("op-new");

      assert.equal(c.purgeJournal(5000), 2);
      assert.equal(c.get("op-old-committed"), null);
      assert.equal(c.get("op-old-released"), null);
      assert.equal(c.get("op-old-active")?.status, "reserved");
      assert.equal(c.get("op-new")?.status, "committed");
      assert.equal(c.purgeJournal(5000), 0);
    } finally {
      db.close();
    }
  });

  it("persists the reservation across controller instances on the same SQLite file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admission-journal-"));
    try {
      const file = path.join(dir, "sandbox.sqlite");
      const cfg = makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64" });
      const first = new Database(file);
      try {
        const c1 = new AdmissionController(first, cfg, fakeDisks(), opts({ bootId: "boot-one" }));
        c1.reserve(
          {
            operationId: "op-persist",
            sandboxId: "sb-persist",
            kind: "create",
            desiredMemoryBytes: 2 * GB,
            desiredDiskBytes: GB,
            desiredCpuFloor: 0.25,
          },
          [],
        );
        assert.equal(c1.active().length, 1);
      } finally {
        first.close();
      }

      const second = new Database(file);
      try {
        const c2 = new AdmissionController(second, cfg, fakeDisks(), opts({ bootId: "boot-two" }));
        const found = c2.get("op-persist");
        assert.ok(found);
        assert.equal(found.status, "reserved");
        assert.equal(found.desiredMemoryBytes, 2 * GB);
        assert.equal(found.bootId, "boot-one");
        assert.equal(c2.activeFor("sb-persist").length, 1);
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
