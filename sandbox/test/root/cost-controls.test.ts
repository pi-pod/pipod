import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { Manager } from "../../src/core/manager.js";
import type {
  ArchiveIfStoppedResponse,
  CapacityReportV1,
  ErrorResponse,
  OperationStatusWire,
  SandboxInfoWire,
  TenantStatusWire,
  UsageEventsResponse,
  UsageSnapshotV1,
} from "../../src/wire.js";
import { RootHarness, rootTestSkipReason } from "./harness.js";

const GB = 1024 ** 3;

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * Privileged end-to-end coverage of the cost-control plan on a disposable host: durable
 * ceiling-first admission, archive-if-stopped with checksum verification, owner tenant
 * cgroups, create idempotency, the usage feed, and restart recovery that adopts rather
 * than kills.
 */
test("root cost controls", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  // Room for exactly two 4 GiB ceilings, whatever the host has.
  const harness = await RootHarness.create({ env: { PI_POD_SANDBOX_MEMORY_BUDGET_GB: "8" } });
  t.after(async () => harness.cleanup());
  await harness.pullBusybox();

  const create = async (body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Response> =>
    await harness.request("/v1/sandboxes", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ image: "busybox:latest", workdir: "/workspace", ...body }),
    });

  const cgroupValue = (rel: string, file: string): string =>
    fs.readFileSync(path.join("/sys/fs/cgroup", rel, file), "utf8").trim();

  await t.test("ceiling-first admission: exact fit is admitted, one more is refused with typed details", async () => {
    const a = await responseJson<SandboxInfoWire>(await create());
    const b = await responseJson<SandboxInfoWire>(await create());
    try {
      const capacity = await responseJson<CapacityReportV1>(await harness.request("/v1/capacity"));
      assert.equal(capacity.memory.committedBytes, 8 * GB);
      assert.equal(capacity.memory.availableBytes, 0);
      assert.equal(capacity.memory.inFlightBytes, 0, "steady state carries the commitment, not the journal");

      const third = await create();
      assert.equal(third.status, 507);
      const refusal = await responseJson<ErrorResponse>(third);
      assert.equal(refusal.error.code, "admission_denied");
      assert.equal(refusal.error.details?.kind, "admission");
      if (refusal.error.details?.kind === "admission") {
        assert.equal(refusal.error.details.reason, "memory_capacity");
        assert.equal(refusal.error.details.required, 4 * GB);
        assert.equal(refusal.error.details.available, 0);
        assert.equal(refusal.error.details.retryable, true);
      }
      assert.equal(harness.manager.admission.active().length, 0, "a refusal writes nothing");

      // Stopping releases memory only after the runtime confirmed exit; disk stays committed.
      const stopped = await harness.json(`/v1/sandboxes/${a.id}/stop`, "POST", {});
      assert.equal(stopped.status, 200);
      const after = await responseJson<CapacityReportV1>(await harness.request("/v1/capacity"));
      assert.equal(after.memory.committedBytes, 4 * GB);
      // Both workspaces keep their full quota committed while stopped.
      assert.equal(after.disk.committedBytes, 2 * 0.01 * GB);
    } finally {
      await harness.manager.delete(a.id);
      await harness.manager.delete(b.id);
    }
  });

  await t.test("a create burst cannot overshoot the budget: exactly the fitting number win", async () => {
    // Four simultaneous 4 GiB creates against an 8 GiB budget: the reservation transaction
    // decides in arrival order, so exactly two are admitted and two get a typed refusal
    // before any allocation. No sandbox is half-created and nothing is left charged.
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => create({ resources: { diskGB: 0.01 } })),
    );
    const winners = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 507);
    const ids: string[] = [];
    try {
      for (const w of winners) ids.push((await responseJson<SandboxInfoWire>(w)).id);
      assert.equal(winners.length, 2, `expected exactly two admissions, got ${results.map((r) => r.status).join(",")}`);
      assert.equal(refused.length, 2);
      for (const r of refused) {
        const body = await responseJson<ErrorResponse>(r);
        assert.equal(body.error.details?.kind === "admission" && body.error.details.reason, "memory_capacity");
      }
      assert.equal(harness.store.all().length, 2);
      const capacity = await responseJson<CapacityReportV1>(await harness.request("/v1/capacity"));
      assert.equal(capacity.memory.committedBytes, 8 * GB);
      assert.equal(capacity.memory.inFlightBytes, 0);
      assert.equal(capacity.memory.quarantinedBytes, 0);
    } finally {
      for (const id of ids) await harness.manager.delete(id);
    }
  });

  await t.test("concurrent creates with one idempotency key yield one sandbox", async () => {
    const key = `pod-race-${Date.now()}:create:1`;
    const results = await Promise.all(
      [0, 1, 2].map(() => create({ resources: { diskGB: 0.01 } }, { "idempotency-key": key })),
    );
    const bodies = await Promise.all(results.map((r) => responseJson<SandboxInfoWire>(r)));
    try {
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
      assert.equal(new Set(bodies.map((b) => b.id)).size, 1, "same key joins the in-flight create");
      assert.equal(harness.store.all().length, 1);
    } finally {
      await harness.manager.delete(bodies[0]!.id);
    }
  });

  await t.test("cgroup limits are read back after launch", async () => {
    const sandbox = await responseJson<SandboxInfoWire>(await create({ resources: { cpu: 1, memoryGB: 1, diskGB: 0.01 } }));
    try {
      const row = harness.store.get(sandbox.id)!;
      assert.ok(row.cgroupRel, "the launch records where the cgroup lives");
      assert.equal(cgroupValue(row.cgroupRel!, "memory.max"), String(1 * GB));
      assert.equal(cgroupValue(row.cgroupRel!, "cpu.max"), "100000 100000");
    } finally {
      await harness.manager.delete(sandbox.id);
    }
  });

  await t.test("owned sandboxes run under an equal-weight tenant parent that is cleaned up", async () => {
    const one = await responseJson<SandboxInfoWire>(await create({ owner: { userKey: "user_alpha" }, resources: { diskGB: 0.01 } }));
    const two = await responseJson<SandboxInfoWire>(await create({ owner: { userKey: "user_beta" }, resources: { diskGB: 0.01 } }));
    try {
      assert.deepEqual(one.owner, { userKey: "user_alpha" });
      const rowOne = harness.store.get(one.id)!;
      assert.equal(rowOne.cgroupRel, `/${harness.cgroupScope}/tenant-user_alpha/${one.id}`);
      assert.equal(cgroupValue(`${harness.cgroupScope}/tenant-user_alpha`, "cpu.weight"), "100");
      assert.equal(cgroupValue(`${harness.cgroupScope}/tenant-user_beta`, "cpu.weight"), "100");
      assert.equal(cgroupValue(rowOne.cgroupRel!, "cpu.max"), "200000 100000", "per-sandbox 2 vCPU cap is kept");

      // Labels cannot move a sandbox between tenants.
      await harness.json(`/v1/sandboxes/${one.id}/labels`, "PUT", { labels: { "pi-pod-server/user": "user_beta" } });
      assert.deepEqual(harness.manager.info(one.id)!.owner, { userKey: "user_alpha" });

      // A grant caps the parent and is visible in tenant status.
      const grant = await harness.json("/v1/tenants/user_alpha/cpu-grant", "PUT", { revision: 1, cpuCores: 1.5, ttlMs: 60_000 });
      assert.equal(grant.status, 200, await grant.clone().text());
      assert.equal((await responseJson<{ applied: boolean }>(grant)).applied, true);
      assert.equal(cgroupValue(`${harness.cgroupScope}/tenant-user_alpha`, "cpu.max"), "150000 100000");
      const status = await responseJson<TenantStatusWire>(await harness.request("/v1/tenants/user_alpha"));
      assert.equal(status.effectiveCpuCores, 1.5);
      assert.deepEqual(status.liveSandboxIds, [one.id]);

      // The host is now grant-managed: a tenant without a grant is gated on new launches.
      const gated = await create({ owner: { userKey: "user_gamma" }, resources: { diskGB: 0.01 } });
      assert.equal(gated.status, 507);
      const gatedBody = await responseJson<ErrorResponse>(gated);
      assert.equal(gatedBody.error.details?.kind === "admission" && gatedBody.error.details.reason, "fairness_degraded");
      const capacity = await responseJson<CapacityReportV1>(await harness.request("/v1/capacity"));
      assert.equal(capacity.fairness.managed, true);
      assert.equal(capacity.fairness.mode, "degraded", "user_beta runs on the fallback");
    } finally {
      await harness.manager.delete(one.id);
      await harness.manager.delete(two.id);
    }
    assert.equal(fs.existsSync(path.join("/sys/fs/cgroup", harness.cgroupScope, "tenant-user_alpha")), false);
    assert.equal(fs.existsSync(path.join("/sys/fs/cgroup", harness.cgroupScope, "tenant-user_beta")), false);
  });

  await t.test("archive-if-stopped verifies the checksum, honours revision guards and never stops a running sandbox", async () => {
    const sandbox = await responseJson<SandboxInfoWire>(await create({ resources: { diskGB: 0.01 } }));
    try {
      const running = await responseJson<ArchiveIfStoppedResponse>(
        await harness.json(`/v1/sandboxes/${sandbox.id}/archive-if-stopped`, "POST", {}),
      );
      assert.deepEqual([running.archived, running.outcome, running.sandbox.state], [false, "not_stopped", "started"]);

      const stopped = await responseJson<SandboxInfoWire>(await harness.json(`/v1/sandboxes/${sandbox.id}/stop`, "POST", {}));
      const stale = await responseJson<ArchiveIfStoppedResponse>(
        await harness.json(`/v1/sandboxes/${sandbox.id}/archive-if-stopped`, "POST", { expectedRevision: stopped.revision + 1 }),
      );
      assert.equal(stale.outcome, "revision_mismatch");
      assert.equal(fs.existsSync(path.join(harness.cfg.paths.sandboxes, sandbox.id, "writable.ext4")), true);

      const archived = await responseJson<ArchiveIfStoppedResponse>(
        await harness.json(`/v1/sandboxes/${sandbox.id}/archive-if-stopped`, "POST", {
          expectedRevision: stopped.revision,
          expectedStoppedAt: stopped.stoppedAt,
        }),
      );
      assert.equal(archived.outcome, "archived");
      assert.equal(archived.sandbox.state, "archived");
      const row = harness.store.get(sandbox.id)!;
      const stored = await harness.objects.head(row.archiveKey!);
      assert.equal(stored?.sha256, row.archiveSha256, "the object store vouches for the checksum that was packed");
      assert.equal(fs.existsSync(path.join(harness.cfg.paths.sandboxes, sandbox.id, "writable.ext4")), false);
      const capacity = await responseJson<CapacityReportV1>(await harness.request("/v1/capacity"));
      assert.equal(capacity.disk.quarantinedBytes, 0);

      const again = await responseJson<ArchiveIfStoppedResponse>(
        await harness.json(`/v1/sandboxes/${sandbox.id}/archive-if-stopped`, "POST", {}),
      );
      assert.equal(again.outcome, "already_archived");
    } finally {
      await harness.manager.delete(sandbox.id);
    }
  });

  await t.test("create idempotency returns one sandbox for one key", async () => {
    const key = `pod-${Date.now()}:create:1`;
    const first = await create({ resources: { diskGB: 0.01 } }, { "idempotency-key": key });
    assert.equal(first.status, 200, await first.clone().text());
    const created = await responseJson<SandboxInfoWire>(first);
    try {
      const second = await create({ resources: { diskGB: 0.01 } }, { "idempotency-key": key });
      assert.equal(second.status, 200);
      assert.equal((await responseJson<SandboxInfoWire>(second)).id, created.id);
      assert.equal(harness.store.all().length, 1);

      const status = await responseJson<OperationStatusWire>(await harness.request(`/v1/operations/${key}`));
      assert.equal(status.status, "succeeded");
      assert.equal(status.sandboxId, created.id);
      assert.equal(status.crossHostRetrySafe, false);

      const conflict = await create({ resources: { diskGB: 0.02 } }, { "idempotency-key": key });
      assert.equal(conflict.status, 409);
      assert.equal((await responseJson<ErrorResponse>(conflict)).error.code, "idempotency_conflict");

      // Cleanup by key deletes the sandbox the key produced.
      const cancelled = await responseJson<OperationStatusWire>(
        await harness.request(`/v1/operations/${key}`, { method: "DELETE" }),
      );
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.resolution, "cleaned");
      assert.equal(harness.manager.info(created.id), null);
    } finally {
      await harness.manager.delete(created.id);
    }
  });

  // The tenant test above made this host grant-managed, so every later owned launch needs a
  // current grant first (that is the gate working, not a test artefact).
  const grant = async (userKey: string): Promise<void> => {
    const response = await harness.json(`/v1/tenants/${userKey}/cpu-grant`, "PUT", { revision: 1, cpuCores: 2, ttlMs: 600_000 });
    assert.equal(response.status, 200, await response.clone().text());
  };

  await t.test("usage feed carries live counters, generations and terminal events", async () => {
    await grant("user_usage");
    const created = await create({ owner: { userKey: "user_usage" }, resources: { diskGB: 0.01 } });
    assert.equal(created.status, 200, await created.clone().text());
    const sandbox = await responseJson<SandboxInfoWire>(created);
    try {
      const burn = await harness.exec(sandbox.id, { argv: ["sh", "-c", "i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done"] });
      assert.equal(burn.exitCode, 0);
      const snapshot = await responseJson<UsageSnapshotV1>(await harness.request("/v1/usage"));
      const sample = snapshot.samples.find((s) => s.sandboxId === sandbox.id);
      assert.ok(sample);
      assert.equal(sample.live, true);
      assert.equal(sample.ownerKey, "user_usage");
      assert.equal(sample.runtimeGeneration, 1);
      assert.ok(sample.cpuUsec > 0);
      assert.ok(sample.memoryCurrentBytes > 0);
      assert.ok(sample.diskAllocatedBytes > 0);
      assert.equal(sample.diskCommittedBytes, 0.01 * GB);

      await harness.json(`/v1/sandboxes/${sandbox.id}/stop`, "POST", {});
      const events = await responseJson<UsageEventsResponse>(await harness.request("/v1/usage/events?after=0&limit=100"));
      const terminal = events.events.find((e) => e.sandboxId === sandbox.id && e.kind === "terminal");
      assert.ok(terminal?.counters);
      assert.ok(terminal.counters.cpuUsec > 0);
      const stoppedEvent = events.events.find((e) => e.sandboxId === sandbox.id && e.kind === "stopped");
      assert.ok(stoppedEvent?.durationMs !== undefined);
      assert.ok(events.events.every((e) => !JSON.stringify(e).includes("PATH=")));
    } finally {
      await harness.manager.delete(sandbox.id);
    }
  });

  await t.test("a second service over the same state adopts running sandboxes and their reservations", async () => {
    await grant("user_restart");
    const created = await create({ owner: { userKey: "user_restart" }, resources: { diskGB: 0.01 } });
    assert.equal(created.status, 200, await created.clone().text());
    const sandbox = await responseJson<SandboxInfoWire>(created);
    let second: Manager | undefined;
    try {
      // Simulate a crash between launch and the hot tier write: rewind the row and leave the
      // create reservation open, as the journal would look after a kill at that instant.
      const row = harness.store.get(sandbox.id)!;
      harness.store.database
        .prepare("UPDATE sandboxes SET tier = 'stopped' WHERE id = ?")
        .run(sandbox.id);
      harness.manager.admission.reserve(
        { operationId: "create:pod-restart:create:1", sandboxId: sandbox.id, kind: "create", desiredMemoryBytes: 4 * GB, desiredDiskBytes: 0.01 * GB, desiredCpuFloor: 0.25 },
        harness.store.all(),
      );
      harness.store.database
        .prepare("UPDATE admission_reservations SET boot_id = 'previous-boot' WHERE operation_id = ?")
        .run("create:pod-restart:create:1");

      second = new Manager(
        harness.cfg,
        harness.store,
        harness.images,
        harness.runtime,
        harness.network,
        harness.cgroups,
        harness.objects,
        harness.log,
        undefined,
        { bootId: "boot-2" },
      );
      await second.init();
      const adopted = second.info(sandbox.id)!;
      assert.equal(adopted.state, "started", "the running process was adopted, not killed");
      assert.equal(adopted.runtimeGeneration, row.runtimeGeneration);
      const reservation = second.admission.get("create:pod-restart:create:1");
      assert.equal(reservation?.status, "committed");
      const alive = await harness.exec(sandbox.id, { argv: ["true"] });
      assert.equal(alive.exitCode, 0);
    } finally {
      await (second ?? harness.manager).delete(sandbox.id);
    }
  });
});
