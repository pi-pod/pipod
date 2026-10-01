/**
 * Request-aware fleet capacity (§6.3–6.4).
 *
 * A health probe is advisory; the host's atomic admission is final (every create
 * still handles 507/400). This module makes the advisory side honest:
 *
 * - validate the versioned capacity contract (never trust free-form numbers),
 * - treat stale snapshots conservatively (assume no headroom),
 * - filter candidates by actual request fit (`freeDisk > 0` is not enough for a
 *   20 GiB request; 19.9 GiB free refuses a 20 GiB request),
 * - rank the survivors by documented headroom + validated CPU pressure with a
 *   deterministic tiebreak (no optimizer until telemetry justifies one).
 *
 * All functions are pure (no I/O, no clock reads except via injected `nowMs`)
 * so the fairness/placement suites can drive them deterministically.
 */
import {
  CAPACITY_CONTRACT_VERSION,
  type CapacityReportV1,
  type ResourceShape,
} from "../../core/providers/sandbox/wire.js";
import { HttpError } from "../httperrors.js";

export const BYTES_PER_GB = 1024 ** 3;

/** The standard shape: 2 CPU / 4 GiB / 20 GiB (§7.4 stays default). */
export const STANDARD_SHAPE: ResourceShape = Object.freeze({
  cpu: 2,
  memoryGB: 4,
  diskGB: 20,
}) as ResourceShape;

/** Largest shape the gated path may admit; the deployment gate decides, not this constant. */
export const GATED_MAX_SHAPE: ResourceShape = Object.freeze({
  cpu: 2,
  memoryGB: 8,
  diskGB: 20,
}) as ResourceShape;

export interface ResolvedShape extends ResourceShape {
  memoryBytes: number;
  diskBytes: number;
}

/** Resolve a possibly-partial request to a full shape; omitted fields take the standard. */
export function resolveShape(requested?: {
  cpu?: number;
  memoryGB?: number;
  diskGB?: number;
}): ResolvedShape {
  const shape: ResourceShape = {
    cpu: requested?.cpu ?? STANDARD_SHAPE.cpu,
    memoryGB: requested?.memoryGB ?? STANDARD_SHAPE.memoryGB,
    diskGB: requested?.diskGB ?? STANDARD_SHAPE.diskGB,
  };
  return { ...shape, memoryBytes: shape.memoryGB * BYTES_PER_GB, diskBytes: shape.diskGB * BYTES_PER_GB };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidShape(value: unknown): value is ResourceShape {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isFiniteNonNegative(record["cpu"]) &&
    isFiniteNonNegative(record["memoryGB"]) &&
    isFiniteNonNegative(record["diskGB"])
  );
}

/**
 * Validate a capacity report from the wire. Rejects malformed/negative/NaN
 * values (returns null): a host that sends nonsense is treated as having no
 * usable report, never as having infinite headroom.
 */
