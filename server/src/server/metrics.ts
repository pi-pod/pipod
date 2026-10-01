/**
 * Prometheus metrics for private scraping.
 *
 * Cardinality is a hard constraint: labels are allowlisted enums (HTTP method, Fastify
 * route templates, provider ids, worker names). Request paths, user ids, org ids, pod ids,
 * tokens, and SQL never become labels. /metrics is unauthenticated unless METRICS_TOKEN is
 * set; scrape it only on a private network, the same way as /healthz.
 *
 * Cluster-wide inventory (pod/job/queue depths) is emitted only by ROLE=worker or ROLE=all
 * so a split api+gateway+worker scrape does not triple-count. Process-local series (HTTP,
 * this process's pool, counters this process observed, gateway holds) are emitted by every
 * role that has them.
 */
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";
import prometheus from "@prometheus-io/client";
import { setDbMetricsHook } from "./db/index.js";

const { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } = prometheus;

const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_HEX_SEGMENT = /\/[0-9a-f]{16,}(?:\/|$)/i;
const ROUTE_CHARS = /^\/[A-Za-z0-9_.:*/-]{0,119}$/;
const WORKER_NAME = /^[a-z][a-z0-9_-]{0,39}$/;

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const HTTP_STATUSES = new Set([
  "200",
  "201",
  "202",
  "204",
  "400",
  "401",
  "403",
  "404",
  "409",
  "410",
  "413",
  "429",
  "500",
  "502",
  "503",
]);
const ROLES = new Set(["api", "gateway", "worker", "all"]);
const PROVIDERS = new Set(["host", "sandbox"]);
const POD_STATES = new Set(["active", "archived"]);
const PROVIDER_STATES = new Set([
  "preparing_image",
  "provisioning",
  "starting",
  "started",
  "stopping",
  "stopped",
  "archiving",
  "archived",
  "deleting",
  "error",
  "gone",
]);
const PROVIDER_OPERATIONS = new Set(["start", "stop", "archive", "delete"]);
const JOB_STATUSES = new Set(["active", "paused", "completed"]);
const JOB_RUN_LIVE_STATUSES = new Set(["running", "interrupted"]);
const JOB_RUN_TERMINALS = new Set(["completed", "failed"]);
const PUSH_KINDS = new Set([
  "turn_completed",
  "interaction_pending",
  "session_ended",
  "pod_error",
  "idle_stop",
  "archived",
  "job_failed",
]);
const PUSH_RESULTS = new Set(["enqueued", "delivered", "failed", "dropped"]);
const QUEUE_PROMPT_STATUSES = new Set(["pending", "delivering", "delivered", "failed", "unknown"]);
const DB_KINDS = new Set(["query", "transaction"]);
const DB_RESULTS = new Set(["ok", "error"]);
const GATEWAY_ATTACH_RESULTS = new Set(["ok", "error"]);
const GATEWAY_END_KINDS = new Set(["retryable", "asleep", "exited", "unavailable"]);
const WORKER_RESULTS = new Set(["ok", "error"]);
const POD_LAUNCH_RESULTS = new Set(["accepted", "started", "failed"]);

/** Process-local series. Cluster inventory lives on `clusterRegister`. */
export const metricsRegister = new Registry();
const clusterRegister = new Registry();

let processMetricsStarted = false;
let dbHookInstalled = false;
let metricsSources: MetricsSources = {};

export interface MetricsSources {
  role?: string;
  gatewaySessions?: () => number;
  gatewayPodTransports?: () => number;
  gatewayAttachesInFlight?: () => number;
}

export type JobRunTerminal = "completed" | "failed";

function allow(value: string, allowed: ReadonlySet<string>): string {
  return allowed.has(value) ? value : "other";
}

function elapsedSeconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e9;
}

export function publishesClusterInventory(role: string | undefined): boolean {
  return role === "worker" || role === "all";
}

export function serverVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [here, join(here, ".."), join(here, "../.."), process.cwd()]) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === "pi-pod-server" && parsed.version) return parsed.version;
    } catch {
      // Source, bundled dist, and cwd all try; missing files are expected.
    }
  }
  return "0.1.0";
}

