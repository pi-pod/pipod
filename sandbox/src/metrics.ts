import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type PrometheusContentType,
} from "prom-client";
import type { ObjectStore } from "./archive/types.js";
import type { ImageStore } from "./images/types.js";
import type { Runtime } from "./runtime/crun.js";

/** Standard Prometheus scrape path. Not under `/v1` so scrapers need no API prefix. */
export const METRICS_PATH = "/metrics";

/** Single series for every request that did not match a registered template. */
export const UNMATCHED_ROUTE = "unmatched";

/**
 * Fastify route templates the HTTP metrics may emit. Anything else, including a raw URL,
 * collapses to {@link UNMATCHED_ROUTE} so unknown paths cannot create unbounded series.
 */
export const HTTP_ROUTE_TEMPLATES = new Set<string>([
  METRICS_PATH,
  "/v1/healthz",
  "/v1/authz",
  "/v1/sandboxes",
  "/v1/sandboxes/import",
  "/v1/sandboxes/:id",
  "/v1/sandboxes/:id/start",
  "/v1/sandboxes/:id/stop",
  "/v1/sandboxes/:id/archive",
  "/v1/sandboxes/:id/archive-if-stopped",
  "/v1/sandboxes/:id/archive",
  "/v1/sandboxes/:id/hold",
  "/v1/sandboxes/:id/retire",
  "/v1/sandboxes/:id/labels",
  "/v1/sandboxes/:id/owner",
  "/v1/sandboxes/:id/activity",
  "/v1/sandboxes/:id/retention",
  "/v1/sandboxes/:id/resources",
  "/v1/sandboxes/:id/files",
  "/v1/sandboxes/:id/ptys",
  "/v1/sandboxes/:id/exec",
  "/v1/sandboxes/:id/pty",
  "/v1/images",
  "/v1/images/*",
  "/v1/capacity",
  "/v1/operations/:key",
  "/v1/tenants/:userKey",
  "/v1/tenants/:userKey/cpu-grant",
  "/v1/usage",
  "/v1/usage/events",
  "/v1/usage/events/ack",
]);

const SANDBOX_TIERS = ["hot", "warm", "stopped", "archived", "error"] as const;

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const OP_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const EXEC_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 120];
/** PTY sessions routinely last minutes to hours; HTTP buckets would overflow immediately. */
const WS_BUCKETS = [0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 10800, 21600, 86400];

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

export type OpResult = "ok" | "error" | "noop";
export type ExecResult = "ok" | "error" | "timeout";
export type FileResult = "ok" | "error" | "not_found";
export type WsKind = "exec" | "pty";
export type WsResult = "complete" | "error" | "disconnect";
export type AdmissionResult = "ok" | "denied";
export type AdmissionResource = "cpu" | "memory" | "disk" | "network" | "none" | "other";
/** Usage-snapshot cadence classes (§8.1.1): full per-poll detail, daily archived heartbeat, or ambiguous error rows at full cadence. */
export type UsageSnapshotClass = "live" | "heartbeat" | "error";
export type SandboxOp =
  | "create"
  | "start"
  | "stop"
  | "freeze"
  | "thaw"
  | "archive"
  | "restore"
  | "delete"
  | "import"
  | "archive_orphan"
  | "reconcile_adopt"
  | "reconcile_stop";
export type ReaperAction =
  | "idle_stop"
  | "freeze"
  | "archive"
  | "archive_skipped"
  | "pressure_freeze"
  | "pressure_stop"
  | "cpu_veto"
  | "grant_expired"
  | "dr_snapshot";
export type ArchiveOp = "put" | "get" | "head" | "list" | "delete";
export type RuntimeOp = "start";
export type FileOp = "upload" | "download";
export type PtyOp = "open" | "attach";

export interface CapacityMetricsSnapshot {
  memoryBudgetBytes: number;
  memoryAvailableBytes: number;
  memoryDebtBytes: number;
  memoryQuarantinedBytes: number;
  diskAvailableBytes: number;
  diskQuarantinedBytes: number;
  transitionsInFlight: number;
  archivesInFlight: number;
  quarantinedOperations: number;
  usageOutboxRows: number;
}

