import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import type { OperationStatusWire, SandboxInfoWire } from "../src/core/providers/sandbox/wire.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { staticHostUrlHash } from "../src/server/pods/create-attempts.js";
import { assertNoLaunchRecoveryHold } from "../src/server/pods/launch-control.js";
import { buildCreateOwner } from "../src/server/pods/owner-identity.js";
import { runCreateRecovery } from "../src/server/pods/create-recovery.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env.PI_POD_TEST_DATABASE_URL;
const platformToken = "create-recovery-test-platform-token";

type OperationFixture = { status: OperationStatusWire; sandbox?: SandboxInfoWire };

describe("GET-only create recovery (postgres + recording HTTP provider fake)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const operationFixtures = new Map<string, OperationFixture>();
  const requests: Array<{ method: string; path: string }> = [];
  let server: http.Server;
  let serviceUrl = "";
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const kek = new EnvKekProvider("recovery-test", randomBytes(32).toString("base64"));

  const sandboxInfo = (id: string): SandboxInfoWire => ({
    id,
    labels: { "pi-pod-server/pod": podId, "pi-pod-server/org": orgId },
    state: "started",
    createdAt: "2026-09-24T00:00:00.000Z",
    lastActivityAt: "2026-09-24T00:00:00.000Z",
    image: "debian:stable-slim",
    workdir: "/workspace",
    tier: "hot",
    archiveAfterMinutes: 0,
    idleTimeoutMinutes: 0,
    resources: { cpu: 1, memoryGB: 1, diskGB: 1 },
    ceiling: { cpu: 1, memoryGB: 1, diskGB: 1 },
    owner: { userKey: buildCreateOwner({ userId }).userKey },
  });
  const podId = uuidv7();
  const pendingPodId = uuidv7();
  const safePodId = uuidv7();
  const interruptedPodId = uuidv7();

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations(id,name) VALUES ($1,'create recovery test')", [orgId]);
    await query("INSERT INTO users(id,email) VALUES ($1,$2)", [userId, `${userId}@recovery.test`]);
    server = http.createServer((req, res) => {
      const path = req.url ?? "";
      requests.push({ method: req.method ?? "", path });
      if (req.headers.authorization !== `Bearer ${platformToken}`) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "unauthorized" } }));
        return;
      }
      const operation = path.match(/^\/v1\/operations\/([^/?]+)$/);
      if (operation && req.method === "GET") {
        const fixture = operationFixtures.get(decodeURIComponent(operation[1]!));
        if (!fixture) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(fixture.status));
        return;
      }
      const sandbox = path.match(/^\/v1\/sandboxes\/([^/?]+)$/);
      if (sandbox && req.method === "GET") {
        const id = decodeURIComponent(sandbox[1]!);
        const fixture = [...operationFixtures.values()].find((candidate) => candidate.sandbox?.id === id);
        if (!fixture?.sandbox) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(fixture.sandbox));
        return;
      }
      res.writeHead(405, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "method_not_allowed" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    serviceUrl = `http://127.0.0.1:${address.port}`;

    for (const [id, name] of [
      [podId, "succeeded attempt"],
      [pendingPodId, "pending attempt"],
      [safePodId, "safe failure attempt"],
      [interruptedPodId, "interrupted attempt"],
    ] as const) {
      await query(
        `INSERT INTO pods
           (id,org_id,user_id,name,provider,state,provider_state,resolved_config,
            provisioning_heartbeat_at,transport)
         VALUES ($1,$2,$3,$4,'sandbox','active','provisioning',
           $5::jsonb,now(),'ws')`,
        [id, orgId, userId, name, JSON.stringify({
          config: { providers: { sandbox: { url: serviceUrl } } },
          workdir: "/workspace",
        })],
      );
    }

    const outcomes: Array<{ podId: string; status: OperationStatusWire; sandbox?: SandboxInfoWire }> = [
      {
        podId,
        status: {
          key: "create-recovered-success-000000000001",
          kind: "create", status: "succeeded", sandboxId: "sbx-recovered-success",
          createdAt: "2026-09-24T00:00:00.000Z", finishedAt: "2026-09-24T00:00:01.000Z",
          expiresAt: "2026-10-01T00:00:00.000Z", cancelRequested: false,
          resolution: null, crossHostRetrySafe: false,
          result: sandboxInfo("sbx-recovered-success"),
        },
        sandbox: sandboxInfo("sbx-recovered-success"),
      },
      {
        podId: pendingPodId,
        status: {
          key: "create-recovered-pending-0000000001",
          kind: "create", status: "pending", sandboxId: null,
          createdAt: "2026-09-24T00:00:00.000Z", finishedAt: null,
          expiresAt: "2026-10-01T00:00:00.000Z", cancelRequested: false,
          resolution: null, crossHostRetrySafe: false,
        },
      },
      {
        podId: safePodId,
        status: {
          key: "create-recovered-safe-00000000001",
          kind: "create", status: "failed", sandboxId: null,
          createdAt: "2026-09-24T00:00:00.000Z", finishedAt: "2026-09-24T00:00:01.000Z",
          expiresAt: "2026-10-01T00:00:00.000Z", cancelRequested: false,
          resolution: "preallocation", crossHostRetrySafe: true,
          error: { code: "disk_capacity", message: "safe fixture" },
        },
      },
      {
        podId: interruptedPodId,
        status: {
          key: "create-recovered-interrupted-0001",
          kind: "create", status: "failed", sandboxId: null,
          createdAt: "2026-09-24T00:00:00.000Z", finishedAt: "2026-09-24T00:00:01.000Z",
          expiresAt: "2026-10-01T00:00:00.000Z", cancelRequested: false,
          resolution: "preallocation", crossHostRetrySafe: true,
          error: { code: "interrupted", message: "host restart fixture" },
        },
      },
    ];
    for (const outcome of outcomes) {
      const key = outcome.status.key;
      operationFixtures.set(key, { status: outcome.status, ...(outcome.sandbox ? { sandbox: outcome.sandbox } : {}) });
      await query(
        `INSERT INTO pod_create_attempts
           (pod_id,org_id,user_id,provider,attempt_no,operation_key,sandbox_host_id,
            static_host_url_sha256,sandbox_id,phase,owner_epoch,owner_instance_id,
            reason_code,next_observe_at)
         VALUES ($1,$2,$3,'sandbox',1,$4,NULL,$5,NULL,'unknown',1,$6,
                 'original_outcome_unknown',NULL)`,
        [outcome.podId, orgId, userId, key, staticHostUrlHash(serviceUrl), uuidv7()],
      );
    }
  });

  after(async () => {
    await query("DELETE FROM pod_create_attempts WHERE org_id=$1", [orgId]).catch(() => {});
    await query("DELETE FROM pods WHERE org_id=$1", [orgId]).catch(() => {});
    await query("DELETE FROM users WHERE id=$1", [userId]).catch(() => {});
    await query("DELETE FROM organizations WHERE id=$1", [orgId]).catch(() => {});
    await closePool();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("adopts verified success without init/replay, preserves pending/interrupted holds, and closes only safe refusal", async () => {
    const env = {
      PI_POD_SANDBOX_URL: serviceUrl,
      PI_POD_SANDBOX_TOKEN: platformToken,
      SECRETS_KEK_ID: "recovery-test",
      SECRETS_KEK: Buffer.alloc(32, 3).toString("base64"),
      PUBLIC_URL: "http://localhost:8080",
    } as unknown as ServerEnv;
    await runCreateRecovery({ env, kek, log });

    const success = await query<{ phase: string; sandbox_id: string }>(
      "SELECT phase,sandbox_id FROM pod_create_attempts WHERE pod_id=$1", [podId],
    );
    assert.deepEqual(success.rows[0], { phase: "initialization_interrupted", sandbox_id: "sbx-recovered-success" });
    const boundPod = await query<{ provider_state: string; provider_sandbox_id: string | null }>(
      "SELECT provider_state,provider_sandbox_id FROM pods WHERE id=$1", [podId],
    );
    assert.deepEqual(boundPod.rows[0], { provider_state: "error", provider_sandbox_id: "sbx-recovered-success" });

    const pending = await query<{ phase: string; last_provider_status: string | null }>(
      "SELECT phase,last_provider_status FROM pod_create_attempts WHERE pod_id=$1", [pendingPodId],
    );
    assert.deepEqual(pending.rows[0], { phase: "unknown", last_provider_status: "pending" });
    const interrupted = await query<{ phase: string; reason_code: string | null }>(
      "SELECT phase,reason_code FROM pod_create_attempts WHERE pod_id=$1", [interruptedPodId],
    );
    assert.deepEqual(interrupted.rows[0], { phase: "unknown", reason_code: "provider_operation_interrupted" });
    const safe = await query<{ phase: string; state: string; provider_state: string }>(
      `SELECT a.phase,p.state,p.provider_state FROM pod_create_attempts a JOIN pods p ON p.id=a.pod_id WHERE a.pod_id=$1`,
      [safePodId],
    );
    assert.deepEqual(safe.rows[0], { phase: "failed_safe", state: "archived", provider_state: "gone" });
    await assert.rejects(assertNoLaunchRecoveryHold(undefined, userId), (error: unknown) =>
      error instanceof Error && (error as { statusCode?: number }).statusCode === 409,
    );

    assert.ok(requests.length >= 5);
    assert.ok(requests.every((request) => request.method === "GET"), JSON.stringify(requests));
    assert.equal(requests.some((request) => request.method === "DELETE" || request.method === "POST"), false);
  });
});
