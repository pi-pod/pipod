import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, openSync, ftruncateSync, closeSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { AdmissionController } from "../src/core/admission.js";
import type { SandboxRow } from "../src/db/index.js";
import { SandboxDisks } from "../src/runtime/disk.js";

const GB = 1024 ** 3;
const config = (env: Record<string, string> = {}) => loadConfig({ PI_POD_SANDBOX_TOKEN: "sparse-test-token-long", PI_POD_SANDBOX_DISK_ADMISSION: "sparse", PI_POD_SANDBOX_STORAGE_QUOTA_GB: "40", PI_POD_SANDBOX_MEMORY_ADMISSION: "floor", ...env });
const row = (id: string, tier: SandboxRow["tier"] = "stopped") => ({ id, tier, resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 20 }, ceiling: { cpu: 2, memoryGB: 4, diskGB: 20 } }) as SandboxRow;
const request = (id: string) => ({ operationId: `op-${id}`, sandboxId: id, kind: "create" as const, desiredDiskBytes: 20 * GB, desiredMemoryBytes: 0.5 * GB, desiredCpuFloor: 0.25 });
const host = { totalmem: () => 16 * GB, freemem: () => 14 * GB, cpus: () => 8, loadavg1: () => 0, cpuPressureAvg10: () => 0 };
function probe(allocations: Map<string, number>, capacityBytes = 100 * GB) {
  return { hasImage: (id: string) => allocations.has(id), probe: () => ({ capacityBytes, allocatedBytes: [...allocations.values()].reduce((a, b) => a + b, 0), allocatedById: allocations }) };
}


test("20 full-ceiling pods fit sparse/floor large-box admission; CPU fleet cap is honored", (t) => {
  const db = new Database(":memory:"); t.after(() => db.close());
  const allocations = new Map<string, number>();
  const ctrl = new AdmissionController(db, config({ PI_POD_SANDBOX_FLEET_MEMORY_GB: "12", PI_POD_SANDBOX_FLEET_CPU: "7" }), probe(allocations), { bootId: "boot", host });
  const rows: SandboxRow[] = [];
  for (let i = 0; i < 20; i++) {
    const id = `sb-${i}`;
    ctrl.reserve(request(id), rows);
    allocations.set(id, GB);
    rows.push(row(id, "hot"));
    ctrl.commit(`op-${id}`);
  }
  const cap = ctrl.capacity(rows);
  assert.equal(cap.disk.committedBytes, 20 * GB);
  assert.equal(cap.disk.availableBytes, 20 * GB);
  assert.equal(cap.memory.committedBytes, 10 * GB);
  assert.equal(cap.cpu.budgetCores, 7);
  assert.equal(rows[0]!.ceiling.diskGB, 20);
});


test("pending minimums are journaled across boot, quarantined once, and exact fit is admitted", async (t) => {
  const db = new Database(":memory:"); t.after(() => db.close());
  const cfg = config({ PI_POD_SANDBOX_STORAGE_QUOTA_GB: "1" });
  const disks = probe(new Map());
  const ctrl = new AdmissionController(db, cfg, disks, { bootId: "old", host });
  for (let i = 0; i < 4; i++) ctrl.reserve(request(`sb-${i}`), []);
  assert.equal(ctrl.capacity([]).disk.inFlightBytes, GB);
  assert.throws(() => ctrl.reserve(request("overflow"), []), /disk/);
  const resumed = new AdmissionController(db, cfg, disks, { bootId: "new", host });
  await resumed.recover(async () => "unknown", []);
  assert.equal(resumed.capacity([]).disk.quarantinedBytes, GB);
  assert.throws(() => resumed.reserve(request("overflow"), []), /disk/);
});


test("disk probe measures sparse blocks rather than file length, including untracked and legacy workspaces", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pps-sparse-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const disks = new SandboxDisks(dir, 0, true);
  mkdirSync(path.dirname(disks.layout("orphan").image), { recursive: true });
  const fd = openSync(disks.layout("orphan").image, "w");
  ftruncateSync(fd, 20 * GB); closeSync(fd);
  mkdirSync(path.join(dir, "legacy", "upper"), { recursive: true });
  writeFileSync(path.join(dir, "legacy", "upper", "file"), Buffer.alloc(1024 * 1024));
  const measured = disks.probe([]);
  assert.equal(measured.allocatedById.get("orphan"), 0);
  assert.ok(measured.allocatedById.get("legacy")! >= 1024 * 1024);
  assert.ok(measured.allocatedBytes < 2 * 1024 * 1024);
});