export interface MetricsSnapshot {
  sandboxesByTier: Record<string, number>;
  committed: { cpu: number; memoryBytes: number };
  disk: { committedBytes: number; capacityBytes: number };
  ptysActive: number;
  booting: number;
  hostPressure: number;
  hostMemoryAvailableBytes: number;
  hostMemoryTotalBytes: number;
  /** Admission-controller aggregates (§6.3); optional so older binders keep working. */
  capacity?: CapacityMetricsSnapshot;
}

export interface MetricsSource {
  /** One call per scrape; implementors should read SQLite/statfs once here. */
  snapshot(): MetricsSnapshot;
}

export interface MetricsOptions {
  register?: Registry;
  /** Process/Node default metrics. Off in unit tests so we do not leave scrape intervals behind. */
  defaultMetrics?: boolean;
  version?: string;
}

export const EMPTY_SNAPSHOT: MetricsSnapshot = {
  sandboxesByTier: { hot: 0, warm: 0, stopped: 0, archived: 0, error: 0 },
  committed: { cpu: 0, memoryBytes: 0 },
  disk: { committedBytes: 0, capacityBytes: 0 },
  ptysActive: 0,
  booting: 0,
  hostPressure: -1,
  hostMemoryAvailableBytes: 0,
  hostMemoryTotalBytes: 0,
};

/**
 * Path-only view of a request URL. Query strings never become metric labels.
 */
export function requestPath(url: string): string {
  return url.split("?", 1)[0] || "/";
}

export function isMetricsPath(url: string, path: string = METRICS_PATH): boolean {
  return requestPath(url) === path;
}

export function httpMethodLabel(method: string): string {
  const upper = method.toUpperCase();
  return HTTP_METHODS.has(upper) ? upper : "other";
}

export function httpStatusLabel(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "unknown";
}

/**
 * Low-cardinality HTTP route. Only registered Fastify templates are emitted; every
 * unmatched or raw URL becomes {@link UNMATCHED_ROUTE}.
 */
export function httpRouteLabel(routeTemplate: string | undefined): string {
  if (!routeTemplate) return UNMATCHED_ROUTE;
  const path = requestPath(routeTemplate);
  return HTTP_ROUTE_TEMPLATES.has(path) ? path : UNMATCHED_ROUTE;
}

/** Map an admission-denial reason onto a tiny, stable resource label. */
export function admissionResource(reason: string | undefined): AdmissionResource {
  const text = reason ?? "";
  if (text.startsWith("memory")) return "memory";
  if (text.startsWith("cpu")) return "cpu";
  if (text.startsWith("disk")) return "disk";
  if (text.includes("network")) return "network";
  return "other";
}

export class Metrics {
  readonly register: Registry;
  readonly contentType: PrometheusContentType | string;
  private source: MetricsSource | null = null;
  private cached: MetricsSnapshot = EMPTY_SNAPSHOT;
  private static noneSingleton: Metrics | undefined;

  private readonly httpRequests: Counter;
  private readonly httpDuration: Histogram;
  private readonly wsActive: Gauge;
  private readonly wsConnections: Counter;
  private readonly wsDuration: Histogram;
  private readonly sandboxOps: Counter;
  private readonly sandboxOpDuration: Histogram;
  private readonly admissions: Counter;
  private readonly execs: Counter;
  private readonly execDuration: Histogram;
  private readonly files: Counter;
  private readonly ptys: Counter;
  private readonly imagePulls: Counter;
  private readonly imagePullDuration: Histogram;
  private readonly imageGcRemoved: Counter;
  private readonly archiveOps: Counter;
  private readonly archiveDuration: Histogram;
  private readonly archiveBytes: Counter;
  private readonly runtimeOps: Counter;
  private readonly reaperTicks: Counter;
  private readonly reaperTickDuration: Histogram;
  private readonly reaperActions: Counter;
  private readonly usageSnapshotRows: Gauge;
  private readonly usageSnapshotDuration: Histogram;

