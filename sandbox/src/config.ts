import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { canonicalizeProxyOrigin, ProxyOriginPinError } from "./archive/proxy-origin-pin.js";

/**
 * Configuration is environment-only. The service is deployed as one container with a
 * mounted state volume; a config file would be a second thing to mount and a second
 * place for the token to leak into.
 */
const Schema = z.object({
  PI_POD_SANDBOX_TOKEN: z.string().min(16, "PI_POD_SANDBOX_TOKEN must be at least 16 chars"),
  PI_POD_SANDBOX_PORT: z.coerce.number().int().positive().default(8433),
  PI_POD_SANDBOX_HOST: z.string().default("0.0.0.0"),
  PI_POD_SANDBOX_STATE_DIR: z.string().default("/state"),
  /**
   * Names this host inside a fleet that shares one archive bucket and prefix. Sandbox
   * archives are already keyed by unique sandbox id, but DR snapshots are per host and would
   * otherwise overwrite each other.
   */
  PI_POD_SANDBOX_HOST_ID: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "PI_POD_SANDBOX_HOST_ID must be a bare object-key-safe name")
    .default(os.hostname()),
  /** `crun` for shared-kernel isolation, `runsc` for gVisor (§2, optional hardening). */
  PI_POD_SANDBOX_RUNTIME: z.string().default("crun"),
  PI_POD_SANDBOX_HOST_BACKEND: z.enum(["static", "boat"]).default("static"),
  /** Opt-in, immutable one-pod profile; never inferred from the vendor machine type. */
  PI_POD_SANDBOX_PROFILE: z.enum(["shared", "small-v1"]).default("shared"),
  /** Nonbillable, signed lifecycle observations on disposable small guests only. */
  PI_POD_SANDBOX_SERVICE_OBSERVATIONS: z.enum(["off", "shadow-v1"]).default("off"),
  PI_POD_SANDBOX_OBSERVATION_KEY_PATH: z.string().optional(),
  PI_POD_SANDBOX_OBSERVATION_KEY_ID: z.string().optional(),
  PI_POD_SANDBOX_DISK_ADMISSION: z.enum(["committed", "sparse"]).default("committed"),
  PI_POD_SANDBOX_STORAGE_QUOTA_GB: z.coerce.number().positive().optional(),
  PI_POD_SANDBOX_SPARSE_MIN_DISK_GB: z.coerce.number().min(0.125).default(0.25),

  /** Minutes of API silence before a hot sandbox is frozen and reclaimed (§6.2). */
  PI_POD_SANDBOX_WARM_AFTER_MINUTES: z.coerce.number().nonnegative().default(10),
  /** How often the reaper evaluates timers. */
  PI_POD_SANDBOX_REAPER_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  /** cgroup CPU-time delta (ms per reaper tick) above which a sandbox vetoes its own stop. */
  PI_POD_SANDBOX_CPU_VETO_MS: z.coerce.number().nonnegative().default(200),

  /** Host capacity the service keeps for itself; admission control sizes against the rest. */
  PI_POD_SANDBOX_RESERVE_MEMORY_GB: z.coerce.number().nonnegative().default(1),
  PI_POD_SANDBOX_RESERVE_CPU: z.coerce.number().nonnegative().default(0.5),
  /**
   * Kernel aggregate cap applied to every tenant parent cgroup (`pps/tenant-<key>`),
   * in GiB. This is the kill boundary that stops a bursting tenant from reclaiming
   * memory out of vendor/system services: per-sandbox `memory.max` partitions the tenant,
   * the tenant cap bounds the tenant. Unset defaults to the conservative boat value in
   * boat mode and to uncapped in static mode (static contract unchanged). An explicit 0
   * in boat mode is rejected at startup: a boat host must never silently run unlimited.
   */
  PI_POD_SANDBOX_TENANT_MEMORY_GB: z.coerce.number().nonnegative().default(0),
  /**
   * Total CPU cores a tenant parent may use. Unset derives `max(0.5, host CPUs − reserve)`
   * in boat mode and leaves the parent uncapped in static mode (grant-managed hosts keep
   * their grant/fallback semantics either way). Explicit 0 removes the cap.
   */
  PI_POD_SANDBOX_TENANT_CPU: z.coerce.number().nonnegative().optional(),
  /** State-volume capacity kept outside sparse per-sandbox disk commitments. */
  PI_POD_SANDBOX_RESERVE_DISK_GB: z.coerce.number().nonnegative().default(5),
  /** Host memory PSI (avg10, %) above which the pressure policy sheds load (§7.2). */
  PI_POD_SANDBOX_PRESSURE_THRESHOLD: z.coerce.number().nonnegative().default(20),

  /**
   * Memory admission policy. `ceiling` reserves each live sandbox's full memory ceiling
   * (the cost plan's initial native-fleet policy: six 4 GiB workloads fit a 24 GiB budget,
   * eight do not). `floor` is the legacy behaviour that only reserved the 0.5 GiB reclaim
   * floor and let ceilings overcommit.
   */
  PI_POD_SANDBOX_MEMORY_ADMISSION: z.enum(["ceiling", "floor"]).default("ceiling"),
  /**
   * Explicit memory-admission budget in GiB. Unset derives `min(total − reserve, fleet cap)`;
   * set it to the validated safe threshold for the host class rather than stacking reserves.
   */
  PI_POD_SANDBOX_MEMORY_BUDGET_GB: z.coerce.number().positive().optional(),
  /** Archive uploads running at once (reaper + explicit). Bounds spool use and upload bandwidth. */
  PI_POD_SANDBOX_MAX_CONCURRENT_ARCHIVES: z.coerce.number().int().positive().default(2),
  /** Launch/restore transitions in flight at once; more is `transition_capacity`, retryable. */
  PI_POD_SANDBOX_MAX_CONCURRENT_TRANSITIONS: z.coerce.number().int().positive().default(8),
  /** Spool (pack/restore staging) budget in GiB. Unset uses the disk reserve. */
  PI_POD_SANDBOX_SCRATCH_BUDGET_GB: z.coerce.number().nonnegative().optional(),
  /** How long create-operation tombstones outlive their completion (§6.5). */
  PI_POD_SANDBOX_OPERATION_RETENTION_HOURS: z.coerce.number().positive().default(72),
  /** Bounded usage-event outbox (§8.2): rows and age before unacknowledged events are dropped. */
  PI_POD_SANDBOX_USAGE_EVENT_MAX_ROWS: z.coerce.number().int().positive().default(50_000),
  PI_POD_SANDBOX_USAGE_EVENT_MAX_AGE_HOURS: z.coerce.number().positive().default(168),
  /**
   * Hard payload cap for `GET /v1/usage` snapshot pages (§8.1.1). A larger `limit`
   * is clamped, never honoured; parsed here so the knob cannot be a no-op.
   */
  PI_POD_SANDBOX_USAGE_MAX_ROWS: z.coerce.number().int().positive().default(1000),
  /** Off by default. `builtin` publishes the signed usage envelope from the host evidence key. */
  PI_POD_SANDBOX_EVIDENCE_SIGNING: z.enum(["off", "builtin"]).default("off"),
  /**
   * Legacy behaviour: silently clamp an oversized shape request down to the host maximum.
   * Off by default: an advertised 8 GiB request must be honoured or refused, never shrunk.
   */
  PI_POD_SANDBOX_CLAMP_OVERSIZED_SHAPES: z.enum(["0", "1", "true", "false"]).default("0"),
  /**
   * cpu.max applied to a tenant parent when its allocator grant expires. Unset removes the
   * cap (equal parent weights and per-sandbox 2-vCPU ceilings still apply).
   */
  PI_POD_SANDBOX_TENANT_CPU_FALLBACK_CORES: z.coerce.number().positive().optional(),
  /**
   * On a grant-managed host, refuse new launches for a tenant that has no current grant
   * (`fairness_degraded`, retryable) until the allocator recovers. Existing sandboxes keep
   * running either way. Only meaningful once a grant has ever been applied.
   */
  PI_POD_SANDBOX_GRANT_GATE_ADMISSION: z.enum(["0", "1", "true", "false"]).default("1"),
  /**
   * Rollout switch (§7.2): refuse create/start/restore of sandboxes without an owner so a
   * legacy flat row cannot relaunch beside tenant parents once the control plane has
   * initialized owners. Off by default; already-running unowned sandboxes are never stopped.
   */
  PI_POD_SANDBOX_REQUIRE_OWNER: z.enum(["0", "1", "true", "false"]).default("0"),

  /**
   * Hard ceiling on what every sandbox *together* may consume, enforced by the kernel on the
   * parent cgroup. Admission control only bounds guarantees, and a guarantee is not a cap, so
   * on a host shared with anything else this is what stops a bursting sandbox from reclaiming
   * memory out of its neighbours. 0 leaves the fleet uncapped.
   */
  PI_POD_SANDBOX_FLEET_MEMORY_GB: z.coerce.number().nonnegative().default(0),
  PI_POD_SANDBOX_FLEET_CPU: z.coerce.number().nonnegative().default(0),

  PI_POD_SANDBOX_DEFAULT_DISK_GB: z.coerce.number().positive().default(10),
  /**
   * Largest single `PUT /v1/sandboxes/:id/files` body the service accepts, in bytes.
   *
   * The file route streams `application/octet-stream` straight into the sandbox, so
   * Fastify's global `bodyLimit` (which only bounds buffered JSON/text parsers) never
   * constrains it; this value is enforced in the route handler while streaming. The
   * default (256 MiB) fits the workspace-seeding compressed-tarball budget from the
   * auto-seeding plan with headroom for one file, while staying far below the default
   * 10 GiB sandbox disk quota so a single upload cannot fill a workspace by itself.
   */
  PI_POD_SANDBOX_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(256 * 1024 * 1024),
  /** Per-sandbox ceilings a caller may select up to; operators tighten (or widen) them per deployment. */
  PI_POD_SANDBOX_MAX_CPU: z.coerce.number().positive().default(2),
  PI_POD_SANDBOX_MAX_MEMORY_GB: z.coerce.number().positive().default(4),
  PI_POD_SANDBOX_MAX_DISK_GB: z.coerce.number().positive().default(20),
  PI_POD_SANDBOX_MAX_PIDS: z.coerce.number().int().positive().default(4096),

  /** Bridge subnet for sandbox netns veth pairs. */
  PI_POD_SANDBOX_BRIDGE_CIDR: z.string().default("10.77.0.0/16"),
  PI_POD_SANDBOX_BRIDGE_NAME: z.string().default("ppsbr0"),
  /** Host DNS resolver handed to sandboxes; always reachable under an allowlist. */
  PI_POD_SANDBOX_DNS: z.string().default("1.1.1.1,8.8.8.8"),
  /** Hostname sandboxes dial for keepalive; must survive the egress allowlist. */
  PI_POD_SANDBOX_API_HOST: z.string().optional(),

  /** Archive object store. `local` keeps archives on the state volume (dev, air-gapped).
   * `proxy` streams archives through the server's authenticated, path-scoped ingest
   * so the boat never holds object-store credentials. */
  PI_POD_SANDBOX_ARCHIVE_DRIVER: z.enum(["s3", "local", "none", "proxy"]).default("local"),
  PI_POD_SANDBOX_ARCHIVE_PROXY_URL: z.string().optional(),
  PI_POD_SANDBOX_ARCHIVE_PROXY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(120_000),
  PI_POD_SANDBOX_S3_ENDPOINT: z.string().optional(),
  PI_POD_SANDBOX_S3_REGION: z.string().default("us-east-1"),
  PI_POD_SANDBOX_S3_BUCKET: z.string().optional(),
  PI_POD_SANDBOX_S3_ACCESS_KEY: z.string().optional(),
  PI_POD_SANDBOX_S3_SECRET_KEY: z.string().optional(),
  PI_POD_SANDBOX_S3_PREFIX: z.string().default("sandboxes"),

  /** Minutes between disaster-recovery snapshots of SQLite + manifest (§5.2); 0 disables. */
  PI_POD_SANDBOX_DR_INTERVAL_MINUTES: z.coerce.number().nonnegative().default(60),

  /** Registry mirror/credentials for image pulls. */
  PI_POD_SANDBOX_REGISTRY_USERNAME: z.string().optional(),
  PI_POD_SANDBOX_REGISTRY_PASSWORD: z.string().optional(),

  /**
   * Optional scrape token for GET /metrics. Empty/unset leaves the endpoint open like
   * /v1/healthz, which is the private-network default (compose binds loopback).
   * When set, scrapers must send `Authorization: Bearer`. Never the master API token.
   */
  PI_POD_SANDBOX_METRICS_TOKEN: z.preprocess(
    (v) => (typeof v === "string" && v.length === 0 ? undefined : v),
    z.string().min(16, "PI_POD_SANDBOX_METRICS_TOKEN must be at least 16 chars").optional(),
  ),

  LOG_LEVEL: z.string().default("info"),
});

