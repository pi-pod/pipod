// Wire types mirrored from sandbox/src/wire.ts.

export type SandboxState = "starting" | "started" | "stopped" | "archived" | "error" | "gone";

export type EgressPolicy =
  | { mode: "open" }
  | {
      mode: "allowlist";
      hosts: string[];
      /** What each allowed hostname resolved to, under CIDR enforcement: the pod's /etc/hosts. */
      names?: Record<string, string[]>;
    };

export interface ResourceSpec {
  cpu?: number;
  memoryGB?: number;
  diskGB?: number;
}

/** A fully resolved shape; every field present. */
export interface ResourceShape {
  cpu: number;
  memoryGB: number;
  diskGB: number;
}

/**
 * Authoritative tenant identity, provisioned by the trusted control plane on create/import
 * and immutable afterwards. Labels are mutable and are never consulted for ownership,
 * quota, cgroup placement, or cost attribution.
 *
 * Mirrored from sandbox/src/wire.ts (cost-ledger contract v1). Nothing here is
 * invented server-side: every shape exists because the native host serves it.
 */
export interface OwnerIdentity {
  /** Opaque platform user key; `^[A-Za-z0-9._-]{1,64}$`. */
  userKey: string;
}

/** Owner keys double as cgroup directory components, so they are matched, never trusted. */
export const OWNER_USER_KEY = /^[A-Za-z0-9._-]{1,64}$/;
/** Idempotency keys name journal rows and log lines; same posture. */
export const OPERATION_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
/** Header carrying the create operation key; `operationKey` in the body is equivalent. */
export const IDEMPOTENCY_HEADER = "idempotency-key";

export interface CreateSandboxRequest {
  image: string;
  workdir: string;
  /** Caller-selected hard ceiling; the service owns the fixed CPU/RAM floor. */
  resources?: ResourceSpec;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  archiveAfterMinutes?: number;
  idleTimeoutMinutes?: number;
  egress?: EgressPolicy;
  /** Immutable tenant owner. Omitted keeps the legacy unowned flat cgroup layout. */
  owner?: OwnerIdentity;
  /**
   * Stable control-plane operation key. A retry with the same key and the same
   * request returns the original outcome; the same key with a different request is a
   * conflict. Also accepted as the `Idempotency-Key` header.
   */
  operationKey?: string;
}

export interface SandboxInfoWire {
  id: string;
  labels: Record<string, string>;
  state: SandboxState;
  createdAt: string;
  lastActivityAt: string;
  image: string;
  workdir: string;
  tier: "hot" | "warm" | "stopped" | "archived" | "error";
  archiveAfterMinutes: number;
  idleTimeoutMinutes: number;
  /** Fixed CPU/RAM guarantee. */
  resources: ResourceSpec;
  /** Effective hard ceiling. */
  ceiling: ResourceSpec;
  /**
   * Host-issued conditional-archive guards (native contract §1–3, additive). Optional
   * while older hosts roll forward: a response without them predates archive-if-stopped
   * and the sweep must SKIP (never force-archive) until the host upgrades.
   */
  /** Immutable owner; null for legacy/unowned sandboxes. */
  owner?: { userKey: string } | null;
  /** Transition revision, +1 on every tier write; the archive-if-stopped guard domain. */
  revision?: number;
  /** +1 on every launch; usage counters are only comparable within one generation. */
  runtimeGeneration?: number;
  /** Authoritative stop instant, stable across retention updates and retries. */
  stoppedAt?: string | null;
  /**
   * The object this host's row points at (native rev5 §11, additive). Optional while
   * older hosts roll forward; absent means "manifest not supported" — fail closed.
   */
  archive?: ArchiveReference | null;
  /** Active quiescence hold, if any (native rev5 §11, additive). */
  hold?: SandboxHold | null;
  /**
   * Effective egress policy (native rev7, additive). Optional while older hosts roll
   * forward; the manifest config carries the authoritative copy for imports.
   */
  egress?: EgressPolicy;
  /** In-flight transition, if any (native rev7, additive). */
  transition?: { kind: string } | null;
}