  /**
   * Shared sink for constructors that do not scrape. Avoids a discarded Registry per
   * Manager/Reaper/server in unit tests.
   */
  static none(): Metrics {
    return (Metrics.noneSingleton ??= new Metrics());
  }

  constructor(opts: MetricsOptions = {}) {
    this.register = opts.register ?? new Registry();
    this.contentType = this.register.contentType;
    if (opts.defaultMetrics) {
      collectDefaultMetrics({ register: this.register });
    }

    const registers = [this.register];
    const metrics = this;

    new Gauge({
      name: "pps_build_info",
      help: "Build information for pi-pod-sandbox (always 1).",
      labelNames: ["version"],
      registers,
    }).set({ version: opts.version ?? "0.1.0" }, 1);

    this.httpRequests = new Counter({
      name: "pps_http_requests_total",
      help: "HTTP requests handled by the sandbox service.",
      labelNames: ["method", "route", "status"],
      registers,
    });
    this.httpDuration = new Histogram({
      name: "pps_http_request_duration_seconds",
      help: "HTTP request duration in seconds.",
      labelNames: ["method", "route"],
      buckets: HTTP_BUCKETS,
      registers,
    });

    this.wsActive = new Gauge({
      name: "pps_ws_connections_active",
      help: "Open WebSocket connections.",
      labelNames: ["kind"],
      registers,
    });
    this.wsConnections = new Counter({
      name: "pps_ws_connections_total",
      help: "WebSocket connections closed, by kind and outcome.",
      labelNames: ["kind", "result"],
      registers,
    });
    this.wsDuration = new Histogram({
      name: "pps_ws_connection_duration_seconds",
      help: "WebSocket connection lifetime in seconds.",
      labelNames: ["kind"],
      buckets: WS_BUCKETS,
      registers,
    });

    new Gauge({
      name: "pps_sandboxes",
      help: "Sandboxes known to this host, by internal tier.",
      labelNames: ["tier"],
      registers,
      collect() {
        const counts = metrics.cached.sandboxesByTier;
        for (const tier of SANDBOX_TIERS) this.set({ tier }, counts[tier] ?? 0);
      },
    });
    new Gauge({
      name: "pps_sandboxes_booting",
      help: "Sandboxes admitted but not yet hot (they already owe their guarantee).",
      registers,
      collect() {
        this.set(metrics.cached.booting);
      },
    });
    this.sandboxOps = new Counter({
      name: "pps_sandbox_operations_total",
      help: "Sandbox lifecycle operations. create covers first launch; start is an explicit wake.",
      labelNames: ["op", "result"],
      registers,
    });
    this.sandboxOpDuration = new Histogram({
      name: "pps_sandbox_operation_duration_seconds",
      help: "Sandbox lifecycle operation duration in seconds.",
      labelNames: ["op"],
      buckets: OP_BUCKETS,
      registers,
    });
    this.admissions = new Counter({
      name: "pps_sandbox_admissions_total",
      help: "Admission-control decisions. One series per attempt (create or later start).",
      labelNames: ["result", "resource"],
      registers,
    });

    this.execs = new Counter({
      name: "pps_sandbox_execs_total",
      help: "Sandbox execs. Non-zero process exit codes still count as ok.",
      labelNames: ["result"],
      registers,
    });
    this.execDuration = new Histogram({
      name: "pps_sandbox_exec_duration_seconds",
      help: "Sandbox exec duration in seconds.",
      buckets: EXEC_BUCKETS,
      registers,
    });
    this.files = new Counter({
      name: "pps_sandbox_files_total",
      help: "Sandbox file upload and download operations.",
      labelNames: ["op", "result"],
      registers,
    });
    this.ptys = new Counter({
      name: "pps_sandbox_ptys_total",
      help: "PTY sessions opened or reattached.",
      labelNames: ["op"],
      registers,
    });
    new Gauge({
      name: "pps_sandbox_ptys_active",
      help: "Live PTY sessions held by the service.",
      registers,
      collect() {
        this.set(metrics.cached.ptysActive);
      },
    });

    this.imagePulls = new Counter({
      name: "pps_image_pulls_total",
      help: "OCI image pulls into the local layer store.",
      labelNames: ["result"],
      registers,
    });
    this.imagePullDuration = new Histogram({
      name: "pps_image_pull_duration_seconds",
      help: "OCI image pull duration in seconds.",
      buckets: OP_BUCKETS,
      registers,
    });
    this.imageGcRemoved = new Counter({
      name: "pps_image_gc_layers_removed_total",
      help: "Extracted image layers deleted by garbage collection.",
      registers,
    });

    this.archiveOps = new Counter({
      name: "pps_archive_operations_total",
      help: "Archive object-store operations.",
      labelNames: ["op", "result"],
      registers,
    });
    this.archiveDuration = new Histogram({
      name: "pps_archive_operation_duration_seconds",
      help: "Archive object-store operation duration in seconds.",
      labelNames: ["op"],
      buckets: OP_BUCKETS,
      registers,
    });
    this.archiveBytes = new Counter({
      name: "pps_archive_bytes_total",
      help: "Bytes written to the archive object store.",
      labelNames: ["op"],
      registers,
    });

    this.runtimeOps = new Counter({
      name: "pps_runtime_operations_total",
      help: "OCI runtime start operations. Kill/delete/state polls are not counted.",
      labelNames: ["op", "result"],
      registers,
    });

    this.reaperTicks = new Counter({
      name: "pps_reaper_ticks_total",
      help: "Reaper loop iterations.",
      labelNames: ["result"],
      registers,
    });
    this.reaperTickDuration = new Histogram({
      name: "pps_reaper_tick_duration_seconds",
      help: "Reaper loop duration in seconds.",
      buckets: HTTP_BUCKETS,
      registers,
    });
    this.reaperActions = new Counter({
      name: "pps_reaper_actions_total",
      help: "Actions taken by the reaper.",
      labelNames: ["action", "result"],
      registers,
    });

    this.usageSnapshotRows = new Gauge({
      name: "pps_usage_snapshot_rows",
      help: "Rows assembled by the most recent first-page usage snapshot, by cadence class (§8.1.1). Later pages of the same poll leave it untouched.",
      labelNames: ["class"],
      registers,
    });
    this.usageSnapshotDuration = new Histogram({
      name: "pps_usage_snapshot_duration_seconds",
      help: "Usage snapshot assembly duration in seconds (row scan plus sampling, before paging).",
      buckets: HTTP_BUCKETS,
      registers,
    });

    new Gauge({
      name: "pps_resource_committed_cpu",
      help: "CPU guarantees committed to live and booting sandboxes.",
      registers,
      collect() {
        this.set(metrics.cached.committed.cpu);
      },
    });
    new Gauge({
      name: "pps_resource_committed_memory_bytes",
      help: "Memory guarantees committed to live and booting sandboxes.",
      registers,
      collect() {
        this.set(metrics.cached.committed.memoryBytes);
      },
    });
    new Gauge({
      name: "pps_resource_disk_committed_bytes",
      help: "Disk quotas committed to non-archived sandboxes.",
      registers,
      collect() {
        this.set(metrics.cached.disk.committedBytes);
      },
    });
    new Gauge({
      name: "pps_resource_disk_capacity_bytes",
      help: "Disk capacity admission control compares against.",
      registers,
      collect() {
        this.set(metrics.cached.disk.capacityBytes);
      },
    });
    const capacityGauge = (name: string, help: string, pick: (c: CapacityMetricsSnapshot) => number): void => {
      new Gauge({
        name,
        help,
        registers,
        collect() {
          const c = metrics.cached.capacity;
          this.set(c ? pick(c) : 0);
        },
      });
    };
    capacityGauge("pps_admission_memory_budget_bytes", "Memory the admission controller may promise in total.", (c) => c.memoryBudgetBytes);
    capacityGauge("pps_admission_memory_available_bytes", "Memory headroom a new request's ceiling is compared against.", (c) => c.memoryAvailableBytes);
    capacityGauge("pps_admission_memory_debt_bytes", "Grandfathered commitments above the budget; blocks new admissions while > 0.", (c) => c.memoryDebtBytes);
    capacityGauge("pps_admission_memory_quarantined_bytes", "Unresolved reservations still charged against memory.", (c) => c.memoryQuarantinedBytes);
    capacityGauge("pps_admission_disk_available_bytes", "Disk headroom a full requested quota is compared against.", (c) => c.diskAvailableBytes);
    capacityGauge("pps_admission_disk_quarantined_bytes", "Leaked archived images and unresolved reservations charged against disk.", (c) => c.diskQuarantinedBytes);
    capacityGauge("pps_transitions_in_flight", "Launch/restore transitions holding a reservation.", (c) => c.transitionsInFlight);
    capacityGauge("pps_archives_in_flight", "Archive packs/uploads currently running.", (c) => c.archivesInFlight);
    capacityGauge("pps_admission_quarantined_operations", "Reservations awaiting operator resolution.", (c) => c.quarantinedOperations);
    capacityGauge("pps_usage_outbox_rows", "Unacknowledged usage events retained in the bounded outbox.", (c) => c.usageOutboxRows);

    new Gauge({
      name: "pps_host_memory_pressure",
      help: "Host memory PSI avg10 percent. -1 when the kernel does not expose PSI.",
      registers,
      collect() {
        this.set(metrics.cached.hostPressure);
      },
    });
    new Gauge({
      name: "pps_host_memory_available_bytes",
      help: "Host memory available as reported by the OS.",
      registers,
      collect() {
        this.set(metrics.cached.hostMemoryAvailableBytes);
      },
    });
    new Gauge({
      name: "pps_host_memory_total_bytes",
      help: "Host memory total as reported by the OS.",
      registers,
      collect() {
        this.set(metrics.cached.hostMemoryTotalBytes);
      },
    });
  }

