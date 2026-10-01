/**
 * Tenant identity helpers and host-local CPU grants (plan §7.2–7.3, reviewer addendum).
 *
 * Once the allocator pushes the first grant the host is grant-managed: expiry falls back
 * to an explicit bounded local share (never an uncapped cpu.max), and tenants without an
 * active grant are advertised as degraded so the Manager can gate grant-requiring
 * admissions.
 *
 * Grants are persisted. A restart cannot observe the previous boot's monotonic clock, so
 * adopted rows are treated as expired — but their revision high-water is kept, which is
 * what rejects a delayed pre-restart grant after the restart.
 */
import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { badRequest, staleRevision } from "../errors.js";
import { OWNER_USER_KEY, type CpuGrantRequest, type CpuGrantState, type CpuGrantWire } from "../wire.js";

/** Validates against OWNER_USER_KEY and returns the key; throws badRequest otherwise. */
export function validateOwnerKey(userKey: unknown): string {
  if (typeof userKey !== "string" || !OWNER_USER_KEY.test(userKey)) {
    throw badRequest("owner.userKey must match ^[A-Za-z0-9._-]{1,64}$");
  }
  return userKey;
}

export interface FallbackContext {
  /** Host CPU budget in cores (after the operator reserve). */
  budgetCores: number;
  /** Owners that currently have at least one live (hot/warm) sandbox. */
  activeOwners: number;
}

export interface GrantApplyResult {
  applied: boolean;
  grant: CpuGrantWire;
  /** What the parent cgroup should be capped at now: grant cores, or the fallback. */
  effectiveCores: number | null;
}

export interface GrantStatus {
  grant: CpuGrantWire | null;
  state: CpuGrantState;
  effectiveCores: number | null;
}

export interface CpuGrantsOptions {
  /** Operator override for the fallback; `null` = derive from FallbackContext. */
  fallbackCores: number | null;
  /** Monotonic milliseconds; defaults to performance.now(). Wall clocks are never consulted. */
  clock?: () => number;
  /** Date.now(); only used to stamp persisted rows, never for expiry. */
  wallClock?: () => number;
  /** Accepted ttl range; defaults 1 s .. 1 h. */
  minTtlMs?: number;
  maxTtlMs?: number;
  bootId: string;
}

/** Internal lifecycle, including the post-restart state wire.ts is growing. */
type GrantState = "active" | "expired" | "restart-expired";

interface GrantEntry {
  revision: number;
  cpuCores: number | null;
  ttlMs: number;
  /** Monotonic ms the grant was applied (meaningful only for this boot's grants). */
  grantedAtMs: number;
  /** False for rows adopted from a previous boot: elapsed time is unknown, treat as expired. */
  fromThisBoot: boolean;
  /** Set once `expireDue()` has reported this entry, so each expiry is reported exactly once. */
  reported: boolean;
}

