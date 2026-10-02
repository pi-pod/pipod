/**
 * Session event retention: age window, ceiling trim, watermarks, adjacent tables.
 *
 *   PI_POD_TEST_DATABASE_URL=postgres://pipod:pipod@localhost:55432/pipod npm run test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { helloFirstAvailableSeq } from "../src/server/gateway/service.js";
import { runRetention, trimToCeiling } from "../src/server/workers/retention.js";
import type { WorkerDeps } from "../src/server/workers/index.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("session event retention (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podA = uuidv7();
  const podB = uuidv7();

  function deps(overrides: { EVENT_RETENTION_DAYS?: number; EVENT_MAX_ROWS?: number } = {}): WorkerDeps {
    return {
      env: {
        EVENT_RETENTION_DAYS: overrides.EVENT_RETENTION_DAYS ?? 90,
        EVENT_MAX_ROWS: overrides.EVENT_MAX_ROWS ?? 4_000_000,
      } as WorkerDeps["env"],
      kek: {} as WorkerDeps["kek"],
      gateway: null,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
  }

  async function makePod(id: string): Promise<void> {
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'ret', 'sandbox', 'active', 'stopped', '{}'::jsonb)`,
      [id, orgId, userId],
    );
  }

  async function makeSession(args: {
    id: string;
    podId: string;
    startedAt: string;
    endedAt?: string | null;
  }): Promise<void> {
    await query(
      `INSERT INTO sessions (id, pod_id, user_id, started_at, ended_at, end_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [args.id, args.podId, userId, args.startedAt, args.endedAt ?? null, args.endedAt ? "idle_stop" : null],
    );
  }

  async function makeEvent(sessionId: string, seq: number, createdAt: string, kind = "user_prompt"): Promise<void> {
    await query(
      `INSERT INTO session_events (session_id, seq, kind, payload, created_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
      [sessionId, seq, kind, createdAt],
    );
  }

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'retention test')", [
      orgId,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@example.test`,
    ]);
    await makePod(podA);
    await makePod(podB);
  });

  after(async () => {
    await query("DELETE FROM session_events WHERE session_id IN (SELECT id FROM sessions WHERE pod_id = ANY($1))", [
      [podA, podB],
    ]);
    await query("DELETE FROM queued_prompts WHERE pod_id = ANY($1)", [[podA, podB]]);
    await query("DELETE FROM sessions WHERE pod_id = ANY($1)", [[podA, podB]]);
    await query("DELETE FROM pods WHERE id = ANY($1)", [[podA, podB]]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  async function wipe(): Promise<void> {
    await query("DELETE FROM session_events WHERE session_id IN (SELECT id FROM sessions WHERE pod_id = ANY($1))", [
      [podA, podB],
    ]);
    await query("DELETE FROM queued_prompts WHERE pod_id = ANY($1)", [[podA, podB]]);
    await query("DELETE FROM sessions WHERE pod_id = ANY($1)", [[podA, podB]]);
  }

  it("deletes a whole older ended session before touching a newer one", async () => {
    await wipe();
    const older = uuidv7();
    const newer = uuidv7();
    await makeSession({ id: older, podId: podA, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T01:00:00Z" });
    await makeSession({ id: newer, podId: podA, startedAt: "2026-02-01T00:00:00Z", endedAt: "2026-02-01T01:00:00Z" });
    for (const seq of [1, 2, 3]) await makeEvent(older, seq, "2026-01-01T00:00:01Z");
    for (const seq of [1, 2, 3]) await makeEvent(newer, seq, "2026-02-01T00:00:01Z");

    await trimToCeiling(deps({ EVENT_MAX_ROWS: 3 }));

    const remaining = await query<{ session_id: string; n: string }>(
      `SELECT session_id, count(*)::bigint AS n FROM session_events
        WHERE session_id = ANY($1) GROUP BY session_id`,
      [[older, newer]],
    );
    assert.deepEqual(
      Object.fromEntries(remaining.rows.map((row) => [row.session_id, Number(row.n)])),
      { [newer]: 3 },
    );
    const watermark = await query<{ events_truncated_below_seq: string | null }>(
      "SELECT events_truncated_below_seq FROM sessions WHERE id = $1",
      [newer],
    );
    assert.equal(watermark.rows[0]?.events_truncated_below_seq, null);
  });

  it("sets a watermark when a single live session must be cut", async () => {
    await wipe();
    const live = uuidv7();
    await makeSession({ id: live, podId: podA, startedAt: "2026-03-01T00:00:00Z" });
    for (let seq = 1; seq <= 10; seq += 1) {
      await makeEvent(live, seq, "2026-03-01T00:00:01Z");
    }

    await trimToCeiling(deps({ EVENT_MAX_ROWS: 4 }));

    const rows = await query<{ seq: string }>(
      "SELECT seq FROM session_events WHERE session_id = $1 ORDER BY seq",
      [live],
    );
    assert.deepEqual(rows.rows.map((row) => Number(row.seq)), [7, 8, 9, 10]);
    const watermark = await query<{ events_truncated_below_seq: string | null }>(
      "SELECT events_truncated_below_seq FROM sessions WHERE id = $1",
      [live],
    );
    assert.equal(Number(watermark.rows[0]?.events_truncated_below_seq), 7);
    assert.equal(helloFirstAvailableSeq({ replayFrom: 2, truncatedBelowSeq: 7 }), 7);
  });

  it("records a watermark after the age window eats a session prefix", async () => {
    await wipe();
    const sessionId = uuidv7();
    await makeSession({ id: sessionId, podId: podA, startedAt: "2020-01-01T00:00:00Z" });
    await makeEvent(sessionId, 1, "2020-01-01T00:00:01Z");
    await makeEvent(sessionId, 2, "2020-01-02T00:00:01Z");
    const insideRetentionWindow = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    await makeEvent(sessionId, 3, insideRetentionWindow);

    await runRetention(deps({ EVENT_RETENTION_DAYS: 30, EVENT_MAX_ROWS: 4_000_000 }));

    const rows = await query<{ seq: string }>(
      "SELECT seq FROM session_events WHERE session_id = $1 ORDER BY seq",
      [sessionId],
    );
    assert.deepEqual(rows.rows.map((row) => Number(row.seq)), [3]);
    const watermark = await query<{ events_truncated_below_seq: string | null }>(
      "SELECT events_truncated_below_seq FROM sessions WHERE id = $1",
      [sessionId],
    );
    assert.equal(Number(watermark.rows[0]?.events_truncated_below_seq), 3);
  });

  it("expires adjacent tables without touching fresh rows or violating FKs", async () => {
    await wipe();
    const oldSession = uuidv7();
    const newSession = uuidv7();
    await makeSession({
      id: oldSession,
      podId: podA,
      startedAt: "2020-01-01T00:00:00Z",
      endedAt: "2020-01-02T00:00:00Z",
    });
    await makeSession({ id: newSession, podId: podB, startedAt: "2026-08-01T00:00:00Z" });
    await makeEvent(newSession, 1, "2026-08-01T00:00:01Z");

    const oldPrompt = uuidv7();
    const newPrompt = uuidv7();
    const pendingPrompt = uuidv7();
    await query(
      `INSERT INTO queued_prompts (id, pod_id, user_id, text, status, created_at)
       VALUES ($1, $2, $3, 'old', 'delivered', now() - interval '40 days')`,
      [oldPrompt, podA, userId],
    );
    await query(
      `INSERT INTO queued_prompts (id, pod_id, user_id, text, status, created_at)
       VALUES ($1, $2, $3, 'new', 'delivered', now())`,
      [newPrompt, podB, userId],
    );
    await query(
      `INSERT INTO queued_prompts (id, pod_id, user_id, text, status, created_at)
       VALUES ($1, $2, $3, 'pending', 'pending', now() - interval '40 days')`,
      [pendingPrompt, podA, userId],
    );

    await runRetention(deps({ EVENT_RETENTION_DAYS: 30, EVENT_MAX_ROWS: 4_000_000 }));

    const prompts = await query<{ id: string }>(
      "SELECT id FROM queued_prompts WHERE id = ANY($1) ORDER BY id",
      [[oldPrompt, newPrompt, pendingPrompt]],
    );
    assert.deepEqual(
      new Set(prompts.rows.map((row) => row.id)),
      new Set([newPrompt, pendingPrompt]),
    );

    const sessions = await query<{ id: string }>(
      "SELECT id FROM sessions WHERE id = ANY($1)",
      [[oldSession, newSession]],
    );
    assert.deepEqual(sessions.rows.map((row) => row.id), [newSession]);
  });
});
