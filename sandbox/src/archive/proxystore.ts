import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ListedObject, ObjectStore, PutOptions, StoredObject } from "./types.js";

/**
 * Server-mediated archive store ("proxy" driver).
 *
 * The boat holds NO object-store credentials: every request carries only the
 * host's own runtime token (the same PI_POD_SANDBOX_TOKEN the boat already
 * holds), and the server namespaces all keys under the token's host id.
 * Cross-host and cross-prefix access is refused server-side; the client-side
 * key check below is defense in depth, never the boundary.
 *
 * Wire protocol (implemented by the hosted edition's archive proxy):
 *   PUT  /v1/host-archives/{host}/objects/{key…}   streamed bytes
 *        headers: authorization, content-length, x-pipod-sha256 (hex, optional)
 *        → 200 { key, size, sha256? } (sha256 only when the server verified it)
 *   GET  same path → bytes
 *   HEAD same path → 200 + x-pipod-size / x-pipod-sha256 (when vouched), or 404
 *   GET  /v1/host-archives/{host}/objects?prefix= → { objects: ListedObject[] }
 *        (keys are runtime-relative; the server strips its host namespace)
 *   DELETE same object path → 200/404
 *
 * All bodies stream; nothing is buffered (a 20 GB workspace must flow through,
 * never sit in memory). The token never appears in errors, logs, or metrics.
 */

export interface ProxyStoreConfig {
  url: string;
  token: string;
  hostId: string;
  timeoutMs: number;
  /**
   * Internal dispatch-boundary pin hook (production only, installed by
   * `createPinnedProxyStore`). Re-validates the durable origin binding and
   * returns the pinned base origin, or throws a pin refusal. It runs AFTER
   * async PUT prep (stat/stream setup) and adjacent to `fetch` with no await
   * between, so mid-prep deletion/drift still blocks with no send. Raw stores
   * built without it are unpinned protocol transports for tests only.
   */
  resolveBase?: () => string;
}

/** Pod archives plus host DR snapshots — the only shapes this host may name.
 * Mirrors the server's key shapes exactly (server is the boundary; this is
 * defense in depth so malformed keys never take network traffic). */
export function assertProxyKey(key: string): void {
  const pod = /^[A-Za-z0-9._-]+\/upper-[0-9a-f]{64}\.tar\.zst$/;
  const dr = /^_dr\/[A-Za-z0-9._-]+\/sandbox-[^/]+\.sqlite$/;
  if (!pod.test(key) && !dr.test(key)) throw new Error(`invalid proxy archive key`);
}

function encodeKey(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * Transport failures carry only a fixed operation label plus the numeric
 * status. The server's `statusText` is untrusted reflected bytes
 * (operator-log injection via a compromised/drifted proxy), so it is never
 * interpolated. URLs and tokens are never interpolated either.
 */
function bareError(operation: string, status: number): Error {
  return new Error(`archive proxy ${operation} failed with HTTP ${status}`);
}

/**
 * `fetch` rejections (DNS, refused, timeout) surface undici internals whose
 * `cause` chain must not reach operator logs verbatim. Keep only the stable
 * syscall code (`ECONNREFUSED`, ...) — never the message, never the URL.
 */
async function checkedFetch(
  operation: string,
  url: string | URL,
  init: RequestInit & { duplex?: "half" },
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(`archive proxy ${operation} failed: network error`, {
      cause: typeof code === "string" && code.length > 0 && code.length <= 32 ? code : "fetch failed",
    });
  }
}

/**
 * Redirects are never followed: a 3xx that would send the bearer token to a
 * new location is a hard failure. `fetch` defaults to `follow`, so every
 * proxy call opts into `manual` and treats any redirect as an error before
 * reading the body. No URL/token is echoed.
 */