/** Archive object identity: what pack() verified, not "S3 latest by id" (rev5 §11.1). */
export interface ArchiveReference {
  key: string;
  sha256: string;
  size: number;
}

/** Quiescence hold: while held, no wake/re-archive/resize/owner-init/delete (rev5 §11.2). */
export interface SandboxHold {
  holder: string;
  reason?: string;
  since: string;
}

/** Source-authoritative archive reference; with verify=1 the object is HEAD-checked (rev5 §11.1). */
export interface ArchiveReferenceWire {
  id: string;
  hostId: string;
  tier: SandboxInfoWire["tier"];
  state: SandboxState;
  revision: number;
  stoppedAt: string | null;
  archive: ArchiveReference | null;
  hold: SandboxHold | null;
  /** Present with `?verify=1`: what the object store says about the referenced key. */
  object?: { present: boolean; size: number | null; sha256: string | null; matches: boolean };
  /**
   * Everything the host persists that an import must carry to reproduce the sandbox
   * exactly (rev7 §11.1). Copy verbatim into the import; `env` is never exported.
   */
  config: SandboxConfigManifest;
}

/** Persisted configuration verbatim for imports (rev7 §11.1). Nothing here is a secret. */
export interface SandboxConfigManifest {
  image: string;
  /** Manifest digest the source resolved `image` to; pass as `imageDigest` for equality. */
  imageDigest: string;
  workdir: string;
  /** Effective ceiling including disk quota. */
  resources: ResourceSpec;
  egress: EgressPolicy;
  archiveAfterMinutes: number;
  idleTimeoutMinutes: number;
  labels: Record<string, string>;
  owner: { userKey: string } | null;
}

export interface HoldRequest {
  holder: string;
  reason?: string;
  /** Fence exactly the state the caller read: `409 stale_revision` if the row moved. */
  expectedRevision?: number;
}

export interface ReleaseHoldRequest {
  holder?: string;
  /** Release regardless of holder (operator override). */
  force?: boolean;
}

/* ------------------------------------------------- owner initialization */

/**
 * One-time trusted owner initialization for a legacy unowned sandbox (native §7.2
 * rollout, rev 3). The control plane maps the authoritative pod owner and calls
 * this before the next start; it is a compare-and-set from `null` to `userKey`,
 * never an update of an existing owner. Calling it is capacity-lead integration;
 * the ledger only mirrors the types.
 */
export interface OwnerInitRequest {
  owner: OwnerIdentity;
}

export interface OwnerInitResponse {
  /** False when the sandbox already carried exactly this owner (idempotent replay). */
  changed: boolean;
  sandbox: SandboxInfoWire;
}

/* ------------------------------------------------------- capacity contract */

export const CAPACITY_CONTRACT_VERSION = 1 as const;

export type MemoryAdmissionMode = "ceiling" | "floor";

export interface CapacityCapabilities {
  /** Largest shape this host accepts; larger requests are `unsupported_shape`, never clamped. */
  maxShape: ResourceShape;
  /** The shape an omitted request resolves to. */
  standardShape: ResourceShape;
  resize: {
    memoryGrowOnline: boolean;
    memoryShrink: boolean;
    diskGrowOnline: boolean;
    diskShrink: boolean;
  };
  memoryAdmission: MemoryAdmissionMode;
  /** Additive native Boat profile attestations; absent on older static hosts. */
  boat?: boolean;
  diskAdmission?: "sparse";
  storageQuotaBytes?: number;
  /** Fresh-create charge the host uses under sparse admission. Absent on older hosts. */
  sparseMinDiskBytes?: number;
  ownerIdentity: boolean;
  tenantCgroups: boolean;
  cpuGrants: boolean;
  idempotentCreate: boolean;
  archiveIfStopped: boolean;
  usageFeed: boolean;
}

