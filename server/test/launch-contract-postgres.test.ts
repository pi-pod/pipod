import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { after, before, describe, it } from "node:test";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { closePool, initPool, query, tx } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { GatewayService } from "../src/server/gateway/service.js";
import {
  admitLaunchOperationTx,
  finishLaunchOperation,
  getLaunchOperation,
  reserveLaunchOperation,
} from "../src/server/pods/launch-operations.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import { launchOperationStatusView, registerPodRoutes } from "../src/server/pods/routes.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

const env = {
  GATEWAY_ID: "gateway-launch-contract",
  ZITADEL_ISSUER: "http://127.0.0.1:8081",
  ZITADEL_API_AUDIENCE: "pipod-api",
  LOG_LEVEL: "silent",
  WEB_ORIGINS: [],
  PI_POD_SANDBOX_URL: "http://pi-pod-sandbox:8433",
  PI_POD_SANDBOX_IMAGE_MIRROR: "ghcr.io/pi-pod",
} as unknown as ServerEnv;
const log = { info: () => {}, warn: () => {}, error: () => {} };

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded 5s`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** An owned lock barrier: raw connection so the test pool never holds the blocker. */
async function blockerClient(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("SET idle_in_transaction_session_timeout = '15s'");
  return client;
}

async function waitForBlockers(blockerPid: number, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE $1 = ANY(pg_blocking_pids(pid))`, [blockerPid],
    );
    if (blocked.rows[0]?.count === count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${count} blocked reservation(s) before deadline`);
}

/** These contracts need real SQL because launch planning and cold attach both resolve org secrets. */
describe("launch and attach contracts (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = "org_launch_contract_test";
  const userId = "user_launch_contract_test";
  const podId = uuidv7();
  const pendingPodId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const podDeps: PodServiceDeps = { env, kek, log };
  let app: FastifyInstance;

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'launch contract test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
          resolved_config)
       VALUES ($1, $2, $3, 'attach contract', 'sandbox', 'sandbox-must-not-be-contacted',
               'active', 'started', $4::jsonb)`,
      [podId, orgId, userId, JSON.stringify({
        config: { providers: {} },
        clamps: [],
        configProvenance: [{ path: "idleTimeoutMinutes", winner: "project", over: ["template"] }],
        secretKeys: ["SHARED"],
        secretScopes: { SHARED: "project" },
        secretShadows: { SHARED: ["org", "template"] },
        egress: { description: "open", mode: "open" },
        workdir: "/workspace",
        warnings: [],
        notificationsRedacted: true,
      })],
    );
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
          resolved_config)
       VALUES ($1, $2, $3, 'pending launch', 'sandbox', NULL, 'active', 'provisioning', $4::jsonb)`,
      [pendingPodId, orgId, userId, JSON.stringify({ config: { providers: {} }, workdir: "/workspace" })],
    );
    await query(
      `INSERT INTO pod_create_attempts
         (pod_id,org_id,user_id,provider,attempt_no,operation_key,phase,owner_epoch,
          owner_instance_id,owner_token,owner_lease_until,reason_code)
       VALUES ($1,$2,$3,'sandbox',1,$4,'prepared',1,$5,$6,clock_timestamp()+interval '1 minute','launch_prepared')`,
      [pendingPodId, orgId, userId, `create-${randomBytes(24).toString("base64url")}`, uuidv7(), uuidv7()],
    );

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof HttpError) {
        return reply.code(error.statusCode).send({ error: error.message, detail: error.detail ?? null });
      }
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === "number" && statusCode < 500) {
        return reply.code(statusCode).send({ error: error.message, detail: null });
      }
      return reply.code(500).send({ error: "internal server error", detail: null });
    });
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

  after(async () => {
    await app.close();
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_launch_operations WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_create_attempts WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("concurrent same-ID reservations keep one owner, one pod and a pending replay", { timeout: 20_000 }, async () => {
    const operationId = uuidv7();
    const admittedPodId = uuidv7();
    const forgedPodId = uuidv7();
    const baseline = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pods WHERE org_id = $1", [orgId],
    );
    const blocker = await blockerClient(databaseUrl!);
    let first: ReturnType<typeof reserveLaunchOperation> | undefined;
    let second: ReturnType<typeof reserveLaunchOperation> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE pod_launch_operations IN SHARE MODE");
      const pid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      first = reserveLaunchOperation({ orgId, userId, operationId, templateId: null });
      second = reserveLaunchOperation({ orgId, userId, operationId, templateId: null });
      await waitForBlockers(pid.rows[0]!.pid, 2);
      const unseen = await withDeadline(
        app.inject({ method: "GET", url: `/v1/launch-operations/${operationId}` }), "pre-reservation GET",
      );
      assert.equal(unseen.statusCode, 200);
      assert.deepEqual(unseen.json(), { operationId, state: "not_found" });
      await blocker.query("COMMIT");
      const [a, b] = await withDeadline(Promise.all([first, second]), "concurrent reservations");
      const owner = a.kind === "owner" ? a : b;
      const existing = a.kind === "existing" ? a : b;
      assert.equal(owner.kind, "owner");
      assert.equal(existing.kind, "existing");
      if (owner.kind !== "owner" || existing.kind !== "existing") return;
      assert.equal(existing.operation.state, "pending");
      assert.equal(existing.operation.owner_token, owner.claim.ownerToken);
      assert.equal(Number(existing.operation.owner_generation), 1);

      await assert.rejects(
        tx(async (client) => {
          await client.query(
            `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
             VALUES ($1, $2, $3, 'forged owner', 'sandbox', 'active', 'provisioning', '{}'::jsonb)`,
            [forgedPodId, orgId, userId],
          );
          await admitLaunchOperationTx(client, { ...owner.claim, ownerToken: randomUUID() }, forgedPodId);
        }),
        /ownership changed before admission/,
      );
      await tx(async (client) => {
        await client.query(
          `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
           VALUES ($1, $2, $3, 'admitted owner', 'sandbox', 'active', 'provisioning', $4::jsonb)`,
          [admittedPodId, orgId, userId, JSON.stringify({ config: { providers: {} }, workdir: "/workspace" })],
        );
        await admitLaunchOperationTx(client, owner.claim, admittedPodId);
      });
      const admitted = await app.inject({ method: "GET", url: `/v1/launch-operations/${operationId}` });
      assert.equal(admitted.statusCode, 200, admitted.body);
      assert.equal(admitted.json().state, "admitted");
      assert.equal(admitted.json().launch.pod.id, admittedPodId);
      const replay = await app.inject({
        method: "POST", url: "/v1/pods", payload: { operationId, templateId: null },
      });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().pod.id, admittedPodId);
      const after = await query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pods WHERE org_id = $1", [orgId],
      );
      assert.equal(after.rows[0]!.count, baseline.rows[0]!.count + 1);
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
      await Promise.allSettled([first, second].filter((p): p is NonNullable<typeof p> => !!p));
    }
  });

  for (const commit of [true, false]) {
    it(`same-ID retry waits for an uncommitted reservation then ${commit ? "replays" : "owns"}`, { timeout: 20_000 }, async () => {
      const operationId = uuidv7();
      const ownerToken = randomUUID();
      const blocker = await blockerClient(databaseUrl!);
      let retry: ReturnType<typeof reserveLaunchOperation> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          `INSERT INTO pod_launch_operations
             (org_id, user_id, operation_id, template_id, state,
              owner_generation, owner_token, owner_lease_until)
           VALUES ($1, $2, $3, NULL, 'pending', 1, $4, now() + interval '300 seconds')`,
          [orgId, userId, operationId, ownerToken],
        );
        const pid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const unseen = await app.inject({ method: "GET", url: `/v1/launch-operations/${operationId}` });
        assert.equal(unseen.statusCode, 200);
        assert.deepEqual(unseen.json(), { operationId, state: "not_found" });
        retry = reserveLaunchOperation({ orgId, userId, operationId, templateId: null });
        await waitForBlockers(pid.rows[0]!.pid, 1);
        const stillUnseen = await withDeadline(
          app.inject({ method: "GET", url: `/v1/launch-operations/${operationId}` }), "GET while retry waits",
        );
        assert.deepEqual(stillUnseen.json(), { operationId, state: "not_found" });
        await blocker.query(commit ? "COMMIT" : "ROLLBACK");
        const result = await withDeadline(retry, "same-ID retry");
        assert.equal(result.kind, commit ? "existing" : "owner");
        if (result.kind === "existing") assert.equal(result.operation.owner_token, ownerToken);
        if (result.kind === "owner") assert.notEqual(result.claim.ownerToken, ownerToken);
        const visible = await app.inject({ method: "GET", url: `/v1/launch-operations/${operationId}` });
        assert.equal(visible.json().state, "pending");
        const count = await query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pod_launch_operations
           WHERE org_id = $1 AND user_id = $2 AND operation_id = $3`,
          [orgId, userId, operationId],
        );
        assert.equal(count.rows[0]!.count, 1);
      } finally {
        await blocker.query("ROLLBACK").catch(() => {});
        await blocker.end();
        if (retry) await Promise.allSettled([retry]);
      }
    });
  }

  it("distinguishes a missing operation from an admitted pod removed between reads", async () => {
    const neverUsed = uuidv7();
    const missing = await app.inject({ method: "GET", url: `/v1/launch-operations/${neverUsed}` });
    assert.equal(missing.statusCode, 200);
    assert.deepEqual(missing.json(), { operationId: neverUsed, state: "not_found" });

    const operationId = uuidv7();
    const deletedPodId = uuidv7();
    const reserved = await reserveLaunchOperation({ orgId, userId, operationId, templateId: null });
    assert.equal(reserved.kind, "owner");
    if (reserved.kind !== "owner") return;
    await tx(async (client) => {
      await client.query(
        `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
         VALUES ($1, $2, $3, 'deleted admitted pod', 'sandbox', 'active', 'provisioning', '{}'::jsonb)`,
        [deletedPodId, orgId, userId],
      );
      await admitLaunchOperationTx(client, reserved.claim, deletedPodId);
    });
    const beforeDelete = await getLaunchOperation({ orgId, userId, operationId });
    await query("DELETE FROM pods WHERE id = $1", [deletedPodId]);
    const status = await app.inject({ method: "GET", url: `/v1/launch-operations/${operationId}` });
    assert.equal(status.statusCode, 200, status.body);
    assert.deepEqual(status.json(), { operationId, state: "admitted", podDeleted: true });
    // Simulate the exact race: the operation row was read with pod_id, then
    // the pod vanished before the second lookup. A database FK cannot store it.
    assert.deepEqual(await launchOperationStatusView(beforeDelete, null),
      { operationId, state: "admitted", podDeleted: true });
    const replay = await app.inject({
      method: "POST", url: "/v1/pods", payload: { operationId, templateId: null },
    });
    assert.equal(replay.statusCode, 410, replay.body);
  });

  it("does not replay a user-deleted pod retained as a gone row", async () => {
    const operationId = uuidv7();
    const deletedPodId = uuidv7();
    const reserved = await reserveLaunchOperation({ orgId, userId, operationId, templateId: null });
    assert.equal(reserved.kind, "owner");
    if (reserved.kind !== "owner") return;
    await tx(async (client) => {
      await client.query(
        `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
         VALUES ($1, $2, $3, 'soft-deleted admitted pod', 'sandbox', 'active', 'provisioning', '{}'::jsonb)`,
        [deletedPodId, orgId, userId],
      );
      await admitLaunchOperationTx(client, reserved.claim, deletedPodId);
    });
    await query("UPDATE pods SET provider_state='gone' WHERE id=$1", [deletedPodId]);
    const status = await app.inject({ method: "GET", url: `/v1/launch-operations/${operationId}` });
    assert.equal(status.statusCode, 200, status.body);
    assert.deepEqual(status.json(), { operationId, state: "admitted", podDeleted: true });
    const replay = await app.inject({
      method: "POST", url: "/v1/pods", payload: { operationId, templateId: null },
    });
    assert.equal(replay.statusCode, 410, replay.body);
  });

  it("normalizes uppercase UUIDs before comparing a retry's frozen template", async () => {
    const operationId = uuidv7();
    const templateId = uuidv7();
    const body = { operationId: operationId.toUpperCase(), templateId: templateId.toUpperCase() };
    const before = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pods WHERE org_id=$1", [orgId],
    );
    const first = await app.inject({ method: "POST", url: "/v1/pods", payload: body });
    assert.equal(first.statusCode, 404, first.body);
    assert.equal(first.json().error, "template not found");
    const operation = await getLaunchOperation({ orgId, userId, operationId });
    assert.equal(operation.operation_id, operationId);
    assert.equal(operation.template_id, templateId);
    assert.equal(operation.state, "rejected");
    assert.equal(operation.error_status, 404);
    assert.equal(operation.error_code, "launch_rejected");
    const replay = await app.inject({ method: "POST", url: "/v1/pods", payload: body });
    assert.equal(replay.statusCode, 404, replay.body);
    assert.equal(replay.statusCode, first.statusCode);
    assert.equal(replay.json().error, "launch operation was rejected; start a new launch to try again");
    assert.deepEqual(replay.json().detail, { operationId, code: "launch_rejected" });
    const status = await app.inject({
      method: "GET", url: `/v1/launch-operations/${body.operationId}`,
    });
    assert.equal(status.statusCode, 200, status.body);
    assert.deepEqual(status.json(), {
      operationId, state: "rejected", errorStatus: 404, errorCode: "launch_rejected",
    });
    const unseen = uuidv7();
    const missing = await app.inject({
      method: "GET", url: `/v1/launch-operations/${unseen.toUpperCase()}`,
    });
    assert.deepEqual(missing.json(), { operationId: unseen, state: "not_found" });
    const after = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pods WHERE org_id=$1", [orgId],
    );
    assert.equal(after.rows[0]!.count, before.rows[0]!.count);
  });

  it("records a correlated Pi rejection as failed in PostgreSQL without a stale writer overwrite", async () => {
    for (const stale of [false, true]) {
      const requestId = uuidv7();
      await query(
        "INSERT INTO queued_prompts (id, pod_id, user_id, text) VALUES ($1,$2,$3,$4)",
        [requestId, podId, userId, "do not submit without a model"],
      );
      const gateway = new GatewayService({ env, kek, log });
      const internals = gateway as unknown as {
        sessions: Map<string, unknown>;
        persist: () => Promise<{ seq: number; ts: string }>;
        fanOut: () => void;
        drainQueuedPrompts: (session: unknown) => Promise<void>;
      };
      internals.persist = async () => ({ seq: 1, ts: "2026-09-22T00:00:00.000Z" });
      internals.fanOut = () => {};
      const session = {
        pod: { id: podId }, closed: false,
        activity: { blocksPrompt: () => false, grantDispatchLease: async () => {} },
        rpc: { request: async (command: { type: string; message: string }) => {
          assert.deepEqual(command, { type: "prompt", message: "do not submit without a model" });
          if (stale) await query("UPDATE queued_prompts SET attempts=attempts+1 WHERE id=$1", [requestId]);
          return { type: "response", command: "prompt", success: false, error: "No model selected" };
        } },
      };
      internals.sessions.set(podId, session);
      try {
        await internals.drainQueuedPrompts(session);
        const result = await query<{ status: string; attempts: number }>(
          "SELECT status, attempts FROM queued_prompts WHERE id=$1", [requestId],
        );
        assert.deepEqual(result.rows[0], stale
          ? { status: "delivering", attempts: 2 }
          : { status: "failed", attempts: 1 });
      } finally {
        await query("DELETE FROM queued_prompts WHERE id=$1", [requestId]);
      }
    }
  });

  it("fences a stale launch-operation owner before pod admission", async () => {
    const operationId = uuidv7();
    const first = await reserveLaunchOperation({ orgId, userId, operationId, templateId: null });
    assert.equal(first.kind, "owner");
    if (first.kind !== "owner") return;

    const duplicate = await reserveLaunchOperation({ orgId, userId, operationId, templateId: null });
    assert.equal(duplicate.kind, "existing");
    if (duplicate.kind !== "existing") return;
    assert.equal(duplicate.operation.state, "pending");

    await finishLaunchOperation(first.claim, { state: "waiting", status: 503, code: "host_starting" });
    const retry = await reserveLaunchOperation({ orgId, userId, operationId, templateId: null });
    assert.equal(retry.kind, "owner");
    if (retry.kind !== "owner") return;
    assert.equal(retry.claim.ownerGeneration, first.claim.ownerGeneration + 1);

    await assert.rejects(
      tx((client) => admitLaunchOperationTx(client, first.claim, podId)),
      /ownership changed before admission/,
    );
    await tx((client) => admitLaunchOperationTx(client, retry.claim, podId));
    const status = await getLaunchOperation({ orgId, userId, operationId });
    assert.equal(status.state, "admitted");
    assert.equal(status.pod_id, podId);
  });

  it("DELETE cancels a provably unsent prepared attempt before provider dispatch", async () => {
    const response = await app.inject({ method: "DELETE", url: `/v1/pods/${pendingPodId}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { id: pendingPodId, state: "gone", deleted: true, cascaded: [] });
    const row = await query<{ provider_state: string; provider_sandbox_id: string | null }>(
      "SELECT provider_state, provider_sandbox_id FROM pods WHERE id = $1",
      [pendingPodId],
    );
    assert.deepEqual(row.rows[0], { provider_state: "gone", provider_sandbox_id: null });
    const attempt = await query<{ phase: string }>(
      "SELECT phase FROM pod_create_attempts WHERE pod_id=$1", [pendingPodId],
    );
    assert.equal(attempt.rows[0]?.phase, "aborted_unsent");
  });

  it("GET pod exposes the complete frozen redacted report and provenance projection", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/pods/${podId}` });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      report: Record<string, unknown> & { config: Record<string, unknown> };
      resolvedConfig: Record<string, unknown>;
    };
    assert.deepEqual(body.report["configProvenance"], [
      { path: "idleTimeoutMinutes", winner: "project", over: ["template"] },
    ]);
    assert.deepEqual(body.report["secretShadows"], { SHARED: ["org", "template"] });
    assert.deepEqual(body.resolvedConfig["configProvenance"], body.report["configProvenance"]);
    assert.deepEqual(body.resolvedConfig["secretShadows"], body.report["secretShadows"]);
    assert.equal(JSON.stringify(body).includes("secret-value"), false);
    // The stored row carries provider wiring; the client's copy of the report must not, or a
    // current CLI prints "providers: unknown key (ignored)" against it.
    assert.equal("providers" in body.report.config, false, JSON.stringify(body.report.config));
  });

  it("durably records a keyed pre-admission launch refusal for status reconciliation", async () => {
    const operationId = uuidv7();
    const before = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pods WHERE org_id = $1",
      [orgId],
    );
    const refused = await app.inject({
      method: "POST", url: "/v1/pods", payload: { operationId, templateId: null },
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal((refused.json() as { error: string }).error, "no sandbox credential");

    const status = await app.inject({
      method: "GET", url: `/v1/launch-operations/${operationId}`,
    });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal((status.json() as { state: string }).state, "rejected");

    const replay = await app.inject({
      method: "POST", url: "/v1/pods", payload: { operationId, templateId: null },
    });
    assert.equal(replay.statusCode, 400, replay.body);
    const after = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pods WHERE org_id = $1",
      [orgId],
    );
    assert.equal(after.rows[0]!.count, before.rows[0]!.count);
  });

  it("POST /v1/pods defaults fresh placement to sandbox for both default and explicit-null payloads", async () => {
    const piSettings = {
      user: {
        settings: {
          packages: ["npm:pi-claude-agent-sdk", "npm:pi-meta-oauth"],
        },
      },
    };
    for (const payload of [
      { piSettings },
      { templateId: null, provider: null, piSettings },
    ]) {
      const response = await app.inject({ method: "POST", url: "/v1/pods", payload });
      const body = response.json() as { error: string; detail: unknown };
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(body.error, "no sandbox credential");
      assert.equal(body.error.startsWith("body/"), false);
      assert.match(String(body.detail), /PI_POD_SANDBOX_TOKEN/);
    }
  });

  it("returns sandbox capability findings in the shared doctor/dry-run payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/pods/resolve?check_image=false",
      payload: {
        provider: "sandbox",
        projectConfig: { resources: { diskGB: 5 } },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      warnings: string[];
      layerOrder: string[];
      config: Record<string, unknown>;
    };
    assert.deepEqual(body.layerOrder, ["org", "user", "project"]);
    assert.ok(
      !body.warnings.some((warning) => /cannot apply configured diskGB/.test(warning)),
      JSON.stringify(body.warnings),
    );
    assert.ok(
      body.warnings.some((warning) => /sandbox enforces egress by CIDR/.test(warning)),
      JSON.stringify(body.warnings),
    );
    // Planning froze the placed sandbox host into config.providers (see the fleet suite), and
    // the resolve answer is the one payload a CLI re-validates: the block stays server-side.
    assert.equal("providers" in body.config, false, JSON.stringify(body.config));
    assert.equal(response.body.includes("pi-pod-sandbox:8433"), false);
  });

  it("honors CIDR wildcard projectConfig in preview but ignores it at launch", async () => {
    const egress = {
      mode: "allowlist",
      allow: [
        "*.github.com",
        "*.anthropic.com",
        "*.openai.com",
        "*.example.com",
        "*.npmjs.org",
      ],
    };
    const resolved = await app.inject({
      method: "POST",
      url: "/v1/pods/resolve?check_image=false",
      payload: { provider: "sandbox", projectConfig: { egress } },
    });
    assert.equal(resolved.statusCode, 400, resolved.body);
    const resolvedBody = resolved.json() as { error: string; detail: string };
    assert.match(resolvedBody.error, /"\*\.github\.com"/);
    assert.match(resolvedBody.error, /and 2 more/);
    assert.doesNotMatch(resolvedBody.error, /npmjs/);
    assert.match(resolvedBody.detail, /replace each wildcard with the concrete hostnames/);

    const before = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pods WHERE org_id = $1",
      [orgId],
    );
    const launched = await app.inject({
      method: "POST",
      url: "/v1/pods",
      payload: {
        provider: "sandbox",
        project: { name: "wildcard rejection", config: { egress } },
      },
    });
    assert.equal(launched.statusCode, 400, launched.body);
    assert.equal((launched.json() as { error: string }).error, "no sandbox credential");
    assert.notEqual((launched.json() as { error: string }).error, resolvedBody.error);
    const afterLaunch = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pods WHERE org_id = $1",
      [orgId],
    );
    assert.equal(afterLaunch.rows[0]!.count, before.rows[0]!.count);
  });

  it("ensureSession maps a real missing provider credential during attach to the typed 409 body", async () => {
    const previous = process.env["PI_POD_SANDBOX_TOKEN"];
    delete process.env["PI_POD_SANDBOX_TOKEN"];
    try {
      const gateway = new GatewayService({ env, kek, log });
      await assert.rejects(
        gateway.ensureSession(orgId, podId),
        (error: unknown) => {
          assert.ok(error instanceof HttpError);
          assert.equal(error.statusCode, 409);
          assert.deepEqual(
            { error: error.message, detail: error.detail },
            {
              error: "no sandbox credential",
              detail: "store an org secret named PI_POD_SANDBOX_TOKEN or configure the platform account",
            },
          );
          return true;
        },
      );
    } finally {
      if (previous === undefined) delete process.env["PI_POD_SANDBOX_TOKEN"];
      else process.env["PI_POD_SANDBOX_TOKEN"] = previous;
    }
  });
});
