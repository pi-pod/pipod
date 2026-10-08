/**
 * Workspace seeding: git-clone and tar.gz extract into an empty pod workdir.
 * Inputs are validated and rate-limited here; the Python sources run inside the
 * sandbox and never take a credential on argv, in the URL, or in a file.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, open, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { allowsHost, isHostname, isIPv4, isIPv6 } from "../../core/egress.js";
import {
  HttpError,
  badRequest,
  conflict,
  forbidden,
  payloadTooLarge,
  tooManyRequests,
} from "../httperrors.js";
import type { Sandbox } from "../../core/providers/types.js";
import type { ResolvedConfigReport, WorkspaceSeedReport } from "./types.js";

export interface WorkspaceArchiveLimits {
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxEntries: number;
}

export const DEFAULT_WORKSPACE_ARCHIVE_LIMITS: WorkspaceArchiveLimits = {
  maxCompressedBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxEntries: 200_000,
};

/** Names of the env vars (parent adds them to env.ts with these exact keys and the defaults above). */
export function workspaceArchiveLimits(env: {
  WORKSPACE_ARCHIVE_MAX_COMPRESSED_BYTES?: number;
  WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES?: number;
  WORKSPACE_ARCHIVE_MAX_ENTRIES?: number;
}): WorkspaceArchiveLimits {
  return {
    maxCompressedBytes:
      env.WORKSPACE_ARCHIVE_MAX_COMPRESSED_BYTES ?? DEFAULT_WORKSPACE_ARCHIVE_LIMITS.maxCompressedBytes,
    maxUncompressedBytes:
      env.WORKSPACE_ARCHIVE_MAX_UNCOMPRESSED_BYTES ?? DEFAULT_WORKSPACE_ARCHIVE_LIMITS.maxUncompressedBytes,
    maxEntries: env.WORKSPACE_ARCHIVE_MAX_ENTRIES ?? DEFAULT_WORKSPACE_ARCHIVE_LIMITS.maxEntries,
  };
}

export const WorkspaceCloneCredentialSchema = z
  .object({
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(4096),
  })
  .strict();

const COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export const WorkspaceCloneBody = z
  .object({
    url: z
      .string()
      .min(1)
      .max(2048)
      .superRefine((value, ctx) => {
        try {
          parseCloneUrl(value);
        } catch (error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof HttpError ? error.message : "invalid clone url",
          });
        }
      }),
    branch: z
      .string()
      .min(1)
      .max(255)
      .superRefine((value, ctx) => {
        const message = gitRefNameError(value);
        if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      }),
    commit: z.string().regex(COMMIT_RE),
    credential: WorkspaceCloneCredentialSchema.optional(),
  })
  .strict();

export type WorkspaceCloneRequest = z.infer<typeof WorkspaceCloneBody>;
export type WorkspaceCloneCredential = z.infer<typeof WorkspaceCloneCredentialSchema>;

