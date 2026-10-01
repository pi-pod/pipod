/**
 * Usage snapshot + bounded lifecycle-event outbox (plan §8.1–8.2).
 *
 * The outbox is a best-effort telemetry channel: `record()` never throws, and old rows
 * are dropped past either bound so an unpolled consumer cannot grow the DB without
 * limit. Dropped *unacknowledged* rows are reported as a coverage gap
 * (`droppedBeforeSeq`) rather than silently skipped.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { badRequest } from "../errors.js";
import { EvidenceKey, OUTBOX_INCARNATION } from "./evidence-key.js";
import type { SandboxRow } from "../db/index.js";
import type { ExtendedCgroupStats } from "../runtime/cgroup.js";
import {
  USAGE_CONTRACT_VERSION,
  type SandboxState,
  type UsageAckResponse,
  type UsageCounters,
  type UsageEventWire,
  type UsageEventsResponse,
  type UsageSampleRecordV1,
  type UsageSampleWire,
  type UsageSnapshotV1,
} from "../wire.js";

export interface UsageLedgerOptions {
  hostId: string;
  bootId: string;
  /** Outbox bounds; the oldest unacknowledged rows are dropped past either and reported as a gap. */
  maxRows: number;
  maxAgeMs: number;
  now?: () => number;
  /** Hard payload cap for snapshot pages (§8.1.1); defaults to 1000. */
  maxSnapshotRows?: number;
  /** Signed-response identity for the small profile. Off by default: no key, no envelope. */
  evidence?: EvidenceKey | null;
}

export type UsageEventInput = Omit<UsageEventWire, "seq" | "at"> & { at?: number };

export interface UsageLedgerStats {
  rows: number;
  oldestSeq: number | null;
  newestSeq: number | null;
  droppedBeforeSeq: number | null;
  acknowledgedSeq: number;
}

/** Meta keys persisted in `usage_outbox_meta`. */
const META_ACKNOWLEDGED = "acknowledged_seq";
const META_DROPPED = "dropped_before_seq";
/** Stable across runtime restarts; a recreated outbox gets a new one, so lineage stays honest. */
const META_INCARNATION = "outbox_incarnation";

/** Secret-looking detail keys are never stored (case-insensitive substring match). */
const SECRET_KEY_PARTS = ["token", "secret", "password", "env", "authorization"] as const;

/** Bounded scalar budget for `detail`: at most this many keys, short strings only. */
const MAX_DETAIL_KEYS = 32;
const MAX_DETAIL_STRING = 256;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  owner_key TEXT,
  runtime_generation INTEGER NOT NULL,
  duration_ms INTEGER,
  counters_json TEXT,
  detail_json TEXT,
  boot_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events(at);
CREATE TABLE IF NOT EXISTS usage_outbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

interface UsageEventRow {
  seq: number;
  at: number;
  kind: UsageEventWire["kind"];
  sandbox_id: string;
  owner_key: string | null;
  runtime_generation: number;
  duration_ms: number | null;
  counters_json: string | null;
  detail_json: string | null;
  boot_id: string;
}

export class UsageLedger {
  private readonly db: Database.Database;
  private readonly hostId: string;
  private readonly bootId: string;
  private readonly maxRows: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly maxSnapshotRows: number;
  private readonly evidence: EvidenceKey | null;
  private readonly outboxIncarnation: string;
  /** Per-boot snapshot sequence; a consumer treats a smaller value as stale. */
  private sequence = 1;
  /** Per-boot observation sequence; one increment per sample record assembled. */
  private sampleSeq = 1;

  constructor(db: Database.Database, opts: UsageLedgerOptions) {
    this.db = db;
    this.hostId = opts.hostId;
    this.bootId = opts.bootId;
    this.maxRows = opts.maxRows;
    this.maxAgeMs = opts.maxAgeMs;
    this.now = opts.now ?? (() => Date.now());
    const cap = opts.maxSnapshotRows;
    this.maxSnapshotRows =
      typeof cap === "number" && Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 1000;
    this.evidence = opts.evidence ?? null;
    this.db.exec(SCHEMA);
    // The acknowledged watermark starts at 0 so a fresh consumer sees every row.
    this.db
      .prepare("INSERT OR IGNORE INTO usage_outbox_meta (key, value) VALUES (?, ?)")
      .run(META_ACKNOWLEDGED, "0");
    const existing = this.db
      .prepare("SELECT value FROM usage_outbox_meta WHERE key = ?")
      .get(META_INCARNATION) as { value: string } | undefined;
    if (existing && OUTBOX_INCARNATION.test(existing.value)) {
      this.outboxIncarnation = existing.value;
    } else {
      this.outboxIncarnation = randomUUID();
      this.db
        .prepare("INSERT OR REPLACE INTO usage_outbox_meta (key, value) VALUES (?, ?)")
        .run(META_INCARNATION, this.outboxIncarnation);
    }
  }