export interface CapacityMemory {
  /** What the host may promise in total, including in-flight reservations. */
  budgetBytes: number;
  /** Steady-state commitments of live (hot/warm) sandboxes. */
  committedBytes: number;
  /** Reservations held by transitions that have not reached steady state. */
  inFlightBytes: number;
  /** Reservations whose runtime state could not be resolved; charged until resolved. */
  quarantinedBytes: number;
  /** committed − budget when pre-upgrade workloads exceed the budget; blocks admission. */
  debtBytes: number;
  /** max(0, budget − committed − inFlight − quarantined); what a new request is compared to. */
  availableBytes: number;
  hostTotalBytes: number;
  hostAvailableBytes: number;
}

export interface CapacityCpu {
  hostCpus: number;
  /** Floor-guarantee budget after the host reserve; shares, not dedicated cores. */
  budgetCores: number;
  committedFloorCores: number;
  /** Sum of live sandbox ceilings; may legitimately exceed hostCpus. */
  ceilingCoresSum: number;
  sharing: "weighted-shares";
  loadAvg1: number;
  /** PSI avg10 percent; -1 when unavailable. */
  pressureAvg10: number;
}

export interface CapacityDisk {
  capacityBytes: number;
  /** Full quota of every local (non-archived) workspace, including stopped/error. */
  committedBytes: number;
  inFlightBytes: number;
  /** Archived rows that still have a local image, and unresolved reservations. */
  quarantinedBytes: number;
  /** Blocks actually allocated by sparse images. */
  allocatedBytes: number;
  scratchBudgetBytes: number;
  scratchUsedBytes: number;
  availableBytes: number;
}

export interface CapacityTransitions {
  inFlight: number;
  maxInFlight: number;
  archivesInFlight: number;
  maxConcurrentArchives: number;
  pendingOperations: number;
  quarantinedOperations: number;
}

export interface CapacityReportV1 {
  contractVersion: typeof CAPACITY_CONTRACT_VERSION;
  hostId: string;
  /** Random per service process; a new boot resets in-flight state and usage sequences. */
  bootId: string;
  serviceVersion: string;
  /** Monotonic per boot; a consumer must treat a smaller value as stale. */
  generation: number;
  sampledAt: string;
  capabilities: CapacityCapabilities;
  memory: CapacityMemory;
  cpu: CapacityCpu;
  disk: CapacityDisk;
  transitions: CapacityTransitions;
  sandboxes: { hot: number; warm: number; stopped: number; archived: number; error: number; booting: number };
  fairness: {
    mode: "local-weights" | "grants" | "degraded";
    managed: boolean;
    /**
     * Whether the host gates new grant-requiring admissions while managed
     * (`PI_POD_SANDBOX_GRANT_GATE_ADMISSION`, default on). Omitted by hosts
     * predating the gate report — absence is unknown, never off.
     */
    gateAdmissions?: boolean;
    activeGrants: number;
    expiredGrants: number;
    degradedTenants: number;
  };
  /**
   * Owner migration debt (§7.2 rollout). Unowned rows sit flat beside tenant parents, so
   * each of them competes with a whole tenant for CPU; live ones are grandfathered until
   * they stop, stopped/archived ones can be initialized with `PUT /v1/sandboxes/:id/owner`.
   */
  tenancy: {
    ownedSandboxes: number;
    /** Unowned hot/warm rows: grandfathered until their next stop; never moved live. */
    unownedLive: number;
    /** Unowned stopped/archived rows with no unresolved reservation: eligible for owner initialization. */
    unownedInitializable: number;
    /**
     * Unowned rows in `error` or holding an unresolved reservation: their runtime may still
     * be live on the legacy flat layout, so they are neither initializable nor counted as
     * migrated. Debt that only a supported reconciliation (delete, successful stop, restart
     * recovery) can clear. Omitted by hosts predating this field.
     */
    unownedUncertain?: number;
    /** Whether launches of unowned sandboxes are refused (`PI_POD_SANDBOX_REQUIRE_OWNER`). */
    requireOwner: boolean;
  };
}

/* ------------------------------------------------------- typed safe errors */

export type AdmissionReason =
  | "memory_capacity"
  | "cpu_capacity"
  | "disk_capacity"
  | "transition_capacity"
  | "network_capacity"
  | "memory_debt"
  | "fairness_degraded"
  | "unsupported_shape";