export function validateCapacityReport(raw: unknown): CapacityReportV1 | null {
  if (raw === null || typeof raw !== "object") return null;
  const report = raw as Record<string, unknown>;
  if (report["contractVersion"] !== CAPACITY_CONTRACT_VERSION) return null;
  if (typeof report["hostId"] !== "string" || report["hostId"] === "") return null;
  if (typeof report["bootId"] !== "string" || report["bootId"] === "") return null;
  if (!isFiniteNonNegative(report["generation"])) return null;
  if (typeof report["sampledAt"] !== "string" || Number.isNaN(Date.parse(report["sampledAt"]))) {
    return null;
  }
  const capabilities = report["capabilities"] as Record<string, unknown> | undefined;
  const memory = report["memory"] as Record<string, unknown> | undefined;
  const cpu = report["cpu"] as Record<string, unknown> | undefined;
  const disk = report["disk"] as Record<string, unknown> | undefined;
  const transitions = report["transitions"] as Record<string, unknown> | undefined;
  if (!capabilities || !memory || !cpu || !disk || !transitions) return null;
  if (!isValidShape(capabilities["maxShape"])) return null;
  if (!isValidShape(capabilities["standardShape"])) return null;
  if (capabilities["memoryAdmission"] !== "ceiling" && capabilities["memoryAdmission"] !== "floor") {
    return null;
  }
  if (capabilities["boat"] !== undefined && typeof capabilities["boat"] !== "boolean") return null;
  if (capabilities["diskAdmission"] !== undefined && capabilities["diskAdmission"] !== "sparse") return null;
  if (capabilities["storageQuotaBytes"] !== undefined && !isFiniteNonNegative(capabilities["storageQuotaBytes"])) return null;
  if (capabilities["sparseMinDiskBytes"] !== undefined && !isFiniteNonNegative(capabilities["sparseMinDiskBytes"])) return null;
  for (const key of [
    "budgetBytes",
    "committedBytes",
    "inFlightBytes",
    "quarantinedBytes",
    "debtBytes",
    "availableBytes",
    "hostTotalBytes",
    "hostAvailableBytes",
  ]) {
    if (!isFiniteNonNegative(memory[key])) return null;
  }
  for (const key of ["hostCpus", "budgetCores", "committedFloorCores", "ceilingCoresSum", "loadAvg1"]) {
    if (!isFiniteNonNegative(cpu[key])) return null;
  }
  if (typeof cpu["pressureAvg10"] !== "number" || !Number.isFinite(cpu["pressureAvg10"])) return null;
  for (const key of [
    "capacityBytes",
    "committedBytes",
    "inFlightBytes",
    "quarantinedBytes",
    "allocatedBytes",
    "scratchBudgetBytes",
    "scratchUsedBytes",
    "availableBytes",
  ]) {
    if (!isFiniteNonNegative(disk[key])) return null;
  }
  for (const key of [
    "inFlight",
    "maxInFlight",
    "archivesInFlight",
    "maxConcurrentArchives",
    "pendingOperations",
    "quarantinedOperations",
  ]) {
    if (!isFiniteNonNegative(transitions[key])) return null;
  }
  // Owner migration debt (§7.2 rollout, native rev3): when present it must be
  // a well-formed object (finite counters + requireOwner switch). When absent
  // (pre-rev3 host) the report stays valid for placement fit, but debt is
  // UNKNOWN — see tenancyDebt(): the allocator excludes such hosts rather
  // than granting around tenants it cannot see. Native rev5 adds the
  // optional `unownedUncertain` counter (error/quarantine ownership debt);
  // when present it must also be a finite non-negative number.
  const tenancy = report["tenancy"] as Record<string, unknown> | undefined;
  if (tenancy !== undefined) {
    for (const key of ["ownedSandboxes", "unownedLive", "unownedInitializable"]) {
      if (!isFiniteNonNegative(tenancy[key])) return null;
    }
    if (tenancy["unownedUncertain"] !== undefined && !isFiniteNonNegative(tenancy["unownedUncertain"])) {
      return null;
    }
    if (typeof tenancy["requireOwner"] !== "boolean") return null;
  }
  return raw as CapacityReportV1;
}

/**
 * Owner migration debt on a validated report: owned vs unowned counts.
 * Returns null when the host predates the tenancy report (unknown debt) —
 * callers that need tenant completeness (the CPU allocator) must treat
 * unknown as indebted, never as clean.
 *
 * Native rev5 adds the optional `unownedUncertain` (error/quarantine
 * ownership debt that even owner-init must not touch — ambiguous legacy
 * owners are rejected). When `tenancy` is present but the counter is
 * ABSENT (older producer), the visible sum undercounts hidden error
 * ownership debt, so this also returns null: missing must never read as
 * measured zero. Only a present counter (even zero) proves the debt was
 * actually measured.
 */
export function tenancyDebt(report: CapacityReportV1): number | null {
  const tenancy = (report as { tenancy?: CapacityReportV1["tenancy"] }).tenancy;
  if (tenancy === undefined) return null;
  if (typeof tenancy.unownedLive !== "number" || typeof tenancy.unownedInitializable !== "number") {
    return null;
  }
  if (typeof tenancy.unownedUncertain !== "number") return null;
  return tenancy.unownedLive + tenancy.unownedInitializable + tenancy.unownedUncertain;
}

/**
 * Platform disk default for native launches (canary gap, 2026-09-06).
 *
 * Product standard is 2 CPU / 4 GiB / 20 GiB, but the built-in defaults
 * carry diskGB 5 and native's own default disk is 10: a platform-funded
 * native launch with NO explicit disk config must resolve to 20, with
 * provenance naming the provider default — slotted BEFORE (lower precedence
 * than) every user/org policy layer, so any explicit setting wins.
 *
 * Scope is deliberately narrow: sandbox provider only, platform-funded only
 * (no explicit providers.sandbox.url in the layers — BYO services keep
 * their own defaults), disk axis only. BYOK providers and custom images, as well as explicit
 * disk values (even 5), are untouched: the built-in 5
 * stays the global default and explicit 5 stays an explicit 5.
 */