const info = new Gauge({
  name: "pipod_info",
  help: "Build and role of this pi-pod-server process.",
  labelNames: ["role", "version"] as const,
  registers: [metricsRegister],
});

const httpRequests = new Counter({
  name: "pipod_http_requests_total",
  help: "HTTP requests handled by this process, excluding /metrics scrapes and WebSocket upgrades.",
  labelNames: ["method", "route", "status"] as const,
  registers: [metricsRegister],
});

const httpDuration = new Histogram({
  name: "pipod_http_request_duration_seconds",
  help: "HTTP request duration in seconds, excluding /metrics scrapes and WebSocket upgrades.",
  labelNames: ["method", "route"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegister],
});

const dbOperations = new Counter({
  name: "pipod_db_operations_total",
  help: "Database operations issued by this process.",
  labelNames: ["kind", "result"] as const,
  registers: [metricsRegister],
});

const dbDuration = new Histogram({
  name: "pipod_db_operation_duration_seconds",
  help: "Database operation duration in seconds.",
  labelNames: ["kind"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegister],
});

const dbPoolConnections = new Gauge({
  name: "pipod_db_pool_connections",
  help: "pg.Pool totalCount: clients currently in this process's pool.",
  registers: [metricsRegister],
});

const dbPoolIdleConnections = new Gauge({
  name: "pipod_db_pool_idle_connections",
  help: "pg.Pool idleCount: pooled clients sitting unused.",
  registers: [metricsRegister],
});

const dbPoolBusyConnections = new Gauge({
  name: "pipod_db_pool_busy_connections",
  help: "Pooled clients checked out (totalCount - idleCount).",
  registers: [metricsRegister],
});

const dbPoolWaitingClients = new Gauge({
  name: "pipod_db_pool_waiting_clients",
  help: "pg.Pool waitingCount: callers queued for a free client, not connections.",
  registers: [metricsRegister],
});

const podLaunches = new Counter({
  name: "pipod_pod_launches_total",
  help: "Pod launch attempts observed by this process.",
  labelNames: ["provider", "result"] as const,
  registers: [metricsRegister],
});

const CAPACITY_WAIT_OUTCOMES = new Set(["enqueued", "admitted", "expired", "cancelled", "orphaned"]);
const capacityWaits = new Counter({
  name: "pipod_capacity_waits_total",
  help: "Bounded capacity waits observed by this process (low-cardinality outcome only).",
  labelNames: ["outcome"] as const,
  registers: [metricsRegister],
});

export function observeCapacityWait(outcome: "enqueued" | "admitted" | "expired" | "cancelled" | "orphaned"): void {
  capacityWaits.inc({ outcome: allow(outcome, CAPACITY_WAIT_OUTCOMES) });
}

const CPU_GRANT_RESULTS = new Set(["issued", "failed", "skipped"]);
const cpuGrants = new Counter({
  name: "pipod_cpu_grants_total",
  help: "Fleet CPU budget grants issued by the allocator (host ids stay out of labels).",
  labelNames: ["result"] as const,
  registers: [metricsRegister],
});

export function observeCpuGrant(result: "issued" | "failed" | "skipped"): void {
  cpuGrants.inc({ result: allow(result, CPU_GRANT_RESULTS) });
}

const providerOperations = new Counter({
  name: "pipod_provider_operations_total",
  help: "Provider sandbox start/stop/archive/delete issued by this process. Launch-time provider.create is counted by pipod_pod_launches_total, not here.",
  labelNames: ["provider", "operation", "result"] as const,
  registers: [metricsRegister],
});

const providerDuration = new Histogram({
  name: "pipod_provider_operation_duration_seconds",
  help: "Duration of provider sandbox start/stop/archive/delete. Launch-time provider.create is not timed here.",
  labelNames: ["provider", "operation"] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegister],
});

