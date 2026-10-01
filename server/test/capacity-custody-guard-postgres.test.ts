/**
 * Pinned fleet custody/registry guard for cold wakes (postgres + fake host).
 *
 * Own org scope on a disposable test DB — never foundation, never
 * production. Closes the parent-flagged registry bypass: the lifecycle cold
 * wake used to treat a failed registry lookup as "no host row" and a missing
 * host row as implicit BYOK/compat, so a query error — or a known
 * platform-fleet pod whose host row was deleted — started without evidence.
 *
 * Proves, each with ZERO native start calls and the mapping/SID/archive
 * references intact:
 *
 * - a known platform-fleet wake whose host row is gone is REFUSED with typed
 *   `host_unregistered` (non-retryable, never migrated cross-host);
 * - an unregistered wake with UNKNOWN custody (legacy, no retention record)
 *   is refused the same way — unknown custody can never justify platform
 *   credential admission (fail closed, never implicit BYOK);
 * - a failed REGISTRY read propagates as-is (retryable 500-class DB error,
 *   no state touched pre-claim) instead of degrading into a compat skip;
 * - a failed CUSTODY read propagates the same way;
 * - a genuine BYOK wake (`org-secret` custody, unregistered URL) proceeds on
 *   host admission in fleet mode — with no evidence probe at all;
 * - a single-mode unregistered wake keeps the deliberate compat path.
 *
 * Companion coverage (not duplicated here): valid fresh ceiling admits,
 * malformed/missing/stale/mismatch/unreadable evidence refuses, and
 * already-running jobs return untouched — see
 * wake-floor-refusal-postgres.test.ts. Pure routing table —
 * see classifyPinnedCustody in capacity-wake-wait-unit.test.ts.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { ensureProviderPodStartedWithResult } from "../src/server/pods/lifecycle.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("pinned fleet custody/registry guard (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));

  function deps(placementMode: "fleet" | "single"): PodServiceDeps {
    return {
      env: {
        GATEWAY_ID: "gateway-custody-guard",
        POD_MAX_CONCURRENT_PER_USER: 20,
        PI_POD_SANDBOX_TOKEN: "test-provider-token",
        SANDBOX_PLACEMENT_MODE: placementMode,
      } as unknown as ServerEnv,
      kek,
      log,
    };
  }
  const fleetDeps = deps("fleet");
  const singleDeps = deps("single");
  const previousToken = process.env["PI_POD_SANDBOX_TOKEN"];

  let server: http.Server;
  let hostUrl = "";
  let healthzHits = 0;
  const starts: string[] = [];
  const hostState = new Map<string, string>();

  before(async () => {
    initPool(databaseUrl!);
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-provider-token";
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/v1/healthz") {
          healthzHits += 1;
          // Deliberately unserved: compat paths must never probe evidence.
          // A stray probe surfaces here as a 404 (=> "unknown" => refusal),
          // so admission tests below would fail loudly instead of masking it.
          res.writeHead(404).end("{}");
          return;
        }
        const start = req.url?.match(/^\/v1\/sandboxes\/([^/]+)\/start$/);
        if (start && req.method === "POST") {
          const id = decodeURIComponent(start[1]!);
          starts.push(id);
          hostState.set(id, "started");
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
          return;
        }
        const get = req.url?.match(/^\/v1\/sandboxes\/([^/]+)$/);
        if (get && req.method === "GET") {
          const id = decodeURIComponent(get[1]!);
          const state = hostState.get(id) ?? "stopped";
          const now = new Date().toISOString();
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              id,
              labels: {},
              state,
              createdAt: now,
              lastActivityAt: now,
              image: "fixture-image",
              workdir: "/w",
              tier: state === "started" ? "hot" : "stopped",
              archiveAfterMinutes: 60,
              idleTimeoutMinutes: 15,
              resources: {},
              ceiling: {},
              owner: null,
              revision: 1,
              runtimeGeneration: 1,
              stoppedAt: state === "started" ? null : now,
            }),
          );
          return;
        }
        res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    hostUrl = `http://127.0.0.1:${address.port}`;
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'custody guard org')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]).catch(() => null);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    server.close();
    await closePool();
    if (previousToken === undefined) delete process.env["PI_POD_SANDBOX_TOKEN"];
    else process.env["PI_POD_SANDBOX_TOKEN"] = previousToken;
  });

  /** Stopped sandbox pod pinned at the (unregistered) fake host URL. */
  async function seedPinnedPod(sandboxId: string, custody: "platform" | "org-secret" | null): Promise<string> {
    const podId = uuidv7();
    starts.length = 0;
    healthzHits = 0;
    hostState.set(sandboxId, "stopped");
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'custody guard pod', 'sandbox', $4, 'active', 'stopped', $5::jsonb)`,
      [podId, orgId, userId, sandboxId, JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } })],
    );
    if (custody !== null) {
      await query(
        `INSERT INTO pod_retention (pod_id, desired_archive_after_minutes, revision, status, credential_source)
         VALUES ($1, 60, 1, 'pending', $2)`,
        [podId, custody],
      );
    }
    return podId;
  }

  /** Stopped sandbox pod with a SID but NO frozen host mapping (legacy row). */
  async function seedUnmappedPod(sandboxId: string, custody: "platform" | null): Promise<string> {
    const podId = uuidv7();
    starts.length = 0;
    healthzHits = 0;
    hostState.set(sandboxId, "stopped");
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'custody guard unmapped pod', 'sandbox', $4, 'active', 'stopped', $5::jsonb)`,
      [podId, orgId, userId, sandboxId, JSON.stringify({ config: { providers: {} }, workdir: "/w" })],
    );
    if (custody !== null) {
      await query(
        `INSERT INTO pod_retention (pod_id, desired_archive_after_minutes, revision, status, credential_source)
         VALUES ($1, 60, 1, 'pending', $2)`,
        [podId, custody],
      );
    }
    return podId;
  }

  /** Fleet deps with the boot-default route pointed at the fake host: a gate
   *  fall-through would land a start there, so empty `starts` proves no
   *  default-route fallback. Built per-test (hostUrl is known after before()). */
  function fleetDepsWithDefaultRoute(): PodServiceDeps {
    return {
      env: {
        GATEWAY_ID: "gateway-custody-guard",
        POD_MAX_CONCURRENT_PER_USER: 20,
        PI_POD_SANDBOX_TOKEN: "test-provider-token",
        SANDBOX_PLACEMENT_MODE: "fleet",
        PI_POD_SANDBOX_URL: hostUrl,
      } as unknown as ServerEnv,
      kek,
      log,
    };
  }

  async function rowState(podId: string): Promise<{ provider_state: string; provider_sandbox_id: string; url: string }> {
    const row = (
      await query<{ provider_state: string; provider_sandbox_id: string; resolved_config: unknown }>(
        `SELECT provider_state, provider_sandbox_id, resolved_config FROM pods WHERE id = $1`,
        [podId],
      )
    ).rows[0]!;
    const url = (
      row.resolved_config as { config: { providers: { sandbox: { url: string } } } }
    ).config.providers.sandbox.url;
    return { provider_state: row.provider_state, provider_sandbox_id: row.provider_sandbox_id, url };
  }

  it("refuses a known-platform wake whose host row is gone (typed, intact, zero starts)", async () => {
    const sandboxId = `sb-orphan-${uuidv7().replace(/-/g, "").slice(0, 12)}`;
    const podId = await seedPinnedPod(sandboxId, "platform");
    const failed = await ensureProviderPodStartedWithResult(fleetDeps, { org_id: orgId, id: podId }, null).then(
      () => null,
      (error: unknown) => error as { statusCode?: number; message?: string; detail?: unknown },
    );
    assert.ok(failed, "platform wake with a deleted host row must fail, never start blind");
    assert.equal(failed.statusCode, 503);
    assert.match(failed.message ?? "", /not registered/);
    const detail = failed.detail as { reason?: unknown; retryable?: unknown } | undefined;
    assert.equal(detail?.reason, "host_unregistered");
    assert.equal(detail?.retryable, false);
    assert.deepEqual(starts, [], "no native start may fly for an unregistered platform host");
    const row = await rowState(podId);
    assert.equal(row.provider_state, "stopped", "no quota claim may leak on refusal");
    assert.equal(row.provider_sandbox_id, sandboxId, "sandbox id preserved for re-register + retry");
    assert.equal(row.url, hostUrl, "frozen host URL preserved for the guarded rehome");
  });

  it("refuses unknown-custody unregistered wakes (never implicit BYOK)", async () => {
    const sandboxId = `sb-unknown-${uuidv7().replace(/-/g, "").slice(0, 12)}`;
    const podId = await seedPinnedPod(sandboxId, null);
    const failed = await ensureProviderPodStartedWithResult(fleetDeps, { org_id: orgId, id: podId }, null).then(
      () => null,
      (error: unknown) => error as { statusCode?: number; message?: string; detail?: unknown },
    );
    assert.ok(failed, "unknown custody must fail closed, never become BYOK by default");
    assert.equal(failed.statusCode, 503);
    const detail = failed.detail as { reason?: unknown; retryable?: unknown } | undefined;
    assert.equal(detail?.reason, "host_unregistered");
    assert.equal(detail?.retryable, false);
    assert.deepEqual(starts, []);
    const row = await rowState(podId);
    assert.equal(row.provider_state, "stopped");
    assert.equal(row.provider_sandbox_id, sandboxId);
    assert.equal(row.url, hostUrl);
  });

  it("refuses a known-platform wake with no frozen host mapping (no default-route fallback)", async () => {
    const sandboxId = `sb-nomap-${uuidv7().replace(/-/g, "").slice(0, 12)}`;
    const podId = await seedUnmappedPod(sandboxId, "platform");
    const failed = await ensureProviderPodStartedWithResult(
      fleetDepsWithDefaultRoute(),
      { org_id: orgId, id: podId },
      null,
    ).then(
      () => null,
      (error: unknown) => error as { statusCode?: number; message?: string; detail?: unknown },
    );
    assert.ok(failed, "platform wake with no host mapping must fail, never take the default route");
    assert.equal(failed.statusCode, 503);
    assert.match(failed.message ?? "", /no pinned platform host mapping/);
    const detail = failed.detail as { reason?: unknown; retryable?: unknown } | undefined;
    assert.equal(detail?.reason, "host_unregistered");
    assert.equal(detail?.retryable, false);
    assert.deepEqual(starts, [], "no native start, including via the boot-default route");
    assert.equal(healthzHits, 0, "no evidence probe without a pinned host");
    const row = (
      await query<{ provider_state: string; provider_sandbox_id: string }>(`
        SELECT provider_state, provider_sandbox_id FROM pods WHERE id = $1`,
        [podId],
      )
    ).rows[0]!;
    assert.equal(row.provider_state, "stopped", "row untouched: no claim, no repoint, no migration");
    assert.equal(row.provider_sandbox_id, sandboxId, "sandbox id preserved for the guarded rehome");
  });

  it("refuses an unknown-custody wake with no frozen host mapping", async () => {
    const sandboxId = `sb-nomapunk-${uuidv7().replace(/-/g, "").slice(0, 12)}`;
    const podId = await seedUnmappedPod(sandboxId, null);
    const failed = await ensureProviderPodStartedWithResult(
      fleetDepsWithDefaultRoute(),
      { org_id: orgId, id: podId },
      null,
    ).then(
      () => null,
      (error: unknown) => error as { statusCode?: number; message?: string; detail?: unknown },
    );
    assert.ok(failed, "unknown custody with no mapping must fail closed");
    assert.equal(failed.statusCode, 503);
    const detail = failed.detail as { reason?: unknown; retryable?: unknown } | undefined;
    assert.equal(detail?.reason, "host_unregistered");
    assert.equal(detail?.retryable, false);
    assert.deepEqual(starts, [], "no native start, including via the boot-default route");
    const row = (
      await query<{ provider_state: string; provider_sandbox_id: string }>(`
        SELECT provider_state, provider_sandbox_id FROM pods WHERE id = $1`,
        [podId],
      )
    ).rows[0]!;
    assert.equal(row.provider_state, "stopped");
    assert.equal(row.provider_sandbox_id, sandboxId);
  });

  it("a failed registry read propagates (never degrades into compat), zero starts", async () => {
    const sandboxId = `sb-regfail-${uuidv7().replace(/-/g, "").slice(0, 12)}`;
    const podId = await seedPinnedPod(sandboxId, "platform");
    await query("ALTER TABLE sandbox_hosts RENAME TO sandbox_hosts_hidden_for_guard_test");
    try {
      const failed = await ensureProviderPodStartedWithResult(fleetDeps, { org_id: orgId, id: podId }, null).then(
        () => null,
        (error: unknown) => error as { message?: string; detail?: unknown; code?: string },
      );
      assert.ok(failed, "a registry outage must surface, never admit");
      // A raw database failure: NOT the typed unregistered refusal (which
      // requires a successfully-read absent row), and never a success.
      assert.match(failed.message ?? "", /sandbox_hosts.*does not exist|does not exist.*sandbox_hosts/i);
      const detail = failed.detail as { reason?: unknown } | undefined;
      assert.notEqual(detail?.reason, "host_unregistered");
      assert.deepEqual(starts, [], "no native start may fly when custody is unreadable");
      const row = await rowState(podId);
      assert.equal(row.provider_state, "stopped", "no quota claim may leak on a propagated failure");
      assert.equal(row.provider_sandbox_id, sandboxId);
    } finally {
      await query("ALTER TABLE sandbox_hosts_hidden_for_guard_test RENAME TO sandbox_hosts");
    }
    // Guard-test hygiene: the registry is whole again for the rest of the suite.
    const check = await query("SELECT count(*) AS n FROM sandbox_hosts");
    assert.ok(check.rows[0], "sandbox_hosts restored after the failure-injection test");
  });

  it("a failed custody read propagates (never degrades into compat), zero starts", async () => {
    const sandboxId = `sb-custfail-${uuidv7().replace(/-/g, "").slice(0, 12)}`;
    const podId = await seedPinnedPod(sandboxId, "platform");
    await query("ALTER TABLE pod_retention RENAME TO pod_retention_hidden_for_guard_test");
    try {
      const failed = await ensureProviderPodStartedWithResult(fleetDeps, { org_id: orgId, id: podId }, null).then(
        () => null,
        (error: unknown) => error as { message?: string; detail?: unknown },
      );
      assert.ok(failed, "a custody outage must surface, never admit");
      assert.match(failed.message ?? "", /pod_retention.*does not exist|does not exist.*pod_retention/i);
      const detail = failed.detail as { reason?: unknown } | undefined;
      assert.notEqual(detail?.reason, "host_unregistered");
      assert.deepEqual(starts, [], "no native start may fly when custody is unreadable");
      const row = await rowState(podId);
      assert.equal(row.provider_state, "stopped");
      assert.equal(row.provider_sandbox_id, sandboxId);
    } finally {
      await query("ALTER TABLE pod_retention_hidden_for_guard_test RENAME TO pod_retention");
    }
    const check = await query("SELECT count(*) AS n FROM pod_retention");
    assert.ok(check.rows[0], "pod_retention restored after the failure-injection test");
  });

  it("a genuine BYOK wake proceeds on host admission in fleet mode (no evidence probe)", async () => {
    const sandboxId = `sb-byok-${uuidv7().replace(/-/g, "").slice(0, 12)}`;
    const podId = await seedPinnedPod(sandboxId, "org-secret");
    const { pod, restarted } = await ensureProviderPodStartedWithResult(
      fleetDeps,
      { org_id: orgId, id: podId },
      null,
    );
    assert.equal(restarted, true);
    assert.equal(pod.provider_state, "started");
    assert.equal(pod.provider_sandbox_id, sandboxId, "same workspace, same (BYO) host");
    assert.deepEqual(starts, [sandboxId], "exactly one pinned start, no failover");
    assert.equal(healthzHits, 0, "org-secret compat takes no evidence probe");
  });

  it("a single-mode unregistered wake keeps the deliberate compat path", async () => {
    const sandboxId = `sb-single-${uuidv7().replace(/-/g, "").slice(0, 12)}`;
    const podId = await seedPinnedPod(sandboxId, null);
    const { pod, restarted } = await ensureProviderPodStartedWithResult(
      singleDeps,
      { org_id: orgId, id: podId },
      null,
    );
    assert.equal(restarted, true);
    assert.equal(pod.provider_state, "started");
    assert.equal(pod.provider_sandbox_id, sandboxId);
    assert.deepEqual(starts, [sandboxId]);
    assert.equal(healthzHits, 0, "single-mode compat takes no evidence probe");
  });
});
