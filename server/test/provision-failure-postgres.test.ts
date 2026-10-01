import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PiPodError } from "../src/core/errors.js";
import { SandboxApiError } from "../src/core/providers/sandbox/client.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  ADMISSION_DENIED_CODE,
  describeLaunchFailure,
  parseLaunchFailureCode,
  recordProvisioningFailure,
} from "../src/server/pods/provision-failure.js";
import { listPods } from "../src/server/pods/store.js";
import type { ResolvedConfigReport } from "../src/server/pods/types.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
/** Host prose in the fixtures below: it must never reach a row or the audit feed. */
const CANARY = "sk-live-canary-DO-NOT-LEAK";

describe("pre-sandbox provisioning failures (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const beforeSandboxId = uuidv7();
  const afterSandboxId = uuidv7();
  const admissionId = uuidv7();
  const report = {
    image: { status: "failed" },
    warnings: ["provisioning failed: provider at capacity"],
  } as unknown as ResolvedConfigReport;

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'provision failure test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES
         ($1, $4, $5, 'capacity rejection', 'sandbox', NULL, 'active', 'provisioning', '{}'::jsonb),
         ($2, $4, $5, 'post-create failure', 'sandbox', 'sandbox-created', 'active', 'starting', '{}'::jsonb),
         ($3, $4, $5, 'admission refusal', 'sandbox', NULL, 'active', 'provisioning', '{}'::jsonb)`,
      [beforeSandboxId, afterSandboxId, admissionId, orgId, userId],
    );
  });

  after(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("reaps a rejected launch with no sandbox while storing only fail-closed reason and audit", async () => {
    // Fail-closed boundary: the arbitrary caller message never reaches the row or
    // the audit feed; both carry the generic reason instead.
    const probeMessage = "provider admission refused launch at capacity";
    const state = await recordProvisioningFailure({
      podId: beforeSandboxId,
      orgId,
      userId,
      report,
      message: probeMessage,
    });
    assert.equal(state, "gone");

    const row = await query<{ provider_state: string; state_reason: string; reaped_at: string | null }>(
      "SELECT provider_state, state_reason, reaped_at FROM pods WHERE id = $1",
      [beforeSandboxId],
    );
    assert.equal(row.rows[0]?.provider_state, "gone");
    assert.equal(row.rows[0]?.state_reason, "operation failed");
    assert.equal((row.rows[0]?.state_reason ?? "").includes(probeMessage), false);
    assert.notEqual(row.rows[0]?.reaped_at, null);
    const visible = await listPods({ orgId, userId, limit: 100 });
    assert.equal(visible.some((pod) => pod.id === beforeSandboxId), false);

    const audits = await query<{ action: string; detail: { reason: string; beforeSandbox: boolean } }>(
      "SELECT action, detail FROM audit_log WHERE target_id = $1",
      [beforeSandboxId],
    );
    assert.equal(audits.rows[0]?.action, "pod.launch_failed");
    assert.equal(audits.rows[0]?.detail.beforeSandbox, true);
    assert.equal(audits.rows[0]?.detail.reason, "operation failed");
    assert.equal((audits.rows[0]?.detail.reason ?? "").includes(probeMessage), false);
  });

  it("persists the actionable message for a host admission refusal", async () => {
    // The defect this fixes: the host answered 507 with validated numbers and the
    // row still said "operation failed". The message the recorder keeps here is
    // composed inside the leakage boundary (static copy + sanitized detail), so
    // the host's own prose is still absent from the row and the audit feed.
    const throwSite = new PiPodError(`creating a sandbox failed: ${CANARY}`, {
      status: 507,
      cause: new SandboxApiError(507, "admission_denied", CANARY, CANARY, {
        kind: "admission",
        reason: "memory_capacity",
        resource: "memory",
        unit: "bytes",
        retryable: true,
        required: 4294967296,
        available: 3038605312,
        budget: 3038605312,
        committed: 0,
      } as never),
    });
    const { message, code } = describeLaunchFailure(throwSite);
    assert.equal(code, ADMISSION_DENIED_CODE);
    const state = await recordProvisioningFailure({
      podId: admissionId,
      orgId,
      userId,
      report,
      message,
      code,
    });
    assert.equal(state, "gone");

    const row = await query<{ state_reason: string }>(
      "SELECT state_reason FROM pods WHERE id = $1",
      [admissionId],
    );
    const reason = row.rows[0]?.state_reason ?? "";
    assert.equal(
      reason,
      "launch_failed:admission_denied: sandbox hosts at capacity (memory_capacity): " +
        "4.00 GiB required, 2.83 GiB available of 2.83 GiB budget",
    );
    assert.equal(parseLaunchFailureCode(reason), ADMISSION_DENIED_CODE);
    assert.equal(reason.includes(CANARY), false);

    const audits = await query<{ detail: { reason: string } }>(
      "SELECT detail FROM audit_log WHERE target_id = $1",
      [admissionId],
    );
    assert.equal(audits.rows[0]?.detail.reason, reason);
  });

  it("keeps a provider-backed failure visible for recovery", async () => {
    const state = await recordProvisioningFailure({
      podId: afterSandboxId,
      orgId,
      userId,
      report,
      message: "sandbox start failed",
    });
    assert.equal(state, "error");
    const visible = await listPods({ orgId, userId, limit: 100 });
    assert.equal(visible.some((pod) => pod.id === afterSandboxId), true);
  });
});
