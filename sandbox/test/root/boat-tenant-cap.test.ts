import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { CapacityReportV1, ErrorResponse, SandboxInfoWire } from "../../src/wire.js";
import { RootHarness, rootTestSkipReason } from "./harness.js";

const GB = 1024 ** 3;

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * Privileged end-to-end coverage of the boat tenant aggregate cap on a disposable host:
 * the kernel bounds every tenant parent at the configured aggregate, admission refuses
 * past it with backpressure instead of OOM, and unowned flat sandboxes still launch.
 */
test("root boat tenant aggregate cap", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const harness = await RootHarness.create({
    env: {
      PI_POD_SANDBOX_HOST_BACKEND: "boat",
      PI_POD_SANDBOX_HOST_ID: "boat-roottester",
      PI_POD_SANDBOX_TENANT_MEMORY_GB: "1",
    },
  });
  t.after(async () => harness.cleanup());
  await harness.pullBusybox();

  const create = async (body: Record<string, unknown> = {}): Promise<Response> =>
    await harness.request("/v1/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: "busybox:latest", workdir: "/workspace", ...body }),
    });

  const cgroupValue = (rel: string, file: string): string =>
    fs.readFileSync(path.join("/sys/fs/cgroup", rel, file), "utf8").trim();

  await t.test("capacity advertises the tenant aggregate caps", async () => {
    const capacity = await responseJson<CapacityReportV1>(await harness.request("/v1/capacity"));
    assert.deepEqual(capacity.capabilities.tenantLimits, {
      memoryMaxBytes: 1 * GB,
      // Harness reserve is 0, so the unmanaged boat default derives to the full host CPU count.
      cpuMaxCores: Math.max(0.5, os.cpus().length),
    });
    // The 1 GiB tenant cap binds tighter than the 64 GiB harness budget.
    assert.equal(capacity.memory.budgetBytes, 1 * GB);
  });

  await t.test("owned launches land under a kernel-bounded tenant parent and execute", async () => {
    const expectedCpuMax = `${Math.max(0.5, os.cpus().length) * 100_000} 100000`;
    const first = await responseJson<SandboxInfoWire>(
      await create({ owner: { userKey: "boatcap-tester" }, resources: { memoryGB: 0.5, diskGB: 0.01 } }),
    );
    const second = await responseJson<SandboxInfoWire>(
      await create({ owner: { userKey: "boatcap-tester" }, resources: { memoryGB: 0.5, diskGB: 0.01 } }),
    );
    try {
      const tenantRel = `${harness.cgroupScope}/tenant-boatcap-tester`;
      // No headroom above the cap: anything past it is global-OOM territory on a boat host.
      assert.equal(cgroupValue(tenantRel, "memory.max"), String(1 * GB));
      assert.equal(cgroupValue(tenantRel, "memory.high"), String(1 * GB));
      assert.equal(cgroupValue(tenantRel, "cpu.max"), expectedCpuMax);
      for (const sb of [first, second]) {
        const row = harness.store.get(sb.id)!;
        assert.ok(row.cgroupRel!.includes("tenant-boatcap-tester"), "owned pod nests under its tenant parent");
      }
      const exec = await harness.exec(first.id, { argv: ["echo", "tenant-cap-ok"] });
      assert.equal(exec.exitCode, 0);

      // Two 0.5 GiB ceilings exactly fill the 1 GiB tenant: a third is backpressure, not OOM.
      const third = await create({ owner: { userKey: "boatcap-tester" }, resources: { memoryGB: 0.5, diskGB: 0.01 } });
      assert.equal(third.status, 507);
      const refusal = await responseJson<ErrorResponse>(third);
      assert.equal(refusal.error.details?.kind === "admission" && refusal.error.details.reason, "memory_capacity");
    } finally {
      await harness.manager.delete(first.id);
      await harness.manager.delete(second.id);
    }
  });

  await t.test("unowned flat launches are unchanged (no privilege regression)", async () => {
    const flat = await responseJson<SandboxInfoWire>(await create({ resources: { memoryGB: 0.5, diskGB: 0.01 } }));
    try {
      const row = harness.store.get(flat.id)!;
      assert.ok(!row.cgroupRel!.includes("tenant-"), "unowned pod stays on the legacy flat layout");
    } finally {
      await harness.manager.delete(flat.id);
    }
  });
});
