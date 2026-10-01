import * as os from "node:os";
import type { Config } from "../config.js";
import type { SandboxRow } from "../db/index.js";
import { badRequest, unsupportedShape } from "../errors.js";
import type { ResourceShape, ResourceSpec } from "../wire.js";
import type { CgroupLimits } from "../runtime/cgroup.js";

const GB = 1024 ** 3;

/** The largest shape this host admits; advertised in the capacity contract. */
export function maximumShape(cfg: Config): ResourceShape {
  return { cpu: cfg.maximums.cpu, memoryGB: cfg.maximums.memoryGB, diskGB: cfg.maximums.diskGB };
}

/** What an omitted request resolves to. */
export function standardShape(cfg: Config): ResourceShape {
  return {
    cpu: cfg.maximums.cpu,
    memoryGB: cfg.maximums.memoryGB,
    diskGB: Math.min(cfg.maximums.diskGB, cfg.defaults.diskGB),
  };
}

/**
 * Refuse a shape above the host maximum instead of shrinking it (§7.4): a caller that asked
 * for 8 GiB and silently received 4 GiB would OOM later and call it a fleet failure. The
 * legacy clamp is still available behind `PI_POD_SANDBOX_CLAMP_OVERSIZED_SHAPES`.
 */
export function assertSupportedShape(cfg: Config, requested?: ResourceSpec): void {
  if (!requested) return;
  // Malformed numbers are never clamped, in either mode: a negative disk quota would be
  // stored and *subtract* from committed capacity.
  for (const [name, value] of Object.entries(requested) as Array<[keyof ResourceSpec, unknown]>) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw badRequest(`resources.${name} must be a finite number greater than zero`);
    }
  }
  if (cfg.admission.clampOversizedShapes) return;
  const max = maximumShape(cfg);
  const over =
    (typeof requested.memoryGB === "number" && requested.memoryGB > max.memoryGB) ||
    (typeof requested.cpu === "number" && requested.cpu > max.cpu) ||
    (typeof requested.diskGB === "number" && requested.diskGB > max.diskGB);
  if (!over) return;
  const asked: Partial<ResourceShape> = {};
  if (typeof requested.cpu === "number") asked.cpu = requested.cpu;
  if (typeof requested.memoryGB === "number") asked.memoryGB = requested.memoryGB;
  if (typeof requested.diskGB === "number") asked.diskGB = requested.diskGB;
  throw unsupportedShape(asked, max);
}

/** Bytes a sandbox with this ceiling must have admitted under the configured memory policy. */
export function memoryReservationBytes(
  cfg: Config,
  guarantee: Required<ResourceSpec>,
  ceiling: ResourceSpec,
): number {
  if (cfg.admission.memoryMode === "floor") return guarantee.memoryGB * GB;
  return (ceiling.memoryGB ?? cfg.maximums.memoryGB) * GB;
}

/** Fixed reclaim/admission floor; callers can only select the separate ceiling. */
export const SANDBOX_RESOURCE_FLOOR = Object.freeze({ cpu: 0.25, memoryGB: 0.5 });
/** Defaults for the `PI_POD_SANDBOX_MAX_*` per-sandbox ceilings. */
export const SANDBOX_RESOURCE_MAXIMUM = Object.freeze({ cpu: 2, memoryGB: 4, diskGB: 20 });

export function resolveGuarantee(cfg: Config, requested?: ResourceSpec): Required<ResourceSpec> {
  return {
    cpu: SANDBOX_RESOURCE_FLOOR.cpu,
    memoryGB: SANDBOX_RESOURCE_FLOOR.memoryGB,
    diskGB: Math.min(cfg.maximums.diskGB, requested?.diskGB ?? cfg.defaults.diskGB),
  };
}

/** Normalize a caller-selected ceiling without allowing CPU, memory or disk outside configured bounds. */
export function resolveCeiling(cfg: Config, requested?: ResourceSpec): ResourceSpec {
  const clamp = (value: number | undefined, floor: number, maximum: number): number => {
    const normalized = typeof value === "number" && Number.isFinite(value) ? value : maximum;
    return Math.min(maximum, Math.max(floor, normalized));
  };
  const ceiling: ResourceSpec = {
    cpu: clamp(requested?.cpu, SANDBOX_RESOURCE_FLOOR.cpu, cfg.maximums.cpu),
    memoryGB: clamp(requested?.memoryGB, SANDBOX_RESOURCE_FLOOR.memoryGB, cfg.maximums.memoryGB),
  };
  if (typeof requested?.diskGB === "number" && Number.isFinite(requested.diskGB)) {
    ceiling.diskGB = Math.min(cfg.maximums.diskGB, requested.diskGB);
  }
  return ceiling;
}