/** Lower-cased host (no port) of a validated clone URL, and the URL with any trailing whitespace stripped. */
export function parseCloneUrl(url: string): { host: string; url: string } {
  const stripped = url.trimEnd();
  if (stripped.length < 1 || stripped.length > 2048) {
    throw badRequest("clone url must be 1..2048 characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    throw badRequest("clone url is not a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw badRequest("clone url must use https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw badRequest("clone url must not contain credentials");
  }
  if (parsed.search !== "") {
    throw badRequest("clone url must not contain a query");
  }
  if (parsed.hash !== "") {
    throw badRequest("clone url must not contain a fragment");
  }
  const host = parsed.hostname.trim().toLowerCase();
  if (!host) throw badRequest("clone url must include a hostname");
  if (isIPv4(host) || isIPv6(host) || host.startsWith("[") || host.includes(":")) {
    throw badRequest("clone url must use a hostname, not an IP address");
  }
  if (!isHostname(host)) {
    throw badRequest("clone url hostname is not valid");
  }
  const pathParts = parsed.pathname.split("/").filter((part) => part !== "" && part !== ".");
  if (pathParts.length === 0) {
    throw badRequest("clone url path must be non-empty");
  }
  return { host, url: stripped };
}

/** Throw forbidden(...) when the pod's frozen egress is allowlist mode and allowsHost(config.egress.allow, host) is false. Open mode: no-op. */
export function assertCloneHostAllowed(
  report: Pick<ResolvedConfigReport, "config" | "egress">,
  host: string,
): void {
  if (report.egress?.mode !== "allowlist") return;
  const allow = report.config?.egress?.allow ?? [];
  if (!allowsHost(allow, host)) {
    throw forbidden(`clone host is not allowed by this pod's egress policy`);
  }
}

/** Replace every occurrence of credential.password (and credential.username when length >= 4) in text with "[redacted]". */
export function redactCredential(text: string, credential?: WorkspaceCloneCredential | null): string {
  if (!credential) return text;
  try {
    const secrets: string[] = [];
    const add = (value: string | undefined) => {
      if (!value) return;
      secrets.push(value);
      try {
        const encoded = encodeURIComponent(value);
        if (encoded !== value) secrets.push(encoded);
      } catch {
        // ignore
      }
    };
    add(credential.password);
    if (credential.username.length >= 4) add(credential.username);
    try {
      secrets.push(Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64"));
    } catch {
      // ignore
    }
    const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort((a, b) => b.length - a.length);
    let out = text;
    for (const secret of unique) {
      out = out.split(secret).join("[redacted]");
    }
    return out;
  } catch {
    return text;
  }
}

export const SEED_RATE_WINDOW_MS = 10 * 60_000;
export const SEED_RATE_MAX_REQUESTS = 10;
export const SEED_RATE_MAX_BYTES = 1024 * 1024 * 1024;

type RateBucket = { windowStart: number; requests: number; bytes: number };
const rateBuckets = new Map<string, RateBucket>();

export function resetWorkspaceSeedRateLimits(): void {
  rateBuckets.clear();
}

export function assertWorkspaceSeedRateLimit(key: string, bytes: number, now = Date.now()): void {
  const existing = rateBuckets.get(key);
  const bucket =
    !existing || now - existing.windowStart >= SEED_RATE_WINDOW_MS
      ? { windowStart: now, requests: 0, bytes: 0 }
      : existing;
  bucket.requests += 1;
  bucket.bytes += bytes;
  rateBuckets.set(key, bucket);
  if (bucket.requests > SEED_RATE_MAX_REQUESTS || bucket.bytes > SEED_RATE_MAX_BYTES) {
    throw tooManyRequests("workspace seed rate limit exceeded for this token");
  }
}

class ArchiveSpoolTransform extends Transform {
  bytes = 0;
  header = Buffer.alloc(0);

  constructor(private readonly maxCompressedBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.header.length < 2) {
      this.header = Buffer.concat([this.header, buf.subarray(0, 2 - this.header.length)]);
      if (this.header.length >= 2 && (this.header[0] !== 0x1f || this.header[1] !== 0x8b)) {
        callback(badRequest("archive is not gzip"));
        return;
      }
    }
    const next = this.bytes + buf.length;
    if (next > this.maxCompressedBytes) {
      callback(payloadTooLarge(`archive exceeds the ${this.maxCompressedBytes} byte compressed limit`));
      return;
    }
    this.bytes = next;
    callback(null, buf);
  }
}

/**
 * Stream `source` into a fresh 0600 temp file under os.tmpdir() named pi-pod-archive-<random>.tgz.
 * Enforce `maxCompressedBytes` while streaming: on overflow destroy the source, delete the file, throw payloadTooLarge.
 */
export async function spoolArchiveToTempFile(
  source: NodeJS.ReadableStream,
  opts: { maxCompressedBytes: number; declaredLength?: number | null; signal?: AbortSignal },
): Promise<{ path: string; bytes: number; cleanup: () => Promise<void> }> {
  if (typeof opts.declaredLength === "number" && opts.declaredLength > opts.maxCompressedBytes) {
    throw payloadTooLarge(`archive exceeds the ${opts.maxCompressedBytes} byte compressed limit`);
  }
  if (opts.signal?.aborted) {
    throw abortReason(opts.signal);
  }

  const filePath = path.join(tmpdir(), `pi-pod-archive-${randomBytes(16).toString("hex")}.tgz`);
  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    try {
      await unlink(filePath);
    } catch (error) {
      // The name is the only thing cleanup owns; anything but "already gone"
      // signals a real problem (and a possible leak), so surface it and leave
      // `removed` false so a later cleanup() can retry.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    removed = true;
  };

  const spooler = new ArchiveSpoolTransform(opts.maxCompressedBytes);
  const destroySource = () => {
    const readable = source as { destroy?: (err?: Error) => void };
    if (typeof readable.destroy === "function") readable.destroy();
  };

  let handle: FileHandle | undefined;
  let out: WriteStream | undefined;
  try {
    // Barrier-create the file before wiring the pipeline. createWriteStream opens
    // lazily by path, so an abort racing that async open could unlink (ENOENT,
    // ignored) and then have the late open recreate the file after cleanup ran,
    // leaking a temp file and stalling pipeline teardown. Holding the fd makes
    // creation observable, and the fd-backed stream itself can never recreate the
    // name after it is unlinked. The stream takes ownership of the handle via
    // autoClose; teardown below still awaits handle.close() unconditionally — a
    // no-op (already-closed error, ignored) when the stream took over, and the
    // real close when it never did.
    handle = await open(filePath, "wx", 0o600);
    if (opts.signal?.aborted) {
      throw abortReason(opts.signal);
    }
    out = createWriteStream(filePath, { fd: handle });
    await pipeline(source as unknown as Readable, spooler, out, { signal: opts.signal });
    if (spooler.bytes === 0) throw badRequest("archive is empty");
    if (spooler.header.length < 2 || spooler.header[0] !== 0x1f || spooler.header[1] !== 0x8b) {
      throw badRequest("archive is not gzip");
    }
    await chmod(filePath, 0o600);
    return { path: filePath, bytes: spooler.bytes, cleanup };
  } catch (error) {
    destroySource();
    out?.destroy();
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // already closed by the stream's autoClose
      }
    }
    try {
      await cleanup();
    } catch (cleanupError) {
      // Surface the unlink debt without changing the primary failure's HTTP
      // semantics (status/message stay intact): it rides along as `cause`.
      // Unlike direct cleanup() callers, this path hands nothing back, so a
      // failed cleanup here cannot be retried — it is recorded, not swallowed.
      if (error instanceof Error && error.cause === undefined) {
        error.cause = cleanupError;
      }
    }
    throw error;
  }
}