const jobRuns = new Counter({
  name: "pipod_job_runs_total",
  help: "Terminal job-run transitions on this process. Counted once when a run becomes completed or failed, including abandoned launches and expired interrupts. Interrupted is a live state, not a result.",
  labelNames: ["result"] as const,
  registers: [metricsRegister],
});

const pushMessages = new Counter({
  name: "pipod_push_messages_total",
  help: "Push queue messages observed by this process.",
  labelNames: ["kind", "result"] as const,
  registers: [metricsRegister],
});

const workerTicks = new Counter({
  name: "pipod_worker_ticks_total",
  help: "Background worker ticks on this process.",
  labelNames: ["worker", "result"] as const,
  registers: [metricsRegister],
});

const workerDuration = new Histogram({
  name: "pipod_worker_tick_duration_seconds",
  help: "Background worker tick duration in seconds.",
  labelNames: ["worker"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 5, 15, 30, 60, 120],
  registers: [metricsRegister],
});

const gatewaySessions = new Gauge({
  name: "pipod_gateway_sessions",
  help: "Live gateway sessions held by this process.",
  registers: [metricsRegister],
});

const gatewayPodTransports = new Gauge({
  name: "pipod_gateway_pod_transports",
  help: "Live pod-to-gateway transports held by this process.",
  registers: [metricsRegister],
});

const gatewayAttachesInFlight = new Gauge({
  name: "pipod_gateway_attaches_in_flight",
  help: "Gateway session attaches currently in progress on this process.",
  registers: [metricsRegister],
});

const gatewayAttaches = new Counter({
  name: "pipod_gateway_attaches_total",
  help: "Gateway session attach attempts on this process.",
  labelNames: ["provider", "result"] as const,
  registers: [metricsRegister],
});

