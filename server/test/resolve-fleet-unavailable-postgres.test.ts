/**
 * Resolve during an unreachable fleet answers a typed 503 (S2).
 *
 * Production 2026-09-07: `POST /pods/resolve` during a deliberate 3-minute
 * server→host partition answered 500 `internal server error` (a bare 503
 * genericized at the error boundary) instead of a retryable typed result.
 * In fleet mode, zero reachable workers must answer HTTP 503 with the
 * allowlisted `fleet_unavailable` body — never 500, never raw text, never a
 * control-plane fallback.
 *
 * Postgres: planning resolves org/user rows before placement throws.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { installErrorHandler } from "../src/server/app.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { registerPodRoutes } from "../src/server/pods/routes.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

const env = {
  GATEWAY_ID: "gateway-resolve-fleet",
  ZITADEL_ISSUER: "http://127.0.0.1:8081",
  ZITADEL_API_AUDIENCE: "pipod-api",
  LOG_LEVEL: "silent",
  WEB_ORIGINS: [],
  PI_POD_SANDBOX_URL: "http://fleet-worker-1:8433",
  PI_POD_SANDBOX_IMAGE_MIRROR: "ghcr.io/pi-pod",
  PI_POD_SANDBOX_TOKEN: "test-platform-token",
  SANDBOX_PLACEMENT_MODE: "fleet",
} as unknown as ServerEnv;
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("resolve during an unreachable fleet (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const podDeps: PodServiceDeps = { env, kek, log };
  let app: FastifyInstance;
  // Rows owned by other suites sharing this DB: the tests below wipe the
  // registry to simulate an empty/unreachable fleet, so snapshot up front
  // and restore after every test — never leak an empty registry downstream.
  let hostSnapshot: Array<{ id: string; url: string; status: string }> = [];

  async function restoreSandboxHosts(): Promise<void> {
    await query("DELETE FROM sandbox_hosts");
    for (const row of hostSnapshot) {
      await query("INSERT INTO sandbox_hosts (id, url, status) VALUES ($1, $2, $3)", [
        row.id,
        row.url,
        row.status,
      ]);
    }
  }

  before(async () => {
    initPool(databaseUrl!);
    hostSnapshot = (
      await query<{ id: string; url: string; status: string }>("SELECT id, url, status FROM sandbox_hosts")
    ).rows;
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'resolve fleet test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // The production boundary, not a test double: the regression was a 503
    // genericized to 500 exactly here.
    installErrorHandler(app);
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      req.auth = {
        userId,
        email: `${userId}@example.test`,
        orgId,
        permissions: ["pods:launch"],
      };
    });
    await app.register(async (v1: FastifyInstance) => registerPodRoutes(v1, podDeps, null), { prefix: "/v1" });
    await app.ready();
  });

  afterEach(async () => {
    await restoreSandboxHosts();
  });

  after(async () => {
    await app.close();
    await restoreSandboxHosts();
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("answers 503 + typed fleet_unavailable when no host is reachable", async () => {
    await query("DELETE FROM sandbox_hosts");
    // Connection-refused: the probe fails fast with no sandbox contactable.
    await query("INSERT INTO sandbox_hosts (id, url, status) VALUES ('fleet-dead-1', 'http://127.0.0.1:1', 'active')");
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/pods/resolve?check_image=false",
        payload: { provider: "sandbox" },
      });
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(response.json(), {
        error: "the sandbox fleet is unreachable; retry shortly",
        detail: {
          code: "fleet_unavailable",
          reason: "fleet_unavailable",
          retryable: true,
          retryAfterMs: 15000,
        },
      });
    } finally {
      await query("DELETE FROM sandbox_hosts WHERE id = 'fleet-dead-1'");
    }
  });

  it("answers the same typed 503 for an empty fleet", async () => {
    await query("DELETE FROM sandbox_hosts");
    const response = await app.inject({
      method: "POST",
      url: "/v1/pods/resolve?check_image=false",
      payload: { provider: "sandbox" },
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), {
      error: "the sandbox fleet is unreachable; retry shortly",
      detail: {
        code: "fleet_unavailable",
        reason: "fleet_unavailable",
        retryable: true,
        retryAfterMs: 15000,
      },
    });
  });
});
