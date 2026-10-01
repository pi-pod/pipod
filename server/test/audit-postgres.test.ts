/**
 * The audit trail end to end: what `audit()` writes is what `GET /orgs/:id/audit` returns,
 * scoped to one organization and gated on `audit:read`. Needs Postgres because the ordering,
 * the org scope, and the `before` cursor are all SQL.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { audit } from "../src/server/audit.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { registerOrgRoutes } from "../src/server/orgs/routes.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const env = { ZITADEL_ISSUER: "http://127.0.0.1:8081" } as unknown as ServerEnv;

interface AuditEntryRow {
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

describe("audit log (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const otherOrgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  let auth = {
    userId,
    email: `${userId}@example.test`,
    orgId,
    permissions: ["audit:read"] as string[],
  };
  let app: ReturnType<typeof Fastify>;

  const read = async (queryString = ""): Promise<AuditEntryRow[]> => {
    const response = await app.inject({ method: "GET", url: `/orgs/${orgId}/audit${queryString}` });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().entries as AuditEntryRow[];
  };

  /** An entry at a fixed instant, so ordering and the cursor do not race the clock. */
  const writeAgo = async (action: string, secondsAgo: number): Promise<void> => {
    await audit({ orgId, actorId: userId, action });
    await query(
      "UPDATE audit_log SET created_at = now() - ($3 || ' seconds')::interval WHERE org_id = $1 AND action = $2",
      [orgId, action, secondsAgo],
    );
  };

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'audit test'), ($2, 'audit test other')", [
      orgId,
      otherOrgId,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate("authenticate", async (req: { auth?: unknown }) => { req.auth = auth; });
    registerOrgRoutes(app, env);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await query("DELETE FROM audit_log WHERE org_id IN ($1, $2)", [orgId, otherOrgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id IN ($1, $2)", [orgId, otherOrgId]);
    await closePool();
  });

  beforeEach(async () => {
    auth = { userId, email: `${userId}@example.test`, orgId, permissions: ["audit:read"] };
    await query("DELETE FROM audit_log WHERE org_id IN ($1, $2)", [orgId, otherOrgId]);
  });

  it("reads back the actor, target, and detail of a critical action", async () => {
    await audit({
      orgId,
      actorId: userId,
      action: "secret.delete",
      targetType: "secret",
      targetId: podId,
      detail: { scope: "org", name: "SHARED" },
    });

    const entries = await read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.actor_id, userId);
    assert.equal(entries[0]!.action, "secret.delete");
    assert.equal(entries[0]!.target_type, "secret");
    assert.equal(entries[0]!.target_id, podId);
    assert.deepEqual(entries[0]!.detail, { scope: "org", name: "SHARED" });
    assert.ok(Number.isFinite(Date.parse(entries[0]!.created_at)));
  });

  it("keeps system actions, which have no user behind them, in the same feed", async () => {
    await audit({ orgId, actorId: null, action: "pod.launch_failed", targetType: "pod", targetId: podId });

    const entries = await read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.actor_id, null);
    assert.equal(entries[0]!.action, "pod.launch_failed");
    assert.deepEqual(entries[0]!.detail, {});
  });

  it("returns the newest entries first and pages backwards with before", async () => {
    await writeAgo("pod.archive", 30);
    await writeAgo("secret.write", 20);
    await writeAgo("policy.update", 10);

    const page = await read("?limit=2");
    assert.deepEqual(page.map((entry) => entry.action), ["policy.update", "secret.write"]);

    const next = await read(`?before=${encodeURIComponent(page[1]!.created_at)}`);
    assert.deepEqual(next.map((entry) => entry.action), ["pod.archive"]);
  });

  it("never shows another organization's entries", async () => {
    await audit({ orgId: otherOrgId, actorId: null, action: "policy.update" });
    await audit({ orgId, actorId: userId, action: "template.archive" });

    assert.deepEqual((await read()).map((entry) => entry.action), ["template.archive"]);
  });

  it("requires audit:read, and never answers for another organization", async () => {
    auth = { ...auth, permissions: [] };
    const denied = await app.inject({ method: "GET", url: `/orgs/${orgId}/audit` });
    assert.equal(denied.statusCode, 403, denied.body);

    auth = { ...auth, permissions: ["audit:read"] };
    const mismatch = await app.inject({ method: "GET", url: `/orgs/${otherOrgId}/audit` });
    assert.equal(mismatch.statusCode, 403, mismatch.body);
  });
});
