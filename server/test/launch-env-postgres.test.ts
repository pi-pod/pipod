import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  loadPodLaunchEnv,
  savePodLaunchEnv,
} from "../src/server/pods/launchenv.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

/** Encrypted pod launch-env custody: v2 writes bound to the pod, legacy rows still resume. */
describe("pod launch env custody (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  const otherPodId = uuidv7();
  const kek = new EnvKekProvider("launch-env-test-kek", randomBytes(32).toString("base64"));

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'launch env test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    for (const id of [podId, otherPodId]) {
      await query(
        `INSERT INTO pods
           (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
         VALUES ($1, $2, $3, $4, 'sandbox', 'active', 'started', '{}'::jsonb)`,
        [id, orgId, userId, `launch-env-${id}`],
      );
    }
  });

  beforeEach(async () => {
    await query("DELETE FROM pod_launch_env WHERE pod_id IN ($1, $2)", [podId, otherPodId]);
  });

  after(async () => {
    await query("DELETE FROM pod_launch_env WHERE pod_id IN ($1, $2)", [podId, otherPodId]);
    await query("DELETE FROM pods WHERE id IN ($1, $2)", [podId, otherPodId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("round-trips a project layer as version 2 and clears the row on empty save", async () => {
    assert.deepEqual(await loadPodLaunchEnv(kek, podId), { project: {} });
    await savePodLaunchEnv({ kek, podId, layers: { project: { PROJECT_KEY: "p" } } });
    assert.deepEqual(await loadPodLaunchEnv(kek, podId), { project: { PROJECT_KEY: "p" } });
    const stored = await query<{ encryption_version: number; key_id: string }>(
      "SELECT encryption_version, key_id FROM pod_launch_env WHERE pod_id = $1",
      [podId],
    );
    assert.equal(Number(stored.rows[0]?.encryption_version), 2);
    assert.equal(stored.rows[0]?.key_id, "launch-env-test-kek");

    await savePodLaunchEnv({ kek, podId, layers: { project: {} } });
    assert.deepEqual(await loadPodLaunchEnv(kek, podId), { project: {} });
    assert.equal(
      (await query("SELECT 1 FROM pod_launch_env WHERE pod_id = $1", [podId])).rowCount,
      0,
      "an empty project layer deletes the row instead of resurrecting stale env",
    );
  });

  it("rejects a row transplanted from another pod instead of replaying its env", async () => {
    await savePodLaunchEnv({ kek, podId, layers: { project: { SECRET_LAYER: "donor" } } });
    const donor = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
      "SELECT ciphertext, key_id, encryption_version FROM pod_launch_env WHERE pod_id = $1",
      [podId],
    );
    const row = donor.rows[0]!;
    await query(
      `INSERT INTO pod_launch_env (pod_id, ciphertext, key_id, encryption_version, host_keys, repo_keys)
       VALUES ($1, $2, $3, $4, '{SECRET_LAYER}', '{SECRET_LAYER}')`,
      [otherPodId, row.ciphertext, row.key_id, row.encryption_version],
    );
    await assert.rejects(() => loadPodLaunchEnv(kek, otherPodId));
    assert.deepEqual(await loadPodLaunchEnv(kek, podId), { project: { SECRET_LAYER: "donor" } });
  });
});
