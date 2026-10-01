import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  normalizeReference,
  parseBearerChallenge,
  selectPlatformManifest,
  type OciIndex,
} from "../src/images/registry.js";
import { extractLayerBlob, omitEmptyDiffLayers } from "../src/images/store.js";

const run = promisify(execFile);
test("converts OCI whiteouts after layer extraction", async (t) => {
  if (process.getuid?.() !== 0) {
    t.skip("whiteout conversion requires root");
    return;
  }

  const temporary = await mkdtemp(path.join(tmpdir(), "pi-pod-images-whiteout-"));
  t.after(async () => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source");
  const blob = path.join(temporary, "layer.tar");
  const extracted = path.join(temporary, "layer");
  await mkdir(path.join(source, "dir"), { recursive: true });
  await writeFile(path.join(source, ".wh.deleted"), "");
  await writeFile(path.join(source, "dir", ".wh..wh..opq"), "");
  await run("tar", ["-cf", blob, "-C", source, "."]);

  await extractLayerBlob(blob, "application/vnd.oci.image.layer.v1.tar", extracted);

  const whiteout = await lstat(path.join(extracted, "deleted"));
  assert.equal(whiteout.isCharacterDevice(), true);
  assert.equal(whiteout.rdev, 0);
  await assert.rejects(lstat(path.join(extracted, ".wh.deleted")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(extracted, "dir", ".wh..wh..opq")), { code: "ENOENT" });
  const { stdout } = await run("getfattr", ["--absolute-names", "-n", "trusted.overlay.opaque", path.join(extracted, "dir")]);
  assert.match(stdout, /trusted\.overlay\.opaque="y"/);
});
