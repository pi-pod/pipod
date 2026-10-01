/**
 * Reconciler race barriers against a REAL PostgreSQL (PI_POD_TEST_DATABASE_URL), driven by a
 * fake provider whose `list()` runs a hook mid-flight so the database can change between the
 * reconciler's row capture and its provider read — the exact windows a guarded fleet rehome
 * (target import → PG repoint → source retire) opens. Proves, with actual stale routes:
 *   1. a row re-pointed INTO a group while that group's list is in flight is never marked
 *      gone by the older list (rows are captured before the list);
 *   2. a row whose pointer or sandbox id is rebound while its OLD group's list is in flight is
 *      left untouched (full captured-tuple CAS), whether the old list still shows it or not;
 *   3. identical observations are no-op writes (updated_at untouched) while state advance,
 *      activity advance and stop-cause fill still write exactly once;
 *   4. cascade/push gating stays on the actually-updated row.
 * Plus the native adapter's fresh-import activity rule as a pure unit test.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { registerProvider } from "../src/core/providers/registry.js";
import { providerActivityOf } from "../src/core/providers/sandbox/index.js";
import type { SandboxInfo, SandboxProvider } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { snapshotPlatformCredentials } from "../src/server/pods/providercred.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { runReconciler } from "../src/server/workers/reconciler.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const log = { info: () => {}, warn: () => {}, error: () => {} };
const env = { GATEWAY_ID: "gateway-reconciler-race", PI_POD_SANDBOX_TOKEN: "test-provider-token" } as unknown as ServerEnv;

const SOURCE_URL = "http://reconciler-race-source.test:8433";
const TARGET_URL = "http://reconciler-race-target.test:8433";

type Listing = SandboxInfo[];

describe("reconciler race barriers (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  void snapshotPlatformCredentials(env);
  /** Per-URL listings the fake provider answers with; hooks run while that URL's list is in flight. */
  const listings = new Map<string, Listing>();
  const hooks = new Map<string, () => Promise<void>>();
  const listCalls: string[] = [];

  before(async () => {
    initPool(databaseUrl!);
    registerProvider("sandbox", async () => (providerConfig: Record<string, unknown> = {}) => {
      const url = String(providerConfig["url"] ?? "");
      return {
        name: "sandbox",
        capabilities: {},
        list: async () => {
          listCalls.push(url);
          const hook = hooks.get(url);
          if (hook) {
            hooks.delete(url);
            await hook();
          }
          return listings.get(url) ?? [];
        },
        get: async () => null,
      } as unknown as SandboxProvider;
    });
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'reconciler race test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
    registerProvider("sandbox", async () => (await import("../src/core/providers/sandbox.js")).createSandboxProvider);
  });

  beforeEach(async () => {
    listings.clear();
    hooks.clear();
    listCalls.length = 0;
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
  });

  async function makePod(opts: {
    url: string;
    sandboxId: string;
    providerState?: string;
    state?: string;
    lastActivityAt?: string | null;
    lastStopCause?: string | null;
  }): Promise<string> {
    const id = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
                         provider_state_changed_at, last_activity_at, last_stop_cause, resolved_config)
       VALUES ($1, $2, $3, $4, 'sandbox', $5, $6, $7, now() - interval '1 hour', $8, $9, $10::jsonb)`,
      [
        id,
        orgId,
        userId,
        `race-${opts.sandboxId}`,
        opts.sandboxId,
        opts.state ?? "active",
        opts.providerState ?? "archived",
        opts.lastActivityAt ?? null,
        opts.lastStopCause ?? null,
        JSON.stringify({ config: { providers: { sandbox: { url: opts.url } } }, workdir: "/workspace" }),
      ],
    );
    return id;
  }

  type Snap = {
    provider_state: string;
    state: string;
    reaped_at: string | null;
    state_reason: string | null;
    updated_at: string;
    last_activity_at: string | null;
    last_stop_cause: string | null;
    url: string;
    provider_sandbox_id: string;
  };
  async function snap(id: string): Promise<Snap> {
    const r = await query<Snap>(
      `SELECT provider_state, state, reaped_at::text AS reaped_at, state_reason,
              extract(epoch FROM updated_at)::text AS updated_at,
              to_char(last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_activity_at,
              last_stop_cause, provider_sandbox_id,
              resolved_config -> 'config' -> 'providers' -> 'sandbox' ->> 'url' AS url
         FROM pods WHERE id = $1`,
      [id],
    );
    return r.rows[0]!;
  }
  async function repoint(id: string, url: string): Promise<void> {
    await query(
      `UPDATE pods SET resolved_config = jsonb_set(resolved_config, '{config,providers,sandbox,url}', to_jsonb($2::text), true),
              updated_at = now() WHERE id = $1`,
      [id, url],
    );
  }
  async function pushCount(): Promise<number> {
    const r = await query<{ n: string }>("SELECT count(*)::text AS n FROM push_queue WHERE user_id = $1", [userId]);
    return Number(r.rows[0]!.n);
  }
  const info = (id: string, state: SandboxInfo["state"], lastActivityAt?: string): SandboxInfo => ({
    id,
    labels: {},
    state,
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
  });
  const run = () => runReconciler({ env, kek, log, gateway: null });

  // ---------------------------------------------------------------- 1. target arrival during list
  for (const targetListShowsIt of [false, true]) {
    it(`target arrival during the target list (${targetListShowsIt ? "newer" : "older"} target list) never marks the moved row gone`, async () => {
      const anchor = await makePod({ url: TARGET_URL, sandboxId: "sb-anchor" }); // makes the target group exist
      const moved = await makePod({ url: SOURCE_URL, sandboxId: "sb-moved" });
      listings.set(SOURCE_URL, [info("sb-moved", "archived")]);
      listings.set(TARGET_URL, [
        info("sb-anchor", "archived"),
        ...(targetListShowsIt ? [info("sb-moved", "archived")] : []),
      ]);
      // The guarded rehome commits the PG pointer while the target list is in flight.
      hooks.set(TARGET_URL, async () => {
        await repoint(moved, TARGET_URL);
      });
      const before = await snap(moved);
      await run();
      const after = await snap(moved);
      assert.equal(after.provider_state, "archived", "moved row must not be marked gone by a list captured before its import");
      assert.equal(after.reaped_at, null);
      assert.equal(after.state_reason, null);
      assert.equal(after.url, TARGET_URL, "pointer stays repointed");
      assert.equal(after.last_activity_at, before.last_activity_at);
      assert.equal(await pushCount(), 0, "no pod-gone push");
      const anchorRow = await snap(anchor);
      assert.equal(anchorRow.provider_state, "archived");
      // Next tick reads the moved row in its new group against that group's own list.
      listings.set(TARGET_URL, [info("sb-anchor", "archived"), info("sb-moved", "archived")]);
      await run();
      assert.equal((await snap(moved)).provider_state, "archived");
    });
  }

  // ------------------------------------------------- 2. source URL / SID rebind during the OLD list
  for (const oldListStillShowsIt of [true, false]) {
    it(`source pointer rebind during the source list (old list ${oldListStillShowsIt ? "still shows" : "no longer shows"} it) leaves the row untouched`, async () => {
      const pod = await makePod({ url: SOURCE_URL, sandboxId: "sb-rebind", lastActivityAt: "2026-09-01T00:00:00Z" });
      listings.set(SOURCE_URL, oldListStillShowsIt ? [info("sb-rebind", "started", "2026-09-06T00:00:00Z")] : []);
      hooks.set(SOURCE_URL, async () => {
        await repoint(pod, TARGET_URL);
      });
      await run();
      const after = await snap(pod);
      assert.equal(after.provider_state, "archived", "stale source route must not converge/gone a repointed row");
      assert.equal(after.reaped_at, null);
      assert.equal(after.last_activity_at, "2026-09-01T00:00:00Z", "no activity fabricated from the stale route");
      assert.equal(after.url, TARGET_URL);
      assert.equal(await pushCount(), 0);
    });

    it(`sandbox-id rebind during the source list (old list ${oldListStillShowsIt ? "still shows" : "no longer shows"} the old id) leaves the row untouched`, async () => {
      const pod = await makePod({ url: SOURCE_URL, sandboxId: "sb-old" });
      listings.set(SOURCE_URL, oldListStillShowsIt ? [info("sb-old", "started")] : []);
      const captured: { afterHook?: Snap } = {};
      hooks.set(SOURCE_URL, async () => {
        await query("UPDATE pods SET provider_sandbox_id = 'sb-new', updated_at = now() WHERE id = $1", [pod]);
        captured.afterHook = await snap(pod);
      });
      await run();
      const after = await snap(pod);
      assert.equal(after.provider_state, "archived");
      assert.equal(after.provider_sandbox_id, "sb-new");
      assert.equal(after.reaped_at, null);
      assert.ok(captured.afterHook, "hook ran during the list");
      assert.equal(after.updated_at, captured.afterHook.updated_at, "hook write only; the reconciler wrote nothing");
    });
  }

  // ----------------------------------------------------------------------- 3. no-op discipline
  it("an identical observation is a no-op: updated_at does not move on repeated equal activity", async () => {
    const pod = await makePod({ url: SOURCE_URL, sandboxId: "sb-quiet", lastActivityAt: "2026-09-05T12:00:00Z", lastStopCause: "provider_archived" });
    listings.set(SOURCE_URL, [info("sb-quiet", "archived", "2026-09-05T12:00:00Z")]);
    const s0 = await snap(pod);
    await run();
    const s1 = await snap(pod);
    assert.equal(s1.updated_at, s0.updated_at, "equal activity + same state + cause set → no write");
    // Older provider activity than the high-water mark is also a no-op.
    listings.set(SOURCE_URL, [info("sb-quiet", "archived", "2026-09-01T00:00:00Z")]);
    await run();
    assert.equal((await snap(pod)).updated_at, s0.updated_at);
    // Missing activity (fresh-import rule upstream) is a no-op too.
    listings.set(SOURCE_URL, [info("sb-quiet", "archived")]);
    await run();
    assert.equal((await snap(pod)).updated_at, s0.updated_at);
    assert.equal((await snap(pod)).last_activity_at, "2026-09-05T12:00:00Z");
  });

  it("activity advance, state change and stop-cause fill still write (each exactly once)", async () => {
    const pod = await makePod({ url: SOURCE_URL, sandboxId: "sb-live", providerState: "started", lastActivityAt: "2026-09-05T12:00:00Z" });
    // activity advance
    listings.set(SOURCE_URL, [info("sb-live", "started", "2026-09-05T13:00:00Z")]);
    const s0 = await snap(pod);
    await run();
    const s1 = await snap(pod);
    assert.notEqual(s1.updated_at, s0.updated_at);
    assert.equal(s1.last_activity_at, "2026-09-05T13:00:00Z");
    await run();
    assert.equal((await snap(pod)).updated_at, s1.updated_at, "same advance again is a no-op");
    // state change started → stopped fills the cause
    listings.set(SOURCE_URL, [info("sb-live", "stopped", "2026-09-05T13:00:00Z")]);
    await run();
    const s2 = await snap(pod);
    assert.equal(s2.provider_state, "stopped");
    assert.equal(s2.last_stop_cause, "provider_stopped");
    assert.notEqual(s2.updated_at, s1.updated_at);
    await run();
    assert.equal((await snap(pod)).updated_at, s2.updated_at, "stopped + same activity + cause set → no write");
    // cause fill alone (state already stopped, cause NULL) writes once
    await query("UPDATE pods SET last_stop_cause = NULL WHERE id = $1", [pod]);
    const s3 = await snap(pod);
    await run();
    const s4 = await snap(pod);
    assert.equal(s4.last_stop_cause, "provider_stopped");
    assert.notEqual(s4.updated_at, s3.updated_at);
    await run();
    assert.equal((await snap(pod)).updated_at, s4.updated_at);
  });

  // -------------------------------------------------------------- 4. gone + cascade gating intact
  it("a genuinely missing sandbox (no concurrent change) is still marked gone with a push", async () => {
    const pod = await makePod({ url: SOURCE_URL, sandboxId: "sb-lost" });
    listings.set(SOURCE_URL, []);
    await run();
    const after = await snap(pod);
    assert.equal(after.provider_state, "gone");
    assert.ok(after.reaped_at);
    assert.equal(await pushCount(), 1);
    await run();
    assert.equal(await pushCount(), 1, "gone rows leave the group; no repeat push");
  });

  it("host children cascade only when the host row actually updated", async () => {
    const host = await makePod({ url: SOURCE_URL, sandboxId: "sb-host", providerState: "started" });
    const childId = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, host_pod_id, resolved_config)
       VALUES ($1, $2, $3, 'child', 'host', 'active', 'started', $4, '{}'::jsonb)`,
      [childId, orgId, userId, host],
    );
    // Rebind the host row during the list: the host UPDATE must not match, so no cascade.
    listings.set(SOURCE_URL, [info("sb-host", "stopped")]);
    hooks.set(SOURCE_URL, async () => {
      await repoint(host, TARGET_URL);
    });
    await run();
    const child = await query<{ provider_state: string }>("SELECT provider_state FROM pods WHERE id = $1", [childId]);
    assert.equal(child.rows[0]!.provider_state, "started", "no cascade without an actual host update");
    assert.equal((await snap(host)).provider_state, "started");
    // Next tick in the new group: the host converges and the child cascades.
    listings.set(TARGET_URL, [info("sb-host", "stopped")]);
    await run();
    assert.equal((await snap(host)).provider_state, "stopped");
    const child2 = await query<{ provider_state: string }>("SELECT provider_state FROM pods WHERE id = $1", [childId]);
    assert.equal(child2.rows[0]!.provider_state, "stopped");
  });
});

