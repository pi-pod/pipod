import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import * as os from "node:os";
import { Readable, Transform, type TransformCallback } from "node:stream";
import type { Config } from "../config.js";
import { ServiceError, badRequest, notFound, payloadTooLarge, unauthorized } from "../errors.js";
import type { Logger } from "../log.js";
import type { Manager } from "../core/manager.js";
import type { ObjectStore } from "../archive/types.js";
import {
  METRICS_PATH,
  Metrics,
  httpMethodLabel,
  httpRouteLabel,
  httpStatusLabel,
  isMetricsPath,
} from "../metrics.js";
import { DeriveScriptFailure, ImageDeriver, planDerive } from "../images/derive.js";
import { registerExecRoute } from "./ws-exec.js";
import { registerPtyRoute } from "./ws-pty.js";
import {
  IDEMPOTENCY_HEADER,
  type ActivityResponse,
  type ArchiveIfStoppedRequest,
  type AuthzResponse,
  type CpuGrantRequest,
  type CreateSandboxRequest,
  type DeriveImageEvent,
  type HealthResponse,
  type HoldRequest,
  type ReleaseHoldRequest,
  type RetireRequest,
  type ImagePullRequest,
  type ImportSandboxRequest,
  type LabelsRequest,
  type ListResponse,
  type OwnerInitRequest,
  type PtyListResponse,
  type ResourcesRequest,
  type RetentionRequest,
  type StartRequest,
  type StopRequest,
  type UsageAckRequest,
} from "../wire.js";

export interface ServerDeps {
  cfg: Config;
  manager: Manager;
  objects: ObjectStore;
  log: Logger;
  version: string;
  runtimeName: string;
  metrics?: Metrics;
}

export function bearerFrom(req: { headers: Record<string, unknown> }): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

