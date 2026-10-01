/**
 * M0 old-client compatibility ON WRITE (postgres): retired providers must 400
 * with the supported list at the settings/policy write API, not store.
 *
 * Live 2026-09-09: PUT /v1/orgs/<id>/policy {config:{allowedProviders:['e2b']}}
 * returned 200/version1, and PUT settings {deniedProviders:['e2b']} returned
 * 200/version1 — validation lived only in the merge/resolve path. Both rows
 * were restored to {} via CAS PUT (version2) with no continuing bad config.
 *
 * These tests use the PRODUCTION writeLayer + PRODUCTION HTTP routes (no
 * mocks that skip validation) against a throwaway database. The Fastify app
 * uses the real validator plus the real app error boundary, so the asserted
 * 400 bodies are exactly what old clients will see.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { installErrorHandler } from "../src/server/app.js";
import { registerSettingsRoutes } from "../src/server/settings/routes.js";
import { readLayer, writeLayer } from "../src/server/settings/merge.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe(
  "provider compat on write (postgres, production writeLayer)",
  { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" },
  () => {
    const orgId = uuidv7();
    const userId = uuidv7();
    let auth = {
      userId,
      email: `${userId}@example.test`,
      orgId,
      permissions: [] as string[],
    };
    let app: ReturnType<typeof Fastify>;

    before(async () => {
      initPool(databaseUrl!);
      await query("INSERT INTO organizations (id, name) VALUES ($1, 'provider compat write test')", [orgId]);
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
      app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      installErrorHandler(app);
      app.decorate("authenticate", async (req: { auth?: unknown }) => {
        req.auth = auth;
      });
      registerSettingsRoutes(app);
      await app.ready();
    });

    after(async () => {
      await app.close();
      await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
      await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
      await query("DELETE FROM users WHERE id = $1", [userId]);
      await query("DELETE FROM organizations WHERE id = $1", [orgId]);
      await closePool();
    });

    beforeEach(async () => {
      auth = { userId, email: `${userId}@example.test`, orgId, permissions: [] };
      await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
      await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    });

    it("production writeLayer rejects retired deniedProviders with the supported list", async () => {
      for (const provider of ["e2b", "daytona", "unknown"]) {
        await assert.rejects(
          () =>
            writeLayer({
              scopeType: "org_defaults",
              scopeId: orgId,
              orgId,
              config: { deniedProviders: [provider] },
              expectedVersion: 0,
              updatedBy: userId,
            }),
          (e: unknown) => {
            const err = e as { statusCode?: unknown; message?: unknown; detail?: unknown };
            assert.equal(err.statusCode, 400);
            const blob = JSON.stringify({ error: err.message, detail: err.detail });
            assert.ok(blob.includes("sandbox") && blob.includes("host"), `missing list: ${blob}`);
            return true;
          },
          `deniedProviders [${provider}] must 400`,
        );
      }
      // No row was stored by the rejections.
      const row = await readLayer("org_defaults", orgId, orgId);
      assert.equal(row.version, 0);
      assert.deepEqual(row.config, {});
    });

    it("production writeLayer rejects retired allowedProviders with the supported list", async () => {
      for (const provider of ["e2b", "daytona", "unknown"]) {
        await assert.rejects(
          () =>
            writeLayer({
              scopeType: "org_policy",
              scopeId: orgId,
              orgId,
              config: { allowedProviders: [provider] },
              expectedVersion: 0,
              updatedBy: userId,
            }),
          (e: unknown) => {
            const err = e as { statusCode?: unknown; message?: unknown; detail?: unknown };
            assert.equal(err.statusCode, 400);
            const blob = JSON.stringify({ error: err.message, detail: err.detail });
            assert.ok(blob.includes("sandbox") && blob.includes("host"), `missing list: ${blob}`);
            return true;
          },
          `allowedProviders [${provider}] must 400`,
        );
      }
      const row = await readLayer("org_policy", orgId, orgId);
      assert.equal(row.version, 0);
    });

    it("production writeLayer still honors native valid provider lists", async () => {
      const v1 = await writeLayer({
        scopeType: "org_defaults",
        scopeId: orgId,
        orgId,
        config: { deniedProviders: ["host"] },
        expectedVersion: 0,
        updatedBy: userId,
      });
      assert.equal(v1, 1);
      assert.deepEqual((await readLayer("org_defaults", orgId, orgId)).config, {
        deniedProviders: ["host"],
      });

      const p1 = await writeLayer({
        scopeType: "org_policy",
        scopeId: orgId,
        orgId,
        config: { allowedProviders: ["sandbox"] },
        expectedVersion: 0,
        updatedBy: userId,
      });
      assert.equal(p1, 1);
    });

    it("PUT settings/policy HTTP rejects retired names with the supported list (real boundary)", async () => {
      auth = { ...auth, permissions: ["org:manage", "policy:write"] };

      for (const provider of ["e2b", "daytona"]) {
        const denied = await app.inject({
          method: "PUT",
          url: `/orgs/${orgId}/settings`,
          payload: { config: { deniedProviders: [provider] }, version: 0 },
        });
        assert.equal(denied.statusCode, 400, `settings denied [${provider}]: ${denied.body}`);
        assert.ok(
          denied.body.includes("sandbox") && denied.body.includes("host"),
          `settings denied [${provider}] missing list: ${denied.body}`,
        );

        const allowed = await app.inject({
          method: "PUT",
          url: `/orgs/${orgId}/policy`,
          payload: { config: { allowedProviders: [provider] }, version: 0 },
        });
        assert.equal(allowed.statusCode, 400, `policy allowed [${provider}]: ${allowed.body}`);
        assert.ok(
          allowed.body.includes("sandbox") && allowed.body.includes("host"),
          `policy allowed [${provider}] missing list: ${allowed.body}`,
        );
      }

      // Rejections do not bump versions: both rows are still unwritten.
      assert.equal((await readLayer("org_defaults", orgId, orgId)).version, 0);
      assert.equal((await readLayer("org_policy", orgId, orgId)).version, 0);

      // Native valid lists still write via HTTP.
      const validDenied = await app.inject({
        method: "PUT",
        url: `/orgs/${orgId}/settings`,
        payload: { config: { deniedProviders: ["host"] }, version: 0 },
      });
      assert.equal(validDenied.statusCode, 200, validDenied.body);

      const validAllowed = await app.inject({
        method: "PUT",
        url: `/orgs/${orgId}/policy`,
        payload: { config: { allowedProviders: ["sandbox"] }, version: 0 },
      });
      assert.equal(validAllowed.statusCode, 200, validAllowed.body);
    });
  },
);
