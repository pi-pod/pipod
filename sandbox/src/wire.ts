/**
 * The wire contract, shared verbatim by the service and by the typed client the
 * pi-pod-server adapter uses.
 *
 * Every shape here exists because `SandboxProvider`/`Sandbox` in pi-pod-server's
 * `providers/types.ts` needs it. Nothing is added "because a sandbox service usually
 * has one" — an endpoint no adapter calls is an endpoint no conformance test covers.
 */

export type SandboxState = "starting" | "started" | "stopped" | "archived" | "error" | "gone";

/**
 * Which transition currently holds the sandbox, if any. Only `start` (launch or restore) is
 * reported as `state: "starting"`; a stop, archive or delete keeps reporting the
 * tier's state so a control plane does not mistake a two-second archive for a boot and
 * suspend its polling.
 */
export type SandboxTransition = "start" | "stop" | "archive" | "delete";

export type EgressPolicy = { mode: "open" } | { mode: "allowlist"; hosts: string[] };

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
/** Hold holders name an operator/control-plane actor in audit logs. */
export const HOLD_HOLDER = /^[A-Za-z0-9._:-]{1,128}$/;

/** The archive object a sandbox row points at: source-authoritative, never "latest by id". */
export interface ArchiveReference {
  key: string;
  sha256: string;
  size: number;
}

/**
 * Quiescence hold (§11.2 of the native contract): while held, a stopped/archived sandbox can
 * neither wake, re-archive, resize nor be deleted, so a rehome can adopt its object safely.
 */
export interface SandboxHold {
  holder: string;
  reason?: string;
  since: string;
}

export interface CreateSandboxRequest {
  image: string;
  workdir: string;
  /** Caller-selected hard ceiling; the service applies its fixed CPU/RAM floor separately. */
  resources?: ResourceSpec;
  /** Never persisted by the service — memory only (§6.3). */
  env?: Record<string, string>;
  labels?: Record<string, string>;
  archiveAfterMinutes?: number;
  idleTimeoutMinutes?: number;
  /** Omitted means `{ mode: "allowlist", hosts: [] }`: open Internet is opt-in, never a default. */
  egress?: EgressPolicy;
  /** Immutable tenant owner (§7.2). Omitted keeps the legacy unowned flat cgroup layout. */
  owner?: OwnerIdentity;
  /**
   * Stable control-plane operation key (§6.5). A retry with the same key and the same
   * request returns the original outcome; the same key with a different request is a
   * conflict. Also accepted as the `Idempotency-Key` header.
   */
  operationKey?: string;
}

/**
 * Adopt a sandbox whose workspace is already in the shared object store, under the id it had
 * on the host that archived it. This is how a fleet moves an archived sandbox off a host that
 * is being removed; the resulting sandbox is ARCHIVED and restores on its next start.
 */
export interface ImportSandboxRequest {
  id: string;
  image: string;
  workdir: string;
  resources?: ResourceSpec;
  labels?: Record<string, string>;
  archiveAfterMinutes?: number;
  idleTimeoutMinutes?: number;
  /** Omitted means `{ mode: "allowlist", hosts: [] }`, as on create. */
  egress?: EgressPolicy;
  /** Same owner the archiving host recorded; preserved through rehome. */
  owner?: OwnerIdentity;
  /**
   * Adopt exactly this object (§11.3). Omitted keeps the legacy "newest object by id"
   * behaviour, which is not authoritative.
   */
  archive?: { key: string; sha256: string; size?: number };
  /** When given, the target's resolved image manifest digest must equal it (`409 image_mismatch`). */
  imageDigest?: string;
}

