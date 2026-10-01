import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OciImageStore } from "../../src/images/store.js";
import { rootTestSkipReason } from "./harness.js";

const run = promisify(execFile);
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("root OCI repair preserves whiteouts/opaque xattrs and refuses to mutate mounted lowers", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) { t.skip(skip); return; }
  const stateDir = await mkdtemp(path.join(tmpdir(), "pps-root-integrity-"));
  let mounted = false;
  t.after(async () => {
    if (mounted) await run("umount", [path.join(stateDir, "merged")]);
    await rm(stateDir, { recursive: true, force: true });
  });
  const source = path.join(stateDir, "source");
  await mkdir(path.join(source, "opaque"), { recursive: true });
  await writeFile(path.join(source, ".wh.deleted"), "");
  await writeFile(path.join(source, "opaque", ".wh..wh..opq"), "");
  await writeFile(path.join(source, "executable"), "image payload", { mode: 0o755 });
  const tar = path.join(stateDir, "layer.tar");
  await run("tar", ["-cf", tar, "-C", source, "."]);
  const bytes = await readFile(tar);
  const diff = digest(bytes);
  const blob = path.join(stateDir, "images", "blobs", ...diff.split(":"));
  await mkdir(path.dirname(blob), { recursive: true });
  await writeFile(blob, bytes);
  const ref = "127.0.0.1:1/fixture:latest";
  const records = path.join(stateDir, "images", "refs");
  await mkdir(records);
  await writeFile(path.join(records, `${encodeURIComponent(ref)}.json`), JSON.stringify({
    ref, manifestDigest: diff, layers: [diff], config: { env: [], cmd: [], entrypoint: [] }, pulledAt: new Date().toISOString(),
    layerSources: [{ diffDigest: diff, descriptor: { digest: diff, mediaType: "application/vnd.oci.image.layer.v1.tar" } }],
  }));
  const images = () => new OciImageStore({ stateDir });
  const lower = images().layerDir(diff);
  await mkdir(lower, { recursive: true }); // Exact G0 failure: existing, empty lower directory.
  await images().validateAndRepair();
  assert.equal((await lstat(path.join(lower, "deleted"))).isCharacterDevice(), true);
  const attrs = await run("getfattr", ["-n", "trusted.overlay.opaque", path.join(lower, "opaque")]);
  assert.match(attrs.stdout, /="y"/);
  const upper = path.join(stateDir, "upper"), work = path.join(stateDir, "work"), merged = path.join(stateDir, "merged");
  for (const dir of [upper, work, merged]) await mkdir(dir);
  await run("mount", ["-t", "overlay", "overlay", "-o", `lowerdir=${lower},upperdir=${upper},workdir=${work}`, merged]);
  mounted = true;
  await writeFile(path.join(merged, "workspace-marker"), "preserve writable data");
  await writeFile(path.join(lower, "executable"), "corruption");
  await assert.rejects(images().validateAndRepair(), /cannot repair mounted OCI lower/);
  assert.equal(await readFile(path.join(lower, "executable"), "utf8"), "corruption");
  await run("umount", [merged]); mounted = false;
  await images().validateAndRepair();
  assert.equal(await readFile(path.join(lower, "executable"), "utf8"), "image payload");
  assert.equal(await readFile(path.join(upper, "workspace-marker"), "utf8"), "preserve writable data");
});
