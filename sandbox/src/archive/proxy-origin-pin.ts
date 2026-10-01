import * as constants from "node:constants";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createProxyStore } from "./proxystore.js";
import type { ObjectStore } from "./types.js";

/**
 * Runtime-side archive proxy origin pin (GAP-1).
 *
 * Deep module: the interface is `canonicalizeProxyOrigin`, `proxyBindingPath`,
 * `createPinnedProxyStore`, plus the producer helper `writeProxyBindingAtomic`.
 * Everything else (bounded reads, stat checks, canonical comparison) is hidden.
 *
 * The binding is provisioning-owned, persistent JSON at a fixed stateDir-derived
 * path. Proxy fails closed before any HTTP when the binding is absent, invalid,
 * or mismatched. No trust-on-first-use, no automatic mint, no env-controlled
 * bypass: the env URL is only compared against the binding, never trusted alone.
 *
 * Read discipline: ONE synchronous bounded fd reader. The constructor reads once
 * (fail fast at activation); the per-request guard runs inside the raw transport
 * AFTER async PUT prep (stat/stream setup), adjacent to `fetch` with no await
 * between, so a binding deleted during prep still blocks with no send.
 */

export const PROXY_BINDING_VERSION = 1 as const;
export const PROXY_BINDING_FILENAME = "archive-proxy-binding.json";
/** Upper bound for the binding file; the real file is ~100 bytes. */
export const PROXY_BINDING_MAX_BYTES = 8192;

export type ProxyOriginPinCode =
  | "archive_proxy_origin_missing"
  | "archive_proxy_origin_invalid"
  | "archive_proxy_origin_mismatch"
  | "archive_proxy_origin_config_invalid";

export class ProxyOriginPinError extends Error {
  readonly code: ProxyOriginPinCode;
  constructor(code: ProxyOriginPinCode, message: string) {
    super(message);
    this.name = "ProxyOriginPinError";
    this.code = code;
  }
}

function missing(): never {
  throw new ProxyOriginPinError(
    "archive_proxy_origin_missing",
    "archive proxy origin pin is missing for this host (archive_proxy_origin_missing)",
  );
}

function invalid(): never {
  throw new ProxyOriginPinError(
    "archive_proxy_origin_invalid",
    "archive proxy origin pin is invalid for this host (archive_proxy_origin_invalid)",
  );
}

function mismatch(): never {
  throw new ProxyOriginPinError(
    "archive_proxy_origin_mismatch",
    "archive proxy origin does not match the pinned origin for this host (archive_proxy_origin_mismatch)",
  );
}

function badConfig(): never {
  throw new ProxyOriginPinError(
    "archive_proxy_origin_config_invalid",
    "archive proxy origin configuration is invalid for this host (archive_proxy_origin_config_invalid)",
  );
}

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** Fixed stateDir-derived path. No env override, no alternate pin location. */
export function proxyBindingPath(stateDir: string): string {
  return path.join(path.resolve(stateDir), PROXY_BINDING_FILENAME);
}

function parseOriginUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    return badConfig();
  }
}

/**
 * Canonicalize a bare proxy origin to `scheme://host[:port]`.
 *
 * Strict pre-parse rejects on the RAW string (before `new URL` can normalize
 * anything away): control/whitespace, `?`, `#`, userinfo `@`, and any path that
 * is not exactly empty or `/` (so `/../`, `/%2e%2e/`, `/.`, `/prefix` are all
 * rejected rather than normalized — the producer shape stays unambiguous).
 * Then: scheme `https:`, or `http:` for loopback test only; scheme+host
 * lowercased; default ports omitted; IPv6 bracketed; no trailing slash.
 *
 * Throws ProxyOriginPinError (config_invalid) with no URL/token echo.
 */
