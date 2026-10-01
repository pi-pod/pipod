/**
 * Reuse is a launch: it brings compute back and lands this launch's secrets on the warm disk,
 * so it belongs in the audit trail next to pod.launch. The claim is what gets audited — the
 * background refresh is deliberately failed here, since it is not what this suite is about.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { registerProvider } from "../src/core/providers/registry.js";
import type { SandboxProvider } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { planPodLaunch } from "../src/server/pods/planning.js";
import { reusePod } from "../src/server/pods/reuse.js";
import type { PodServiceDeps } from "../src/server/pods/types.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const env = { GATEWAY_ID: "gateway-reuse", PI_POD_SANDBOX_TOKEN: "test-provider-key" } as unknown as ServerEnv;
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("pod reuse (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  const kek = new EnvKekProvider("reuse-kek", randomBytes(32).toString("base64"));
  const deps: PodServiceDeps = { env, kek, log };
  // The warm sandbox is gone, so the background refresh gives up right after the claim.
  const provider = { name: "sandbox", capabilities: {}, get: async () => null } as unknown as SandboxProvider;

  before(async () => {
    initPool(databaseUrl!);
    registerProvider("sandbox", async () => () => provider);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'reuse test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    // The frozen report has to agree with what this launch resolves to, or reuse is refused.
    const plan = await planPodLaunch(deps, { orgId, userId, provider: "sandbox" });
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
          resolved_config)
       VALUES ($1, $2, $3, 'reuse pod', 'sandbox', 'reuse-sandbox', 'active', 'stopped', $4::jsonb)`,
      [podId, orgId, userId, JSON.stringify({
        config: { egress: plan.config.egress, image: plan.config.image, providers: {} },
        secretKeys: [],
        workdir: plan.workdir,
        warnings: [],
      })],
    );
  });

  after(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_launch_env WHERE pod_id = $1", [podId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("audits the claim, with the provider and the secret names that traveled", async () => {
    const { pod } = await reusePod(deps, { podId, orgId, userId, provider: "sandbox" });
    assert.equal(pod.id, podId);

    const audited = await query<{ actor_id: string; detail: { provider: string; secretKeys: string[] } }>(
      "SELECT actor_id, detail FROM audit_log WHERE org_id = $1 AND action = 'pod.reuse' AND target_id = $2",
      [orgId, podId],
    );
    assert.equal(audited.rowCount, 1);
    assert.equal(audited.rows[0]!.actor_id, userId);
    assert.deepEqual(audited.rows[0]!.detail, { provider: "sandbox", secretKeys: [] });

    // Let the background refresh finish failing before the pool closes.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await query<{ provider_state: string }>("SELECT provider_state FROM pods WHERE id = $1", [podId]);
      if (row.rows[0]!.provider_state !== "provisioning") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("the reuse refresh never settled");
  });

  it("refuses a pod that is not stopped, and audits nothing", async () => {
    await query("UPDATE pods SET provider_state = 'started' WHERE id = $1", [podId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);

    await assert.rejects(
      () => reusePod(deps, { podId, orgId, userId, provider: "sandbox" }),
      /nothing to reuse/,
    );
    const audited = await query("SELECT 1 FROM audit_log WHERE org_id = $1", [orgId]);
    assert.equal(audited.rowCount, 0);
  });
});
