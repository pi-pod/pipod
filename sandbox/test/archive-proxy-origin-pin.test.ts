import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createObjectStore } from "../src/archive/objectstore.js";
import {
  canonicalizeProxyOrigin,
  createPinnedProxyStore,
  proxyBindingPath,
  writeProxyBindingAtomic,
  ProxyOriginPinError,
} from "../src/archive/proxy-origin-pin.js";

const TOKEN = "test-pin-token-0123456789abcdef-xyz";
const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

async function proofServerProcesses(): Promise<string[]> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid,args"]);
  return stdout.split("\n").filter((line) => line.includes("proxy-origin-pin-proof-server.mjs"));
}
const HOST = "boat-pintest";
const OTHER_HOST = "boat-otherhost";
const KEY = (sha: string) => `pod-1/upper-${sha}.tar.zst`;

/** Production-protocol stub with hit counting. Counts only /v1/host-archives hits. */
function startStub(options: { token?: string; redirectGet?: boolean } = {}): Promise<{
  server: Server;
  url: string;
  hits: () => number;
}> {
  const token = options.token ?? TOKEN;
  let hits = 0;
  const objects = new Map<string, Buffer>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname === "/__counts") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hits }));
      return;
    }
    const match = /^\/v1\/host-archives\/([^/]+)\/objects(\/(.*))?$/.exec(url.pathname);
    if (!match) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no");
      return;
    }
    hits += 1;
    const fail = (code: number, body = "no") => {
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(body);
    };
    if (req.headers.authorization !== `Bearer ${token}`) return fail(401);
    const pathHost = decodeURIComponent(match[1]!);
    if (pathHost !== HOST) return fail(403);
    if (req.method === "GET" && match[3] === undefined) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const scoped = `${pathHost}/${prefix}`;
      const listed = [...objects.entries()]
        .filter(([k]) => k.startsWith(scoped))
        .map(([k, bytes]) => ({ key: k.slice(pathHost.length + 1), size: bytes.length, lastModified: 1700000000000 }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ objects: listed }));
      return;
    }
    const key = (match[3] ?? "").split("/").map(decodeURIComponent).join("/");
    const namespaced = `${pathHost}/${key}`;
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
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
      if (options.redirectGet) {
        res.writeHead(302, { location: "/v1/host-archives/evil/objects/evil" });
        res.end();
        return;
      }
      const bytes = objects.get(namespaced);
      if (!bytes) return fail(404);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
      res.end(bytes);
      return;
    }
    if (req.method === "HEAD") {
      if (options.redirectGet) {
        res.writeHead(301, { location: "/elsewhere" });
        res.end();
        return;
      }
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
      resolve({ server, url: `http://127.0.0.1:${port}`, hits: () => hits });
    });
  });
}

async function tempStateDir(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-pin-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function pinErrorCode(error: unknown): string {
  assert.ok(error instanceof ProxyOriginPinError, `expected ProxyOriginPinError, got ${String(error)}`);
  return (error as ProxyOriginPinError).code;
}

test("pin: known-good archive roundtrip via production pinned store", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: stub.url });
  // Binding path is fixed and stateDir-derived.
  assert.equal(proxyBindingPath(stateDir), path.join(path.resolve(stateDir), "archive-proxy-binding.json"));

  const store = createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 });
  assert.equal(store.kind, "proxy");
  const contents = randomBytes(64 * 1024);
  const sha = createHash("sha256").update(contents).digest("hex");
  const source = path.join(stateDir, "source.tar.zst");
  await writeFile(source, contents);
  const stored = await store.put(KEY(sha), source, { sha256: sha });
  assert.equal(stored.size, contents.length);
  assert.equal(stored.sha256, sha);
  const head = await store.head(KEY(sha));
  assert.equal(head?.size, contents.length);
  const dest = path.join(stateDir, "out", "restored.tar.zst");
  await store.get(KEY(sha), dest);
  assert.deepEqual(await readFile(dest), contents);
  const listed = await store.list("pod-1/");
  assert.deepEqual(listed.map((e) => e.key), [KEY(sha)]);
  await store.delete(KEY(sha));
  assert.equal(await store.head(KEY(sha)), null);
  assert.ok(stub.hits() > 0, "pinned roundtrip must take network traffic");
});

