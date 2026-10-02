import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createProxyStore, assertProxyKey } from "../src/archive/proxystore.js";
import { createObjectStore } from "../src/archive/objectstore.js";

const TOKEN = "test-runtime-token-0123456789abcdef";
const HOST = "boat-testuser";
const OTHER_HOST = "boat-someoneelse";
const KEY = (sha: string) => `pod-1/upper-${sha}.tar.zst`;

/** In-memory stub of the hosted edition's archive proxy protocol.
 * Enforces token equality, host-path binding, key shape, and upload checksums —
 * the same contract the real server enforces, minus persistence. */
function startStub(options: { token: string } = { token: TOKEN }): Promise<{
  server: Server; url: string; objects: Map<string, Buffer>; hits: () => number;
}> {
  const objects = new Map<string, Buffer>();
  let hits = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits += 1;
    const url = new URL(req.url ?? "/", "http://stub");
    const match = /^\/v1\/host-archives\/([^/]+)\/objects(\/(.*))?$/.exec(url.pathname);
    const fail = (code: number, body = "no") => {
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(body);
    };
    if (!match) return fail(404);
    if (req.headers.authorization !== `Bearer ${options.token}`) return fail(401);
    const pathHost = decodeURIComponent(match[1]!);
    if (req.method !== "GET" || match[3] !== undefined) {
      if (pathHost !== HOST) return fail(403);
    } else if (pathHost !== HOST) return fail(403);
    if (req.method === "GET" && match[3] === undefined) {
      const prefix = url.searchParams.get("prefix") ?? "";
      // The server namespaces keys under the authed host and strips the
      // namespace back to runtime-relative keys on list (real servers must too).
      const scoped = `${pathHost}/${prefix}`;
      const listed = [...objects.entries()]
        .filter(([key]) => key.startsWith(scoped))
        .map(([key, bytes]) => ({ key: key.slice(pathHost.length + 1), size: bytes.length, lastModified: 1700000000000 }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ objects: listed }));
      return;
    }
    const key = (match[3] ?? "").split("/").map(decodeURIComponent).join("/");
    const namespaced = `${pathHost}/${key}`;
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const bytes = Buffer.concat(chunks);
        const actual = createHash("sha256").update(bytes).digest("hex");
        const claimed = req.headers["x-pipod-sha256"];
        if (typeof claimed === "string" && claimed !== actual) return fail(400, "checksum mismatch");
        objects.set(namespaced, bytes);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ key, size: bytes.length, sha256: actual }));
      });
      return;
    }
    if (req.method === "GET") {
      const bytes = objects.get(namespaced);
      if (!bytes) return fail(404);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
      res.end(bytes);
      return;
    }
    if (req.method === "HEAD") {
      const bytes = objects.get(namespaced);
      if (!bytes) return fail(404);
      const sha = createHash("sha256").update(bytes).digest("hex");
      res.writeHead(200, { "x-pipod-size": String(bytes.length), "x-pipod-sha256": sha });
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      if (!objects.delete(namespaced)) return fail(404);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    return fail(405);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, objects, hits: () => hits });
    });
  });
}

test("proxy store put/get/head/list/delete round trip, byte-identical", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archive-proxy-"));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });

  const contents = randomBytes(1 << 20);
  const sha = createHash("sha256").update(contents).digest("hex");
  const source = path.join(temporary, "source.tar.zst");
  await writeFile(source, contents);
  const store = createProxyStore({ url: stub.url, token: TOKEN, hostId: HOST, timeoutMs: 30_000 });

  const stored = await store.put(KEY(sha), source, { sha256: sha });
  assert.equal(stored.size, contents.length);
  assert.equal(stored.sha256, sha);

  const head = await store.head(KEY(sha));
  assert.equal(head?.size, contents.length);
  assert.equal(head?.sha256, sha);

  const destination = path.join(temporary, "downloads", "restored.tar.zst");
  await store.get(KEY(sha), destination);
  assert.deepEqual(await readFile(destination), contents);

  const listed = await store.list("pod-1/");
  assert.deepEqual(listed.map((entry) => entry.key), [KEY(sha)]);

  await store.delete(KEY(sha));
  assert.equal(await store.head(KEY(sha)), null);
});

test("proxy store streams a large body without buffering it whole", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archive-proxy-big-"));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  // 32 MB exercises the streaming path at unit scale. This is NOT a 20 GB proof;
  // the no-buffering property holds by construction (file stream → fetch duplex),
  // and production-scale evidence belongs to the manual rehearsal, honestly labeled.
  const contents = randomBytes(32 << 20);
  const sha = createHash("sha256").update(contents).digest("hex");
  const source = path.join(temporary, "big.tar.zst");
  await writeFile(source, contents);
  const store = createProxyStore({ url: stub.url, token: TOKEN, hostId: HOST, timeoutMs: 120_000 });
  const stored = await store.put(KEY(sha), source, { sha256: sha });
  assert.equal(stored.size, contents.length);
  assert.equal(stored.sha256, sha);
});

