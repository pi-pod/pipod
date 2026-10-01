/**
 * Capacity-wait visibility against Postgres: typed terminal failure payload,
 * the archived (not active) gone row, exactly-once cancel, the gone-row
 * sweep's workspace refusal, and the `includeGone` listing gate.
 *
 * Own DB: `PI_POD_TEST_DATABASE_URL` on the parent-isolated PG — never the
 * foundation DB, never production. Follows capacity-wait-postgres.test.ts.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { metricsRegister } from "../src/server/metrics.js";
import {
  cancelCapacityWait,
  claimOrphanedWait,
  enqueueCapacityWait,
  expireDueWaits,
  findOrphanedWaits,
  finishCapacityWait,
  finishWaitExpired,
  getCapacityWait,
  heartbeatCapacityWait,
  type WaitStore,
} from "../src/server/pods/capacity-wait.js";
import {
  failWaitPod,
  failWakeWaitPod,
  runCapacityWaitSweep,
} from "../src/server/workers/capacity-sweep.js";
import {
  classifyGoneRow,
  findGoneRows,
  reconcileGoneRows,
} from "../src/server/pods/gone-reconciler.js";
import { CAPACITY_WAIT_EXPIRED_CODE, recordProvisioningFailure } from "../src/server/pods/provision-failure.js";
import { listPods } from "../src/server/pods/store.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

const store: WaitStore = {
  query: (text: string, params?: unknown[]) => query(text, params ?? []),
};

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** Current `pipod_capacity_waits_total` count for one outcome (delta assertions). */
async function waitOutcomeCount(outcome: string): Promise<number> {
  const text = await metricsRegister.getSingleMetricAsString("pipod_capacity_waits_total").catch(() => "");
  const match = new RegExp(`outcome="${outcome}"\\} ([0-9.eE+-]+)`).exec(text);
  return match ? Number(match[1]) : 0;
}

