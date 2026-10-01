/**
 * Non-owner runtime ACL model (production evidence 2026-09-06, production-acl.jsonl):
 * production runs as pi_pod_app (NON-owner; current_user = session_user = pi_pod_app)
 * while pi_pod_migration owns the schema. Owner pi_pod_migration's default ACL grants
 * pi_pod_app arwd on public tables and rwU on sequences, so new tables inherit
 * read/write without explicit grants.
 *
 * This test connects AS pi_pod_app (LOGIN role, exactly like production) with ONLY the
 * default-ACL-equivalent table privileges, then runs the foundation's new query paths
 * (quota counts, retention records, plan/apply/status). If a future query needs more
 * (TRUNCATE, DDL, sequence creation), it fails here — not in production.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { closePool, initPool, query, tx } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  acquireQuotaLocks,
  assertQuotaRoomTx,
  countQuota,
  countQuarantined,
  orgConcurrencyCapTx,
} from "../src/server/pods/concurrency.js";
import { createRetentionRecord, readRetentionRecord } from "../src/server/pods/retention-policy.js";
import {
  applyRetentionPlan,
  planRetention,
  retentionStatus,
  type Custody,
} from "../src/server/pods/retention-reconciler.js";

const ownerUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const APP_PASSWORD = "acl-model-test-only";

// Exactly the production default ACL (owner pi_pod_migration → pi_pod_app on public):
// tables arwd (INSERT=a, SELECT=r, UPDATE=w, DELETE=d). Foundation paths create no
// sequences (uuid defaults only), matching the evidence (rwU unused here).
const FOUNDATION_TABLES = [
  "pod_retention",
  "pods",
  "settings",
  "audit_log",
  "sandbox_hosts",
  "secrets",
];

function appUrl(): string {
  const url = new URL(ownerUrl!);
  url.username = "pi_pod_app";
  url.password = APP_PASSWORD;
  return url.toString();
}

describe("non-owner runtime ACL model (postgres)", {
  skip: ownerUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  let appPool: pg.Pool | null = null;

  const deps = {
    deploymentMaxMinutes: 60,
    platformToken: null as string | null,
    resolveCustody: (async (): Promise<Custody> => "platform") as () => Promise<Custody>,
  };

  before(async () => {
    initPool(ownerUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'acl model test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    const podId = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
                         provider_state_changed_at, resolved_config)
       VALUES ($1, $2, $3, 'acl fixture', 'sandbox', NULL, 'active', 'stopped', now() - interval '2 hours', '{}'::jsonb)`,
      [podId, orgId, userId],
    );
    // Build the production role split locally: LOGIN role + default-ACL-equivalent grants.
    await query(`DROP ROLE IF EXISTS pi_pod_app`);
    await query(`CREATE ROLE pi_pod_app LOGIN PASSWORD '${APP_PASSWORD}'`);
    for (const table of FOUNDATION_TABLES) {
      await query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO pi_pod_app`);
    }
    // Sanity: the model really is non-owner and really is pi_pod_app.
    appPool = new pg.Pool({ connectionString: appUrl() });
    const who = await appPool.query("SELECT current_user, session_user");
    assert.equal(who.rows[0].current_user, "pi_pod_app");
    // Swap the module pool so every server query path runs as the app role.
    await closePool();
    initPool(appUrl());
  });

  after(async () => {
    await appPool?.end().catch(() => {});
    appPool = null;
    await closePool();
    initPool(ownerUrl!);
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]).catch(() => {});
    await query("DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM pi_pod_app`).catch(() => {});
    await query(`DROP ROLE IF EXISTS pi_pod_app`);
    await closePool();
  });

  it("runs quota counts and advisory-lock checks as the app role", async () => {
    assert.deepEqual(await countQuota(orgId, userId), { globalUser: 0, org: 0 });
    assert.deepEqual(await countQuarantined(orgId, userId), { globalUser: 0, org: 0 });
    const cap = await tx(async (client) => orgConcurrencyCapTx(client, orgId));
    assert.equal(cap, undefined);
  });

  it("writes and reads retention records as the app role", async () => {
    const pods = await query<{ id: string }>(`SELECT id FROM pods WHERE org_id = $1`, [orgId]);
    const podId = pods.rows[0]!.id;
    await tx(async (client) => {
      await acquireQuotaLocks(client, orgId, userId);
      await assertQuotaRoomTx(client, {
        orgId,
        userId,
        perUserCap: 20,
        orgCap: await orgConcurrencyCapTx(client, orgId),
      });
      await createRetentionRecord(client, { podId, desiredMinutes: 60, credentialSource: "platform" });
    });
    const record = await readRetentionRecord(podId);
    assert.equal(record?.desired_archive_after_minutes, 60);
    assert.equal(record?.credential_source, "platform");
  });

  it("runs plan/apply/status as the app role without provider convergence", async () => {
    const plan = await planRetention({ ...deps, includeProviderReads: false });
    const mine = { ...plan, entries: plan.entries.filter((e) => e.orgId === orgId) };
    assert.equal(mine.entries.length, 1);
    // No platform token in this model: scoped provider convergence cannot run, so the
    // record write + skipped-provider path is what must work under the role.
    const applied = await applyRetentionPlan(plan, {
      ...deps,
      approved: true,
      actorId: userId,
    });
    assert.equal(
      applied.failed.filter((f) => mine.entries.some((e) => e.podId === f.podId)).length,
      0,
    );
    const status = await retentionStatus();
    assert.ok(status.totalPods >= 1);
  });

  it("cannot escalate beyond the default ACL (no TRUNCATE/DDL)", async () => {
    await assert.rejects(query(`TRUNCATE pod_retention`), /permission denied/);
  });
});
