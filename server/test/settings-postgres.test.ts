import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { registerSettingsRoutes } from "../src/server/settings/routes.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("settings bundles (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  let auth = {
    userId,
    email: `${userId}@example.test`,
    orgId,
    permissions: [] as string[],
  };
  let app: ReturnType<typeof Fastify>;

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'settings bundles test')", [orgId]);
    await query(
      "INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)",
      [userId, `${userId}@example.test`, otherUserId, `${otherUserId}@example.test`],
    );
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate("authenticate", async (req: { auth?: unknown }) => { req.auth = auth; });
    registerSettingsRoutes(app);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id IN ($1, $2)", [userId, otherUserId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    auth = { userId, email: `${userId}@example.test`, orgId, permissions: [] };
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
  });

  it("migration 042 adds flat Pi files and the user_defaults scope", async () => {
    const column = await query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'settings' AND column_name = 'pi_settings'`,
    );
    assert.match(column.rows[0]!.column_default, /jsonb/);
    const constraint = await query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'settings'::regclass AND conname = 'settings_scope_type_check'`,
    );
    assert.match(constraint.rows[0]!.definition, /user_defaults/);
    const piConstraint = await query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'settings'::regclass AND conname = 'settings_pi_settings_object'`,
    );
    assert.match(piConstraint.rows[0]!.definition, /jsonb_typeof.*object/);
  });

  it("lets a member CRUD only their own user bundle with CAS", async () => {
    const empty = await app.inject({ method: "GET", url: `/users/${userId}/settings` });
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(empty.json(), {
      config: {}, version: 0, initScript: "", bakeScript: "", piFiles: {},
    });

    const created = await app.inject({
      method: "PUT",
      url: `/users/${userId}/settings`,
      payload: {
        config: { idleTimeoutMinutes: 25 },
        initScript: "echo user init",
        bakeScript: "echo user bake",
        piFiles: { settings: { theme: "dark", hooks: { stop: "drop" } } },
        version: 0,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.deepEqual(created.json(), { version: 1 });

    const read = await app.inject({ method: "GET", url: `/users/${userId}/settings` });
    assert.deepEqual(read.json(), {
      config: { idleTimeoutMinutes: 25 },
      version: 1,
      initScript: "echo user init",
      bakeScript: "echo user bake",
      piFiles: { settings: { theme: "dark" } },
    });

    const replaced = await app.inject({
      method: "PUT",
      url: `/users/${userId}/settings`,
      payload: { config: { workdir: "/work" }, version: 1 },
    });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const preserved = await app.inject({ method: "GET", url: `/users/${userId}/settings` });
    assert.deepEqual(preserved.json().piFiles, { settings: { theme: "dark" } });
    assert.equal(preserved.json().initScript, "echo user init");

    const stale = await app.inject({
      method: "PUT",
      url: `/users/${userId}/settings`,
      payload: { config: {}, version: 1 },
    });
    assert.equal(stale.statusCode, 409, stale.body);

    for (const method of ["GET", "PUT"] as const) {
      const denied = await app.inject({
        method,
        url: `/users/${otherUserId}/settings`,
        ...(method === "PUT" ? { payload: { config: {}, version: 0 } } : {}),
      });
      assert.equal(denied.statusCode, 403, denied.body);
    }
  });

  it("keeps org permissions and rejects Pi files on policy", async () => {
    const denied = await app.inject({
      method: "PUT",
      url: `/orgs/${orgId}/settings`,
      payload: { config: {}, version: 0 },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    auth = { ...auth, permissions: ["org:manage", "policy:write"] };
    const org = await app.inject({
      method: "PUT",
      url: `/orgs/${orgId}/settings`,
      payload: { config: {}, piFiles: { settings: { theme: "org" } }, version: 0 },
    });
    assert.equal(org.statusCode, 200, org.body);
    const read = await app.inject({ method: "GET", url: `/orgs/${orgId}/settings` });
    assert.deepEqual(read.json().piFiles, { settings: { theme: "org" } });

    const policy = await app.inject({
      method: "PUT",
      url: `/orgs/${orgId}/policy`,
      payload: { config: {}, piFiles: {}, version: 0 },
    });
    assert.equal(policy.statusCode, 400, policy.body);
    assert.match(policy.body, /policy has no Pi files/);
  });

  it("serves org and user rows written before the schema shed keys without them", async () => {
    // Written by a server whose schema still had these keys; nothing rewrites a row when the
    // schema shrinks, so the JSON is exactly what an old `pipod push` left behind.
    const legacy = {
      repo: "github.com/example/app",
      autoStopOnExit: true,
      orphanTtlMinutes: 240,
      stopTimeoutSeconds: 300,
      envFile: "custom/env",
      initScript: "custom/init.sh",
      bakeScript: "custom/bake.sh",
      template: "team-default",
      reuse: true,
      idleTimeoutMinutes: 45,
      pi: {
        version: "latest",
        shellOnExit: true,
        detachSequence: "C-p C-q",
        detachStopSequence: "C-p C-s",
        detachArchiveSequence: "C-p C-a",
        model: "legacy-model",
        hostConfig: { settings: false, skills: ["review"], extensions: ["ext"] },
      },
    };
    for (const [scopeType, scopeId] of [["org_defaults", orgId], ["user_defaults", userId]] as const) {
      await query(
        `INSERT INTO settings (id, scope_type, scope_id, org_id, config, version, updated_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 3, $5)`,
        [scopeType, scopeId, orgId, JSON.stringify(legacy), userId],
      );
    }

    auth = { ...auth, permissions: ["org:manage"] };
    for (const url of [`/orgs/${orgId}/settings`, `/users/${userId}/settings`]) {
      const read = await app.inject({ method: "GET", url });
      assert.equal(read.statusCode, 200, read.body);
      // The bundle a client pulls carries only what a current CLI knows; the live keys stay.
      // hostConfig keeps its enforced boolean (settings: false) while the retired name lists go.
      assert.deepEqual(read.json().config, {
        idleTimeoutMinutes: 45,
        pi: { model: "legacy-model", hostConfig: { settings: false } },
      });
      assert.equal(read.json().version, 3);
    }
  });

  it("rejects retired client-only keys on settings writes with the removal spelled out", async () => {
    auth = { ...auth, permissions: ["org:manage"] };
    const rejected = await app.inject({
      method: "PUT",
      url: `/orgs/${orgId}/settings`,
      payload: {
        config: { idleTimeoutMinutes: 45, envFile: "custom/env", reuse: true },
        version: 0,
      },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.match(rejected.body, /retired config keys \\"envFile\\", \\"reuse\\" are no longer accepted/);
    const retiredHostConfig = await app.inject({
      method: "PUT",
      url: `/users/${userId}/settings`,
      payload: { config: { pi: { hostConfig: { skills: ["review"] } } }, version: 0 },
    });
    assert.equal(retiredHostConfig.statusCode, 400, retiredHostConfig.body);
    assert.match(retiredHostConfig.body, /pi\.hostConfig\.skills/);
    // Live keys still write.
    const written = await app.inject({
      method: "PUT",
      url: `/users/${userId}/settings`,
      payload: { config: { idleTimeoutMinutes: 45 }, version: 0 },
    });
    assert.equal(written.statusCode, 200, written.body);
  });

  it("accepts Zitadel numeric user ids on the user bundle routes", async () => {
    const zitadelUserId = "388200106354016263";
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      zitadelUserId,
      `${zitadelUserId}@example.test`,
    ]);
    const previous = auth;
    auth = { ...auth, userId: zitadelUserId, email: `${zitadelUserId}@example.test` };
    try {
      const empty = await app.inject({ method: "GET", url: `/users/${zitadelUserId}/settings` });
      assert.equal(empty.statusCode, 200, empty.body);
      assert.equal(empty.json().version, 0);
    } finally {
      auth = previous;
      await query("DELETE FROM settings WHERE scope_id = $1", [zitadelUserId]);
      await query("DELETE FROM users WHERE id = $1", [zitadelUserId]);
    }
  });

  it("lists a pre-removal pending proposal stripped and applies its live content", async () => {
    // A proposal authored before the bundle-schema removals still stores retired keys. New
    // writes reject those keys, so list and apply strip them: the pending proposal keeps
    // working on its live content instead of failing.
    const podId = uuidv7();
    const proposalId = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'proposal fixture', 'sandbox', 'active', 'started', '{}'::jsonb)`,
      [podId, orgId, userId],
    );
    await query(
      `INSERT INTO settings_proposals
         (id, org_id, scope_type, scope_id, config, secret_names, created_by, created_from_pod)
       VALUES ($1, $2, 'org_defaults', $3, $4, '{}', $5, $6)`,
      [
        proposalId,
        orgId,
        orgId,
        JSON.stringify({
          idleTimeoutMinutes: 45,
          repo: "github.com/example/app",
          envFile: "custom/env",
          pi: {
            model: "proposal-model",
            version: "latest",
            hostConfig: { settings: false, skills: ["review"] },
          },
        }),
        userId,
        podId,
      ],
    );
    try {
      auth = { ...auth, permissions: ["org:manage"] };
      const listed = await app.inject({ method: "GET", url: "/settings/proposals" });
      assert.equal(listed.statusCode, 200, listed.body);
      assert.deepEqual(listed.json().proposals.map((p: { id: string }) => p.id), [proposalId]);
      assert.deepEqual(listed.json().proposals[0].config, {
        idleTimeoutMinutes: 45,
        pi: { model: "proposal-model", hostConfig: { settings: false } },
      });

      const applied = await app.inject({
        method: "POST",
        url: `/settings/proposals/${proposalId}/apply`,
      });
      assert.equal(applied.statusCode, 200, applied.body);
      assert.equal(applied.json().version, 1);
      const read = await app.inject({ method: "GET", url: `/orgs/${orgId}/settings` });
      assert.equal(read.statusCode, 200, read.body);
      assert.deepEqual(read.json().config, {
        idleTimeoutMinutes: 45,
        pi: { model: "proposal-model", hostConfig: { settings: false } },
      });
      // CAS and status security are untouched: a second apply conflicts.
      const again = await app.inject({
        method: "POST",
        url: `/settings/proposals/${proposalId}/apply`,
      });
      assert.equal(again.statusCode, 409, again.body);
    } finally {
      await query("DELETE FROM settings_proposals WHERE id = $1", [proposalId]);
      await query("DELETE FROM pods WHERE id = $1", [podId]);
    }
  });
});
