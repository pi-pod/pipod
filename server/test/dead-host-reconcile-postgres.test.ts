import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { addSandboxHost, drainSandboxHost, getSandboxHost, reconcileDeadSandboxHost, removeSandboxHost } from "../src/server/pods/sandboxfleet.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
describe("explicit dead-host reconciliation", { skip: !databaseUrl }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const hostId = `dead-${uuidv7()}`;
  const url = `http://${hostId}.invalid:8433`;
  const config = { config: { providers: { sandbox: { url } } } };
  const approvals = { dryRun: false, expectedUrl: url, hostDeletedConfirmed: true, quiescenceConfirmed: true, acceptWorkspaceLoss: true, reason: "operator@example.test incident-123 VM deletion confirmed" };
  const created: string[] = [];
  async function pod(state: string, providerState: string, podUrl = url, provider = "sandbox") {
    const id = uuidv7();
    created.push(id);
    await query(`INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config, work_lease_until)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '1 hour')`,
    [id, orgId, userId, id, provider, `sandbox-${id}`, state, providerState, JSON.stringify({ config: { providers: { sandbox: { url: podUrl } } } })]);
    return id;
  }
  async function auditCount() {
    return Number((await query(`SELECT count(*) AS n FROM audit_log WHERE org_id = $1`, [orgId])).rows[0]!.n);
  }
  before(async () => {
    initPool(databaseUrl!);
    await query(`INSERT INTO organizations (id, name) VALUES ($1, 'dead host test')`, [orgId]);
    await query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await addSandboxHost(hostId, url);
  });
  after(async () => {
    await query(`DELETE FROM audit_log WHERE org_id = $1`, [orgId]);
    await query(`DELETE FROM pods WHERE org_id = $1`, [orgId]);
    await query(`DELETE FROM sandbox_hosts WHERE id = $1`, [hostId]);
    await query(`DELETE FROM users WHERE id = $1`, [userId]);
    await query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await closePool();
  });

  it("requires every attestation, exact URL and draining host; default inventory writes nothing", async () => {
    await pod("active", "archived");
    await pod("active", "gone");
    await pod("archived", "archived");
    await pod("archived", "gone");
    const before = (await query(`SELECT * FROM pods WHERE org_id = $1 ORDER BY id`, [orgId])).rows;
    const plan = await reconcileDeadSandboxHost(hostId);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.pods.map((p) => p.action).sort(), ["converge", "converge", "converge", "unchanged"]);
    assert.deepEqual((await query(`SELECT * FROM pods WHERE org_id = $1 ORDER BY id`, [orgId])).rows, before);
    assert.equal(await auditCount(), 0);
    await assert.rejects(removeSandboxHost(hostId), /still point/);
    for (const key of ["hostDeletedConfirmed", "quiescenceConfirmed", "acceptWorkspaceLoss"] as const) {
      await assert.rejects(reconcileDeadSandboxHost(hostId, { ...approvals, [key]: false }), /requires/);
    }
    await assert.rejects(reconcileDeadSandboxHost(hostId, { ...approvals, expectedUrl: undefined }), /requires/);
    await assert.rejects(reconcileDeadSandboxHost(hostId, { ...approvals, reason: " " }), /requires/);
    await assert.rejects(reconcileDeadSandboxHost(hostId, { ...approvals, expectedUrl: "http://wrong.invalid" }), /does not match/);
    await assert.rejects(reconcileDeadSandboxHost(hostId, approvals), /drained/);
    await assert.rejects(reconcileDeadSandboxHost("missing-host", approvals), /no sandbox host/);
    await drainSandboxHost(hostId);
  });

  it("refuses the entire transaction on unexpected live or logical states", async () => {
    for (const [state, providerState] of [["active", "started"], ["active", "error"], ["deleted", "gone"]]) {
      const id = await pod(state!, providerState!);
      const before = (await query(`SELECT * FROM pods WHERE org_id = $1 ORDER BY id`, [orgId])).rows;
      assert.equal((await reconcileDeadSandboxHost(hostId)).pods.find((p) => p.id === id)?.action, "refuse");
      await assert.rejects(reconcileDeadSandboxHost(hostId, approvals), /unexpected/);
      assert.deepEqual((await query(`SELECT * FROM pods WHERE org_id = $1 ORDER BY id`, [orgId])).rows, before);
      assert.equal(await auditCount(), 0);
      await query(`DELETE FROM pods WHERE id = $1`, [id]);
    }
  });

  it("CLI refuses ambiguous, unknown and missing options without mutations", async () => {
    for (const args of [["--yes", "--dry-run"], ["--yess"], ["--expected-url"], ["--yes"]]) {
      const child = spawnSync(process.execPath, ["--import", "tsx", "src/server/pods/sandboxfleet-cli.ts", "reconcile-dead-host", hostId, ...args], {
        env: { ...process.env, DATABASE_URL: databaseUrl! }, encoding: "utf8",
      });
      assert.notEqual(child.status, 0, child.stdout + child.stderr);
    }
    const dryRun = spawnSync(process.execPath, ["--import", "tsx", "src/server/pods/sandboxfleet-cli.ts", "reconcile-dead-host", hostId], {
      env: { ...process.env, DATABASE_URL: databaseUrl! }, encoding: "utf8",
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /dry-run/);
    assert.match(dryRun.stdout, /3 to converge; 1 already terminal; 0 refused/);
    assert.equal(await auditCount(), 0);
  });

  it("rolls mutations back if audit insertion fails", async () => {
    // Isolated fixture: a temporary test trigger rejects only this org's audit.
    const trigger = `dead_host_audit_${orgId.replaceAll("-", "")}`;
    await query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.org_id::text = '${orgId}' THEN RAISE EXCEPTION 'audit test refusal'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      await assert.rejects(reconcileDeadSandboxHost(hostId, approvals), /audit test refusal/);
      assert.equal((await query(`SELECT state FROM pods WHERE id = $1`, [created[0]])).rows[0]!.state, "active");
      assert.equal(await auditCount(), 0);
    } finally {
      await query(`DROP TRIGGER ${trigger} ON audit_log`);
      await query(`DROP FUNCTION ${trigger}()`);
    }
  });

  it("converges terminal combinations, retains history, audits atomically and permits ordinary remove", async () => {
    const otherHost = await pod("active", "archived", "http://other.invalid:8433");
    const otherProvider = await pod("active", "archived", url, "host");
    const result = await reconcileDeadSandboxHost(hostId, approvals);
    assert.equal(result.pods.length, 4);
    assert.equal(result.pods.filter((p) => p.action === "converge").length, 3);
    const rows = (await query(`SELECT * FROM pods WHERE id = ANY($1::uuid[]) ORDER BY id`, [created.slice(0, 4)])).rows;
    for (const row of rows) {
      assert.equal(row.state, "archived");
      assert.equal(row.provider_state, "gone");
      assert.equal(row.provider_sandbox_id, `sandbox-${row.id}`);
      assert.deepEqual(row.resolved_config, config);
    }
    for (const row of rows.filter((row) => row.id !== created[3])) {
      assert.ok(row.archived_at);
      assert.equal(row.work_lease_until, null);
      assert.match(row.state_reason, /permanently deleted/);
    }
    assert.equal(await auditCount(), 3);
    const audits = (await query(`SELECT * FROM audit_log WHERE org_id = $1`, [orgId])).rows;
    for (const entry of audits) {
      assert.equal(entry.action, "pod.reconcile_dead_host");
      assert.equal(entry.detail.operatorReason, approvals.reason);
      assert.equal(entry.detail.workspaceLossAccepted, true);
      assert.equal(entry.detail.hostUrl, url);
    }
    for (const id of [otherHost, otherProvider]) {
      assert.equal((await query(`SELECT state FROM pods WHERE id = $1`, [id])).rows[0]!.state, "active");
    }
    const retry = await reconcileDeadSandboxHost(hostId, approvals);
    assert.ok(retry.pods.every((p) => p.action === "unchanged"));
    assert.equal(await auditCount(), 3);
    const cliRetry = spawnSync(process.execPath, ["--import", "tsx", "src/server/pods/sandboxfleet-cli.ts", "reconcile-dead-host", hostId,
      "--yes", "--expected-url", url, "--host-deleted-confirmed", "--quiescence-confirmed", "--accept-workspace-loss", "--reason", approvals.reason], {
      env: { ...process.env, DATABASE_URL: databaseUrl! }, encoding: "utf8",
    });
    assert.equal(cliRetry.status, 0, cliRetry.stderr);
    assert.match(cliRetry.stdout, /applied/);
    assert.match(cliRetry.stdout, /0 to converge; 4 already terminal; 0 refused/);
    assert.equal(await auditCount(), 3);
    await removeSandboxHost(hostId);
    assert.equal(await getSandboxHost(hostId), null);
  });
});