/** Convert persisted pre-floor guarantees into ceilings during a rolling upgrade. */
export function normalizeResourcePolicy(
  cfg: Config,
  storedGuarantee: ResourceSpec,
  storedCeiling: ResourceSpec,
): { guarantee: Required<ResourceSpec>; ceiling: ResourceSpec } {
  return {
    guarantee: resolveGuarantee(cfg, storedGuarantee),
    ceiling: resolveCeiling(cfg, {
      cpu: storedCeiling.cpu ?? storedGuarantee.cpu,
      memoryGB: storedCeiling.memoryGB ?? storedGuarantee.memoryGB,
      diskGB: storedCeiling.diskGB ?? storedGuarantee.diskGB,
    }),
  };
}

/**
 * Every sandbox receives the fixed floor: cpu becomes a weight the kernel honors only under
 * contention and memory becomes reclaim protection. The caller-selected ceiling is a hard cap.
 */
export function limitsFor(
  guarantee: Required<ResourceSpec>,
  ceiling: ResourceSpec,
  maxPids: number,
): CgroupLimits {
  const memLow = guarantee.memoryGB * GB;
  const memHigh = ceiling.memoryGB ? ceiling.memoryGB * GB : null;
  return {
    cpuWeight: Math.round(guarantee.cpu * 100),
    cpuMaxCores: ceiling.cpu ?? null,
    memoryLow: memLow,
    memoryHigh: memHigh,
    memoryMax: memHigh,
    pidsMax: maxPids,
  };
}

export interface AdmissionVerdict {
  ok: boolean;
  reason?: string;
  hint?: string;
}

/** Total guarantees this host can admit after retaining its operator-configured reserve. */
export function guaranteeCapacity(cfg: Config): { cpu: number; memoryBytes: number } {
  return {
    cpu: Math.max(0, os.cpus().length - cfg.reserveCpu),
    memoryBytes: Math.max(0, os.totalmem() - cfg.reserveMemoryBytes),
  };
}

/**
 * Guarantees already owed to live sandboxes; the left-hand side of {@link admits}.
 *
 * A sandbox owes its guarantee from the moment it is admitted, not from the moment it turns
 * HOT: its row stays STOPPED for the whole boot, so without the booting ids a burst of
 * concurrent creates would each be answered against the full headroom.
 */
export function committedGuarantees(
  existing: SandboxRow[],
  booting: ReadonlySet<string> = new Set(),
): { cpu: number; memoryBytes: number } {
  const live = existing.filter((r) => r.tier === "hot" || r.tier === "warm" || booting.has(r.id));
  return {
    cpu: live.reduce((sum, r) => sum + (r.resources.cpu ?? 0), 0),
    memoryBytes: live.reduce((sum, r) => sum + (r.resources.memoryGB ?? 0) * GB, 0),
  };
}

/** Σ guarantees ≤ capacity − reserve (§7.2). Ceilings may overcommit; guarantees may not. */
export function admits(
  cfg: Config,
  existing: SandboxRow[],
  incoming: Required<ResourceSpec>,
  booting: ReadonlySet<string> = new Set(),
): AdmissionVerdict {
  const { cpu: usedCpu, memoryBytes: usedMemory } = committedGuarantees(existing, booting);
  const capacity = guaranteeCapacity(cfg);

  if (usedMemory + incoming.memoryGB * GB > capacity.memoryBytes) {
    return {
      ok: false,
      reason: `memory guarantees exhausted: ${(usedMemory / GB).toFixed(1)}GB committed of ${(capacity.memoryBytes / GB).toFixed(1)}GB, ${incoming.memoryGB}GB requested`,
      hint: "stop or archive an idle sandbox, or add host memory capacity",
    };
  }
  if (usedCpu + incoming.cpu > capacity.cpu) {
    return {
      ok: false,
      reason: `cpu guarantees exhausted: ${usedCpu.toFixed(1)} committed of ${capacity.cpu.toFixed(1)}, ${incoming.cpu} requested`,
      hint: "stop or archive an idle sandbox, or add host CPU capacity",
    };
  }
  return { ok: true };
}
