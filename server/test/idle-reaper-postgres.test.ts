import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { claimNextIdlePod } from "../src/server/workers/reaper.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("idle reaper atomic claims (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const staleDetachedId = uuidv7();
  const freshAttachedId = uuidv7();
  const leasedWorkId = uuidv7();
  const concurrentAId = uuidv7();
  const concurrentBId = uuidv7();
  const archivedBusyId = uuidv7();
  const archivedNoTimeoutId = uuidv7();
  const podIds = [
    staleDetachedId,
    freshAttachedId,
    leasedWorkId,
    concurrentAId,
    concurrentBId,
    archivedBusyId,
    archivedNoTimeoutId,
  ];

  async function insertPod(args: {
    id: string;
    activityMinutesAgo: number;
    workLeaseMinutesAhead?: number;
    state?: string;
    idleTimeoutMinutes?: number;
  }): Promise<void> {
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
          resolved_config, last_activity_at, work_lease_until, gateway_id,
          gateway_heartbeat_at)
       VALUES ($1, $2, $3, 'idle claim fixture', 'sandbox', $4, $8, 'started', $5::jsonb,
          now() - make_interval(mins => $6),
          CASE WHEN $7::int IS NULL THEN NULL ELSE now() + make_interval(mins => $7) END,
          'fresh-replacement-gateway', now())`,
      [
        args.id,
        orgId,
        userId,
        `idle-claim-${args.id}`,
        JSON.stringify({ config: { idleTimeoutMinutes: args.idleTimeoutMinutes ?? 15 } }),
        args.activityMinutesAgo,
        args.workLeaseMinutesAhead ?? null,
        args.state ?? "active",
      ],
    );
  }

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'idle reaper claim test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await insertPod({ id: staleDetachedId, activityMinutesAgo: 60 });
    await insertPod({ id: freshAttachedId, activityMinutesAgo: 1 });
    await insertPod({ id: leasedWorkId, activityMinutesAgo: 60, workLeaseMinutesAhead: 30 });
    await insertPod({ id: concurrentAId, activityMinutesAgo: 60 });
    await insertPod({ id: concurrentBId, activityMinutesAgo: 60 });
    await insertPod({ id: archivedBusyId, activityMinutesAgo: 0, workLeaseMinutesAhead: 30, state: "archived" });
    await insertPod({ id: archivedNoTimeoutId, activityMinutesAgo: 0, state: "archived", idleTimeoutMinutes: 0 });
  });

  after(async () => {
    await query("DELETE FROM pods WHERE id = ANY($1)", [podIds]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("claims stale detached activity despite a fresh gateway heartbeat", async () => {
    const candidates = [staleDetachedId, freshAttachedId, leasedWorkId];
    const claimed = await claimNextIdlePod(candidates);
    assert.equal(claimed?.id, staleDetachedId);
    assert.equal(claimed?.provider_state, "stopping");
    assert.equal(claimed?.last_stop_cause, "idle_stop");
    assert.equal(await claimNextIdlePod(candidates), null);

    const protectedRows = await query<{ id: string; provider_state: string }>(
      "SELECT id, provider_state FROM pods WHERE id = ANY($1) ORDER BY id",
      [[freshAttachedId, leasedWorkId]],
    );
    assert.deepEqual(protectedRows.rows.map((row) => row.provider_state), ["started", "started"]);
  });

  it("claims an archived pod at once, however busy it looks and whatever its idle policy says", async () => {
    // Nobody can reach an archived pod, so activity a second old, a live work lease, and a
    // disabled idle timeout are all beside the point: its sandbox should not still be running.
    for (const id of [archivedBusyId, archivedNoTimeoutId]) {
      const claimed = await claimNextIdlePod([id]);
      assert.equal(claimed?.id, id);
      assert.equal(claimed?.provider_state, "stopping");
      assert.equal(claimed?.last_stop_cause, "archived");
      assert.equal(claimed?.state_reason, "archived");
      assert.equal(await claimNextIdlePod([id]), null);
    }
  });

  it("does not let concurrent sweeps claim the same eligible row twice", async () => {
    const [left, right] = await Promise.all([
      claimNextIdlePod([concurrentAId, concurrentBId]),
      claimNextIdlePod([concurrentAId, concurrentBId]),
    ]);
    const claimedIds = [left?.id, right?.id].filter((id): id is string => id !== undefined).sort();
    assert.deepEqual(claimedIds, [concurrentAId, concurrentBId].sort());
  });
});
