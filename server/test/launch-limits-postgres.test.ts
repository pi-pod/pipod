import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { registerProvider, unregisterProvider } from "../src/core/providers/registry.js";
import type { SandboxProvider } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import { registerPodRoutes } from "../src/server/pods/routes.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { writeLayer } from "../src/server/settings/merge.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

const env = {
  GATEWAY_ID: "gateway-launch-limits",
  LOG_LEVEL: "silent",
  WEB_ORIGINS: [],
  PI_POD_SANDBOX_TOKEN: "test-provider-token",
  PI_POD_SANDBOX_URL: "http://pi-pod-sandbox:8433",
  PI_POD_SANDBOX_IMAGE_MIRROR: "ghcr.io/pi-pod",
  POD_MAX_CONCURRENT_PER_USER: 20,
  POD_MAX_CPU: 2,
  POD_MAX_MEMORY_GB: 4,
  POD_MAX_DISK_GB: 20,
} as unknown as ServerEnv;
const log = { info: () => {}, warn: () => {}, error: () => {} };

/** The per-user cap needs real SQL: it is a count over the pods table scoped to the launcher. */
describe("deployment launch limits (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const deps: PodServiceDeps = { env, kek, log };
  const previousToken = process.env["PI_POD_SANDBOX_TOKEN"];
  const provider = {
    name: "sandbox",
    capabilities: {},
    resolveImage: async () => null,
  } as unknown as SandboxProvider;
  let app: FastifyInstance;

  async function seedPods(owner: string, providerState: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await query(
        `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
         VALUES ($1, $2, $3, $4, 'sandbox', $5, 'active', $6, $7::jsonb)`,
        [uuidv7(), orgId, owner, `seed ${providerState} ${i}`, `sb-${uuidv7()}`, providerState, JSON.stringify({ config: { providers: {} }, workdir: "/workspace" })],
      );
    }
  }

  async function launch(payload: Record<string, unknown> = { provider: "sandbox" }) {
    const response = await app.inject({ method: "POST", url: "/v1/pods", payload });
    return { status: response.statusCode, body: response.json() as { error?: string }, text: response.body };
  }

  /**
   * The fake provider holds no image and cannot build one, so a launch that passes the
   * concurrency check fails deterministically at image preparation, after the cap check and
   * before any pod row exists. That failure is this suite's "admitted" signal.
   */
  const ADMITTED = /cannot prepare managed image/;

  before(async () => {
    initPool(databaseUrl!);
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-provider-token";
    registerProvider("sandbox", async () => () => provider);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'launch limits test')", [orgId]);
    for (const id of [userId, otherUserId]) {
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    }

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof HttpError) {
        return reply.code(error.statusCode).send({ error: error.message, detail: error.detail ?? null });
      }
      return reply.code(500).send({ error: error.message, detail: null });
    });
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      req.auth = { userId, email: `${userId}@example.test`, orgId, permissions: ["pods:launch"] };
    });
    await app.register(async (v1: FastifyInstance) => registerPodRoutes(v1, deps, null), { prefix: "/v1" });
    await app.ready();
  });

  after(async () => {
    await app.close();
    unregisterProvider("sandbox");
    if (previousToken === undefined) delete process.env["PI_POD_SANDBOX_TOKEN"];
    else process.env["PI_POD_SANDBOX_TOKEN"] = previousToken;
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    for (const id of [userId, otherUserId]) await query("DELETE FROM users WHERE id = $1", [id]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("clamps a launch asking for more than the deployment ceiling and says so", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/pods/resolve?check_image=false",
      payload: { provider: "sandbox", projectConfig: { resources: { cpu: 4, memoryGB: 4, diskGB: 50 } } },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { warnings: string[]; config: { resources: { cpu: number; memoryGB: number; diskGB: number } } };
    assert.deepEqual(body.config.resources, { cpu: 2, memoryGB: 4, diskGB: 20 });
    assert.ok(
      body.warnings.includes("diskGB is configured as 50, but this deployment supports at most 20 — using 20"),
      JSON.stringify(body.warnings),
    );
  });

  it("refuses memory above the 4 GiB standard while 8 GiB is gated (never clamps 8→4)", async () => {
    // §7.4 (capacity workstream): an advertised 8-GiB request must either land
    // on 8 GiB or fail clearly — silently running it at 4 GiB is a bug.
    const response = await app.inject({
      method: "POST",
      url: "/v1/pods/resolve?check_image=false",
      payload: { provider: "sandbox", projectConfig: { resources: { memoryGB: 8 } } },
    });
    assert.equal(response.statusCode, 400, response.body);
    const body = response.json() as { error: string; detail?: unknown };
    assert.match(body.error ?? "", /exceeds this deployment's 4 GiB per-sandbox limit/);
  });

  it("resolves a layer-less platform launch to the 2/4/20 standard with provenance", async () => {
    // Canary gap (2026-09-06): native default disk is 10 and built-in 5 — a
    // platform-funded native launch with NO explicit disk config must get 20.
    // Resolve-only: no pod row, no sandbox, nothing started.
    const response = await app.inject({
      method: "POST",
      url: "/v1/pods/resolve?check_image=false",
      payload: { provider: "sandbox", projectConfig: {} },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      config: { resources: { cpu: number; memoryGB: number; diskGB: number } };
      configProvenance: Array<{ path: string; winner: string; over: string[] }>;
    };
    assert.deepEqual(body.config.resources, { cpu: 2, memoryGB: 4, diskGB: 20 });
    const diskProvenance = body.configProvenance.filter((entry) => entry.path === "resources.diskGB");
    assert.deepEqual(diskProvenance, [{ path: "resources.diskGB", winner: "platform-default", over: [] }]);
  });

  it("keeps an explicit diskGB 5 exactly as configured (no silent upgrade)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/pods/resolve?check_image=false",
      payload: { provider: "sandbox", projectConfig: { resources: { diskGB: 5 } } },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      config: { resources: { cpu: number; memoryGB: number; diskGB: number } };
      configProvenance: Array<{ path: string; winner: string; over: string[] }>;
    };
    assert.equal(body.config.resources.diskGB, 5);
    const diskProvenance = body.configProvenance.filter((entry) => entry.path === "resources.diskGB");
    assert.ok(
      diskProvenance.length > 0 && diskProvenance.every((entry) => entry.winner !== "platform-default"),
      JSON.stringify(body.configProvenance),
    );
  });

  it("refuses the twenty-first concurrent pod for a user, counting only that user's holding pods", async () => {
    // Stopped pods and other users' pods do not count toward this user's cap.
    await seedPods(userId, "stopped", 20);
    await seedPods(otherUserId, "started", 10);
    await seedPods(userId, "started", 19);
    const before = await query<{ n: string }>("SELECT count(*) AS n FROM pods WHERE org_id = $1", [orgId]);

    const twentieth = await launch();
    assert.equal(twentieth.status, 400, twentieth.text);
    assert.match(twentieth.body.error ?? "", ADMITTED);

    await seedPods(userId, "started", 1);
    const twentyFirst = await launch();
    assert.equal(twentyFirst.status, 409, twentyFirst.text);
    assert.equal(
      twentyFirst.body.error,
      "this deployment caps concurrent pods per user at 20; stop or let another pod sleep first",
    );
    const after = await query<{ n: string }>("SELECT count(*) AS n FROM pods WHERE org_id = $1", [orgId]);
    assert.equal(Number(after.rows[0]!.n), Number(before.rows[0]!.n) + 1, "neither launch left a pod row");
  });

  it("lets an org policy narrow the cap but never raise it", async () => {
    const version = await writeLayer({
      scopeType: "org_policy",
      scopeId: orgId,
      orgId,
      config: { maxConcurrentPods: 50 },
      expectedVersion: 0,
      updatedBy: userId,
    });
    const raised = await launch();
    assert.equal(raised.status, 409, raised.text);
    assert.equal(
      raised.body.error,
      "this deployment caps concurrent pods per user at 20; stop or let another pod sleep first",
    );

    // With this user idle, the org's 10 awake pods (all the other user's) sit under the
    // org policy of 50, so the launch is admitted...
    await query("UPDATE pods SET provider_state = 'stopped' WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
    const admitted = await launch();
    assert.equal(admitted.status, 400, admitted.text);
    assert.match(admitted.body.error ?? "", ADMITTED);

    // ...until the org narrows its own cap to 10.
    await writeLayer({
      scopeType: "org_policy",
      scopeId: orgId,
      orgId,
      config: { maxConcurrentPods: 10 },
      expectedVersion: version,
      updatedBy: userId,
    });
    const narrowed = await launch();
    assert.equal(narrowed.status, 409, narrowed.text);
    assert.equal(
      narrowed.body.error,
      "org policy caps concurrent pods at 10; stop or let another pod sleep first",
    );
  });
});
