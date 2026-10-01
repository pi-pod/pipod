import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { GatewayService } from "../src/server/gateway/service.js";
import { uuidv7 } from "../src/server/ids.js";
import { listPods } from "../src/server/pods/store.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("abandoned pre-sandbox provisioning (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  const preparedPodId = uuidv7();
  const env = { GATEWAY_ID: "gateway-abandoned-test" } as unknown as ServerEnv;
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const log = { info: () => {}, warn: () => {}, error: () => {} };

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'abandoned provisioning test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    for (const [id, name] of [[podId, "ambiguous launch"], [preparedPodId, "unsent launch"]] as const) {
      await query(
        `INSERT INTO pods
           (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
            provider_state_changed_at, provisioning_heartbeat_at, resolved_config)
         VALUES ($1, $2, $3, $4, 'sandbox', NULL, 'active', 'provisioning',
                 now() - interval '1 day', now() - interval '1 day',
                 '{"config":{"providers":{"sandbox":{}}},"workdir":"/workspace"}'::jsonb)`,
        [id, orgId, userId, name],
      );
    }
    await query(
      `INSERT INTO pod_create_attempts
         (pod_id,org_id,user_id,provider,attempt_no,operation_key,phase,owner_epoch,
          owner_instance_id,reason_code)
       VALUES ($1,$2,$3,'sandbox',1,$4,'unknown',1,$5,'original_outcome_unknown')`,
      [podId, orgId, userId, `create-${randomBytes(24).toString("base64url")}`, uuidv7()],
    );
    await query(
      `INSERT INTO pod_create_attempts
         (pod_id,org_id,user_id,provider,attempt_no,operation_key,phase,owner_epoch,
          owner_instance_id,owner_token,owner_lease_until,reason_code)
       VALUES ($1,$2,$3,'sandbox',1,$4,'prepared',1,$5,$6,now()-interval '1 day','launch_prepared')`,
      [preparedPodId, orgId, userId, `create-${randomBytes(24).toString("base64url")}`, uuidv7(), uuidv7()],
    );
  });

  after(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]);
    await query("DELETE FROM pod_create_attempts WHERE pod_id = ANY($1::uuid[])", [[podId, preparedPodId]]);
    await query("DELETE FROM pods WHERE id = ANY($1::uuid[])", [[podId, preparedPodId]]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("keeps a dispatched unknown create held but closes an unsent prepared attempt", async () => {
    const gateway = new GatewayService({ env, kek, log });
    await gateway.failAbandonedProvisioning();

    const ambiguous = await query<{ provider_state: string; state: string; provider_sandbox_id: string | null }>(
      "SELECT provider_state,state,provider_sandbox_id FROM pods WHERE id=$1", [podId],
    );
    assert.equal(ambiguous.rows[0]?.provider_state, "provisioning");
    assert.equal(ambiguous.rows[0]?.state, "active");
    assert.equal(ambiguous.rows[0]?.provider_sandbox_id, null);
    const attempt = await query<{ phase: string; reason_code: string | null }>(
      "SELECT phase,reason_code FROM pod_create_attempts WHERE pod_id=$1", [podId],
    );
    assert.equal(attempt.rows[0]?.phase, "unknown");
    assert.equal(attempt.rows[0]?.reason_code, "original_host_identity_unavailable");
    assert.equal((await listPods({ orgId, userId, limit: 100 })).some((pod) => pod.id === podId), true);

    const preparedPod = await query<{ state: string; provider_state: string }>(
      "SELECT state,provider_state FROM pods WHERE id=$1", [preparedPodId],
    );
    assert.equal(preparedPod.rows[0]?.state, "archived");
    assert.equal(preparedPod.rows[0]?.provider_state, "gone");
    const preparedAttempt = await query<{ phase: string }>(
      "SELECT phase FROM pod_create_attempts WHERE pod_id=$1", [preparedPodId],
    );
    assert.equal(preparedAttempt.rows[0]?.phase, "aborted_unsent");
  });
});
