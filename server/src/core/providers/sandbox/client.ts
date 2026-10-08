import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { PiPodError } from "../../errors.js";
import type {
  CpuGrantRequest,
  CpuGrantResponse,
  ErrorDetails,
  ErrorResponse,
  OperationStatusWire,
  OwnerInitRequest,
  OwnerInitResponse,
  TenantStatusWire,
} from "./wire.js";
import { ERR_NOT_FOUND, IDEMPOTENCY_HEADER } from "./wire.js";

export { IDEMPOTENCY_HEADER };

export class SandboxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    /**
     * Validated numeric/enum detail the host sent alongside the error. Safe to keep
     * through the sanitizer and to render user messages from: by construction it
     * carries no paths, URLs, env, or tokens. Unvalidated until `sanitizeErrorDetails`.
     */
    readonly details?: ErrorDetails,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SandboxApiError";
  }
}

export class SandboxWsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxWsError";
  }
}

interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

export interface SandboxTransportOptions {
  /** Total request budget, including bounded read retries and response body. */
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Only GETs are replayed. Mutations and upload streams are never replayed. */
  readRetries?: number;
  retryBaseMs?: number;
  /** Preferred hosted configuration: query-free URL plus independent edge token. */
  hostedToken?: string;
}

interface HostedCookie {
  value: string;
  path: string;
  secure: boolean;
  expiresAt: number;
}

/**
 * Default budget for a create carrying an operation key. A host create covers image
 * resolution, launch and readiness and has been observed finishing past 150s, so the
 * client must not give up before the launch's own start budget (`START_TIMEOUT_MS`,
 * 5 min): abandoning the POST early leaves the host still creating, and the sandbox it
 * produces is an orphan until the GET-only operation-key recovery finds it.
 */
export const CREATE_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

/** GET /v1/images/:ref only — POST /v1/images (pull) and every other route stay out. */
export const NATIVE_IMAGE_LOOKUP_PREFIX = "/v1/images/";

/** Hosted image-lookup 404 JSON is inspected only up to this many decoded body bytes. */
export const HOSTED_IMAGE_LOOKUP_404_MAX_BYTES = 65_536;

export function isNativeImageLookup(method: string, path: string): boolean {
  if (method !== "GET") return false;
  const pathname = path.split("?")[0] ?? "";
  return pathname.startsWith(NATIVE_IMAGE_LOOKUP_PREFIX)
    && pathname.length > NATIVE_IMAGE_LOOKUP_PREFIX.length;
}

/**
 * Provider wire ref from GET /v1/images/:ref (decodeURIComponent of the path suffix).
 * Native notFound(`image ${ref} has not been pulled`) interpolates this wire ref, not the
 * caller-unmapped managed tag from before imageRef() mapping.
 */
export function nativeImageLookupRef(path: string): string | null {
  const pathname = path.split("?")[0] ?? "";
  if (!pathname.startsWith(NATIVE_IMAGE_LOOKUP_PREFIX)) return null;
  const encoded = pathname.slice(NATIVE_IMAGE_LOOKUP_PREFIX.length);
  if (!encoded) return null;
  try {
    const ref = decodeURIComponent(encoded);
    return ref.length > 0 ? ref : null;
  } catch {
    return null;
  }
}

function jsonMediaType(contentType: string | null): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json" || Boolean(type?.endsWith("+json"));
}

function declaredContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/**
 * Exact native GET /v1/images/:ref miss: `{ error: { code: "not_found", message } }` with
 * `message === "image ${expectedRef} has not been pulled"`. expectedRef is the provider
 * wire ref. Extra top-level/inner keys (including known Boat vendor envelopes) are not native.
 */
export function nativeImageNotFoundEnvelope(payload: unknown, expectedRef: string): boolean {
  if (typeof expectedRef !== "string" || expectedRef.length === 0) return false;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "error") return false;
  const error = (payload as { error: unknown }).error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return false;
  const record = error as Record<string, unknown>;
  const inner = Object.keys(record);
  if (inner.length !== 2 || !inner.includes("code") || !inner.includes("message")) return false;
  if (record["code"] !== ERR_NOT_FOUND) return false;
  return record["message"] === `image ${expectedRef} has not been pulled`;
}

