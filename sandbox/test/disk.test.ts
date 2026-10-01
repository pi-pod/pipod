import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SandboxDisks } from "../src/runtime/disk.js";

const GB = 1024 ** 3;

test("sandbox disk layout keeps writable overlay state inside its quota image", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-pod-disks-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const disks = new SandboxDisks(root, 0);
  assert.deepEqual(disks.layout("sb-one"), {
    image: path.join(root, "sb-one", "writable.ext4"),
    mountpoint: path.join(root, "sb-one", "writable"),
    upper: path.join(root, "sb-one", "writable", "upper"),
    work: path.join(root, "sb-one", "writable", "work"),
  });
  assert.equal(disks.hasImage("sb-one"), false);
});

test("disk admission retains the configured host reserve", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-pod-disks-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const stat = fs.statfsSync(root);
  const available = stat.bavail * stat.bsize;
  const disks = new SandboxDisks(root, available - 8 * 1024 ** 2);
  const verdict = disks.admits([], 0.01);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /disk quotas exhausted/);

  const admitted = new SandboxDisks(root, Math.max(0, available - 2 * GB)).admits([], 0.01);
  assert.equal(admitted.ok, true);
});

test("capacity reports the totals admits() compares", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "disk-capacity-"));
  t.after(async () => await rm(dir, { recursive: true, force: true }));
  const disks = new SandboxDisks(dir, 0);

  const rows = [
    { id: "sb-a", tier: "hot", resources: { diskGB: 10 }, ceiling: { diskGB: 10 } },
    { id: "sb-b", tier: "stopped", resources: { diskGB: 5 }, ceiling: { diskGB: 5 } },
    { id: "sb-c", tier: "archived", resources: { diskGB: 40 }, ceiling: { diskGB: 40 } },
  ] as Parameters<SandboxDisks["capacity"]>[0];

  const capacity = disks.capacity(rows);
  assert.equal(capacity.committedBytes, 15 * 1024 ** 3);
  assert.equal(
    disks.admits(rows, 1).ok,
    capacity.committedBytes + 1024 ** 3 <= capacity.capacityBytes,
  );
});