export const PLATFORM_SANDBOX_DEFAULT_DISK_GB = 20;

export function platformDiskDefault(args: {
  providerName: string;
  /** True when any layer set an explicit providers.sandbox.url (BYO service). */
  explicitSandboxUrl: boolean;
  /** Per-leaf winning layers from the settings merge (raw layers only). */
  provenance: ReadonlyArray<{ path: string }>;
  /** Provisioned large boats use the 60 GiB workspace default. Absent keeps 20. */
  diskGB?: number;
}): { diskGB: number; provenanceEntry: { path: string; winner: string; over: string[] } } | null {
  if (args.providerName !== "sandbox") return null;
  if (args.explicitSandboxUrl) return null;
  if (args.provenance.some((entry) => entry.path === "resources.diskGB")) return null;
  return {
    diskGB: args.diskGB ?? PLATFORM_SANDBOX_DEFAULT_DISK_GB,
    provenanceEntry: { path: "resources.diskGB", winner: "platform-default", over: [] },
  };
}

export type FreshnessVerdict = "fresh" | "stale-generation" | "stale-sample";

/**
 * Generation is monotonic per boot: a smaller generation for the same bootId is
 * an out-of-order sample and must be discarded. A new bootId resets the
 * sequence (the host forgot in-flight state and usage sequences on restart).
 */
export function checkGeneration(
  report: Pick<CapacityReportV1, "bootId" | "generation">,
  lastSeen: { bootId: string; generation: number } | null,
): FreshnessVerdict | "fresh-boot" {
  if (!lastSeen) return "fresh-boot";
  if (report.bootId !== lastSeen.bootId) return "fresh-boot";
  return report.generation < lastSeen.generation ? "stale-generation" : "fresh";
}