export const WORKSPACE_EMPTY_IGNORED: readonly string[] = ["lost+found"];

/** argv: workdir. Prints one JSON line {"empty": bool, "entries": [up to 10 names]} and exits 0. */
export function workspaceEmptyCheckSource(): string {
  return `import json, os, sys
IGNORED = set(${JSON.stringify([...WORKSPACE_EMPTY_IGNORED])})
workdir = sys.argv[1]
try:
    names = []
    with os.scandir(workdir) as it:
        for entry in it:
            if entry.name in IGNORED:
                continue
            names.append(entry.name)
    names.sort()
    print(json.dumps({"empty": len(names) == 0, "entries": names[:10]}, separators=(",", ":")))
except FileNotFoundError:
    print(json.dumps({"empty": True, "entries": [], "missing": True}, separators=(",", ":")))
`;
}

export function decodeWorkspaceEmptyCheck(output: string): { empty: boolean; entries: string[]; missing: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw badRequest("pod returned an invalid empty-check result");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("pod returned an invalid empty-check result");
  }
  const object = parsed as { empty?: unknown; entries?: unknown; missing?: unknown };
  if (typeof object.empty !== "boolean") throw badRequest("pod returned an invalid empty-check result");
  if (!Array.isArray(object.entries) || object.entries.some((entry) => typeof entry !== "string")) {
    throw badRequest("pod returned an invalid empty-check result");
  }
  if (object.missing !== undefined && typeof object.missing !== "boolean") {
    throw badRequest("pod returned an invalid empty-check result");
  }
  return {
    empty: object.empty,
    entries: object.entries as string[],
    missing: object.missing === true,
  };
}