  bind(source: MetricsSource): void {
    this.source = source;
  }

  /** Read the source once. Collectors never call into SQLite/stat themselves. */
  refreshSnapshot(): void {
    if (!this.source) return;
    try {
      this.cached = this.source.snapshot();
    } catch {
      /* fail-open: keep the last successful snapshot (or zeros) */
    }
  }

  async scrape(): Promise<string> {
    this.refreshSnapshot();
    try {
      return await this.register.metrics();
    } catch {
      return "# metrics scrape failed\n";
    }
  }

  observeHttp(method: string, route: string, status: string, seconds: number): void {
    this.httpRequests.inc({ method, route, status });
    this.httpDuration.observe({ method, route }, seconds);
  }

  wsOpened(kind: WsKind): void {
    this.wsActive.inc({ kind }, 1);
  }

  wsClosed(kind: WsKind, result: WsResult, seconds: number): void {
    this.wsActive.dec({ kind }, 1);
    this.wsConnections.inc({ kind, result });
    this.wsDuration.observe({ kind }, seconds);
  }

  recordAdmission(result: AdmissionResult, resource: AdmissionResource): void {
    this.admissions.inc({ result, resource });
  }

  recordSandboxOp(op: SandboxOp, result: OpResult): void {
    this.sandboxOps.inc({ op, result });
  }

