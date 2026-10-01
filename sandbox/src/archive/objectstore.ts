import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "../config.js";
import { createPinnedProxyStore } from "./proxy-origin-pin.js";
import type { ListedObject, ObjectStore, PutOptions, StoredObject } from "./types.js";

/** Hex SHA-256 of a file, streamed; used by the local driver's trusted `head`. */
async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), async function (source) {
    for await (const chunk of source) hash.update(chunk as Buffer);
  });
  return hash.digest("hex");
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

function base64ToHex(b64: string): string {
  return Buffer.from(b64, "base64").toString("hex");
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

export interface SigV4Input {
  method: string;
  url: string | URL;
  headers?: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  amzDate: string;
}

export interface SigV4Result {
  authorization: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function compareBytes(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? compareBytes(leftValue, rightValue) : compareBytes(leftKey, rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalUri(url: URL): string {
  if (url.pathname === "") return "/";
  return url.pathname
    .split("/")
    .map((segment) => awsEncode(decodeURIComponent(segment)))
    .join("/");
}

function normalizeHeaders(headers: Record<string, string>): Array<[string, string]> {
  const normalized = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    normalized.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }
  return [...normalized.entries()].sort(([left], [right]) => compareBytes(left, right));
}

export function createCanonicalRequest(
  method: string,
  urlValue: string | URL,
  headers: Record<string, string>,
  payloadHash: string,
): { canonicalRequest: string; signedHeaders: string } {
  const url = typeof urlValue === "string" ? new URL(urlValue) : urlValue;
  const normalized = normalizeHeaders(headers);
  const canonicalHeaders = normalized.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = normalized.map(([name]) => name).join(";");
  return {
    canonicalRequest: [
      method.toUpperCase(),
      canonicalUri(url),
      canonicalQuery(url),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n"),
    signedHeaders,
  };
}

export function createStringToSign(
  amzDate: string,
  credentialScope: string,
  canonicalRequest: string,
): string {
  return ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
}

export function deriveSigningKey(
  secretKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

export function signAwsV4(input: SigV4Input): SigV4Result {
  const url = typeof input.url === "string" ? new URL(input.url) : input.url;
  const headers = {
    ...input.headers,
    host: url.host,
    "x-amz-date": input.amzDate,
  };
  const { canonicalRequest, signedHeaders } = createCanonicalRequest(
    input.method,
    url,
    headers,
    input.payloadHash,
  );
  const date = input.amzDate.slice(0, 8);
  const credentialScope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = createStringToSign(input.amzDate, credentialScope, canonicalRequest);
  const signature = createHmac("sha256", deriveSigningKey(
    input.secretKey,
    date,
    input.region,
    input.service,
  )).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, canonicalRequest, stringToSign, signature, signedHeaders };
}

function temporaryPath(destination: string): string {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
}

async function atomicCopy(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = temporaryPath(destination);
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function localObjectPath(root: string, key: string): string {
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, key);
  if (destination === resolvedRoot || !destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`invalid archive object key: ${key}`);
  }
  return destination;
}

function createLocalStore(directory: string): ObjectStore {
  return {
    kind: "local",
    async put(key, filePath, options?: PutOptions) {
      const destination = localObjectPath(directory, key);
      await atomicCopy(filePath, destination);
      const stored = await stat(destination);
      const sha256 = await sha256OfFile(destination);
      if (options?.sha256 && options.sha256 !== sha256) {
        await unlink(destination).catch(() => undefined);
        throw new Error(`local archive copy checksum mismatch for ${key}`);
      }
      return { key, size: stored.size, sha256 };
    },
    async get(key, destPath) {
      await atomicCopy(localObjectPath(directory, key), destPath);
    },
    async head(key) {
      try {
        const file = localObjectPath(directory, key);
        const stored = await stat(file);
        // The local driver owns the bytes, so hashing them is a trusted checksum.
        return { key, size: stored.size, sha256: await sha256OfFile(file) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async list(prefix) {
      const slash = prefix.lastIndexOf("/");
      const searchRoot =
        slash === -1 ? path.resolve(directory) : localObjectPath(directory, prefix.slice(0, slash));
      let entries: Dirent[];
      try {
        entries = await readdir(searchRoot, { recursive: true, withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const found: ListedObject[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const absolute = path.join(entry.parentPath, entry.name);
        const key = path.relative(path.resolve(directory), absolute).split(path.sep).join("/");
        if (!key.startsWith(prefix)) continue;
        const stored = await stat(absolute);
        found.push({ key, size: stored.size, lastModified: stored.mtimeMs });
      }
      return found.sort((left, right) => compareBytes(left.key, right.key));
    },
    async delete(key) {
      try {
        await unlink(localObjectPath(directory, key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function createNoneStore(): ObjectStore {
  const unavailable = (): never => {
    throw new Error("archive storage is not configured");
  };
  return {
    kind: "none",
    put: async () => unavailable(),
    get: async () => unavailable(),
    head: async () => unavailable(),
    list: async () => unavailable(),
    delete: async () => unavailable(),
  };
}

type S3Config = Extract<Config["archive"], { driver: "s3" }>;

function prefixedKey(prefix: string, key: string): string {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const normalizedKey = key.replace(/^\/+/, "");
  return normalizedPrefix === "" ? normalizedKey : `${normalizedPrefix}/${normalizedKey}`;
}

function objectUrl(config: S3Config, key: string): URL {
  const url = new URL(config.endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  const objectPath = [config.bucket, ...prefixedKey(config.prefix, key).split("/")]
    .map(awsEncode)
    .join("/");
  url.pathname = `${basePath}/${objectPath}`;
  url.search = "";
  return url;
}

function bucketUrl(config: S3Config, query: Record<string, string>): URL {
  const url = new URL(config.endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/${awsEncode(config.bucket)}`;
  url.search = "";
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

function amzTimestamp(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Minimal ListObjectsV2 result reader. Only the key, size, and modification time are read, and
 * S3 escapes them as XML entities, so a full parser would buy nothing here.
 */
export function parseListObjects(xml: string): {
  objects: ListedObject[];
  continuationToken: string | null;
} {
  const decode = (value: string): string =>
    value
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/g, "&");
  const objects: ListedObject[] = [];
  for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    if (body === undefined) continue;
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
    if (key === undefined || size === undefined) continue;
    const modified = Date.parse(/<LastModified>([\s\S]*?)<\/LastModified>/.exec(body)?.[1] ?? "");
    objects.push({
      key: decode(key),
      size: Number(size),
      lastModified: Number.isNaN(modified) ? 0 : modified,
    });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return {
    objects,
    continuationToken: truncated && token !== undefined ? decode(token) : null,
  };
}

async function signedFetch(
  config: S3Config,
  method: "PUT" | "GET" | "HEAD" | "DELETE",
  url: URL,
  additionalHeaders: Record<string, string> = {},
  body?: ReadableStream,
): Promise<Response> {
  const payloadHash = method === "PUT" ? "UNSIGNED-PAYLOAD" : EMPTY_SHA256;
  const date = amzTimestamp(new Date());
  const headers: Record<string, string> = {
    ...additionalHeaders,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  const signed = signAwsV4({
    method,
    url,
    headers,
    payloadHash,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    region: config.region,
    service: "s3",
    amzDate: date,
  });
  headers.authorization = signed.authorization;

  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (body !== undefined) {
    init.body = body;
    init.duplex = "half";
  }
  return fetch(url, init);
}

async function s3Request(
  config: S3Config,
  method: "PUT" | "GET" | "HEAD" | "DELETE",
  key: string,
  additionalHeaders: Record<string, string> = {},
  body?: ReadableStream,
): Promise<Response> {
  return signedFetch(config, method, objectUrl(config, key), additionalHeaders, body);
}

function responseError(operation: string, response: Response): Error {
  return new Error(`S3 ${operation} failed with HTTP ${response.status} ${response.statusText}`.trim());
}

function createS3Store(config: S3Config): ObjectStore {
  return {
    kind: "s3",
    async put(key, filePath, options?: PutOptions) {
      const sourceStat = await stat(filePath);
      const body = Readable.toWeb(createReadStream(filePath));
      // With the checksum header the service verifies the bytes it stores and rejects a
      // corrupted upload with 400 instead of persisting it; HEAD can then vouch for it.
      const response = await s3Request(config, "PUT", key, {
        "content-length": String(sourceStat.size),
        ...(options?.sha256 ? { "x-amz-checksum-sha256": hexToBase64(options.sha256) } : {}),
      }, body);
      if (!response.ok) throw responseError("PUT", response);
      const echoed = response.headers.get("x-amz-checksum-sha256");
      return { key, size: sourceStat.size, ...(echoed ? { sha256: base64ToHex(echoed) } : {}) };
    },
    async get(key, destPath) {
      const response = await s3Request(config, "GET", key);
      if (!response.ok) throw responseError("GET", response);
      if (response.body === null) throw new Error("S3 GET returned no response body");
      await mkdir(path.dirname(destPath), { recursive: true });
      const temporary = temporaryPath(destPath);
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        await rename(temporary, destPath);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async head(key) {
      const response = await s3Request(config, "HEAD", key, { "x-amz-checksum-mode": "ENABLED" });
      if (response.status === 404) return null;
      if (!response.ok) throw responseError("HEAD", response);
      const value = response.headers.get("content-length");
      const size = value === null ? Number.NaN : Number(value);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("S3 HEAD returned an invalid content-length");
      // Only a checksum the backend computed itself is trusted; ETag is not a content hash
      // for multipart or encrypted objects and is deliberately ignored.
      const checksum = response.headers.get("x-amz-checksum-sha256");
      const sha256 = checksum ? base64ToHex(checksum) : undefined;
      return {
        key,
        size,
        ...(sha256 && /^[0-9a-f]{64}$/.test(sha256) ? { sha256 } : {}),
      } satisfies StoredObject;
    },
    async list(prefix) {
      const scoped = prefixedKey(config.prefix, prefix);
      const found: ListedObject[] = [];
      let continuationToken: string | null = null;
      do {
        const url = bucketUrl(config, {
          "list-type": "2",
          prefix: scoped,
          ...(continuationToken === null ? {} : { "continuation-token": continuationToken }),
        });
        const response = await signedFetch(config, "GET", url);
        if (!response.ok) throw responseError("LIST", response);
        const page = parseListObjects(await response.text());
        for (const object of page.objects) {
          // Callers name objects relative to the configured prefix, as they do everywhere else.
          found.push({ ...object, key: object.key.slice(scoped.length - prefix.length) });
        }
        continuationToken = page.continuationToken;
      } while (continuationToken !== null);
      return found;
    },
    async delete(key) {
      const response = await s3Request(config, "DELETE", key);
      if (!response.ok && response.status !== 404) throw responseError("DELETE", response);
    },
  };
}

export function createObjectStore(config: Config["archive"]): ObjectStore {
  switch (config.driver) {
    case "local":
      return createLocalStore(config.dir);
    case "s3":
      return createS3Store(config);
    case "proxy":
      // Production proxy path is always pinned: the durable binding at
      // `<stateDir>/archive-proxy-binding.json` must already exist and match
      // the configured origin+host, or this throws before any HTTP. There is
      // no trust-on-first-use and no unpinned fallback. See
      // docs/archive-proxy-origin-pin.md and proxy-origin-pin.ts.
      return createPinnedProxyStore({
        stateDir: config.stateDir,
        hostId: config.hostId,
        url: config.url,
        token: config.token,
        timeoutMs: config.timeoutMs,
      });
    case "none":
      return createNoneStore();
  }
}