/** Lists what the pod's workdir holds, judged exactly as the seed routes judge it. */
export async function inspectWorkdir(
  sandbox: Pick<Sandbox, "exec">,
  workdir: string,
): Promise<{ empty: boolean; entries: string[] }> {
  const checked = await sandbox.exec(["python3", "-c", workspaceEmptyCheckSource(), workdir], {
    timeoutMs: 60_000,
  });
  if (checked.exitCode !== 0) {
    throw badRequest(checked.output?.trim() || "workspace inspection failed");
  }
  const state = decodeWorkspaceEmptyCheck(checked.output ?? "");
  return { empty: state.empty, entries: state.entries };
}

/**
 * Seeds only fill an empty workdir, so one that init (or the image) already populated can never
 * take a seed. Settling that before the pod starts opens the gate with the pod, and the client
 * reads the outcome instead of building and uploading a seed the routes would refuse.
 */
export async function skipSeedIntoPopulatedWorkdir(
  sandbox: Pick<Sandbox, "exec">,
  workdir: string,
  seed: WorkspaceSeedReport,
): Promise<WorkspaceSeedReport> {
  if ((await inspectWorkdir(sandbox, workdir)).empty) return seed;
  return {
    requestedAt: seed.requestedAt,
    status: "skipped",
    finishedAt: new Date().toISOString(),
    reason: "the workspace was already populated when the pod started",
  };
}

/** Builds the 409 for a populated workdir. */
export function workspaceNotEmptyError(entries: string[]): HttpError {
  return conflict("workspace_not_empty", { code: "workspace_not_empty", entries });
}

/**
 * Clone script. argv: workdir, tmpdir, url, branch, commit.
 * Env (read by the script, set by the caller): PI_POD_GIT_USERNAME / PI_POD_GIT_PASSWORD (optional pair).
 */