  startTimer(op: SandboxOp): () => void {
    return this.sandboxOpDuration.startTimer({ op });
  }

  async timeSandboxOp<T>(op: SandboxOp, fn: () => Promise<T>): Promise<T> {
    const stop = this.startTimer(op);
    try {
      const value = await fn();
      this.recordSandboxOp(op, "ok");
      return value;
    } catch (error) {
      this.recordSandboxOp(op, "error");
      throw error;
    } finally {
      stop();
    }
  }

  recordExec(result: ExecResult, seconds: number): void {
    this.execs.inc({ result });
    this.execDuration.observe(seconds);
  }

  recordFile(op: FileOp, result: FileResult): void {
    this.files.inc({ op, result });
  }

  recordPty(op: PtyOp): void {
    this.ptys.inc({ op });
  }

  recordImagePull(result: OpResult, seconds: number): void {
    this.imagePulls.inc({ result: result === "noop" ? "ok" : result });
    this.imagePullDuration.observe(seconds);
  }

  recordImageGc(removed: number): void {
    if (removed > 0) this.imageGcRemoved.inc(removed);
  }

  recordArchive(op: ArchiveOp, result: OpResult, seconds: number, bytes?: number): void {
    const recorded = result === "noop" ? "ok" : result;
    this.archiveOps.inc({ op, result: recorded });
    this.archiveDuration.observe({ op }, seconds);
    if (recorded === "ok" && bytes !== undefined && bytes > 0) {
      this.archiveBytes.inc({ op }, bytes);
    }
  }

