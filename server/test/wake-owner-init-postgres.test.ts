/**
 * Wake-time owner healing (§7.2 rev3) against Postgres + fake provider/host.
 *
 * Own DB: `pipod_cost_capacity_test` — never foundation, never production.
 * A stopped legacy pod whose host runs REQUIRE_OWNER fails its first start
 * with 400 owner_required; the wake path runs the same one-time CAS the
 * sweep uses (trusted pod owner) and retries exactly once. Quota is claimed
 * once (no double charge); any other outcome rethrows the original refusal.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { registerProvider } from "../src/core/providers/registry.js";
import { PiPodError } from "../src/core/errors.js";
import { SandboxApiError } from "../src/core/providers/sandbox/client.js";
import type { Sandbox, SandboxProvider } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { getPod } from "../src/server/pods/store.js";
import { ensureProviderPodStartedWithResult } from "../src/server/pods/lifecycle.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { ownerKeyForUserId } from "../src/server/pods/owner-identity.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("wake-time owner healing (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const expectedKey = ownerKeyForUserId(userId);
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const env = {
    GATEWAY_ID: "gateway-wake-owner",
    POD_MAX_CONCURRENT_PER_USER: 20,
    // Boot-parsed platform custody, as in production (loadEnv): provider
    // credential resolution reads this snapshot, not ambient process.env.
    PI_POD_SANDBOX_TOKEN: "test-provider-token",
  } as unknown as ServerEnv;
  const deps: PodServiceDeps = { env, kek, log };
  const previousToken = process.env["PI_POD_SANDBOX_TOKEN"];

  let starts = 0;
  let failFirstStart = true;
  let fakeProviderState: "stopped" | "started" = "stopped";
  const sandbox = {
    id: "sb-wake-1",
    state: async () => fakeProviderState,
    start: async () => {
      starts += 1;
      if (failFirstStart) {
        failFirstStart = false;
        throw new PiPodError("starting sandbox sb-wake-1 failed: operation failed", {
          status: 400,
          cause: new SandboxApiError(400, "owner_required", "unowned launches refused", undefined, undefined),
        });
      }
      fakeProviderState = "started";
    },
    stop: async () => {},
    waitUntilStarted: async () => {},
  } as unknown as Sandbox;
  const provider = {
    name: "sandbox",
    capabilities: {},
    get: async () => sandbox,
    list: async () => [],
  } as unknown as SandboxProvider;

  let server: http.Server;
  let hostUrl = "";
  const puts: Array<{ body: string }> = [];

  before(async () => {
    initPool(databaseUrl!);
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-provider-token";
    registerProvider("sandbox", async () => () => provider);
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const put = req.url?.match(/^\/v1\/sandboxes\/([^/]+)\/owner$/);
        if (put && req.method === "PUT") {
          puts.push({ body });
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ changed: true, sandbox: { id: decodeURIComponent(put[1]!) } }),
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
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'wake owner test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    server.close();
    await closePool();
    registerProvider("sandbox", async () => (await import("../src/core/providers/sandbox.js")).createSandboxProvider);
    if (previousToken === undefined) delete process.env["PI_POD_SANDBOX_TOKEN"];
    else process.env["PI_POD_SANDBOX_TOKEN"] = previousToken;
  });

  it("initializes the owner on 400 owner_required and retries the start once", async () => {
    const podId = uuidv7();
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'wake owner pod', 'sandbox', 'sb-wake-1', 'active', 'stopped', $4::jsonb)`,
      [podId, orgId, userId, JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } })],
    );
    starts = 0;
    failFirstStart = true;
    puts.length = 0;
    const { pod, restarted } = await ensureProviderPodStartedWithResult(
      deps,
      { org_id: orgId, id: podId },
      null,
    );
    assert.equal(restarted, true);
    assert.equal(starts, 2, "start retried exactly once after owner init");
    assert.equal(puts.length, 1);
    const sent = JSON.parse(puts[0]!.body) as { owner: { userKey: string } };
    assert.equal(sent.owner.userKey, expectedKey);
    const fresh = await getPod(orgId, pod.id);
    assert.equal(fresh.provider_state, "started");
  });
});
