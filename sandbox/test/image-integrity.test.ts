import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { OciImageStore } from "../src/images/store.js";
import { layerTreeDigest, verifyDiffDigest } from "../src/images/integrity.js";

const run = promisify(execFile);
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function fixture(t: TestContext, options: { empty?: boolean; gzip?: boolean; legacy?: boolean } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "pps-integrity-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const source = path.join(stateDir, "source");
  await mkdir(source);
  if (!options.empty) {
    await mkdir(path.join(source, "bin"));
    await writeFile(path.join(source, "bin", "sh"), "#!/bin/sh\necho preserved\n", { mode: 0o755 });
    await symlink("sh", path.join(source, "bin", "shell"));
    await run("setfattr", ["-n", "user.integrity", "-v", "retained", path.join(source, "bin", "sh")]);
  }
  const tar = path.join(stateDir, "layer.tar");
  await run("tar", ["--xattrs", "-cf", tar, "-C", source, "."]);
  const raw = await readFile(tar);
  const diff = digest(raw);
  if (options.gzip) await run("gzip", ["-k", tar]);
  const bytes = await readFile(options.gzip ? `${tar}.gz` : tar);
  const blobDigest = digest(bytes);
  const config = Buffer.from(JSON.stringify({ rootfs: { diff_ids: [diff] } }));
  const configDigest = digest(config);
  const requests: string[] = [];
  let serve = false;
  const registry = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (serve && decodeURIComponent(req.url ?? "").endsWith(`/blobs/${blobDigest}`)) { res.end(bytes); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => registry.close(() => resolve())));
  const address = registry.address() as { port: number };
  const ref = `127.0.0.1:${address.port}/fixture:latest`;
  const manifestDigest = `sha256:${"a".repeat(64)}`;
  const blobPath = (d: string) => path.join(stateDir, "images", "blobs", ...d.split(":"));
  for (const [d, data] of [[blobDigest, bytes], [configDigest, config]] as const) {
    await mkdir(path.dirname(blobPath(d)), { recursive: true });
    await writeFile(blobPath(d), data);
  }
  const record = {
    ref, manifestDigest, layers: [diff], config: { env: [], cmd: [], entrypoint: [] }, pulledAt: new Date().toISOString(),
    blobDigests: [configDigest, blobDigest],
    ...(!options.legacy ? { layerSources: [{ diffDigest: diff, descriptor: { digest: blobDigest, mediaType: `application/vnd.oci.image.layer.v1.tar${options.gzip ? "+gzip" : ""}` } }] } : {}),
  };
  const recordPath = path.join(stateDir, "images", "refs", `${encodeURIComponent(ref)}.json`);
  await mkdir(path.dirname(recordPath), { recursive: true });
  await writeFile(recordPath, JSON.stringify(record));
  const images = () => new OciImageStore({ stateDir });
  const lower = images().layerDir(diff);
  return { stateDir, images, lower, ref, requests, recordPath, record, blob: blobPath(blobDigest), serve: () => { serve = true; } };
}

test("boot repairs existing empty lowers from retained legacy gzip blobs without a registry call", async (t) => {
  const f = await fixture(t, { legacy: true, gzip: true });
  await mkdir(f.lower, { recursive: true });
  await f.images().validateAndRepair([{ image: f.ref, imageDigest: f.record.manifestDigest, layers: f.record.layers }]);
  assert.match(await readFile(path.join(f.lower, "bin", "sh"), "utf8"), /preserved/);
  assert.deepEqual(f.requests, []);
  assert.ok(JSON.parse(await readFile(f.recordPath, "utf8")).layerSources);
  const hash = await layerTreeDigest(f.lower);
  await f.images().validateAndRepair();
  assert.equal(await layerTreeDigest(f.lower), hash);
});