export function isSampleFresh(
  report: Pick<CapacityReportV1, "sampledAt">,
  freshnessMs: number,
  nowMs: number,
): boolean {
  const ageMs = nowMs - Date.parse(report.sampledAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;
  return ageMs <= freshnessMs;
}

export type CapacityRefusalReason =
  | "unsupported_shape"
  | "unsupported_admission"
  | "legacy_contract"
  | "malformed_capacity"
  | "host_mismatch"
  | "memory_debt"
  | "memory_capacity"
  | "disk_capacity"
  | "cpu_capacity"
  | "transition_capacity";

export interface CapacityFit {
  fits: boolean;
  /** Set when fits=false: the single resource that refuses first (memory→disk→transitions). */
  reason?: CapacityRefusalReason;
  requiredBytes?: number;
  availableBytes?: number;
}

/** Does this host's largest accepted shape cover the request? Never clamp: refuse. */
export function shapeWithinMax(shape: ResourceShape, maxShape: ResourceShape): boolean {
  return shape.cpu <= maxShape.cpu && shape.memoryGB <= maxShape.memoryGB && shape.diskGB <= maxShape.diskGB;
}

/**
 * Compare a resolved request against one validated, fresh capacity report.
 * Exact fit is admitted (19.9 GiB free refuses a 20 GiB request; 20.0 admits).
 * Grandfathered debt blocks new admissions until it drains.
 *
 * Ceiling admission is REQUIRED for platform placement: a host accounting
 * only the floor cannot uphold full-ceiling admission under concurrency, so
 * floor-mode reports refuse here — never as `unsupported_shape` (the shape
 * may be fine) and never silently overbooked.
 */
export function checkRequestFit(report: CapacityReportV1, shape: ResolvedShape): CapacityFit {
  if (!shapeWithinMax(shape, report.capabilities.maxShape)) {
    return { fits: false, reason: "unsupported_shape" };
  }
  if (report.capabilities.memoryAdmission !== "ceiling") {
    return { fits: false, reason: "unsupported_admission" };
  }
  if (report.memory.debtBytes > 0) {
    return {
      fits: false,
      reason: "memory_debt",
      requiredBytes: shape.memoryBytes,
      availableBytes: report.memory.availableBytes,
    };
  }
  if (report.memory.availableBytes < shape.memoryBytes) {
    return {
      fits: false,
      reason: "memory_capacity",
      requiredBytes: shape.memoryBytes,
      availableBytes: report.memory.availableBytes,
    };
  }
  if (report.disk.availableBytes < shape.diskBytes) {
    return {
      fits: false,
      reason: "disk_capacity",
      requiredBytes: shape.diskBytes,
      availableBytes: report.disk.availableBytes,
    };
  }
  if (report.transitions.inFlight >= report.transitions.maxInFlight) {
    return { fits: false, reason: "transition_capacity" };
  }
  return { fits: true };
}

/** Largest workspace filesystem an owned boat may be asked for. Aggregate
 * admission stays the host storage quota; this is not a per-sandbox reservation. */
export const OWNED_BOAT_DISK_CEILING_GB = 60;

/** Fresh ext4 image of 60 GiB measured 273346560 bytes allocated after mkfs
 * (2026-09-28, large boat from pipod-ws-v5). 512 MiB is above that measurement
 * and is the server's fresh-create charge. The host's atomic admission remains
 * final and charges the blocks the image actually allocates. */
export const OWNED_BOAT_FRESH_DISK_RESERVATION_BYTES = 512 * 1024 ** 2;

/** Bytes a fresh owned-boat create reserves. Sparse hosts do not reserve the
 * whole filesystem ceiling. Missing sparse attestation keeps the full ceiling. */
export function ownedBoatFreshDiskReservationBytes(report: CapacityReportV1, shape: ResolvedShape): number {
  if (report.capabilities.diskAdmission !== "sparse") return shape.diskBytes;
  const advertised = report.capabilities.sparseMinDiskBytes;
  if (typeof advertised === "number" && advertised > 0) return Math.max(advertised, OWNED_BOAT_FRESH_DISK_RESERVATION_BYTES);
  return OWNED_BOAT_FRESH_DISK_RESERVATION_BYTES;
}

/** Explicit personal-host policy, NEVER used for shared/static placement. The
 * caller must first verify owner custody, controller-ready host and exact boot.
 * 4GiB is a ceiling, not a reservation: the qualified runtime charges 512MiB and
 * .25CPU floors atomically. Sparse disk reserves the qualified fresh-image
 * charge, not the filesystem ceiling; runtime admission is final. */
export function checkOwnedBoatRequestFit(report: CapacityReportV1, shape: ResolvedShape): CapacityFit {
  if (report.capabilities.boat !== true) {
    return { fits: false, reason: "unsupported_admission" };
  }
  if (!shapeWithinMax(shape, { cpu: 2, memoryGB: 4, diskGB: OWNED_BOAT_DISK_CEILING_GB }) || !shapeWithinMax(shape, report.capabilities.maxShape)) {
    return { fits: false, reason: "unsupported_shape" };
  }
  if (report.capabilities.memoryAdmission === "ceiling") return checkRequestFit(report, shape);
  const requiredBytes = 512 * 1024 ** 2;
  if (report.memory.debtBytes > 0) return { fits: false, reason: "memory_debt", requiredBytes, availableBytes: report.memory.availableBytes };
  if (report.memory.availableBytes < requiredBytes) return { fits: false, reason: "memory_capacity", requiredBytes, availableBytes: report.memory.availableBytes };
  if (report.cpu.budgetCores - report.cpu.committedFloorCores < 0.25) return { fits: false, reason: "cpu_capacity" };
  const requiredDisk = ownedBoatFreshDiskReservationBytes(report, shape);
  if (report.disk.availableBytes < requiredDisk) return { fits: false, reason: "disk_capacity", requiredBytes: requiredDisk, availableBytes: report.disk.availableBytes };
  if (report.transitions.inFlight >= report.transitions.maxInFlight) return { fits: false, reason: "transition_capacity" };
  return { fits: true };
}

/**
 * Structural check for a server-constructed admission detail (placement
 * refusals, wait rows). Unlike `sanitizeErrorDetails` — which validates
 * HOST-sent details against the native enum — this accepts the wider
 * server-side reason set (legacy/floor/mismatch verdicts the native
 * contract never emits). Server-constructed details are trusted by
 * construction (validated numbers only); host-controlled input must still
 * go through the sanitizer.
 */
export function isAdmissionDetailLike(value: unknown): value is Record<string, unknown> & {
  kind: "admission";
  reason: string;
  retryable: boolean;
} {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record["kind"] === "admission" &&
    typeof record["reason"] === "string" &&
    typeof record["retryable"] === "boolean"
  );
}