export function canonicalizeProxyOrigin(input: unknown): string {
  if (typeof input !== "string") badConfig();
  if (input.length === 0 || input.length > 2048) badConfig();
  if (/[\u0000-\u0020\u007f]/.test(input)) badConfig();
  if (input.includes("?") || input.includes("#")) badConfig();
  const schemeEnd = input.indexOf("://");
  if (schemeEnd <= 0) badConfig();
  const afterScheme = input.slice(schemeEnd + 3);
  const slashAt = afterScheme.indexOf("/");
  const authority = slashAt === -1 ? afterScheme : afterScheme.slice(0, slashAt);
  const rest = slashAt === -1 ? "" : afterScheme.slice(slashAt);
  if (authority === "" || authority.includes("@")) badConfig();
  if (rest !== "" && rest !== "/") badConfig();
  const url = parseOriginUrl(input);
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") badConfig();
  if (url.username !== "" || url.password !== "") badConfig();
  if (url.search !== "" || url.hash !== "") badConfig();
  if (url.pathname !== "" && url.pathname !== "/") badConfig();
  if (url.hostname.length === 0) badConfig();
  const lowerHost = url.hostname.toLowerCase();
  if (protocol === "http:" && !LOOPBACK_HOSTS.has(lowerHost)) badConfig();
  const port = url.port;
  const hostPart = lowerHost.includes(":") && !lowerHost.startsWith("[") ? `[${lowerHost}]` : lowerHost;
  return `${protocol}//${hostPart}${port === "" ? "" : `:${port}`}`;
}

export interface ProxyOriginBinding {
  version: typeof PROXY_BINDING_VERSION;
  hostId: string;
  /** Canonical bare origin (`scheme://host[:port]`), no path. */
  origin: string;
}

function parseBindingBuffer(buf: Buffer): ProxyOriginBinding {
  let obj: unknown;
  try {
    obj = JSON.parse(buf.toString("utf8"));
  } catch {
    invalid();
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) invalid();
  const record = obj as Record<string, unknown>;
  // Strict shape: exactly version/hostId/origin. Extra fields are rejected so
  // a future factory field cannot slip past this review.
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "hostId" || keys[1] !== "origin" || keys[2] !== "version") invalid();
  if (record.version !== PROXY_BINDING_VERSION) invalid();
  if (typeof record.hostId !== "string" || !HOST_PATTERN.test(record.hostId)) invalid();
  if (typeof record.origin !== "string") invalid();
  const origin = record.origin as string;
  let canonical: string;
  try {
    canonical = canonicalizeProxyOrigin(origin);
  } catch {
    invalid();
  }
  // Producer must write canonical form; non-canonical bytes are rejected so
  // string equality is the comparison (no normalization drift).
  if (origin !== canonical) invalid();
  return { version: 1, hostId: record.hostId as string, origin };
}

function checkedLstat(bindingPath: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(bindingPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") missing();
    invalid();
  }
  if (st.isSymbolicLink()) invalid();
  assertSafeStat(st.isFile(), st.mode, st.size);
}

function assertSafeStat(isFile: boolean, mode: number, size: number): void {
  if (!isFile) invalid();
  // Group- or world-writable bindings can be swapped by another local user.
  // The binding holds no secrets, so world-readable is tolerated.
  if ((mode & 0o022) !== 0) invalid();
  if (size > PROXY_BINDING_MAX_BYTES || size <= 0) invalid();
}

/**
 * The single bounded binding reader (sync; no unbounded allocation).
 *
 * `lstat` rejects symlinks first; the file is then opened `O_NOFOLLOW |
 * O_NONBLOCK` (a FIFO substituted between the calls opens but fails the
 * regular-file check instead of hanging the reader) and re-checked via
 * `fstat` before a size-capped exact read. Any I/O failure other than
 * missing maps to invalid; file bytes are never echoed.
 */
function readExactBounded(fd: number): Buffer {
  const st = fstatSync(fd);
  assertSafeStat(st.isFile(), st.mode, st.size);
  const buf = Buffer.alloc(st.size);
  let offset = 0;
  while (offset < st.size) {
    const n = readSync(fd, buf, offset, st.size - offset, null);
    if (n <= 0) break;
    offset += n;
  }
  if (offset !== st.size) invalid();
  return buf;
}

function readBindingFile(bindingPath: string): Buffer {
  checkedLstat(bindingPath);
  let fd = -1;
  try {
    fd = openSync(bindingPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") missing();
    return invalid();
  }
  try {
    return readExactBounded(fd);
  } catch (error) {
    if (error instanceof ProxyOriginPinError) throw error;
    return invalid();
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors on a read path
      }
    }
  }
}

/** Read + shape validation. Throws missing/invalid, never echoes file bytes. */
export function readProxyBinding(stateDir: string): ProxyOriginBinding {
  return parseBindingBuffer(readBindingFile(proxyBindingPath(stateDir)));
}

/**
 * Compare the env-configured proxy URL against the durable binding.
 * Returns the pinned canonical origin on success. Throws missing/invalid/
 * mismatch/config_invalid without echoing URLs, tokens, or file bytes.
 */