test("pin: createObjectStore factory path is pinned (same binding, same roundtrip)", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: stub.url });
  const cfg = loadConfig({
    PI_POD_SANDBOX_TOKEN: TOKEN,
    PI_POD_SANDBOX_STATE_DIR: stateDir,
    PI_POD_SANDBOX_HOST_ID: HOST,
    PI_POD_SANDBOX_ARCHIVE_DRIVER: "proxy",
    PI_POD_SANDBOX_ARCHIVE_PROXY_URL: stub.url,
  });
  assert.equal(cfg.archive.driver, "proxy");
  const store = createObjectStore(cfg.archive);
  assert.equal(store.kind, "proxy");
  const contents = randomBytes(1024);
  const sha = createHash("sha256").update(contents).digest("hex");
  const source = path.join(stateDir, "a.bin");
  await writeFile(source, contents);
  await store.put(KEY(sha), source, { sha256: sha });
  assert.equal((await store.head(KEY(sha)))?.size, contents.length);
});

test("pin: missing binding blocks activation with zero HTTP", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const stateDir = await tempStateDir(t);
  const before = stub.hits();
  assert.throws(
    () => createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 }),
    (e: unknown) => pinErrorCode(e) === "archive_proxy_origin_missing",
  );
  assert.equal(stub.hits(), before);
  // Same via the production factory entry point.
  const cfg = loadConfig({
    PI_POD_SANDBOX_TOKEN: TOKEN,
    PI_POD_SANDBOX_STATE_DIR: stateDir,
    PI_POD_SANDBOX_HOST_ID: HOST,
    PI_POD_SANDBOX_ARCHIVE_DRIVER: "proxy",
    PI_POD_SANDBOX_ARCHIVE_PROXY_URL: stub.url,
  });
  assert.throws(() => createObjectStore(cfg.archive), /archive_proxy_origin_missing/);
  assert.equal(stub.hits(), before);
});

test("pin: deleted binding blocks every method with zero new HTTP (no cache)", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: stub.url });
  const store = createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 });
  const contents = randomBytes(512);
  const sha = createHash("sha256").update(contents).digest("hex");
  const source = path.join(stateDir, "s.bin");
  await writeFile(source, contents);
  await store.put(KEY(sha), source, { sha256: sha });
  const baseline = stub.hits();
  assert.ok(baseline > 0);
  // Delete the binding: every subsequent method must fail closed, no HTTP.
  await rm(proxyBindingPath(stateDir), { force: true });
  const key = KEY(sha);
  await assert.rejects(store.head(key), /archive_proxy_origin_missing/);
  await assert.rejects(store.get(key, path.join(stateDir, "o.bin")), /archive_proxy_origin_missing/);
  await assert.rejects(store.list("pod-1/"), /archive_proxy_origin_missing/);
  await assert.rejects(store.delete(key), /archive_proxy_origin_missing/);
  await assert.rejects(store.put(key, source), /archive_proxy_origin_missing/);
  assert.equal(stub.hits(), baseline, "no HTTP after binding deletion");
});