export function workspaceCloneSource(): string {
  return `import errno, json, os, shutil, stat, subprocess, sys
IGNORED = set(${JSON.stringify([...WORKSPACE_EMPTY_IGNORED])})
GIT_TIMEOUT = 300
workdir, tmpdir, url, branch, commit = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
os.environ["GIT_TERMINAL_PROMPT"] = "0"
os.environ["GIT_ASKPASS"] = "/bin/true"
os.environ["SSH_ASKPASS"] = "true"
os.environ["GIT_SSH_COMMAND"] = "ssh -oBatchMode=yes"
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
os.environ["LC_ALL"] = "C"

def scrub(text):
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    secrets = []
    password = os.environ.get("PI_POD_GIT_PASSWORD") or ""
    user = os.environ.get("PI_POD_GIT_USERNAME") or ""
    if password:
        secrets.append(password)
    if user:
        secrets.append(user)
    try:
        from urllib.parse import quote
        if password:
            encoded = quote(password, safe="")
            if encoded != password:
                secrets.append(encoded)
        if user:
            encoded = quote(user, safe="")
            if encoded != user:
                secrets.append(encoded)
    except Exception:
        pass
    secrets.sort(key=len, reverse=True)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[redacted]")
    return text

def fail(message, code=1, entries=None):
    payload = {"error": scrub(message)}
    if entries is not None:
        payload["entries"] = entries
    print(json.dumps(payload, separators=(",", ":")), flush=True)
    raise SystemExit(code)

def scandir_names(directory, ignore=False):
    names = []
    with os.scandir(directory) as it:
        for entry in it:
            if ignore and entry.name in IGNORED:
                continue
            names.append(entry.name)
    names.sort()
    return names

def workdir_state(directory):
    try:
        names = scandir_names(directory, ignore=True)
    except FileNotFoundError:
        return True, [], True
    except NotADirectoryError:
        fail("workdir is not a directory")
    return len(names) == 0, names, False

def run_git(args):
    try:
        proc = subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=GIT_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        fail("git timed out")
    return proc.returncode, scrub(proc.stdout or ""), scrub(proc.stderr or "")

def remove_path(target):
    try:
        info = os.lstat(target)
    except OSError:
        return
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        shutil.rmtree(target, ignore_errors=True)
    else:
        try:
            os.unlink(target)
        except OSError:
            pass

def move_entries(src, dest):
    moved = []
    try:
        for name in scandir_names(src, ignore=False):
            from_path = os.path.join(src, name)
            to_path = os.path.join(dest, name)
            try:
                os.rename(from_path, to_path)
            except OSError as exc:
                if exc.errno == errno.EXDEV:
                    shutil.move(from_path, to_path)
                else:
                    raise
            moved.append(name)
    except BaseException:
        for name in moved:
            remove_path(os.path.join(dest, name))
        raise
    return len(moved)

def main():
    empty, entries, missing = workdir_state(workdir)
    if not empty:
        fail("workspace_not_empty", 3, entries[:10])
    if missing:
        os.makedirs(workdir, mode=0o755)
    os.makedirs(tmpdir, mode=0o700, exist_ok=True)
    os.chmod(tmpdir, 0o700)
    repo = os.path.join(tmpdir, "repo")
    # Every network command (the clone, and the fetch that chases a tip that moved since the
    # client probed) gets the same per-invocation helper; nothing is ever written to config.
    git_net = ["git", "-c", "credential.helper="]
    if (os.environ.get("PI_POD_GIT_USERNAME") or "") and (os.environ.get("PI_POD_GIT_PASSWORD") or ""):
        git_net += ["-c", "credential.helper=!f() { printf 'username=%s\\\\npassword=%s\\\\n' \\"$PI_POD_GIT_USERNAME\\" \\"$PI_POD_GIT_PASSWORD\\"; }; f"]
    git_net += ["-c", "core.askPass=true"]
    cmd = git_net + ["clone", "--branch", branch, "--single-branch", "--no-tags", "--", url, repo]
    code, stdout, stderr = run_git(cmd)
    if code != 0:
        fail("git clone failed: " + ((stderr or stdout or ("exit %s" % code))[:2000]))
    code, head, stderr = run_git(["git", "-C", repo, "rev-parse", "HEAD"])
    if code != 0:
        fail("git rev-parse HEAD failed: " + (stderr[:2000]))
    head = head.strip()
    if head != commit:
        code, _, stderr = run_git(["git", "-C", repo, "cat-file", "-e", commit + "^{commit}"])
        if code != 0:
            code, _, stderr = run_git(git_net + ["-C", repo, "fetch", "--", "origin", commit])
            if code != 0:
                fail("git fetch failed: " + (stderr[:2000]))
        code, _, stderr = run_git(["git", "-C", repo, "reset", "--hard", commit])
        if code != 0:
            fail("git reset failed: " + (stderr[:2000]))
        code, head, stderr = run_git(["git", "-C", repo, "rev-parse", "HEAD"])
        if code != 0 or head.strip() != commit:
            fail("HEAD does not match the requested commit")
        head = head.strip()
    code, current, stderr = run_git(["git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])
    if code != 0:
        fail("git rev-parse --abbrev-ref HEAD failed: " + (stderr[:2000]))
    if current.strip() != branch:
        fail("checked-out branch does not match the requested branch")
    code, _, _ = run_git(["git", "-C", repo, "config", "--unset-all", "credential.helper"])
    if code not in (0, 5):
        pass
    empty, entries, missing = workdir_state(workdir)
    if not empty:
        fail("workspace_not_empty", 3, entries[:10])
    if missing:
        os.makedirs(workdir, mode=0o755)
    count = move_entries(repo, workdir)
    print(json.dumps({"ok": True, "commit": head, "entries": count}, separators=(",", ":")), flush=True)

try:
    main()
except SystemExit:
    raise
except Exception as exc:
    fail(str(exc)[:2000])
finally:
    shutil.rmtree(tmpdir, ignore_errors=True)
`;
}

export function decodeWorkspaceCloneResult(output: string): { commit: string; entries: number } {
  const object = parseLastJsonObject(output, "pod returned an invalid clone result");
  throwIfSeedError(object);
  const commit = object.commit;
  const entries = object.entries;
  if (typeof commit !== "string" || commit.length === 0 || !Number.isInteger(entries) || (entries as number) < 0) {
    throw badRequest("pod returned an invalid clone result");
  }
  return { commit, entries: entries as number };
}

