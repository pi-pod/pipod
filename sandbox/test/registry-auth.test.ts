import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { pino } from "pino";
import test from "node:test";
import { buildServer } from "../src/api/server.js";
import type { ObjectStore } from "../src/archive/types.js";
import { loadConfig } from "../src/config.js";
import type { Manager } from "../src/core/manager.js";
import { guaranteeCapacity } from "../src/core/resources.js";
import { OciImageStore } from "../src/images/store.js";
import { OCI_MANIFEST } from "../src/images/registry.js";

const run = promisify(execFile);

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(location)));
    else if (entry.isFile()) files.push(location);
  }
  return files;
}

test("POST /v1/images uses auth only for that pull and never logs it", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "pi-pod-registry-auth-"));
  t.after(async () => rm(temporary, { recursive: true, force: true }));

  const source = path.join(temporary, "layer-source");
  const layerFile = path.join(temporary, "layer.tar");
  await mkdir(source);
  await writeFile(path.join(source, "hello.txt"), "registry fixture\n");
  await run("tar", ["-cf", layerFile, "-C", source, "."]);
  const layer = await readFile(layerFile);
  const layerDigest = digest(layer);

  const config = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: { Env: ["PATH=/usr/bin:/bin"], Cmd: ["sh"] },
      rootfs: { type: "layers", diff_ids: [layerDigest] },
    }),
  );
  const configDigest = digest(config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: config.length },
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar",
          digest: layerDigest,
          size: layer.length,
        },
      ],
    }),
  );
  const manifestDigest = digest(manifest);

  const username = "deploy-job";
  const password = "short-lived-registry-password";
  const wrongPassword = "another-pull-password";
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const wrongAuthorization = `Basic ${Buffer.from(`${username}:${wrongPassword}`).toString("base64")}`;
  const seenAuthorization: Array<string | undefined> = [];

  const registry = createServer((req, res) => {
    const authorization = req.headers.authorization;
    seenAuthorization.push(authorization);
    if (authorization !== expectedAuthorization) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="private-registry"' });
      res.end();
      return;
    }

    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://registry.test").pathname);
    if (pathname.endsWith("/manifests/latest")) {
      res.writeHead(200, { "content-type": OCI_MANIFEST, "docker-content-digest": manifestDigest });
      res.end(manifest);
    } else if (pathname.endsWith(`/blobs/${configDigest}`)) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(config);
    } else if (pathname.endsWith(`/blobs/${layerDigest}`)) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(layer);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    registry.once("error", reject);
    registry.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => await new Promise<void>((resolve) => registry.close(() => resolve())));
  const registryPort = (registry.address() as AddressInfo).port;

  const logLines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(chunk.toString());
      callback();
    },
  });
  const log = pino({ level: "debug" }, destination);
  const stateDir = path.join(temporary, "state");
  const images = new OciImageStore({
    stateDir,
    log: (message) => log.debug({ images: message }, "image store"),
  });
  const token = "service-test-token-long-enough";
  const cfg = loadConfig({
    PI_POD_SANDBOX_TOKEN: token,
    PI_POD_SANDBOX_STATE_DIR: stateDir,
    PI_POD_SANDBOX_ARCHIVE_DRIVER: "none",
    PI_POD_SANDBOX_RESERVE_MEMORY_GB: "0",
    PI_POD_SANDBOX_RESERVE_CPU: "0",
  });
  const manager = {
    imagesRef: images,
    storeRef: { countByTier: () => ({ hot: 0, warm: 0, stopped: 0, archived: 0 }), all: () => [] },
    diskCapacity: () => ({ committedBytes: 0, capacityBytes: 64 * 1024 ** 3 }),
    guaranteesCommitted: () => ({ cpu: 0, memoryBytes: 0 }),
    capacityReport: () => ({
      contractVersion: 1,
      hostId: "test",
      bootId: "boot",
      serviceVersion: "test",
      generation: 1,
      sampledAt: new Date(0).toISOString(),
      capabilities: {},
      memory: { budgetBytes: guaranteeCapacity(cfg).memoryBytes, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0, debtBytes: 0, availableBytes: guaranteeCapacity(cfg).memoryBytes },
      cpu: { budgetCores: guaranteeCapacity(cfg).cpu, committedFloorCores: 0 },
      disk: { capacityBytes: 64 * 1024 ** 3, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0 },
      transitions: {},
      sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0, error: 0, booting: 0 },
      fairness: {},
    }),
  } as unknown as Manager;
  const objects = { kind: "none" } as ObjectStore;
  const app = await buildServer({ cfg, manager, objects, log, version: "test", runtimeName: "test" });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => app.close());

  const health = await fetch(`${baseUrl}/v1/healthz`);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as {
    hostId: string;
    host: {
      guaranteeCapacity: { cpu: number; memoryBytes: number };
      committed: { cpu: number; memoryBytes: number; diskBytes: number };
      diskCapacityBytes: number;
    };
  };
  assert.deepEqual(healthBody.host.guaranteeCapacity, guaranteeCapacity(cfg));
  assert.equal(healthBody.hostId, cfg.hostId);
  assert.deepEqual(healthBody.host.committed, { cpu: 0, memoryBytes: 0, diskBytes: 0 });
  assert.equal(healthBody.host.diskCapacityBytes, 64 * 1024 ** 3);

  const guaranteeChange = await fetch(`${baseUrl}/v1/sandboxes/any/resources`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ guarantee: { cpu: 1, memoryGB: 2 } }),
  });
  assert.equal(guaranteeChange.status, 400);
  assert.match(await guaranteeChange.text(), /guarantees are fixed at 0\.25 CPU and 512 MiB/);

  const pull = async (repository: string, auth?: { username: string; password: string }): Promise<Response> =>
    await fetch(`${baseUrl}/v1/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ref: `127.0.0.1:${registryPort}/${repository}:latest`, ...(auth ? { auth } : {}) }),
    });

  const unauthenticated = await pull("team/image");
  assert.equal(unauthenticated.status, 500);
  assert.match(await unauthenticated.text(), /registry manifest request failed.*HTTP 401/);

  const [authorized, wrong] = await Promise.all([
    pull("team/image", { username, password }),
    pull("team/other", { username, password: wrongPassword }),
  ]);
  assert.equal(authorized.status, 200, await authorized.clone().text());
  assert.equal(wrong.status, 500);
  assert.match(await wrong.text(), /registry manifest request failed.*HTTP 401/);

  const pulled = (await authorized.json()) as { ref: string };
  assert.equal(pulled.ref, `127.0.0.1:${registryPort}/team/image:latest`);
  assert.deepEqual((await images.list()).map((image) => image.ref), [pulled.ref], "internal pinned recovery aliases must not change the public image list");
  assert.equal(seenAuthorization[0], undefined);
  assert.ok(seenAuthorization.includes(expectedAuthorization), "registry did not receive the request credential");
  assert.ok(seenAuthorization.includes(wrongAuthorization), "concurrent pull did not use its own credential");

  const logs = logLines.join("");
  for (const secret of [password, wrongPassword, expectedAuthorization, wrongAuthorization]) {
    assert.equal(logs.includes(secret), false, `registry credential leaked into logs: ${secret}`);
  }
  for (const file of await filesBelow(stateDir)) {
    const bytes = await readFile(file);
    assert.equal(bytes.includes(Buffer.from(password)), false, `registry credential leaked into ${file}`);
  }
});
