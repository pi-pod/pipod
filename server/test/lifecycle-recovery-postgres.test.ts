import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { registerProvider } from "../src/core/providers/registry.js";
import type { Sandbox, SandboxProvider, SandboxState } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import { getPod } from "../src/server/pods/store.js";
import { withPodSandbox, type PodServiceDeps } from "../src/server/pods/service.js";
import { snapshotPlatformCredentials } from "../src/server/pods/providercred.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { runReconciler } from "../src/server/workers/reconciler.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const log = { info: () => {}, warn: () => {}, error: () => {} };
// Boot-shaped env (mirrors main(): keys live in the parsed env, never ambient). The
// threaded snapshot below is what withProviderCredential consumes as platform fallback.
const env = {
  GATEWAY_ID: "gateway-lifecycle-recovery",
  PI_POD_SANDBOX_TOKEN: "test-provider-token",
} as unknown as ServerEnv;

describe("stale provider-state recovery (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const deps: PodServiceDeps = { env, kek, log, platformCredentials: snapshotPlatformCredentials(env) };
  let providerState: SandboxState = "stopped";
  let starts = 0;
  let providerSandboxId = "unassigned";

  const sandbox = {
    get id() {
      return providerSandboxId;
    },
    state: async () => providerState,
    start: async () => {
      starts += 1;
      providerState = "started";
    },
  } as unknown as Sandbox;
  let getResults: Array<Sandbox | null> | null = null;
  const provider = {
    name: "sandbox",
    capabilities: {},
    get: async () => (getResults && getResults.length > 0 ? getResults.shift()! : sandbox),
    list: async () => [
      { id: sandbox.id, state: providerState, labels: {}, lastActivityAt: null },
    ],
  } as unknown as SandboxProvider;

  before(async () => {
    initPool(databaseUrl!);
    registerProvider("sandbox", async () => () => provider);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'lifecycle recovery test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
    registerProvider("sandbox", async () => (await import("../src/core/providers/sandbox.js")).createSandboxProvider);
  });

  async function insertStartedPod(): Promise<string> {
    const podId = uuidv7();
    providerSandboxId = `stale-provider-${podId}`;
    providerState = "stopped";
    starts = 0;
    getResults = null;
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'stale provider state', 'sandbox', $4, 'active', 'started', $5::jsonb)`,
      [
        podId,
        orgId,
        userId,
        sandbox.id,
        JSON.stringify({ config: { providers: {} }, workdir: "/workspace" }),
      ],
    );
    return podId;
  }

  for (const providerError of [
    "sandbox stale-provider-sandbox is stopped",
    "sandbox process not found",
    "sandbox stale-provider-sandbox is gone",
  ]) {
    it(`reconciles, starts and retries once after: ${providerError}`, async () => {
      const podId = await insertStartedPod();
      const pod = await getPod(orgId, podId);
      let attempts = 0;

      const session = await withPodSandbox(deps, pod, async () => {
        attempts += 1;
        if (providerState !== "started") throw new Error(providerError);
        return { ready: true };
      });

      assert.deepEqual(session, { ready: true });
      assert.equal(starts, 1);
      assert.equal(attempts, 2);
      const row = await query<{ provider_state: string; state_reason: string | null }>(
        "SELECT provider_state, state_reason FROM pods WHERE id = $1",
        [podId],
      );
      assert.deepEqual(row.rows[0], { provider_state: "started", state_reason: null });
    });
  }

  it("the periodic reconciler also converges a stale started row to stopped", async () => {
    const podId = await insertStartedPod();
    providerState = "stopped";

    await runReconciler({ env, kek, log, gateway: null });

    const row = await query<{ provider_state: string; last_stop_cause: string | null }>(
      "SELECT provider_state, last_stop_cause FROM pods WHERE id = $1",
      [podId],
    );
    assert.deepEqual(row.rows[0], { provider_state: "stopped", last_stop_cause: "provider_stopped" });
  });

  it("does not turn a logically archived pod into an implicit restore", async () => {
    const podId = await insertStartedPod();
    await query("UPDATE pods SET state = 'archived' WHERE id = $1", [podId]);
    const pod = await getPod(orgId, podId);

    await assert.rejects(
      withPodSandbox(deps, pod, async () => {
        throw new Error("sandbox is stopped");
      }),
      (error: unknown) =>
        error instanceof HttpError && error.statusCode === 409 && /restore the pod before using it/.test(error.message),
    );
    assert.equal(starts, 0);
  });

  it("does not condemn a pod as gone on a single provider 404", async () => {
    const podId = await insertStartedPod();
    providerState = "started";
    const pod = await getPod(orgId, podId);
    getResults = [null];

    const session = await withPodSandbox(deps, pod, async () => ({ ready: true }), {
      goneRecheckDelayMs: 10,
    });

    assert.deepEqual(session, { ready: true });
    const row = await query<{ provider_state: string }>(
      "SELECT provider_state FROM pods WHERE id = $1",
      [podId],
    );
    assert.deepEqual(row.rows[0], { provider_state: "started" });
  });

  it("marks a pod gone only after the provider 404 is confirmed", async () => {
    const podId = await insertStartedPod();
    providerState = "started";
    const pod = await getPod(orgId, podId);
    getResults = [null, null];

    await assert.rejects(
      withPodSandbox(deps, pod, async () => assert.fail("a missing sandbox must not run work"), {
        goneRecheckDelayMs: 10,
      }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 404,
    );
    const row = await query<{ provider_state: string }>(
      "SELECT provider_state FROM pods WHERE id = $1",
      [podId],
    );
    assert.deepEqual(row.rows[0], { provider_state: "gone" });
  });

  it("returns a clean explained error when the single retry still fails", async () => {
    const podId = await insertStartedPod();
    const pod = await getPod(orgId, podId);
    let attempts = 0;

    await assert.rejects(
      withPodSandbox(deps, pod, async () => {
        attempts += 1;
        throw new Error(attempts === 1 ? "sandbox process not found" : "sandbox channel unavailable after restart");
      }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 503);
        // Fail-closed: static product message only; the work function's provider
        // prose ("channel unavailable…") never enters the thrown message.
        assert.equal(error.message, "the pod restarted, but the provider operation still failed");
        assert.equal(error.message.includes("channel unavailable"), false);
        return true;
      },
    );
    assert.equal(attempts, 2);
    assert.equal(starts, 1);
  });
});
