/**
 * Hardened account-mode file transfer: canonical base64, path containment, no-follow
 * placement and collection, bounded payloads, and per-token rate limits. Authorization
 * is the caller's job and must complete before wake or filesystem access.
 */
import { badRequest, payloadTooLarge, tooManyRequests } from "../httperrors.js";

export const SEND_MAX_BYTES = 24 * 1024 * 1024;
export const SEND_MAX_ENTRIES = 10_000;
export const SEND_RATE_WINDOW_MS = 60_000;
export const SEND_RATE_MAX_REQUESTS = 30;
export const SEND_RATE_MAX_BYTES = 50 * 1024 * 1024;

export type SendEntry = {
  relPath: string;
  kind: "file" | "dir" | "symlink";
  contents?: string;
  mode?: number;
  target?: string;
};

export type ReceiveEntry = {
  relPath: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  size?: number;
  target?: string;
  contents?: string;
  sha256?: string;
};

export function assertSafeRelPath(relPath: string): void {
  if (relPath === "") return;
  if (relPath.startsWith("/") || relPath.split("/").includes("..") || relPath.includes("\0")) {
    throw badRequest(`unsafe path in send: ${relPath}`);
  }
}

/** Receive paths are always named entries relative to the pod workdir. */
export function assertSafeReceivePath(relPath: string): void {
  assertSafeRelPath(relPath);
  const useful = relPath.split("/").filter((part) => part !== "" && part !== ".");
  if (useful.length === 0) throw badRequest("receive path must name a file or directory inside the workdir");
}

/** Reject non-canonical base64 so decoded size cannot disagree with the wire form. */
export function decodeCanonicalBase64(contents: string, relPath: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contents) || contents.length % 4 !== 0) {
    throw badRequest(`invalid base64 in send: ${relPath}`);
  }
  const decoded = Buffer.from(contents, "base64");
  if (decoded.toString("base64") !== contents) {
    throw badRequest(`non-canonical base64 in send: ${relPath}`);
  }
  return decoded;
}

export function assertSendEntriesWithinLimit(
  entries: ReadonlyArray<{ kind: string; contents?: string; relPath?: string }>,
) : number {
  if (entries.length > SEND_MAX_ENTRIES) {
    throw badRequest(`send exceeds the ${SEND_MAX_ENTRIES} entry limit`);
  }
  let bytes = 0;
  for (const entry of entries) {
    if (entry.relPath !== undefined) assertSafeRelPath(entry.relPath);
    if (entry.kind !== "file") continue;
    const decoded = decodeCanonicalBase64(entry.contents ?? "", entry.relPath ?? "file");
    bytes += decoded.length;
    if (bytes > SEND_MAX_BYTES) {
      throw payloadTooLarge(`send exceeds the ${Math.floor(SEND_MAX_BYTES / (1024 * 1024))} MB limit`);
    }
  }
  return bytes;
}

export function symlinkEscapesWorkdir(relPath: string, target: string): boolean {
  if (target.startsWith("/") || target.includes("\0")) return true;
  const destDir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const parts = [...(destDir ? destDir.split("/") : []), ...target.split("/")];
  let depth = 0;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }
  return false;
}

/** A received link must stay inside the received directory tree; a root link has no safe tree. */
export function symlinkEscapesReceiveRoot(relPath: string, target: string): boolean {
  return relPath === "" || symlinkEscapesWorkdir(relPath, target);
}

