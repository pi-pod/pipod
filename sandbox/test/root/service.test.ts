import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { deriveActivityToken } from "../../src/api/server.js";
import { guaranteeCapacity, limitsFor, resolveCeiling, resolveGuarantee } from "../../src/core/resources.js";
import type { CreateSandboxRequest, ErrorResponse, ListResponse, SandboxInfoWire } from "../../src/wire.js";
import { RootHarness, rootTestSkipReason } from "./harness.js";

const execFileAsync = promisify(execFile);
const GB = 1024 ** 3;

async function responseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function filesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(location);
      else if (entry.isFile()) files.push(location);
    }
  };
  visit(root);
  return files;
}

test("root service integration", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const harness = await RootHarness.create();
  t.after(async () => harness.cleanup());
  await harness.pullBusybox();

  const create = async (overrides: Partial<CreateSandboxRequest> = {}): Promise<SandboxInfoWire> => {
    const response = await harness.json("/v1/sandboxes", "POST", {
      image: "busybox:latest",
      workdir: "/workspace",
      ...overrides,
    });
    assert.equal(response.status, 200, await response.clone().text());
    return await responseJson<SandboxInfoWire>(response);
  };

  const deleteSandbox = async (id: string): Promise<void> => {
    const response = await harness.request(`/v1/sandboxes/${id}`, { method: "DELETE" });
    assert.equal(response.status, 200, await response.clone().text());
  };

  await t.test("auth", async () => {
    const missing = await harness.request("/v1/authz", {}, null);
    assert.equal(missing.status, 401);
    assert.equal((await responseJson<ErrorResponse>(missing)).error.code, "unauthorized");

    const wrong = await harness.request("/v1/authz", {}, "definitely-the-wrong-token");
    assert.equal(wrong.status, 401);
    assert.equal((await responseJson<ErrorResponse>(wrong)).error.code, "unauthorized");

    const health = await harness.request("/v1/healthz", {}, null);
    assert.equal(health.status, 200);
    const healthBody = await responseJson<{
      ok: boolean;
      host: { guaranteeCapacity: { cpu: number; memoryBytes: number } };
    }>(health);
    assert.equal(healthBody.ok, true);
    // Legacy field now carries the admission budget: the configured memory budget (a policy
    // number, see harness) and the CPU floor budget after the host reserve.
    assert.deepEqual(healthBody.host.guaranteeCapacity, {
      cpu: guaranteeCapacity(harness.cfg).cpu,
      memoryBytes: harness.cfg.admission.memoryBudgetBytes,
    });

    // A derived activity token authenticates exactly one route for exactly one sandbox.
    const scoped = deriveActivityToken(harness.token, "sb-none");
    const ownActivity = await harness.request("/v1/sandboxes/sb-none/activity", { method: "POST" }, scoped);
    assert.equal(ownActivity.status, 404);
    assert.equal((await responseJson<ErrorResponse>(ownActivity)).error.code, "not_found");

    const crossActivity = await harness.request("/v1/sandboxes/sb-other/activity", { method: "POST" }, scoped);
    assert.equal(crossActivity.status, 401);

    const escalated = await harness.request("/v1/sandboxes", {}, scoped);
    assert.equal(escalated.status, 401);
  });

  await t.test("failed create rolls back every allocated resource", async () => {
    const originalStart = harness.runtime.start.bind(harness.runtime);
    let failedId: string | undefined;
    harness.runtime.start = async (id) => {
      failedId = id;
      throw new Error("simulated runtime launch failure");
    };

    try {
      const failed = await harness.json("/v1/sandboxes", "POST", {
        image: "busybox:latest",
        workdir: "/workspace",
      });
      assert.equal(failed.status, 500);
      assert.match(
        (await responseJson<ErrorResponse>(failed)).error.message,
        /sandbox creation failed: simulated runtime launch failure/,
      );
    } finally {
      harness.runtime.start = originalStart;
    }

    assert.ok(failedId);
    assert.deepEqual(harness.store.all(), []);
    assert.equal(fs.existsSync(path.join(harness.cfg.paths.sandboxes, failedId)), false);

    const replacement = await create();
    try {
      assert.equal(harness.store.get(replacement.id)?.netIndex, 0, "rolled-back network index was not reused");
    } finally {
      await deleteSandbox(replacement.id);
    }
  });

  await t.test("create and exec streaming", async () => {
    const sandbox = await create();
    try {
      assert.equal(sandbox.state, "started");
      const normal = await harness.exec(sandbox.id, {
        argv: ["sh", "-c", "echo hi; pwd; id -u"],
      });
      assert.equal(normal.error, undefined);
      assert.equal(normal.exitCode, 0);
      assert.equal(normal.stderr.toString("utf8"), "");
      assert.deepEqual(normal.stdout.toString("utf8").trimEnd().split("\n"), ["hi", "/workspace", "0"]);
      assert.ok(normal.streamTags.length > 0);
      assert.ok(normal.streamTags.every((tag) => tag === 1), `unexpected stream tags: ${normal.streamTags}`);

      const failure = await harness.exec(sandbox.id, {
        argv: ["sh", "-c", "echo bad >&2; exit 7"],
      });
      assert.equal(failure.error, undefined);
      assert.equal(failure.exitCode, 7);
      assert.equal(failure.stdout.toString("utf8"), "");
      assert.equal(failure.stderr.toString("utf8"), "bad\n");
      assert.ok(failure.streamTags.length > 0);
      assert.ok(failure.streamTags.every((tag) => tag === 2), `unexpected stream tags: ${failure.streamTags}`);
    } finally {
      await deleteSandbox(sandbox.id);
    }
  });

  await t.test("env is memory-only", async () => {
    const canary = `env-canary-${randomBytes(24).toString("hex")}`;
    const sandbox = await create({ env: { CANARY: canary }, labels: { purpose: "env-test" } });
    try {
      const visible = await harness.exec(sandbox.id, { argv: ["sh", "-c", "printf %s \"$CANARY\""] });
      assert.equal(visible.exitCode, 0);
      assert.equal(visible.stdout.toString("utf8"), canary);

      const needle = Buffer.from(canary);
      assert.equal(fs.readFileSync(harness.store.file).includes(needle), false, "canary leaked into SQLite");
      for (const file of filesBelow(harness.stateDir)) {
        assert.equal(fs.readFileSync(file).includes(needle), false, `canary leaked into ${file}`);
      }

      const response = await harness.request(`/v1/sandboxes/${sandbox.id}`);
      assert.equal(response.status, 200);
      const info = await responseJson<SandboxInfoWire>(response);
      assert.equal(JSON.stringify(info.labels).includes(canary), false, "canary leaked into API labels");
    } finally {
      await deleteSandbox(sandbox.id);
    }
  });

  await t.test("file round trip", async () => {
    const sandbox = await create();
    try {
      const data = randomBytes(64 * 1024 + 317);
      const fileUrl = `/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent("/workspace/random.bin")}&mode=600`;
      const uploaded = await harness.request(fileUrl, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: data,
      });
      assert.equal(uploaded.status, 204, await uploaded.clone().text());

      const downloaded = await harness.request(`/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent("/workspace/random.bin")}`);
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), data);

      const mode = await harness.exec(sandbox.id, { argv: ["stat", "-c", "%a", "/workspace/random.bin"] });
      assert.equal(mode.exitCode, 0);
      assert.equal(mode.stdout.toString("utf8").trim(), "600");

      const missing = await harness.request(`/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent("/workspace/missing")}`);
      assert.equal(missing.status, 404);
      assert.equal((await responseJson<ErrorResponse>(missing)).error.code, "not_found");

      const directory = await harness.request(`/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent("/workspace")}`);
      assert.equal(directory.status, 404);
      assert.equal((await responseJson<ErrorResponse>(directory)).error.code, "not_found");

      const emptyPath = `/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent("/workspace/empty")}&mode=600`;
      const emptyUpload = await harness.request(emptyPath, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": "0" },
        body: new Uint8Array(0),
      });
      assert.equal(emptyUpload.status, 204, await emptyUpload.clone().text());
      const empty = await harness.request(`/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent("/workspace/empty")}`);
      assert.equal(empty.status, 200);
      assert.equal((await empty.arrayBuffer()).byteLength, 0);
    } finally {
      await deleteSandbox(sandbox.id);
    }
  });

  await t.test("pty reattach", async () => {
    const sandbox = await create();
    try {
      const opened = await harness.pty(sandbox.id);
      opened.sendControl({ type: "open", argv: ["/bin/sh", "-i"], cols: 80, rows: 24 });
      await opened.waitFor(
        (channel) => channel.controls.some((frame) => frame.type === "ready") && channel.output.toString("utf8").includes("# "),
        "PTY ready frame and shell prompt",
      );
      const ready = opened.controls.find((frame) => frame.type === "ready");
      assert.ok(ready?.type === "ready");
      assert.equal(ready.reattached, false);
      opened.sendRaw("PPS_REATTACH_VALUE=survived\nprintf '__SET__\\n'\n");
      await opened.waitFor((channel) => channel.output.toString("utf8").includes("__SET__"), "shell variable assignment");
      await opened.close();

      const attached = await harness.pty(sandbox.id);
      attached.sendControl({ type: "attach", sessionId: ready.sessionId, cols: 90, rows: 30 });
      await attached.waitFor(
        (channel) => channel.controls.some((frame) => frame.type === "ready" && frame.reattached),
        "PTY reattach",
      );
      attached.sendRaw("printf '__VAR__%s__END__\\n' \"$PPS_REATTACH_VALUE\"\n");
      await attached.waitFor(
        (channel) => channel.output.toString("utf8").includes("__VAR__survived__END__"),
        "reattached shell variable",
      );
      attached.sendRaw("exit\n");
      await attached.waitFor((channel) => channel.controls.some((frame) => frame.type === "exit"), "PTY exit");
      await attached.close();

      const missing = await harness.pty(sandbox.id);
      missing.sendControl({ type: "attach", sessionId: randomUUID(), cols: 80, rows: 24 });
      await missing.waitFor(
        (channel) => channel.controls.some((frame) => frame.type === "error"),
        "missing-session error",
      );
      const error = missing.controls.find((frame) => frame.type === "error");
      assert.ok(error?.type === "error");
      assert.equal(error.code, "no_such_session");
      await missing.close();
    } finally {
      await deleteSandbox(sandbox.id);
    }
  });

  await t.test("stop and start", async () => {
    const sandbox = await create({ env: { OLD_VALUE: "before-stop" } });
    try {
      const upload = await harness.request(`/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent("/workspace/persistent")}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from("still-here"),
      });
      assert.equal(upload.status, 204, await upload.clone().text());

      const stopped = await harness.json(`/v1/sandboxes/${sandbox.id}/stop`, "POST", {});
      assert.equal(stopped.status, 200, await stopped.clone().text());
      assert.equal((await responseJson<SandboxInfoWire>(stopped)).state, "stopped");

      const rejected = await harness.exec(sandbox.id, { argv: ["true"] });
      assert.equal(rejected.error?.code, "conflict");

      const started = await harness.json(`/v1/sandboxes/${sandbox.id}/start`, "POST", {
        env: { REHYDRATED_VALUE: "after-start" },
      });
      assert.equal(started.status, 200, await started.clone().text());
      assert.equal((await responseJson<SandboxInfoWire>(started)).state, "started");

      const file = await harness.request(`/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent("/workspace/persistent")}`);
      assert.equal(file.status, 200);
      assert.equal(Buffer.from(await file.arrayBuffer()).toString("utf8"), "still-here");
      const env = await harness.exec(sandbox.id, { argv: ["sh", "-c", "printf %s \"$REHYDRATED_VALUE\""] });
      assert.equal(env.exitCode, 0);
      assert.equal(env.stdout.toString("utf8"), "after-start");
    } finally {
      await deleteSandbox(sandbox.id);
    }
  });

  await t.test("archive and restore", async () => {
    const sandbox = await create();
    try {
      const contents = randomBytes(8192);
      const filePath = "/workspace/archive.bin";
      const uploaded = await harness.request(`/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent(filePath)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: contents,
      });
      assert.equal(uploaded.status, 204, await uploaded.clone().text());

      const archived = await harness.json(`/v1/sandboxes/${sandbox.id}/archive`, "POST", {});
      assert.equal(archived.status, 200, await archived.clone().text());
      const archivedInfo = await responseJson<SandboxInfoWire>(archived);
      assert.equal(archivedInfo.state, "archived");
      assert.equal(archivedInfo.tier, "archived");
      const diskImage = path.join(harness.cfg.paths.sandboxes, sandbox.id, "writable.ext4");
      assert.equal(fs.existsSync(diskImage), false);

      const started = await harness.json(`/v1/sandboxes/${sandbox.id}/start`, "POST", {});
      assert.equal(started.status, 200, await started.clone().text());
      assert.equal((await responseJson<SandboxInfoWire>(started)).state, "started");
      assert.equal(fs.existsSync(diskImage), true);
      const restored = await harness.request(`/v1/sandboxes/${sandbox.id}/files?path=${encodeURIComponent(filePath)}`);
      assert.equal(restored.status, 200);
      assert.deepEqual(Buffer.from(await restored.arrayBuffer()), contents);
    } finally {
      await deleteSandbox(sandbox.id);
    }
  });

  await t.test("resources", async () => {
    const sandbox = await create({ resources: { diskGB: 0.01 } });
    try {
      const rejected = await harness.json(`/v1/sandboxes/${sandbox.id}/resources`, "POST", {
        guarantee: { cpu: 1, memoryGB: 2 },
      });
      assert.equal(rejected.status, 400);
      assert.match((await responseJson<ErrorResponse>(rejected)).error.message, /guarantees are fixed/);

      // A live memory shrink is refused (a running process may already exceed it); growth
      // and CPU/disk changes apply online.
      const shrink = await harness.json(`/v1/sandboxes/${sandbox.id}/resources`, "POST", { ceiling: { memoryGB: 3 } });
      assert.equal(shrink.status, 409, await shrink.clone().text());
      assert.equal((await responseJson<ErrorResponse>(shrink)).error.code, "conflict");

      const ceiling = { cpu: 1.5, memoryGB: 4, diskGB: 0.02 };
      const response = await harness.json(`/v1/sandboxes/${sandbox.id}/resources`, "POST", { ceiling });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await responseJson(response), {
        guarantee: resolveGuarantee(harness.cfg, sandbox.resources),
        ceiling,
      });

      const expected = limitsFor(resolveGuarantee(harness.cfg), resolveCeiling(harness.cfg, ceiling), harness.cfg.maxPids);
      const cgroup = path.join("/sys/fs/cgroup", harness.cgroupScope, sandbox.id);
      const value = (name: string): string => fs.readFileSync(path.join(cgroup, name), "utf8").trim();
      assert.equal(value("cpu.weight"), String(expected.cpuWeight));
      assert.equal(value("cpu.max"), `${Math.round(ceiling.cpu * 100_000)} 100000`);
      assert.equal(value("memory.low"), String(expected.memoryLow));
      assert.equal(value("memory.high"), String(expected.memoryHigh));
      assert.equal(value("memory.max"), String(expected.memoryMax));

      const image = path.join(harness.cfg.paths.sandboxes, sandbox.id, "writable.ext4");
      assert.equal(fs.statSync(image).size, Math.floor(ceiling.diskGB * GB));
      const diskShrink = await harness.json(`/v1/sandboxes/${sandbox.id}/resources`, "POST", {
        ceiling: { diskGB: 0.015 },
      });
      assert.equal(diskShrink.status, 409, await diskShrink.clone().text());
    } finally {
      await deleteSandbox(sandbox.id);
    }
  });

  await t.test("disk quota returns ENOSPC without harming the sandbox", async () => {
    const sandbox = await create({ resources: { cpu: 0.05, memoryGB: 0.01, diskGB: 0.01 } });
    try {
      const fill = await harness.exec(sandbox.id, {
        argv: ["sh", "-c", "dd if=/dev/zero of=/workspace/fill bs=1M count=32"],
      });
      assert.notEqual(fill.exitCode, 0);
      assert.match(fill.stderr.toString("utf8"), /No space left on device/);

      const bindBypass = await harness.exec(sandbox.id, {
        argv: ["sh", "-c", "printf bypass >/etc/hosts"],
      });
      assert.notEqual(bindBypass.exitCode, 0);
      assert.match(bindBypass.stderr.toString("utf8"), /[Rr]ead-only file system/);

      const recovered = await harness.exec(sandbox.id, {
        argv: ["sh", "-c", "rm -f /workspace/fill && printf still-running"],
      });
      assert.equal(recovered.exitCode, 0);
      assert.equal(recovered.stdout.toString("utf8"), "still-running");
    } finally {
      await deleteSandbox(sandbox.id);
    }
  });

  await t.test("resource requests cannot change the floor, and an oversized shape is refused, not clamped", async () => {
    const oversized = await harness.json("/v1/sandboxes", "POST", {
      image: "busybox:latest",
      workdir: "/workspace",
      resources: { memoryGB: os.totalmem() / GB + 1024, cpu: os.cpus().length + 1024, diskGB: 0.01 },
    });
    assert.equal(oversized.status, 400, await oversized.clone().text());
    const refusal = await responseJson<ErrorResponse>(oversized);
    assert.equal(refusal.error.code, "unsupported_shape");
    assert.equal(refusal.error.details?.kind, "admission");

    const sandbox = await create({ resources: { cpu: 1, memoryGB: 1, diskGB: 0.01 } });
    try {
      assert.deepEqual(sandbox.resources, { cpu: 0.25, memoryGB: 0.5, diskGB: 0.01 });
      assert.deepEqual(sandbox.ceiling, { cpu: 1, memoryGB: 1, diskGB: 0.01 });
      assert.equal(sandbox.owner, null);
      assert.equal(sandbox.runtimeGeneration, 1);
    } finally {
      await deleteSandbox(sandbox.id);
    }
  });

  await t.test("labels", async () => {
    const matching = await create({ labels: { a: "1", original: "kept" } });
    const partial = await create({ labels: { a: "1", b: "wrong" } });
    try {
      const merged = await harness.json(`/v1/sandboxes/${matching.id}/labels`, "PUT", { labels: { b: "2" } });
      assert.equal(merged.status, 200, await merged.clone().text());
      assert.deepEqual((await responseJson<SandboxInfoWire>(merged)).labels, { a: "1", original: "kept", b: "2" });

      const both = await harness.request("/v1/sandboxes?label.a=1&label.b=2");
      assert.equal(both.status, 200);
      assert.deepEqual((await responseJson<ListResponse>(both)).sandboxes.map((item) => item.id), [matching.id]);

      const one = await harness.request("/v1/sandboxes?label.a=1");
      assert.equal(one.status, 200);
      assert.deepEqual(new Set((await responseJson<ListResponse>(one)).sandboxes.map((item) => item.id)), new Set([matching.id, partial.id]));
    } finally {
      await deleteSandbox(matching.id);
      await deleteSandbox(partial.id);
    }
  });

  await t.test("delete leaves no leftovers", async () => {
    const sandbox = await create();
    const response = await harness.request(`/v1/sandboxes/${sandbox.id}`, { method: "DELETE" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(harness.manager.info(sandbox.id), null);
    assert.equal(fs.existsSync(path.join(harness.cfg.paths.sandboxes, sandbox.id)), false);
    assert.equal(fs.existsSync(`/var/run/netns/pps-${sandbox.id}`), false);
    assert.equal(fs.existsSync(path.join("/sys/fs/cgroup", harness.cgroupScope, sandbox.id)), false);
    const runtimeExists = await execFileAsync("crun", ["state", sandbox.id]).then(
      () => true,
      () => false,
    );
    assert.equal(runtimeExists, false);
  });
});
