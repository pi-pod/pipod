/**
 * Purge transcript rows when a pod is deleted.
 *
 *   PI_POD_TEST_DATABASE_URL=postgres://pipod:pipod@localhost:55432/pipod npm run test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { purgePodSessionData } from "../src/server/pods/session-data.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("pod session purge (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const parentId = uuidv7();
  const childId = uuidv7();
  const otherId = uuidv7();

  async function makePod(id: string, parent?: string): Promise<void> {
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config,
                         parent_pod_id, lineage_root_id, lineage_depth)
       VALUES ($1, $2, $3, 'purge', 'sandbox', 'active', 'stopped', '{}'::jsonb, $4, $5, $6)`,
      [id, orgId, userId, parent ?? null, parent ?? id, parent ? 1 : 0],
    );
  }

  async function seedPod(podId: string): Promise<{ sessionId: string; interactionId: string; promptId: string }> {
    const sessionId = uuidv7();
    const interactionId = uuidv7();
    const promptId = uuidv7();
    await query(
      `INSERT INTO sessions (id, pod_id, user_id, started_at, ended_at, end_reason)
       VALUES ($1, $2, $3, now(), now(), 'idle_stop')`,
      [sessionId, podId, userId],
    );
    await query(
      `INSERT INTO session_events (session_id, seq, kind, payload)
       VALUES ($1, 1, 'user_prompt', '{"text":"secret"}')`,
      [sessionId],
    );
    await query(
      `INSERT INTO pending_interactions (id, session_id, seq, kind, payload)
       VALUES ($1, $2, 1, 'tool_approval', '{}'::jsonb)`,
      [interactionId, sessionId],
    );
    await query(
      `INSERT INTO queued_prompts (id, pod_id, user_id, text, status)
       VALUES ($1, $2, $3, 'queued', 'delivered')`,
      [promptId, podId, userId],
    );
    return { sessionId, interactionId, promptId };
  }

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'purge test')", [
      orgId,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@example.test`,
    ]);
    await makePod(parentId);
    await makePod(childId, parentId);
    await makePod(otherId);
  });

  after(async () => {
    for (const podId of [parentId, childId, otherId]) {
      await query("DELETE FROM pending_interactions WHERE session_id IN (SELECT id FROM sessions WHERE pod_id = $1)", [
        podId,
      ]);
      await query("DELETE FROM session_events WHERE session_id IN (SELECT id FROM sessions WHERE pod_id = $1)", [podId]);
      await query("DELETE FROM queued_prompts WHERE pod_id = $1", [podId]);
      await query("DELETE FROM sessions WHERE pod_id = $1", [podId]);
    }
    await query("DELETE FROM pods WHERE id = ANY($1)", [[parentId, childId, otherId]]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("removes only the deleted pod's sessions, events, interactions, and queued prompts", async () => {
    const target = await seedPod(parentId);
    const kept = await seedPod(otherId);

    await purgePodSessionData(parentId);

    const gone = await query(
      `SELECT
         (SELECT count(*) FROM sessions WHERE id = $1) AS sessions,
         (SELECT count(*) FROM session_events WHERE session_id = $1) AS events,
         (SELECT count(*) FROM pending_interactions WHERE id = $2) AS interactions,
         (SELECT count(*) FROM queued_prompts WHERE id = $3) AS prompts`,
      [target.sessionId, target.interactionId, target.promptId],
    );
    assert.deepEqual(gone.rows[0], { sessions: "0", events: "0", interactions: "0", prompts: "0" });

    const still = await query(
      `SELECT
         (SELECT count(*) FROM sessions WHERE id = $1) AS sessions,
         (SELECT count(*) FROM session_events WHERE session_id = $1) AS events,
         (SELECT count(*) FROM pending_interactions WHERE id = $2) AS interactions,
         (SELECT count(*) FROM queued_prompts WHERE id = $3) AS prompts`,
      [kept.sessionId, kept.interactionId, kept.promptId],
    );
    assert.deepEqual(still.rows[0], { sessions: "1", events: "1", interactions: "1", prompts: "1" });

    const tombstone = await query("SELECT id FROM pods WHERE id = $1", [parentId]);
    assert.equal(tombstone.rows[0]?.id, parentId);
  });

  it("purges each cascaded child independently", async () => {
    const parent = await seedPod(parentId);
    const child = await seedPod(childId);
    const other = await seedPod(otherId);

    await purgePodSessionData(childId);
    await purgePodSessionData(parentId);

    const remaining = await query<{ kind: string; n: string }>(
      `SELECT 'sessions' AS kind, count(*)::text AS n FROM sessions WHERE id = ANY($1)
       UNION ALL
       SELECT 'events', count(*)::text FROM session_events WHERE session_id = ANY($1)
       UNION ALL
       SELECT 'interactions', count(*)::text FROM pending_interactions WHERE id = ANY($2)
       UNION ALL
       SELECT 'prompts', count(*)::text FROM queued_prompts WHERE id = ANY($3)`,
      [
        [parent.sessionId, child.sessionId, other.sessionId],
        [parent.interactionId, child.interactionId, other.interactionId],
        [parent.promptId, child.promptId, other.promptId],
      ],
    );
    const counts = Object.fromEntries(remaining.rows.map((row) => [row.kind, Number(row.n)]));
    assert.deepEqual(counts, { sessions: 1, events: 1, interactions: 1, prompts: 1 });

    const otherLeft = await query("SELECT id FROM sessions WHERE id = $1", [other.sessionId]);
    assert.equal(otherLeft.rows[0]?.id, other.sessionId);
  });
});