export type AdmissionResourceName = "memory" | "cpu" | "disk" | "network" | "transitions" | "shape" | "fairness";

/**
 * Numbers a client may render without trusting free-form text. Every field is validated on
 * the way in (finite, non-negative) so a sanitizer can keep this object while dropping the
 * message.
 */
export interface AdmissionErrorDetails {
  kind: "admission";
  reason: AdmissionReason;
  resource: AdmissionResourceName;
  unit: "bytes" | "cores" | "count" | "gb";
  required?: number;
  available?: number;
  budget?: number;
  committed?: number;
  retryable: boolean;
  /** Bounded hint; absent when the condition is not expected to clear on its own. */
  retryAfterMs?: number;
  /** For `unsupported_shape`: what was asked and what this host supports. */
  requested?: Partial<ResourceShape>;
  maximum?: ResourceShape;
}

export interface RevisionErrorDetails {
  kind: "revision";
  expected: number;
  actual: number;
}

export interface OperationErrorDetails {
  kind: "operation";
  operationKey: string;
  status: OperationStatus;
  sandboxId: string | null;
}

export type ErrorDetails = AdmissionErrorDetails | RevisionErrorDetails | OperationErrorDetails;

/* ------------------------------------------------------ create idempotency */

export type OperationStatus = "pending" | "succeeded" | "failed" | "cancelled";

/** rev 4: how an operation's resources were resolved after interruption. */
export type OperationResolution = "preallocation" | "cleaned" | "quarantined";

export interface OperationStatusWire {
  key: string;
  kind: "create";
  status: OperationStatus;
  sandboxId: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Tombstones are retained until this instant, longer than any retry window. */
  expiresAt: string;
  cancelRequested: boolean;
  resolution: OperationResolution | null;
  /**
   * True only when the status is failed/cancelled AND the resolution is preallocation or
   * cleaned. A pending, succeeded, or quarantined operation never authorises creating the
   * same pod on another host (native §6.5, rev 4).
   */
  crossHostRetrySafe: boolean;
  result?: SandboxInfoWire;
  error?: { code: string; message: string; hint?: string; details?: ErrorDetails };
}

/* -------------------------------------------------------- tenant CPU grants */

export interface CpuGrantRequest {
  /** Allocator epoch/revision; a grant at or below the current revision is rejected as stale. */
  revision: number;
  /** Cores the tenant parent may use in total; `null` removes the cap (weights only). */
  cpuCores: number | null;
  /** Host-local validity measured with a monotonic clock, never wall time. */
  ttlMs: number;
}

/** rev 4 adds `restart-expired`: persisted before a restart; elapsed time is unknown. */
export type CpuGrantState = "none" | "active" | "expired" | "restart-expired";

export interface CpuGrantWire {
  revision: number;
  cpuCores: number | null;
  /** Remaining validity; 0 once expired. */
  expiresInMs: number;
  state: CpuGrantState;
}

export interface CpuGrantResponse {
  userKey: string;
  applied: boolean;
  grant: CpuGrantWire;
}

export interface TenantStatusWire {
  userKey: string;
  sandboxIds: string[];
  /** Live sandboxes currently placed under the tenant parent cgroup. */
  liveSandboxIds: string[];
  cgroupPresent: boolean;
  grant: CpuGrantWire | null;
  /** What is applied on the parent right now: grant cores, the bounded fallback, or `null` (no cap; never grant-managed). */
  effectiveCpuCores: number | null;
  /** True when this tenant is running on the fallback while the host is grant-managed. */
  degraded: boolean;
}

/* ------------------------------------------------------------- usage feed */

export const USAGE_CONTRACT_VERSION = 1 as const;

export interface UsageCounters {
  /** Cumulative within one runtime generation. */
  cpuUsec: number;
  cpuUserUsec: number;
  cpuSystemUsec: number;
  throttledUsec: number;
  nrPeriods: number;
  nrThrottled: number;
  memoryPeakBytes: number;
  oomEvents: number;
  oomKillEvents: number;
}

