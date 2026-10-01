/**
 * Durable capacity wait + grant ledger against Postgres (migration 053).
 *
 * Own DB: `pipod_cost_capacity_test` on the parent-isolated PG — never the
 * foundation DB, never production. Covers enqueue fairness caps, heartbeat,
 * cancel, expiry, orphan detection, restart recovery, pruning, and grant
 * revision monotonicity over real SQL.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  cancelHostOperation,
  platformSandboxClient,
} from "../src/server/pods/operations.js";
import {
  capacityWaitDisplay,
  enqueueCapacityWait,
  expiredWaitTerminal,
  expireDueWaits,
  findOrphanedWaits,
  finishCapacityWait,
  finishWaitExpired,
  getCapacityWait,
  heartbeatCapacityWait,
  noteWaitAttemptHost,
  pruneFinishedWaits,
  recoverWaitsAfterRestart,
  recordWaitAttempt,
  tryClaimAttempt,
  requestWaitCancel,
  listWaitingPods,
  toWaitView,
  type WaitStore,
} from "../src/server/pods/capacity-wait.js";
import { midWaitAttemptRecord } from "../src/server/pods/provisioning.js";
import { fleetUnavailableError } from "../src/server/pods/sandboxfleet.js";
import { renderCapacityWaitTerminal } from "../src/server/pods/provision-failure.js";
import {
  allocateGrantRevision,
  confirmGrant,
  markGrantsExpired,
} from "../src/server/pods/cpu-fairness.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
// platformSandboxClient reads the platform token from the process env (as in production).
process.env["PI_POD_SANDBOX_TOKEN"] ??= "test-platform-token";

const store: WaitStore = {
  query: (text: string, params?: unknown[]) => query(text, params ?? []),
};

describe("capacity wait queue (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  async function seedPod(owner: string): Promise<string> {
    const podId = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, $4, 'sandbox', NULL, 'active', 'provisioning', $5::jsonb)`,
      [podId, orgId, owner, `wait ${podId.slice(0, 8)}`, JSON.stringify({ config: { providers: {} } })],
    );
    return podId;
  }

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, "capacity wait org"]);
    for (const id of [userId, otherUserId]) {
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    }
  });

  after(async () => {
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    for (const id of [userId, otherUserId]) await query("DELETE FROM users WHERE id = $1", [id]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM pod_capacity_wait");
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM cpu_grant_ledger");
  });

  it("enqueues, heartbeats, records attempts, and admits", async () => {
    const podId = await seedPod(userId);
    const row = await enqueueCapacityWait(store, {
      podId,
      orgId,
      userId,
      operationKey: "pod-op-1-abcdefgh",
      reason: "memory_capacity",
      detail: { kind: "admission", reason: "memory_capacity", retryable: true },
      waitSeconds: 60,
    });
    assert.ok(row);
    assert.equal(row.status, "waiting");
    assert.equal(row.attempts, 0);

    const beat = await heartbeatCapacityWait(store, podId);
    assert.ok(beat);

    const attempted = await recordWaitAttempt(store, podId, {
      reason: "memory_capacity",
      detail: { kind: "admission", reason: "memory_capacity", retryable: true },
    });
    assert.equal(attempted?.attempts, 1);

    await noteWaitAttemptHost(store, podId, "http://host-a:8433");
    const withHost = await getCapacityWait(store, podId);
    assert.equal(withHost?.last_host_url, "http://host-a:8433");

    const view = toWaitView(withHost!, Date.now());
    assert.equal(view.state, "waiting");
    assert.ok(view.deadlineInMs > 0 && view.deadlineInMs <= 60_000);

    const admitted = await finishCapacityWait(store, podId, "admitted");
    assert.equal(admitted?.status, "admitted");
    // Terminal rows stop heartbeating.
    assert.equal(await heartbeatCapacityWait(store, podId), null);
  });

  it("expiry terminal reports the last recorded refusal, not the enqueue reason", async () => {
    // Production 2026-09-07: enqueued on fairness_degraded, the last five
    // of six attempts refused disk_capacity — the expiry terminal must say
    // disk_capacity (with the numbers), never the stale enqueue reason.
    const podId = await seedPod(userId);
    const enqueueDetail = {
      kind: "admission",
      reason: "fairness_degraded",
      resource: "fairness",
      unit: "count",
      retryable: true,
    };
    await enqueueCapacityWait(store, {
      podId,
      orgId,
      userId,
      operationKey: "pod-op-expiry-last",
      reason: "fairness_degraded",
      detail: enqueueDetail,
      waitSeconds: 60,
    });
    const lastDetail = {
      kind: "admission",
      reason: "disk_capacity",
      resource: "disk",
      unit: "bytes",
      retryable: true,
      required: 21474836480,
      available: 19906027520,
    };
    await recordWaitAttempt(store, podId, { reason: "fairness_degraded", detail: enqueueDetail });
    for (let i = 0; i < 5; i++) {
      await recordWaitAttempt(store, podId, { reason: "disk_capacity", detail: lastDetail });
    }
    const expired = await finishWaitExpired(store, podId);
    assert.ok(expired);
    assert.equal(expired.status, "expired");
    assert.equal(expired.attempts, 6);
    assert.equal(expired.reason, "disk_capacity");
    const terminal = expiredWaitTerminal({
      enqueueReason: "fairness_degraded",
      enqueueDetail,
      row: expired,
    });
    assert.deepEqual(terminal, { reason: "disk_capacity", detail: lastDetail });
  });

  it("a mid-wait fleet outage records fleet_unavailable, and the expiry terminal says so", async () => {
    // Follow-up to #247: a mid-wait `fleet_unavailable` from `placeFresh`
    // used to record the enqueue reason with a null detail, clobbering the
    // previously recorded admission numbers. The outage is evidence: record
    // it, and the expiry terminal names it.
    const podId = await seedPod(userId);
    const enqueueDetail = {
      kind: "admission",
      reason: "disk_capacity",
      resource: "disk",
      unit: "bytes",
      retryable: true,
      required: 21474836480,
      available: 19906027520,
    };
    await enqueueCapacityWait(store, {
      podId,
      orgId,
      userId,
      operationKey: "pod-op-expiry-fleet",
      reason: "disk_capacity",
      detail: enqueueDetail,
      waitSeconds: 60,
    });
    let row = await getCapacityWait(store, podId);
    assert.ok(row);
    await recordWaitAttempt(store, podId, { reason: "disk_capacity", detail: enqueueDetail });
    // The fleet goes unreachable mid-wait: record exactly what the wait
    // loop records for the `placeFresh` throw (validated shape, jsonb round-trip).
    row = (await getCapacityWait(store, podId)) ?? row;
    const outage = midWaitAttemptRecord({
      enqueueReason: "disk_capacity",
      row,
      placeError: fleetUnavailableError("no sandbox host answered"),
    });
    assert.equal(outage.reason, "fleet_unavailable");
    await recordWaitAttempt(store, podId, outage);
    const expired = await finishWaitExpired(store, podId);
    assert.ok(expired);
    assert.equal(expired.reason, "fleet_unavailable");
    const terminal = expiredWaitTerminal({
      enqueueReason: "disk_capacity",
      enqueueDetail,
      row: expired,
    });
    assert.equal(terminal.reason, "fleet_unavailable");
    const display = capacityWaitDisplay(terminal);
    assert.equal(display.reason, "fleet_unavailable");
    const rendered = renderCapacityWaitTerminal({ reason: display.reason!, waitedSeconds: 60 });
    assert.match(rendered, /the sandbox fleet is unreachable; retry shortly/);
    assert.match(rendered, /waited 60s for fleet_unavailable/);
  });

  it("expiry with zero attempts keeps the enqueue reason", async () => {
    const podId = await seedPod(userId);
    const enqueueDetail = {
      kind: "admission",
      reason: "fairness_degraded",
      resource: "fairness",
      unit: "count",
      retryable: true,
    };
    await enqueueCapacityWait(store, {
      podId,
      orgId,
      userId,
      operationKey: "pod-op-expiry-first",
      reason: "fairness_degraded",
      detail: enqueueDetail,
      waitSeconds: 60,
    });
    const expired = await finishWaitExpired(store, podId);
    assert.ok(expired);
    assert.equal(expired.attempts, 0);
    const terminal = expiredWaitTerminal({
      enqueueReason: "fairness_degraded",
      enqueueDetail,
      row: expired,
    });
    assert.deepEqual(terminal, { reason: "fairness_degraded", detail: enqueueDetail });
  });

  it("bounds waiters by quota, not by a separate waiter cap", async () => {
    // Parent review: a per-user waiter cap would be a new entitlement on top
    // of the atomic 20-slot quota. Any entitled pod may queue; fairness is
    // enforced at attempt time (tryClaimAttempt), not at admission.
    const pods = [await seedPod(userId), await seedPod(userId), await seedPod(otherUserId)];
    for (const podId of pods) {
      const row = await enqueueCapacityWait(store, {
        podId,
        orgId,
        userId: podId === pods[2] ? otherUserId : userId,
        operationKey: `pod-op-${podId.slice(0, 8)}`,
        reason: "memory_capacity",
        detail: null,
        waitSeconds: 60,
      });
      assert.ok(row);
    }
  });

  it("rotates attempts across users (no monopolization)", async () => {
    const [a1, a2, b1] = [await seedPod(userId), await seedPod(userId), await seedPod(otherUserId)];
    for (const [podId, user] of [[a1, userId], [a2, userId], [b1, otherUserId]] as const) {
      await enqueueCapacityWait(store, {
        podId,
        orgId,
        userId: user,
        operationKey: `pod-op-rr-${podId.slice(0, 8)}`,
        reason: "memory_capacity",
        detail: null,
        waitSeconds: 60,
      });
    }
    // Round 1: everyone holds its turn (all at 0 attempts).
    assert.ok(await tryClaimAttempt(store, a1));
    assert.ok(await tryClaimAttempt(store, a2));
    assert.ok(await tryClaimAttempt(store, b1));
    await recordWaitAttempt(store, a1, { reason: null, detail: null });
    await recordWaitAttempt(store, a2, { reason: null, detail: null });
    // a1/a2 at 1 attempt, b1 at 0: b1 still holds its turn...
    assert.ok(await tryClaimAttempt(store, b1));
    await recordWaitAttempt(store, b1, { reason: null, detail: null });
    // ...but a1 must now sit out until b1 catches up: all at 1 after b1's
    // attempt, so a1's claim at attempts=1 vs other-user min=1 passes again.
    assert.ok(await tryClaimAttempt(store, a1));
    await recordWaitAttempt(store, a1, { reason: null, detail: null });
    // a1 at 2, others at 1: a1 sits out, a2 (at 1, min other = b1 at 1) goes.
    assert.equal(await tryClaimAttempt(store, a1), null);
    assert.ok(await tryClaimAttempt(store, a2));
  });

  it("a lone waiter always holds its turn", async () => {
    const podId = await seedPod(userId);
    await enqueueCapacityWait(store, {
      podId,
      orgId,
      userId,
      operationKey: "pod-op-lone-1",
      reason: "memory_capacity",
      detail: null,
      waitSeconds: 60,
    });
    for (let i = 0; i < 3; i++) {
      assert.ok(await tryClaimAttempt(store, podId));
      await recordWaitAttempt(store, podId, { reason: null, detail: null });
    }
  });

  it("cancels cooperatively: heartbeat stops after cancel_requested", async () => {
    const podId = await seedPod(userId);
    await enqueueCapacityWait(store, {
      podId,
      orgId,
      userId,
      operationKey: "pod-op-cancel-1",
      reason: "disk_capacity",
      detail: null,
      waitSeconds: 60,
    });
    assert.equal(await requestWaitCancel(store, podId), true);
    assert.equal(await heartbeatCapacityWait(store, podId), null);
    const row = await getCapacityWait(store, podId);
    assert.equal(row?.cancel_requested, true);
    assert.equal(row?.status, "waiting");
  });

  it("expires past-deadline waits and prunes terminal rows after an hour", async () => {
    const podId = await seedPod(userId);
    await enqueueCapacityWait(store, {
      podId,
      orgId,
      userId,
      operationKey: "pod-op-expire-1",
      reason: "transition_capacity",
      detail: null,
      waitSeconds: 60,
    });
    assert.deepEqual(await expireDueWaits(store), []);
    await query(`UPDATE pod_capacity_wait SET deadline_at = now() - make_interval(secs => 1) WHERE pod_id = $1`, [
      podId,
    ]);
    const expired = await expireDueWaits(store);
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.status, "expired");

    // FIFO drain order for capacity-change wakeups.
    const a = await seedPod(userId);
    const b = await seedPod(userId);
    await enqueueCapacityWait(store, {
      podId: a,
      orgId,
      userId,
      operationKey: "pod-op-fifo-a1",
      reason: null,
      detail: null,
      waitSeconds: 60,
    });
    await enqueueCapacityWait(store, {
      podId: b,
      orgId,
      userId,
      operationKey: "pod-op-fifo-b1",
      reason: null,
      detail: null,
      waitSeconds: 60,
    });
    const waiting = await listWaitingPods(store, 10);
    assert.deepEqual(
      waiting.map((row) => row.pod_id),
      [a, b],
    );

    // Prune only terminal rows older than an hour.
    await query(
      `UPDATE pod_capacity_wait SET status = 'expired', updated_at = now() - make_interval(hours => 2) WHERE pod_id = $1`,
      [podId],
    );
    assert.equal(await pruneFinishedWaits(store), 1);
    assert.equal(await getCapacityWait(store, podId), null);
    assert.ok(await getCapacityWait(store, a));
  });

  it("detects orphaned waits and recovers restart state", async () => {
    const orphan = await seedPod(userId);
    const live = await seedPod(userId);
    for (const [podId, key] of [
      [orphan, "pod-op-orphan-1"],
      [live, "pod-op-live-123"],
    ] as const) {
      await enqueueCapacityWait(store, {
        podId,
        orgId,
        userId,
        operationKey: key,
        reason: "memory_capacity",
        detail: null,
        waitSeconds: 600,
      });
    }
    // Owner died 5 minutes ago: orphan. Live row heartbeat stays fresh.
    await query(`UPDATE pod_capacity_wait SET heartbeat_at = now() - make_interval(mins => 5) WHERE pod_id = $1`, [
      orphan,
    ]);
    const orphaned = await findOrphanedWaits(store, 30_000);
    assert.deepEqual(orphaned.map((row) => row.pod_id), [orphan]);

    const recovered = await recoverWaitsAfterRestart(store, 30_000);
    assert.deepEqual(recovered.live.map((row) => row.pod_id), [live]);
    assert.deepEqual(recovered.expired.map((row) => row.pod_id), []);
  });

  it("cascades wait rows when the pod is deleted (cancel-via-delete)", async () => {
    const podId = await seedPod(userId);
    await enqueueCapacityWait(store, {
      podId,
      orgId,
      userId,
      operationKey: "pod-op-cascade1",
      reason: null,
      detail: null,
      waitSeconds: 60,
    });
    await query("DELETE FROM pods WHERE id = $1", [podId]);
    assert.equal(await getCapacityWait(store, podId), null);
  });

  it("expires only unconfirmed aspirations, never charged state, over real SQL", async () => {
    // Aspiration that never landed: collected once its TTL passes.
    await allocateGrantRevision(store, { hostId: "host-x", userKey: "u_tmp", nowMs: 1_700_000_000_000, cpuCores: 2.5, ttlMs: 60_000 });
    await query(`UPDATE cpu_grant_ledger SET expires_at = now() - make_interval(secs => 1) WHERE user_key = 'u_tmp'`);
    assert.equal(await markGrantsExpired(store), 1);
    // Charged state survives ledger TTL (the host may still enforce it;
    // freshness carries the caution, revocation clears it on host ACK).
    const first = await allocateGrantRevision(store, { hostId: "host-a", userKey: "u_abc", nowMs: 1_700_000_000_000, cpuCores: 2.5, ttlMs: 60_000 });
    // Stale confirmation cannot overwrite.
    assert.equal(await confirmGrant(store, { hostId: "host-a", userKey: "u_abc", revision: first - 1, cpuCores: 9 }), false);
    assert.equal(await confirmGrant(store, { hostId: "host-a", userKey: "u_abc", revision: first, cpuCores: 2.5 }), true);
    const second = await allocateGrantRevision(store, { hostId: "host-a", userKey: "u_abc", nowMs: 1_700_000_000_000, cpuCores: 3, ttlMs: 60_000 });
    assert.ok(second > first);
    await query(`UPDATE cpu_grant_ledger SET expires_at = now() - make_interval(secs => 1) WHERE user_key = 'u_abc'`);
    assert.equal(await markGrantsExpired(store), 0);
  });

  it("cancelHostOperation against a dead host resolves null (never throws)", async () => {
    // Explicit token (test value): no ambient read on this path.
    const client = platformSandboxClient("http://127.0.0.1:1", "test-platform-token");
    assert.ok(client);
    assert.equal(await cancelHostOperation(client!, "pod-op-dead-host"), null);
  });
});
