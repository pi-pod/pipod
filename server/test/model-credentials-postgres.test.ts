import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import WebSocket from "ws";
import { closePool, getPool, initPool, query } from "../src/server/db/index.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import { acquireLease } from "../src/server/model-credentials/lease.js";
import {
  consumeLoginTicket,
  createLoginTicket,
  executeLogin,
  type LoginExec,
} from "../src/server/model-credentials/login.js";
import {
  ensureFreshCredential,
  MIN_VALIDITY_MS,
  type RefreshExec,
} from "../src/server/model-credentials/refresh.js";
import { registerModelCredentialRoutes } from "../src/server/model-credentials/routes.js";
import {
  dbCredentialStore,
  deleteCredential,
  listCredentialMeta,
  readCredentialEntry,
  upsertCredentialEntry,
} from "../src/server/model-credentials/store.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function onceClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe("model credential broker (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  const podId = uuidv7();
  const kek = new EnvKekProvider("model-credentials-test-kek", randomBytes(32).toString("base64"));
  const subject = { orgId, userId };

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'model credentials test')", [orgId]);
    await query(
      "INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)",
      [userId, `${userId}@example.test`, otherUserId, `${otherUserId}@example.test`],
    );
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, state, provider_state, resolved_config, transport)
       VALUES ($1, $2, $3, 'credential login source', 'sandbox', 'active', 'started', '{}'::jsonb, 'ws')`,
      [podId, orgId, userId],
    );
  });

  beforeEach(async () => {
    await query("DELETE FROM model_credential_login_tickets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM model_credentials WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
  });

  after(async () => {
    await query("DELETE FROM model_credential_login_tickets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM model_credentials WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE id = $1", [podId]);
    await query("DELETE FROM users WHERE id IN ($1, $2)", [userId, otherUserId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("upserts, reads, and deletes one provider without touching another", async () => {
    const first = await upsertCredentialEntry(kek, subject, "anthropic", {
      type: "oauth",
      access: "access-a1",
      refresh: "refresh-a1",
      expires: Date.now() + 60 * 60_000,
      accountId: "account-a",
    });
    assert.equal(first.revision, 1);
    await upsertCredentialEntry(kek, subject, "openrouter", {
      type: "api_key",
      key: "key-b",
    });
    const bBefore = await query<{ ciphertext: Buffer; revision: string }>(
      `SELECT ciphertext, revision FROM model_credentials
       WHERE org_id = $1 AND user_id = $2 AND provider_id = 'openrouter'`,
      [orgId, userId],
    );

    const second = await upsertCredentialEntry(kek, subject, "anthropic", {
      type: "oauth",
      access: "access-a2",
      refresh: "refresh-a2",
      expires: Date.now() + 2 * 60 * 60_000,
      enterpriseUrl: "https://example.test",
    });
    assert.equal(second.revision, 2);
    const read = await readCredentialEntry(kek, subject, "anthropic");
    assert.equal(read?.["type"], "oauth");
    assert.equal(read?.["access"], "access-a2");
    assert.equal(read?.["refresh"], "refresh-a2");
    assert.equal(read?.["enterpriseUrl"], "https://example.test");
    assert.equal(typeof read?.["expires"], "number");

    const bAfter = await query<{ ciphertext: Buffer; revision: string }>(
      `SELECT ciphertext, revision FROM model_credentials
       WHERE org_id = $1 AND user_id = $2 AND provider_id = 'openrouter'`,
      [orgId, userId],
    );
    assert.equal(bAfter.rows[0]?.revision, bBefore.rows[0]?.revision);
    assert.deepEqual(bAfter.rows[0]?.ciphertext, bBefore.rows[0]?.ciphertext);
    assert.equal(await deleteCredential(subject, "anthropic"), true);
    assert.equal(await deleteCredential(subject, "anthropic"), false);
    assert.equal((await readCredentialEntry(kek, subject, "openrouter"))?.["key"], "key-b");
  });

  it("dbCredentialStore.modify persists each rotation before the next reader", async () => {
    await upsertCredentialEntry(kek, subject, "anthropic", {
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: Date.now() + 10_000,
    });
    const store = dbCredentialStore(kek, subject);
    await store.modify("anthropic", async (current) => {
      assert.equal(current?.type, "oauth");
      return { ...current!, access: "access-2", refresh: "refresh-2" };
    });
    await store.modify("anthropic", async (current) => {
      assert.equal(current?.type, "oauth");
      assert.equal((current as { access?: string }).access, "access-2");
      return { ...current!, access: "access-3", refresh: "refresh-3" };
    });
    const stored = await readCredentialEntry(kek, subject, "anthropic");
    assert.equal(stored?.["access"], "access-3");
    assert.equal((await listCredentialMeta(subject))[0]?.revision, 3);
    await store.modify("anthropic", async (current) => {
      assert.equal((current as { access?: string }).access, "access-3");
      return undefined;
    });
    assert.equal(await readCredentialEntry(kek, subject, "anthropic"), null);
  });

  it("times out a held provider lock without blocking independent providers or exhausting the pool", async () => {
    for (const providerId of ["anthropic", "openrouter"]) {
      await upsertCredentialEntry(kek, subject, providerId, {
        type: "oauth",
        access: `${providerId}-old-access`,
        refresh: `${providerId}-refresh`,
        expires: Date.now() - 1,
      });
    }
    const holder = await getPool().connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT ciphertext FROM model_credentials
         WHERE org_id = $1 AND user_id = $2 AND provider_id = 'anthropic' FOR UPDATE`,
        [orgId, userId],
      );

      const started = Date.now();
      const blocked = ensureFreshCredential(kek, subject, "anthropic", MIN_VALIDITY_MS, {
        refreshExec: async () => assert.fail("the locked row must not reach refresh"),
      });
      await delay(50);
      const independent = await ensureFreshCredential(kek, subject, "openrouter", MIN_VALIDITY_MS, {
        refreshExec: async (entry) => ({ ...entry, access: "openrouter-new-access", expires: Date.now() + 60 * 60_000 }),
      });
      assert.deepEqual(independent, { state: "ready" });
      assert.equal((await query("SELECT 1")).rowCount, 1, "the pool still serves unrelated queries");
      assert.deepEqual(await blocked, { state: "temporarily_unavailable" });
      assert.ok(Date.now() - started < 30_000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("refreshes successfully and persists terminal refresh classifications", async () => {
    await upsertCredentialEntry(kek, subject, "anthropic", {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: Date.now() - 1,
    });
    const outcome = await ensureFreshCredential(kek, subject, "anthropic", MIN_VALIDITY_MS, {
      refreshExec: async (entry) => ({
        ...entry,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 2 * 60 * 60_000,
      }),
    });
    assert.deepEqual(outcome, { state: "ready" });
    const successMeta = (await listCredentialMeta(subject))[0]!;
    assert.equal(successMeta.revision, 2);
    assert.ok(successMeta.lastRefreshAt);
    assert.equal((await readCredentialEntry(kek, subject, "anthropic"))?.["refresh"], "rotated-refresh");

    await upsertCredentialEntry(kek, subject, "xai", {
      type: "oauth",
      access: "xai-access",
      refresh: "xai-refresh",
      expires: Date.now() - 1,
    });
    const rejected = await ensureFreshCredential(kek, subject, "xai", MIN_VALIDITY_MS, {
      refreshExec: async () => { throw new Error("invalid_grant"); },
    });
    assert.deepEqual(rejected, { state: "reconnect_required", reason: "invalid_grant" });
    assert.equal((await listCredentialMeta(subject)).find((m) => m.providerId === "xai")?.lastFailureCode, "invalid_grant");

    await upsertCredentialEntry(kek, subject, "openai-codex", {
      type: "oauth",
      access: "codex-access",
      expires: Date.now() - 1,
    });
    const missing = await ensureFreshCredential(kek, subject, "openai-codex", MIN_VALIDITY_MS, {
      refreshExec: async () => assert.fail("no refresh grant must fail before network"),
    });
    assert.deepEqual(missing, { state: "reconnect_required", reason: "missing_refresh_token" });
  });

  it("acquires stable sanitized leases and keeps a still-valid token through a transient outage", async () => {
    const now = Date.now();
    await upsertCredentialEntry(kek, subject, "anthropic", {
      type: "oauth",
      access: "anthropic-access",
      refresh: "anthropic-refresh",
      expires: now + 2 * 60 * 60_000,
      scope: "user:inference",
    });
    await upsertCredentialEntry(kek, subject, "openrouter", { type: "api_key", key: "openrouter-key" });
    await upsertCredentialEntry(kek, subject, "xai", {
      type: "oauth",
      access: "xai-access",
      refresh: "xai-refresh",
      expires: now + 20 * 60_000,
    });
    await upsertCredentialEntry(kek, subject, "openai-codex", {
      type: "oauth",
      access: "codex-access",
      refresh: "codex-refresh",
      expires: now + 2 * 60 * 60_000,
    });
    await query(
      `UPDATE model_credentials SET last_failure_code = 'revoked', last_failure_at = now()
       WHERE org_id = $1 AND user_id = $2 AND provider_id = 'openai-codex'`,
      [orgId, userId],
    );
    const refreshExec: RefreshExec = async () => { throw new Error("fetch failed"); };
    const ids = ["anthropic", "openrouter", "xai", "openai-codex", "missing-provider"];
    const first = await acquireLease(kek, subject, ids, MIN_VALIDITY_MS, { refreshExec });
    assert.deepEqual(Object.keys(first.lease.providers).sort(), ["anthropic", "openrouter", "xai"]);
    assert.equal(first.lease.providers.anthropic?.entry["refresh"], undefined);
    assert.equal(first.lease.providers.xai?.entry["refresh"], undefined);
    assert.equal(first.lease.providers.anthropic?.entry["scope"], "user:inference");
    assert.deepEqual(first.failures["missing-provider"], { state: "missing" });
    assert.deepEqual(first.failures["openai-codex"], { state: "reconnect_required", reason: "revoked" });
    assert.equal(first.failures.xai, undefined, "a provider outage does not discard an unexpired access token");

    const second = await acquireLease(kek, subject, ids, MIN_VALIDITY_MS, { refreshExec });
    assert.equal(second.lease.revision, first.lease.revision, "identical provider revisions support unchanged/304 detection");
  });

  it("mints login tickets that are one-shot and rejects expired and unknown values", async () => {
    const oneShot = await createLoginTicket(subject, "anthropic", "oauth");
    assert.match(oneShot.ticket, /^mclt_[A-Za-z0-9_-]{43}$/);
    assert.equal((await consumeLoginTicket(oneShot.ticket))?.providerId, "anthropic");
    assert.equal(await consumeLoginTicket(oneShot.ticket), null);
    assert.equal(await consumeLoginTicket("mclt_not-a-real-ticket"), null);

    const expired = await createLoginTicket(subject, "anthropic", "oauth", podId);
    await query(
      "UPDATE model_credential_login_tickets SET expires_at = now() - interval '1 second' WHERE ticket_hash IS NOT NULL",
    );
    assert.equal(await consumeLoginTicket(expired.ticket), null);
  });

  it("executes provider-scoped login and removes an OAuth result without a refresh grant", async () => {
    await upsertCredentialEntry(kek, subject, "openrouter", { type: "api_key", key: "untouched-key" });
    const before = (await listCredentialMeta(subject)).find((m) => m.providerId === "openrouter")!;
    const interaction = { prompt: async () => "answer", notify: () => {} };
    const loginExec: LoginExec = async (providerId, authType) => {
      assert.equal(providerId, "anthropic");
      assert.equal(authType, "api_key");
      await upsertCredentialEntry(kek, subject, providerId, { type: "api_key", key: "stored-key" });
    };
    const status = await executeLogin(kek, subject, "anthropic", "api_key", interaction, { loginExec });
    assert.equal(status.state, "ready");
    assert.equal((await listCredentialMeta(subject)).find((m) => m.providerId === "openrouter")?.revision, before.revision);

    await assert.rejects(
      () => executeLogin(kek, subject, "openai-codex", "oauth", interaction, {
        loginExec: async (providerId) => {
          await upsertCredentialEntry(kek, subject, providerId, {
            type: "oauth",
            access: "access-without-refresh",
            expires: Date.now() + 60 * 60_000,
          });
        },
      }),
      (error: unknown) =>
        error instanceof HttpError &&
        error.statusCode === 400 &&
        (error.detail as { code?: string }).code === "missing_refresh_token",
    );
    assert.equal(await readCredentialEntry(kek, subject, "openai-codex"), null);
  });

  it("serves status, ticket, test, delete, and interactive login routes", async () => {
    let routeApp: ReturnType<typeof Fastify> | undefined;
    let baseUrl = "";
    const routeLoginExec: LoginExec = async (providerId, authType, interaction) => {
      interaction.notify({ type: "progress", message: "Waiting for account input" });
      const value = await interaction.prompt({ type: "secret", message: "API key" });
      await upsertCredentialEntry(kek, subject, providerId, { type: authType, key: value });
    };
    try {
      routeApp = Fastify({ logger: false });
      routeApp.setValidatorCompiler(validatorCompiler);
      routeApp.setSerializerCompiler(serializerCompiler);
      await routeApp.register(websocket);
      routeApp.decorate("authenticate", async (req: { auth?: unknown }) => {
        req.auth = { userId, orgId, email: `${userId}@example.test`, permissions: [] };
      });
      routeApp.setErrorHandler((error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
        if (error instanceof HttpError) {
          return reply.code(error.statusCode).send({ error: error.message, detail: error.detail ?? null });
        }
        return reply.send(error);
      });
      registerModelCredentialRoutes(routeApp, { kek, loginExec: routeLoginExec });
      const address = await routeApp.listen({ host: "127.0.0.1", port: 0 });
      baseUrl = address.replace(/^http/, "ws");

      await upsertCredentialEntry(kek, subject, "openrouter", { type: "api_key", key: "route-secret" });
      const listed = await routeApp.inject({ method: "GET", url: "/model-credentials" });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.body.includes("route-secret"), false);
      assert.equal(listed.body.includes("ciphertext"), false);
      assert.ok(listed.json().credentials.some((s: { providerId: string }) => s.providerId === "openrouter"));
      const anthropicProvider = listed.json().providers.find((p: { id: string }) => p.id === "anthropic");
      assert.equal(anthropicProvider.name, "Anthropic (Claude Pro/Max)");
      assert.equal(typeof anthropicProvider.oauth.loginLabel, "string");
      assert.equal(anthropicProvider.apiKey, true);
      assert.equal(anthropicProvider.brokerSupported, true);

      const unsupported = await routeApp.inject({
        method: "POST",
        url: "/model-credentials/made-up-extension/login-ticket",
        payload: { authType: "oauth" },
      });
      assert.equal(unsupported.statusCode, 400);
      assert.equal(unsupported.json().detail.code, "credential_provider_unsupported");

      const absentTest = await routeApp.inject({ method: "POST", url: "/model-credentials/anthropic/test" });
      assert.equal(absentTest.statusCode, 404);

      const removed = await routeApp.inject({ method: "DELETE", url: "/model-credentials/openrouter" });
      assert.equal(removed.statusCode, 204);
      assert.equal((await routeApp.inject({ method: "DELETE", url: "/model-credentials/openrouter" })).statusCode, 404);

      const ticketResponse = await routeApp.inject({
        method: "POST",
        url: "/model-credentials/anthropic/login-ticket",
        payload: { authType: "api_key", podId },
      });
      assert.equal(ticketResponse.statusCode, 201);
      const ticket = ticketResponse.json().ticket as string;
      const socket = new WebSocket(`${baseUrl}/model-credentials/anthropic/login?ticket=${encodeURIComponent(ticket)}`);
      const messages: Array<Record<string, unknown>> = [];
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        messages.push(message);
        if (message.type === "prompt") {
          socket.send(JSON.stringify({ type: "response", id: message.id, value: "entered-key" }));
        }
      });
      const socketClosed = onceClose(socket);
      await onceOpen(socket);
      assert.deepEqual(await socketClosed, { code: 1000, reason: "done" });
      assert.ok(messages.some((m) => m.type === "event"));
      const done = messages.find((m) => m.type === "done")!;
      assert.equal(done.ok, true);
      assert.equal(JSON.stringify(done).includes("entered-key"), false);
      const attachedPod = await query<{ credential_providers: string[] | null }>(
        "SELECT credential_providers FROM pods WHERE id = $1",
        [podId],
      );
      assert.deepEqual(attachedPod.rows[0]?.credential_providers, ["anthropic"]);

      const reused = new WebSocket(`${baseUrl}/model-credentials/anthropic/login?ticket=${encodeURIComponent(ticket)}`);
      assert.deepEqual(await onceClose(reused), { code: 4001, reason: "invalid_ticket" });

      const cancelTicket = (await routeApp.inject({
        method: "POST",
        url: "/model-credentials/anthropic/login-ticket",
        payload: { authType: "api_key" },
      })).json().ticket as string;
      const cancelled = new WebSocket(`${baseUrl}/model-credentials/anthropic/login?ticket=${encodeURIComponent(cancelTicket)}`);
      const cancelledMessages: Array<Record<string, unknown>> = [];
      cancelled.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        cancelledMessages.push(message);
        if (message.type === "prompt") cancelled.send(JSON.stringify({ type: "cancel" }));
      });
      const cancelledClosed = onceClose(cancelled);
      await onceOpen(cancelled);
      assert.deepEqual(await cancelledClosed, { code: 1000, reason: "done" });
      assert.ok(cancelledMessages.some((m) => m.type === "done" && m.ok === false));

      const audits = await query<{ detail: Record<string, unknown> }>(
        "SELECT detail FROM audit_log WHERE org_id = $1 AND action LIKE 'model_credentials.%'",
        [orgId],
      );
      const auditJson = JSON.stringify(audits.rows.map((row) => row.detail));
      assert.equal(auditJson.includes("entered-key"), false);
      assert.equal(auditJson.includes("route-secret"), false);
      assert.equal(auditJson.includes("refresh"), false);
      assert.ok(
        audits.rows.every((row) =>
          Object.keys(row.detail).every((key) => ["provider", "outcome", "providers", "state"].includes(key)),
        ),
      );
    } finally {
      await routeApp?.close();
    }
  });
});