/**
 * Archive extraction script. argv: workdir, archivePath, staging, maxUncompressedBytes, maxEntries, allowSymlinks ("1"/"0").
 * Streams the tar.gz with tarfile.open(mode="r|gz") (never r:gz, never extractall).
 */
export function workspaceArchiveExtractSource(): string {
  return `import errno, json, os, shutil, stat, sys, tarfile
IGNORED = set(${JSON.stringify([...WORKSPACE_EMPTY_IGNORED])})
CHUNK = 1024 * 1024
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
workdir, archive_path, staging, max_uncompressed_s, max_entries_s, allow_symlinks_s = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
try:
    max_uncompressed = int(max_uncompressed_s)
    max_entries = int(max_entries_s)
except ValueError:
    print(json.dumps({"error": "invalid archive limits"}, separators=(",", ":")))
    raise SystemExit(1)
allow_symlinks = allow_symlinks_s == "1"
tree = os.path.join(staging, "tree")

def fail(message, code=1, entries=None):
    payload = {"error": message}
    if entries is not None:
        payload["entries"] = entries
    print(json.dumps(payload, separators=(",", ":")), flush=True)
    raise SystemExit(code)

def scandir_names(directory, ignore=False):
    names = []
    with os.scandir(directory) as it:
        for entry in it:
            if ignore and entry.name in IGNORED:
                continue
            names.append(entry.name)
    names.sort()
    return names

def workdir_state(directory):
    try:
        names = scandir_names(directory, ignore=True)
    except FileNotFoundError:
        return True, [], True
    except NotADirectoryError:
        fail("workdir is not a directory")
    return len(names) == 0, names, False

def remove_path(target):
    try:
        info = os.lstat(target)
    except OSError:
        return
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        shutil.rmtree(target, ignore_errors=True)
    else:
        try:
            os.unlink(target)
        except OSError:
            pass

def move_entries(src, dest):
    moved = []
    try:
        for name in scandir_names(src, ignore=False):
            from_path = os.path.join(src, name)
            to_path = os.path.join(dest, name)
            try:
                os.rename(from_path, to_path)
            except OSError as exc:
                if exc.errno == errno.EXDEV:
                    shutil.move(from_path, to_path)
                else:
                    raise
            moved.append(name)
    except BaseException:
        for name in moved:
            remove_path(os.path.join(dest, name))
        raise
    return len(moved)

def normalize_name(name):
    if name is None or name == "" or "\\0" in name:
        fail("archive member has an unsafe path")
    if name.startswith("/") or name.startswith("\\\\"):
        fail("archive member has an unsafe path")
    parts = []
    for part in name.split("/"):
        if part == "" or part == ".":
            continue
        if part == "..":
            fail("archive member has an unsafe path")
        parts.append(part)
    return "/".join(parts)

def symlink_escapes(rel, target):
    if target.startswith("/") or target.startswith("\\\\") or "\\0" in target:
        return True
    dest_dir = rel[:rel.rfind("/")] if "/" in rel else ""
    parts = (dest_dir.split("/") if dest_dir else []) + target.split("/")
    depth = 0
    for part in parts:
        if part == "" or part == ".":
            continue
        if part == "..":
            depth -= 1
            if depth < 0:
                return True
            continue
        depth += 1
    return False

def through_symlink(rel, created_symlinks):
    parts = rel.split("/")
    acc = []
    for part in parts[:-1]:
        acc.append(part)
        prefix = "/".join(acc)
        if prefix in created_symlinks:
            return True
        disk = os.path.join(tree, *acc)
        try:
            info = os.lstat(disk)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            return True
    return False

def with_parent(rel, fn):
    parts = [part for part in rel.split("/") if part]
    if not parts:
        fail("archive member has an unsafe path")
    dirfd = os.open(tree, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                info = os.stat(part, dir_fd=dirfd, follow_symlinks=False)
            except FileNotFoundError:
                os.mkdir(part, 0o755, dir_fd=dirfd)
                info = os.stat(part, dir_fd=dirfd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                fail("archive member path traverses a symlink")
            if not stat.S_ISDIR(info.st_mode):
                fail("archive member path conflicts with a non-directory")
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=dirfd)
            os.close(dirfd)
            dirfd = next_fd
        return fn(dirfd, parts[-1])
    finally:
        try:
            os.close(dirfd)
        except OSError:
            pass

def extract_file(member, dest_rel, total):
    source = tar.extractfile(member)
    if source is None:
        fail("archive member could not be read")
    mode = member.mode & 0o777 if getattr(member, "mode", None) is not None else 0o644
    header_size = member.size if getattr(member, "size", None) else 0
    if header_size < 0 or total + header_size > max_uncompressed:
        fail("archive exceeds the uncompressed size limit")
    def create(dirfd, name):
        return os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=dirfd)
    fd = with_parent(dest_rel, create)
    copied = 0
    try:
        while True:
            chunk = source.read(CHUNK)
            if not chunk:
                break
            copied += len(chunk)
            if total + copied > max_uncompressed:
                fail("archive exceeds the uncompressed size limit")
            os.write(fd, chunk)
        os.fchmod(fd, mode)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            source.close()
        except Exception:
            pass
    return copied

def extract_dir(member, dest_rel):
    mode = 0o755 | (member.mode & 0o777 if getattr(member, "mode", None) is not None else 0)
    def create(dirfd, name):
        try:
            os.mkdir(name, 0o755, dir_fd=dirfd)
        except FileExistsError:
            info = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                fail("archive member path traverses a symlink")
            if not stat.S_ISDIR(info.st_mode):
                fail("archive member path conflicts with a non-directory")
        os.chmod(name, mode, dir_fd=dirfd)
        return None
    with_parent(dest_rel, create)

def extract_symlink(member, dest_rel, created_symlinks):
    target = member.linkname or ""
    if not allow_symlinks:
        fail("archive contains a symlink")
    if target == "" or symlink_escapes(dest_rel, target):
        fail("symlink target escapes the archive")
    def create(dirfd, name):
        os.symlink(target, name, dir_fd=dirfd)
        return None
    with_parent(dest_rel, create)
    created_symlinks.add(dest_rel)

created_symlinks = set()
entry_count = 0
total_bytes = 0
try:
    os.makedirs(tree, mode=0o700, exist_ok=True)
    try:
        tar = tarfile.open(archive_path, mode="r|gz")
    except (tarfile.TarError, OSError, EOFError) as exc:
        fail("archive is truncated or corrupt")
    try:
        for member in tar:
            name = member.name if isinstance(member.name, str) else ""
            dest_rel = normalize_name(name)
            if dest_rel == "":
                if member.isdir():
                    continue
                fail("archive member has an unsafe path")
            if through_symlink(dest_rel, created_symlinks):
                fail("archive member path traverses a symlink")
            entry_count += 1
            if entry_count > max_entries:
                fail("archive exceeds the %s entry limit" % max_entries)
            pax_types = {getattr(tarfile, "XGLTYPE", b"g"), getattr(tarfile, "XHDTYPE", b"x")}
            if member.type in pax_types:
                continue
            if member.isdir():
                extract_dir(member, dest_rel)
            elif member.issym():
                extract_symlink(member, dest_rel, created_symlinks)
            elif member.isfile():
                total_bytes += extract_file(member, dest_rel, total_bytes)
            elif member.islnk() or member.type in (
                tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE,
            ):
                if member.islnk() or member.type == tarfile.LNKTYPE:
                    fail("archive contains a hard link")
                if member.type == tarfile.CHRTYPE or member.type == tarfile.BLKTYPE:
                    fail("archive contains a device node")
                if member.type == tarfile.FIFOTYPE:
                    fail("archive contains a fifo")
                fail("archive contains an unsupported member type")
            else:
                fail("archive contains an unsupported member type")
    except SystemExit:
        raise
    except (tarfile.TarError, OSError, EOFError):
        fail("archive is truncated or corrupt")
    finally:
        try:
            tar.close()
        except Exception:
            pass
    empty, entries, missing = workdir_state(workdir)
    if not empty:
        fail("workspace_not_empty", 3, entries[:10])
    if missing:
        os.makedirs(workdir, mode=0o755)
    move_entries(tree, workdir)
    print(json.dumps({"entries": entry_count, "bytes": total_bytes}, separators=(",", ":")), flush=True)
except SystemExit:
    raise
except Exception as exc:
    fail(str(exc)[:2000])
finally:
    shutil.rmtree(staging, ignore_errors=True)
    try:
        os.unlink(archive_path)
    except OSError:
        shutil.rmtree(archive_path, ignore_errors=True)
`;
}

