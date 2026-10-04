import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, readdir, readlink, readFile, stat } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const exec = promisify(execFile);

/** Never rewrite an OverlayFS lower still used by a live container on a service restart. */
export async function assertLayerNotMounted(root: string): Promise<void> {
  const mountinfo = await readFile("/proc/self/mountinfo", "utf8");
  for (const line of mountinfo.split("\n")) {
    const lowers = /(?:^|,)lowerdir=([^, ]+)/.exec(line)?.[1];
    if (lowers?.split(":").some((entry) => entry.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))) === root)) {
      throw new Error(`cannot repair mounted OCI lower; stop its containers first: ${root}`);
    }
  }
}

/** Hash the real tree, never a sentinel or just the presence of a lower directory. */
export async function layerTreeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const hardlinks = new Map<string, string>();
  async function visit(relative: string): Promise<void> {
    const file = path.join(root, relative);
    const s = await lstat(file);
    hash.update(JSON.stringify([relative, s.mode, s.uid, s.gid, s.rdev]));
    if (s.isSymbolicLink()) hash.update(JSON.stringify(await readlink(file)));
    else if (s.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
    } else if (s.isFile()) {
      const key = `${s.dev}:${s.ino}`;
      hash.update(JSON.stringify([s.size, hardlinks.get(key) ?? relative]));
      hardlinks.set(key, hardlinks.get(key) ?? relative);
      for await (const chunk of createReadStream(file)) hash.update(chunk);
    }
  }
  await visit("");
  // Overlay opaque/whiteout and file capability xattrs are part of the image too.
  // Do not follow image-controlled symlinks. Sort blocks: getfattr traversal order is not stable.
  const { stdout } = await exec("getfattr", ["--absolute-names", "--physical", "-h", "-R", "-d", "-m", "-", "-e", "hex", root], {
    maxBuffer: 64 * 1024 * 1024,
  });
  hash.update(stdout.split("\n\n").filter(Boolean).map((block) => block.replace(`# file: ${root}`, "# file: .")).sort().join("\n\n"));
  return hash.digest("hex");
}

/**
 * What a tree looks like to the filesystem, without reading file contents: every entry's path,
 * type, mode, owner, device, size, inode, link count, mtime and ctime. Writing, truncating,
 * linking, renaming, removing, chmod, chown and xattr changes all move ctime, which userspace
 * cannot set back, so an unchanged fingerprint means nothing changed the tree through the
 * filesystem since {@link layerTreeDigest} verified it. Only the content digest sees silent
 * media corruption.
 */
export async function layerTreeFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relative: string, s: BigIntStats): Promise<void> {
    hash.update(`${JSON.stringify(relative)} ${s.mode} ${s.uid} ${s.gid} ${s.rdev} ${s.size} ${s.ino} ${s.nlink} ${s.mtimeNs} ${s.ctimeNs}\n`);
    if (!s.isDirectory()) return;
    const names = (await readdir(path.join(root, relative))).sort();
    const children = await Promise.all(names.map((name) => lstat(path.join(root, relative, name), { bigint: true })));
    for (const [i, name] of names.entries()) await visit(path.join(relative, name), children[i]!);
  }
  await visit("", await lstat(root, { bigint: true }));
  return hash.digest("hex");
}

export async function fileDigest(file: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * OCI diff_id is the digest of the uncompressed tar, not the compressed registry blob. Returns
 * the tar's size, and stops at `maxBytes`: a small layer can decompress to fill the host's
 * state volume, which no pod quota covers.
 */
export async function verifyDiffDigest(
  blob: string,
  mediaType: string,
  digest: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<number> {
  const [algorithm, expected] = digest.split(":");
  const tooLarge = () => new Error(`layer ${digest} is larger than the ${maxBytes}-byte image limit`);
  const command = mediaType.includes("zstd") ? "zstd" : mediaType.includes("gzip") ? "gzip" : null;
  if (!command) {
    const { size } = await stat(blob);
    if (size > maxBytes) throw tooLarge();
    if (await fileDigest(blob, algorithm!) !== expected) throw new Error(`layer diff digest verification failed: ${digest}`);
    return size;
  }
  const hash = createHash(algorithm!);
  const child = spawn(command, ["-dc", "--", blob], { stdio: ["ignore", "pipe", "pipe"] });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} decompression failed: ${code}`)));
  });
  child.stderr.resume();
  // Attach a rejection handler immediately while stdout is being drained.
  void done.catch(() => undefined);
  let bytes = 0;
  for await (const chunk of child.stdout) {
    bytes += (chunk as Buffer).length;
    if (bytes > maxBytes) {
      child.kill();
      throw tooLarge();
    }
    hash.update(chunk);
  }
  await done;
  if (hash.digest("hex") !== expected) throw new Error(`layer diff digest verification failed: ${digest}`);
  return bytes;
}