test("pin: malformed bindings fail closed with zero HTTP", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const badPayloads: Array<{ name: string; bytes: string }> = [
    { name: "not-json", bytes: "{not json" },
    { name: "wrong-version", bytes: JSON.stringify({ version: 2, hostId: HOST, origin: stub.url }) },
    { name: "missing-origin", bytes: JSON.stringify({ version: 1, hostId: HOST }) },
    { name: "bad-host", bytes: JSON.stringify({ version: 1, hostId: "bad id!", origin: stub.url }) },
    { name: "path-origin", bytes: JSON.stringify({ version: 1, hostId: HOST, origin: `${stub.url}/prefix` }) },
    { name: "query-origin", bytes: JSON.stringify({ version: 1, hostId: HOST, origin: `${stub.url}?x=1` }) },
    { name: "userinfo-origin", bytes: JSON.stringify({ version: 1, hostId: HOST, origin: stub.url.replace("://", "://user@") }) },
    { name: "non-loopback-http", bytes: JSON.stringify({ version: 1, hostId: HOST, origin: "http://example.com" }) },
    { name: "extra-field", bytes: JSON.stringify({ version: 1, hostId: HOST, origin: stub.url, token: "x" }) },
    { name: "array", bytes: "[]" },
  ];
  for (const bad of badPayloads) {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), `proxy-pin-bad-${bad.name}-`));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    await writeFile(proxyBindingPath(stateDir), bad.bytes, { mode: 0o600 });
    const before = stub.hits();
    assert.throws(
      () => createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 }),
      /archive_proxy_origin_invalid/,
      bad.name,
    );
    assert.equal(stub.hits(), before, bad.name);
  }
});

test("pin: wrong host and symlink/world-writable fail closed", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  // Wrong host.
  {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "proxy-pin-wronghost-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    await writeProxyBindingAtomic(stateDir, { hostId: OTHER_HOST, origin: stub.url });
    const before = stub.hits();
    assert.throws(
      () => createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 }),
      /archive_proxy_origin_mismatch/,
    );
    assert.equal(stub.hits(), before);
  }
  // Symlink.
  {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "proxy-pin-symlink-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    const real = path.join(stateDir, "real.json");
    await writeFile(real, JSON.stringify({ version: 1, hostId: HOST, origin: stub.url }));
    await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: stub.url });
    await rm(proxyBindingPath(stateDir), { force: true });
    await symlink(real, proxyBindingPath(stateDir));
    const before = stub.hits();
    assert.throws(
      () => createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 }),
      /archive_proxy_origin_invalid/,
    );
    assert.equal(stub.hits(), before);
  }
  // World-writable.
  {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "proxy-pin-ww-"));
    t.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: stub.url });
    await chmod(proxyBindingPath(stateDir), 0o666);
    const before = stub.hits();
    assert.throws(
      () => createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 }),
      /archive_proxy_origin_invalid/,
    );
    assert.equal(stub.hits(), before);
  }
});

test("pin: cross-origin drift across logical restart is blocked, binding survives", async (t) => {
  const originA = await startStub();
  t.after(() => originA.server.close());
  const originB = await startStub();
  t.after(() => originB.server.close());
  assert.notEqual(originA.url, originB.url);
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: originA.url });

  // Logical restart 1: correct origin still works (durability).
  const good = createPinnedProxyStore({ stateDir, hostId: HOST, url: originA.url, token: TOKEN, timeoutMs: 30_000 });
  const contents = randomBytes(2048);
  const sha = createHash("sha256").update(contents).digest("hex");
  const source = path.join(stateDir, "drift.bin");
  await writeFile(source, contents);
  await good.put(KEY(sha), source, { sha256: sha });
  const countA1 = originA.hits();
  assert.ok(countA1 > 0);
  assert.equal(originB.hits(), 0);

  // Logical restart 2: env drifted to origin B. Construction fails, zero egress.
  const beforeA = originA.hits();
  const beforeB = originB.hits();
  assert.throws(
    () => createPinnedProxyStore({ stateDir, hostId: HOST, url: originB.url, token: TOKEN, timeoutMs: 30_000 }),
    /archive_proxy_origin_mismatch/,
  );
  assert.equal(originA.hits(), beforeA);
  assert.equal(originB.hits(), beforeB);

  // All five drifted methods stay blocked with zero egress (construct via fresh
  // binding-swap trick is impossible here since construction itself throws, so
  // prove per-method blocking by pinning to B then drifting env back to A
  // against a second stateDir — instead directly assert the mismatch error
  // carries no URL/token).
  try {
    createPinnedProxyStore({ stateDir, hostId: HOST, url: originB.url, token: TOKEN, timeoutMs: 30_000 });
    assert.fail("drifted construction must throw");
  } catch (error) {
    const message = String(error);
    assert.match(message, /archive_proxy_origin_mismatch/);
    assert.doesNotMatch(message, /127\.0\.0\.1:\d+/);
    assert.ok(!message.includes(TOKEN), "token must never appear in pin errors");
  }
});

