import { createHash, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { childError, run, waitForChild } from "../runtime/exec.js";

export const ZSTD_LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+zstd";

export interface PackedLayer {
  /** sha256 of the uncompressed tar: the image config's rootfs diff_id. */
  diffId: string;
  /** sha256 of the compressed blob the manifest references. */
  digest: string;
  size: number;
  mediaType: string;
}

/**
 * Overlay xattrs with no OCI spelling. A redirected directory or a metacopy file only means
 * something next to the very lowers it was written over, so an upper holding one cannot become
 * a portable layer; refusing it is better than publishing a layer that silently differs.
 */
const UNPORTABLE_OVERLAY_XATTRS = new Set([
  "trusted.overlay.redirect",
  "trusted.overlay.metacopy",
  "trusted.overlay.whiteout",
  "trusted.overlay.whiteouts",
]);

/**
 * Turn an overlayfs upper directory into an OCI layer blob at `outFile`, consuming the
 * directory: whiteouts are rewritten in place, so the caller must be about to discard it.
 *
 * Overlayfs records a deleted path as a 0/0 character device and a replaced directory as a
 * `trusted.overlay.opaque` xattr; OCI spells them `.wh.<name>` and `.wh..wh..opq`. This is the
 * exact reverse of `extractLayerBlob`'s conversion in store.ts. Every other xattr survives,
 * file capabilities included. `exclude` names paths, relative to the root, that are dropped.
 */
export async function packUpperLayer(upperDir: string, outFile: string, exclude: string[]): Promise<PackedLayer> {
  for (const directory of await opaqueDirectories(upperDir)) {
    await writeFile(path.join(directory, ".wh..wh..opq"), "", { mode: 0o644 });
  }
  const devices = await run("find", [upperDir, "-type", "c", "-print0"]);
  if (devices.code !== 0) throw new Error(`find failed (${devices.code}): ${firstLines(devices.stderr)}`);
  for (const device of devices.stdout.split("\0").filter(Boolean)) {
    if ((await lstat(device)).rdev !== 0) continue; // a real device node, not a whiteout
    await rm(device);
    await writeFile(path.join(path.dirname(device), `.wh.${path.basename(device)}`), "", { mode: 0o644 });
  }

  const tar = spawn("tar", [
    "--create",
    "--file=-",
    `--directory=${upperDir}`,
    "--format=posix",
    "--numeric-owner",
    "--sort=name",
    "--xattrs",
    "--xattrs-include=*",
    "--xattrs-exclude=trusted.overlay.*",
    "--anchored",
    ...exclude.map((entry) => `--exclude=./${entry.replace(/^\/+/, "")}`),
    ".",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const zstd = spawn("zstd", ["-q", "-T0", "-c", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  const diff = createHash("sha256");
  const blob = createHash("sha256");
  let size = 0;
  const results = await Promise.allSettled([
    waitForChild(tar),
    waitForChild(zstd),
    pipeline(tar.stdout, digesting(diff), zstd.stdin),
    pipeline(zstd.stdout, digesting(blob, (bytes) => (size += bytes)), createWriteStream(outFile, { mode: 0o600 })),
  ]);
  const failure = [
    results[0].status === "fulfilled" ? childError("tar", results[0].value) : results[0].reason,
    results[1].status === "fulfilled" ? childError("zstd", results[1].value) : results[1].reason,
    results[2].status === "rejected" ? results[2].reason : null,
    results[3].status === "rejected" ? results[3].reason : null,
  ].find((error) => error !== null && error !== undefined);
  if (failure !== undefined) {
    await rm(outFile, { force: true });
    throw failure;
  }
  return {
    diffId: `sha256:${diff.digest("hex")}`,
    digest: `sha256:${blob.digest("hex")}`,
    size,
    mediaType: ZSTD_LAYER_MEDIA_TYPE,
  };
}

function digesting(hash: Hash, count?: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      count?.(chunk.length);
      callback(null, chunk);
    },
  });
}

/** Directories overlayfs marked opaque, after refusing any upper that cannot be expressed in OCI. */
async function opaqueDirectories(upperDir: string): Promise<string[]> {
  // --no-dereference: a symlink in an upper usually points into a lower layer, so following it
  // finds nothing; its own xattrs are what matter.
  const dump = await run("getfattr", [
    "--recursive",
    "--physical",
    "--no-dereference",
    "--absolute-names",
    "--dump",
    "--match=^trusted\\.overlay\\.",
    upperDir,
  ]);
  if (dump.code !== 0) throw new Error(`getfattr failed (${dump.code}): ${firstLines(dump.stderr)}`);
  const opaque: string[] = [];
  let file: string | null = null;
  for (const line of dump.stdout.split("\n")) {
    if (line.startsWith("# file: ")) {
      file = unescapeGetfattrPath(line.slice("# file: ".length));
      continue;
    }
    const separator = line.indexOf("=");
    if (file === null || separator < 0) continue;
    const name = line.slice(0, separator);
    if (UNPORTABLE_OVERLAY_XATTRS.has(name)) {
      throw new Error(`${path.relative(upperDir, file) || "."} carries ${name}, which an OCI layer cannot express`);
    }
    if (name === "trusted.overlay.opaque" && line.slice(separator + 1) === '"y"') opaque.push(file);
  }
  return opaque;
}

/** A tool's complaints about a whole tree can run to thousands of lines; an error needs a few. */
function firstLines(stderr: string, count = 5): string {
  const lines = stderr.trim().split("\n");
  return lines.slice(0, count).join("\n") + (lines.length > count ? `\n… and ${lines.length - count} more` : "");
}

/** getfattr prints a path with backslash and non-printable bytes as `\\` and `\ooo` escapes. */
function unescapeGetfattrPath(escaped: string): string {
  const bytes: number[] = [];
  for (const match of escaped.matchAll(/\\([0-7]{3})|\\\\|[^\\]+|\\/gu)) {
    if (match[1] !== undefined) bytes.push(Number.parseInt(match[1], 8));
    else if (match[0] === "\\\\") bytes.push(0x5c);
    else bytes.push(...Buffer.from(match[0], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}
