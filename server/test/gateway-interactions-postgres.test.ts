/**
 * A dialog blocks pi's turn until someone answers it, so an attaching client is told about
 * every interaction still unanswered — and about no others, however the answer was recorded.
 *
 *   PI_POD_TEST_DATABASE_URL=postgres://pipod:pipod@localhost:55432/pipod npm run test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { unansweredInteractionFrames } from "../src/server/gateway/service.js";
import { uuidv7 } from "../src/server/ids.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("unanswered interactions on attach (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  const sessionId = uuidv7();
  const otherSessionId = uuidv7();

  const dialog = (id: string, method = "confirm") => ({
    type: "extension_ui_request",
    id,
    method,
    title: "Run rm -rf?",
  });

  async function interaction(
    args: { session?: string; seq: number; payload: unknown; resolution?: unknown; delivered?: boolean },
  ): Promise<void> {
    await query(
      `INSERT INTO pending_interactions (id, session_id, seq, kind, payload, resolution, resolved_at, delivered_at)
       VALUES ($1, $2, $3, 'confirm', $4, $5, CASE WHEN $5::jsonb IS NULL THEN NULL ELSE now() END,
               CASE WHEN $6 THEN now() ELSE NULL END)`,
      [
        uuidv7(),
        args.session ?? sessionId,
        args.seq,
        JSON.stringify(args.payload),
        args.resolution === undefined ? null : JSON.stringify(args.resolution),
        args.delivered ?? false,
      ],
    );
  }

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'interaction test')", [
      orgId,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@example.test`,
    ]);
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config,
                         lineage_root_id, lineage_depth)
       VALUES ($1, $2, $3, 'interactions', 'sandbox', 'active', 'started', '{}'::jsonb, $1, 0)`,
      [podId, orgId, userId],
    );
    for (const id of [sessionId, otherSessionId]) {
      await query(
        "INSERT INTO sessions (id, pod_id, user_id, started_at) VALUES ($1, $2, $3, now())",
        [id, podId, userId],
      );
    }
  });

  after(async () => {
    await query("DELETE FROM pending_interactions WHERE session_id = ANY($1)", [[sessionId, otherSessionId]]);
    await query("DELETE FROM sessions WHERE pod_id = $1", [podId]);
    await query("DELETE FROM pods WHERE id = $1", [podId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("re-presents only what nobody has answered, in emission order", async () => {
    await interaction({ seq: 3, payload: dialog("second", "select") });
    await interaction({ seq: 1, payload: dialog("first") });
    // Answered over the socket by another client mid-gap: resolution and delivery in one claim.
    await interaction({ seq: 2, payload: dialog("answered-live"), resolution: { confirmed: true }, delivered: true });
    // Answered through REST from the phone; the resolution is recorded before it is forwarded.
    await interaction({ seq: 4, payload: dialog("answered-rest"), resolution: { confirmed: false } });
    await interaction({ session: otherSessionId, seq: 1, payload: dialog("other-session") });

    const frames = await unansweredInteractionFrames(sessionId);
    assert.deepEqual(frames, [
      { type: "ephemeral", kind: "extension_ui_request", payload: dialog("first") },
      { type: "ephemeral", kind: "extension_ui_request", payload: dialog("second", "select") },
    ]);
  });

  it("bounds a storm of unanswered dialogs", async () => {
    const flooded = uuidv7();
    await query("INSERT INTO sessions (id, pod_id, user_id, started_at) VALUES ($1, $2, $3, now())", [
      flooded,
      podId,
      userId,
    ]);
    for (let seq = 1; seq <= 5; seq++) await interaction({ session: flooded, seq, payload: dialog(`d${seq}`) });
    const frames = await unansweredInteractionFrames(flooded, 2);
    assert.deepEqual(
      frames.map((frame) => (frame as { payload: { id: string } }).payload.id),
      ["d1", "d2"],
    );
    await query("DELETE FROM pending_interactions WHERE session_id = $1", [flooded]);
    await query("DELETE FROM sessions WHERE id = $1", [flooded]);
  });
});