test("pin: live binding replacement is honored without restart (no fence caching)", async (t) => {
  const originA = await startStub();
  t.after(() => originA.server.close());
  const originB = await startStub();
  t.after(() => originB.server.close());
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: originA.url });
  const store = createPinnedProxyStore({ stateDir, hostId: HOST, url: originA.url, token: TOKEN, timeoutMs: 30_000 });
  const contents = randomBytes(512);
  const sha = createHash("sha256").update(contents).digest("hex");
  const source = path.join(stateDir, "live.bin");
  await writeFile(source, contents);
  await store.put(KEY(sha), source, { sha256: sha });
  const baselineA = originA.hits();
  const baselineB = originB.hits();
  // Factory re-points the binding to B; the SAME store instance (env still A)
  // must now refuse without any HTTP.
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: originB.url });
  await assert.rejects(store.head(KEY(sha)), /archive_proxy_origin_mismatch/);
  await assert.rejects(store.list("pod-1/"), /archive_proxy_origin_mismatch/);
  await assert.rejects(store.delete(KEY(sha)), /archive_proxy_origin_mismatch/);
  assert.equal(originA.hits(), baselineA, "no egress to old origin after re-point");
  assert.equal(originB.hits(), baselineB, "no egress to new origin on mismatch");
});

test("pin: drifted env blocks all five methods with zero egress", async (t) => {
  const originA = await startStub();
  t.after(() => originA.server.close());
  const originB = await startStub();
  t.after(() => originB.server.close());
  // Pin to A in one stateDir, then build a drifted store by writing a B-pinned
  // binding, constructing (succeeds), then swapping the binding back to A so
  // the env (B) mismatches at call time. This exercises per-method gating for
  // a store whose construction succeeded.
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: originB.url });
  const drifted = createPinnedProxyStore({ stateDir, hostId: HOST, url: originB.url, token: TOKEN, timeoutMs: 30_000 });
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: originA.url });
  const beforeA = originA.hits();
  const beforeB = originB.hits();
  const key = KEY("a".repeat(64));
  const source = path.join(stateDir, "x.bin");
  await writeFile(source, randomBytes(128));
  await assert.rejects(drifted.put(key, source), /archive_proxy_origin_mismatch/);
  await assert.rejects(drifted.get(key, path.join(stateDir, "o.bin")), /archive_proxy_origin_mismatch/);
  await assert.rejects(drifted.head(key), /archive_proxy_origin_mismatch/);
  await assert.rejects(drifted.list("pod-1/"), /archive_proxy_origin_mismatch/);
  await assert.rejects(drifted.delete(key), /archive_proxy_origin_mismatch/);
  assert.equal(originA.hits(), beforeA);
  assert.equal(originB.hits(), beforeB);
});

test("pin: redirects are never followed (manual, hard failure)", async (t) => {
  const stub = await startStub({ redirectGet: true });
  t.after(() => stub.server.close());
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: stub.url });
  const store = createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 });
  const key = KEY("b".repeat(64));
  // PUT succeeds (redirect only on GET/HEAD in this stub); GET/HEAD must fail
  // as redirect-blocked without following the Location.
  const source = path.join(stateDir, "r.bin");
  await writeFile(source, randomBytes(256));
  await store.put(key, source);
  await assert.rejects(store.get(key, path.join(stateDir, "r-out.bin")), /redirect blocked|HTTP 30[12]/);
  await assert.rejects(store.head(key), /redirect blocked|HTTP 30[12]/);
  // LIST does not redirect in this stub and still works (proves the failure
  // was the redirect, not the pin).
  const listed = await store.list("pod-1/");
  assert.ok(listed.some((e) => e.key === key));
});