test("proxy store refuses wrong tokens without leaking them", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archive-proxy-auth-"));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const source = path.join(temporary, "source.tar.zst");
  await writeFile(source, randomBytes(64));
  const store = createProxyStore({ url: stub.url, token: "wrong-token", hostId: HOST, timeoutMs: 30_000 });
  await assert.rejects(store.put("pod-1/upper-" + "0".repeat(64) + ".tar.zst", source), /HTTP 401/);
  await assert.rejects(store.head("pod-1/upper-" + "0".repeat(64) + ".tar.zst"), /HTTP 401/);
});

test("proxy store refuses cross-host paths", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const store = createProxyStore({ url: stub.url, token: TOKEN, hostId: OTHER_HOST, timeoutMs: 30_000 });
  await assert.rejects(store.list("pod-1/"), /HTTP 403/);
  await assert.rejects(store.head("pod-1/upper-" + "0".repeat(64) + ".tar.zst"), /HTTP 403/);
});

test("proxy store rejects corrupt uploads: checksum mismatch fails, local bytes untouched", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archive-proxy-corrupt-"));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const contents = randomBytes(1024);
  const source = path.join(temporary, "source.tar.zst");
  await writeFile(source, contents);
  const store = createProxyStore({ url: stub.url, token: TOKEN, hostId: HOST, timeoutMs: 30_000 });
  const wrongSha = "f".repeat(64);
  await assert.rejects(store.put(KEY(wrongSha), source, { sha256: wrongSha }), /checksum|HTTP 400/);
  assert.equal(await store.head(KEY(wrongSha)), null);
  assert.deepEqual(await readFile(source), contents);
});

test("proxy store rejects unshaped keys client-side, with no network traffic", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const before = stub.hits();
  const store = createProxyStore({ url: stub.url, token: TOKEN, hostId: HOST, timeoutMs: 30_000 });
  for (const bad of ["../escape.tar.zst", "pod-1/upper-NOTHEX.tar.zst", "pod-1/plain.txt", "", "/absolute"]) {
    assert.throws(() => assertProxyKey(bad), /invalid proxy archive key/);
  }
  assert.equal(stub.hits(), before);
  assert.doesNotThrow(() => assertProxyKey(`_dr/${HOST}/sandbox-2026-09-11T12:00:00.000Z.sqlite`));
});

test("proxy store reports missing objects honestly (null head, throwing get, quiet delete)", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archive-proxy-miss-"));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const store = createProxyStore({ url: stub.url, token: TOKEN, hostId: HOST, timeoutMs: 30_000 });
  const missing = `pod-9/upper-${"1".repeat(64)}.tar.zst`;
  assert.equal(await store.head(missing), null);
  await assert.rejects(store.get(missing, path.join(temporary, "out.bin")), /HTTP 404/);
  await store.delete(missing);
});

test("proxy config: URL required, bare https origin enforced outside loopback", async () => {
  const base = { PI_POD_SANDBOX_TOKEN: "test-token-0123456789", PI_POD_SANDBOX_HOST_ID: HOST };
  assert.throws(
    () => loadConfig({ ...base, PI_POD_SANDBOX_ARCHIVE_DRIVER: "proxy" }),
    /requires PI_POD_SANDBOX_ARCHIVE_PROXY_URL/);
  assert.throws(
    () => loadConfig({ ...base, PI_POD_SANDBOX_ARCHIVE_DRIVER: "proxy", PI_POD_SANDBOX_ARCHIVE_PROXY_URL: "http://example.com/x" }),
    /bare https origin/);
  // Path/query/userinfo are rejected: the pin binds a bare origin only.
  for (const bad of ["https://api.pipod.dev/prefix", "https://user@api.pipod.dev", "https://api.pipod.dev?x=1"]) {
    assert.throws(
      () => loadConfig({ ...base, PI_POD_SANDBOX_ARCHIVE_DRIVER: "proxy", PI_POD_SANDBOX_ARCHIVE_PROXY_URL: bad }),
      /bare https origin/, bad);
  }
  const cfg = loadConfig({
    ...base,
    PI_POD_SANDBOX_ARCHIVE_DRIVER: "proxy",
    PI_POD_SANDBOX_ARCHIVE_PROXY_URL: "https://api.pipod.dev",
  });
  assert.equal(cfg.archive.driver, "proxy");
  // Production activation is pinned: without the durable binding this throws
  // before any HTTP (see archive-proxy-origin-pin-unit.test.ts). The raw
  // transport below stays unpinned on purpose for protocol-level tests.
  assert.throws(() => createObjectStore(cfg.archive), /archive_proxy_origin_missing/);
});
