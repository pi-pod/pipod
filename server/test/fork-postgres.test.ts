/**
 * Fork seed persistence, consumption, purge, and retention.
 *
 *   PI_POD_TEST_DATABASE_URL=postgres://pipod:pipod@localhost:55432/pipod npm run test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query, tx } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  consumeForkSeed,
  expireForkSeeds,
  insertForkSeed,
  loadUnconsumedForkSeed,
} from "../src/server/pods/fork-seed.js";
import { purgePodSessionData } from "../src/server/pods/session-data.js";
import { runRetention } from "../src/server/workers/retention.js";
import type { WorkerDeps } from "../src/server/workers/index.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("pod fork seeds (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const sourceId = uuidv7();
  const targetId = uuidv7();
  const otherId = uuidv7();
  const goneId = uuidv7();

  async function makePod(id: string, state = "active", providerState = "started"): Promise<void> {
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'fork', 'sandbox', $4, $5, '{}'::jsonb)`,
      [id, orgId, userId, state, providerState],
    );
  }

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'fork test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await makePod(sourceId);
    await makePod(targetId);
    await makePod(otherId);
    await makePod(goneId, "active", "gone");
  });

  after(async () => {
    await query("DELETE FROM pod_fork_seeds WHERE pod_id = ANY($1)", [[targetId, otherId, goneId]]);
    await query("DELETE FROM pods WHERE id = ANY($1)", [[sourceId, targetId, otherId, goneId]]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("loads an unconsumed seed and leaves it until consume", async () => {
    const content = Buffer.from('{"type":"header"}\n');
    await tx((client) =>
      insertForkSeed(client, {
        podId: targetId,
        sourcePodId: sourceId,
        sourcePath: "session.jsonl",
        content,
      }),
    );

    const loaded = await loadUnconsumedForkSeed(targetId);
    assert.ok(loaded);
    assert.equal(loaded.sourcePodId, sourceId);
    assert.equal(loaded.sourcePath, "session.jsonl");
    assert.equal(loaded.content.toString(), content.toString());

    await consumeForkSeed(targetId);
    assert.equal(await loadUnconsumedForkSeed(targetId), null);
  });

  it("purges seeds with the rest of a pod's session data", async () => {
    await tx((client) =>
      insertForkSeed(client, {
        podId: otherId,
        sourcePodId: sourceId,
        sourcePath: "keep.jsonl",
        content: Buffer.from("{}\n"),
      }),
    );
    await purgePodSessionData(targetId);
    const gone = await query("SELECT 1 FROM pod_fork_seeds WHERE pod_id = $1", [targetId]);
    assert.equal(gone.rowCount, 0);
    const kept = await query("SELECT 1 FROM pod_fork_seeds WHERE pod_id = $1", [otherId]);
    assert.equal(kept.rowCount, 1);
  });

  it("expires consumed seeds and unconsumed seeds whose pod cannot spawn", async () => {
    await query("DELETE FROM pod_fork_seeds WHERE pod_id = ANY($1)", [[otherId, goneId]]);
    await tx(async (client) => {
      await insertForkSeed(client, {
        podId: otherId,
        sourcePodId: sourceId,
        sourcePath: "old.jsonl",
        content: Buffer.from("{}\n"),
      });
      await insertForkSeed(client, {
        podId: goneId,
        sourcePodId: sourceId,
        sourcePath: "orphan.jsonl",
        content: Buffer.from("{}\n"),
      });
    });
    await query("UPDATE pod_fork_seeds SET consumed_at = now() - interval '8 days' WHERE pod_id = $1", [otherId]);

    const expired = await expireForkSeeds();
    assert.equal(expired.consumed, 1);
    assert.equal(expired.orphaned, 1);
    const left = await query("SELECT pod_id FROM pod_fork_seeds WHERE pod_id = ANY($1)", [[otherId, goneId]]);
    assert.equal(left.rowCount, 0);
  });

  it("runs seed expiry from the retention worker", async () => {
    await tx((client) =>
      insertForkSeed(client, {
        podId: goneId,
        sourcePodId: sourceId,
        sourcePath: "worker.jsonl",
        content: Buffer.from("{}\n"),
      }),
    );
    await runRetention({
      env: { EVENT_RETENTION_DAYS: 90, EVENT_MAX_ROWS: 4_000_000 } as WorkerDeps["env"],
      kek: {} as WorkerDeps["kek"],
      gateway: null,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const left = await query("SELECT 1 FROM pod_fork_seeds WHERE pod_id = $1", [goneId]);
    assert.equal(left.rowCount, 0);
  });
});
