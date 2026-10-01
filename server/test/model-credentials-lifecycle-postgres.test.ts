import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { PiPodConfig } from "../src/core/config.js";
import type { Sandbox } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { extendPodCredentialContractForModel } from "../src/server/gateway/service.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import { acquireLease } from "../src/server/model-credentials/lease.js";
import { materializeCredentialLease } from "../src/server/model-credentials/materializer.js";
import {
  listCredentialMeta,
  upsertCredentialEntry,
  type CredentialMeta,
} from "../src/server/model-credentials/store.js";
import { planLaunchCredentials } from "../src/server/pods/planning.js";
import { materializeLaunchCredentialLease } from "../src/server/pods/provisioning.js";
import { registerPodRoutes } from "../src/server/pods/routes.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const AUTH_PATH = "/root/.pi/agent/auth.json";
const TMP_PATH = "/tmp/pi-pod-auth.json";
const log = { info: () => {}, warn: () => {}, error: () => {} };
const env = { GATEWAY_ID: "gateway-model-credential-lifecycle" } as unknown as ServerEnv;

function fakeSandbox(initial: Record<string, string> = {}) {
  const files = new Map<string, { contents: Uint8Array; mode?: number }>();
  for (const [path, text] of Object.entries(initial)) {
    files.set(path, { contents: new TextEncoder().encode(text), mode: 0o600 });
  }
  const sandbox = {
    uploadFile: async (path: string, contents: Uint8Array, mode?: number) => {
      files.set(path, { contents, mode });
    },
    exec: async (argv: string[]) => {
      if (argv[0] === "cat" && argv[1]) {
        const file = files.get(argv[1]);
        if (!file) return { exitCode: 1, output: "" };
        return { exitCode: 0, output: new TextDecoder().decode(file.contents) };
      }
      if (argv[0] === "bash" && argv[1] === "-c" && typeof argv[2] === "string") {
        const mv = /mv\s+(\S+)\s+(\S+)/.exec(argv[2]);
        if (!mv) return { exitCode: 1, output: "" };
        const src = files.get(mv[1]!);
        if (!src) return { exitCode: 1, output: "" };
        files.set(mv[2]!, src);
        files.delete(mv[1]!);
        return { exitCode: 0, output: "" };
      }
      return { exitCode: 1, output: "" };
    },
  };
  return { sandbox: sandbox as unknown as Sandbox, files };
}

function readAuthJson(files: Map<string, { contents: Uint8Array; mode?: number }>): Record<string, Record<string, unknown>> {
  const file = files.get(AUTH_PATH);
  assert.ok(file, `expected ${AUTH_PATH} to exist`);
  return JSON.parse(new TextDecoder().decode(file.contents)) as Record<string, Record<string, unknown>>;
}

