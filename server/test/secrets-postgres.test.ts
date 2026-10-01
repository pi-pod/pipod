import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { HttpError } from "../src/server/httperrors.js";
import { uuidv7 } from "../src/server/ids.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { registerSecretRoutes } from "../src/server/secrets/routes.js";
import {
  putSecret,
  resolveSecrets,
  SECRET_NAME_MAX_LENGTH,
  SECRET_VALUE_MAX_BYTES,
} from "../src/server/secrets/store.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

// Canary values below are disposable test fixtures. They are compared, never logged or
// returned by the metadata-only API under test.
describe("secure secrets phase 1 (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgA = uuidv7();
  const orgB = uuidv7();
  const userId = uuidv7();
  const templateId = uuidv7();
  const kek = new EnvKekProvider("phase1-test-kek", randomBytes(32).toString("base64"));
  let auth = {
    userId,
    email: `${userId}@example.test`,
    orgId: orgA,
    permissions: ["secrets:org:write", "secrets:own:write", "templates:write"],
  };
  let app: ReturnType<typeof Fastify>;

  const asOrg = (orgId: string) => {
    auth = { ...auth, orgId };
  };

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'phase1 org a'), ($2, 'phase1 org b')", [
      orgA,
      orgB,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await query("INSERT INTO pod_templates (id, org_id, name) VALUES ($1, $2, 'phase1 template')", [
      templateId,
      orgA,
    ]);

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof HttpError) {
        return reply.code(error.statusCode).send({ error: error.message, detail: error.detail ?? null });
      }
      // Same mapping as src/server/app.ts: schema failures carry the validator's status.
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      if (typeof statusCode === "number" && statusCode < 500) {
        const validation = (error as { validation?: unknown }).validation;
        return reply.code(statusCode).send({ error: error.message, detail: validation ?? null });
      }
      return reply.code(500).send({ error: error.message, detail: null });
    });
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      req.auth = auth;
    });
    registerSecretRoutes(app, kek);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await query("DELETE FROM audit_log WHERE org_id IN ($1, $2)", [orgA, orgB]);
    await query("DELETE FROM secrets WHERE org_id IN ($1, $2)", [orgA, orgB]);
    await query("DELETE FROM pod_templates WHERE org_id = $1", [orgA]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id IN ($1, $2)", [orgA, orgB]);
    await closePool();
  });

  beforeEach(async () => {
    asOrg(orgA);
    await query("DELETE FROM audit_log WHERE org_id IN ($1, $2)", [orgA, orgB]);
    await query("DELETE FROM secrets WHERE org_id IN ($1, $2)", [orgA, orgB]);
  });

  it("migration 048 scopes secret uniqueness by org", async () => {
    const current = await query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'secrets'::regclass AND conname = 'secrets_org_scope_name_key'`,
    );
    assert.match(current.rows[0]!.definition, /UNIQUE \(org_id, scope_type, scope_id, name\)/);
    const legacy = await query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'secrets' AND c.contype = 'u'
         AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
             = ARRAY['scope_type', 'scope_id', 'name']::text[]`,
    );
    assert.equal(legacy.rows[0]!.n, "0");
  });

  it("keeps the same user + secret name independent across two orgs", async () => {
    const putA = await app.inject({
      method: "PUT",
      url: `/secrets/user/${userId}/SHARED_NAME`,
      payload: { value: "test-only-canary-a" },
    });
    assert.equal(putA.statusCode, 204, putA.body);

    asOrg(orgB);
    const putB = await app.inject({
      method: "PUT",
      url: `/secrets/user/${userId}/SHARED_NAME`,
      payload: { value: "test-only-canary-b" },
    });
    assert.equal(putB.statusCode, 204, putB.body);

    const rows = await query<{ org_id: string }>(
      "SELECT org_id FROM secrets WHERE scope_type = 'user' AND scope_id = $1 AND name = 'SHARED_NAME'",
      [userId],
    );
    assert.deepEqual(
      rows.rows.map((r) => r.org_id).sort(),
      [orgA, orgB].sort(),
    );

    const resolvedA = await resolveSecrets({ kek, orgId: orgA, userId, templateId: null });
    const resolvedB = await resolveSecrets({ kek, orgId: orgB, userId, templateId: null });
    assert.equal(resolvedA.env["SHARED_NAME"], "test-only-canary-a");
    assert.equal(resolvedB.env["SHARED_NAME"], "test-only-canary-b");
  });

  it("does not let an upsert in one org cross into another", async () => {
    await app.inject({
      method: "PUT",
      url: `/secrets/user/${userId}/ROTATING_NAME`,
      payload: { value: "test-only-original-a" },
    });
    asOrg(orgB);
    await app.inject({
      method: "PUT",
      url: `/secrets/user/${userId}/ROTATING_NAME`,
      payload: { value: "test-only-original-b" },
    });
    // Overwrite in org B only.
    const rewrite = await app.inject({
      method: "PUT",
      url: `/secrets/user/${userId}/ROTATING_NAME`,
      payload: { value: "test-only-updated-b" },
    });
    assert.equal(rewrite.statusCode, 204, rewrite.body);

    const count = await query<{ n: string }>(
      "SELECT count(*) AS n FROM secrets WHERE scope_type = 'user' AND scope_id = $1 AND name = 'ROTATING_NAME'",
      [userId],
    );
    assert.equal(count.rows[0]!.n, "2");
    assert.equal((await resolveSecrets({ kek, orgId: orgA, userId, templateId: null })).env["ROTATING_NAME"], "test-only-original-a");
    assert.equal((await resolveSecrets({ kek, orgId: orgB, userId, templateId: null })).env["ROTATING_NAME"], "test-only-updated-b");
  });

  it("rejects provider credentials outside org scope, server-side", async () => {
    const userScoped = await app.inject({
      method: "PUT",
      url: `/secrets/user/${userId}/PI_POD_SANDBOX_TOKEN`,
      payload: { value: "test-only-key" },
    });
    assert.equal(userScoped.statusCode, 400, userScoped.body);

    const templateScoped = await app.inject({
      method: "PUT",
      url: `/secrets/template/${templateId}/PI_POD_SANDBOX_TOKEN`,
      payload: { value: "test-only-key" },
    });
    assert.equal(templateScoped.statusCode, 400, templateScoped.body);

    // Every retired adapter name stays reserved and org-scoped too, forever.
    for (const name of ["E2B_API_KEY", "DAYTONA_API_KEY", "BOX_API_KEY"]) {
      const retiredUser = await app.inject({
        method: "PUT",
        url: `/secrets/user/${userId}/${name}`,
        payload: { value: "test-only-key" },
      });
      assert.equal(retiredUser.statusCode, 400, retiredUser.body);
      const retiredTemplate = await app.inject({
        method: "PUT",
        url: `/secrets/template/${templateId}/${name}`,
        payload: { value: "test-only-key" },
      });
      assert.equal(retiredTemplate.statusCode, 400, retiredTemplate.body);
    }

    const orgScoped = await app.inject({
      method: "PUT",
      url: `/secrets/org/${orgA}/PI_POD_SANDBOX_TOKEN`,
      payload: { value: "test-only-key" },
    });
    assert.equal(orgScoped.statusCode, 204, orgScoped.body);

    // Org-scoped provider credentials stay server-custodied: never injected into pods.
    const resolved = await resolveSecrets({ kek, orgId: orgA, userId, templateId: null });
    assert.equal("PI_POD_SANDBOX_TOKEN" in resolved.env, false);
    const listed = await app.inject({ method: "GET", url: `/secrets/org/${orgA}` });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      (listed.json() as { secrets: Array<{ name: string }> }).secrets.map((s) => s.name),
      ["PI_POD_SANDBOX_TOKEN"],
    );
    for (const secret of (listed.json() as { secrets: Array<Record<string, unknown>> }).secrets) {
      assert.equal("value" in secret, false);
      assert.equal("ciphertext" in secret, false);
    }
  });

  it("enforces secret name/value bounds", async () => {
    // Over-long names never reach the route schema — the router rejects >100-char
    // params first — so the documented name bound is enforced at the store choke
    // point, which every writer funnels through.
    await assert.rejects(
      putSecret({
        kek,
        orgId: orgA,
        scopeType: "user",
        scopeId: userId,
        name: "N".repeat(SECRET_NAME_MAX_LENGTH + 1),
        value: "test-only-key",
        createdBy: userId,
      }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 400,
    );
    await putSecret({
      kek,
      orgId: orgA,
      scopeType: "user",
      scopeId: userId,
      name: "N".repeat(SECRET_NAME_MAX_LENGTH),
      value: "test-only-key",
      createdBy: userId,
    });

    const bigValue = `v${"x".repeat(SECRET_VALUE_MAX_BYTES)}`;
    assert.ok(Buffer.byteLength(bigValue, "utf8") > SECRET_VALUE_MAX_BYTES);
    const bigValueRes = await app.inject({
      method: "PUT",
      url: `/secrets/user/${userId}/BIG_VALUE`,
      payload: { value: bigValue },
    });
    assert.equal(bigValueRes.statusCode, 400, bigValueRes.body);

    // Boundary name via the route schema path stays under the router's own
    // param cap while exercising the same zod bound.
    const maxNameRes = await app.inject({
      method: "PUT",
      url: `/secrets/user/${userId}/${"M".repeat(64)}`,
      payload: { value: "test-only-key" },
    });
    assert.equal(maxNameRes.statusCode, 204, maxNameRes.body);
    const maxValueRes = await app.inject({
      method: "PUT",
      url: `/secrets/user/${userId}/MAX_VALUE`,
      payload: { value: "x".repeat(SECRET_VALUE_MAX_BYTES) },
    });
    assert.equal(maxValueRes.statusCode, 204, maxValueRes.body);

    const count = await query<{ n: string }>(
      "SELECT count(*) AS n FROM secrets WHERE org_id = $1 AND scope_type = 'user'",
      [orgA],
    );
    assert.equal(count.rows[0]!.n, "3");
  });
});
