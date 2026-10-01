import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { query, tx, closePool, initPool } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { acquireQuotaLocks } from "../src/server/pods/concurrency.js";
import { assertNoLaunchRecoveryHold } from "../src/server/pods/launch-control.js";
import {
  assignCreateAttemptTx,
  createOperationKey,
  markCreateAttemptDispatchingTx,
  markCreateAttemptFailedSafeTx,
  heartbeatCreateAttempt,
  markCreateAttemptUnknownTx,
  prepareCreateAttemptTx,
  type PreparedCreateAttempt,
} from "../src/server/pods/create-attempts.js";

const databaseUrl = process.env.PI_POD_TEST_DATABASE_URL;

describe("durable create-attempt admission (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const ownerId = uuidv7();
  const otherUserId = uuidv7();
  const leaseUserId = uuidv7();
  const podIds: string[] = [];

  async function prepare(userId: string): Promise<{ podId: string; attempt: PreparedCreateAttempt }> {
    const podId = uuidv7();
    podIds.push(podId);
    let attempt: PreparedCreateAttempt | null = null;
    await tx(async (client) => {
      await acquireQuotaLocks(client, orgId, userId);
      await client.query(
        `INSERT INTO pods
           (id,org_id,user_id,name,provider,state,provider_state,resolved_config,
            provisioning_heartbeat_at,transport)
         VALUES ($1,$2,$3,'attempt test','sandbox','active','provisioning',
           '{"config":{"providers":{"sandbox":{}}},"workdir":"/workspace"}'::jsonb,now(),'ws')`,
        [podId, orgId, userId],
      );
      attempt = await prepareCreateAttemptTx(client, {
        podId,
        orgId,
        userId,
        provider: "sandbox",
        hostId: null,
      });
    });
    assert.ok(attempt);
    return { podId, attempt };
  }

  async function dispatch(podId: string, userId: string, attempt: PreparedCreateAttempt): Promise<void> {
    await tx((client) => markCreateAttemptDispatchingTx(client, {
      attemptId: attempt.id,
      ownerToken: attempt.ownerToken,
      ownerInstanceId: attempt.ownerInstanceId,
      orgId,
      userId,
    }));
  }

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations(id,name) VALUES ($1,'attempt admission test')", [orgId]);
    await query("INSERT INTO users(id,email) VALUES ($1,$2),($3,$4),($5,$6)", [
      ownerId, `${ownerId}@attempt.test`, otherUserId, `${otherUserId}@attempt.test`,
      leaseUserId, `${leaseUserId}@attempt.test`,
    ]);
  });

  after(async () => {
    await query("DELETE FROM pod_create_attempts WHERE pod_id=ANY($1::uuid[])", [podIds]).catch(() => {});
    await query("DELETE FROM pods WHERE id=ANY($1::uuid[])", [podIds]).catch(() => {});
    await query("DELETE FROM users WHERE id=ANY($1::text[])", [[ownerId, otherUserId, leaseUserId]]).catch(() => {});
    await query("DELETE FROM organizations WHERE id=$1", [orgId]).catch(() => {});
    await closePool();
  });

  it("keeps independent live launches concurrent, then blocks a prepared peer after ambiguity", async () => {
    const first = await prepare(ownerId);
    const second = await prepare(ownerId);
    await dispatch(first.podId, ownerId, first.attempt);
    await dispatch(second.podId, ownerId, second.attempt);
    await assertNoLaunchRecoveryHold(undefined, ownerId);
    const preparedPeer = await prepare(ownerId);

    await tx((client) => markCreateAttemptUnknownTx(client, {
      attemptId: first.attempt.id,
      ownerToken: first.attempt.ownerToken,
      ownerInstanceId: first.attempt.ownerInstanceId,
      orgId,
      userId: ownerId,
      reasonCode: "original_outcome_unknown",
      observedAt: true,
      clearOwner: true,
    }));
    await assert.rejects(
      assertNoLaunchRecoveryHold(undefined, ownerId),
      (error: unknown) => error instanceof Error && (error as { statusCode?: number }).statusCode === 409,
    );
    await assert.rejects(
      dispatch(preparedPeer.podId, ownerId, preparedPeer.attempt),
      (error: unknown) => error instanceof Error && (error as { statusCode?: number }).statusCode === 409,
    );
    // An already-authorized independent launch can record its affirmative terminal outcome;
    // it must not recreate or reinitialize the held attempt.
    await tx((client) => markCreateAttemptFailedSafeTx(client, {
      attemptId: second.attempt.id,
      ownerToken: second.attempt.ownerToken,
      ownerInstanceId: second.attempt.ownerInstanceId,
      orgId,
      userId: ownerId,
      reasonCode: "provider_preallocation_refusal",
    }));

    // A different account remains independent of the held owner.
    const unrelated = await prepare(otherUserId);
    await dispatch(unrelated.podId, otherUserId, unrelated.attempt);
    assert.ok(createOperationKey() !== first.attempt.operationKey);

    const stale = await prepare(leaseUserId);
    await dispatch(stale.podId, leaseUserId, stale.attempt);
    await query(
      `UPDATE pod_create_attempts SET owner_lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [stale.attempt.id],
    );
    assert.equal(await heartbeatCreateAttempt({
      attemptId: stale.attempt.id,
      podId: stale.podId,
      ownerToken: stale.attempt.ownerToken,
      ownerInstanceId: stale.attempt.ownerInstanceId,
    }), false, "an expired owner cannot revive its lease");
    await assert.rejects(assertNoLaunchRecoveryHold(undefined, leaseUserId), (error: unknown) =>
      error instanceof Error && (error as { statusCode?: number }).statusCode === 409,
    );
  });

  it("creates a new opaque key only after an affirmative safe terminal outcome", async () => {
    const first = await prepare(otherUserId);
    await dispatch(first.podId, otherUserId, first.attempt);
    await tx((client) => markCreateAttemptFailedSafeTx(client, {
      attemptId: first.attempt.id,
      ownerToken: first.attempt.ownerToken,
      ownerInstanceId: first.attempt.ownerInstanceId,
      orgId,
      userId: otherUserId,
      reasonCode: "provider_preallocation_refusal",
    }));
    const next = await tx((client) => assignCreateAttemptTx(client, {
      previous: first.attempt,
      podId: first.podId,
      orgId,
      userId: otherUserId,
      provider: "sandbox",
      hostId: null,
      hostUrl: "http://127.0.0.1:8433",
    }));
    assert.equal(next.attemptNo, first.attempt.attemptNo + 1);
    assert.notEqual(next.operationKey, first.attempt.operationKey);
    assert.ok(next.operationKey);
    await assertNoLaunchRecoveryHold(undefined, otherUserId);
  });
});