export function decodeWorkspaceArchiveResult(output: string): { entries: number; bytes: number } {
  const object = parseLastJsonObject(output, "pod returned an invalid archive result");
  throwIfSeedError(object);
  const entries = object.entries;
  const bytes = object.bytes;
  if (!Number.isInteger(entries) || (entries as number) < 0 || !Number.isInteger(bytes) || (bytes as number) < 0) {
    throw badRequest("pod returned an invalid archive result");
  }
  return { entries: entries as number, bytes: bytes as number };
}

export function cloneAuditDetail(args: {
  host: string;
  branch: string;
  commit: string;
  credentialed: boolean;
  entries?: number;
  durationMs: number;
  fromPod?: string | null;
}): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    host: args.host,
    branch: args.branch,
    commit: args.commit,
    credentialed: args.credentialed,
    durationMs: args.durationMs,
  };
  if (args.entries !== undefined) detail.entries = args.entries;
  if (args.fromPod) detail.fromPod = args.fromPod;
  return detail;
}

export function archiveAuditDetail(args: {
  bytes: number;
  entries: number;
  uncompressedBytes?: number;
  durationMs: number;
  fromPod?: string | null;
}): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    bytes: args.bytes,
    entries: args.entries,
    durationMs: args.durationMs,
  };
  if (args.uncompressedBytes !== undefined) detail.uncompressedBytes = args.uncompressedBytes;
  if (args.fromPod) detail.fromPod = args.fromPod;
  return detail;
}

