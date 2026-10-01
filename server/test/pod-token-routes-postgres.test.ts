import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { registerProvider } from "../src/core/providers/registry.js";
import type { Sandbox, SandboxProvider } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { resetSendRateLimits } from "../src/server/pods/files.js";
import { registerPodRoutes } from "../src/server/pods/routes.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { snapshotPlatformCredentials } from "../src/server/pods/providercred.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { writeLayer } from "../src/server/settings/merge.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const log = { info: () => {}, warn: () => {}, error: () => {} };
// Boot-shaped env (mirrors main(): keys live in the parsed env, never ambient). The
// threaded snapshot below is what withProviderCredential consumes as platform fallback.
const env = {
  GATEWAY_ID: "gateway-pod-token-routes",
  PI_POD_SANDBOX_TOKEN: "test-provider-token",
} as unknown as ServerEnv;

describe("pod-token descendant routes (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const rootId = uuidv7();
  const childId = uuidv7();
  const unrelatedId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const deps: PodServiceDeps = { env, kek, log, platformCredentials: snapshotPlatformCredentials(env) };
  const contents = Buffer.from("abc");
  let receiveInspections = 0;
  let stopCalls = 0;
  let auth = {
    userId,
    email: `${userId}@example.test`,
    orgId,
    permissions: [] as string[],
    podId: rootId,
  };
  let app: ReturnType<typeof Fastify>;

  const sandbox = {
    id: "pod-token-route-sandbox",
    exec: async (argv: string[]) => {
      if (argv[0] === "python3") {
        receiveInspections += 1;
        return {
          exitCode: 0,
          output: JSON.stringify({
            entries: [
              {
                relPath: "",
                kind: "file",
                mode: 0o600,
                size: contents.byteLength,
                sha256: createHash("sha256").update(contents).digest("hex"),
              },
            ],
            bytes: contents.byteLength,
          }),
        };
      }
      return { exitCode: 0, output: "" };
    },
    downloadFile: async () => contents,
    stop: async () => { stopCalls += 1; },
    state: async () => (stopCalls > 0 ? "stopped" : "started") as "started" | "stopped",
  } as unknown as Sandbox;
  const provider = {
    name: "sandbox",
    capabilities: {},
    get: async () => sandbox,
  } as unknown as SandboxProvider;

  before(async () => {
    initPool(databaseUrl!);
    registerProvider("sandbox", async () => () => provider);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'pod token route test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    for (const pod of [
      { id: rootId, parent: null, root: rootId, depth: 0 },
      { id: childId, parent: rootId, root: rootId, depth: 1 },
      { id: unrelatedId, parent: null, root: unrelatedId, depth: 0 },
    ]) {
      await query(
        `INSERT INTO pods
           (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
            resolved_config, parent_pod_id, lineage_root_id, lineage_depth)
         VALUES ($1, $2, $3, 'route pod', 'sandbox', $4, 'active', 'started', $5::jsonb,
                 $6, $7, $8)`,
        [
          pod.id,
          orgId,
          userId,
          `${sandbox.id}-${pod.id}`,
          JSON.stringify({ config: { providers: {} }, workdir: "/workspace" }),
          pod.parent,
          pod.root,
          pod.depth,
        ],
      );
    }

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      req.auth = auth;
    });
    registerPodRoutes(app, deps, null);
    await app.ready();
  });

  beforeEach(async () => {
    auth = { ...auth, podId: rootId, permissions: [] };
    receiveInspections = 0;
    stopCalls = 0;
    resetSendRateLimits();
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query(
      "UPDATE pods SET name = 'route pod', provider_state = 'started' WHERE org_id = $1",
      [orgId],
    );
  });

  after(async () => {
    await app.close();
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("UPDATE pods SET parent_pod_id = NULL WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
    registerProvider("sandbox", async () => (await import("../src/core/providers/sandbox.js")).createSandboxProvider);
  });

  it("returns the frozen workdir needed by account clients", async () => {
    const response = await app.inject({ method: "GET", url: `/pods/${childId}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().resolvedConfig.workdir, "/workspace");
  });

  it("allows descendant rename, refuses unrelated rename, and audits the pod actor", async () => {
    const allowed = await app.inject({ method: "PATCH", url: `/pods/${childId}`, payload: { name: "renamed" } });
    assert.equal(allowed.statusCode, 200, allowed.body);

    const refused = await app.inject({ method: "PATCH", url: `/pods/${unrelatedId}`, payload: { name: "not allowed" } });
    assert.equal(refused.statusCode, 403, refused.body);
    const names = await query<{ id: string; name: string }>(
      "SELECT id, name FROM pods WHERE id = ANY($1) ORDER BY id",
      [[childId, unrelatedId]],
    );
    assert.equal(names.rows.find((row) => row.id === childId)?.name, "renamed");
    assert.equal(names.rows.find((row) => row.id === unrelatedId)?.name, "route pod");
    const auditRows = await query<{ detail: { fromPod?: string } }>(
      "SELECT detail FROM audit_log WHERE action = 'pod.rename' AND target_id = $1",
      [childId],
    );
    assert.deepEqual(auditRows.rows[0]?.detail, { name: "renamed", fromPod: rootId });
  });

  it("allows stopping a descendant, refuses unrelated pods, and persists provider state", async () => {
    const allowed = await app.inject({ method: "POST", url: `/pods/${childId}/stop` });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().state, "stopped");
    assert.equal(stopCalls, 1);
    const persisted = await query<{ provider_state: string }>(
      "SELECT provider_state FROM pods WHERE id = $1",
      [childId],
    );
    assert.equal(persisted.rows[0]?.provider_state, "stopped");

    const refused = await app.inject({ method: "POST", url: `/pods/${unrelatedId}/stop` });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(stopCalls, 1, "authorization must run before provider work");
  });

  it("allows file receive from a descendant and refuses targets outside the subtree", async () => {
    const allowed = await app.inject({ method: "GET", url: `/pods/${childId}/files?path=artifact.bin` });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.deepEqual(allowed.json(), {
      id: childId,
      source: "artifact.bin",
      entries: [{ relPath: "", kind: "file", mode: 0o600, size: 3, contents: "YWJj" }],
    });
    assert.equal(receiveInspections, 1);

    const refused = await app.inject({ method: "GET", url: `/pods/${unrelatedId}/files?path=artifact.bin` });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(receiveInspections, 1, "authorization must run before provider work");
    const auditRows = await query<{ detail: { fromPod?: string } }>(
      "SELECT detail FROM audit_log WHERE action = 'pod.receive' AND target_id = $1",
      [childId],
    );
    assert.equal(auditRows.rows[0]?.detail.fromPod, rootId);
  });

  it("refuses descendant receive when org policy disables it before provider work", async () => {
    await writeLayer({
      scopeType: "org_policy",
      scopeId: orgId,
      orgId,
      config: { nestedPods: { allowFileReceive: false } },
      expectedVersion: 0,
      updatedBy: userId,
    });

    const refused = await app.inject({ method: "GET", url: `/pods/${childId}/files?path=artifact.bin` });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.match(refused.body, /allowFileReceive/);
    assert.equal(receiveInspections, 0);
  });
});