test("pin: canonicalization rejects userinfo/path/query/fragment, normalizes case+ports", async (t) => {
  // Rejects.
  for (const bad of [
    "https://user@example.com",
    "https://user:pass@example.com/",
    "https://example.com/prefix",
    "https://example.com/prefix/",
    "https://example.com/../",
    "https://example.com/%2e%2e/",
    "https://example.com/.",
    "https://example.com?",
    "https://example.com#",
    "https://example.com?x=1",
    "https://example.com#frag",
    " https://example.com",
    "https://example.com ",
    "https://exa mple.com",
    "http://example.com/",
    "ftp://example.com/",
    "",
    "not-a-url",
  ]) {
    assert.throws(() => canonicalizeProxyOrigin(bad), /archive_proxy_origin_config_invalid/, bad);
  }
  // Normalizes.
  assert.equal(canonicalizeProxyOrigin("https://PROXY.EXAMPLE.COM"), "https://proxy.example.com");
  assert.equal(canonicalizeProxyOrigin("https://proxy.example.com:443"), "https://proxy.example.com");
  assert.equal(canonicalizeProxyOrigin("https://proxy.example.com:8443"), "https://proxy.example.com:8443");
  assert.equal(canonicalizeProxyOrigin("https://proxy.example.com/"), "https://proxy.example.com");
  assert.equal(canonicalizeProxyOrigin("http://127.0.0.1:1234"), "http://127.0.0.1:1234");
  assert.equal(canonicalizeProxyOrigin("http://localhost:80"), "http://localhost");
  // Config layer enforces the same rule without echoing the URL.
  const base = { PI_POD_SANDBOX_TOKEN: TOKEN, PI_POD_SANDBOX_HOST_ID: HOST };
  for (const bad of ["https://example.com/prefix", "https://user@example.com", "http://example.com/x"]) {
    assert.throws(
      () => loadConfig({ ...base, PI_POD_SANDBOX_ARCHIVE_DRIVER: "proxy", PI_POD_SANDBOX_ARCHIVE_PROXY_URL: bad }),
      /bare https origin/,
      bad,
    );
  }
});

test("pin: boat+local still boots without any binding; boat/static+proxy without binding is blocked", async (t) => {
  const stateDir = await tempStateDir(t);
  for (const backend of ["boat", "static"] as const) {
    const hostId = backend === "boat" ? "boat-localboot" : HOST;
    const local = loadConfig({
      PI_POD_SANDBOX_TOKEN: TOKEN,
      PI_POD_SANDBOX_STATE_DIR: stateDir,
      PI_POD_SANDBOX_HOST_ID: hostId,
      PI_POD_SANDBOX_HOST_BACKEND: backend,
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
    });
    const store = createObjectStore(local.archive);
    assert.equal(store.kind, "local");
  }
  // Proxy without binding is blocked in both backends (explicit: no static exemption).
  const stub = await startStub();
  t.after(() => stub.server.close());
  for (const backend of ["boat", "static"] as const) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-pin-nobind-"));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: TOKEN,
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_HOST_ID: backend === "boat" ? "boat-nobind" : HOST,
      PI_POD_SANDBOX_HOST_BACKEND: backend,
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "proxy",
      PI_POD_SANDBOX_ARCHIVE_PROXY_URL: stub.url,
    });
    assert.throws(() => createObjectStore(cfg.archive), /archive_proxy_origin_missing/);
  }
  // Error strings never carry the origin or token.
  const dir2 = await mkdtemp(path.join(os.tmpdir(), "proxy-pin-leak-"));
  t.after(async () => {
    await rm(dir2, { recursive: true, force: true });
  });
  await writeProxyBindingAtomic(dir2, { hostId: OTHER_HOST, origin: stub.url });
  const cfg2 = loadConfig({
    PI_POD_SANDBOX_TOKEN: TOKEN,
    PI_POD_SANDBOX_STATE_DIR: dir2,
    PI_POD_SANDBOX_HOST_ID: HOST,
    PI_POD_SANDBOX_ARCHIVE_DRIVER: "proxy",
    PI_POD_SANDBOX_ARCHIVE_PROXY_URL: stub.url,
  });
  try {
    createObjectStore(cfg2.archive);
    assert.fail("must throw");
  } catch (error) {
    const message = String(error);
    assert.match(message, /archive_proxy_origin_mismatch/);
    assert.ok(!message.includes(TOKEN));
    assert.ok(!message.includes(stub.url));
  }
  void mkdir;
});