export function decodeReceiveManifest(output: string): { entries: ReceiveEntry[]; bytes: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw badRequest("pod returned an invalid receive manifest");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("pod returned an invalid receive manifest");
  }
  const object = parsed as { error?: unknown; entries?: unknown };
  if (typeof object.error === "string") throw badRequest(object.error);
  if (!Array.isArray(object.entries) || object.entries.length === 0) {
    throw badRequest("pod returned an empty receive manifest");
  }
  if (object.entries.length > SEND_MAX_ENTRIES) {
    throw payloadTooLarge(`receive exceeds the ${SEND_MAX_ENTRIES} entry limit`);
  }

  const entries: ReceiveEntry[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const raw of object.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("pod returned an invalid receive entry");
    const entry = raw as Record<string, unknown>;
    const relPath = entry.relPath;
    const kind = entry.kind;
    const mode = entry.mode;
    if (typeof relPath !== "string" || relPath.length > 1024) throw badRequest("pod returned an invalid receive path");
    assertSafeRelPath(relPath);
    if (relPath !== "" && relPath.split("/").some((part) => part === "" || part === ".")) {
      throw badRequest(`pod returned an invalid receive path: ${relPath}`);
    }
    if (seen.has(relPath)) throw badRequest(`pod returned duplicate receive path: ${relPath || "."}`);
    seen.add(relPath);
    if (kind !== "file" && kind !== "dir" && kind !== "symlink") {
      throw badRequest(`pod returned an unsupported entry: ${relPath || "."}`);
    }
    if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777) {
      throw badRequest(`pod returned an invalid mode: ${relPath || "."}`);
    }
    const checked: ReceiveEntry = { relPath, kind, mode: mode as number };
    if (kind === "file") {
      if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
        throw badRequest(`pod returned an invalid file size: ${relPath || "."}`);
      }
      checked.size = entry.size as number;
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw badRequest(`pod returned an invalid file digest: ${relPath || "."}`);
      }
      checked.sha256 = entry.sha256;
      bytes += checked.size;
      if (bytes > SEND_MAX_BYTES) {
        throw payloadTooLarge(`receive exceeds the ${Math.floor(SEND_MAX_BYTES / (1024 * 1024))} MB limit`);
      }
    } else if (kind === "symlink") {
      if (typeof entry.target !== "string" || entry.target === "" || entry.target.length > 4096) {
        throw badRequest(`pod returned an invalid symlink: ${relPath || "."}`);
      }
      if (symlinkEscapesReceiveRoot(relPath, entry.target)) {
        throw badRequest(`symlink ${relPath || "."} escapes the received tree`);
      }
      checked.target = entry.target;
    }
    entries.push(checked);
  }
  if (entries[0]?.relPath !== "" || !seen.has("")) throw badRequest("pod receive manifest has no root entry");
  if (entries.length > 1 && entries[0]!.kind !== "dir") {
    throw badRequest("pod receive manifest has children beneath a non-directory root");
  }
  return { entries, bytes };
}

type RateBucket = { windowStart: number; requests: number; bytes: number };
const rateBuckets = new Map<string, RateBucket>();

export function resetSendRateLimits(): void {
  rateBuckets.clear();
}

export function assertSendRateLimit(key: string, bytes: number, now = Date.now()): void {
  assertTransferRateLimit(`send:${key}`, bytes, "send", now);
}

export function assertReceiveRateLimit(key: string, bytes: number, now = Date.now()): void {
  assertTransferRateLimit(`receive:${key}`, bytes, "receive", now);
}

function assertTransferRateLimit(key: string, bytes: number, action: "send" | "receive", now: number): void {
  const existing = rateBuckets.get(key);
  const bucket =
    !existing || now - existing.windowStart >= SEND_RATE_WINDOW_MS
      ? { windowStart: now, requests: 0, bytes: 0 }
      : existing;
  bucket.requests += 1;
  bucket.bytes += bytes;
  rateBuckets.set(key, bucket);
  if (bucket.requests > SEND_RATE_MAX_REQUESTS || bucket.bytes > SEND_RATE_MAX_BYTES) {
    throw tooManyRequests(`${action} rate limit exceeded for this token`);
  }
}