export interface UsageSampleWire extends UsageCounters {
  sandboxId: string;
  ownerKey: string | null;
  runtimeGeneration: number;
  tier: SandboxInfoWire["tier"];
  state: SandboxState;
  /** True when a cgroup existed and counters were read from it this sample. */
  live: boolean;
  memoryCurrentBytes: number;
  memoryPressureAvg10: number;
  cpuPressureAvg10: number;
  pidsCurrent: number;
  /** Full local quota commitment (0 when archived without a local image). */
  diskCommittedBytes: number;
  /** Blocks the sparse image actually occupies on the host. */
  diskAllocatedBytes: number;
  archiveSizeBytes: number | null;
  lastActivityAt: string;
  stoppedAt: string | null;
  /**
   * Sampling cadence that produced this row: `full` per-poll detail, or a daily
   * archived `heartbeat` (native feat/usage-archived-heartbeat). Optional so
   * older hosts are unaffected; the server stores no per-row cadence.
   */
  cadence?: "full" | "heartbeat";
  /**
   * False when counters were not read from a cgroup for this sample (a heartbeat,
   * or a sandbox with no live runtime). `live` stays the coarse presence flag.
   * Ingest ANDs this with its own delta validity into `usage_samples_raw.cpu_valid`.
   */
  cpuValid?: boolean;
  /** Runtime pod-ready-v1 observation at sample time; null/absent means not observed. */
  serviceReady?: boolean | null;
  predicateVersion?: string | null;
  /** Runtime monotonic reading; only deltas of this field establish duration. */
  monotonicMs?: number | null;
}

/**
 * One usage sample as returned by the runtime: the sample plus the identity the
 * evidence envelope signs with it. Mirrors the runtime's wire contract.
 */
export interface UsageSampleRecordV1 extends UsageSampleWire {
  /** Originating runtime boot; a page-boot key would erase replay identity. */
  bootId: string;
  /** Per-boot observation identity; unique within one page and monotonic per boot. */
  seq: number;
  kind: "usage-sample";
  /** Observation wall time (the page's sampledAt). */
  at: string;
  /** Stable identity of the outbox incarnation that observed this sample. */
  outboxIncarnation: string;
  /** The scalar gauge reading this record reports; never labels, env or image refs. */
  counters: UsageSampleWire;
}

export interface UsageSnapshotV1 {
  contractVersion: typeof USAGE_CONTRACT_VERSION;
  hostId: string;
  bootId: string;
  /** Monotonic per boot; one per snapshot page served. */
  sequence: number;
  sampledAt: string;
  samples: UsageSampleRecordV1[];
  /** Pass as `?cursor=` to fetch the next page; `null` when this page was the last. */
  nextCursor: string | null;
  limit: number;
  outboxIncarnation?: string;
  evidence?: UsageEvidenceWire;
}

export type UsageEventKind =
  | "created"
  | "imported"
  | "started"
  | "restored"
  | "frozen"
  | "thawed"
  | "stopped"
  | "archived"
  | "deleted"
  | "resized"
  | "owner_initialized"
  | "failed"
  | "terminal";

export interface UsageEventWire {
  seq: number;
  at: string;
  kind: UsageEventKind;
  sandboxId: string;
  ownerKey: string | null;
  runtimeGeneration: number;
  /** Boot that originated this row, never the boot of the page serving it. */
  bootId?: string;
  /** Operation duration where the event closes an operation. */
  durationMs?: number;
  /** Final counters captured before teardown (`stopped`/`terminal`), so a sandbox that lived between two polls is not invisible. */
  counters?: UsageCounters & { memoryCurrentBytes: number };
  /** Small bounded scalars: sizes, bytes moved, reason codes. Never env, prompts, files, or tokens. */
  detail?: Record<string, number | string | boolean | null>;
}

/** Signed usage-feed envelope (isolated small profile; absent unless signing is on). */
export interface UsageEvidenceWire {
  schema: "pi-pod-usage-evidence-v1";
  keyId: string;
  publicKey: string;
  endpoint: "usage-snapshot" | "usage-events";
  nonce: string | null;
  request: Record<string, string | number | null>;
  hostId: string;
  outboxIncarnation: string;
  issuedAt: string;
  recordsDigest: string;
  signature: string;
}