test("pin: transport errors carry fixed op + numeric status only (no statusText)", async (t) => {
  const MARKER = "SYNTHETIC-STATUS-MARKER-9f8e";
  const server = createServer((_req, res) => {
    res.writeHead(500, MARKER, { "content-type": "text/plain" });
    res.end("boom");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  // Harness sanity: the server really does send the reflected marker.
  const raw = await fetch(`${url}/anything`);
  assert.ok(raw.statusText.includes(MARKER), "server must reflect the marker for this test to mean anything");
  await raw.text().catch(() => undefined);
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: url });
  const store = createPinnedProxyStore({ stateDir, hostId: HOST, url, token: TOKEN, timeoutMs: 30_000 });
  const error = await store.head(KEY("c".repeat(64))).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(error instanceof Error);
  assert.equal(error.message, "archive proxy HEAD failed with HTTP 500");
  assert.ok(!error.message.includes(MARKER), "statusText must never be reflected");
});

test("pin: network rejections are sanitized to a code-only cause", async (t) => {
  // Harvest a port that is guaranteed closed: bind it, then close it.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const deadUrl = `http://127.0.0.1:${port}`;
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: deadUrl });
  const store = createPinnedProxyStore({ stateDir, hostId: HOST, url: deadUrl, token: TOKEN, timeoutMs: 5000 });
  const error = await store.head(KEY("d".repeat(64))).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(error instanceof Error);
  assert.equal(error.message, "archive proxy HEAD failed: network error");
  assert.ok(!error.message.includes(deadUrl) && !error.message.includes(TOKEN));
  const cause = (error as { cause?: unknown }).cause;
  assert.ok(typeof cause === "string", "cause keeps only the syscall code");
  assert.ok(!cause.includes(deadUrl) && !cause.includes(TOKEN));
});

test("pin: binding deleted during PUT prep still blocks with zero HTTP", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const stateDir = await tempStateDir(t);
  await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: stub.url });
  const store = createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 });
  const contents = randomBytes(4096);
  const sha = createHash("sha256").update(contents).digest("hex");
  const source = path.join(stateDir, "delayed.bin");
  await writeFile(source, contents);
  const before = stub.hits();
  // The dispatch guard runs AFTER async prep (stat/stream setup) with no await
  // before fetch: deleting synchronously here lands inside the old TOCTOU
  // window, and must still block with no send.
  const pending = store.put(KEY(sha), source, { sha256: sha });
  rmSync(proxyBindingPath(stateDir));
  await assert.rejects(pending, /archive_proxy_origin_missing/);
  assert.equal(stub.hits(), before, "no HTTP when the binding vanishes mid-prep");
});

test("pin: producer writes byte-exact payload, verifies read-back, cleans own temp", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-pin-producer-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const stateDir = path.join(dir, "state");
  const target = await writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: "https://proxy.example.com:443" });
  assert.equal(target, proxyBindingPath(stateDir));
  const raw = await readFile(target, "utf8");
  assert.equal(raw, `{\n  "version": 1,\n  "hostId": "${HOST}",\n  "origin": "https://proxy.example.com"\n}\n`);
  assert.equal(statSync(target).mode & 0o077, 0, "binding must not be group/other-accessible");

  // A failed install (rename onto a non-empty directory) throws and leaves no
  // temp behind, and never touches an existing binding.
  const blockedDir = path.join(dir, "blocked");
  await mkdir(blockedDir, { recursive: true });
  const clash = path.join(blockedDir, "archive-proxy-binding.json");
  await mkdir(clash, { recursive: true });
  await writeFile(path.join(clash, "keep"), "x");
  await assert.rejects(
    writeProxyBindingAtomic(blockedDir, { hostId: HOST, origin: "https://proxy.example.com" }),
  );
  const leftovers = (await readdir(blockedDir)).filter((name) => name.startsWith(".archive-proxy-binding.json."));
  assert.deepEqual(leftovers, [], "failed installs must not leave temps");

  // A rejected write (bad origin) never clobbers the installed binding.
  const before = await readFile(target, "utf8");
  await assert.rejects(writeProxyBindingAtomic(stateDir, { hostId: HOST, origin: "https://bad/prefix" }));
  assert.equal(await readFile(target, "utf8"), before);
});

