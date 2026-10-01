import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { installErrorHandler } from "../src/server/app.js";
import { LAUNCH_ADMISSION_HELD_CODE, LAUNCH_ADMISSION_HELD_MESSAGE } from "../src/server/httperrors.js";
import { readLaunchControl, transitionLaunchControl, LAUNCH_RECOVERY_PROTOCOL_VERSION } from "../src/server/pods/launch-control.js";
import { registerPodRoutes } from "../src/server/pods/routes.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const userId = uuidv7();
const orgId = uuidv7();
const heldAttemptPodId = uuidv7();
const log = { info: () => {}, warn: () => {}, error: () => {} };
const env = {
  GATEWAY_ID: "gateway-launch-admission-held-test",
  ZITADEL_ISSUER: "http://127.0.0.1:8081",
  ZITADEL_API_AUDIENCE: "pipod-api",
  LOG_LEVEL: "silent",
  WEB_ORIGINS: [],
  PI_POD_SANDBOX_URL: "http://127.0.0.1:9",
  PI_POD_SANDBOX_IMAGE_MIRROR: "ghcr.io/pi-pod",
} as unknown as ServerEnv;

interface Counts {
  pods: string;
  attempts: string;
}

async function countsForUser(): Promise<Counts> {
  const result = await query<Counts>(
    `SELECT (SELECT count(*)::text FROM pods WHERE user_id = $1::text) AS pods,
            (SELECT count(*)::text FROM pod_create_attempts WHERE user_id = $2::text) AS attempts`,
    [userId, userId],
  );
  return result.rows[0]!;
}

describe("held launch admission route (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  let app: FastifyInstance | undefined;
  let providerServer: http.Server | undefined;
  let providerCalls = 0;
  let poolInitialized = false;
  let originalGateMode: "held" | "open" | undefined;

  before(async () => {
    initPool(databaseUrl!);
    poolInitialized = true;
    const gate = await readLaunchControl();
    originalGateMode = gate.mode;
    assert.equal(gate.mode, "open", "isolated test runner opens launch admission before the suite");

    providerServer = http.createServer((_request, response) => {
      providerCalls += 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unexpected_provider_call" } }));
    });
    providerServer.listen(0, "127.0.0.1");
    await once(providerServer, "listening");
    const providerAddress = providerServer.address();
    assert.ok(providerAddress && typeof providerAddress === "object");

    app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    installErrorHandler(app);
    app.decorate("authenticate", async (request: { auth?: unknown }) => {
      request.auth = {
        userId,
        email: `${userId}@fixture.test`,
        orgId,
        permissions: ["pods:launch"],
      };
    });
    const deps: PodServiceDeps = {
      env: { ...env, PI_POD_SANDBOX_URL: `http://127.0.0.1:${providerAddress.port}` } as ServerEnv,
      kek: new EnvKekProvider("launch-admission-held-test", randomBytes(32).toString("base64")),
      log,
    };
    await app.register(async (v1: FastifyInstance) => registerPodRoutes(v1, deps, null), { prefix: "/v1" });
    await app.ready();
  });

  after(async () => {
    let cleanupError: unknown;
    try {
      await app?.close();
    } catch (error) {
      cleanupError = error;
    }
    if (providerServer?.listening) {
      try {
        providerServer.closeAllConnections();
        await new Promise<void>((resolveClose) => providerServer!.close(() => resolveClose()));
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (poolInitialized) {
      try {
        await query("DELETE FROM pod_create_attempts WHERE pod_id = $1", [heldAttemptPodId]);
        const current = await readLaunchControl();
        if (originalGateMode && current.mode !== originalGateMode) {
          await transitionLaunchControl({
            mode: originalGateMode,
            expectedEpoch: Number(current.epoch),
            protocolVersion: LAUNCH_RECOVERY_PROTOCOL_VERSION,
            sourceSha: originalGateMode === "open" ? "0000000000000000000000000000000000000000" : null,
            actor: "test_runner",
            reasonCode: "launch_gate_http_restore",
          });
        }
        await query(
          `DELETE FROM launch_recovery_control_events
            WHERE actor = 'test_runner'
              AND reason_code = ANY($1::text[])`,
          [["launch_gate_http_test", "launch_gate_http_owner_test", "launch_gate_http_restore"]],
        );
      } catch (error) {
        cleanupError ??= error;
      } finally {
        await closePool();
      }
    }
    if (cleanupError) throw cleanupError;
  });

  it("returns 503 for the held global gate and 409 for an open-gate owner hold without writes", async () => {
    assert.ok(app);
    const beforeHeld = await countsForUser();
    const providerCallsBeforeHeld = providerCalls;
    const initial = await readLaunchControl();
    assert.equal(initial.mode, "open");
    await transitionLaunchControl({
      mode: "held",
      expectedEpoch: Number(initial.epoch),
      protocolVersion: LAUNCH_RECOVERY_PROTOCOL_VERSION,
      sourceSha: null,
      actor: "test_runner",
      reasonCode: "launch_gate_http_test",
    });

    const held = await app.inject({ method: "POST", url: "/v1/pods", payload: {} });
    const heldDiagnostic = {
      status: held.statusCode,
      fixedMessage: held.json<{ error?: unknown }>().error === LAUNCH_ADMISSION_HELD_MESSAGE,
      heldCode: held.json<{ detail?: { code?: unknown } }>().detail?.code === LAUNCH_ADMISSION_HELD_CODE,
      retryable: held.json<{ detail?: { retryable?: unknown } }>().detail?.retryable === true,
    };
    assert.equal(held.statusCode, 503, `held global admission contract mismatch: ${JSON.stringify(heldDiagnostic)}`);
    assert.deepEqual(held.json(), {
      error: LAUNCH_ADMISSION_HELD_MESSAGE,
      detail: { code: LAUNCH_ADMISSION_HELD_CODE, retryable: true },
    });
    assert.deepEqual(await countsForUser(), beforeHeld, "global refusal must not create a pod or attempt");
    assert.equal(providerCalls, providerCallsBeforeHeld, "global refusal must not contact the provider");

    const currentHeld = await readLaunchControl();
    await transitionLaunchControl({
      mode: "open",
      expectedEpoch: Number(currentHeld.epoch),
      protocolVersion: LAUNCH_RECOVERY_PROTOCOL_VERSION,
      sourceSha: "0000000000000000000000000000000000000000",
      actor: "test_runner",
      reasonCode: "launch_gate_http_owner_test",
    });
    await query(
      `INSERT INTO pod_create_attempts
         (pod_id, org_id, user_id, provider, attempt_no, phase, owner_epoch, reason_code)
       VALUES ($1, $2, $3, 'sandbox', 0, 'legacy_unresolved', 1, 'legacy_create_outcome_unknown')`,
      [heldAttemptPodId, orgId, userId],
    );
    const beforeOwnerHold = await countsForUser();
    const providerCallsBeforeOwnerHold = providerCalls;

    const ownerHeld = await app.inject({ method: "POST", url: "/v1/pods", payload: {} });
    assert.equal(ownerHeld.statusCode, 409, "an unresolved account hold remains a conflict when global admission is open");
    assert.equal(ownerHeld.json<{ detail?: { code?: unknown } }>().detail?.code, "launch_recovery_required");
    assert.deepEqual(await countsForUser(), beforeOwnerHold, "owner-hold refusal must not create a pod or attempt");
    assert.equal(providerCalls, providerCallsBeforeOwnerHold, "owner-hold refusal must not contact the provider");
  });
});
