import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  conversationEventsQuery,
  conversationPageFromRows,
} from "../src/server/pods/conversation.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
type ConversationEventRow = {
  session_id: string;
  seq: string | number;
  kind: string;
  payload: unknown;
  created_at: string | Date;
};

describe("conversation history (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  const sessionA = uuidv7();
  const sessionB = uuidv7();

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'conversation test')", [
      orgId,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@example.test`,
    ]);
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'conv', 'sandbox', 'active', 'stopped', '{}'::jsonb)`,
      [podId, orgId, userId],
    );
    await query(
      `INSERT INTO sessions (id, pod_id, user_id, started_at, ended_at, end_reason)
       VALUES ($1, $2, $3, '2026-08-12T11:00:00Z', '2026-08-12T11:10:00Z', 'idle_stop')`,
      [sessionA, podId, userId],
    );
    await query(
      `INSERT INTO sessions (id, pod_id, user_id, started_at)
       VALUES ($1, $2, $3, '2026-08-12T12:00:00Z')`,
      [sessionB, podId, userId],
    );
    await query(
      `INSERT INTO session_events (session_id, seq, kind, payload, created_at) VALUES
       ($1, 1, 'user_prompt', '{"text":"first"}', '2026-08-12T11:00:01Z'),
       ($1, 2, 'session_ended', '{"reason":"idle_stop"}', '2026-08-12T11:10:00Z'),
       ($2, 1, 'user_prompt', '{"text":"second"}', '2026-08-12T12:00:01Z')`,
      [sessionA, sessionB],
    );
  });

  after(async () => {
    await query("DELETE FROM session_events WHERE session_id = ANY($1)", [[sessionA, sessionB]]);
    await query("DELETE FROM sessions WHERE pod_id = $1", [podId]);
    await query("DELETE FROM pods WHERE id = $1", [podId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("merges sessions into one chronological page", async () => {
    const q = conversationEventsQuery({ podId, before: null, limit: 10 });
    const rows = await query<ConversationEventRow>(q.text, q.params);
    const page = conversationPageFromRows(rows.rows, 10);
    assert.deepEqual(
      page.events.map((event) => `${event.kind}:${(event.payload as { text?: string }).text ?? ""}`),
      ["user_prompt:first", "session_ended:", "user_prompt:second"],
    );
    assert.equal(page.nextBefore, null);
  });

  it("pages strictly before a cursor across the session boundary", async () => {
    const first = conversationEventsQuery({ podId, before: null, limit: 1 });
    const newest = conversationPageFromRows((await query<ConversationEventRow>(first.text, first.params)).rows, 1);
    assert.equal(newest.events[0]?.sessionId, sessionB);
    assert.deepEqual(newest.nextBefore, { sessionId: sessionB, seq: 1 });

    const older = conversationEventsQuery({ podId, before: newest.nextBefore, limit: 10 });
    const page = conversationPageFromRows((await query<ConversationEventRow>(older.text, older.params)).rows, 10);
    assert.deepEqual(
      page.events.map((event) => `${event.sessionId}:${event.seq}`),
      [`${sessionA}:1`, `${sessionA}:2`],
    );
  });
});
