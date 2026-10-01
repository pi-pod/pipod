/**
 * Retention reconciler operator flow (plan §3.2): inventory incl. hidden rows,
 * custody-scoped convergence, transactional desired-state records, stale-plan
 * re-resolution, revision-guarded acks, overdue wave.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  applyRetentionPlan,
  planRetention,
  retentionStatus,
  type Custody,
  type RetentionPlan,
} from "../src/server/pods/retention-reconciler.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

/** Minimal fake sandbox host: controllable timer reads + counted retention writes. */
interface FakeHost {
  url: string;
  close(): Promise<void>;
  /** Current provider-side timer per sandbox id. */
  timers: Map<string, number>;
  /** Bodies POSTed to /retention, in order. */
  retentionPosts: Array<{ id: string; body: unknown }>;
  down: boolean;
}

async function startFakeHost(): Promise<FakeHost> {
  const timers = new Map<string, number>();
  const retentionPosts: Array<{ id: string; body: unknown }> = [];
  const state = { down: false };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const retentionMatch = url.match(/^\/v1\/sandboxes\/([^/]+)\/retention$/);
    const infoMatch = url.match(/^\/v1\/sandboxes\/([^/]+)$/);
    if (state.down) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { code: "boom", message: "down" } }));
      return;
    }
    if (req.method === "POST" && retentionMatch) {
      const id = decodeURIComponent(retentionMatch[1]!);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        retentionPosts.push({ id, body });
        if (typeof body.archiveAfterMinutes === "number") timers.set(id, body.archiveAfterMinutes);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ changed: true }));
      });
      return;
    }
    if (req.method === "GET" && infoMatch) {
      const id = decodeURIComponent(infoMatch[1]!);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id,
          labels: {},
          state: "stopped",
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          image: "img",
          workdir: "/workspace",
          tier: "stopped",
          archiveAfterMinutes: timers.get(id) ?? 10080,
          idleTimeoutMinutes: 15,
          resources: {},
          ceiling: {},
          revision: 7,
          runtimeGeneration: 1,
          stoppedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    timers,
    retentionPosts,
    get down() {
      return state.down;
    },
    set down(v: boolean) {
      state.down = v;
    },
  };
}

