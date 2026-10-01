/**
 * Both concurrency caps — the deployment's per-user one and the org policy's — price sandboxes
 * that are awake at the provider, so a stopped pod frees its slot and waking one has to win a
 * slot back. These are SQL and settings rules, so they need a real database:
 *   PI_POD_TEST_DATABASE_URL=postgres://pipod:pipod@localhost:5432/pipod npm run test:integration
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  AWAKE_PROVIDER_STATES,
  assertRoomToWake,
  countAwakePods,
  countQuarantined,
  orgConcurrencyCap,
} from "../src/server/pods/concurrency.js";
import { ensureProviderPodStartedWithResult } from "../src/server/pods/lifecycle.js";
import type { PodServiceDeps } from "../src/server/pods/types.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("pod concurrency caps (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const neighborOrgId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const log = { info: () => {}, warn: () => {}, error: () => {} };

  /** The pod service with one deployment cap in force; the org cap comes from stored policy. */
  function depsWithPerUserCap(perUserCap: number): PodServiceDeps {
    const env = { LOG_LEVEL: "silent", POD_MAX_CONCURRENT_PER_USER: perUserCap } as unknown as ServerEnv;
    return { env, kek, log };
  }

  /** A pod row with only the columns a cap reads, plus what a wake needs to reach a provider. */
  async function makePod(
    args: { provider?: string; providerState?: string; state?: string; org?: string; owner?: string; sandboxId?: string | null } = {},
  ): Promise<string> {
    const id = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
                         resolved_config)
       VALUES ($1, $2, $3, 'cap fixture', $4, $5, $6, $7, $8::jsonb)`,
      [
        id,
        args.org ?? orgId,
        args.owner ?? userId,
        args.provider ?? "sandbox",
        args.sandboxId === undefined ? `sandbox-${id}` : args.sandboxId,
        args.state ?? "active",
        args.providerState ?? "started",
        JSON.stringify({ config: { providers: {} }, workdir: "/workspace" }),
      ],
    );
    return id;
  }

  async function setPolicy(config: Record<string, unknown>): Promise<void> {
    await query(
      `INSERT INTO settings (id, scope_type, scope_id, org_id, config)
       VALUES ($1, 'org_policy', $2, $2, $3::jsonb)
       ON CONFLICT (scope_type, scope_id, org_id) DO UPDATE SET config = EXCLUDED.config`,
      [uuidv7(), orgId, JSON.stringify(config)],
    );
  }

  async function refused(fn: () => Promise<unknown>): Promise<HttpError> {
    try {
      await fn();
    } catch (e) {
      assert.ok(e instanceof HttpError, `expected an HttpError, got ${String(e)}`);
      return e;
    }
    throw new Error("expected the call to be refused");
  }

  /** The pod as the wake path reads it: an asleep pod, owned by whoever owns it. */
  function sleeper(args: { owner?: string; provider?: string } = {}) {
    return { org_id: orgId, user_id: args.owner ?? userId, provider: args.provider ?? "sandbox" };
  }

  before(async () => {
    initPool(databaseUrl!);
    for (const [id, name] of [[orgId, "concurrency cap test"], [neighborOrgId, "concurrency cap neighbor"]]) {
      await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [id, name]);
    }
    for (const id of [userId, otherUserId]) {
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    }
  });

  after(async () => {
    await query("DELETE FROM audit_log WHERE org_id = ANY($1)", [[orgId, neighborOrgId]]);
    await query("DELETE FROM pods WHERE org_id = ANY($1)", [[orgId, neighborOrgId]]);
    await query("DELETE FROM settings WHERE org_id = ANY($1)", [[orgId, neighborOrgId]]);
    for (const id of [userId, otherUserId]) await query("DELETE FROM users WHERE id = $1", [id]);
    await query("DELETE FROM organizations WHERE id = ANY($1)", [[orgId, neighborOrgId]]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM pods WHERE org_id = ANY($1)", [[orgId, neighborOrgId]]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
  });

  it("counts the pods that hold a sandbox, not the rows that exist", async () => {
    for (const providerState of AWAKE_PROVIDER_STATES) await makePod({ providerState });
    assert.deepEqual(await countAwakePods(orgId, userId), {
      org: AWAKE_PROVIDER_STATES.length,
      user: AWAKE_PROVIDER_STATES.length,
    });

    // A pod on its way down still holds its slot until the stop is confirmed (§7.1):
    // releasing on `stopping` would free a slot for a sandbox that may still be running.
    // Everything already down (or briefly exiting through archive/delete) holds nothing.
    // `error` is quarantined capacity only while it still references a sandbox id.
    for (const asleep of ["stopped", "archiving", "archived", "deleting", "gone"]) {
      await makePod({ providerState: asleep });
    }
    await makePod({ providerState: "error", sandboxId: null });
    await makePod({ providerState: "stopping" });
    // But a pod merely hidden from the active lists, whose sandbox is still up, keeps its slot:
    // the slot follows the sandbox, not the logical state.
    await makePod({ state: "archived" });
    assert.equal((await countAwakePods(orgId, userId)).org, AWAKE_PROVIDER_STATES.length + 2);

    // A co-located pod runs inside another pod's machine, so it never holds a slot of its own.
    await makePod({ provider: "host" });
    assert.equal((await countAwakePods(orgId, userId)).org, AWAKE_PROVIDER_STATES.length + 2);

    // One user's running pods are not another's budget, and one org's are not another's.
    await makePod({ owner: otherUserId });
    const counts = await countAwakePods(orgId, userId);
    assert.equal(counts.org, AWAKE_PROVIDER_STATES.length + 3);
    assert.equal(counts.user, AWAKE_PROVIDER_STATES.length + 2);
    await makePod({ org: neighborOrgId });
    assert.deepEqual(await countAwakePods(neighborOrgId, userId), { org: 1, user: 1 });
  });

  it("quarantines error rows that still reference a sandbox, frees the rest", async () => {
    await makePod({ providerState: "error" });
    await makePod({ providerState: "error", sandboxId: null });
    // The error WITH a sandbox id holds a slot (potentially live provider resources);
    // the error with no sandbox id holds nothing (nothing left to clean up).
    assert.equal((await countAwakePods(orgId, userId)).org, 1);
    assert.deepEqual(await countQuarantined(orgId, userId), { globalUser: 1, org: 1 });
    // Quarantine is per-owner and per-org like every other holding count.
    assert.deepEqual(await countQuarantined(orgId, otherUserId), { globalUser: 0, org: 1 });
    assert.deepEqual(await countQuarantined(neighborOrgId, userId), { globalUser: 1, org: 0 });
  });

  it("takes the org cap from the policy layer, and treats an unusable one as no org cap", async () => {
    assert.equal(await orgConcurrencyCap(orgId), undefined);
    await setPolicy({ maxConcurrentPods: 3 });
    assert.equal(await orgConcurrencyCap(orgId), 3);

    // A stored policy the current schema cannot parse must not wedge every wake in the org.
    await setPolicy({ maxConcurrentPods: "three" });
    assert.equal(await orgConcurrencyCap(orgId), undefined);

    // Neither may a settings read that fails outright.
    await setPolicy({ maxConcurrentPods: 3 });
    await closePool();
    assert.equal(await orgConcurrencyCap(orgId), undefined);
    initPool(databaseUrl!);
  });

  it("refuses a wake once the owner is running as many pods as the deployment allows", async () => {
    const running = await makePod();
    await makePod({ providerState: "stopped" });
    // One awake pod under a cap of two, so the sleeping one still has a slot to wake into.
    await assertRoomToWake(sleeper(), 2);

    await makePod();
    const refusal = await refused(() => assertRoomToWake(sleeper(), 2));
    assert.equal(refusal.statusCode, 409);
    assert.equal(
      refusal.message,
      "this deployment caps concurrent pods per user at 2; stop or let another pod sleep first",
    );

    // Another user's awake pods are not this owner's problem, however many there are.
    for (let i = 0; i < 5; i += 1) await makePod({ owner: otherUserId });
    await assertRoomToWake(sleeper({ owner: otherUserId }), 10);

    // A co-located pod asks its host for room, never the provider, so no cap refuses its wake.
    await assertRoomToWake(sleeper({ provider: "host" }), 1);

    // And the cap frees itself the moment a pod sleeps.
    await query("UPDATE pods SET provider_state = 'stopped' WHERE id = $1", [running]);
    await assertRoomToWake(sleeper(), 2);
  });

  it("refuses a wake the org's own cap has no room for, and names the user's cap first", async () => {
    await setPolicy({ maxConcurrentPods: 2 });
    await makePod({ owner: otherUserId });
    // The org is one pod short of its cap, and this owner has none awake at all.
    await assertRoomToWake(sleeper(), 10);

    await makePod({ owner: otherUserId });
    const orgRefusal = await refused(() => assertRoomToWake(sleeper(), 10));
    assert.equal(orgRefusal.statusCode, 409);
    assert.equal(orgRefusal.message, "org policy caps concurrent pods at 2; stop or let another pod sleep first");

    // When both caps are already met, the one the waker can act on is the one named.
    await makePod();
    const bothRefusal = await refused(() => assertRoomToWake(sleeper(), 1));
    assert.equal(
      bothRefusal.message,
      "this deployment caps concurrent pods per user at 1; stop or let another pod sleep first",
    );
  });

  it("lets a wake through when the org sets no cap of its own", async () => {
    for (let i = 0; i < 5; i += 1) await makePod();
    await assertRoomToWake(sleeper(), 10);
    await setPolicy({ nestedPods: { maxDepth: 1 } });
    await assertRoomToWake(sleeper(), 10);
  });

  it("stops a wake at the cap before the provider is touched", async () => {
    await setPolicy({ maxConcurrentPods: 1 });
    await makePod();
    const sleeping = await makePod({ providerState: "stopped" });

    const refusal = await refused(() =>
      ensureProviderPodStartedWithResult(depsWithPerUserCap(10), { org_id: orgId, id: sleeping }, userId),
    );
    assert.equal(refusal.statusCode, 409);
    assert.equal(refusal.message, "org policy caps concurrent pods at 1; stop or let another pod sleep first");

    // The deployment cap refuses the same wake the same way, with no org policy involved.
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    const perUser = await refused(() =>
      ensureProviderPodStartedWithResult(depsWithPerUserCap(1), { org_id: orgId, id: sleeping }, userId),
    );
    assert.equal(
      perUser.message,
      "this deployment caps concurrent pods per user at 1; stop or let another pod sleep first",
    );

    // Both refusals are clean: the pod is still asleep rather than stuck claiming a start.
    const row = await query<{ provider_state: string }>(
      "SELECT provider_state FROM pods WHERE id = $1",
      [sleeping],
    );
    assert.equal(row.rows[0]!.provider_state, "stopped");
  });

  it("lets a wake with room reach the provider, however many pods others are running", async () => {
    const previous = process.env["PI_POD_SANDBOX_TOKEN"];
    delete process.env["PI_POD_SANDBOX_TOKEN"];
    try {
      for (let i = 0; i < 5; i += 1) await makePod({ owner: otherUserId });
      const sleeping = await makePod({ providerState: "stopped" });
      // Reaching provider custody is the proof that no cap refused this wake.
      const error = await refused(() =>
        ensureProviderPodStartedWithResult(depsWithPerUserCap(2), { org_id: orgId, id: sleeping }, userId),
      );
      assert.equal(error.message, "no sandbox credential");
      const row = await query<{ provider_state: string }>(
        "SELECT provider_state FROM pods WHERE id = $1",
        [sleeping],
      );
      assert.equal(row.rows[0]!.provider_state, "stopped");
    } finally {
      if (previous === undefined) delete process.env["PI_POD_SANDBOX_TOKEN"];
      else process.env["PI_POD_SANDBOX_TOKEN"] = previous;
    }
  });
});