test("boot detects partial content, same-length corruption, permissions, symlinks and xattrs", async (t) => {
  const f = await fixture(t);
  await f.images().validateAndRepair();
  const expected = await layerTreeDigest(f.lower);
  for (const corrupt of [
    () => rm(path.join(f.lower, "bin", "sh")),
    () => writeFile(path.join(f.lower, "bin", "sh"), "#!/bin/sh\necho corrupted\n"),
    () => chmod(path.join(f.lower, "bin", "sh"), 0o644),
    async () => { await rm(path.join(f.lower, "bin", "shell")); await symlink("missing", path.join(f.lower, "bin", "shell")); },
    () => run("setfattr", ["-n", "user.integrity", "-v", "changed", path.join(f.lower, "bin", "sh")]),
  ]) {
    await corrupt();
    assert.notEqual(await layerTreeDigest(f.lower), expected);
    await f.images().validateAndRepair();
    assert.equal(await layerTreeDigest(f.lower), expected);
  }
  assert.deepEqual(f.requests, []);
});

test("legitimate empty OCI layers survive repeated boot validation", async (t) => {
  const f = await fixture(t, { empty: true });
  const images = f.images();
  await images.validateAndRepair();
  await images.validateAndRepair();
  assert.deepEqual(await readdir(f.lower), []);
  assert.ok(await images.resolve(f.ref));
});

test("corrupt retained blob is re-fetched and verified before automatic repair", async (t) => {
  const f = await fixture(t, { gzip: true });
  await writeFile(f.blob, "corrupt retained compressed blob");
  f.serve();
  await f.images().validateAndRepair();
  assert.equal(f.requests.length, 1);
  assert.match(await readFile(path.join(f.lower, "bin", "sh"), "utf8"), /preserved/);
});

test("unavailable registry with missing blob fails closed even if the lower directory exists", async (t) => {
  const f = await fixture(t);
  await f.images().validateAndRepair();
  await rm(f.blob);
  await assert.rejects(f.images().validateAndRepair(), /404/);
  // Run the actual executable path: it must fail in the image gate, not start networking/listen.
  await assert.rejects(run(process.execPath, ["--import", "tsx", "src/main.ts"], {
    env: { ...process.env, PI_POD_SANDBOX_TOKEN: "integrity-test-token", PI_POD_SANDBOX_STATE_DIR: f.stateDir },
  }), (error: unknown) => {
    const e = error as { stderr: string; stdout: string; code: number };
    assert.equal(e.code, 1);
    assert.match(e.stderr, /404/);
    assert.doesNotMatch(e.stdout, /listening/);
    return true;
  });
});

test("verified compressed digest cannot substitute for verifying the uncompressed diff_id", async (t) => {
  const f = await fixture(t, { gzip: true });
  f.record.layerSources![0]!.diffDigest = `sha256:${"b".repeat(64)}`;
  await writeFile(f.recordPath, JSON.stringify(f.record));
  await assert.rejects(f.images().validateAndRepair(), /disagree with verified image config/);
  await assert.rejects(verifyDiffDigest(f.blob, "application/vnd.oci.image.layer.v1.tar+gzip", `sha256:${"b".repeat(64)}`), /diff digest verification failed/);
});

test("resolve refuses unverified caches and detects post-boot layer loss or corruption", async (t) => {
  const f = await fixture(t);
  const images = f.images();
  assert.equal(await images.resolve(f.ref), null);
  await images.validateAndRepair();
  assert.ok(await images.resolve(f.ref));
  await writeFile(path.join(f.lower, "bin", "sh"), "corrupt but not empty");
  assert.equal(await images.resolve(f.ref), null);
  await images.validateAndRepair();
  assert.ok(await images.resolve(f.ref));
  for (const name of await readdir(f.lower)) await rm(path.join(f.lower, name), { recursive: true, force: true });
  assert.equal(await images.resolve(f.ref), null);
  await images.validateAndRepair();
  assert.ok(await images.resolve(f.ref));
});

test("truncated cached or persisted sandbox layer selections cannot pass the boot gate", async (t) => {
  const f = await fixture(t);
  await f.images().validateAndRepair();
  await assert.rejects(f.images().validateAndRepair([{ image: f.ref, imageDigest: f.record.manifestDigest, layers: [] }]), /sandbox image layer selection mismatch/);
  await writeFile(f.recordPath, JSON.stringify({ ...f.record, layers: [] }));
  await assert.rejects(f.images().validateAndRepair(), /cached image layer selection mismatch/);
});
