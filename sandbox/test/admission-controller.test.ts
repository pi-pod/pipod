import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { describe, it } from "node:test";
import { AdmissionController, type ReserveRequest } from "../src/core/admission.js";
import { loadConfig, type Config } from "../src/config.js";
import type { SandboxRow } from "../src/db/index.js";
import { ServiceError } from "../src/errors.js";

const GB = 1024 ** 3;
const TOKEN = "test-token-xyzzy-long-enough";

function makeCfg(extra: Record<string, string> = {}): Config {
  return loadConfig({ PI_POD_SANDBOX_TOKEN: TOKEN, ...extra });
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

function fakeDisks(capacityBytes: number, images: Set<string> = new Set()) {
  return {
    probe: (_ids: Iterable<string>) => ({ capacityBytes, allocatedBytes: 0 }),
    hasImage: (id: string) => images.has(id),
  };
}

function row(
  id: string,
  tier: SandboxRow["tier"],
  opts: { memoryGB?: number; cpu?: number; diskGB?: number; ceilingMemoryGB?: number } = {},
): SandboxRow {
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
    resources: { cpu: opts.cpu ?? 0.25, memoryGB: opts.memoryGB ?? 0.5, diskGB: opts.diskGB ?? 10 },
    ceiling: { cpu: 2, memoryGB: opts.ceilingMemoryGB ?? 4, diskGB: opts.diskGB ?? 10 },
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

function req(partial: Partial<ReserveRequest> & { operationId: string; sandboxId: string }): ReserveRequest {
  return {
    kind: "create",
    desiredMemoryBytes: 0,
    desiredDiskBytes: 0,
    desiredCpuFloor: 0,
    ...partial,
  };
}

function ctrl(
  db: Database.Database,
  cfg: Config,
  opts: { capacityBytes?: number; images?: Set<string>; bootId?: string } = {},
) {
  return new AdmissionController(db, cfg, fakeDisks(opts.capacityBytes ?? 1024 * GB, opts.images), {
    bootId: opts.bootId ?? "boot-test",
    host: fakeHost(),
  });
}

function refusalOf(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ServiceError, `expected ServiceError, got ${err}`);
    return err;
  }
  assert.fail("expected reserve to throw");
}

