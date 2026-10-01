/**
 * Durable bounded capacity wait (§6.6).
 *
 * A launch/wake that is otherwise valid (within user/org entitlements, known
 * shape) but finds every host refusing with retryable capacity detail may wait
 * instead of failing immediately:
 *
 * - default total deadline 60s (`CAPACITY_WAIT_SECONDS`), configurable;
 * - quota-bound (waiting pods hold their atomic quota slot; no separate
 *   waiter cap) with cross-user round-robin attempt claims, so one user's
 *   burst cannot monopolize attempts;
 * - one pod identity and one user concurrency slot held the whole time (the
 *   pod row stays in a quota-holding state; queued operations hold no host
 *   reservation until an attempt starts);
 * - bounded retries with jitter + wakeup on capacity change (each attempt
 *   re-probes; an attempt's reservations are released before another host is
 *   chosen, only after confirmed pre-allocation refusal or confirmed cleanup);
 * - ambiguous creates retain their assignment and quarantined resources while
 *   the original host is queried by operation key — queue expiry never
 *   authorises a blind cross-host retry;
 * - heartbeat keeps the wait owned; the reaper expires dead waits; cancel is
 *   explicit; server restart recovers (unexpired waits are re-driven, expired
 *   ones fail closed with a typed capacity result; orphans go to the
 *   reconciler, never to a silent second create).
 *
 * Invalid shapes, auth failures, quota refusals, and unsupported_shape never
 * enter the queue: only retryable capacity waits.
 */
/**
 * Minimal query surface both the shared pool facade and a pg transaction
 * client satisfy — avoids overload-assignability friction with PoolClient.
 */
export interface WaitStore {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}
import { query } from "../db/index.js";
import { observeCapacityWait } from "../metrics.js";
import { sanitizeErrorDetails } from "../safe-errors.js";

export interface CapacityWaitConfig {
  enabled: boolean;
  /** Total deadline per wait (default 60s). */
  waitSeconds: number;
  /** Heartbeat interval the waiter promises (reaper grace = 3x). */
  heartbeatMs: number;
  /** Base delay between attempts (jittered, bounded by remaining deadline). */
  retryBaseMs: number;
}

export function capacityWaitConfig(env: {
  CAPACITY_WAIT_ENABLED?: unknown;
  CAPACITY_WAIT_SECONDS?: unknown;
}): CapacityWaitConfig {
  const enabled =
    env.CAPACITY_WAIT_ENABLED === true ||
    env.CAPACITY_WAIT_ENABLED === "true" ||
    env.CAPACITY_WAIT_ENABLED === 1;
  const waitSeconds =
    typeof env.CAPACITY_WAIT_SECONDS === "number" && Number.isFinite(env.CAPACITY_WAIT_SECONDS)
      ? Math.min(600, Math.max(5, Math.floor(env.CAPACITY_WAIT_SECONDS)))
      : 60;
  return { enabled, waitSeconds, heartbeatMs: 10_000, retryBaseMs: 1_000 };
}

export type CapacityWaitStatus = "waiting" | "cancelled" | "expired" | "admitted";

/**
 * What is waiting. `create` = a fresh launch with no workspace yet (host
 * cleanup by operation key applies). `wake` = an existing workspace is
 * being started in place: ending the wait ends the WAITING only — it never
 * touches the host workspace, never stops active work, and never cancels a
 * host operation (the stored operation key is a waiter-identity marker).
 */
export type CapacityWaitKind = "create" | "wake";