/** Append service paths without turning a base query into part of the path. */
export function sandboxServiceUrl(baseUrl: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("sandbox endpoint must be an absolute service path");
  }
  const url = new URL(baseUrl);
  const endpoint = new URL(path, "http://sandbox.invalid");
  url.pathname = url.pathname.replace(/\/+$/, "") + endpoint.pathname;
  for (const key of new Set(endpoint.searchParams.keys())) {
    // The endpoint must never replace a deployment credential.
    if (key === "_token" && url.searchParams.has(key)) continue;
    url.searchParams.delete(key);
    for (const value of endpoint.searchParams.getAll(key)) url.searchParams.append(key, value);
  }
  url.hash = "";
  return url.toString();
}

/** Unknown host availability is never evidence that a sandbox was deleted. */
export class SandboxTransportError extends PiPodError {
  constructor(code: string, transient = true) {
    super("could not reach the sandbox service: " + code, { code, transient });
    this.name = "SandboxTransportError";
  }
}

export function isRetryableSandboxError(error: unknown): boolean {
  if (error instanceof SandboxTransportError) {
    return error.transient && error.code !== "host_asleep_or_unknown" && error.code !== "host_auth_expired";
  }
  return error instanceof SandboxApiError && ([408, 429, 500, 502, 503, 504].includes(error.status)
    || (error.status >= 500 && error.code === "upstream_unavailable"));
}

