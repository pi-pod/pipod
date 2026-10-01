import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { ErrorResponse, HealthResponse, SandboxInfoWire } from "../../src/wire.js";
import { RootHarness, rootTestSkipReason } from "./harness.js";

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * Two services sharing one archive store, which is what a fleet of hosts is. The sandbox is
 * archived on one host and adopted by the other under the same id, so the workspace has to
 * survive a move between hosts that never talk to each other.
 */
test("root cross-host sandbox import", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const hostA = await RootHarness.create({ env: { PI_POD_SANDBOX_HOST_ID: "host-a" } });
  t.after(async () => hostA.cleanup());
  const sharedArchives = path.join(hostA.stateDir, "archives");
  fs.mkdirSync(sharedArchives, { recursive: true });

  const hostB = await RootHarness.create({ env: { PI_POD_SANDBOX_HOST_ID: "host-b" } });
  t.after(async () => hostB.cleanup());
  fs.symlinkSync(sharedArchives, path.join(hostB.stateDir, "archives"));

  await hostA.pullBusybox();
  await hostB.pullBusybox();

  const created = await hostA.createSandbox({ workdir: "/workspace" });
  const marker = `moved-${created.id}`;
  const write = await hostA.exec(created.id, {
    argv: ["/bin/sh", "-c", `echo ${marker} > /workspace/marker`],
  });
  assert.equal(write.exitCode, 0, write.stderr.toString("utf8"));

  await t.test("healthz reports the host identity and its commitments", async () => {
    const health = await responseJson<HealthResponse>(await hostA.request("/v1/healthz", {}, null));
    assert.equal(health.hostId, "host-a");
    assert.equal(health.sandboxes.hot, 1);
    // The running sandbox holds the fixed CPU floor and, under ceiling-first admission, its
    // whole memory ceiling; its sparse quota is committed on disk.
    assert.equal(health.host.committed.cpu, 0.25);
    assert.equal(health.host.committed.memoryBytes, 4 * 1024 ** 3);
    assert.equal(health.capacity?.contractVersion, 1);
    assert.equal(health.capacity?.memory.committedBytes, 4 * 1024 ** 3);
    assert.ok(health.host.committed.diskBytes > 0);
    assert.ok(health.host.diskCapacityBytes > 0);

    const idle = await responseJson<HealthResponse>(await hostB.request("/v1/healthz", {}, null));
    assert.equal(idle.hostId, "host-b");
    assert.deepEqual(idle.host.committed, { cpu: 0, memoryBytes: 0, diskBytes: 0 });
  });

  const archived = await hostA.json(`/v1/sandboxes/${created.id}/archive`, "POST", {});
  assert.equal(archived.status, 200, await archived.clone().text());
  assert.equal((await responseJson<SandboxInfoWire>(archived)).state, "archived");

  await t.test("the workspace is adopted by the other host and restores there", async () => {
    const imported = await hostB.json("/v1/sandboxes/import", "POST", {
      id: created.id,
      image: "busybox:latest",
      workdir: "/workspace",
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    assert.equal((await responseJson<SandboxInfoWire>(imported)).state, "archived");

    const started = await hostB.json(`/v1/sandboxes/${created.id}/start`, "POST", {});
    assert.equal(started.status, 200, await started.clone().text());
    assert.equal((await responseJson<SandboxInfoWire>(started)).state, "started");

    const read = await hostB.exec(created.id, { argv: ["/bin/cat", "/workspace/marker"] });
    assert.equal(read.exitCode, 0, read.stderr.toString("utf8"));
    assert.equal(read.stdout.toString("utf8").trim(), marker);
  });

  await t.test("an import never shadows or invents a sandbox", async () => {
    const duplicate = await hostB.json("/v1/sandboxes/import", "POST", {
      id: created.id,
      image: "busybox:latest",
      workdir: "/workspace",
    });
    assert.equal(duplicate.status, 409);
    assert.match((await responseJson<ErrorResponse>(duplicate)).error.message, /already exists/);

    const traversal = await hostB.json("/v1/sandboxes/import", "POST", {
      id: "../../etc",
      image: "busybox:latest",
      workdir: "/workspace",
    });
    assert.equal(traversal.status, 400);

    const unknown = await hostB.json("/v1/sandboxes/import", "POST", {
      id: "sb-0123456789abcdef0123",
      image: "busybox:latest",
      workdir: "/workspace",
    });
    assert.equal(unknown.status, 404);
    assert.match((await responseJson<ErrorResponse>(unknown)).error.message, /no archived workspace/);
  });
});