export const WORKSPACE_SEED_GATE_TIMEOUT_MS = 10 * 60_000;

/**
 * Seed gate: a launch flagged workspaceSeed defers Pi until the client has seeded (status
 * pending), and a seed in flight (status seeding) holds it too so Pi never boots into a
 * half-extracted tree. Returns true when Pi may start: no workspaceSeed on the report, a
 * settled status, or requestedAt + timeoutMs <= now (the abandoned-launch escape hatch).
 */
export function workspaceSeedGateOpen(
  report: { workspaceSeed?: { status: string; requestedAt: string } | null } | null | undefined,
  now = Date.now(),
  timeoutMs = WORKSPACE_SEED_GATE_TIMEOUT_MS,
): boolean {
  const seed = report?.workspaceSeed;
  if (!seed) return true;
  if (seed.status !== "pending" && seed.status !== "seeding") return true;
  const requested = Date.parse(seed.requestedAt);
  if (!Number.isFinite(requested)) return true;
  return requested + timeoutMs <= now;
}

function gitRefNameError(branch: string): string | null {
  if (branch.length < 1 || branch.length > 255) return "branch must be 1..255 characters";
  if (branch.startsWith("-") || branch.startsWith("/") || branch.startsWith("refs/")) {
    return "branch is not a valid git ref name";
  }
  if (branch.includes("..") || branch.includes("@{") || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) {
    return "branch is not a valid git ref name";
  }
  for (let i = 0; i < branch.length; i += 1) {
    const code = branch.charCodeAt(i);
    if (code < 32 || code === 127) return "branch is not a valid git ref name";
    const ch = branch[i]!;
    if (ch === " " || ch === "~" || ch === "^" || ch === ":" || ch === "?" || ch === "*" || ch === "[" || ch === "\\") {
      return "branch is not a valid git ref name";
    }
  }
  return null;
}

function parseLastJsonObject(output: string, malformed: string): Record<string, unknown> {
  const lines = output.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line === "" || !line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  throw badRequest(malformed);
}

function throwIfSeedError(object: Record<string, unknown>): void {
  if (typeof object.error !== "string") return;
  if (object.error === "workspace_not_empty") {
    const entries = Array.isArray(object.entries)
      ? object.entries.filter((entry): entry is string => typeof entry === "string")
      : [];
    throw workspaceNotEmptyError(entries);
  }
  throw badRequest(object.error);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("aborted");
}