/**
 * Atomic retire-while-held (§11.5): delete the source row and local state of a held,
 * archived sandbox without ever releasing the hold, and only when the caller proves the
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

export interface SandboxInfoWire {
  id: string;
  labels: Record<string, string>;
  state: SandboxState;
  createdAt: string;
  lastActivityAt: string;
  image: string;
  workdir: string;
  /** Internal tier, exposed for operators and tests; the adapter maps WARM → started. */
  tier: "hot" | "warm" | "stopped" | "archived" | "error";
  archiveAfterMinutes: number;
  idleTimeoutMinutes: number;
  /** Fixed CPU/RAM guarantee used for admission and cgroup reclaim protection. */
  resources: ResourceSpec;
  /** Effective caller-selected hard ceiling. */
  ceiling: ResourceSpec;
  /** Immutable owner; `null` for legacy/unowned sandboxes. */
  owner: OwnerIdentity | null;
  /**
   * Transition revision: increments on every tier change. `archive-if-stopped` uses it as
   * an expected-revision guard so a timer worker never archives after a stale read.
   */
  revision: number;
  /** Increments on every launch; usage counters are only comparable within one generation. */
  runtimeGeneration: number;
  /** Authoritative stop timestamp; stable across retention updates and retries. */
  stoppedAt: string | null;
  /**
   * In-flight transition, or null. Optional: hosts predating this field omit it, and so do
   * persisted operation results recorded before the upgrade, which are replayed verbatim.
   */
  transition?: SandboxTransition | null;
  /** The object this host's row points at; null when there is none. */
  archive: ArchiveReference | null;
  /** Active quiescence hold, if any. */
  hold: SandboxHold | null;
  /** Effective egress policy; omitted-on-create means the closed allowlist. */
  egress: EgressPolicy;
}

/**
 * Everything the host persists that an import must carry to reproduce the sandbox exactly
 * (§11.1). `env` is never persisted and therefore never exported; the control plane
 * rehydrates it on the next start. Nothing here is a secret.
 */
export interface SandboxConfigManifest {
  image: string;
  /** Manifest digest the source resolved `image` to; pass as `imageDigest` on import for equality. */
  imageDigest: string;
  workdir: string;
  /** Pass as `ImportSandboxRequest.resources`: the effective ceiling including disk quota. */
  resources: ResourceSpec;
  egress: EgressPolicy;
  archiveAfterMinutes: number;
  idleTimeoutMinutes: number;
  labels: Record<string, string>;
  owner: OwnerIdentity | null;
}

/* ------------------------------------------------- archive manifest handshake */

export interface ArchiveReferenceWire {
  id: string;
  hostId: string;
  tier: SandboxInfoWire["tier"];
  state: SandboxState;
  revision: number;
  stoppedAt: string | null;
  archive: ArchiveReference | null;
  hold: SandboxHold | null;
  /** Copy these fields verbatim into the import so no policy is silently reset. */
  config: SandboxConfigManifest;
  /** Present with `?verify=1`: what the object store says about the referenced key. */
  object?: { present: boolean; size: number | null; sha256: string | null; matches: boolean };
}

export interface HoldRequest {
  holder: string;
  reason?: string;
  /** Fence exactly the state the caller read: `409 stale_revision` if the row moved since. */
  expectedRevision?: number;
}

export interface ReleaseHoldRequest {
  holder?: string;
  /** Release regardless of holder (operator override). */
  force?: boolean;
}

/* ------------------------------------------------- owner initialization */

/**
 * One-time trusted owner initialization for a legacy unowned sandbox (§7.2 rollout). The
 * control plane maps the authoritative pod owner and calls this before the next start;
 * it is a compare-and-set from `null` to `userKey`, never an update of an existing owner.
 */
export interface OwnerInitRequest {
  owner: OwnerIdentity;
}

export interface OwnerInitResponse {
  /** False when the sandbox already carried exactly this owner (idempotent replay). */
  changed: boolean;
  sandbox: SandboxInfoWire;
}

/* ----------------------------------------------------------- archive safety */

