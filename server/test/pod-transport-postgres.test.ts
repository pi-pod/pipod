import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { makeAuthHook } from "../src/server/auth/plugin.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { registerGatewayRoutes } from "../src/server/gateway/routes.js";
import { GatewayService } from "../src/server/gateway/service.js";
import { uuidv7 } from "../src/server/ids.js";
import { createPodToken } from "../src/server/pods/podtoken.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("pod transport endpoint (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  const archivedPodId = uuidv7();
  const env = {
    GATEWAY_ID: "gateway-pod-transport-test",
    ZITADEL_ISSUER: "http://127.0.0.1:8081",
    ZITADEL_API_AUDIENCE: "pipod-api",
    LOG_LEVEL: "silent",
    WEB_ORIGINS: [],
  } as unknown as ServerEnv;
  const gateway = new GatewayService({
    env,
    kek: new EnvKekProvider("test-kek", Buffer.alloc(32, 1).toString("base64")),
    log,
  });
  const app = Fastify({ logger: false });
  let baseUrl = "";
  let token = "";
  let archivedToken = "";

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'pod transport test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    for (const [id, state] of [[podId, "active"], [archivedPodId, "archived"]] as const) {
      await query(
        `INSERT INTO pods
           (id, org_id, user_id, name, provider, state, provider_state, resolved_config, transport)
         VALUES ($1, $2, $3, 'transport test', 'sandbox', $4, 'started', '{}'::jsonb, 'ws')`,
        [id, orgId, userId, state],
      );
    }
    token = await createPodToken({ podId, orgId, userId });
    archivedToken = await createPodToken({ podId: archivedPodId, orgId, userId });

    await app.register(websocket);
    app.decorate("authenticate", makeAuthHook(env));
    registerGatewayRoutes(app, gateway);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = address.replace(/^http/, "ws");
  });

  after(async () => {
    gateway.podTransportRegistry.shutdown();
    await app.close();
    await query("DELETE FROM pod_tokens WHERE pod_id = ANY($1)", [[podId, archivedPodId]]);
    await query("DELETE FROM pods WHERE id = ANY($1)", [[podId, archivedPodId]]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  function connect(bearer: string): WebSocket {
    return new WebSocket(`${baseUrl}/pod-transport`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
  }

  it("binds token identity and supersedes the stale writer", async () => {
    const first = connect(token);
    await new Promise<void>((resolve, reject) => {
      first.once("open", resolve);
      first.once("error", reject);
    });
    for (let i = 0; i < 50 && !gateway.podTransports.has(podId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(gateway.podTransports.has(podId), true);

    const superseded = new Promise<{ code: number; reason: string }>((resolve) =>
      first.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    const second = connect(token);
    await new Promise<void>((resolve, reject) => {
      second.once("open", resolve);
      second.once("error", reject);
    });
    assert.deepEqual(await superseded, { code: 4408, reason: "superseded" });
    second.close();
  });

  it("rejects archived pods and a live lease held elsewhere", async () => {
    const archived = connect(archivedToken);
    const archivedClose = await new Promise<{ code: number; reason: string }>((resolve) =>
      archived.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    assert.deepEqual(archivedClose, { code: 4410, reason: "pod_archived" });

    await query(
      "UPDATE pods SET gateway_id = 'gateway-other', gateway_heartbeat_at = now() WHERE id = $1",
      [podId],
    );
    const leased = connect(token);
    const leaseClose = await new Promise<{ code: number; reason: string }>((resolve) =>
      leased.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    assert.deepEqual(leaseClose, { code: 4409, reason: "lease_held" });
  });
});