describe(
  "capacity wait visibility (postgres)",
  { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" },
  () => {
    const orgId = uuidv7();
    const userId = uuidv7();

    async function seedPod(args: {
      state?: string;
      providerState?: string;
      sandboxId?: string | null;
      reason?: string | null;
    } = {}): Promise<string> {
      const podId = uuidv7();
      await query(
        `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
           state_reason, resolved_config)
         VALUES ($1, $2, $3, $4, 'sandbox', $5, $6, $7, $8, $9::jsonb)`,
        [
          podId,
          orgId,
          userId,
          `vis ${podId.slice(0, 8)}`,
          args.sandboxId ?? null,
          args.state ?? "active",
          args.providerState ?? "provisioning",
          args.reason ?? null,
          JSON.stringify({ config: { providers: {} }, warnings: [] }),
        ],
      );
      return podId;
    }

    async function seedWait(
      podId: string,
      overrides: {
        kind?: "create" | "wake";
        intent?: Record<string, unknown> | null;
        reason?: string | null;
        detail?: Record<string, unknown> | null;
      } = {},
    ): Promise<void> {
      await enqueueCapacityWait(store, {
        podId,
        orgId,
        userId,
        operationKey: overrides.kind === "wake" ? `wake:${podId}` : `op-${podId.slice(0, 8)}-abcdefgh`,
        ...(overrides.kind !== undefined ? { kind: overrides.kind } : {}),
        ...(overrides.intent !== undefined ? { intent: overrides.intent } : {}),
        reason: overrides.reason !== undefined ? overrides.reason : "disk_capacity",
        detail:
          overrides.detail !== undefined
            ? overrides.detail
            : {
                kind: "admission",
                reason: "disk_capacity",
                resource: "disk",
                unit: "bytes",
                retryable: true,
                required: 20,
                available: 19,
              },
        waitSeconds: 60,
      });
    }

    before(async () => {
      initPool(databaseUrl!);
      await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, "wait visibility org"]);
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    });

    after(async () => {
      await query("DELETE FROM pod_capacity_wait WHERE org_id = $1", [orgId]);
      await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
      await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
      await query("DELETE FROM users WHERE id = $1", [userId]);
      await query("DELETE FROM organizations WHERE id = $1", [orgId]);
      await closePool();
    });

    beforeEach(async () => {
      await query("DELETE FROM pod_capacity_wait WHERE org_id = $1", [orgId]);
      await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    });

    it("records a typed terminal failure and archives the never-started row", async () => {
      const podId = await seedPod({ providerState: "provisioning" });
      const message =
        "capacity wait expired: sandbox hosts at capacity (disk_capacity) (waited 60s for disk_capacity)";
      const outcome = await recordProvisioningFailure({
        podId,
        orgId,
        userId,
        report: { warnings: [] } as never,
        message,
        code: CAPACITY_WAIT_EXPIRED_CODE,
      });
      assert.equal(outcome, "gone");
      const row = await query<{ provider_state: string; state: string; state_reason: string }>(
        "SELECT provider_state, state, state_reason FROM pods WHERE id = $1",
        [podId],
      );
      assert.equal(row.rows[0]?.provider_state, "gone");
      // Never-started launches must not linger as active rows no listing shows.
      assert.equal(row.rows[0]?.state, "archived");
      assert.match(row.rows[0]?.state_reason ?? "", /^launch_failed:capacity_wait_expired: /);
      assert.match(row.rows[0]?.state_reason ?? "", /waited 60s for disk_capacity/);
    });

    it("leaves untyped failures and workspace-backed rows exactly as before", async () => {
      const failed = await seedPod({ providerState: "provisioning" });
      const outcome = await recordProvisioningFailure({
        podId: failed,
        orgId,
        userId,
        report: { warnings: [] } as never,
        message: "provider request failed",
      });
      assert.equal(outcome, "gone");
      const gone = await query<{ state: string; state_reason: string }>(
        "SELECT state, state_reason FROM pods WHERE id = $1",
        [failed],
      );
      assert.equal(gone.rows[0]?.state, "archived");
      assert.equal(gone.rows[0]?.state_reason, "operation failed");

      const withWorkspace = await seedPod({ providerState: "starting", sandboxId: "sbx-kept-1" });
      const errorOutcome = await recordProvisioningFailure({
        podId: withWorkspace,
        orgId,
        userId,
        report: { warnings: [] } as never,
        message: "provider request failed",
      });
      assert.equal(errorOutcome, "error");
      const kept = await query<{ state: string }>("SELECT state FROM pods WHERE id = $1", [withWorkspace]);
      assert.equal(kept.rows[0]?.state, "active");
    });

    it("cancels a wait exactly once", async () => {
      const podId = await seedPod();
      await seedWait(podId);
      const finished = await cancelCapacityWait(store, podId);
      assert.equal(finished?.status, "cancelled");
      // A concurrent waiter or second cancel path must not transition (or count) again.
      assert.equal(await cancelCapacityWait(store, podId), null);
      assert.equal(await finishCapacityWait(store, podId, "expired"), null);
      assert.equal(await heartbeatCapacityWait(store, podId), null);
      const row = await getCapacityWait(store, podId);
      assert.equal(row?.status, "cancelled");
    });

    it("dry-runs without touching rows and archives only workspace-less rows", async () => {
      const archivable = await seedPod({ providerState: "gone", reason: "operation failed" });
      const withWorkspace = await seedPod({ providerState: "gone", sandboxId: "sbx-live-1" });
      const alreadyGone = await seedPod({ state: "archived", providerState: "gone" });

      const dry = await reconcileGoneRows({ dryRun: true, actorId: null, log: quiet });
      const decisions = new Map(dry.plans.map((p) => [p.row.id, p.decision]));
      assert.equal(decisions.get(archivable), "archive");
      assert.equal(decisions.get(withWorkspace), "refuse");
      assert.equal(decisions.get(alreadyGone), "skip");
      const untouched = await query<{ state: string }>("SELECT state FROM pods WHERE id = $1", [archivable]);
      assert.equal(untouched.rows[0]?.state, "active");

      const applied = await reconcileGoneRows({ dryRun: false, actorId: null, log: quiet });
      assert.deepEqual(applied.archived, [archivable]);
      assert.deepEqual(applied.refused, [withWorkspace]);
      const archived = await query<{ state: string; provider_state: string; state_reason: string }>(
        "SELECT state, provider_state, state_reason FROM pods WHERE id = $1",
        [archivable],
      );
      assert.equal(archived.rows[0]?.state, "archived");
      assert.equal(archived.rows[0]?.provider_state, "gone");
      assert.equal(archived.rows[0]?.state_reason, "operation failed");
      // The refused row still names its workspace and is byte-identical.
      const refused = await query<{ state: string; provider_sandbox_id: string }>(
        "SELECT state, provider_sandbox_id FROM pods WHERE id = $1",
        [withWorkspace],
      );
      assert.equal(refused.rows[0]?.state, "active");
      assert.equal(refused.rows[0]?.provider_sandbox_id, "sbx-live-1");

      // findGoneRows still surfaces the refused row for operator adjudication.
      const remaining = await findGoneRows();
      assert.ok(remaining.some((r) => r.id === withWorkspace));
    });

    it("classifies gone rows without a database", () => {
      const base = {
        id: "p",
        org_id: "o",
        user_id: "u",
        name: "n",
        provider: "sandbox",
        created_at: new Date().toISOString(),
        provider_state_changed_at: new Date().toISOString(),
        has_unresolved_create_attempt: false,
      };
      assert.equal(
        classifyGoneRow({ ...base, state: "active", provider_state: "gone", provider_sandbox_id: null, state_reason: null }).decision,
        "archive",
      );
      assert.equal(
        classifyGoneRow({ ...base, state: "active", provider_state: "gone", provider_sandbox_id: "sbx-1", state_reason: null }).decision,
        "refuse",
      );
      assert.equal(
        classifyGoneRow({ ...base, state: "archived", provider_state: "gone", provider_sandbox_id: null, state_reason: null }).decision,
        "skip",
      );
    });

    it("gates gone rows behind includeGone in listings", async () => {
      const gone = await seedPod({ state: "archived", providerState: "gone", reason: "operation failed" });
      const listed = await listPods({ orgId, limit: 100 });
      assert.ok(!listed.some((p) => p.id === gone), "default listings still omit gone rows");
      const withGone = await listPods({ orgId, limit: 100, includeGone: true });
      assert.ok(withGone.some((p) => p.id === gone), "includeGone surfaces them for gc/diagnostics");
    });

    it("finishWaitExpired counts exactly once and reports a lost race", async () => {
      const podId = await seedPod();
      await seedWait(podId);
      const before = await waitOutcomeCount("expired");
      const finished = await finishWaitExpired(store, podId);
      assert.equal(finished?.status, "expired");
      assert.equal(await waitOutcomeCount("expired"), before + 1);
      // A second caller (late waiter tick) loses: no transition, no count.
      assert.equal(await finishWaitExpired(store, podId), null);
      assert.equal(await waitOutcomeCount("expired"), before + 1);
      // A synchronous cancel wins the race the same way: the expiry branch
      // must end as cancelled, never observe expired over it.
      const cancelled = await seedPod();
      await seedWait(cancelled);
      await cancelCapacityWait(store, cancelled);
      assert.equal(await finishWaitExpired(store, cancelled), null);
      assert.equal(await waitOutcomeCount("expired"), before + 1);
    });

    it("claimOrphanedWait counts orphaned exactly once", async () => {
      const podId = await seedPod();
      await seedWait(podId);
      const before = await waitOutcomeCount("orphaned");
      const claimed = await claimOrphanedWait(store, podId);
      assert.equal(claimed?.status, "expired");
      assert.equal(await waitOutcomeCount("orphaned"), before + 1);
      assert.equal(await claimOrphanedWait(store, podId), null);
      assert.equal(await waitOutcomeCount("orphaned"), before + 1);
    });

    it("orphan handling does nothing when a concurrent waiter already decided", async () => {
      const podId = await seedPod({ providerState: "provisioning" });
      await seedWait(podId);
      await query(`UPDATE pod_capacity_wait SET heartbeat_at = now() - make_interval(secs => 120) WHERE pod_id = $1`, [
        podId,
      ]);
      const stale = (await findOrphanedWaits(store, 30_000)).find((r) => r.pod_id === podId);
      assert.ok(stale, "row reads as orphaned");
      // The waiter wins the race after the sweep's stale read.
      await cancelCapacityWait(store, podId);
      const orphanedBefore = await waitOutcomeCount("orphaned");
      await failWaitPod(stale, "orphaned", quiet, null);
      assert.equal((await getCapacityWait(store, podId))?.status, "cancelled");
      const pod = await query<{ state_reason: string | null }>("SELECT state_reason FROM pods WHERE id = $1", [
        podId,
      ]);
      assert.equal(pod.rows[0]?.state_reason, null, "no failure recorded over the decided outcome");
      assert.equal(await waitOutcomeCount("orphaned"), orphanedBefore, "no second count");
    });

    it("expired handling re-checks the row before recording a failure", async () => {
      const podId = await seedPod({ providerState: "provisioning" });
      await seedWait(podId);
      await query(`UPDATE pod_capacity_wait SET deadline_at = now() - make_interval(secs => 1) WHERE pod_id = $1`, [
        podId,
      ]);
      const expired = await expireDueWaits(store);
      const stale = expired.find((r) => r.pod_id === podId);
      assert.ok(stale, "tick transitioned the row");
      // The row vanishes before failure recording: leave the pod alone.
      await query(`DELETE FROM pod_capacity_wait WHERE pod_id = $1`, [podId]);
      const expiredBefore = await waitOutcomeCount("expired");
      await failWaitPod(stale, "expired", quiet, null);
      const pod = await query<{ state: string; state_reason: string | null }>(
        "SELECT state, state_reason FROM pods WHERE id = $1",
        [podId],
      );
      assert.equal(pod.rows[0]?.state, "active");
      assert.equal(pod.rows[0]?.state_reason, null);
      assert.equal(await waitOutcomeCount("expired"), expiredBefore);
    });

    it("expired handling still records when the re-check passes", async () => {
      const podId = await seedPod({ providerState: "provisioning" });
      await seedWait(podId);
      await query(`UPDATE pod_capacity_wait SET deadline_at = now() - make_interval(secs => 1) WHERE pod_id = $1`, [
        podId,
      ]);
      const expired = await expireDueWaits(store);
      const stale = expired.find((r) => r.pod_id === podId);
      assert.ok(stale);
      const expiredBefore = await waitOutcomeCount("expired");
      await failWaitPod(stale, "expired", quiet, null);
      const pod = await query<{ state: string; state_reason: string }>(
        "SELECT state, state_reason FROM pods WHERE id = $1",
        [podId],
      );
      assert.equal(pod.rows[0]?.state, "archived");
      assert.match(pod.rows[0]?.state_reason ?? "", /^launch_failed:capacity_wait_expired: /);
      assert.equal(await waitOutcomeCount("expired"), expiredBefore + 1);
    });

    it("wake orphan handling does nothing when the waiter already decided", async () => {
      const podId = await seedPod({ providerState: "starting", sandboxId: "sbx-w1" });
      await seedWait(podId, { kind: "wake", intent: { fromState: "stopped" } });
      await query(`UPDATE pod_capacity_wait SET heartbeat_at = now() - make_interval(secs => 120) WHERE pod_id = $1`, [
        podId,
      ]);
      const stale = (await findOrphanedWaits(store, 30_000)).find((r) => r.pod_id === podId);
      assert.ok(stale, "row reads as orphaned");
      await cancelCapacityWait(store, podId);
      const orphanedBefore = await waitOutcomeCount("orphaned");
      await failWakeWaitPod(stale, "orphaned", quiet);
      const pod = await query<{ provider_state: string; state_reason: string | null }>(
        "SELECT provider_state, state_reason FROM pods WHERE id = $1",
        [podId],
      );
      assert.equal(pod.rows[0]?.provider_state, "starting", "no rollback over the decided outcome");
      assert.equal(pod.rows[0]?.state_reason, null);
      assert.equal(await waitOutcomeCount("orphaned"), orphanedBefore);
    });

    it("successful orphan reaping counts orphaned exactly once (create)", async () => {
      const podId = await seedPod({ providerState: "provisioning" });
      await seedWait(podId);
      await query(`UPDATE pod_capacity_wait SET heartbeat_at = now() - make_interval(secs => 120) WHERE pod_id = $1`, [
        podId,
      ]);
      const orphanedBefore = await waitOutcomeCount("orphaned");
      await runCapacityWaitSweep({ log: quiet, env: {} });
      assert.equal((await getCapacityWait(store, podId))?.status, "expired");
      const pod = await query<{ state: string; state_reason: string }>(
        "SELECT state, state_reason FROM pods WHERE id = $1",
        [podId],
      );
      assert.equal(pod.rows[0]?.state, "archived");
      assert.match(pod.rows[0]?.state_reason ?? "", /^launch_failed:capacity_wait_orphaned: /);
      assert.equal(await waitOutcomeCount("orphaned"), orphanedBefore + 1);
    });

    it("successful orphan reaping counts orphaned exactly once (wake)", async () => {
      const podId = await seedPod({ providerState: "starting", sandboxId: "sbx-w3" });
      await seedWait(podId, { kind: "wake", intent: { fromState: "stopped" } });
      await query(`UPDATE pod_capacity_wait SET heartbeat_at = now() - make_interval(secs => 120) WHERE pod_id = $1`, [
        podId,
      ]);
      const orphanedBefore = await waitOutcomeCount("orphaned");
      await runCapacityWaitSweep({ log: quiet, env: {} });
      assert.equal((await getCapacityWait(store, podId))?.status, "expired");
      const pod = await query<{ provider_state: string }>("SELECT provider_state FROM pods WHERE id = $1", [podId]);
      assert.equal(pod.rows[0]?.provider_state, "stopped");
      assert.equal(await waitOutcomeCount("orphaned"), orphanedBefore + 1);
    });

    it("wake expiry renders state_reason from the validated display only", async () => {
      const podId = await seedPod({ providerState: "starting", sandboxId: "sbx-w2" });
      await seedWait(podId, {
        kind: "wake",
        intent: { fromState: "stopped" },
        reason: "disk_capacity; DROP TABLE pods --",
        detail: null,
      });
      await query(`UPDATE pod_capacity_wait SET deadline_at = now() - make_interval(secs => 1) WHERE pod_id = $1`, [
        podId,
      ]);
      await runCapacityWaitSweep({ log: quiet, env: {} });
      const pod = await query<{ provider_state: string; state_reason: string }>(
        "SELECT provider_state, state_reason FROM pods WHERE id = $1",
        [podId],
      );
      assert.equal(pod.rows[0]?.provider_state, "stopped", "stuck claim rolled back to intent");
      assert.equal(
        pod.rows[0]?.state_reason,
        "wake wait expired: fleet_capacity \u2014 workspace untouched, retry the wake",
      );
      assert.ok(!pod.rows[0]?.state_reason.includes("DROP TABLE"), "raw row text never enters state_reason");
    });
  },
);