/** Python collector: dirfd-only walk plus a bounded, hashed snapshot of regular files. */
export function receiveManifestSource(): string {
  return `import hashlib, json, os, stat, sys
workdir, requested, staging = os.path.realpath(sys.argv[1]), sys.argv[2], sys.argv[3]
entries = []
total_bytes = 0
no_follow = getattr(os, "O_NOFOLLOW", 0)
directory_flags = os.O_RDONLY | os.O_DIRECTORY | no_follow
os.makedirs(os.path.join(staging, "tree"), mode=0o700, exist_ok=True)

def fail(message):
    print(json.dumps({"error": message}, separators=(",", ":")))
    raise SystemExit(0)

def snapshot_file(parent_fd, name, rel, mode):
    global total_bytes
    try:
        descriptor = os.open(name, os.O_RDONLY | no_follow, dir_fd=parent_fd)
    except OSError:
        fail("receive file changed while it was being read: " + (rel or requested))
    with os.fdopen(descriptor, "rb", closefd=True) as source:
        current = os.fstat(source.fileno())
        if not stat.S_ISREG(current.st_mode):
            fail("receive file changed while it was being read: " + (rel or requested))
        size = current.st_size
        if total_bytes + size > ${SEND_MAX_BYTES}:
            fail("receive exceeds the ${Math.floor(SEND_MAX_BYTES / (1024 * 1024))} MB limit")
        staged = os.path.join(staging, "root" if rel == "" else os.path.join("tree", *rel.split("/")))
        os.makedirs(os.path.dirname(staged), mode=0o700, exist_ok=True)
        copied = 0
        digest = hashlib.sha256()
        with open(staged, "xb") as destination:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                copied += len(chunk)
                if total_bytes + copied > ${SEND_MAX_BYTES}:
                    fail("receive exceeds the ${Math.floor(SEND_MAX_BYTES / (1024 * 1024))} MB limit")
                digest.update(chunk)
                destination.write(chunk)
        if copied != size:
            fail("receive file changed while it was being read: " + (rel or requested))
        os.chmod(staged, 0o600)
        total_bytes += copied
        entries.append({"relPath": rel, "kind": "file", "mode": mode, "size": copied, "sha256": digest.hexdigest()})

def visit(parent_fd, name, rel):
    try:
        item = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        fail("receive path changed while it was being read")
    mode = stat.S_IMODE(item.st_mode)
    if stat.S_ISREG(item.st_mode):
        snapshot_file(parent_fd, name, rel, mode)
    elif stat.S_ISDIR(item.st_mode):
        entries.append({"relPath": rel, "kind": "dir", "mode": mode})
        try:
            directory_fd = os.open(name, directory_flags, dir_fd=parent_fd)
        except OSError:
            fail("receive directory changed while it was being read: " + (rel or requested))
        try:
            for child in sorted(os.listdir(directory_fd)):
                child_rel = child if rel == "" else rel + "/" + child
                visit(directory_fd, child, child_rel)
        finally:
            os.close(directory_fd)
    elif stat.S_ISLNK(item.st_mode):
        entries.append({"relPath": rel, "kind": "symlink", "mode": mode, "target": os.readlink(name, dir_fd=parent_fd)})
    else:
        fail("receive supports only regular files, directories, and symbolic links")
    if len(entries) > ${SEND_MAX_ENTRIES}:
        fail("receive exceeds the ${SEND_MAX_ENTRIES} entry limit")

parts = [part for part in requested.split("/") if part not in ("", ".")]
if not parts or any(part == ".." for part in parts):
    fail("receive path escapes the workdir")
try:
    parent_fd = os.open(workdir, directory_flags)
except OSError:
    fail("pod workdir is unavailable")
try:
    for part in parts[:-1]:
        try:
            next_fd = os.open(part, directory_flags, dir_fd=parent_fd)
        except OSError:
            fail("receive path traverses a symlink or missing directory: " + requested)
        os.close(parent_fd)
        parent_fd = next_fd
    visit(parent_fd, parts[-1], "")
finally:
    os.close(parent_fd)
print(json.dumps({"entries": entries}, separators=(",", ":")))
`;
}

export function posixJoin(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

export function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

/** Python placer: no-follow path walk, isolated staging, atomic replace. */
export function sendPlacerSource(): string {
  return `import os, sys, json, stat, shutil
workdir, staging, manifest_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(manifest_path, "r", encoding="utf-8") as f:
    entries = json.load(f)

def check_components(path):
    cur = "/"
    for part in path.strip("/").split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            raise SystemExit("unsafe path")
        nxt = os.path.join(cur, part)
        try:
            st = os.lstat(nxt)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(st.st_mode):
            raise SystemExit("refusing to write through symlink: " + nxt)
        cur = nxt

for entry in entries:
    dest = os.path.join(workdir, entry["relPath"])
    if not os.path.abspath(dest).startswith(os.path.abspath(workdir) + os.sep) and os.path.abspath(dest) != os.path.abspath(workdir):
        raise SystemExit("path escaped workdir")
    check_components(dest)
    if os.path.lexists(dest) and os.path.islink(dest):
        raise SystemExit("refusing to replace symlink: " + dest)
    if entry["kind"] == "dir":
        os.makedirs(dest, exist_ok=True)
        continue
    parent = os.path.dirname(dest)
    os.makedirs(parent, exist_ok=True)
    src = os.path.join(staging, entry["relPath"])
    if entry["kind"] == "symlink":
        raise SystemExit("symlink entries must be rejected before placement")
    mode = int(entry["mode"]) & 0o777 if entry.get("mode") is not None else stat.S_IMODE(os.lstat(src).st_mode)
    # Staging and the workdir are not guaranteed to be on the same filesystem, so a rename
    # between them may fail outright. Copy alongside the destination and
    # swap from there, which is a same-directory rename and therefore still atomic.
    partial = dest + ".pi-pod-partial"
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with open(fd, "wb") as out, open(src, "rb") as inp:
            shutil.copyfileobj(inp, out)
        os.chmod(partial, mode)
        os.replace(partial, dest)
    except BaseException:
        try:
            os.unlink(partial)
        except OSError:
            pass
        raise
    os.unlink(src)
`;
}