export interface UsageEventsResponse {
  contractVersion: typeof USAGE_CONTRACT_VERSION;
  hostId: string;
  bootId: string;
  outboxIncarnation?: string;
  events: UsageEventWire[];
  /** Pass as `?after=` for the next page. */
  nextAfter: number;
  oldestRetainedSeq: number | null;
  /** Events at or below this seq were dropped unacknowledged (bounded outbox); a coverage gap. */
  droppedBeforeSeq: number | null;
  acknowledgedSeq: number;
  evidence?: UsageEvidenceWire;
}

export interface UsageAckRequest {
  upTo: number;
}

export interface UsageAckResponse {
  acknowledgedSeq: number;
  retained: number;
}

export interface StartRequest {
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface StopRequest {
  timeoutMs?: number;
}

export interface RetentionRequest {
  archiveAfterMinutes: number;
}

export interface RetentionResponse {
  changed: boolean;
}

export interface LabelsRequest {
  labels: Record<string, string>;
}

export interface ActivityResponse {
  lastActivityAt: string;
}

export interface ResourcesRequest {
  guarantee?: ResourceSpec;
  ceiling?: ResourceSpec;
}

export interface ResourcesResponse {
  guarantee: ResourceSpec;
  ceiling: ResourceSpec;
}

export interface ImageFetchRequest {
  ref: string;
  auth?: { username: string; password: string };
}

/** Native rev 4 name for the same image-pull body; kept alongside ImageFetchRequest
 *  (which existing server code uses) so the mirror matches native verbatim. */
export interface ImagePullRequest {
  ref: string;
  /** Used only by this pull; the service never persists or logs it. */
  auth?: { username: string; password: string };
}

export interface ImageInfoWire {
  ref: string;
  state?: string;
  createdAt?: string;
}

/** Mirrors sandbox/src/wire.ts: run `script` on `base` and publish the result as `ref`. */
export interface DeriveImageRequest {
  base: string;
  ref: string;
  script: string;
  resources?: ResourceSpec;
}

/** One line of a derive's newline-delimited JSON response; the last is `done` or `error`. */
export type DeriveImageEvent =
  | { log: string }
  | { heartbeat: true }
  | { done: ImageInfoWire }
  | { error: { code: string; message: string; hint?: string; outputTail?: string } };

export interface ListResponse {
  sandboxes: SandboxInfoWire[];
}

export interface HealthResponse {
  ok: true;
  version: string;
  uptimeSeconds: number;
  /** Added with fleet support; absent on hosts that predate it. */
  hostId?: string;
  sandboxes: { hot: number; warm: number; stopped: number; archived: number };
  host: {
    cpus: number;
    memoryTotalBytes: number;
    memoryAvailableBytes: number;
    /** Added by sandbox service 0.1; optional while older deployments roll forward. */
    guaranteeCapacity?: { cpu: number; memoryBytes: number };
    /** What admission control has already charged; absent on hosts that predate fleets. */
    committed?: { cpu: number; memoryBytes: number; diskBytes: number };
    diskCapacityBytes?: number;
  };
}

/**
 * Conditional archive (native contract §3, additive). Never stops a running sandbox,
 * unlike POST /archive which is force-stop-and-archive. Older hosts answer 404: callers
 * must fall back to a safe re-read path, never to a blind force archive after a stale read.
 */
export interface ArchiveIfStoppedRequest {
  expectedRevision?: number;
  expectedStoppedAt?: string;
}

export type ArchiveIfStoppedOutcome =
  | "archived"
  | "already_archived"
  | "not_stopped"
  | "revision_mismatch"
  | "transitioning"
  | "archive_busy";

export interface ArchiveIfStoppedResponse {
  archived: boolean;
  outcome: ArchiveIfStoppedOutcome;
  sandbox: SandboxInfoWire;
}

/** Adopt a sandbox archived by another host in the fleet, under the id it already has. */
export interface ImportSandboxRequest {
  id: string;
  image: string;
  workdir: string;
  resources?: ResourceSpec;
  labels?: Record<string, string>;
  archiveAfterMinutes?: number;
  idleTimeoutMinutes?: number;
  egress?: EgressPolicy;
  /** Same owner the archiving host recorded; omitted keeps the legacy unowned layout. */
  owner?: OwnerIdentity;
  /**
   * Adopt exactly this object (rev5 §11.3). Omitted keeps the legacy "newest object
   * by id" behaviour, which is not authoritative — guarded moves always send it.
   */
  archive?: { key: string; sha256: string; size?: number };
  /** When given, the target's resolved image manifest digest must equal it (`409 image_mismatch`). */
  imageDigest?: string;
}

/**
 * Atomic retire-while-held (rev7 §11.5): delete the source row and local state of a held,
 * archived sandbox without ever releasing the hold, only when the caller proves the
 * target adopted the very same object. The shared object is never deleted.
 */
export interface RetireRequest {
  holder: string;
  expectedRevision?: number;
  /** The object the target was verified to hold; must equal this row's reference. */
  adoptedArchive: { key: string; sha256: string };
}

export interface RetireResponse {
  retired: boolean;
  id: string;
  /** Left in the object store for the adopting host. */
  archive: ArchiveReference;
}

export interface AuthzResponse {
  ok: true;
  runtime: string;
  archiveStore: "s3" | "local" | "none";
}

export interface ErrorResponse {
  error: { code: string; message: string; hint?: string; details?: ErrorDetails };
}

export interface PtySessionWire {
  id: string;
  sandboxId: string;
  cols: number;
  rows: number;
  alive: boolean;
  createdAt: string;
}

export interface PtyListResponse {
  sessions: PtySessionWire[];
}

/**
 * Exec channels tag each binary frame with the stream it belongs to, because stdout and
 * stderr share one socket. A PTY carries a single stream in each direction and its frames
 * are untagged raw bytes.
 */
export const STREAM_STDOUT = 1;
export const STREAM_STDERR = 2;
export const STREAM_STDIN = 0;

export type ExecClientFrame =
  | {
      type: "start";
      argv: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    }
  | { type: "stdin-eof" };

export type ExecServerFrame =
  | { type: "started" }
  | { type: "exit"; exitCode: number }
  | { type: "error"; code: string; message: string };

export type PtyClientFrame =
  | {
      type: "open";
      argv: string[];
      cols: number;
      rows: number;
      cwd?: string;
      env?: Record<string, string>;
    }
  | { type: "attach"; sessionId: string; cols: number; rows: number }
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach" }
  | { type: "kill" };

export type PtyServerFrame =
  | { type: "ready"; sessionId: string; reattached: boolean }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; code: string; message: string };