export function tokenMatches(expected: string, presented: string | null): boolean {
  if (presented === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // Length is compared separately because timingSafeEqual throws on a mismatch, and a
  // thrown comparison is a timing signal of its own.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Per-sandbox activity token: HMAC of the sandbox id under the master token. It is what a
 * sandbox receives for keepalive instead of the master token, and it authorizes exactly one
 * thing — refreshing that sandbox's own activity clock — so a credential leaked from inside
 * a sandbox does not grant control of every sandbox on the host.
 */
export function deriveActivityToken(masterToken: string, sandboxId: string): string {
  return createHmac("sha256", masterToken)
    .update(`pi-pod-sandbox:activity:${sandboxId}`)
    .digest("hex");
}

/**
 * Cap for buffered JSON/text request bodies. This is Fastify's `bodyLimit`, and it only
 * applies to parsers that buffer (`parseAs: "string" | "buffer"`, including the default
 * JSON parser). The `application/octet-stream` file route below streams and is therefore
 * *not* constrained by this value; its limit is `cfg.limits.maxUploadBytes`, enforced
 * while streaming so a 256 MiB workspace-seeding tarball is accepted. Keep this tight:
 * no JSON control-plane body needs tens of megabytes.
 */
export const JSON_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

/** Fallback when a caller builds a server without config limits (tests, embeds). */
export const DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/**
 * Streaming byte counter for `PUT /files`. Fastify never applies `bodyLimit` to a
 * custom streaming parser (it forwards the raw payload stream), so without this the
 * upload path would be unbounded at the HTTP layer and only the sandbox disk quota
 * would stop a runaway client. The guard errors the stream the moment the limit is
 * exceeded; the route then detaches the guard and discards the rest of the upload so
 * the connection can still carry the 413 response.
 */
export class UploadLimitGuard extends Transform {
  private seen = 0;

  constructor(
    private readonly limit: number,
    private readonly what: string,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.seen += chunk.length;
    if (this.seen > this.limit) {
      callback(uploadLimitError(this.what, this.limit));
      return;
    }
    callback(null, chunk);
  }
}

export function uploadLimitError(what: string, limit: number): ServiceError {
  const size =
    limit % 1024 ** 2 === 0
      ? `${limit / 1024 ** 2} MiB`
      : limit % 1024 === 0
        ? `${limit / 1024} KiB`
        : `${limit} bytes`;
  return payloadTooLarge(
    `upload of ${what} exceeds the ${size} single-file limit`,
    "split the payload, raise PI_POD_SANDBOX_MAX_UPLOAD_BYTES, or seed a smaller workspace",
  );
}

/** Fail fast when the client declared a body no policy would accept, before touching the sandbox. */
export function declaredUploadTooLarge(contentLength: unknown, limit: number): boolean {
  return typeof contentLength === "string" && Number.isFinite(Number(contentLength)) && Number(contentLength) > limit;
}

const ACTIVITY_PATH = /^\/v1\/sandboxes\/([^/?#]+)\/activity$/;

/** The sandbox id an activity refresh addresses; null for every other request. */
export function activityRequestSandboxId(method: string, url: string): string | null {
  if (method !== "POST") return null;
  const match = ACTIVITY_PATH.exec(url.split("?", 1)[0]!);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** `?label.role=worker&label.org=acme` — every selector must match, as gc expects. */
export function labelSelector(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith("label.") && typeof value === "string") out[key.slice("label.".length)] = value;
  }
  return out;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { cfg, manager, objects, log } = deps;
  const metrics = deps.metrics ?? Metrics.none();
  const requestStarted = new WeakMap<object, bigint>();
  const app = Fastify({
    loggerInstance: log as FastifyBaseLogger,
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    // Per-request logging would put every exec and file path in the log at info level.
    // Deprecated in favour of `logController` in fastify 6, whose typed shape currently
    // pushes inference onto the http2 overload; revisit at that upgrade.
    disableRequestLogging: true,
  });

  await app.register(websocket, { options: { maxPayload: 64 * 1024 * 1024 } });

  // Streaming parser: the payload stream is forwarded untouched, so Fastify's bodyLimit
  // never constrains (or protects) this path. The byte budget lives in
  // cfg.limits.maxUploadBytes and is enforced per-request in the PUT /files handler.
  // bodyLimit here only documents intent for a future buffered fallback.
  const maxUploadBytes = cfg.limits?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  app.addContentTypeParser(
    "application/octet-stream",
    { bodyLimit: maxUploadBytes },
    (_req, payload, done) => done(null, payload),
  );

  app.addHook("onRequest", async (req) => {
    requestStarted.set(req, process.hrtime.bigint());
    if (req.url.split("?", 1)[0] === "/v1/healthz") return;
    if (isMetricsPath(req.url)) {
      if (
        cfg.metricsToken &&
        !tokenMatches(cfg.metricsToken, bearerFrom(req as unknown as { headers: Record<string, unknown> }))
      ) {
        throw unauthorized();
      }
      return;
    }
    const presented = bearerFrom(req as unknown as { headers: Record<string, unknown> });
    if (tokenMatches(cfg.token, presented)) return;
    // A sandbox holds only its derived activity token, never the master, so the one
    // request it can authenticate is its own activity refresh.
    const activityId = activityRequestSandboxId(req.method, req.url);
    if (activityId !== null && tokenMatches(deriveActivityToken(cfg.token, activityId), presented)) {
      return;
    }
    throw unauthorized();
  });

  app.addHook("onResponse", async (req, reply) => {
    const started = requestStarted.get(req);
    const seconds = started === undefined ? 0 : Number(process.hrtime.bigint() - started) / 1e9;
    metrics.observeHttp(
      httpMethodLabel(req.method),
      httpRouteLabel(req.routeOptions?.url),
      httpStatusLabel(reply.statusCode),
      seconds,
    );
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ServiceError) {
      // `details` carries validated numbers/enums so a downstream sanitizer can keep them
      // while dropping the free-form message (§6.3).
      void reply.status(err.status).send({ error: err.toWire() });
      return;
    }
    log.error({ err }, "unhandled request error");
    void reply.status(500).send({ error: { code: "internal", message: String((err as Error)?.message ?? err) } });
  });

  const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id;

  app.get(METRICS_PATH, async (_req, reply) => {
    const body = await metrics.scrape();
    return reply
      .header("cache-control", "no-store")
      .header("content-type", metrics.contentType)
      .send(body);
  });

  app.get("/v1/healthz", async (): Promise<HealthResponse> => {
    // One capacity computation feeds both the legacy fields and the versioned contract, so
    // an older scheduler reading `host.committed` sees exactly what admission compares.
    const capacity = manager.capacityReport();
    return {
      ok: true,
      version: deps.version,
      uptimeSeconds: Math.round(process.uptime()),
      hostId: cfg.hostId,
      sandboxes: {
        hot: capacity.sandboxes.hot,
        warm: capacity.sandboxes.warm,
        stopped: capacity.sandboxes.stopped,
        archived: capacity.sandboxes.archived,
      },
      host: {
        cpus: os.cpus().length,
        memoryTotalBytes: os.totalmem(),
        memoryAvailableBytes: os.freemem(),
        guaranteeCapacity: { cpu: capacity.cpu.budgetCores, memoryBytes: capacity.memory.budgetBytes },
        committed: {
          cpu: capacity.cpu.committedFloorCores,
          memoryBytes: capacity.memory.committedBytes + capacity.memory.inFlightBytes + capacity.memory.quarantinedBytes,
          diskBytes: capacity.disk.committedBytes + capacity.disk.inFlightBytes + capacity.disk.quarantinedBytes,
        },
        diskCapacityBytes: capacity.disk.capacityBytes,
      },
      capacity,
    };
  });

  app.get("/v1/capacity", async () => manager.capacityReport());

  app.get("/v1/authz", async (): Promise<AuthzResponse> => ({
    ok: true,
    runtime: deps.runtimeName,
    archiveStore: objects.kind,
  }));

  app.post("/v1/sandboxes", async (req) => {
    const body = req.body as CreateSandboxRequest;
    if (!body?.image) throw badRequest("image is required");
    if (!body?.workdir) throw badRequest("workdir is required");
    const header = req.headers[IDEMPOTENCY_HEADER];
    if (typeof header === "string" && header.length > 0) {
      if (body.operationKey !== undefined && body.operationKey !== header) {
        throw badRequest("Idempotency-Key header and body.operationKey disagree");
      }
      body.operationKey = header;
    }
    return await manager.create(body);
  });

  app.get("/v1/operations/:key", async (req) =>
    manager.operationStatus((req.params as { key: string }).key),
  );

  app.delete("/v1/operations/:key", async (req) =>
    await manager.cancelOperation((req.params as { key: string }).key),
  );

  app.post("/v1/sandboxes/import", async (req) => {
    const body = req.body as ImportSandboxRequest;
    if (!body?.id) throw badRequest("id is required");
    if (!body?.image) throw badRequest("image is required");
    if (!body?.workdir) throw badRequest("workdir is required");
    if (body.archive !== undefined) {
      if (typeof body.archive?.key !== "string" || typeof body.archive?.sha256 !== "string") {
        throw badRequest("archive.key and archive.sha256 are required when archive is given");
      }
      if (body.archive.size !== undefined && !Number.isSafeInteger(body.archive.size)) {
        throw badRequest("archive.size must be an integer");
      }
    }
    if (body.imageDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(body.imageDigest)) {
      throw badRequest("imageDigest must be sha256:<64 hex>");
    }
    return await manager.importArchived(body);
  });

  app.post("/v1/sandboxes/:id/retire", async (req) => {
    const body = req.body as RetireRequest;
    if (typeof body?.holder !== "string") throw badRequest("holder is required");
    if (typeof body.adoptedArchive?.key !== "string" || typeof body.adoptedArchive?.sha256 !== "string") {
      throw badRequest("adoptedArchive.key and adoptedArchive.sha256 are required");
    }
    if (body.expectedRevision !== undefined && !Number.isSafeInteger(body.expectedRevision)) {
      throw badRequest("expectedRevision must be an integer");
    }
    return await manager.retire(idOf(req), {
      holder: body.holder,
      adoptedArchive: { key: body.adoptedArchive.key, sha256: body.adoptedArchive.sha256 },
      ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }),
    });
  });

  /* --------------------------------------- archive manifest handshake (§11) */

  app.get("/v1/sandboxes/:id/archive", async (req) => {
    const query = req.query as { verify?: string };
    return await manager.archiveReference(idOf(req), query.verify === "1" || query.verify === "true");
  });

  app.put("/v1/sandboxes/:id/hold", async (req) => {
    const body = req.body as HoldRequest;
    if (typeof body?.holder !== "string") throw badRequest("holder is required");
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 256)) {
      throw badRequest("reason must be a string of at most 256 characters");
    }
    if (body.expectedRevision !== undefined && !Number.isSafeInteger(body.expectedRevision)) {
      throw badRequest("expectedRevision must be an integer");
    }
    return await manager.hold(idOf(req), body.holder, body.reason, body.expectedRevision);
  });

  app.delete("/v1/sandboxes/:id/hold", async (req) => {
    const body = (req.body ?? {}) as ReleaseHoldRequest;
    return await manager.releaseHold(idOf(req), body.holder, body.force === true);
  });

  app.get("/v1/sandboxes", async (req): Promise<ListResponse> => ({
    sandboxes: manager.list(labelSelector(req.query as Record<string, unknown>)),
  }));

  app.get("/v1/sandboxes/:id", async (req) => {
    const info = manager.info(idOf(req));
    if (!info) throw notFound(`sandbox ${idOf(req)} not found`);
    return info;
  });

  app.post("/v1/sandboxes/:id/start", async (req) => {
    const body = (req.body ?? {}) as StartRequest;
    return await manager.start(idOf(req), { env: body.env, timeoutMs: body.timeoutMs });
  });

  app.post("/v1/sandboxes/:id/stop", async (req) => {
    const body = (req.body ?? {}) as StopRequest;
    return await manager.stop(idOf(req), body.timeoutMs);
  });

  app.post("/v1/sandboxes/:id/archive", async (req) => {
    const body = (req.body ?? {}) as StopRequest;
    return await manager.archive(idOf(req), body.timeoutMs);
  });

  app.post("/v1/host/dr-snapshot", async () => manager.forceDisasterRecoverySnapshot());

  app.post("/v1/sandboxes/:id/archive-if-stopped", async (req) => {
    const body = (req.body ?? {}) as ArchiveIfStoppedRequest;
    if (body.expectedRevision !== undefined && !Number.isSafeInteger(body.expectedRevision)) {
      throw badRequest("expectedRevision must be an integer");
    }
    if (body.expectedStoppedAt !== undefined && Number.isNaN(Date.parse(body.expectedStoppedAt))) {
      throw badRequest("expectedStoppedAt must be an ISO-8601 timestamp");
    }
    return await manager.archiveIfStopped(idOf(req), {
      ...(body.expectedRevision === undefined ? {} : { expectedRevision: body.expectedRevision }),
      ...(body.expectedStoppedAt === undefined
        ? {}
        : { expectedStoppedAt: new Date(body.expectedStoppedAt).toISOString() }),
    });
  });

  app.delete("/v1/sandboxes/:id", async (req) => {
    await manager.delete(idOf(req));
    return { deleted: true };
  });

  app.put("/v1/sandboxes/:id/labels", async (req) => {
    const body = req.body as LabelsRequest;
    if (!body?.labels) throw badRequest("labels is required");
    return manager.setLabels(idOf(req), body.labels);
  });

  // Master-token only (the onRequest hook admits activity tokens solely to /activity), so
  // a sandbox can never name its own owner.
  app.put("/v1/sandboxes/:id/owner", async (req) => {
    const body = req.body as OwnerInitRequest;
    if (typeof body?.owner?.userKey !== "string") throw badRequest("owner.userKey is required");
    return await manager.initializeOwner(idOf(req), body.owner.userKey);
  });

  app.post("/v1/sandboxes/:id/activity", async (req): Promise<ActivityResponse> => ({
    lastActivityAt: await manager.touch(idOf(req)),
  }));

  app.post("/v1/sandboxes/:id/retention", async (req) => {
    const body = req.body as RetentionRequest;
    if (typeof body?.archiveAfterMinutes !== "number") throw badRequest("archiveAfterMinutes is required");
    return { changed: manager.applyRetention(idOf(req), body.archiveAfterMinutes) };
  });

  app.post("/v1/sandboxes/:id/resources", async (req) => {
    const body = (req.body ?? {}) as ResourcesRequest;
    if (body.guarantee !== undefined) {
      throw badRequest("sandbox resource guarantees are fixed at 0.25 CPU and 512 MiB");
    }
    return manager.setResourceCeiling(idOf(req), body.ceiling);
  });

  // bodyLimit is a no-op for the streaming octet-stream parser above, but pin it anyway
  // so a future parser change cannot silently reintroduce the 64 MiB JSON cap on uploads.
  app.put("/v1/sandboxes/:id/files", { bodyLimit: maxUploadBytes }, async (req, reply) => {
    const query = req.query as { path?: string; mode?: string };
    if (!query.path) throw badRequest("path query parameter is required");
    const mode = query.mode ? Number.parseInt(query.mode, 8) : 0o644;
    if (!Number.isFinite(mode)) throw badRequest("mode must be octal");
    if (declaredUploadTooLarge(req.headers["content-length"], maxUploadBytes)) {
      throw uploadLimitError(query.path, maxUploadBytes);
    }
    const body = req.body as Readable | Buffer;
    if (Buffer.isBuffer(body)) {
      if (body.length > maxUploadBytes) throw uploadLimitError(query.path, maxUploadBytes);
      await manager.uploadFile(idOf(req), query.path, mode, Readable.from(body));
      return await reply.status(204).send();
    }
    const guard = new UploadLimitGuard(maxUploadBytes, query.path);
    // Never destroy the request stream here: tearing down the socket before the reply
    // is written turns the 413 into a client-side "other side closed". Instead, detach
    // the failed guard and discard the rest of the upload so the connection can still
    // carry the error response.
    const discardRest = (): void => {
      body.unpipe(guard);
      body.resume();
    };
    body.on("error", (err) => guard.destroy(err));
    guard.on("error", discardRest);
    body.pipe(guard);
    try {
      await manager.uploadFile(idOf(req), query.path, mode, guard);
    } catch (err) {
      discardRest();
      throw err;
    }
    return await reply.status(204).send();
  });

  app.get("/v1/sandboxes/:id/files", async (req, reply) => {
    const query = req.query as { path?: string };
    if (!query.path) throw badRequest("path query parameter is required");
    await manager.downloadFile(idOf(req), query.path, reply.raw, () => {
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "application/octet-stream" });
    });
    return await reply;
  });

  app.get("/v1/sandboxes/:id/ptys", async (req): Promise<PtyListResponse> => ({
    sessions: manager.ptys.listFor(idOf(req)).map((s) => s.toWire()),
  }));

  /* ------------------------------------------------------ tenants (§7.2–7.3) */

  const userKeyOf = (req: FastifyRequest): string => (req.params as { userKey: string }).userKey;

  app.get("/v1/tenants/:userKey", async (req) => manager.tenantStatus(userKeyOf(req)));

  app.put("/v1/tenants/:userKey/cpu-grant", async (req) => {
    const body = req.body as CpuGrantRequest;
    if (typeof body?.revision !== "number") throw badRequest("revision is required");
    if (typeof body.ttlMs !== "number") throw badRequest("ttlMs is required");
    if (body.cpuCores !== null && typeof body.cpuCores !== "number") {
      throw badRequest("cpuCores must be a number or null");
    }
    return manager.applyCpuGrant(userKeyOf(req), {
      revision: body.revision,
      cpuCores: body.cpuCores,
      ttlMs: body.ttlMs,
    });
  });

  /* --------------------------------------------------------- usage feed (§8.1) */

  const positiveInt = (raw: unknown, fallback: number): number => {
    if (typeof raw !== "string") return fallback;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
  };

  const usageNonce = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

  app.get("/v1/usage", async (req) => {
    const query = req.query as { cursor?: string; limit?: string; nonce?: string };
    return manager.usageSnapshot({
      cursor: typeof query.cursor === "string" && query.cursor.length > 0 ? query.cursor : null,
      limit: positiveInt(query.limit, 200),
      nonce: usageNonce(query.nonce),
    });
  });

  app.get("/v1/usage/events", async (req) => {
    const query = req.query as { after?: string; limit?: string; nonce?: string };
    return manager.usage.events(
      positiveInt(query.after, 0),
      positiveInt(query.limit, 200),
      usageNonce(query.nonce),
    );
  });

  app.post("/v1/usage/events/ack", async (req) => {
    const body = req.body as UsageAckRequest;
    if (typeof body?.upTo !== "number") throw badRequest("upTo is required");
    return manager.usage.ack(body.upTo);
  });

  app.get("/v1/images", async () => ({ images: await manager.imagesRef.list() }));

  app.get("/v1/images/*", async (req) => {
    const ref = decodeURIComponent((req.params as Record<string, string>)["*"] ?? "");
    const image = await manager.imagesRef.resolve(ref);
    if (!image) throw notFound(`image ${ref} has not been pulled`);
    return { ref: image.ref, state: "active", createdAt: image.pulledAt };
  });

  app.post("/v1/images", async (req) => {
    const body = req.body as ImagePullRequest;
    if (!body?.ref) throw badRequest("ref is required");
    if (
      body.auth !== undefined &&
      (!body.auth ||
        typeof body.auth.username !== "string" ||
        !body.auth.username ||
        typeof body.auth.password !== "string" ||
        !body.auth.password)
    ) {
      throw badRequest("auth.username and auth.password must be non-empty strings");
    }
    const image = await manager.imagesRef.pull(body.ref, {
      auth: body.auth,
      onProgress: (line) => log.info({ pull: line }, "image pull"),
    });
    return { ref: image.ref, state: "active", createdAt: image.pulledAt };
  });

  // A build takes minutes, longer than a client should wait for headers, so the outcome is
  // streamed (see DeriveImageEvent) with a heartbeat. A refusal is still a plain 4xx. The
  // build runs to completion even if the client goes away, and a later call for the same
  // ref joins it or finds the result.
  const deriver = new ImageDeriver(manager, cfg.paths.spool, log);
  app.post("/v1/images/derive", async (req, reply) => {
    const plan = planDerive(req.body);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    // The client may leave mid-build; its socket's errors must not escape as unhandled.
    reply.raw.on("error", () => undefined);
    const send = (event: DeriveImageEvent): void => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`${JSON.stringify(event)}\n`);
    };
    const heartbeat = setInterval(() => send({ heartbeat: true }), 30_000);
    try {
      const image = await deriver.derive(plan, (line) => send({ log: line }));
      send({ done: { ref: image.ref, state: "active", createdAt: image.pulledAt } });
    } catch (err) {
      log.warn({ err, image: plan.ref.ref }, "image derivation failed");
      const error = err instanceof ServiceError
        ? err.toWire()
        : { code: "internal", message: err instanceof Error ? err.message : String(err) };
      send({ error: { ...error, ...(err instanceof DeriveScriptFailure ? { outputTail: err.outputTail } : {}) } });
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
  });

  registerExecRoute(app, manager, log, metrics);
  registerPtyRoute(app, manager, log, metrics);

  return app;
}