interface GrantRow {
  user_key: string;
  revision: number;
  cpu_cores: number | null;
  ttl_ms: number;
  granted_wall_at: number;
  boot_id: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenant_cpu_grants (
  user_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  cpu_cores REAL,
  ttl_ms INTEGER NOT NULL,
  granted_wall_at INTEGER NOT NULL,
  boot_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenancy_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const META_MANAGED = "managed_mode";

/** Floor so the derived fallback never squeezes a tenant below a runnable share. */
const MIN_FALLBACK_CORES = 0.5;

export class CpuGrants {
  private readonly db: Database.Database;
  private readonly grants = new Map<string, GrantEntry>();
  private readonly bootId: string;
  private readonly fallbackOverride: number | null;
  private readonly clock: () => number;
  private readonly wallClock: () => number;
  private readonly minTtlMs: number;
  private readonly maxTtlMs: number;
  private managed: boolean;

  constructor(db: Database.Database, opts: CpuGrantsOptions) {
    this.db = db;
    this.bootId = opts.bootId;
    this.fallbackOverride = opts.fallbackCores;
    // Monotonic by construction: Date.now steps would move grant boundaries.
    this.clock = opts.clock ?? (() => performance.now());
    this.wallClock = opts.wallClock ?? (() => Date.now());
    this.minTtlMs = opts.minTtlMs ?? 1000;
    this.maxTtlMs = opts.maxTtlMs ?? 3_600_000;
    this.db.exec(SCHEMA);
    this.managed = this.readManaged();
    this.load();
  }

  /** True once any grant was ever applied on this host; persisted; never silently leaves. */
  managedMode(): boolean {
    return this.managed;
  }

  /** Rejects a revision at or below the high-water mark with staleRevision; validates ttl and cores. */
  apply(userKey: string, req: CpuGrantRequest, _ctx: FallbackContext): GrantApplyResult {
    if (!Number.isSafeInteger(req.revision) || req.revision < 0) {
      throw badRequest("cpu grant revision must be a non-negative safe integer");
    }
    if (
      typeof req.ttlMs !== "number" ||
      !Number.isFinite(req.ttlMs) ||
      req.ttlMs < this.minTtlMs ||
      req.ttlMs > this.maxTtlMs
    ) {
      throw badRequest(
        `cpu grant ttlMs must be within [${this.minTtlMs}, ${this.maxTtlMs}]`,
      );
    }
    if (
      req.cpuCores !== null &&
      (typeof req.cpuCores !== "number" || !Number.isFinite(req.cpuCores) || req.cpuCores <= 0)
    ) {
      throw badRequest("cpu grant cpuCores must be null or a finite number > 0");
    }
    // The high-water mark covers adopted pre-restart rows too, so a delayed grant from
    // before the restart is rejected rather than resurrected.
    const existing = this.grants.get(userKey);
    if (existing !== undefined && req.revision <= existing.revision) {
      throw staleRevision(req.revision, existing.revision, "cpu grant");
    }
    this.db
      .prepare(
        `INSERT INTO tenant_cpu_grants
           (user_key, revision, cpu_cores, ttl_ms, granted_wall_at, boot_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_key) DO UPDATE SET
           revision = excluded.revision,
           cpu_cores = excluded.cpu_cores,
           ttl_ms = excluded.ttl_ms,
           granted_wall_at = excluded.granted_wall_at,
           boot_id = excluded.boot_id`,
      )
      .run(userKey, req.revision, req.cpuCores, req.ttlMs, Math.floor(this.wallClock()), this.bootId);
    if (!this.managed) {
      this.db
        .prepare(
          "INSERT INTO tenancy_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(META_MANAGED, "1");
      this.managed = true;
    }
    // A newer revision always un-expires: the allocator has reasserted the grant.
    this.grants.set(userKey, {
      revision: req.revision,
      cpuCores: req.cpuCores,
      grantedAtMs: this.clock(),
      ttlMs: req.ttlMs,
      fromThisBoot: true,
      reported: false,
    });
    return {
      applied: true,
      grant: { revision: req.revision, cpuCores: req.cpuCores, expiresInMs: req.ttlMs, state: "active" },
      effectiveCores: req.cpuCores,
    };
  }

  status(userKey: string, ctx: FallbackContext): GrantStatus {
    const entry = this.grants.get(userKey);
    if (entry === undefined) {
      return {
        grant: null,
        state: "none",
        effectiveCores: this.managed ? this.fallbackCores(ctx) : null,
      };
    }
    const now = this.clock();
    const state = this.liveState(entry, now);
    if (state === "active") {
      return {
        grant: {
          revision: entry.revision,
          cpuCores: entry.cpuCores,
          expiresInMs: Math.max(0, entry.grantedAtMs + entry.ttlMs - now),
          state: "active",
        },
        state: "active",
        effectiveCores: entry.cpuCores,
      };
    }
    return {
      grant: {
        revision: entry.revision,
        cpuCores: entry.cpuCores,
        expiresInMs: 0,
        state: toWireState(state),
      },
      state: toWireState(state),
      effectiveCores: this.fallbackCores(ctx),
    };
  }

  /** Bounded fallback: opts.fallbackCores if set, else clamp(budget / max(1, activeOwners), 0.5, budget). */
  fallbackCores(ctx: FallbackContext): number {
    if (this.fallbackOverride !== null) return this.fallbackOverride;
    const perOwner = ctx.budgetCores / Math.max(1, ctx.activeOwners);
    return Math.min(Math.max(perOwner, MIN_FALLBACK_CORES), ctx.budgetCores);
  }

  /** Expired since last call (each reported once); caller applies effectiveCores to the cgroup. */
  expireDue(ctx: FallbackContext): Array<{ userKey: string; grant: CpuGrantWire; effectiveCores: number | null }> {
    const now = this.clock();
    const out: Array<{ userKey: string; grant: CpuGrantWire; effectiveCores: number | null }> = [];
    for (const [userKey, entry] of this.grants) {
      if (entry.reported) continue;
      const state = this.liveState(entry, now);
      if (state === "active") continue;
      // Adopted pre-restart rows land here on the first call after boot, so the Manager
      // applies the fallback to any tenant cgroup it adopted.
      entry.reported = true;
      out.push({
        userKey,
        grant: {
          revision: entry.revision,
          cpuCores: entry.cpuCores,
          expiresInMs: 0,
          state: toWireState(state),
        },
        effectiveCores: this.fallbackCores(ctx),
      });
    }
    return out;
  }

  /** Owners (from the given list) that lack an *active* grant while managed mode is on. Empty when not managed. */
  degradedOwners(ownersWithLiveSandboxes: string[]): string[] {
    if (!this.managed) return [];
    const now = this.clock();
    return ownersWithLiveSandboxes.filter((owner) => {
      const entry = this.grants.get(owner);
      return entry === undefined || this.liveState(entry, now) !== "active";
    });
  }

  forget(userKey: string): void {
    this.grants.delete(userKey);
    this.db.prepare("DELETE FROM tenant_cpu_grants WHERE user_key = ?").run(userKey);
    // managed_mode is deliberately kept: the host stays grant-managed.
  }

  counts(): { active: number; expired: number } {
    // Counted from the live state, not the reported flag, so an elapsed-but-unreported
    // grant already reads as expired to capacity/fairness consumers.
    const now = this.clock();
    let active = 0;
    let expired = 0;
    for (const entry of this.grants.values()) {
      if (this.liveState(entry, now) === "active") active += 1;
      else expired += 1;
    }
    return { active, expired };
  }

  private liveState(entry: GrantEntry, now: number): GrantState {
    if (!entry.fromThisBoot) return "restart-expired";
    return now >= entry.grantedAtMs + entry.ttlMs ? "expired" : "active";
  }

  private readManaged(): boolean {
    const row = this.db
      .prepare("SELECT value FROM tenancy_meta WHERE key = ?")
      .get(META_MANAGED) as { value: string } | undefined;
    return row?.value === "1";
  }

  private load(): void {
    const rows = this.db
      .prepare(
        "SELECT user_key, revision, cpu_cores, ttl_ms, granted_wall_at, boot_id FROM tenant_cpu_grants ORDER BY user_key",
      )
      .all() as GrantRow[];
    // Same-boot rows are live grants of this process, but the monotonic origin is
    // process-local, so a second instance in the same boot restarts their ttl.
    // Cross-boot rows keep only the revision high-water and read as expired.
    const now = this.clock();
    for (const row of rows) {
      this.grants.set(row.user_key, {
        revision: row.revision,
        cpuCores: row.cpu_cores,
        ttlMs: row.ttl_ms,
        grantedAtMs: now,
        fromThisBoot: row.boot_id === this.bootId,
        reported: false,
      });
    }
  }
}

/**
 * The reviewer is adding "restart-expired" to CpuGrantState in wire.ts; the double
 * assertion keeps this file compiling both before and after that lands. Runtime values
 * are unaffected either way.
 */
function toWireState(state: GrantState): CpuGrantState {
  return state as unknown as CpuGrantState;
}