describe("native adapter: fresh archived import reports no activity", () => {
  const t = "2026-09-06T17:40:00.000Z";
  it("gen 0 + archived + all three timestamps equal → no activity (import initialisation)", () => {
    assert.equal(providerActivityOf({ state: "archived", createdAt: t, lastActivityAt: t, stoppedAt: t, runtimeGeneration: 0 }), undefined);
    assert.equal(providerActivityOf({ state: "archived", createdAt: t, lastActivityAt: t, stoppedAt: t }), undefined, "absent generation counts as 0");
  });
  it("gen 0 alone is NOT proof: legacy originals with distinct timestamps keep reporting activity", () => {
    assert.equal(
      providerActivityOf({ state: "archived", createdAt: "2026-08-25T15:00:00.000Z", lastActivityAt: "2026-09-01T10:00:00.000Z", stoppedAt: "2026-09-01T10:05:00.000Z", runtimeGeneration: 0 }),
      "2026-09-01T10:00:00.000Z",
    );
    assert.equal(
      providerActivityOf({ state: "archived", createdAt: "2026-08-25T15:00:00.000Z", lastActivityAt: t, stoppedAt: t, runtimeGeneration: 0 }),
      t,
      "two equal timestamps are not the import signature",
    );
  });
  it("started rows and generation > 0 always report activity", () => {
    assert.equal(providerActivityOf({ state: "started", createdAt: t, lastActivityAt: t, stoppedAt: null, runtimeGeneration: 0 }), t);
    assert.equal(providerActivityOf({ state: "archived", createdAt: t, lastActivityAt: t, stoppedAt: t, runtimeGeneration: 1 }), t);
    assert.equal(providerActivityOf({ state: "stopped", createdAt: t, lastActivityAt: t, stoppedAt: t, runtimeGeneration: 0 }), t);
  });
});