export interface Config {
  token: string;
  port: number;
  host: string;
  stateDir: string;
  hostId: string;
  runtime: string;
  hostBackend: "static" | "boat";
  profile: "shared" | "small-v1";
  serviceObservations: {mode:"off"|"shadow-v1";keyPath:string|null;keyId:string|null};
  warmAfterMinutes: number;
  reaperIntervalMs: number;
  cpuVetoMs: number;
  reserveMemoryBytes: number;
  reserveCpu: number;
  reserveDiskBytes: number;
  pressureThreshold: number;
  fleet: { memoryBytes: number | null; cpu: number | null };
  admission: {
    memoryMode: "ceiling" | "floor";
    diskMode: "committed" | "sparse";
    storageQuotaBytes: number | null;
    sparseMinDiskBytes: number;
    /** Explicit budget; `null` derives from host total, reserve and fleet cap. */
    memoryBudgetBytes: number | null;
    maxConcurrentArchives: number;
    maxConcurrentTransitions: number;
    scratchBudgetBytes: number;
    clampOversizedShapes: boolean;
  };
  operations: { retentionMs: number };
  usage: {
    maxEventRows: number;
    maxEventAgeMs: number;
    maxSnapshotRows: number;
    evidenceSigning: boolean;
  };
  tenancy: {
    cpuFallbackCores: number | null;
    gateDegradedAdmission: boolean;
    requireOwner: boolean;
    /** Kernel aggregate caps enforced on every tenant parent; `null` leaves it uncapped. */
    tenantMemoryMaxBytes: number | null;
    tenantCpuMaxCores: number | null;
  };
  defaults: { diskGB: number };
  limits: { maxUploadBytes: number };
  maximums: { cpu: number; memoryGB: number; diskGB: number };
  maxPids: number;
  bridge: { name: string; cidr: string };
  dns: string[];
  apiHost?: string;
  archive:
    | { driver: "none" }
    | { driver: "local"; dir: string }
    | { driver: "proxy"; url: string; token: string; hostId: string; timeoutMs: number; stateDir: string }
    | {
        driver: "s3";
        endpoint: string;
        region: string;
        bucket: string;
        accessKey: string;
        secretKey: string;
        prefix: string;
      };
  drIntervalMinutes: number;
  registryAuth?: { username: string; password: string };
  /** Present only when scrapers must authenticate. Unset = private scrape, no auth. */
  metricsToken?: string;
  logLevel: string;
  paths: {
    db: string;
    layers: string;
    sandboxes: string;
    spool: string;
    images: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  if(e.PI_POD_SANDBOX_SERVICE_OBSERVATIONS==="shadow-v1"){
    const keyPath=e.PI_POD_SANDBOX_OBSERVATION_KEY_PATH;
    if(e.PI_POD_SANDBOX_PROFILE!=="small-v1" || !keyPath || !path.isAbsolute(keyPath) ||
      path.resolve(keyPath).startsWith(path.resolve(e.PI_POD_SANDBOX_STATE_DIR)+path.sep) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(e.PI_POD_SANDBOX_OBSERVATION_KEY_ID??""))
      throw new Error("shadow observations require small-v1 and an external pinned signing identity");
  }
  if(e.PI_POD_SANDBOX_PROFILE==="small-v1"){
    const quota=8_000_000_000;
    const disk=quota/(1024**3);
    const exact:Record<string,number|string>={
      PI_POD_SANDBOX_HOST_BACKEND:"boat",PI_POD_SANDBOX_MEMORY_ADMISSION:"ceiling",
      PI_POD_SANDBOX_DISK_ADMISSION:"sparse",PI_POD_SANDBOX_FLEET_MEMORY_GB:2,
      PI_POD_SANDBOX_TENANT_MEMORY_GB:2,PI_POD_SANDBOX_MAX_MEMORY_GB:2,
      PI_POD_SANDBOX_FLEET_CPU:1.5,PI_POD_SANDBOX_TENANT_CPU:1.5,
      PI_POD_SANDBOX_MAX_CPU:1.5,PI_POD_SANDBOX_RESERVE_MEMORY_GB:1,
      PI_POD_SANDBOX_RESERVE_CPU:0.5,PI_POD_SANDBOX_STORAGE_QUOTA_GB:disk,
      PI_POD_SANDBOX_MAX_DISK_GB:disk,PI_POD_SANDBOX_DEFAULT_DISK_GB:disk,
      PI_POD_SANDBOX_RESERVE_DISK_GB:5,PI_POD_SANDBOX_MAX_CONCURRENT_TRANSITIONS:1,
      PI_POD_SANDBOX_MAX_CONCURRENT_ARCHIVES:1,PI_POD_SANDBOX_WARM_AFTER_MINUTES:0,
      PI_POD_SANDBOX_DR_INTERVAL_MINUTES:0,PI_POD_SANDBOX_REQUIRE_OWNER:"1",
      PI_POD_SANDBOX_CLAMP_OVERSIZED_SHAPES:"0",
    };
    for(const [name,value] of Object.entries(exact)){
      if(env[name]===undefined || (e as Record<string,unknown>)[name]!==value)
        throw new Error(`small-v1 requires explicit ${name}=${value}`);
    }
    if(Math.round(e.PI_POD_SANDBOX_MAX_DISK_GB*1024**3)!==quota ||
      Math.floor(e.PI_POD_SANDBOX_MAX_DISK_GB*1024**3)!==quota ||
      unknownSandboxEnv(env).length)throw new Error("small-v1 disk bytes or environment unsupported");
  }
  const stateDir = path.resolve(e.PI_POD_SANDBOX_STATE_DIR);
  if (e.PI_POD_SANDBOX_DISK_ADMISSION === "sparse" && e.PI_POD_SANDBOX_STORAGE_QUOTA_GB === undefined) {
    throw new Error("sparse disk admission requires PI_POD_SANDBOX_STORAGE_QUOTA_GB");
  }
  if (e.PI_POD_SANDBOX_HOST_BACKEND === "boat") {
    // Boat capability implies a pinned per-user host: a hostname default here would boot
    // "healthy" with capabilities.boat=true while the server rejects every capacity report
    // as identity-mismatch, leaving the boat unplaceable yet apparently fine. Infra boot.py
    // enforces the same rule outside this repo; fail closed here too so a missing
    // identity.env can never look placeable. Static mode keeps the hostname default.
    const rawId = env.PI_POD_SANDBOX_HOST_ID;
    if (typeof rawId !== "string" || !/^boat-[A-Za-z0-9._-]+$/.test(rawId)) {
      throw new Error(
        "invalid configuration: PI_POD_SANDBOX_HOST_BACKEND=boat requires PI_POD_SANDBOX_HOST_ID explicitly set to boat-<userId> (object-key-safe, e.g. boat-abc123); the hostname default is static-mode only",
      );
    }
  }

  let archive: Config["archive"];
  if (e.PI_POD_SANDBOX_ARCHIVE_DRIVER === "s3") {
    const missing = (["PI_POD_SANDBOX_S3_BUCKET", "PI_POD_SANDBOX_S3_ACCESS_KEY", "PI_POD_SANDBOX_S3_SECRET_KEY"] as const).filter(
      (k) => !e[k],
    );
    if (missing.length > 0) {
      throw new Error(`archive driver "s3" requires ${missing.join(", ")}`);
    }
    archive = {
      driver: "s3",
      endpoint: e.PI_POD_SANDBOX_S3_ENDPOINT ?? `https://${e.PI_POD_SANDBOX_S3_REGION}.digitaloceanspaces.com`,
      region: e.PI_POD_SANDBOX_S3_REGION,
      bucket: e.PI_POD_SANDBOX_S3_BUCKET!,
      accessKey: e.PI_POD_SANDBOX_S3_ACCESS_KEY!,
      secretKey: e.PI_POD_SANDBOX_S3_SECRET_KEY!,
      prefix: e.PI_POD_SANDBOX_S3_PREFIX,
    };
  } else if (e.PI_POD_SANDBOX_ARCHIVE_DRIVER === "proxy") {
    if (!e.PI_POD_SANDBOX_ARCHIVE_PROXY_URL) {
      throw new Error('archive driver "proxy" requires PI_POD_SANDBOX_ARCHIVE_PROXY_URL');
    }
    // Bare-origin only: the durable pin binds scheme+host+port exactly, so a
    // path/query/fragment/userinfo here would never match a canonical pin and
    // would only smuggle routing. `canonicalizeProxyOrigin` enforces https
    // (http loopback-test only) plus those rejects in one place.
    let canonical: string;
    try {
      canonical = canonicalizeProxyOrigin(e.PI_POD_SANDBOX_ARCHIVE_PROXY_URL);
    } catch (error) {
      if (error instanceof ProxyOriginPinError) {
        throw new Error(
          `invalid configuration: PI_POD_SANDBOX_ARCHIVE_PROXY_URL must be a bare https origin (http loopback-test only), no userinfo/path/query/fragment (${error.code})`,
        );
      }
      throw error;
    }
    archive = {
      driver: "proxy",
      url: canonical,
      token: e.PI_POD_SANDBOX_TOKEN,
      hostId: e.PI_POD_SANDBOX_HOST_ID,
      timeoutMs: e.PI_POD_SANDBOX_ARCHIVE_PROXY_TIMEOUT_MS,
      stateDir,
    };
  } else if (e.PI_POD_SANDBOX_ARCHIVE_DRIVER === "local") {
    archive = { driver: "local", dir: path.join(stateDir, "archives") };
  } else {
    archive = { driver: "none" };
  }

  return {
    token: e.PI_POD_SANDBOX_TOKEN,
    port: e.PI_POD_SANDBOX_PORT,
    host: e.PI_POD_SANDBOX_HOST,
    stateDir,
    hostId: e.PI_POD_SANDBOX_HOST_ID,
    runtime: e.PI_POD_SANDBOX_RUNTIME,
    hostBackend: e.PI_POD_SANDBOX_HOST_BACKEND,
    profile: e.PI_POD_SANDBOX_PROFILE,
    serviceObservations:{mode:e.PI_POD_SANDBOX_SERVICE_OBSERVATIONS,
      keyPath:e.PI_POD_SANDBOX_OBSERVATION_KEY_PATH??null,
      keyId:e.PI_POD_SANDBOX_OBSERVATION_KEY_ID??null},
    warmAfterMinutes: e.PI_POD_SANDBOX_WARM_AFTER_MINUTES,
    reaperIntervalMs: e.PI_POD_SANDBOX_REAPER_INTERVAL_MS,
    cpuVetoMs: e.PI_POD_SANDBOX_CPU_VETO_MS,
    reserveMemoryBytes: Math.round(e.PI_POD_SANDBOX_RESERVE_MEMORY_GB * 1024 ** 3),
    reserveCpu: e.PI_POD_SANDBOX_RESERVE_CPU,
    reserveDiskBytes: Math.round(e.PI_POD_SANDBOX_RESERVE_DISK_GB * 1024 ** 3),
    pressureThreshold: e.PI_POD_SANDBOX_PRESSURE_THRESHOLD,
    fleet: {
      memoryBytes: e.PI_POD_SANDBOX_FLEET_MEMORY_GB > 0 ? Math.round(e.PI_POD_SANDBOX_FLEET_MEMORY_GB * 1024 ** 3) : null,
      cpu: e.PI_POD_SANDBOX_FLEET_CPU > 0 ? e.PI_POD_SANDBOX_FLEET_CPU : null,
    },
    admission: {
      memoryMode: e.PI_POD_SANDBOX_MEMORY_ADMISSION,
      diskMode: e.PI_POD_SANDBOX_DISK_ADMISSION,
      storageQuotaBytes: e.PI_POD_SANDBOX_STORAGE_QUOTA_GB === undefined ? null : Math.round(e.PI_POD_SANDBOX_STORAGE_QUOTA_GB * 1024 ** 3),
      sparseMinDiskBytes: Math.round(e.PI_POD_SANDBOX_SPARSE_MIN_DISK_GB * 1024 ** 3),
      memoryBudgetBytes:
        e.PI_POD_SANDBOX_MEMORY_BUDGET_GB === undefined
          ? null
          : Math.round(e.PI_POD_SANDBOX_MEMORY_BUDGET_GB * 1024 ** 3),
      maxConcurrentArchives: e.PI_POD_SANDBOX_MAX_CONCURRENT_ARCHIVES,
      maxConcurrentTransitions: e.PI_POD_SANDBOX_MAX_CONCURRENT_TRANSITIONS,
      scratchBudgetBytes:
        e.PI_POD_SANDBOX_SCRATCH_BUDGET_GB === undefined
          ? Math.round(e.PI_POD_SANDBOX_RESERVE_DISK_GB * 1024 ** 3)
          : Math.round(e.PI_POD_SANDBOX_SCRATCH_BUDGET_GB * 1024 ** 3),
      clampOversizedShapes:
        e.PI_POD_SANDBOX_CLAMP_OVERSIZED_SHAPES === "1" || e.PI_POD_SANDBOX_CLAMP_OVERSIZED_SHAPES === "true",
    },
    operations: { retentionMs: Math.round(e.PI_POD_SANDBOX_OPERATION_RETENTION_HOURS * 3_600_000) },
    usage: {
      maxEventRows: e.PI_POD_SANDBOX_USAGE_EVENT_MAX_ROWS,
      maxEventAgeMs: Math.round(e.PI_POD_SANDBOX_USAGE_EVENT_MAX_AGE_HOURS * 3_600_000),
      maxSnapshotRows: e.PI_POD_SANDBOX_USAGE_MAX_ROWS,
      evidenceSigning: e.PI_POD_SANDBOX_EVIDENCE_SIGNING === "builtin",
    },
    tenancy: {
      cpuFallbackCores: e.PI_POD_SANDBOX_TENANT_CPU_FALLBACK_CORES ?? null,
      gateDegradedAdmission:
        e.PI_POD_SANDBOX_GRANT_GATE_ADMISSION === "1" || e.PI_POD_SANDBOX_GRANT_GATE_ADMISSION === "true",
      requireOwner: e.PI_POD_SANDBOX_REQUIRE_OWNER === "1" || e.PI_POD_SANDBOX_REQUIRE_OWNER === "true",
      tenantMemoryMaxBytes: resolveTenantMemoryMaxBytes(e.PI_POD_SANDBOX_HOST_BACKEND, env),
      tenantCpuMaxCores: resolveTenantCpuMaxCores(
        e.PI_POD_SANDBOX_HOST_BACKEND,
        e.PI_POD_SANDBOX_TENANT_CPU,
        e.PI_POD_SANDBOX_RESERVE_CPU,
      ),
    },
    defaults: { diskGB: e.PI_POD_SANDBOX_DEFAULT_DISK_GB },
    limits: { maxUploadBytes: e.PI_POD_SANDBOX_MAX_UPLOAD_BYTES },
    maximums: {
      cpu: e.PI_POD_SANDBOX_MAX_CPU,
      memoryGB: e.PI_POD_SANDBOX_MAX_MEMORY_GB,
      diskGB: e.PI_POD_SANDBOX_MAX_DISK_GB,
    },
    maxPids: e.PI_POD_SANDBOX_MAX_PIDS,
    bridge: { name: e.PI_POD_SANDBOX_BRIDGE_NAME, cidr: env.PI_POD_SANDBOX_BRIDGE_CIDR === undefined && e.PI_POD_SANDBOX_HOST_BACKEND === "boat" ? "10.78.0.0/16" : e.PI_POD_SANDBOX_BRIDGE_CIDR },
    dns: e.PI_POD_SANDBOX_DNS.split(",").map((s) => s.trim()).filter(Boolean),
    apiHost: e.PI_POD_SANDBOX_API_HOST,
    archive,
    drIntervalMinutes: e.PI_POD_SANDBOX_DR_INTERVAL_MINUTES,
    registryAuth:
      e.PI_POD_SANDBOX_REGISTRY_USERNAME && e.PI_POD_SANDBOX_REGISTRY_PASSWORD
        ? { username: e.PI_POD_SANDBOX_REGISTRY_USERNAME, password: e.PI_POD_SANDBOX_REGISTRY_PASSWORD }
        : undefined,
    metricsToken: e.PI_POD_SANDBOX_METRICS_TOKEN,
    logLevel: e.LOG_LEVEL,
    paths: {
      db: path.join(stateDir, "db"),
      layers: path.join(stateDir, "layers"),
      sandboxes: path.join(stateDir, "sandboxes"),
      spool: path.join(stateDir, "spool"),
      images: path.join(stateDir, "images"),
    },
  };
}

export function hostCapacity(): { cpus: number; memoryBytes: number } {
  return { cpus: os.cpus().length, memoryBytes: os.totalmem() };
}

/**
 * Conservative boat default: an 8 GiB `default` boat loses ~2.5 GiB to the vendor desktop
 * image before any pod runs, so the tenant aggregate is capped at 5.5 GiB and the host
 * keeps its headroom plus swap. Larger boats override this explicitly with a measured
 * value (see docs/native-boat-runtime.md); the default stays safe-but-small there.
 */
export const BOAT_DEFAULT_TENANT_MEMORY_GB = 5.5;
/** Floor so a derived tenant CPU cap never squeezes a tenant below a runnable share. */
export const MIN_TENANT_CPU_CORES = 0.5;

/**
 * Resolve the kernel tenant aggregate memory cap. Boat mode fails closed on an explicit 0:
 * a per-user host with no tenant kill boundary is the configuration that OOM-killed
 * vendor services, so it must be a startup error, never a silent fallback to unlimited.
 */
export function resolveTenantMemoryMaxBytes(
  hostBackend: "static" | "boat",
  env: NodeJS.ProcessEnv,
): number | null {
  if (env.PI_POD_SANDBOX_TENANT_MEMORY_GB === undefined) {
    return hostBackend === "boat" ? Math.round(BOAT_DEFAULT_TENANT_MEMORY_GB * 1024 ** 3) : null;
  }
  const gib = Number(env.PI_POD_SANDBOX_TENANT_MEMORY_GB);
  if (!Number.isFinite(gib) || gib < 0) {
    throw new Error("invalid configuration: PI_POD_SANDBOX_TENANT_MEMORY_GB must be a non-negative number");
  }
  if (gib === 0) {
    if (hostBackend === "boat") {
      throw new Error(
        "invalid configuration: PI_POD_SANDBOX_HOST_BACKEND=boat requires PI_POD_SANDBOX_TENANT_MEMORY_GB > 0 " +
          `(default ${BOAT_DEFAULT_TENANT_MEMORY_GB}); an uncapped tenant aggregate OOM-kills vendor services`,
      );
    }
    return null;
  }
  return Math.round(gib * 1024 ** 3);
}

/** Resolve the tenant aggregate CPU cap; `null` leaves the parent to weights/grants. */
export function resolveTenantCpuMaxCores(
  hostBackend: "static" | "boat",
  explicit: number | undefined,
  reserveCpu: number,
): number | null {
  if (explicit !== undefined) {
    // Explicit 0 removes the cap (a loud operator override, not a silent fallback).
    return explicit > 0 ? explicit : null;
  }
  if (hostBackend !== "boat") return null;
  return Math.max(MIN_TENANT_CPU_CORES, os.cpus().length - reserveCpu);
}

/**
 * `PI_POD_SANDBOX_*` names the service does not parse. Runtime env examples have carried
 * knobs that were silently ignored; naming them at startup is how an operator finds out a
 * setting is a no-op instead of trusting it (plan §7.4).
 */
export function unknownSandboxEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const known = new Set(Object.keys(Schema.shape));
  // Consumed by other components of the same deployment, not by this service's schema.
  const tolerated = new Set(["PI_POD_SANDBOX_INIT", "PI_POD_SANDBOX_NETWORK_TESTS", "PI_POD_SANDBOX_URL"]);
  return Object.keys(env)
    .filter((k) => k.startsWith("PI_POD_SANDBOX_") && !known.has(k) && !tolerated.has(k))
    .sort();
}