function reconnectMeta(overrides: Partial<CredentialMeta> = {}): CredentialMeta {
  return {
    id: uuidv7(),
    orgId: "00000000-0000-7000-8000-000000000002",
    userId: "00000000-0000-7000-8000-000000000003",
    providerId: "anthropic",
    type: "oauth",
    keyId: "kek-1",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    revision: 1,
    lastRefreshAt: null,
    lastFailureCode: "invalid_grant",
    lastFailureAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("model credential lifecycle (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const rootId = uuidv7();
  const siblingAId = uuidv7();
  const siblingBId = uuidv7();
  const kek = new EnvKekProvider("model-credentials-lifecycle-kek", randomBytes(32).toString("base64"));
  const subject = { orgId, userId };
  const deps: PodServiceDeps = { env, kek, log };
  let auth: {
    userId: string;
    email: string;
    orgId: string;
    permissions: string[];
    podId?: string;
  };
  let app: ReturnType<typeof Fastify>;

  async function insertPod(args: {
    id: string;
    parent?: string | null;
    root?: string;
    depth?: number;
  }): Promise<void> {
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, state, provider_state, resolved_config, transport,
          parent_pod_id, lineage_root_id, lineage_depth)
       VALUES ($1, $2, $3, 'credential lifecycle', 'sandbox', 'active', 'started', '{}'::jsonb, 'ws',
               $4, $5, $6)`,
      [args.id, orgId, userId, args.parent ?? null, args.root ?? args.id, args.depth ?? 0],
    );
  }

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'model credential lifecycle')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await insertPod({ id: rootId, root: rootId, depth: 0 });
    await insertPod({ id: siblingAId, parent: rootId, root: rootId, depth: 1 });
    await insertPod({ id: siblingBId, parent: rootId, root: rootId, depth: 1 });

    auth = {
      userId,
      email: `${userId}@example.test`,
      orgId,
      permissions: [],
    };
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
      req.auth = auth;
    });
    registerPodRoutes(app, deps, null);
    await app.ready();
  });

  beforeEach(async () => {
    auth = {
      userId,
      email: `${userId}@example.test`,
      orgId,
      permissions: [],
    };
    await query("DELETE FROM model_credentials WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("UPDATE pods SET credential_providers = NULL WHERE org_id = $1", [orgId]);
  });

  after(async () => {
    await app.close();
    await query("DELETE FROM model_credentials WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query(
      "UPDATE pods SET parent_pod_id = NULL, host_pod_id = NULL, lineage_root_id = NULL WHERE org_id = $1",
      [orgId],
    );
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("planLaunchCredentials throws typed 409 when a required provider is invalid_grant", () => {
    assert.throws(
      () =>
        planLaunchCredentials({
          metas: [reconnectMeta({ lastFailureCode: "invalid_grant" })],
          config: { pi: { model: "anthropic/claude-opus-4-7" } } as Pick<PiPodConfig, "pi">,
          piSettings: null,
        }),
      (error: unknown) => {
        if (!(error instanceof HttpError)) return false;
        const detail = error.detail as { code?: string; provider?: string; requiredBy?: string };
        return (
          error.statusCode === 409 &&
          error.message === "credential_reconnect_required" &&
          detail.code === "credential_reconnect_required" &&
          detail.provider === "anthropic" &&
          detail.requiredBy === "anthropic"
        );
      },
    );
  });

  it("model-less launch with a ready provider leases and materializes its auth entry", async () => {
    await upsertCredentialEntry(kek, subject, "openrouter", {
      type: "api_key",
      key: "lease-key",
    });
    // M5 shape: no pinned model, no selectable settings providers, one READY credential.
    const { piAuth, credentialContract } = planLaunchCredentials({
      metas: await listCredentialMeta(subject),
      config: { pi: {} } as Pick<PiPodConfig, "pi">,
      piSettings: null,
    });
    assert.deepEqual(piAuth, { providers: ["openrouter"] });
    assert.deepEqual(credentialContract, ["openrouter"]);
    const { lease } = await acquireLease(kek, subject, credentialContract, 30 * 60 * 1000);
    assert.deepEqual(Object.keys(lease.providers).sort(), ["openrouter"]);
    const { sandbox, files } = fakeSandbox();
    await materializeCredentialLease(sandbox, lease);
    // Key NAMES only: values must never be asserted, printed, or logged.
    assert.deepEqual(Object.keys(readAuthJson(files)).sort(), ["openrouter"]);
  });

  it("GET model-credential-lease returns the exact lease then 304 for the same revision", async () => {
    const expires = Date.now() + 2 * 60 * 60_000;
    await upsertCredentialEntry(kek, subject, "anthropic", {
      type: "oauth",
      access: "lease-access",
      refresh: "lease-refresh",
      expires,
      accountId: "acct-lease",
    });
    await query("UPDATE pods SET credential_providers = ARRAY['anthropic'] WHERE id = $1", [rootId]);

    const expected = await acquireLease(kek, subject, ["anthropic"], 30 * 60 * 1000);
    const fresh = await app.inject({ method: "GET", url: `/pods/${rootId}/model-credential-lease` });
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.deepEqual(fresh.json(), {
      revision: expected.lease.revision,
      providers: expected.lease.providers,
    });
    assert.equal(fresh.body.includes("lease-refresh"), false);
    assert.equal(fresh.json().providers.anthropic.entry.refresh, undefined);
    assert.equal(fresh.json().providers.anthropic.entry.access, "lease-access");

    const unchanged = await app.inject({
      method: "GET",
      url: `/pods/${rootId}/model-credential-lease?revision=${expected.lease.revision}`,
    });
    assert.equal(unchanged.statusCode, 304, unchanged.body);
  });

  it("pod token rooted at a different sibling receives 403 for the lease", async () => {
    auth = { ...auth, podId: siblingAId };
    const refused = await app.inject({
      method: "GET",
      url: `/pods/${siblingBId}/model-credential-lease`,
    });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(refused.json().error, "a pod token may only inspect pods it launched");
  });

  it("materializeLaunchCredentialLease writes access without refresh and persists the contract", async () => {
    const expires = Date.now() + 2 * 60 * 60_000;
    await upsertCredentialEntry(kek, subject, "anthropic", {
      type: "oauth",
      access: "materialize-access",
      refresh: "materialize-refresh",
      expires,
      accountId: "acct-materialize",
    });
    const { sandbox, files } = fakeSandbox();
    await materializeLaunchCredentialLease({
      kek,
      sandbox,
      execEnv: {},
      podId: rootId,
      orgId,
      userId,
      credentialContract: ["anthropic"],
      config: { pi: { model: "anthropic/claude-opus-4-7" } } as PiPodConfig,
      piSettings: null,
    });

    const written = readAuthJson(files);
    assert.equal(written["anthropic"]?.["type"], "oauth");
    assert.equal(written["anthropic"]?.["access"], "materialize-access");
    assert.equal(written["anthropic"]?.["accountId"], "acct-materialize");
    assert.equal(written["anthropic"]?.["expires"], expires);
    assert.equal(Object.hasOwn(written["anthropic"] ?? {}, "refresh"), false);
    assert.equal(JSON.stringify(written).includes("refresh"), false);
    assert.equal(files.has(TMP_PATH), false);

    const row = await query<{ credential_providers: string[] | null }>(
      "SELECT credential_providers FROM pods WHERE id = $1",
      [rootId],
    );
    assert.deepEqual(row.rows[0]?.credential_providers, ["anthropic"]);
  });

  it("extendPodCredentialContractForModel adds a missing provider without setModel", async () => {
    await query("UPDATE pods SET credential_providers = ARRAY['anthropic'] WHERE id = $1", [rootId]);
    const { sandbox } = fakeSandbox();
    const next = await extendPodCredentialContractForModel({
      kek,
      pod: { id: rootId, org_id: orgId },
      sandbox,
      modelProvider: "xai",
    });
    assert.deepEqual(next, ["anthropic", "xai"]);
    const row = await query<{ credential_providers: string[] | null }>(
      "SELECT credential_providers FROM pods WHERE id = $1",
      [rootId],
    );
    assert.deepEqual(row.rows[0]?.credential_providers, ["anthropic", "xai"]);
  });

  it("blocks a model switch on reconnect_required and rolls back its contract expansion", async () => {
    await upsertCredentialEntry(kek, subject, "anthropic", {
      type: "oauth",
      access: "terminal-access",
      refresh: "terminal-refresh",
      expires: Date.now() + 2 * 60 * 60_000,
    });
    await query(
      `UPDATE model_credentials SET last_failure_code = 'invalid_grant'
        WHERE org_id = $1 AND user_id = $2 AND provider_id = 'anthropic'`,
      [orgId, userId],
    );
    await query("UPDATE pods SET credential_providers = ARRAY[]::text[] WHERE id = $1", [rootId]);

    const { sandbox } = fakeSandbox();
    await assert.rejects(
      extendPodCredentialContractForModel({
        kek,
        pod: { id: rootId, org_id: orgId },
        sandbox,
        modelProvider: "anthropic",
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 409 &&
        error.message === "credential_reconnect_required" &&
        (error.detail as { provider?: string }).provider === "anthropic",
    );
    const row = await query<{ credential_providers: string[] | null }>(
      "SELECT credential_providers FROM pods WHERE id = $1",
      [rootId],
    );
    assert.deepEqual(row.rows[0]?.credential_providers, []);
  });
});
