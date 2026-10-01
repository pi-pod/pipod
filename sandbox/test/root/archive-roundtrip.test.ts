import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { packDir, sha256File, unpackDir } from "../../src/archive/pack.js";

const execFileAsync = promisify(execFile);

test("archive round trip preserves an overlayfs upper directory", {
  skip: process.getuid?.() !== 0,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archive-roundtrip-"));
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  const upper = path.join(temporary, "upper");
  const archive = path.join(temporary, "upper.tar.zst");
  const regular = path.join(upper, "secret.bin");
  const link = path.join(upper, "secret-link");
  const opaqueDirectory = path.join(upper, "opaque");
  const whiteout = path.join(upper, "removed-entry");
  const contents = Buffer.from([0x00, 0x10, 0xff, 0x7f, 0x0a, 0x00]);

  await mkdir(opaqueDirectory, { recursive: true });
  await writeFile(regular, contents, { mode: 0o600 });
  await chmod(regular, 0o600);
  await chmod(opaqueDirectory, 0o711);
  await symlink("secret.bin", link);
  await execFileAsync("setfattr", ["-n", "trusted.overlay.opaque", "-v", "y", opaqueDirectory]);
  await execFileAsync("mknod", [whiteout, "c", "0", "0"]);

  const originalFileMode = (await stat(regular)).mode & 0o7777;
  const originalDirectoryMode = (await stat(opaqueDirectory)).mode & 0o7777;
  const packed = await packDir(upper, archive);
  assert.equal(packed.sha256, await sha256File(archive));
  assert.equal(packed.size, (await stat(archive)).size);

  await rm(upper, { recursive: true, force: true });
  await mkdir(upper);
  await unpackDir(archive, upper);

  assert.deepEqual(await readFile(regular), contents);
  assert.equal((await stat(regular)).mode & 0o7777, originalFileMode);
  assert.equal((await stat(opaqueDirectory)).mode & 0o7777, originalDirectoryMode);
  assert.equal(await readlink(link), "secret.bin");

  const restoredWhiteout = await lstat(whiteout, { bigint: true });
  assert.equal(restoredWhiteout.isCharacterDevice(), true);
  const major = ((restoredWhiteout.rdev >> 8n) & 0xfffn)
    | ((restoredWhiteout.rdev >> 32n) & 0xfffff000n);
  const minor = (restoredWhiteout.rdev & 0xffn)
    | ((restoredWhiteout.rdev >> 12n) & 0xffffff00n);
  assert.equal(major, 0n);
  assert.equal(minor, 0n);

  const xattr = await execFileAsync("getfattr", [
    "--only-values",
    "-n",
    "trusted.overlay.opaque",
    opaqueDirectory,
  ], { encoding: "utf8" });
  assert.equal(xattr.stdout, "y");
});