export class SandboxClient {
  private readonly serviceUrl: string;
  private readonly hostedToken: string | undefined;
  private cookies: HostedCookie[] = [];
  private sessionVersion = 0;
  private bootstrapInFlight?: Promise<void>;

  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly options: SandboxTransportOptions = {},
  ) {
    const url = new URL(baseUrl);
    this.hostedToken = options.hostedToken ?? url.searchParams.get("_token") ?? undefined;
    url.searchParams.delete("_token");
    url.hash = "";
    this.serviceUrl = url.toString();
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const requestedTimeout =
      body !== null && typeof body === "object"
        ? (body as { timeoutMs?: unknown }).timeoutMs
        : undefined;
    const timeoutMs =
      typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout)
        ? Math.max(this.options.timeoutMs ?? 60_000, requestedTimeout + 10_000)
        : this.options.timeoutMs ?? 60_000;
    const response = await this.request(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      { ...(body === undefined ? {} : { "content-type": "application/json" }) },
      timeoutMs,
    );
    if (response.status === 204) return undefined as T;
    return await this.readJson<T>(response);
  }

  /** Read already-serialized JSON while retaining HTTP status (usage protocol). */
  async jsonResponse(method: string, path: string, body?: string): Promise<{ status: number; body: unknown }> {
    const response = await this.request(method, path, body,
      body === undefined ? {} : { "content-type": "application/json" });
    return { status: response.status, body: response.status === 204 ? null : await this.readJson(response) };
  }

  /** Static health remains unauthenticated; hosted callers should use json(). */
  async publicJson<T>(path: string): Promise<T> {
    const response = await this.request("GET", path, undefined, {}, this.options.timeoutMs,
      this.hostedToken !== undefined && Boolean(this.token));
    return await this.readJson<T>(response);
  }

  async bytes(path: string): Promise<Uint8Array> {
    const response = await this.request("GET", path);
    if (this.hostedToken !== undefined
      && response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      await response.body?.cancel();
      throw new SandboxTransportError("host_asleep_or_unknown");
    }
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw this.transportError(error);
    }
  }

  async upload(
    path: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = AbortSignal.timeout(this.options.uploadTimeoutMs ?? 300_000);
    const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response: Response;
    try {
      await this.ensureSession(path, combinedSignal);
      const cookie = this.cookieHeader(path);
      const version = this.sessionVersion;
      const init: StreamingRequestInit = {
        method: "PUT",
        headers: this.headers({ "content-type": "application/octet-stream", ...(cookie ? { cookie } : {}) }),
        body,
        duplex: "half",
        redirect: "manual",
        signal: combinedSignal,
      };
      response = await fetch(this.url(path), init);
      if (this.authExpired(response.status)) {
        await response.body?.cancel();
        await this.refreshSession(path, version, combinedSignal);
        throw new SandboxTransportError("host_auth_expired");
      }
      await this.requireOk(response);
      if (response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
        await response.body?.cancel();
        throw new SandboxTransportError("host_asleep_or_unknown");
      }
      // Drain the acknowledgement under the same timeout, including stalled bodies.
      await response.arrayBuffer();
    } catch (e) {
      throw this.transportError(e);
    }
  }

  stream(readable: Readable): ReadableStream<Uint8Array> {
    return Readable.toWeb(readable) as ReadableStream<Uint8Array>;
  }

  async websocket(path: string): Promise<WebSocket> {
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    const startedAt = Date.now();
    const signal = AbortSignal.timeout(timeoutMs);
    await this.ensureSession(path, signal);
    const cookie = this.cookieHeader(path);
    const version = this.sessionVersion;
    const url = new URL(this.url(path));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: this.headers(cookie ? { cookie } : {}),
        handshakeTimeout: Math.max(1, timeoutMs - (Date.now() - startedAt)),
        followRedirects: false,
      });
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(this.transportError(error));
      };
      socket.once("open", () => {
        if (settled) return;
        settled = true;
        resolve(socket);
      });
      socket.once("error", fail);
      socket.once("unexpected-response", (_request, response) => {
        response.destroy();
        if (this.authExpired(response.statusCode ?? 0)) {
          // No WS session or command is replayed. The next attach uses refreshed auth.
          void this.refreshSession(path, version, signal).then(
            () => fail(new SandboxTransportError("host_auth_expired")), fail,
          );
        } else fail(new SandboxTransportError("host_asleep_or_unknown"));
      });
    });
  }

  /**
   * POST a create with a stable control-plane operation key (§6.5). The key travels
   * in the body and as the `Idempotency-Key` header; the host joins identical
   * retries and conflicts on a different fingerprint (409 idempotency_conflict).
   *
   * Honours `options.timeoutMs` like `json()`, but defaults to the create budget
   * rather than the 60s request default: a create that outlives the client's deadline
   * still runs on the host, and only operation-key recovery can adopt its sandbox.
   */
  async createWithOperation<T>(path: string, body: unknown, operationKey: string): Promise<T> {
    const response = await this.request(
      "POST",
      path,
      JSON.stringify(body),
      { "content-type": "application/json", [IDEMPOTENCY_HEADER]: operationKey },
      this.options.timeoutMs ?? CREATE_OPERATION_TIMEOUT_MS,
    );
    if (response.status === 204) return undefined as T;
    return await this.readJson<T>(response);
  }

  /**
   * POST to a route that answers in newline-delimited JSON, handing each value to `onEvent` as
   * it arrives. For operations that run for minutes: the host sends headers at once and
   * heartbeats after, so only `timeoutMs` bounds the whole exchange.
   */
  async ndjson(path: string, body: unknown, onEvent: (event: unknown) => void, timeoutMs: number): Promise<void> {
    const response = await this.request(
      "POST",
      path,
      JSON.stringify(body),
      { "content-type": "application/json" },
      timeoutMs,
    );
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/x-ndjson" || !response.body) {
      await response.body?.cancel();
      throw new SandboxTransportError("host_asleep_or_unknown");
    }
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true });
        for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) onEvent(JSON.parse(line));
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError) throw new SandboxTransportError("host_asleep_or_unknown");
      throw this.transportError(error);
    }
  }

  /** Authenticated create-operation status lookup (§6.5). Unknown key → 404 not_found. */
  async getOperation(key: string): Promise<OperationStatusWire> {
    return await this.json<OperationStatusWire>("GET", `/v1/operations/${encodeURIComponent(key)}`);
  }

  /**
   * Request cancellation/cleanup of a create operation (§6.5). If the operation
   * already succeeded and the sandbox exists, the host deletes it (by recovered
   * id) and reports `cancelled`; a pending create rolls back after launch.
   */
  async cancelOperation(key: string): Promise<OperationStatusWire> {
    return await this.json<OperationStatusWire>("DELETE", `/v1/operations/${encodeURIComponent(key)}`);
  }

  /** Tenant CPU budget grant (§7.3). Revision must exceed the tenant's current one. */
  async setCpuGrant(
    userKey: string,
    grant: CpuGrantRequest,
  ): Promise<CpuGrantResponse> {
    return await this.json<CpuGrantResponse>(
      "PUT",
      `/v1/tenants/${encodeURIComponent(userKey)}/cpu-grant`,
      grant,
    );
  }

  /** Tenant status: live sandboxes, cgroup presence, active grant (§7.3). */
  async getTenantStatus(userKey: string): Promise<TenantStatusWire> {
    return await this.json<TenantStatusWire>("GET", `/v1/tenants/${encodeURIComponent(userKey)}`);
  }

  /**
   * One-time owner initialization for a legacy unowned sandbox (§7.2 rev3).
   * Compare-and-set from null: idempotent for the same key
   * (`changed: false`), 409 `owner_conflict` for a different key or a live
   * sandbox (grandfathered until it stops — never moved live).
   */
  async initializeOwner(sandboxId: string, userKey: string): Promise<OwnerInitResponse> {
    const body: OwnerInitRequest = { owner: { userKey } };
    return await this.json<OwnerInitResponse>(
      "PUT",
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}/owner`,
      body,
    );
  }

  private async request(
    method: string,
    path: string,
    body?: string,
    headers: Record<string, string> = {},
    timeoutMs = this.options.timeoutMs ?? 60_000,
    authenticated = true,
  ): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    const retries = method === "GET" ? Math.min(3, Math.max(0, this.options.readRetries ?? 2)) : 0;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.ensureSession(path, signal);
        const cookie = this.cookieHeader(path);
        const version = this.sessionVersion;
        const requestHeaders = { ...headers, ...(cookie ? { cookie } : {}) };
        const response = await fetch(this.url(path), {
          method,
          headers: authenticated ? this.headers(requestHeaders) : requestHeaders,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal,
        });
        if (this.authExpired(response.status)) {
          await response.body?.cancel();
          if (!refreshed) {
            refreshed = true;
            await this.refreshSession(path, version, signal);
            if (method === "GET") { attempt--; continue; }
          }
          // Mutations may have been received: refresh credentials, never replay them.
          throw new SandboxTransportError("host_auth_expired");
        }
        await this.requireOk(response, method, path);
        return response;
      } catch (error) {
        const mapped = this.transportError(error);
        if (signal.aborted || attempt >= retries || !isRetryableSandboxError(mapped)) throw mapped;
        try {
          const backoff = (this.options.retryBaseMs ?? 100) * 2 ** attempt;
          const retryAfter = mapped instanceof SandboxApiError ? mapped.retryAfterMs ?? 0 : 0;
          await delay(Math.max(backoff, retryAfter), undefined, { signal });
        } catch (error) {
          throw this.transportError(error);
        }
      }
    }
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private url(path: string): string {
    const url = new URL(sandboxServiceUrl(this.serviceUrl, path));
    if (this.hostedToken !== undefined) url.searchParams.delete("_token");
    return url.toString();
  }

  private authExpired(status: number): boolean {
    return this.hostedToken !== undefined && (status === 401 || status === 403);
  }

  private cookieHeader(path: string): string {
    const url = new URL(this.url(path));
    return this.cookies.filter((cookie) => cookie.expiresAt > Date.now()
      && (!cookie.secure || url.protocol === "https:")
      && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : cookie.path + "/")))
      .map((cookie) => cookie.value).join("; ");
  }

  private async refreshSession(path: string, version: number, signal: AbortSignal): Promise<void> {
    if (version === this.sessionVersion) this.cookies = [];
    await this.ensureSession(path, signal);
  }

  private async ensureSession(path: string, signal: AbortSignal): Promise<void> {
    if (this.hostedToken === undefined) return;
    signal.throwIfAborted();
    if (this.cookieHeader(path)) return;
    // A bounded client-local handshake, shared by concurrent operations. A caller's
    // cancellation stops its wait, not other callers' bootstrap. No global cookie jar.
    if (!this.bootstrapInFlight) {
      this.bootstrapInFlight = this.bootstrap().finally(() => { this.bootstrapInFlight = undefined; });
    }
    const bootstrap = this.bootstrapInFlight;
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(this.transportError(signal.reason));
      signal.addEventListener("abort", aborted, { once: true });
      void bootstrap.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      if (signal.aborted) aborted();
    });
    if (!this.cookieHeader(path)) throw new SandboxTransportError("host_auth_expired");
  }

  private async bootstrap(): Promise<void> {
    const tokenless = new URL(this.serviceUrl);
    const gate = new URL(tokenless);
    gate.searchParams.set("_token", this.hostedToken!);
    try {
      const response = await fetch(gate, {
        method: "GET",
        // Deliberately no runtime Authorization or previously issued Cookie.
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
      });
      const location = response.headers.get("location");
      let target: URL | undefined;
      try { if (location) target = new URL(location, gate); } catch { /* reject below */ }
      const validRedirect = response.status === 302 && target?.origin === tokenless.origin
        && target.pathname === tokenless.pathname && target.search === tokenless.search
        && !target.hash && !target.username && !target.password;
      if (!validRedirect) {
        // Never follow even one hop to another origin/path, including signed previews.
        if (response.status === 408 || response.status === 429 || response.status >= 500) await this.requireOk(response);
        await response.body?.cancel();
        throw new SandboxTransportError("host_asleep_or_unknown");
      }
      const cookies: HostedCookie[] = [];
      for (const raw of response.headers.getSetCookie()) {
        const [value, ...attributes] = raw.split(";").map((part) => part.trim());
        if (!value || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\s;,]*$/.test(value)) continue;
        const attrs = new Map(attributes.map((attribute) => {
          const split = attribute.indexOf("=");
          return split < 0 ? [attribute.toLowerCase(), ""] : [attribute.slice(0, split).toLowerCase(), attribute.slice(split + 1)];
        }));
        const domain = attrs.get("domain")?.replace(/^\./, "").toLowerCase();
        if (domain && tokenless.hostname !== domain && !tokenless.hostname.endsWith("." + domain)) continue;
        const maxAge = attrs.get("max-age");
        const expires = attrs.get("expires");
        let expiresAt = expires ? Date.parse(expires) : Infinity;
        if (Number.isNaN(expiresAt)) expiresAt = Infinity;
        if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) expiresAt = Date.now() + Number(maxAge) * 1000;
        cookies.push({ value, path: attrs.get("path")?.startsWith("/") ? attrs.get("path")! : tokenless.pathname.replace(/[^/]*$/, ""),
          secure: attrs.has("secure"), expiresAt });
      }
      await response.body?.cancel();
      if (!cookies.length) throw new SandboxTransportError("host_auth_expired");
      // Domain attributes never widen scope: this jar only serves this client's
      // immutable service origin, over HTTP and its corresponding WS origin.
      this.cookies = cookies;
      this.sessionVersion++;
    } catch (error) {
      throw this.transportError(error);
    }
  }

  private async readJson<T>(response: Response): Promise<T> {
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json" && !type?.endsWith("+json")) {
      await response.body?.cancel();
      throw new SandboxTransportError("host_asleep_or_unknown");
    }
    try {
      return await response.json() as T;
    } catch (error) {
      if (error instanceof SyntaxError) throw new SandboxTransportError("host_asleep_or_unknown");
      throw this.transportError(error);
    }
  }

  /** Hosted GET /v1/images/:ref 404: native not_found only. Everything else is host_asleep. */
  private async rejectHostedImageLookup404(response: Response, path: string): Promise<never> {
    if (!jsonMediaType(response.headers.get("content-type"))) {
      await response.body?.cancel().catch(() => {});
      throw new SandboxTransportError("host_asleep_or_unknown");
    }
    const expectedRef = nativeImageLookupRef(path);
    if (expectedRef === null) {
      await response.body?.cancel().catch(() => {});
      throw new SandboxTransportError("host_asleep_or_unknown");
    }
    let text: string;
    try {
      text = await this.readCappedBodyText(response, HOSTED_IMAGE_LOOKUP_404_MAX_BYTES);
    } catch (error) {
      throw this.transportError(error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new SandboxTransportError("transport_unknown", false);
    }
    if (nativeImageNotFoundEnvelope(parsed, expectedRef)) {
      throw new SandboxApiError(404, ERR_NOT_FOUND, "not_found");
    }
    throw new SandboxTransportError("host_asleep_or_unknown");
  }

  private async readCappedBodyText(response: Response, maxBytes: number): Promise<string> {
    const declared = declaredContentLength(response);
    if (declared !== undefined && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new SandboxTransportError("transport_unknown", false);
    }
    const body = response.body;
    if (!body) throw new SandboxTransportError("transport_unknown", false);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > maxBytes) throw new SandboxTransportError("transport_unknown", false);
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SandboxTransportError("transport_unknown", false);
    }
  }

  private async requireOk(response: Response, method = "GET", path = ""): Promise<void> {
    // Vendor fallback redirects (including same-origin auth redirects) and HTML
    // previews are availability failures. Never expose their signed URLs/text.
    // Hosted 404 is edge/vendor availability on every path except GET /v1/images/:ref,
    // whose producer-known native JSON not_found is a cache miss (launch preflight
    // must return null, not HTTP 500). Missing sandboxes and malformed/HTML 404s stay
    // transport-unknown: never infer gone from an edge 404.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new SandboxTransportError("host_asleep_or_unknown");
    }
    if (response.status === 404 && this.hostedToken !== undefined) {
      if (isNativeImageLookup(method, path)) {
        return await this.rejectHostedImageLookup404(response, path);
      }
      await response.body?.cancel();
      throw new SandboxTransportError("host_asleep_or_unknown");
    }
    if (response.ok) return;
    const text = await response.text();
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    let payload: ErrorResponse | undefined;
    if (type === "application/json" || type?.endsWith("+json")) {
      try { payload = JSON.parse(text) as ErrorResponse; } catch { /* unknown below */ }
    }
    const error = payload?.error ?? (response.status >= 500 && !text.trim()
      ? { code: "upstream_unavailable", message: "sandbox service temporarily unavailable" } : undefined);
    if (!error || typeof error.code !== "string" || typeof error.message !== "string") {
      // Older Fastify runtimes return a framework error instead of our wire
      // envelope for absent routes. Keep static feature detection working without
      // exposing its message (which includes the requested path/query).
      const legacy = payload as { error?: unknown; message?: unknown; statusCode?: unknown } | undefined;
      if (this.hostedToken === undefined && (response.status === 404 || response.status === 405)
        && legacy?.statusCode === response.status && typeof legacy.error === "string"
        && typeof legacy.message === "string") {
        throw new SandboxApiError(response.status, String(response.status), `HTTP ${response.status}`);
      }
      throw new SandboxTransportError("host_asleep_or_unknown");
    }
    const retryAfter = response.headers.get("retry-after");
    const retryAfterMs = retryAfter === null ? 0 : /^\d+(\.\d+)?$/.test(retryAfter.trim())
      ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    throw new SandboxApiError(
      response.status,
      error.code,
      error.message,
      error.hint,
      error.details,
      // The request deadline bounds waiting; never retry ahead of a server hint.
      Number.isFinite(retryAfterMs) ? Math.min(2_147_483_647, retryAfterMs) : undefined,
    );
  }

  private transportError(error: unknown): SandboxTransportError | SandboxApiError {
    if (error instanceof SandboxApiError || error instanceof SandboxTransportError) return error;
    const failure = error as { name?: string; code?: string; cause?: { code?: string } } | null;
    const code = failure?.cause?.code ?? failure?.code;
    if (failure?.name === "TimeoutError" || code === "ETIMEDOUT"
      || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT"
      || code === "UND_ERR_BODY_TIMEOUT") return new SandboxTransportError("transport_timeout");
    if (failure?.name === "AbortError") return new SandboxTransportError("transport_cancelled", false);
    if (code === "ENOTFOUND") return new SandboxTransportError("transport_dns", false);
    if (code?.startsWith("ERR_TLS") || code?.startsWith("CERT_")
      || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
      return new SandboxTransportError("transport_tls", false);
    }
    if (["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"].includes(code ?? "")) {
      return new SandboxTransportError("transport_unreachable");
    }
    // Do not print fetch/WS error text or causes: they can contain query tokens.
    return new SandboxTransportError("transport_unknown", false);
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof SandboxApiError && error.status === 404;
}