export interface CapacityWaitRow {
  pod_id: string;
  org_id: string;
  user_id: string;
  operation_key: string;
  /** create|wake (pre-058 rows read as create). */
  kind: CapacityWaitKind;
  /**
   * Wake rollback intent, e.g. `{ fromState: "stopped" }`: where an
   * orphaned wake wait's stuck quota claim returns to. Create rows: null.
   */
  intent: { fromState?: unknown } | null;
  status: CapacityWaitStatus;
  reason: string | null;
  detail: Record<string, unknown> | null;
  attempts: number;
  last_attempt_at: string | null;
  last_host_url: string | null;
  last_host_id: string | null;
  heartbeat_at: string;
  deadline_at: string;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

/** Client-visible wait state (published in capacity-contract.md for the client lead). */
export interface CapacityWaitView {
  kind: CapacityWaitKind;
  state: "waiting" | "cancelled" | "expired" | "admitted";
  reason: string | null;
  detail: Record<string, unknown> | null;
  attempts: number;
  /** ms until the final deadline (0 once passed); clients show progress against this. */
  deadlineInMs: number;
  cancelRequested: boolean;
  /** Validated numeric display fields (additive, §6.3): from `detail`, finite ≥0 only. */
  required?: number;
  available?: number;
  unit?: string;
  /** ISO timestamp of the final deadline (additive: clients render countdowns off it). */
  deadlineAt: string;
  /** Seconds waited once terminal (expired/cancelled/admitted); null while waiting. */
  waitedSeconds: number | null;
}

/** Reasons a wait row may name (native admission enum + server-side placement verdicts). */
const WAIT_REASONS = new Set([
  // `fleet_unavailable` is recorded, never waited on: a mid-wait fleet
  // outage is evidence, and an expiry that lands while the fleet is
  // unreachable must say so instead of falling back to `fleet_capacity`.
  "fleet_unavailable",
  "memory_capacity",
  "cpu_capacity",
  "disk_capacity",
  "transition_capacity",
  "network_capacity",
  "memory_debt",
  "fairness_degraded",
  "fleet_capacity",
  "unsupported_shape",
  "unsupported_admission",
  "legacy_contract",
  "malformed_capacity",
  "host_mismatch",
]);

const WAIT_UNITS = new Set(["bytes", "cores", "count", "gb"]);

const WAIT_RESOURCES = new Set(["memory", "cpu", "disk", "network", "transitions", "shape", "fairness"]);

function finiteNonNegativeOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Validated display projection of a wait row (§6.3): validated enums and
 * finite non-negative numbers only — never raw provider text. Anything
 * unrecognized is dropped (undefined), never passed through.
 */
export function capacityWaitDisplay(row: Pick<CapacityWaitRow, "reason" | "detail">): {
  reason: string | null;
  required?: number;
  available?: number;
  unit?: string;
} {
  const reason = typeof row.reason === "string" && WAIT_REASONS.has(row.reason) ? row.reason : null;
  const detail = row.detail !== null && typeof row.detail === "object" ? row.detail : null;
  const out: { reason: string | null; required?: number; available?: number; unit?: string } = { reason };
  if (detail) {
    const required = finiteNonNegativeOrUndefined(detail["required"]);
    const available = finiteNonNegativeOrUndefined(detail["available"]);
    const unit = detail["unit"];
    if (required !== undefined) out.required = required;
    if (available !== undefined) out.available = available;
    if (typeof unit === "string" && WAIT_UNITS.has(unit)) out.unit = unit;
  }
  return out;
}

/**
 * Terminal refusal for an expired wait (2026-09-07: the expiry terminal
 * reported the enqueue-time reason while the loop's later attempts refused
 * otherwise — operators chased a stale `fairness_degraded` for 35 minutes
 * while the wait row said `disk_capacity`).
 *
 * Both wait loops keep the row current via `recordWaitAttempt`, so once any
 * attempt was recorded the row's reason/detail IS the last refusal — use it.
 * Zero attempts means no re-probe ever recorded: keep the enqueue
 * reason/detail, the only evidence there is.
 */
export function expiredWaitTerminal(args: {
  enqueueReason: string | null;
  enqueueDetail: Record<string, unknown> | null;
  row: Pick<CapacityWaitRow, "reason" | "detail" | "attempts">;
}): { reason: string | null; detail: Record<string, unknown> | null } {
  if (args.row.attempts > 0) return { reason: args.row.reason, detail: args.row.detail };
  return { reason: args.enqueueReason, detail: args.enqueueDetail };
}

/**
 * Launch phase override for a pod with a live capacity wait: clients render
 * `waiting-for-capacity` (with the wait view's reason/required/available/
 * unit/deadlineAt) instead of the generic `provisioning-sandbox`. Null when
 * the pod is not currently waiting, so every other phase is untouched.
 */
/** A validated resource shape: finite non-negative numbers only, no host text. */
function validatedWaitShape(value: unknown, partial: boolean): Record<string, number> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["cpu", "memoryGB", "diskGB"]) {
    const field = record[key];
    if (field === undefined) {
      if (!partial) return undefined;
      continue;
    }
    const numeric = finiteNonNegativeOrUndefined(field);
    if (numeric === undefined) return undefined;
    out[key] = numeric;
  }
  return out;
}

