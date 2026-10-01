import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query, tx } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { assertLaunchAllowed, assertLaunchGateOpen, launchGateIsOpen, readLaunchControl, transitionLaunchControl } from "../src/server/pods/launch-control.js";

const databaseUrl = process.env.PI_POD_TEST_DATABASE_URL;
const TEST_SHA = "0000000000000000000000000000000000000000";

async function restoreTestGateFixture(): Promise<void> {
  await query("DELETE FROM launch_recovery_control_events").catch(() => {});
  const updated = await query(
    `UPDATE launch_recovery_control SET mode='held',epoch=1,required_protocol=1,
       cutover_id=gen_random_uuid(),changed_at=now(),actor='migration',reason_code='recovery_cutover'
      WHERE singleton=true RETURNING singleton`,
  ).catch(() => null);
  if ((updated?.rowCount ?? 0) === 0) {
    await query(
      `INSERT INTO launch_recovery_control(singleton,mode,epoch,required_protocol,actor,reason_code)
       VALUES (true,'held',1,1,'migration','recovery_cutover')`,
    );
  }
  await query(
    `INSERT INTO launch_recovery_control_events
       (epoch,cutover_id,previous_mode,new_mode,protocol_version,actor,reason_code)
     SELECT epoch,cutover_id,'held','held',required_protocol,actor,reason_code
       FROM launch_recovery_control WHERE singleton=true`,
  );
  await transitionLaunchControl({
    mode: "open", expectedEpoch: 1, protocolVersion: 1, sourceSha: TEST_SHA,
    actor: "test_runner", reasonCode: "ci_test",
  });
}

describe("durable launch cutover gate (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  const attemptId = uuidv7();

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations(id,name) VALUES ($1,'launch gate test')", [orgId]);
    await query("INSERT INTO users(id,email) VALUES ($1,$2)", [userId, `${userId}@gate.test`]);
  });

  after(async () => {
    await query("DELETE FROM pod_create_attempts WHERE pod_id=$1", [podId]).catch(() => {});
    await query("DELETE FROM pods WHERE id=$1", [podId]).catch(() => {});
    await query("DELETE FROM users WHERE id=$1", [userId]).catch(() => {});
    await query("DELETE FROM organizations WHERE id=$1", [orgId]).catch(() => {});
    await restoreTestGateFixture().catch(() => {});
    await closePool();
  });

  it("refuses unaccounted legacy rows, opens with a hold, and fails closed if control is missing", async () => {
    const initial = await readLaunchControl();
    let epoch = Number(initial.epoch);
    if (initial.mode !== "held") {
      const held = await transitionLaunchControl({
        mode: "held", expectedEpoch: epoch, protocolVersion: 1,
        sourceSha: null, actor: "test_runner", reasonCode: "test_hold",
      });
      epoch = Number(held.epoch);
    }
    await query(
      `INSERT INTO pods
         (id,org_id,user_id,name,provider,state,provider_state,resolved_config,transport)
       VALUES ($1,$2,$3,'unaccounted legacy row','sandbox','active','gone',
         '{"config":{"providers":{"sandbox":{}}},"workdir":"/workspace"}'::jsonb,'ws')`,
      [podId, orgId, userId],
    );
    await assert.rejects(
      transitionLaunchControl({
        mode: "open", expectedEpoch: epoch, protocolVersion: 1,
        sourceSha: TEST_SHA, actor: "test_runner", reasonCode: "test_open",
      }),
      /unaccounted legacy launch rows remain/,
    );
    const stillHeld = await readLaunchControl();
    assert.equal(stillHeld.mode, "held");
    epoch = Number(stillHeld.epoch);

    await query(
      `INSERT INTO pod_create_attempts
         (id,pod_id,org_id,user_id,provider,attempt_no,phase,owner_epoch,reason_code)
       VALUES ($1,$2,$3,$4,'sandbox',0,'legacy_unresolved',1,'legacy_create_outcome_unknown')`,
      [attemptId, podId, orgId, userId],
    );
    const state = await transitionLaunchControl({
      mode: "open", expectedEpoch: epoch, protocolVersion: 1,
      sourceSha: TEST_SHA, actor: "test_runner", reasonCode: "test_open",
    });
    assert.equal(state.mode, "open");
    assert.equal(await launchGateIsOpen(), true);
    await assert.rejects(assertLaunchAllowed(undefined, userId), (error: unknown) =>
      error instanceof Error && (error as { statusCode?: number }).statusCode === 409,
    );

    await tx(async (client) => {
      await client.query("DELETE FROM pod_create_attempts WHERE id=$1", [attemptId]);
      await client.query("DELETE FROM pods WHERE id=$1", [podId]);
    });
    await query("DELETE FROM launch_recovery_control");
    assert.equal(await launchGateIsOpen(), false);
    await assert.rejects(assertLaunchGateOpen(), (error: unknown) =>
      error instanceof Error && (error as { statusCode?: number }).statusCode === 503,
    );
  });
});