describe("AdmissionController", () => {
  it("admits an exact fit and refuses one byte over with a typed memory error", () => {
    const db = new Database(":memory:");
    const c = ctrl(db, makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "4" }));
    try {
      const ok = c.reserve(
        req({ operationId: "op-fit", sandboxId: "sb-fit", desiredMemoryBytes: 4 * GB }),
        [],
      );
      assert.equal(ok.status, "reserved");

      const err = refusalOf(() =>
        c.reserve(req({ operationId: "op-over", sandboxId: "sb-over", desiredMemoryBytes: 1 }), []),
      );
      assert.equal(err.status, 507);
      assert.equal(err.details?.kind, "admission");
      assert.equal((err.details as { reason?: string }).reason, "memory_capacity");
      const details = err.details as { required?: unknown; available?: unknown; budget?: unknown };
      assert.equal(typeof details.required, "number");
      assert.equal(typeof details.available, "number");
      assert.equal(typeof details.budget, "number");
      assert.equal(details.required, 1);
      assert.equal(details.available, 0);
      assert.equal(details.budget, 4 * GB);
      assert.equal((err.details as { retryable?: boolean }).retryable, true);
      // Typed errors render from numbers: no paths, tokens, or request bodies leak in.
      assert.ok(!err.message.includes(TOKEN));
      assert.ok(!err.message.includes("xyzzy"));
      assert.ok(!err.message.includes("/"));
      assert.ok(!(err.hint ?? "").includes(TOKEN));
    } finally {
      db.close();
    }
  });

  it("refuses a 20 GiB disk request against 19.9 GiB free and admits it at exactly 20 GiB", () => {
    const cfg = makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64" });
    const tight = new Database(":memory:");
    const roomy = new Database(":memory:");
    try {
      const cTight = ctrl(tight, cfg, { capacityBytes: 19.9 * GB });
      const err = refusalOf(() =>
        cTight.reserve(
          req({
            operationId: "op-disk",
            sandboxId: "sb-disk",
            desiredMemoryBytes: GB,
            desiredDiskBytes: 20 * GB,
          }),
          [],
        ),
      );
      assert.equal((err.details as { reason?: string }).reason, "disk_capacity");
      assert.equal(err.status, 507);

      const cRoomy = ctrl(roomy, cfg, { capacityBytes: 20 * GB });
      const ok = cRoomy.reserve(
        req({
          operationId: "op-disk",
          sandboxId: "sb-disk",
          desiredMemoryBytes: GB,
          desiredDiskBytes: 20 * GB,
        }),
        [],
      );
      assert.equal(ok.status, "reserved");
    } finally {
      tight.close();
      roomy.close();
    }
  });


  it("holds six 4 GiB creates against a 24 GiB budget without double counting the commit", () => {
    const db = new Database(":memory:");
    try {
      const c = ctrl(db, makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "24" }));
      const rows = Array.from({ length: 6 }, (_, i) => row(`sb-${i}`, "stopped"));
      for (let i = 0; i < 6; i += 1) {
        const r = c.reserve(
          req({
            operationId: `op-${i}`,
            sandboxId: `sb-${i}`,
            desiredMemoryBytes: 4 * GB,
            desiredDiskBytes: 10 * GB,
            desiredCpuFloor: 0.25,
          }),
          rows,
        );
        assert.equal(r.status, "reserved");
      }
      const err = refusalOf(() =>
        c.reserve(
          req({
            operationId: "op-6",
            sandboxId: "sb-6",
            desiredMemoryBytes: 4 * GB,
            desiredDiskBytes: 10 * GB,
            desiredCpuFloor: 0.25,
          }),
          rows,
        ),
      );
      assert.equal((err.details as { reason?: string }).reason, "memory_capacity");

      // One boots: its reservation commits and its row turns hot — charged once, not twice.
      c.commit("op-0");
      const after = rows.map((r) => (r.id === "sb-0" ? { ...r, tier: "hot" as const } : r));
      const totals = c.capacity(after);
      assert.equal(totals.memory.committedBytes, 4 * GB);
      assert.equal(totals.memory.inFlightBytes, 20 * GB);
      assert.equal(totals.memory.availableBytes, 0);
    } finally {
      db.close();
    }
  });

  it("charges a resize only for the delta above the hot commitment", () => {
    const db = new Database(":memory:");
    try {
      const c = ctrl(db, makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "8" }));
      const rows = [row("sb-resize", "hot", { memoryGB: 0.5, ceilingMemoryGB: 4 })];
      const r = c.reserve(
        req({
          operationId: "op-resize",
          sandboxId: "sb-resize",
          kind: "resize",
          desiredMemoryBytes: 8 * GB,
          desiredDiskBytes: 10 * GB,
          desiredCpuFloor: 0.25,
        }),
        rows,
      );
      assert.equal(r.status, "reserved");
      // Committed 4 GiB + 4 GiB delta in flight against the 8 GiB budget: exact fit.
      assert.equal(c.capacity(rows).memory.inFlightBytes, 4 * GB);
    } finally {
      db.close();
    }
  });

  it("charges a restore of an archived row in full and nothing for a zero import", () => {
    const db = new Database(":memory:");
    try {
      const c = ctrl(db, makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64" }));
      const rows = [row("sb-arch", "archived", { memoryGB: 0.5, ceilingMemoryGB: 4 })];
      c.reserve(
        req({
          operationId: "op-restore",
          sandboxId: "sb-arch",
          kind: "restore",
          desiredMemoryBytes: 4 * GB,
          desiredDiskBytes: 10 * GB,
          desiredCpuFloor: 0.25,
        }),
        rows,
      );
      const totals = c.capacity(rows);
      assert.equal(totals.memory.inFlightBytes, 4 * GB);
      assert.equal(totals.disk.inFlightBytes, 10 * GB);

      c.reserve(req({ operationId: "op-import", sandboxId: "sb-new", kind: "import" }), rows);
      const after = c.capacity(rows);
      assert.equal(after.memory.inFlightBytes, 4 * GB);
      assert.equal(after.disk.inFlightBytes, 10 * GB);
    } finally {
      db.close();
    }
  });

  it("counts a stopped row's disk once when a start names the same total", () => {
    const db = new Database(":memory:");
    try {
      const c = ctrl(db, makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64" }));
      const rows = [row("sb-stopped", "stopped", { diskGB: 10 })];
      assert.equal(c.capacity(rows).disk.committedBytes, 10 * GB);
      c.reserve(
        req({
          operationId: "op-start",
          sandboxId: "sb-stopped",
          kind: "start",
          desiredMemoryBytes: 4 * GB,
          desiredDiskBytes: 10 * GB,
          desiredCpuFloor: 0.25,
        }),
        rows,
      );
      const totals = c.capacity(rows);
      assert.equal(totals.disk.committedBytes, 10 * GB);
      assert.equal(totals.disk.inFlightBytes, 0);
    } finally {
      db.close();
    }
  });



  it("bounds concurrent transitions but never counts a resize", () => {
    const db = new Database(":memory:");
    try {
      const c = ctrl(
        db,
        makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64", PI_POD_SANDBOX_MAX_CONCURRENT_TRANSITIONS: "2" }),
      );
      c.reserve(req({ operationId: "op-t0", sandboxId: "sb-t0", desiredMemoryBytes: GB }), []);
      c.reserve(req({ operationId: "op-t1", sandboxId: "sb-t1", desiredMemoryBytes: GB }), []);
      const err = refusalOf(() =>
        c.reserve(req({ operationId: "op-t2", sandboxId: "sb-t2", desiredMemoryBytes: GB }), []),
      );
      assert.equal((err.details as { reason?: string }).reason, "transition_capacity");
      assert.equal((err.details as { retryAfterMs?: number }).retryAfterMs, 5000);

      // A resize holds no launch slot, so it is admitted past the transition limit.
      const resize = c.reserve(
        req({ operationId: "op-rz", sandboxId: "sb-rz", kind: "resize", desiredMemoryBytes: GB }),
        [],
      );
      assert.equal(resize.status, "reserved");
      assert.equal(c.capacity([]).transitions.inFlight, 2);
    } finally {
      db.close();
    }
  });

  it("refuses a second active reservation for the same sandbox as a conflict", () => {
    const db = new Database(":memory:");
    try {
      const c = ctrl(db, makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64" }));
      c.reserve(req({ operationId: "op-first", sandboxId: "sb-dup", desiredMemoryBytes: GB }), []);
      const err = refusalOf(() =>
        c.reserve(
          req({ operationId: "op-second", sandboxId: "sb-dup", kind: "resize", desiredMemoryBytes: GB }),
          [],
        ),
      );
      assert.equal(err.status, 409);
      assert.equal(err.code, "conflict");
    } finally {
      db.close();
    }
  });

  it("leaves the journal unchanged when the decision refuses", () => {
    const db = new Database(":memory:");
    try {
      const c = ctrl(db, makeCfg({ PI_POD_SANDBOX_MEMORY_BUDGET_GB: "4" }));
      c.reserve(req({ operationId: "op-fill", sandboxId: "sb-fill", desiredMemoryBytes: 4 * GB }), []);
      const before = c.active().map((r) => r.operationId);
      refusalOf(() =>
        c.reserve(req({ operationId: "op-nope", sandboxId: "sb-nope", desiredMemoryBytes: GB }), []),
      );
      assert.deepEqual(
        c.active().map((r) => r.operationId),
        before,
      );
      assert.equal(c.get("op-nope"), null);
    } finally {
      db.close();
    }
  });

});