/**
 * Validated client projection of a wait row's admission detail (§6.3):
 * allowlisted kind/reason/resource/unit, a required boolean retryable, and
 * finite non-negative numbers only. Returns a fresh copy, never the input —
 * and null for anything unrecognized, so raw provider text can never reach
 * the wire through the view (unknown → omit, never echo).
 */
export function capacityWaitDetailView(detail: unknown): Record<string, unknown> | null {
  if (detail === null || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  if (record["kind"] !== "admission") return null;
  const reason = record["reason"];
  if (typeof reason !== "string" || !WAIT_REASONS.has(reason)) return null;
  const resource = record["resource"];
  if (typeof resource !== "string" || !WAIT_RESOURCES.has(resource)) return null;
  const unit = record["unit"];
  if (typeof unit !== "string" || !WAIT_UNITS.has(unit)) return null;
  if (typeof record["retryable"] !== "boolean") return null;
  const out: Record<string, unknown> = {
    kind: "admission",
    reason,
    resource,
    unit,
    retryable: record["retryable"],
  };
  for (const key of ["required", "available", "budget", "committed"]) {
    const value = finiteNonNegativeOrUndefined(record[key]);
    if (value !== undefined) out[key] = value;
  }
  const retryAfterMs = finiteNonNegativeOrUndefined(record["retryAfterMs"]);
  // Bounded hint per contract; absent when the condition is not expected to clear.
  if (retryAfterMs !== undefined && retryAfterMs <= 300_000) out["retryAfterMs"] = retryAfterMs;
  // unsupported_shape only: what was asked vs what the host supports (numbers only).
  if (reason === "unsupported_shape") {
    const requested = validatedWaitShape(record["requested"], true);
    const maximum = validatedWaitShape(record["maximum"], false);
    if (requested !== undefined) out["requested"] = requested;
    if (maximum !== undefined) out["maximum"] = maximum;
  }
  return out;
}

export function capacityWaitPhase(
  pod: { state: string; provider_state: string },
  waitRow: Pick<CapacityWaitRow, "status"> | null,
): "waiting-for-capacity" | null {
  if (!waitRow || waitRow.status !== "waiting") return null;
  if (pod.state !== "active") return null;
  if (pod.provider_state !== "preparing_image" && pod.provider_state !== "provisioning") return null;
  return "waiting-for-capacity";
}

export function toWaitView(row: CapacityWaitRow, nowMs: number): CapacityWaitView {
  const display = capacityWaitDisplay(row);
  // Validated projection only: an unknown row reason is null (never the raw
  // text), falling back to the validated detail's own reason when the row
  // text is unrecognized but the detail survived validation.
  const detail = capacityWaitDetailView(row.detail);
  const detailReason =
    detail !== null && typeof detail["reason"] === "string" ? (detail["reason"] as string) : null;
  const terminal = row.status !== "waiting";
  return {
    kind: row.kind ?? "create",
    state: row.status,
    reason: display.reason ?? detailReason,
    detail,
    attempts: row.attempts,
    deadlineInMs: Math.max(0, Date.parse(row.deadline_at) - nowMs),
    cancelRequested: row.cancel_requested,
    ...(display.required !== undefined ? { required: display.required } : {}),
    ...(display.available !== undefined ? { available: display.available } : {}),
    ...(display.unit !== undefined ? { unit: display.unit } : {}),
    deadlineAt: new Date(row.deadline_at).toISOString(),
    waitedSeconds: terminal
      ? Math.max(0, Math.round((Date.parse(row.updated_at) - Date.parse(row.created_at)) / 1000))
      : null,
  };
}

function rowOf(value: unknown): CapacityWaitRow {
  return value as CapacityWaitRow;
}

/**
 * Enqueue a pod for bounded waiting. No per-user cap: waiting pods hold
 * their foundation quota slot (provisioning counts), so the atomic 20-slot
 * user quota IS the bound — a separate waiter cap would be a new,
 * undocumented entitlement restriction. Cross-user fairness comes from
 * round-robin attempt claims (tryClaimAttempt), not from queue admission.
 */
/** Waiter-identity marker for wake waits (never a host operation key). */
export function wakeWaitOperationKey(podId: string): string {
  return `wake:${podId}`;
}

export async function enqueueCapacityWait(
  client: WaitStore,
  args: {
    podId: string;
    orgId: string;
    userId: string;
    operationKey: string;
    lastHostId?: string | null;
    reason: string | null;
    detail: Record<string, unknown> | null;
    waitSeconds: number;
    now?: Date;
    /** create (default) or wake; wake rows carry rollback intent. */
    kind?: CapacityWaitKind;
    /** Wake only: `{ fromState: "stopped" | "archived" }`. */
    intent?: Record<string, unknown> | null;
  },
): Promise<CapacityWaitRow> {
  const now = args.now ?? new Date();
  const deadline = new Date(now.getTime() + args.waitSeconds * 1000);
  const result = await client.query(
    `INSERT INTO pod_capacity_wait
       (pod_id, org_id, user_id, operation_key, kind, intent, status, reason, detail, deadline_at, last_host_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'waiting', $7, $8::jsonb, $9, $10)
     ON CONFLICT (pod_id) DO UPDATE
       SET status = 'waiting', kind = EXCLUDED.kind, intent = EXCLUDED.intent, operation_key=EXCLUDED.operation_key,
           last_host_id = EXCLUDED.last_host_id,
           last_host_url = CASE WHEN EXCLUDED.kind='wake' THEN NULL
             WHEN pod_capacity_wait.last_host_id IS NOT DISTINCT FROM EXCLUDED.last_host_id
             THEN pod_capacity_wait.last_host_url ELSE NULL END,
           reason = EXCLUDED.reason, detail = EXCLUDED.detail,
           deadline_at = EXCLUDED.deadline_at, cancel_requested = false,
           heartbeat_at = now(), updated_at = now()
     RETURNING *`,
    [
      args.podId,
      args.orgId,
      args.userId,
      args.operationKey,
      args.kind ?? "create",
      args.intent === undefined || args.intent === null ? null : JSON.stringify(args.intent),
      args.reason,
      args.detail === null ? null : JSON.stringify(args.detail),
      deadline.toISOString(),
      args.kind === "wake" ? null : args.lastHostId ?? null,
    ],
  );
  const row = result.rows.length > 0 ? rowOf(result.rows[0]) : null;
  if (!row) throw new Error("capacity wait enqueue returned no row");
  return row;
}

/**
 * Cross-user round-robin attempt claim (parent review 2026-09-06).
 *
 * Independent per-pod retry loops would let one user's burst win every
 * capacity race (more pollers, more wins). Before each attempt a waiter
 * claims its turn: allowed iff its attempt count is at most the minimum
 * over OTHER users' waiting pods — i.e. every user advances roughly one
 * attempt per round and no user laps another. A lone waiter (no other users
 * queued) always holds its turn. Returns the row when claimed, null when
 * this pod must sit this round out (sleep and retry; the deadline still
 * bounds the total wait).
 *
 * Approximate under concurrency (two claimants can read the same minimum),
 * exact in the common sequential case; starvation-free either way because
 * attempts only ever increase the claimant's own count toward the next
 * round's minimum.
 */
export async function tryClaimAttempt(
  client: WaitStore,
  podId: string,
): Promise<CapacityWaitRow | null> {
  const result = await client.query(
    `UPDATE pod_capacity_wait w
        SET last_attempt_at = now(), heartbeat_at = now(), updated_at = now()
      WHERE w.pod_id = $1 AND w.status = 'waiting' AND w.cancel_requested = false
        AND (
          NOT EXISTS (
            SELECT 1 FROM pod_capacity_wait
             WHERE status = 'waiting' AND user_id <> w.user_id
          )
          OR w.attempts <= (
            SELECT MIN(attempts) FROM pod_capacity_wait
             WHERE status = 'waiting' AND user_id <> w.user_id
          )
        )
      RETURNING *`,
    [podId],
  );
  return result.rows.length > 0 ? rowOf(result.rows[0]) : null;
}

export async function getCapacityWait(
  client: WaitStore,
  podId: string,
): Promise<CapacityWaitRow | null> {
  const result = await client.query(`SELECT * FROM pod_capacity_wait WHERE pod_id = $1`, [podId]);
  return result.rows.length > 0 ? rowOf(result.rows[0]) : null;
}

/** Heartbeat: keeps ownership; returns the row, or null when it must stop waiting. */
export async function heartbeatCapacityWait(
  client: WaitStore,
  podId: string,
  args: { lastHostId?: string | null } = {},
): Promise<CapacityWaitRow | null> {
  const result = await client.query(
    `UPDATE pod_capacity_wait
        SET heartbeat_at = now(), updated_at = now(), last_host_id = CASE WHEN kind='wake' THEN NULL ELSE COALESCE(last_host_id, $2) END
      WHERE pod_id = $1 AND status = 'waiting' AND cancel_requested = false
      RETURNING *`,
    [podId, args.lastHostId ?? null],
  );
  return result.rows.length > 0 ? rowOf(result.rows[0]) : null;
}

/** Replace only at an actual new create attempt, after earlier attempts proved safe.
 * Heartbeats preserve this tuple; it is the most recent outstanding operation,
 * not the first host ever tried by this launch. Wake waiters never acquire one.
 */
export async function noteWaitAttemptHost(client: WaitStore, podId: string, url: string, lastHostId?: string | null): Promise<void> {
  await client.query(
    `UPDATE pod_capacity_wait SET last_host_url = $2, last_host_id = $3, heartbeat_at = now(), updated_at = now()
      WHERE pod_id = $1 AND status = 'waiting' AND kind = 'create'`,
    [podId, url, lastHostId ?? null],
  );
}

export async function recordWaitAttempt(
  client: WaitStore,
  podId: string,
  args: { reason: string | null; detail: Record<string, unknown> | null },
): Promise<CapacityWaitRow | null> {
  const result = await client.query(
    `UPDATE pod_capacity_wait
        SET attempts = attempts + 1, last_attempt_at = now(),
            reason = $2, detail = $3::jsonb, heartbeat_at = now(), updated_at = now()
      WHERE pod_id = $1 AND status = 'waiting'
      RETURNING *`,
    [podId, args.reason, args.detail === null ? null : JSON.stringify(args.detail)],
  );
  return result.rows.length > 0 ? rowOf(result.rows[0]) : null;
}

export async function finishCapacityWait(
  client: WaitStore,
  podId: string,
  status: "cancelled" | "expired" | "admitted",
): Promise<CapacityWaitRow | null> {
  const result = await client.query(
    `UPDATE pod_capacity_wait
        SET status = $2, heartbeat_at = now(), updated_at = now()
      WHERE pod_id = $1 AND status = 'waiting'
      RETURNING *`,
    [podId, status],
  );
  return result.rows.length > 0 ? rowOf(result.rows[0]) : null;
}

/**
 * Synchronously end a wait as cancelled (launch cancel path: pod DELETE,
 * archive, explicit wait cancel). Exactly-once: only the caller whose UPDATE
 * actually transitions the row observes the `cancelled` metric outcome, so a
 * concurrent waiter loop or sweep never double-counts. The in-flight waiter
 * (if any) sees the terminal row on its next heartbeat and runs host
 * cleanup by key, exactly as with the cooperative flag.
 */
export async function cancelCapacityWait(
  client: WaitStore,
  podId: string,
): Promise<CapacityWaitRow | null> {
  const row = await finishCapacityWait(client, podId, "cancelled");
  if (row) observeCapacityWait("cancelled");
  return row;
}

/**
 * Guarded final-deadline transition shared by the create and wake expiry
 * branches: only the caller whose UPDATE actually moves the row out of
 * `waiting` observes `expired`. A null return means a synchronous cancel
 * (or the sweep) already recorded and counted the terminal outcome — the
 * caller must end as cancelled, never throw the expired terminal over it.
 */
export async function finishWaitExpired(
  client: WaitStore,
  podId: string,
): Promise<CapacityWaitRow | null> {
  const row = await finishCapacityWait(client, podId, "expired");
  if (row) observeCapacityWait("expired");
  return row;
}

/**
 * Orphan claim for the sweep: transitions a still-waiting row to expired
 * and counts `orphaned` — exactly once. Returns null when another path
 * (waiter admit/cancel, synchronous cancel, a prior sweep tick) already
 * decided the outcome; callers must then do nothing further (no rollback,
 * no failure record, no second count).
 */
export async function claimOrphanedWait(
  client: WaitStore,
  podId: string,
  orphanGraceMs?: number,
): Promise<CapacityWaitRow | null> {
  const result = orphanGraceMs === undefined ? null : await client.query(
    `UPDATE pod_capacity_wait SET status='expired',heartbeat_at=now(),updated_at=now()
      WHERE pod_id=$1 AND status='waiting' AND heartbeat_at < now()-($2::double precision * interval '1 millisecond') RETURNING *`,
    [podId,orphanGraceMs]);
  const row = result ? result.rows[0] as CapacityWaitRow | undefined : await finishCapacityWait(client, podId, "expired");
  if (row) observeCapacityWait("orphaned");
  return row ?? null;
}

export async function requestWaitCancel(client: WaitStore, podId: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE pod_capacity_wait
        SET cancel_requested = true, updated_at = now()
      WHERE pod_id = $1 AND status = 'waiting'`,
    [podId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Oldest-first waiting pods: the fair drain order for a capacity-change wakeup. */
export async function listWaitingPods(
  client: WaitStore,
  limit: number,
): Promise<CapacityWaitRow[]> {
  const result = await client.query(
    `SELECT * FROM pod_capacity_wait WHERE status = 'waiting' ORDER BY created_at ASC LIMIT $1`,
    [limit],
  );
  return result.rows.map(rowOf);
}

/**
 * Expire waits past their deadline (reaper/worker path). Terminal rows are kept
 * for operator visibility; `pruneFinishedWaits` removes them after an hour.
 */
export async function expireDueWaits(client: WaitStore): Promise<CapacityWaitRow[]> {
  const result = await client.query(
    `UPDATE pod_capacity_wait
        SET status = 'expired', updated_at = now()
      WHERE status = 'waiting' AND deadline_at <= now()
      RETURNING *`,
  );
  return result.rows.map(rowOf);
}

/**
 * Server-restart recovery: waits whose heartbeat died with the old process but
 * whose deadline has not passed are still valid — the caller re-drives them.
 * Waits past deadline expire. Returns both sets; the caller fails expired pods
 * with a typed capacity result and resumes the live ones.
 */
export async function recoverWaitsAfterRestart(
  client: WaitStore,
  heartbeatGraceMs: number,
): Promise<{ live: CapacityWaitRow[]; expired: CapacityWaitRow[] }> {
  const live = await client.query(
    `SELECT * FROM pod_capacity_wait
      WHERE status = 'waiting'
        AND deadline_at > now()
        AND heartbeat_at > now() - make_interval(secs => $1)
      ORDER BY created_at ASC`,
    [heartbeatGraceMs / 1000],
  );
  const expired = await client.query(
    `UPDATE pod_capacity_wait SET status = 'expired', updated_at = now()
      WHERE status = 'waiting' AND deadline_at <= now()
      RETURNING *`,
  );
  return { live: live.rows.map(rowOf), expired: expired.rows.map(rowOf) };
}

/** Waits abandoned mid-flight (heartbeat dead, deadline future): fail closed, do not adopt. */
export async function findOrphanedWaits(
  client: WaitStore,
  heartbeatGraceMs: number,
): Promise<CapacityWaitRow[]> {
  const result = await client.query(
    `SELECT * FROM pod_capacity_wait
      WHERE status = 'waiting'
        AND deadline_at > now()
        AND heartbeat_at <= now() - make_interval(secs => $1)
      ORDER BY created_at ASC`,
    [heartbeatGraceMs / 1000],
  );
  return result.rows.map(rowOf);
}

export async function pruneFinishedWaits(client: WaitStore): Promise<number> {
  const result = await client.query(
    `DELETE FROM pod_capacity_wait
      WHERE status <> 'waiting' AND updated_at < now() - make_interval(hours => 1)`,
  );
  return result.rowCount ?? 0;
}

/**
 * Classify a wake/start failure for bounded waiting (structural: no provider
 * imports, so classification and the lifecycle path share it).
 *
 * Eligible (returns the detail to record): a typed admission refusal with
 * `retryable !== false` — `fairness_degraded` included — or a legacy
 * untyped 507 (pressure by long-standing convention; recorded as generic
 * `fleet_capacity`). Everything else (shapes, auth, quota, conflicts,
 * timeouts/ambiguity, success-shaped errors) returns null: waiting cannot
 * change it, and an ambiguous start must never be retried blind — the
 * attempt's own rollback already restored the claim, and reconciliation
 * (not the waiter) owns the uncertainty.
 *
 * The returned detail is sanitized (validated enums/numbers only): wait rows
 * are client-visible, so host-controlled fields must never pass through raw.
 */
export function wakeWaitRefusal(error: unknown): Record<string, unknown> | null {
  const record = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const details: unknown[] = [];
  if (record) {
    const direct = record["details"];
    if (direct !== undefined) details.push(direct);
    const cause = record["cause"];
    if (cause !== null && typeof cause === "object") {
      const inner = (cause as Record<string, unknown>)["details"];
      if (inner !== undefined) details.push(inner);
      const innerDetail = (cause as Record<string, unknown>)["detail"];
      if (innerDetail !== undefined) details.push(innerDetail);
    }
    const ownDetail = record["detail"];
    if (ownDetail !== undefined) details.push(ownDetail);
  }
  for (const detail of details) {
    const sanitized = sanitizeErrorDetails({ details: detail });
    if (sanitized !== undefined && sanitized["kind"] === "admission") {
      if (sanitized["retryable"] === false) return null;
      return sanitized;
    }
  }
  if (typeof record?.["status"] === "number" && record["status"] === 507) {
    return { kind: "admission", reason: "fleet_capacity", resource: "transitions", unit: "count", retryable: true };
  }
  const statusCode = record?.["statusCode"];
  if (typeof statusCode === "number" && statusCode === 507) {
    return { kind: "admission", reason: "fleet_capacity", resource: "transitions", unit: "count", retryable: true };
  }
  return null;
}

/**
 * Fairness enablement dependency check (parent directive: the allocator must
 * not run without the convergence paths its grants depend on).
 *
 * A managed host refuses grantless tenants with retryable `fairness_degraded`;
 * without the bounded-wait subsystem that refusal is a permanent visible
 * failure for every new owner (create bootstrap) and every cold wake after a
 * grant TTL lapse (wake bootstrap) — the allocator would manufacture the
 * pressure it cannot drain. Both create-waits and wake-waits ride the same
 * `CAPACITY_WAIT_ENABLED` subsystem, so one flag covers both.
 */
export function fairnessWaitDepsOk(env: {
  CAPACITY_WAIT_ENABLED?: unknown;
}): { ok: true } | { ok: false; reason: string } {
  if (capacityWaitConfig(env).enabled) return { ok: true };
  return {
    ok: false,
    reason:
      "CPU_FAIRNESS_ENABLED requires CAPACITY_WAIT_ENABLED=true: " +
      "grant-managed hosts refuse grantless tenants (fairness_degraded) and only bounded waits converge first-create and cold-wake bootstrap without manual retries",
  };
}

/** Jittered backoff before the next attempt, bounded by the remaining deadline. */
export function waitBackoffMs(args: {
  attempts: number;
  baseMs: number;
  deadlineInMs: number;
  random?: () => number;
}): number {
  const random = args.random ?? Math.random;
  const exponential = args.baseMs * 2 ** Math.min(args.attempts, 5);
  const jittered = exponential * (0.5 + random());
  return Math.max(0, Math.min(jittered, args.deadlineInMs));
}

/**
 * Inter-attempt delay for a capacity wait (§6.6, §7.3 bootstrap).
 *
 * A host refusal may carry a bounded `retryAfterMs` hint (already
 * sanitizer-capped at 300s): honor it as the re-probe interval (jittered)
 * instead of the exponential backoff — the host named when to come back
 * (a fairness bootstrap grant lands on the allocator tick, so re-probing
 * sooner only burns placement probes against a verdict that cannot have
 * changed). Without a usable hint, the existing exponential backoff
 * applies. Never negative, never past the remaining deadline.
 */
export function waitReprobeDelayMs(args: {
  attempts: number;
  baseMs: number;
  retryAfterMs?: number;
  deadlineInMs: number;
  random?: () => number;
}): number {
  const random = args.random ?? Math.random;
  const hint = args.retryAfterMs;
  if (typeof hint === "number" && Number.isFinite(hint) && hint > 0) {
    const jittered = Math.min(hint, args.deadlineInMs) * (0.5 + random());
    return Math.max(0, Math.min(jittered, args.deadlineInMs));
  }
  return waitBackoffMs({
    attempts: args.attempts,
    baseMs: args.baseMs,
    deadlineInMs: args.deadlineInMs,
    random,
  });
}

// Convenience wrappers against the shared pool for routes/workers (no tx).
export const poolCapacityWait = {
  get: (podId: string) => getCapacityWait({ query: (t: string, p?: unknown[]) => query(t, p) }, podId),
  cancel: (podId: string) =>
    requestWaitCancel({ query: (t: string, p?: unknown[]) => query(t, p) }, podId),
  expireDue: () => expireDueWaits({ query: (t: string, p?: unknown[]) => query(t, p) }),
  prune: () => pruneFinishedWaits({ query: (t: string, p?: unknown[]) => query(t, p) }),
};
