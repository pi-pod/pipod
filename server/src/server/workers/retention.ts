import { query } from "../db/index.js";
import { expireForkSeeds } from "../pods/fork-seed.js";
import type { WorkerDeps } from "./index.js";

/** Rows per statement when trimming to the ceiling. One 2.7M-row DELETE is a single transaction
 * and a matching WAL burst — on a volume that just ran out of space, the cure repeats the cause. */
const TRIM_BATCH = 50_000;

const QUEUED_PROMPT_RETENTION = "30 days";

/** Event-log retention (spec §12): expire session_events past the window, then adjacent tables. */
export async function runRetention(deps: WorkerDeps): Promise<void> {
  const days = deps.env.EVENT_RETENTION_DAYS;
  const events = await query(
    `DELETE FROM session_events WHERE created_at < now() - make_interval(days => $1)`,
    [days],
  );
  if ((events.rowCount ?? 0) > 0) {
    await updateSessionTruncationWatermarks();
    deps.log.info(`retention expired ${events.rowCount} session events`);
  }

  await expireAdjacentTables(days, deps);

  const seeds = await expireForkSeeds();
  if (seeds.consumed + seeds.orphaned > 0) {
    deps.log.info(
      `retention expired ${seeds.consumed} consumed fork seeds, ${seeds.orphaned} orphaned fork seeds`,
    );
  }

  await query(`DELETE FROM ws_tickets WHERE expires_at < now() - interval '1 day'`);
  await query(
    `DELETE FROM push_queue WHERE (delivered_at IS NOT NULL OR failed_at IS NOT NULL)
       AND created_at < now() - interval '7 days'`,
  );
  await query(`DELETE FROM job_runs WHERE started_at < now() - interval '90 days'`);

  await trimToCeiling(deps);
}

async function expireAdjacentTables(days: number, deps: WorkerDeps): Promise<void> {
  const prompts = await query(
    `DELETE FROM queued_prompts
      WHERE status IN ('delivered', 'failed', 'unknown')
        AND created_at < now() - $1::interval`,
    [QUEUED_PROMPT_RETENTION],
  );
  // Session metadata only after its content is gone (FK order).
  const sessions = await query(
    `DELETE FROM sessions s
      WHERE s.ended_at < now() - make_interval(days => $1)
        AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.session_id = s.id)`,
    [days],
  );
  const dropped = (prompts.rowCount ?? 0) + (sessions.rowCount ?? 0);
  if (dropped > 0) {
    deps.log.info(
      `retention expired ${prompts.rowCount ?? 0} queued prompts, ${sessions.rowCount ?? 0} session rows`,
    );
  }
}

/** Record the first surviving seq for any session whose prefix was deleted. */
export async function updateSessionTruncationWatermarks(): Promise<void> {
  await query(
    `UPDATE sessions s
        SET events_truncated_below_seq = surviving.min_seq
       FROM (
         SELECT session_id, MIN(seq) AS min_seq
           FROM session_events
          GROUP BY session_id
       ) surviving
      WHERE s.id = surviving.session_id
        AND surviving.min_seq > COALESCE(s.events_truncated_below_seq, 1)`,
  );
}

/** Enforce EVENT_MAX_ROWS by dropping whole ended sessions first, then a prefix of one giant log. */
export async function trimToCeiling(deps: WorkerDeps): Promise<void> {
  const ceiling = deps.env.EVENT_MAX_ROWS;
  const counted = await query<{ count: string }>(`SELECT count(*)::bigint AS count FROM session_events`);
  const total = Number(counted.rows[0]?.count ?? 0);
  let excess = total - ceiling;
  if (excess <= 0) return;

  deps.log.warn(`retention: session_events at ${total} rows, over the ${ceiling} ceiling by ${excess}`);
  let trimmed = 0;

  while (excess > 0) {
    const oldest = await query<{ id: string }>(
      `SELECT s.id
         FROM sessions s
         JOIN session_events e ON e.session_id = s.id
        WHERE s.ended_at IS NOT NULL
        GROUP BY s.id, s.started_at
        ORDER BY s.started_at
        LIMIT 1`,
    );
    const sessionId = oldest.rows[0]?.id;
    if (!sessionId) break;
    const removed = await deleteSessionEvents(sessionId);
    if (removed === 0) break;
    trimmed += removed;
    excess -= removed;
  }

  while (excess > 0) {
    const giant = await query<{ id: string; n: string }>(
      `SELECT s.id, COUNT(e.*)::bigint AS n
         FROM sessions s
         JOIN session_events e ON e.session_id = s.id
        GROUP BY s.id, s.started_at
       HAVING COUNT(e.*) >= $1
        ORDER BY s.started_at
        LIMIT 1`,
      [excess],
    );
    const row = giant.rows[0];
    if (!row) break;
    const take = Math.min(excess, TRIM_BATCH);
    const removed = await deleteOldestSessionEvents(row.id, take);
    if (removed === 0) break;
    await stampTruncationWatermark(row.id);
    trimmed += removed;
    excess -= removed;
  }

  deps.log.warn(`retention: trimmed ${trimmed} session events to hold the row ceiling`);
}

async function deleteSessionEvents(sessionId: string): Promise<number> {
  let removed = 0;
  for (;;) {
    const batch = await query(
      `DELETE FROM session_events WHERE ctid IN (
         SELECT ctid FROM session_events WHERE session_id = $1 LIMIT $2
       )`,
      [sessionId, TRIM_BATCH],
    );
    const n = batch.rowCount ?? 0;
    if (n === 0) break;
    removed += n;
  }
  return removed;
}

async function deleteOldestSessionEvents(sessionId: string, limit: number): Promise<number> {
  const batch = await query(
    `DELETE FROM session_events WHERE ctid IN (
       SELECT ctid FROM session_events WHERE session_id = $1 ORDER BY seq LIMIT $2
     )`,
    [sessionId, limit],
  );
  return batch.rowCount ?? 0;
}

async function stampTruncationWatermark(sessionId: string): Promise<void> {
  const surviving = await query<{ min_seq: string }>(
    `SELECT MIN(seq)::bigint AS min_seq FROM session_events WHERE session_id = $1`,
    [sessionId],
  );
  const minSeq = surviving.rows[0]?.min_seq;
  if (minSeq == null) return;
  await query(
    `UPDATE sessions
        SET events_truncated_below_seq = $2
      WHERE id = $1
        AND (events_truncated_below_seq IS NULL OR events_truncated_below_seq < $2)`,
    [sessionId, minSeq],
  );
}