describe("retention reconciler (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const byokOrgId = uuidv7();
  let host: FakeHost;

  const platformDeps = {
    deploymentMaxMinutes: 60,
    platformToken: "test-token",
    resolveCustody: (async (): Promise<Custody> => "platform") as () => Promise<Custody>,
  };
  const offlinePlatformDeps = { ...platformDeps, includeProviderReads: false as const };

  async function makePod(args: {
    org?: string;
    providerState?: string;
    state?: string;
    archiveMinutes?: number;
    stoppedHoursAgo?: number | null;
    sandboxId?: string | null;
    hostUrl?: string | null;
  } = {}): Promise<string> {
    const id = uuidv7();
    const stoppedAt = args.stoppedHoursAgo == null
      ? new Date().toISOString()
      : new Date(Date.now() - args.stoppedHoursAgo * 3600_000).toISOString();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
                         provider_state_changed_at, resolved_config)
       VALUES ($1, $2, $3, 'ret fixture', 'sandbox', $4, $5, $6, $7, $8::jsonb)`,
      [
        id,
        args.org ?? orgId,
        userId,
        args.sandboxId === null ? null : (args.sandboxId ?? `sb-${id}`),
        args.state ?? "active",
        args.providerState ?? "stopped",
        stoppedAt,
        JSON.stringify({
          config: {
            archiveAfterMinutes: args.archiveMinutes ?? 10080,
            providers: { sandbox: { url: args.hostUrl ?? host.url } },
          },
          workdir: "/workspace",
          retention: {
            idleTimeoutMinutes: 15,
            archiveTransition: { kind: "after-stop", maxDelayDays: 30 },
            effectiveArchiveAfterMinutes: args.archiveMinutes ?? 10080,
            providerExpiryDocumented: true,
          },
        }),
      ],
    );
    return id;
  }

  function scopePlan(plan: RetentionPlan, org: string): RetentionPlan {
    return { ...plan, entries: plan.entries.filter((e) => e.orgId === org) };
  }

  before(async () => {
    initPool(databaseUrl!);
    host = await startFakeHost();
    for (const [id, name] of [[orgId, "retention reconciler test"], [byokOrgId, "retention byok test"]] as const) {
      await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [id, name]);
    }
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await host.close();
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]);
    for (const org of [orgId, byokOrgId]) {
      await query("DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [org]);
      await query("DELETE FROM audit_log WHERE org_id = $1", [org]);
      await query("DELETE FROM pods WHERE org_id = $1", [org]);
      await query("DELETE FROM settings WHERE org_id = $1", [org]);
    }
    await query("DELETE FROM users WHERE id = $1", [userId]);
    for (const org of [orgId, byokOrgId]) await query("DELETE FROM organizations WHERE id = $1", [org]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]);
    for (const org of [orgId, byokOrgId]) {
      await query("DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [org]);
      await query("DELETE FROM pods WHERE org_id = $1", [org]);
      await query("DELETE FROM audit_log WHERE org_id = $1", [org]);
      await query("DELETE FROM settings WHERE org_id = $1", [org]);
    }
    host.timers.clear();
    host.retentionPosts.length = 0;
    host.down = false;
  });

  it("inventories hidden rows and flags legacy 10080 timers for backfill", async () => {
    // A hidden row (logical archive, provider stopped) still holds a disk: it participates.
    await makePod({ state: "archived", providerState: "stopped", stoppedHoursAgo: 48 });
    await makePod({ state: "active", providerState: "started" });
    const plan = scopePlan(await planRetention(offlinePlatformDeps), orgId);
    assert.equal(plan.entries.length, 2);
    assert.equal(plan.migrationId, "platform-60-v1");
    const hidden = plan.entries.find((e) => e.logicalState === "archived")!;
    assert.equal(hidden.providerState, "stopped");
    assert.equal(hidden.requestedMinutes, 10080);
    assert.equal(hidden.effectiveMinutes, 60);
    assert.equal(hidden.custody, "platform");
    assert.equal(hidden.scoped, true);
    assert.equal(hidden.action, "backfill-record");
    assert.equal(hidden.overdue, true);
    assert.equal(plan.overdueCount >= 1, true);
  });

  it("applies desired state transactionally and reports convergence", async () => {
    // No provider sandbox id: provider convergence is skipped, but the record + audit land.
    await makePod({ sandboxId: null, stoppedHoursAgo: 0.1 });
    const plan = scopePlan(await planRetention(offlinePlatformDeps), orgId);
    await assert.rejects(
      applyRetentionPlan(plan, { ...platformDeps, approved: false, actorId: null }),
      /approval/,
    );
    const applied = await applyRetentionPlan(plan, { ...platformDeps, approved: true, actorId: userId });
    assert.equal(applied.recordsWritten, 1);
    const rec = await query(
      "SELECT desired_archive_after_minutes, revision, status, credential_source FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)",
      [orgId],
    );
    assert.equal(Number(rec.rows[0]?.desired_archive_after_minutes), 60);
    assert.equal(Number(rec.rows[0]?.revision), 1);
    assert.equal(rec.rows[0]?.credential_source, "platform");
    const audits = await query("SELECT action FROM audit_log WHERE org_id = $1", [orgId]);
    assert.ok(audits.rows.some((r) => (r as { action: string }).action === "pod.retention_desired"));
    const status = await retentionStatus();
    assert.ok(status.totalPods >= 1);
    assert.ok(status.withRecord >= 1);
  });

  it("converges a live provider timer and acks only the applied revision", async () => {
    const podId = await makePod({ stoppedHoursAgo: 48 });
    host.timers.set(`sb-${podId}`, 10080);
    const plan = scopePlan(await planRetention(platformDeps), orgId);
    const entry = plan.entries.find((e) => e.podId === podId)!;
    assert.equal(entry.providerMinutes, 10080);
    assert.equal(entry.action, "backfill-record");
    const applied = await applyRetentionPlan(plan, { ...platformDeps, approved: true, actorId: userId });
    assert.equal(applied.providerUpdated, 1);
    assert.equal(host.retentionPosts.length, 1);
    assert.equal((host.retentionPosts[0]!.body as { archiveAfterMinutes: number }).archiveAfterMinutes, 60);
    const rec = await query("SELECT status, provider_archive_after_minutes FROM pod_retention WHERE pod_id = $1", [
      podId,
    ]);
    assert.equal(rec.rows[0]?.status, "applied");
    assert.equal(Number(rec.rows[0]?.provider_archive_after_minutes), 60);
  });

  it("never rewrites BYOK timers: unscoped rows are recorded, never converged", async () => {
    const byokDeps = {
      ...platformDeps,
      resolveCustody: (async (org: string): Promise<Custody> =>
        org === byokOrgId ? "org-secret" : "platform") as () => Promise<Custody>,
    };
    const podId = await makePod({ org: byokOrgId, stoppedHoursAgo: 48 });
    host.timers.set(`sb-${podId}`, 10080);
    const plan = scopePlan(await planRetention(byokDeps), byokOrgId);
    const entry = plan.entries.find((e) => e.podId === podId)!;
    // BYOK keeps its documented timer: no deployment clamp, provider untouched.
    assert.equal(entry.custody, "org-secret");
    assert.equal(entry.scoped, false);
    assert.equal(entry.effectiveMinutes, 10080);
    assert.notEqual(entry.action, "update-retention");
    const applied = await applyRetentionPlan(plan, { ...byokDeps, approved: true, actorId: userId });
    assert.equal(applied.skippedUnscoped, 1);
    assert.equal(applied.providerUpdated, 0);
    assert.equal(
      host.retentionPosts.filter((p) => p.id === `sb-${podId}`).length,
      0,
      "no retention POST may reach a BYOK host",
    );
    const rec = await query("SELECT credential_source, status FROM pod_retention WHERE pod_id = $1", [podId]);
    assert.equal(rec.rows[0]?.credential_source, "org-secret");
  });

  it("classifies legacy NULL-custody rows fail-closed (record only, never converge)", async () => {
    const podId = await makePod({ stoppedHoursAgo: 48 });
    host.timers.set(`sb-${podId}`, 10080);
    const unknownDeps = {
      ...platformDeps,
      resolveCustody: (async (): Promise<Custody> => "unknown") as () => Promise<Custody>,
    };
    const plan = scopePlan(await planRetention(unknownDeps), orgId);
    const entry = plan.entries.find((e) => e.podId === podId)!;
    // Unknown custody: no deployment clamp (effective stays requested) and no provider
    // convergence — the record backfill is the only action.
    assert.equal(entry.custody, "unknown");
    assert.equal(entry.scoped, false);
    assert.equal(entry.effectiveMinutes, 10080);
    assert.equal(entry.action, "backfill-record");
    const applied = await applyRetentionPlan(plan, { ...unknownDeps, approved: true, actorId: userId });
    assert.equal(applied.providerUpdated, 0);
    assert.equal(
      host.retentionPosts.filter((p) => p.id === `sb-${podId}`).length,
      0,
      "unknown custody must never reach the provider",
    );
    const rec = await query("SELECT credential_source FROM pod_retention WHERE pod_id = $1", [podId]);
    assert.equal(rec.rows[0]?.credential_source, null);
  });

  it("re-resolves stale plans at apply time instead of acking the old revision", async () => {
    await makePod({ stoppedHoursAgo: 0.1, sandboxId: null });
    const plan = scopePlan(await planRetention(offlinePlatformDeps), orgId);
    assert.equal(plan.entries[0]!.effectiveMinutes, 60);
    // Operator tightens the org policy AFTER the plan was printed.
    await query(
      `INSERT INTO settings (id, scope_type, scope_id, org_id, config)
       VALUES (gen_random_uuid(), 'org_policy', $1, $1, '{"maxArchiveAfterMinutes": 30}'::jsonb)`,
      [orgId],
    );
    const applied = await applyRetentionPlan(plan, { ...platformDeps, approved: true, actorId: userId });
    assert.ok(applied.resolutionsChanged >= 1);
    const rec = await query(
      "SELECT desired_archive_after_minutes FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)",
      [orgId],
    );
    assert.equal(
      Number(rec.rows[0]?.desired_archive_after_minutes),
      30,
      "apply converges to the fresh policy, not the stale plan",
    );
  });

  it("survives double apply without unique violations", async () => {
    const podId = await makePod({ stoppedHoursAgo: 48 });
    host.timers.set(`sb-${podId}`, 10080);
    const first = await applyRetentionPlan(scopePlan(await planRetention(platformDeps), orgId), {
      ...platformDeps,
      approved: true,
      actorId: userId,
    });
    assert.equal(first.failed.length, 0);
    const second = await applyRetentionPlan(scopePlan(await planRetention(platformDeps), orgId), {
      ...platformDeps,
      approved: true,
      actorId: userId,
    });
    // Converged rows leave the todo list: nothing to write, nothing to fail, no
    // unique violation from the concurrent-apply ON CONFLICT path.
    assert.equal(second.failed.length, 0);
    assert.equal(second.recordsWritten, 0);
    const status = await retentionStatus();
    assert.equal(status.applied >= 1, true);
  });
});