export function assertProxyOriginPinned(stateDir: string, hostId: string, proxyUrl: string): string {
  const canonicalEnv = canonicalizeProxyOrigin(proxyUrl);
  if (typeof hostId !== "string" || !HOST_PATTERN.test(hostId)) mismatch();
  const binding = readProxyBinding(stateDir);
  if (binding.hostId !== hostId) mismatch();
  if (binding.origin !== canonicalEnv) mismatch();
  return binding.origin;
}

async function removeOwnedTemp(temporary: string, dev: number, ino: number): Promise<void> {
  // Unlink the temp path only when it is still our own inode: never follow a
  // swapped path onto somebody else's file (reopen-by-name TOCTOU).
  try {
    const st = await lstat(temporary);
    if (st.dev === dev && st.ino === ino) {
      const { rm } = await import("node:fs/promises");
      await rm(temporary, { force: true });
    }
  } catch {
    // best effort; a leftover uniquely-named temp is harmless
  }
}

/**
 * Producer contract helper (server factory / operator / tests only).
 *
 * The runtime NEVER calls this automatically: no trust-on-first-use, no mint.
 * Custody: one exclusive `0600` temp fd (`O_CREAT|O_EXCL|O_NOFOLLOW`) carries
 * the payload through write → fsync → close (the same fd, never a reopen by
 * path); then atomic rename, then a parent-directory fsync so the rename is
 * durable; then a bounded read-back that must parse to exactly the intended
 * `{version,hostId,origin}` before success. Own temp is unlinked on failure
 * only when its inode still matches. No credentials are written.
 */
export async function writeProxyBindingAtomic(
  stateDir: string,
  binding: { hostId: string; origin: string },
): Promise<string> {
  if (typeof binding.hostId !== "string" || !HOST_PATTERN.test(binding.hostId)) {
    throw new Error("writeProxyBindingAtomic: hostId must be a bare object-key-safe name");
  }
  const canonical = canonicalizeProxyOrigin(binding.origin);
  const resolvedDir = path.resolve(stateDir);
  await mkdir(resolvedDir, { recursive: true });
  const target = path.join(resolvedDir, PROXY_BINDING_FILENAME);
  const payload = `${JSON.stringify({ version: PROXY_BINDING_VERSION, hostId: binding.hostId, origin: canonical }, null, 2)}\n`;
  const temporary = path.join(resolvedDir, `.${PROXY_BINDING_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new Error(`writeProxyBindingAtomic: cannot create temp binding: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  let dev = -1;
  let ino = -1;
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    const st = await handle.stat();
    dev = st.dev;
    ino = st.ino;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeOwnedTemp(temporary, dev, ino);
    throw error;
  }
  await handle.close().catch(() => undefined);
  try {
    await rename(temporary, target);
  } catch (error) {
    await removeOwnedTemp(temporary, dev, ino);
    throw error;
  }
  const dirHandle = await open(resolvedDir, constants.O_RDONLY);
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close().catch(() => undefined);
  }
  // Read-back: the bytes on disk must parse to exactly what was intended.
  const back = parseBindingBuffer(readBindingFile(target));
  if (back.version !== PROXY_BINDING_VERSION || back.hostId !== binding.hostId || back.origin !== canonical) {
    throw new Error("writeProxyBindingAtomic: read-back verification failed");
  }
  return target;
}

export interface PinnedProxyStoreOptions {
  stateDir: string;
  hostId: string;
  url: string;
  token: string;
  timeoutMs: number;
}

/**
 * Production proxy store: fail-closed origin pin at the HTTP dispatch boundary.
 *
 * Fail-fast once at construction (blocks proxy activation at startup), then
 * every request re-validates through the raw transport's `resolveBase` hook,
 * which runs AFTER async PUT prep and adjacent to `fetch` with no await
 * between — so mid-prep deletion/drift still blocks with no send. Bytes can
 * only ever address the pinned origin, never a drifted env URL. There are no
 * per-method wrappers here; the single dispatch guard in `proxystore.ts` is
 * the fence, and production (`createObjectStore`) always installs it.
 */
export function createPinnedProxyStore(options: PinnedProxyStoreOptions): ObjectStore {
  const { stateDir, hostId, url, token, timeoutMs } = options;
  const resolveBase = (): string => assertProxyOriginPinned(stateDir, hostId, url);
  resolveBase();
  return createProxyStore({ url, token, hostId, timeoutMs, resolveBase });
}

/** Test helper: is this error a pin refusal (vs transport/validation)? */
export function isProxyOriginPinError(error: unknown): error is ProxyOriginPinError {
  return error instanceof ProxyOriginPinError;
}