export interface ArchiveIfStoppedRequest {
  /** Archive only if the sandbox's transition revision still equals this value. */
  expectedRevision?: number;
  /** Archive only if the authoritative stop timestamp still equals this value. */
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

export interface StartRequest {
  timeoutMs?: number;
  /** core's `rehydrateEnv()` delivered over the wire (§3). */
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
  /** Rejected when present; retained in the wire type for an actionable rolling-upgrade error. */
  guarantee?: ResourceSpec;
  ceiling?: ResourceSpec;
}

export interface ResourcesResponse {
  guarantee: ResourceSpec;
  ceiling: ResourceSpec;
}

/* ------------------------------------------------------- capacity contract */

export const CAPACITY_CONTRACT_VERSION = 1 as const;

export type MemoryAdmissionMode = "ceiling" | "floor";

export interface CapacityCapabilities {
  /** Opt-in per-user Box host; absent on static hosts. */
  box?: boolean;
  diskAdmission?: "sparse";
  storageQuotaBytes?: number;
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
  ownerIdentity: boolean;
  tenantCgroups: boolean;
  /**
   * Kernel aggregate caps enforced on every tenant parent cgroup. `null` is uncapped;
   * omitted by hosts predating this field. A box host must report a finite memory cap.
   */
  tenantLimits?: { memoryMaxBytes: number | null; cpuMaxCores: number | null };
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
  /** Full quotas in committed mode; max(allocated blocks, minimum) per local workspace in sparse mode. */
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
  /**
   * `local-weights`: never grant-managed; equal tenant weights only. `grants`: every tenant
   * with live sandboxes holds an active allocator grant. `degraded`: grant-managed but at
   * least one such tenant runs on the bounded local fallback; new grant-requiring
   * admissions are gated until the allocator recovers (§7.3).
   */
  fairness: {
    mode: "local-weights" | "grants" | "degraded";
    managed: boolean;
    /**
     * Whether this host gates new grant-requiring admissions while managed
     * (`PI_POD_SANDBOX_GRANT_GATE_ADMISSION`, default on). Optional so old
     * hosts stay valid: servers read absence as unknown, never off.
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

export interface HoldErrorDetails {
  kind: "hold";
  holder: string;
  since: string;
}

export interface ArchiveErrorDetails {
  kind: "archive";
  expected: { key: string; sha256: string; size?: number };
  actual: { present: boolean; size: number | null; sha256: string | null };
}

export type ErrorDetails =
  | AdmissionErrorDetails
  | RevisionErrorDetails
  | OperationErrorDetails
  | HoldErrorDetails
  | ArchiveErrorDetails;

/* ------------------------------------------------------ create idempotency */

export type OperationStatus = "pending" | "succeeded" | "failed" | "cancelled";

/**
 * What a terminal failure/cancellation left behind. `preallocation`: refused before any
 * allocation. `cleaned`: every host resource confirmed released. `quarantined`: a sandbox
 * or its resources may still exist on this host; a cross-host retry would duplicate it.
 */
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
   * same pod on another host (§6.5).
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

/** `restart-expired`: persisted before a service restart; elapsed time is unknown, so it is treated as expired but its revision high-water mark is kept. */
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
   * archived `heartbeat` (plan §8.1.1). Optional so older servers ignore it.
   */
  cadence?: "full" | "heartbeat";
  /**
   * False when counters were not read from a cgroup for this sample (a heartbeat,
   * or a sandbox with no live runtime). `live` stays the coarse presence flag.
   */
  cpuValid?: boolean;
  /**
   * Service-readiness observation at this sample (`pod-ready-v1`): an authorized
   * pod execution whose runtime supervision and required resources are intact.
   * Not application health, availability or useful work.
   */
  serviceReady?: boolean | null;
  predicateVersion?: string | null;
  /** Runtime monotonic reading at sample time; durations must come from deltas of this. */
  monotonicMs?: number | null;
}

/**
 * One usage sample as returned: the sample plus the identity the evidence
 * envelope signs with it. `seq` is assigned per observation at assembly time so
 * a retry of the same signed page replays identical records, while each new
 * poll is a new observation.
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
  /** Stable identity of this outbox incarnation; changes only if the outbox is recreated. */
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
  /** The runtime boot that originated this row. Never the boot of the page serving it. */
  bootId?: string;
  /** Operation duration where the event closes an operation. */
  durationMs?: number;
  /** Final counters captured before teardown (`stopped`/`terminal`), so a sandbox that lived between two polls is not invisible. */
  counters?: UsageCounters & { memoryCurrentBytes: number };
  /** Small bounded scalars: sizes, bytes moved, reason codes. Never env, prompts, files, or tokens. */
  detail?: Record<string, number | string | boolean | null>;
}

/** Signed response envelope for the usage feed. Additive: absent when signing is off. */
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
  /** Stable identity of this outbox incarnation; changes only if the outbox is recreated. */
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

export interface ListResponse {
  sandboxes: SandboxInfoWire[];
}

export interface HealthResponse {
  ok: true;
  version: string;
  uptimeSeconds: number;
  /** Identifies this host to a fleet scheduler sharing one archive bucket. */
  hostId: string;
  sandboxes: { hot: number; warm: number; stopped: number; archived: number };
  host: {
    cpus: number;
    memoryTotalBytes: number;
    memoryAvailableBytes: number;
    /** Total CPU/RAM guarantees available to sandboxes after the host reserve. */
    guaranteeCapacity: { cpu: number; memoryBytes: number };
    /**
     * What admission control would compare a new sandbox against: guarantees already owed to
     * live sandboxes, and sparse disk quotas committed against the state filesystem. A
     * scheduler picking between hosts needs the committed side, not just the capacity.
     */
    committed: { cpu: number; memoryBytes: number; diskBytes: number };
    diskCapacityBytes: number;
  };
  /** Versioned capacity contract (§6.3); host aggregates only, no tenant data. */
  capacity?: CapacityReportV1;
}

export interface AuthzResponse {
  ok: true;
  /** Names the runtime so `doctor` can report what isolation is actually in force. */
  runtime: string;
  archiveStore: "s3" | "local" | "none" | "proxy";
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

/* ------------------------------------------------------------------------- *
 * WebSocket framing
 *
 * Control travels as JSON text frames; payload as binary frames. Base64-in-JSON would
 * inflate every chunk of a build log by a third for no gain — the channel is already
 * framed by WebSocket.
 *
 * On an exec channel the first byte of each binary frame names the stream, because stdout
 * and stderr share one socket. A PTY carries a single stream in each direction, so its
 * frames are the raw bytes with no tag: a constant prefix byte on every keystroke and every
 * screen update would be overhead and an extra copy on the latency-sensitive path.
 * ------------------------------------------------------------------------- */

export const STREAM_STDOUT = 1;
export const STREAM_STDERR = 2;
/** Client → server stdin on an exec channel. */
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
  /** Detach without killing the session — the whole point of server-held PTYs. */
  | { type: "detach" }
  | { type: "kill" };

export type PtyServerFrame =
  | { type: "ready"; sessionId: string; reattached: boolean }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; code: string; message: string };

/** Session no longer exists — the adapter turns this into `reconnectPty() → null`. */
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
/** 409: the sandbox already has a different owner, or is live and grandfathered until it stops. */
export const ERR_OWNER_CONFLICT = "owner_conflict";
/** 400: launches of unowned sandboxes are refused on this host (`PI_POD_SANDBOX_REQUIRE_OWNER`). */
export const ERR_OWNER_REQUIRED = "owner_required";
/** 409: a quiescence hold refuses wake/archive/resize/delete until released. */
export const ERR_SANDBOX_HELD = "sandbox_held";
/** 409: the explicitly requested archive object is absent or does not match. */
export const ERR_ARCHIVE_MISMATCH = "archive_mismatch";
/** 409: the target resolved the image to a different manifest digest than the source recorded. */
export const ERR_IMAGE_MISMATCH = "image_mismatch";