function throwIfRedirect(operation: string, response: Response): void {
  if (response.type === "opaqueredirect") {
    throw new Error(`archive proxy ${operation} failed: redirect blocked`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw bareError(operation, response.status);
  }
}

export function createProxyStore(config: ProxyStoreConfig): ObjectStore {
  const defaultBase = config.url.replace(/\/+$/, "");
  // The dispatch-boundary base: pinned when the hook is installed, else the
  // configured URL (unpinned test transport only — never production).
  const resolveBase = (): string => (config.resolveBase ? config.resolveBase() : defaultBase);
  const objectPath = (base: string, key: string): string =>
    `${base}/v1/host-archives/${encodeURIComponent(config.hostId)}/objects/${encodeKey(key)}`;
  const headers = (): Record<string, string> => ({ authorization: `Bearer ${config.token}` });
  const timeout = (): AbortSignal => AbortSignal.timeout(config.timeoutMs);

  return {
    kind: "proxy",

    async put(key, filePath, options?: PutOptions): Promise<StoredObject> {
      assertProxyKey(key);
      const sourceStat = await stat(filePath);
      const body = Readable.toWeb(createReadStream(filePath));
      const base = resolveBase();
      const response = await checkedFetch("PUT", objectPath(base, key), {
        method: "PUT",
        headers: {
          ...headers(),
          // The server routes bodies by media type; omitting it is a 415,
          // never a silent misparse.
          "content-type": "application/octet-stream",
          "content-length": String(sourceStat.size),
          ...(options?.sha256 ? { "x-pipod-sha256": options.sha256 } : {}),
        },
        body,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        duplex: "half" as any,
        signal: timeout(),
        redirect: "manual",
      });
      throwIfRedirect("PUT", response);
      if (!response.ok) throw bareError("PUT", response.status);
      let receipt: { key?: unknown; size?: unknown; sha256?: unknown } = {};
      try {
        receipt = (await response.json()) as typeof receipt;
      } catch {
        throw new Error("archive proxy PUT returned an unreadable receipt");
      }
      if (receipt.key !== key || receipt.size !== sourceStat.size) {
        throw new Error("archive proxy PUT receipt does not match the upload");
      }
      const sha256 = typeof receipt.sha256 === "string" && /^[0-9a-f]{64}$/.test(receipt.sha256)
        ? receipt.sha256
        : undefined;
      if (options?.sha256 && sha256 !== undefined && sha256 !== options.sha256) {
        throw new Error("archive proxy stored checksum does not match the packed bytes");
      }
      return { key, size: sourceStat.size, ...(sha256 ? { sha256 } : {}) };
    },

    async get(key, destPath): Promise<void> {
      assertProxyKey(key);
      const base = resolveBase();
      const response = await checkedFetch("GET", objectPath(base, key), {
        method: "GET",
        headers: headers(),
        signal: timeout(),
        redirect: "manual",
      });
      throwIfRedirect("GET", response);
      if (!response.ok) throw bareError("GET", response.status);
      if (response.body === null) throw new Error("archive proxy GET returned no response body");
      await mkdir(path.dirname(destPath), { recursive: true });
      const temporary = path.join(
        path.dirname(destPath), `.${path.basename(destPath)}.${randomUUID()}.tmp`);
      try {
        await pipeline(Readable.fromWeb(response.body),
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        await rename(temporary, destPath);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },

    async head(key): Promise<StoredObject | null> {
      assertProxyKey(key);
      const base = resolveBase();
      const response = await checkedFetch("HEAD", objectPath(base, key), {
        method: "HEAD",
        headers: headers(),
        signal: timeout(),
        redirect: "manual",
      });
      throwIfRedirect("HEAD", response);
      if (response.status === 404) return null;
      if (!response.ok) throw bareError("HEAD", response.status);
      const size = Number(response.headers.get("x-pipod-size"));
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("archive proxy HEAD returned an invalid size");
      }
      // Only a checksum the server verified itself is trusted; anything else
      // forces the read-back path in verifyArchived, exactly like the S3 driver.
      const checksum = response.headers.get("x-pipod-sha256");
      const sha256 = checksum && /^[0-9a-f]{64}$/.test(checksum) ? checksum : undefined;
      return { key, size, ...(sha256 ? { sha256 } : {}) };
    },

    async list(prefix): Promise<ListedObject[]> {
      if (prefix.includes("..") || prefix.startsWith("/")) throw new Error("invalid proxy list prefix");
      const base = resolveBase();
      const url = new URL(`${base}/v1/host-archives/${encodeURIComponent(config.hostId)}/objects`);
      url.searchParams.set("prefix", prefix);
      const response = await checkedFetch("LIST", url, { headers: headers(), signal: timeout(), redirect: "manual" });
      throwIfRedirect("LIST", response);
      if (!response.ok) throw bareError("LIST", response.status);
      let parsed: { objects?: unknown };
      try {
        parsed = (await response.json()) as typeof parsed;
      } catch {
        throw new Error("archive proxy LIST returned unreadable JSON");
      }
      if (!Array.isArray(parsed.objects)) throw new Error("archive proxy LIST returned no object array");
      const found: ListedObject[] = [];
      for (const entry of parsed.objects) {
        if (typeof entry !== "object" || entry === null) throw new Error("archive proxy LIST entry malformed");
        const record = entry as Record<string, unknown>;
        if (typeof record.key !== "string" || !Number.isSafeInteger(record.size) ||
            (record.size as number) < 0 || !Number.isFinite(record.lastModified)) {
          throw new Error("archive proxy LIST entry malformed");
        }
        assertProxyKey(record.key);
        found.push({
          key: record.key,
          size: record.size as number,
          lastModified: record.lastModified as number,
        });
      }
      return found;
    },

    async delete(key): Promise<void> {
      assertProxyKey(key);
      const base = resolveBase();
      const response = await checkedFetch("DELETE", objectPath(base, key), {
        method: "DELETE",
        headers: headers(),
        signal: timeout(),
        redirect: "manual",
      });
      throwIfRedirect("DELETE", response);
      if (!response.ok && response.status !== 404) throw bareError("DELETE", response.status);
    },
  };
}
