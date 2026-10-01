import assert from "node:assert/strict";
import test from "node:test";
import type { ArchiveIfStoppedResponse, SandboxInfoWire, UsageSnapshotV1 } from "../../src/wire.js";
import { RootHarness, rootTestSkipReason } from "./harness.js";

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * The production poll-suppression bug: a backend archive or stop of a sandbox read as
 * `state: "starting"` for its duration, and the control plane's fresh-transition grace then
 * suspended polling for fifteen minutes. Slow the archive upload and watch the state.
 */
test("root transition state during backend archive, stop and wake", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const harness = await RootHarness.create();
  t.after(async () => harness.cleanup());
  await harness.pullBusybox();
  const sandbox = await harness.createSandbox({ resources: { diskGB: 0.01 } });

  const info = async (): Promise<SandboxInfoWire> =>
    await responseJson<SandboxInfoWire>(await harness.request(`/v1/sandboxes/${sandbox.id}`));

  await t.test("a stop reads as started/transition=stop while in flight, then stopped", async () => {
    const originalKill = harness.runtime.kill.bind(harness.runtime);
    let observed: SandboxInfoWire | undefined;
    harness.runtime.kill = async (id, signal) => {
      observed = await info();
      return await originalKill(id, signal);
    };
    try {
      const stopped = await harness.json(`/v1/sandboxes/${sandbox.id}/stop`, "POST", {});
      assert.equal(stopped.status, 200, await stopped.clone().text());
    } finally {
      harness.runtime.kill = originalKill;
    }
    assert.ok(observed);
    assert.equal(observed.state, "started");
    assert.equal(observed.transition, "stop");
    assert.equal((await info()).state, "stopped");
    assert.equal((await info()).transition, null);
  });

  await t.test("a backend archive reads as stopped/transition=archive while uploading, then archived", async () => {
    const originalPut = harness.objects.put;
    const seen: SandboxInfoWire[] = [];
    harness.objects.put = async (key, file, options) => {
      seen.push(await info());
      const snapshot = await responseJson<UsageSnapshotV1>(await harness.request("/v1/usage"));
      const sample = snapshot.samples.find((s) => s.sandboxId === sandbox.id);
      assert.equal(sample?.state, "stopped", "usage feed must not report a boot either");
      await new Promise((resolve) => setTimeout(resolve, 300));
      return await originalPut(key, file, options);
    };
    try {
      const archived = await responseJson<ArchiveIfStoppedResponse>(
        await harness.json(`/v1/sandboxes/${sandbox.id}/archive-if-stopped`, "POST", {}),
      );
      assert.equal(archived.outcome, "archived");
    } finally {
      harness.objects.put = originalPut;
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.state, "stopped", "an archive in flight is not a boot");
    assert.equal(seen[0]!.transition, "archive");
    assert.equal(archivedState(await info()), "archived");
  });

  await t.test("a restore reads as starting/transition=start, then started, and exec works", async () => {
    const originalGet = harness.objects.get;
    let observed: SandboxInfoWire | undefined;
    harness.objects.get = async (key, dest) => {
      observed = await info();
      return await originalGet(key, dest);
    };
    try {
      const started = await harness.json(`/v1/sandboxes/${sandbox.id}/start`, "POST", {});
      assert.equal(started.status, 200, await started.clone().text());
    } finally {
      harness.objects.get = originalGet;
    }
    assert.ok(observed);
    assert.equal(observed.state, "starting");
    assert.equal(observed.transition, "start");
    const after = await info();
    assert.equal(after.state, "started");
    assert.equal(after.transition, null);
    const alive = await harness.exec(sandbox.id, { argv: ["true"] });
    assert.equal(alive.exitCode, 0);
  });
});

function archivedState(info: SandboxInfoWire): string {
  return info.state;
}
