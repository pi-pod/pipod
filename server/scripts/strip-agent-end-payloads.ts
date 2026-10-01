/**
 * One-time batched cleanup: strip bulk fields from persisted session_events.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/strip-agent-end-payloads.ts
 *
 * Optional env: BATCH (default 10000), SLEEP_MS (default 0). Safe to rerun.
 * Follow with autovacuum or a VACUUM window to reclaim the table.
 */
import { closePool, initPool, query } from "../src/server/db/index.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const batch = Math.max(1, Number(process.env["BATCH"] ?? 10_000));
const sleepMs = Math.max(0, Number(process.env["SLEEP_MS"] ?? 0));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain(
  label: string,
  sql: string,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await query(sql, [batch]);
    const n = result.rowCount ?? 0;
    total += n;
    console.log(`${label}: stripped ${n} rows (total ${total})`);
    if (n === 0) return total;
    if (sleepMs > 0) await sleep(sleepMs);
  }
}

initPool(databaseUrl);
try {
  const agentEnd = await drain(
    "agent_end",
    `WITH doomed AS (
       SELECT session_id, seq
         FROM session_events
        WHERE kind = 'agent_end' AND payload ? 'messages'
        ORDER BY session_id, seq
        LIMIT $1
     )
     UPDATE session_events e
        SET payload = jsonb_build_object('willRetry', e.payload->'willRetry')
       FROM doomed
      WHERE e.session_id = doomed.session_id AND e.seq = doomed.seq`,
  );
  const emptied = await drain(
    "turn_end/entry_appended",
    `WITH doomed AS (
       SELECT session_id, seq
         FROM session_events
        WHERE kind IN ('turn_end', 'entry_appended') AND payload <> '{}'::jsonb
        ORDER BY session_id, seq
        LIMIT $1
     )
     UPDATE session_events e
        SET payload = '{}'::jsonb
       FROM doomed
      WHERE e.session_id = doomed.session_id AND e.seq = doomed.seq`,
  );
  console.log(`done: ${agentEnd} agent_end, ${emptied} turn_end/entry_appended`);
} finally {
  await closePool();
}
