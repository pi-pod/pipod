import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { childError, waitForChild } from "../runtime/exec.js";
import type { PackResult } from "./types.js";

function settledError(result: PromiseSettledResult<unknown>): unknown {
  return result.status === "rejected" ? result.reason : undefined;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function packDir(sourceDir: string, outFile: string): Promise<PackResult> {
  await mkdir(path.dirname(outFile), { recursive: true });

  // Overlayfs upper dirs require device nodes and every xattr to survive the archive.
  const tar = spawn("tar", [
    "--create",
    "--file=-",
    `--directory=${sourceDir}`,
    "--numeric-owner",
    "--xattrs",
    "--xattrs-include=*",
    "--acls",
    "--sparse",
    "-p",
    ".",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const zstd = spawn("zstd", ["-q", "-c", "-"], { stdio: ["pipe", "pipe", "pipe"] });

  const hash = createHash("sha256");
  let size = 0;
  const checksum = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });

  const tarDone = waitForChild(tar);
  const zstdDone = waitForChild(zstd);
  const results = await Promise.allSettled([
    tarDone,
    zstdDone,
    pipeline(tar.stdout, zstd.stdin),
    pipeline(zstd.stdout, checksum, createWriteStream(outFile, { mode: 0o600 })),
  ]);

  const tarResult = results[0];
  const zstdResult = results[1];
  let error: unknown;
  if (tarResult.status === "fulfilled") error = childError("tar", tarResult.value);
  else error = tarResult.reason;
  if (error === null || error === undefined) {
    if (zstdResult.status === "fulfilled") error = childError("zstd", zstdResult.value);
    else error = zstdResult.reason;
  }
  error ??= settledError(results[2]);
  error ??= settledError(results[3]);

  if (error !== null && error !== undefined) {
    await rm(outFile, { force: true });
    throw error;
  }
  return { sha256: hash.digest("hex"), size };
}

export async function unpackDir(archiveFile: string, destDir: string): Promise<void> {
  const zstd = spawn("zstd", ["-q", "-d", "-c", archiveFile], { stdio: ["ignore", "pipe", "pipe"] });
  const tar = spawn("tar", [
    "--extract",
    "--file=-",
    `--directory=${destDir}`,
    "--numeric-owner",
    "--xattrs",
    "--xattrs-include=*",
    "--acls",
    "-p",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  const zstdDone = waitForChild(zstd);
  const tarDone = waitForChild(tar);
  tar.stdout.resume();
  const results = await Promise.allSettled([
    tarDone,
    zstdDone,
    pipeline(zstd.stdout, tar.stdin),
  ]);

  const tarResult = results[0];
  const zstdResult = results[1];
  let error: unknown;
  if (tarResult.status === "fulfilled") error = childError("tar", tarResult.value);
  else error = tarResult.reason;
  if (error === null || error === undefined) {
    if (zstdResult.status === "fulfilled") error = childError("zstd", zstdResult.value);
    else error = zstdResult.reason;
  }
  error ??= settledError(results[2]);
  if (error !== null && error !== undefined) throw error;
}