const gatewayAttachDuration = new Histogram({
  name: "pipod_gateway_attach_duration_seconds",
  help: "Gateway session attach duration in seconds.",
  labelNames: ["provider"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [metricsRegister],
});

const gatewaySessionEnds = new Counter({
  name: "pipod_gateway_session_ends_total",
  help: "Gateway session endings on this process.",
  labelNames: ["kind"] as const,
  registers: [metricsRegister],
});

const pods = new Gauge({
  name: "pipod_pods",
  help: "Pods known to the control plane, excluding gone sandboxes. Emitted only by ROLE=worker or ROLE=all.",
  labelNames: ["state", "provider_state", "provider"] as const,
  registers: [clusterRegister],
});

const jobs = new Gauge({
  name: "pipod_jobs",
  help: "Scheduled jobs that are not archived. Emitted only by ROLE=worker or ROLE=all.",
  labelNames: ["status"] as const,
  registers: [clusterRegister],
});

const jobsDue = new Gauge({
  name: "pipod_jobs_due",
  help: "Active jobs whose next run is at or before now (scheduler backlog). Emitted only by ROLE=worker or ROLE=all.",
  registers: [clusterRegister],
});

const jobRunsLive = new Gauge({
  name: "pipod_job_runs",
  help: "Job runs currently running or interrupted. Emitted only by ROLE=worker or ROLE=all.",
  labelNames: ["status"] as const,
  registers: [clusterRegister],
});

const pushQueuePending = new Gauge({
  name: "pipod_push_queue_pending",
  help: "Push messages not yet delivered or failed (actionable depth, including backoff). Emitted only by ROLE=worker or ROLE=all.",
  registers: [clusterRegister],
});

const pushQueueDue = new Gauge({
  name: "pipod_push_queue_due",
  help: "Pending push messages whose next attempt is due. Emitted only by ROLE=worker or ROLE=all.",
  registers: [clusterRegister],
});

const queuedPrompts = new Gauge({
  name: "pipod_queued_prompts",
  help: "Queued prompts waiting for a ready session. Emitted only by ROLE=worker or ROLE=all.",
  labelNames: ["status"] as const,
  registers: [clusterRegister],
});

export function setMetricsSources(sources: MetricsSources): void {
  metricsSources = sources;
  const role = allow(sources.role ?? "all", ROLES);
  info.reset();
  info.set({ role, version: serverVersion() }, 1);
}

function installDbHook(): void {
  if (dbHookInstalled) return;
  dbHookInstalled = true;
  setDbMetricsHook((event) => observeDbOperation(event.kind, event.result, event.seconds));
}

export function ensureProcessMetrics(): void {
  installDbHook();
  if (processMetricsStarted) return;
  processMetricsStarted = true;
  collectDefaultMetrics({ register: metricsRegister });
}

export function resetMetrics(): void {
  metricsRegister.resetMetrics();
  clusterRegister.resetMetrics();
  if (metricsSources.role) {
    info.set({ role: allow(metricsSources.role, ROLES), version: serverVersion() }, 1);
  }
}

export function httpRouteLabel(route: string | undefined): string {
  if (!route) return "unmatched";
  const path = route.split("?")[0] ?? route;
  if (path === "/metrics") return "/metrics";
  if (UUID_IN_PATH.test(path) || LONG_HEX_SEGMENT.test(path)) return "unmatched";
  if (!ROUTE_CHARS.test(path)) return "other";
  return path;
}

export function isHttpMetricsExcluded(req: {
  url?: string;
  ws?: boolean;
  headers?: { upgrade?: string | string[] };
  routeOptions?: { url?: string; config?: unknown };
}): boolean {
  if (req.ws === true) return true;
  const upgrade = req.headers?.upgrade;
  const upgradeValue = Array.isArray(upgrade) ? upgrade[0] : upgrade;
  if (typeof upgradeValue === "string" && upgradeValue.toLowerCase() === "websocket") return true;
  const config = req.routeOptions?.config;
  if (config && typeof config === "object" && "websocket" in config && config.websocket === true) {
    return true;
  }
  const route = req.routeOptions?.url;
  if (route === "/metrics") return true;
  const raw = (req.url ?? "").split("?")[0];
  return raw === "/metrics";
}

export function authorizeMetricsScrape(
  authorization: string | string[] | undefined,
  token: string | undefined,
): boolean {
  if (!token) return true;
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  if (got.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(got, expected);
}

function recordHttpRequest(req: FastifyRequest, reply: FastifyReply): void {
  if (isHttpMetricsExcluded(req)) return;
  const method = allow(req.method.toUpperCase(), HTTP_METHODS);
  const route = httpRouteLabel(req.routeOptions?.url);
  const status = allow(String(reply.statusCode), HTTP_STATUSES);
  httpRequests.inc({ method, route, status });
  const started = req.metricsStartedAt;
  if (started !== undefined) {
    httpDuration.observe({ method, route }, elapsedSeconds(started));
  }
}

export function observeDbOperation(kind: "query" | "transaction", result: "ok" | "error", seconds: number): void {
  dbOperations.inc({ kind: allow(kind, DB_KINDS), result: allow(result, DB_RESULTS) });
  dbDuration.observe({ kind: allow(kind, DB_KINDS) }, seconds);
}

export function observePodLaunch(provider: string, result: "accepted" | "started" | "failed"): void {
  podLaunches.inc({ provider: allow(provider, PROVIDERS), result: allow(result, POD_LAUNCH_RESULTS) });
}

/** Times start/stop/archive/delete against an existing sandbox. provider.create during launch is
 *  not wrapped: its success/failure is `pipod_pod_launches_total`, and wrapping create would
 *  double-count wall time already attributed to the launch. */
export async function withProviderOperation<T>(
  provider: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const labels = {
    provider: allow(provider, PROVIDERS),
    operation: allow(operation, PROVIDER_OPERATIONS),
  };
  const stop = providerDuration.startTimer(labels);
  try {
    const result = await work();
    providerOperations.inc({ ...labels, result: "ok" });
    return result;
  } catch (error) {
    providerOperations.inc({ ...labels, result: "error" });
    throw error;
  } finally {
    stop();
  }
}

/** Count a terminal job-run status change. `count` is the UPDATE rowCount so a no-op is silent. */
export function observeJobRun(result: JobRunTerminal, count = 1): void {
  if (count <= 0) return;
  jobRuns.inc({ result: allow(result, JOB_RUN_TERMINALS) as JobRunTerminal }, count);
}

export function observePushMessage(kind: string | undefined, result: string, count = 1): void {
  if (count <= 0) return;
  pushMessages.inc({ kind: allow(kind ?? "other", PUSH_KINDS), result: allow(result, PUSH_RESULTS) }, count);
}

export function workerLabel(name: string): string {
  return WORKER_NAME.test(name) ? name : "other";
}

export async function trackWorkerTick<T>(name: string, job: () => Promise<T>): Promise<T> {
  const worker = workerLabel(name);
  const stop = workerDuration.startTimer({ worker });
  try {
    const result = await job();
    workerTicks.inc({ worker, result: "ok" });
    return result;
  } catch (error) {
    workerTicks.inc({ worker, result: allow("error", WORKER_RESULTS) });
    throw error;
  } finally {
    stop();
  }
}

export function observeGatewayAttach(provider: string, result: "ok" | "error", seconds?: number): void {
  const allowedProvider = allow(provider, PROVIDERS);
  gatewayAttaches.inc({
    provider: allowedProvider,
    result: allow(result, GATEWAY_ATTACH_RESULTS),
  });
  if (seconds !== undefined && result === "ok") {
    gatewayAttachDuration.observe({ provider: allowedProvider }, seconds);
  }
}

export function observeGatewaySessionEnd(kind: string): void {
  gatewaySessionEnds.inc({ kind: allow(kind, GATEWAY_END_KINDS) });
}

function setGaugeCounts<R extends { count: string | number }>(
  gauge: { reset(): void; set(labels: Record<string, string>, value: number): void },
  rows: R[],
  labelsFor: (row: R) => Record<string, string>,
): void {
  gauge.reset();
  for (const row of rows) {
    const value = Number(row.count);
    if (!Number.isFinite(value)) continue;
    gauge.set(labelsFor(row), value);
  }
}

async function inventoryQuery<R extends Record<string, unknown>>(text: string): Promise<R[]> {
  const { getPool } = await import("./db/index.js");
  const result = await getPool().query<R>(text);
  return result.rows;
}

async function refreshProcessGauges(): Promise<void> {
  try {
    const { getPool } = await import("./db/index.js");
    const pool = getPool();
    dbPoolConnections.set(pool.totalCount);
    dbPoolIdleConnections.set(pool.idleCount);
    dbPoolBusyConnections.set(Math.max(0, pool.totalCount - pool.idleCount));
    dbPoolWaitingClients.set(pool.waitingCount);
  } catch {
    // An absent pool is normal when no database is configured.
  }

  const sessionFn = metricsSources.gatewaySessions;
  const transportFn = metricsSources.gatewayPodTransports;
  const inflightFn = metricsSources.gatewayAttachesInFlight;
  if (sessionFn) gatewaySessions.set(sessionFn());
  if (transportFn) gatewayPodTransports.set(transportFn());
  if (inflightFn) gatewayAttachesInFlight.set(inflightFn());
}

async function refreshClusterInventory(): Promise<void> {
  try {
    const { getPool } = await import("./db/index.js");
    getPool();
  } catch {
    return;
  }

  try {
    const podRows = await inventoryQuery<{
      state: string;
      provider_state: string;
      provider: string;
      count: string | number;
    }>(
      `SELECT state, provider_state, provider, count(*)::int AS count
       FROM pods
       WHERE provider_state <> 'gone'
       GROUP BY state, provider_state, provider`,
    );
    setGaugeCounts(pods, podRows, (row) => ({
      state: allow(row.state, POD_STATES),
      provider_state: allow(row.provider_state, PROVIDER_STATES),
      provider: allow(row.provider, PROVIDERS),
    }));
  } catch {
    // Inventory is best-effort: a scrape must still return process series.
  }

  try {
    const jobRows = await inventoryQuery<{ status: string; count: string | number }>(
      `SELECT status, count(*)::int AS count FROM jobs WHERE archived_at IS NULL GROUP BY status`,
    );
    setGaugeCounts(jobs, jobRows, (row) => ({ status: allow(row.status, JOB_STATUSES) }));
  } catch {
    // see above
  }

  try {
    const due = await inventoryQuery<{ count: string | number }>(
      `SELECT count(*)::int AS count FROM jobs
       WHERE status = 'active' AND archived_at IS NULL AND next_run_at <= now()`,
    );
    jobsDue.set(Number(due[0]?.count ?? 0));
  } catch {
    // see above
  }

  try {
    const runRows = await inventoryQuery<{ status: string; count: string | number }>(
      `SELECT status, count(*)::int AS count FROM job_runs
       WHERE status IN ('running', 'interrupted')
       GROUP BY status`,
    );
    setGaugeCounts(jobRunsLive, runRows, (row) => ({ status: allow(row.status, JOB_RUN_LIVE_STATUSES) }));
  } catch {
    // see above
  }

  try {
    const pending = await inventoryQuery<{ count: string | number }>(
      `SELECT count(*)::int AS count FROM push_queue
       WHERE delivered_at IS NULL AND failed_at IS NULL`,
    );
    pushQueuePending.set(Number(pending[0]?.count ?? 0));
  } catch {
    // see above
  }

  try {
    const due = await inventoryQuery<{ count: string | number }>(
      `SELECT count(*)::int AS count FROM push_queue
       WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt <= now()`,
    );
    pushQueueDue.set(Number(due[0]?.count ?? 0));
  } catch {
    // see above
  }

  try {
    const promptRows = await inventoryQuery<{ status: string; count: string | number }>(
      `SELECT status, count(*)::int AS count FROM queued_prompts
       WHERE status IN ('pending', 'delivering', 'unknown')
       GROUP BY status`,
    );
    setGaugeCounts(queuedPrompts, promptRows, (row) => ({
      status: allow(row.status, QUEUE_PROMPT_STATUSES),
    }));
  } catch {
    // see above
  }
}

export async function renderMetrics(): Promise<string> {
  await refreshProcessGauges();
  const processBody = await metricsRegister.metrics();
  if (!publishesClusterInventory(metricsSources.role)) return processBody;
  await refreshClusterInventory();
  const clusterBody = await clusterRegister.metrics();
  return processBody.endsWith("\n") ? processBody + clusterBody : `${processBody}\n${clusterBody}`;
}

declare module "fastify" {
  interface FastifyRequest {
    metricsStartedAt?: bigint;
  }
}

/** Duck-typed Fastify HTTP surface so pino-logger and Zod-typed instances both typecheck. */
export interface MetricsHttpApp {
  addHook(name: "onRequest", handler: (req: FastifyRequest) => void | Promise<void>): unknown;
  addHook(
    name: "onResponse",
    handler: (req: FastifyRequest, reply: FastifyReply) => void | Promise<void>,
  ): unknown;
  get(path: string, handler: (req: FastifyRequest, reply: FastifyReply) => unknown): unknown;
  get(
    path: string,
    opts: { logLevel?: string; schema?: { hide?: boolean } },
    handler: (req: FastifyRequest, reply: FastifyReply) => unknown,
  ): unknown;
}

export function registerMetrics(
  app: MetricsHttpApp,
  options: { token?: string; role?: string } = {},
): void {
  ensureProcessMetrics();
  if (options.role) setMetricsSources({ ...metricsSources, role: options.role });

  app.addHook("onRequest", async (req) => {
    req.metricsStartedAt = process.hrtime.bigint();
  });
  app.addHook("onResponse", async (req, reply) => {
    recordHttpRequest(req, reply);
  });

  app.get(
    "/metrics",
    {
      logLevel: "warn",
      schema: { hide: true },
    },
    async (req, reply) => {
      if (!authorizeMetricsScrape(req.headers.authorization, options.token)) {
        return reply
          .code(401)
          .header("www-authenticate", "Bearer")
          .send({ error: "unauthorized", detail: null });
      }
      const body = await renderMetrics();
      return reply
        .header("content-type", metricsRegister.contentType)
        .header("cache-control", "no-store")
        .send(body);
    },
  );
}