export interface RankedCandidate {
  hostId: string;
  /** Bytes of memory headroom after this request would land (higher is better). */
  memoryHeadroomBytes: number;
  /** Bytes of disk headroom after this request would land (higher is better). */
  diskHeadroomBytes: number;
  /** Host CPU pressure avg10, -1 when unavailable (lower is better). */
  cpuPressure: number;
  /** True for legacy hosts with no capacity report (admission decides; ranked last). */
  legacy: boolean;
}

/**
 * Rank eligible candidates: legacy (unknown) hosts last, then most memory
 * headroom, then most disk headroom, then lowest CPU pressure, then host id.
 * Deterministic: the same inputs always choose the same host.
 */
export function rankCandidates(candidates: RankedCandidate[]): RankedCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.legacy !== right.legacy) return left.legacy ? 1 : -1;
    if (right.memoryHeadroomBytes !== left.memoryHeadroomBytes) {
      return right.memoryHeadroomBytes - left.memoryHeadroomBytes;
    }
    if (right.diskHeadroomBytes !== left.diskHeadroomBytes) {
      return right.diskHeadroomBytes - left.diskHeadroomBytes;
    }
    const leftPressure = left.cpuPressure < 0 ? Number.POSITIVE_INFINITY : left.cpuPressure;
    const rightPressure = right.cpuPressure < 0 ? Number.POSITIVE_INFINITY : right.cpuPressure;
    if (leftPressure !== rightPressure) return leftPressure - rightPressure;
    return left.hostId.localeCompare(right.hostId);
  });
}

/**
 * Per-host freshness memory: last accepted (bootId, generation) plus when the
 * report was observed. Guards caches/polls against out-of-order samples; the
 * launch path always probes, so it constructs fresh-by-observation reports and
 * uses this only to discard regressions.
 */
export class CapacityTracker {
  private readonly lastSeen = new Map<string, { bootId: string; generation: number; seenAtMs: number }>();

  note(hostId: string, report: Pick<CapacityReportV1, "bootId" | "generation">, nowMs: number): FreshnessVerdict {
    const previous = this.lastSeen.get(hostId) ?? null;
    const verdict = checkGeneration(report, previous);
    if (verdict === "stale-generation") return verdict;
    this.lastSeen.set(hostId, { bootId: report.bootId, generation: report.generation, seenAtMs: nowMs });
    return "fresh";
  }

  last(hostId: string): { bootId: string; generation: number; seenAtMs: number } | null {
    return this.lastSeen.get(hostId) ?? null;
  }
}

/**
 * Gated 8-GiB guard (§7.4). The standard stays 4 GiB: while the gate is off, a
 * request above 4 GiB is refused outright — downstream clamping to deployment
 * or provider maximums must never silently turn an advertised 8-GiB request
 * into a 4-GiB sandbox. With the gate on (and POD_MAX_MEMORY_GB raised), up
 * to 8 GiB passes through to capability-aware admission.
 */
export function assertSandboxShapeGate(
  requested: { cpu?: number; memoryGB?: number; diskGB?: number },
  env: { POD_ALLOW_8GIB_MEMORY?: unknown },
): void {
  const memoryGB = requested.memoryGB ?? STANDARD_SHAPE.memoryGB;
  if (memoryGB <= STANDARD_SHAPE.memoryGB) return;
  const allowed =
    env.POD_ALLOW_8GIB_MEMORY === true || env.POD_ALLOW_8GIB_MEMORY === "true";
  if (allowed && memoryGB <= GATED_MAX_SHAPE.memoryGB) return;
  const ceiling = allowed ? GATED_MAX_SHAPE.memoryGB : STANDARD_SHAPE.memoryGB;
  throw new HttpError(
    400,
    `memoryGB ${memoryGB} exceeds this deployment's ${ceiling} GiB per-sandbox limit` +
      (allowed
        ? "; request at most 8 GiB or register a larger host"
        : "; 8 GiB is gated in this deployment (POD_ALLOW_8GIB_MEMORY)"),
    "this sandbox size is not supported on the available hosts",
  );
}