export const ERR_NO_SESSION = "no_such_session";
export const ERR_NOT_FOUND = "not_found";
export const ERR_CONFLICT = "conflict";
export const ERR_UNAUTHORIZED = "unauthorized";
export const ERR_PAYLOAD_TOO_LARGE = "payload_too_large";
export const ERR_ADMISSION = "admission_denied";
export const ERR_TIMEOUT = "timeout";
/** 400: the requested shape exceeds what this host supports; not a capacity condition. */
export const ERR_UNSUPPORTED_SHAPE = "unsupported_shape";
/** 409: same operation key, different request fingerprint. */
export const ERR_IDEMPOTENCY_CONFLICT = "idempotency_conflict";
/** 409: a CPU grant or archive guard carried a revision that is no longer current. */
export const ERR_STALE_REVISION = "stale_revision";
/** 409: owner init on a sandbox that already carries a different owner. */
export const ERR_OWNER_CONFLICT = "owner_conflict";
/** 400: launches of unowned sandboxes are refused on this host (`PI_POD_SANDBOX_REQUIRE_OWNER`). */
export const ERR_OWNER_REQUIRED = "owner_required";
/** 409: this host cannot publish a derived image for that base (it is not in a loopback registry). */
export const ERR_DERIVE_UNAVAILABLE = "derive_unavailable";