test("pin: group-writable and FIFO bindings fail closed without hanging", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-pin-groupw-"));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    await writeProxyBindingAtomic(dir, { hostId: HOST, origin: stub.url });
    await chmod(proxyBindingPath(dir), 0o660);
    const before = stub.hits();
    assert.throws(
      () => createPinnedProxyStore({ stateDir: dir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 }),
      /archive_proxy_origin_invalid/,
    );
    assert.equal(stub.hits(), before);
  }
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-pin-fifo-"));
    t.after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    execFileSync("mkfifo", [proxyBindingPath(dir)]);
    const before = stub.hits();
    assert.throws(
      () => createPinnedProxyStore({ stateDir: dir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 }),
      /archive_proxy_origin_invalid/,
    );
    assert.equal(stub.hits(), before);
  }
});

test("pin: operator producer command writes a verified binding (and refuses bad input)", async (t) => {
  const stub = await startStub();
  t.after(() => stub.server.close());
  const cli = path.join(SCRIPTS_DIR, "write-proxy-origin-binding.mjs");
  const base = await mkdtemp(path.join(os.tmpdir(), "cli-op-"));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const stateDir = path.join(base, "newstate");
  const { stdout } = await execFileAsync("node", [cli, "--state-dir", stateDir, "--host-id", HOST, "--origin", stub.url]);
  const receipt = JSON.parse(stdout) as { path: string; version: number; hostId: string; origin: string };
  assert.equal(receipt.version, 1);
  assert.equal(receipt.hostId, HOST);
  assert.equal(receipt.origin, stub.url);
  assert.ok(!stdout.includes(TOKEN), "operator output carries no credentials");
  assert.equal(statSync(receipt.path).mode & 0o077, 0);
  // The runtime accepts exactly what the operator command wrote.
  const store = createPinnedProxyStore({ stateDir, hostId: HOST, url: stub.url, token: TOKEN, timeoutMs: 30_000 });
  assert.equal(await store.head(KEY("e".repeat(64))), null);
  // Bad input exits nonzero and creates no binding.
  const badDir = path.join(base, "badstate");
  let code: string | number | null = null;
  try {
    await execFileAsync("node", [cli, "--state-dir", badDir, "--host-id", HOST, "--origin", "https://h/prefix"]);
  } catch (error) {
    code = (error as { code?: string | number | null }).code ?? 1;
  }
  assert.notEqual(code, 0);
  assert.ok(!((await import("node:fs")).existsSync(path.join(badDir, "archive-proxy-binding.json"))));
});

test("pin: proof fail-after-first-spawn exits nonzero and leaves zero owned children", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "proof-fail-parent-"));
  t.after(async () => {
    await rm(parent, { recursive: true, force: true });
  });
  const outDir = path.join(parent, "run");
  const proof = path.join(SCRIPTS_DIR, "proxy-origin-pin-proof.ts");
  let code: string | number | null = 0;
  try {
    await execFileAsync("node", ["--import", "tsx", proof, "--out-dir", outDir, "--fail-after-first-spawn"], {
      cwd: path.join(SCRIPTS_DIR, ".."),
      timeout: 90_000,
    });
  } catch (error) {
    code = (error as { code?: string | number | null }).code ?? 1;
  }
  assert.notEqual(code, 0, "hook must fail the run");
  // The run dir was created (failure happened after the first spawn, not before).
  assert.ok((await import("node:fs")).existsSync(outDir));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const strays = await proofServerProcesses();
  assert.equal(strays.length, 0, `orphaned proof servers must not remain: ${strays.join("; ")}`);
});