  recordRuntime(op: RuntimeOp, result: "ok" | "error"): void {
    this.runtimeOps.inc({ op, result });
  }

  recordReaperTick(result: OpResult, seconds: number): void {
    this.reaperTicks.inc({ result });
    this.reaperTickDuration.observe(seconds);
  }

  recordReaperAction(action: ReaperAction, result: OpResult): void {
    this.reaperActions.inc({ action, result });
  }

  recordUsageSnapshot(counts: Record<UsageSnapshotClass, number>, seconds: number): void {
    this.usageSnapshotRows.set({ class: "live" }, counts.live);
    this.usageSnapshotRows.set({ class: "heartbeat" }, counts.heartbeat);
    this.usageSnapshotRows.set({ class: "error" }, counts.error);
    this.recordUsageSnapshotDuration(seconds);
  }

  /** Assembly cost of one snapshot call, including follow-up pages of a drain. */
  recordUsageSnapshotDuration(seconds: number): void {
    this.usageSnapshotDuration.observe(seconds);
  }
}

export function instrumentObjectStore(inner: ObjectStore, metrics: Metrics): ObjectStore {
  const wrap = <A extends unknown[], R>(
    op: ArchiveOp,
    fn: (...args: A) => Promise<R>,
    sizeOf?: (result: R) => number | undefined,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      const started = process.hrtime.bigint();
      try {
        const result = await fn(...args);
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        metrics.recordArchive(op, "ok", seconds, sizeOf?.(result));
        return result;
      } catch (error) {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        metrics.recordArchive(op, "error", seconds);
        throw error;
      }
    };
  };
  return {
    kind: inner.kind,
    put: wrap("put", inner.put.bind(inner), (stored) => stored.size),
    get: wrap("get", inner.get.bind(inner)),
    head: wrap("head", inner.head.bind(inner)),
    list: wrap("list", inner.list.bind(inner)),
    delete: wrap("delete", inner.delete.bind(inner)),
  };
}

export function instrumentImageStore(inner: ImageStore, metrics: Metrics): ImageStore {
  return {
    resolve: (ref) => inner.resolve(ref),
    layerDir: (digest) => inner.layerDir(digest),
    list: () => inner.list(),
    pull: async (ref, options) => {
      const started = process.hrtime.bigint();
      try {
        const image = await inner.pull(ref, options);
        metrics.recordImagePull("ok", Number(process.hrtime.bigint() - started) / 1e9);
        return image;
      } catch (error) {
        metrics.recordImagePull("error", Number(process.hrtime.bigint() - started) / 1e9);
        throw error;
      }
    },
    gc: async (pinned) => {
      const removed = await inner.gc(pinned);
      metrics.recordImageGc(removed.length);
      return removed;
    },
  };
}

/** Only `start` is instrumented: teardown polls `state()` on a tight loop. */
export function instrumentRuntime(runtime: Runtime, metrics: Metrics): Runtime {
  const origStart = runtime.start.bind(runtime);
  runtime.start = async (...args: Parameters<Runtime["start"]>) => {
    try {
      const result = await origStart(...args);
      metrics.recordRuntime("start", "ok");
      return result;
    } catch (error) {
      metrics.recordRuntime("start", "error");
      throw error;
    }
  };
  return runtime;
}