  /** Append; returns the seq, or null when the write failed (logged by the caller, never thrown). */
  record(event: UsageEventInput): number | null {
    try {
      const nowMs = this.now();
      const at = Number.isFinite(event.at) ? (event.at as number) : nowMs;
      const durationMs =
        typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
          ? event.durationMs
          : null;
      const detail = sanitizeDetail(event.detail);
      const result = this.db
        .prepare(
          `INSERT INTO usage_events
             (at, kind, sandbox_id, owner_key, runtime_generation, duration_ms, counters_json, detail_json, boot_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          at,
          event.kind,
          event.sandboxId,
          event.ownerKey ?? null,
          event.runtimeGeneration,
          durationMs,
          event.counters != null ? JSON.stringify(event.counters) : null,
          detail !== undefined ? JSON.stringify(detail) : null,
          this.bootId,
        );
      const seq = Number(result.lastInsertRowid);
      this.enforceBounds(nowMs);
      return seq;
    } catch {
      // Metering must never break lifecycle transitions; the caller logs the null.
      return null;
    }
  }

  events(after: number, limit: number, nonce: string | null = null): UsageEventsResponse {
    const afterSeq = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0;
    const lim = clampLimit(limit, 1, 1000, 200);
    const rows = this.db
      .prepare("SELECT * FROM usage_events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(afterSeq, lim) as UsageEventRow[];
    const oldest = this.db
      .prepare("SELECT MIN(seq) AS min_seq FROM usage_events")
      .get() as { min_seq: number | null };
    const response: UsageEventsResponse = {
      contractVersion: USAGE_CONTRACT_VERSION,
      hostId: this.hostId,
      bootId: this.bootId,
      outboxIncarnation: this.outboxIncarnation,
      events: rows.map(toWire),
      nextAfter: rows.length > 0 ? (rows[rows.length - 1] as UsageEventRow).seq : afterSeq,
      oldestRetainedSeq: oldest.min_seq ?? null,
      droppedBeforeSeq: this.readDroppedBeforeSeq(),
      acknowledgedSeq: this.readAcknowledgedSeq(),
    };
    return this.withEvidence(response, "usage-events", nonce, { after: afterSeq, limit: lim }, response.events);
  }

  /** Acknowledged rows are deleted; `acknowledgedSeq` is persisted. */
  ack(upTo: number): UsageAckResponse {
    if (typeof upTo !== "number" || !Number.isFinite(upTo) || upTo < 0) {
      throw badRequest("usage ack upTo must be a non-negative finite number");
    }
    const watermark = Math.floor(upTo);
    this.db.prepare("DELETE FROM usage_events WHERE seq <= ?").run(watermark);
    const acknowledgedSeq = Math.max(this.readAcknowledgedSeq(), watermark);
    this.writeMeta(META_ACKNOWLEDGED, String(acknowledgedSeq));
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
    return { acknowledgedSeq, retained: n };
  }

  /**
   * Page pre-built samples (sorted by sandboxId) after `cursor`; bumps the per-boot
   * sequence. `limit` is clamped to the hard payload cap (§8.1.1), so a paginating
   * server sees each assembled row once per poll and no page exceeds the cap.
   */
  snapshot(
    samples: UsageSampleWire[],
    opts: { cursor: string | null; limit: number; nonce?: string | null },
  ): UsageSnapshotV1 {
    // The fallback must itself respect the cap: with a small configured maximum an
    // invalid limit must not escape it.
    const lim = clampLimit(opts.limit, 1, this.maxSnapshotRows, Math.min(200, this.maxSnapshotRows));
    const cursor: string | null = opts.cursor;
    const rest = cursor === null ? samples : samples.filter((s) => s.sandboxId > cursor);
    const page = rest.slice(0, lim);
    const sequence = this.sequence++;
    const sampledAt = new Date(this.now()).toISOString();
    // Each returned sample is a self-identifying observation record: the signed
    // envelope covers these exact bytes, so a retry of this page replays the
    // same identity and content, and the server can compare content on replay
    // instead of trusting the key alone.
    const records: UsageSampleRecordV1[] = page.map((sample) => ({
      ...sample,
      bootId: this.bootId,
      seq: this.sampleSeq++,
      kind: "usage-sample",
      at: sampledAt,
      outboxIncarnation: this.outboxIncarnation,
      counters: sample,
    }));
    const response: UsageSnapshotV1 = {
      contractVersion: USAGE_CONTRACT_VERSION,
      hostId: this.hostId,
      bootId: this.bootId,
      sequence,
      sampledAt,
      samples: records,
      nextCursor: rest.length > page.length ? (page[page.length - 1] as UsageSampleWire).sandboxId : null,
      limit: lim,
      outboxIncarnation: this.outboxIncarnation,
    };
    return this.withEvidence(
      response,
      "usage-snapshot",
      opts.nonce ?? null,
      { cursor, limit: lim, sequence: response.sequence },
      response.samples,
    );
  }

  /** Attach the signed envelope covering request identity and the exact returned records. */
  private withEvidence<T extends { evidence?: unknown }>(
    response: T,
    endpoint: "usage-snapshot" | "usage-events",
    nonce: string | null,
    request: Record<string, string | number | null>,
    records: unknown,
  ): T {
    if (!this.evidence) return response;
    if (nonce !== null && !/^[A-Za-z0-9._:-]{1,64}$/.test(nonce)) {
      throw badRequest("usage nonce must match [A-Za-z0-9._:-]{1,64}");
    }
    response.evidence = this.evidence.envelope({
      endpoint,
      nonce,
      request,
      hostId: this.hostId,
      outboxIncarnation: this.outboxIncarnation,
      records,
    });
    return response;
  }

  stats(): UsageLedgerStats {
    const agg = this.db
      .prepare("SELECT COUNT(*) AS n, MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM usage_events")
      .get() as { n: number; min_seq: number | null; max_seq: number | null };
    return {
      rows: agg.n,
      oldestSeq: agg.min_seq ?? null,
      newestSeq: agg.max_seq ?? null,
      droppedBeforeSeq: this.readDroppedBeforeSeq(),
      acknowledgedSeq: this.readAcknowledgedSeq(),
    };
  }

  /**
   * Drop rows past either bound. Rows already acknowledged are forgotten silently; rows
   * the consumer has not acked yet move the gap watermark so the gap is visible.
   */
  private enforceBounds(nowMs: number): void {
    const acknowledged = this.readAcknowledgedSeq();
    const unackedDropped: number[] = [];
    // Age bound first, then the row-count bound on what remains.
    const aged = this.db
      .prepare("SELECT seq FROM usage_events WHERE at < ?")
      .all(nowMs - this.maxAgeMs) as { seq: number }[];
    if (aged.length > 0) {
      for (const r of aged) {
        if (r.seq > acknowledged) unackedDropped.push(r.seq);
      }
      this.db.prepare("DELETE FROM usage_events WHERE at < ?").run(nowMs - this.maxAgeMs);
    }
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as {
      n: number;
    };
    if (n > this.maxRows) {
      const excess = n - this.maxRows;
      const oldest = this.db
        .prepare("SELECT seq FROM usage_events ORDER BY seq ASC LIMIT ?")
        .all(excess) as { seq: number }[];
      for (const r of oldest) {
        if (r.seq > acknowledged) unackedDropped.push(r.seq);
      }
      if (oldest.length > 0) {
        const seqs = oldest.map((r) => r.seq);
        this.db
          .prepare(`DELETE FROM usage_events WHERE seq IN (${seqs.map(() => "?").join(",")})`)
          .run(...seqs);
      }
    }
    if (unackedDropped.length > 0) {
      const maxDropped = Math.max(...unackedDropped);
      const existing = this.readDroppedBeforeSeq();
      this.writeMeta(META_DROPPED, String(existing !== null ? Math.max(existing, maxDropped) : maxDropped));
    }
  }

  private readAcknowledgedSeq(): number {
    const row = this.db
      .prepare("SELECT value FROM usage_outbox_meta WHERE key = ?")
      .get(META_ACKNOWLEDGED) as { value: string } | undefined;
    const parsed = row !== undefined ? Number(row.value) : 0;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  }

  private readDroppedBeforeSeq(): number | null {
    const row = this.db
      .prepare("SELECT value FROM usage_outbox_meta WHERE key = ?")
      .get(META_DROPPED) as { value: string } | undefined;
    if (row === undefined) return null;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  }

  private writeMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO usage_outbox_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
}

function clampLimit(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function toWire(row: UsageEventRow): UsageEventWire {
  const event: UsageEventWire = {
    seq: row.seq,
    at: new Date(row.at).toISOString(),
    kind: row.kind,
    sandboxId: row.sandbox_id,
    ownerKey: row.owner_key,
    runtimeGeneration: row.runtime_generation,
    // The originating boot, never the boot of the page that happens to serve it.
    bootId: row.boot_id,
  };
  if (row.duration_ms !== null) event.durationMs = row.duration_ms;
  if (row.counters_json !== null) {
    event.counters = JSON.parse(row.counters_json) as UsageEventWire["counters"];
  }
  if (row.detail_json !== null) {
    event.detail = JSON.parse(row.detail_json) as NonNullable<UsageEventWire["detail"]>;
  }
  return event;
}

/**
 * Keep only small bounded scalars, and never anything that looks like a credential:
 * the outbox is scraped by the fleet, so env dumps and tokens must not reach it even
 * when a lifecycle caller passes a rich context object.
 */
function sanitizeDetail(
  detail: UsageEventInput["detail"],
): Record<string, number | string | boolean | null> | undefined {
  if (detail === undefined || detail === null || typeof detail !== "object" || Array.isArray(detail)) {
    return undefined;
  }
  const out: Record<string, number | string | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (Object.keys(out).length >= MAX_DETAIL_KEYS) break;
    if (typeof key !== "string" || key.length === 0) continue;
    if (SECRET_KEY_PARTS.some((part) => key.toLowerCase().includes(part))) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (typeof value === "string") {
      if (value.length <= MAX_DETAIL_STRING) out[key] = value;
    }
    // Objects, arrays, undefined, and functions carry unbounded or opaque payloads.
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerceCounter(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function countersFrom(stats: ExtendedCgroupStats): UsageCounters & { memoryCurrentBytes: number } {
  return {
    cpuUsec: coerceCounter(stats.cpuUsec),
    cpuUserUsec: coerceCounter(stats.cpuUserUsec),
    cpuSystemUsec: coerceCounter(stats.cpuSystemUsec),
    throttledUsec: coerceCounter(stats.throttledUsec),
    nrPeriods: coerceCounter(stats.nrPeriods),
    nrThrottled: coerceCounter(stats.nrThrottled),
    memoryPeakBytes: coerceCounter(stats.memoryPeak),
    oomEvents: coerceCounter(stats.oomEvents),
    oomKillEvents: coerceCounter(stats.oomKillEvents),
    memoryCurrentBytes: coerceCounter(stats.memoryCurrent),
  };
}

/** Build one snapshot sample from the row plus an optional live cgroup read. */
export function buildUsageSample(input: {
  row: SandboxRow;
  state: SandboxState;
  /** null when the sandbox has no cgroup right now (stopped/archived). */
  stats: ExtendedCgroupStats | null;
  diskCommittedBytes: number;
  diskAllocatedBytes: number;
  /** `heartbeat` collapses a provably-archived row to daily presence (§8.1.1). */
  cadence?: "full" | "heartbeat";
  /** Overrides the default validity (`stats !== null`); heartbeats are never valid. */
  cpuValid?: boolean;
  /** Explicit readiness observation; absence means "not observed", never ready. */
  serviceReady?: boolean;
  predicateVersion?: string;
  monotonicMs?: number;
}): UsageSampleWire {
  const { row, state, stats } = input;
  const counters =
    stats !== null
      ? countersFrom(stats)
      : {
          cpuUsec: 0,
          cpuUserUsec: 0,
          cpuSystemUsec: 0,
          throttledUsec: 0,
          nrPeriods: 0,
          nrThrottled: 0,
          memoryPeakBytes: 0,
          oomEvents: 0,
          oomKillEvents: 0,
          memoryCurrentBytes: 0,
        };
  // Only scalar telemetry leaves this function: labels, env, and image refs stay out
  // because the snapshot crosses the host boundary to the fleet scheduler.
  return {
    ...counters,
    sandboxId: row.id,
    ownerKey: row.ownerKey,
    runtimeGeneration: row.runtimeGeneration,
    tier: row.tier,
    state,
    live: stats !== null,
    memoryPressureAvg10: stats !== null && Number.isFinite(stats.memoryPressure) ? stats.memoryPressure : -1,
    cpuPressureAvg10: stats !== null && Number.isFinite(stats.cpuPressure) ? stats.cpuPressure : -1,
    pidsCurrent: stats !== null ? coerceCounter(stats.pidsCurrent) : 0,
    diskCommittedBytes: input.diskCommittedBytes,
    diskAllocatedBytes: input.diskAllocatedBytes,
    archiveSizeBytes: row.archiveSize,
    lastActivityAt: new Date(row.lastActivityAt).toISOString(),
    stoppedAt: row.stoppedAt !== null ? new Date(row.stoppedAt).toISOString() : null,
    cadence: input.cadence ?? "full",
    cpuValid: input.cpuValid ?? stats !== null,
    // Absent observations stay absent: an unobserved readiness or monotonic
    // reading must never be manufactured as `false` or `0`.
    serviceReady: input.serviceReady ?? null,
    predicateVersion: input.predicateVersion ?? null,
    monotonicMs: Number.isFinite(input.monotonicMs) ? (input.monotonicMs as number) : null,
  };
}
