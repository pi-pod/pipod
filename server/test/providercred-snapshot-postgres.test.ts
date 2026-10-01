/**
 * Provider-credential env snapshot (postgres, no provider network).
 *
 * Own org scope on the shared disposable test DB — never foundation, never
 * production. Proves the parent-directed race and its fix at the exact layer
 * where it lives:
 *
 * - `resolveProviderCredential` receives the platform fallback as an OBJECT.
 *   When that object is the live `process.env` reference, the fallback read
 *   happens AFTER the async org-secret lookup yields — so a concurrent
 *   `withCredential` overlay (another org's key) is what gets returned. The
 *   locked swap inside `withCredential` itself is safe; this lazy read
 *   outside the lock is the real cross-tenant race. Deterministic: a single
 *   DB round-trip always yields before the fallback read.
 * - An explicit boot snapshot object is immune by construction.
 * - Org-secret precedence is unchanged (org key wins over any platform value).
 * - `withProviderCredential` threads the explicit snapshot end to end
 *   (resolves with ambient empty — impossible via the legacy path).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { putSecret } from "../src/server/secrets/store.js";
import { resolveProviderCredential } from "../src/server/secrets/store.js";
import {
  platformProviderEnv,
  withProviderCredential,
} from "../src/server/pods/providercred.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const VAR = "PI_POD_SANDBOX_TOKEN";

describe("provider credential env snapshot (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const previousToken = process.env[VAR];

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, "cred snapshot org"]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
    if (previousToken === undefined) delete process.env[VAR];
    else process.env[VAR] = previousToken;
  });

  beforeEach(async () => {
    await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    delete process.env[VAR];
  });

  it("a live process.env reference observes a mid-lookup overlay (the race)", async () => {
    process.env[VAR] = "first-platform-token0123456789";
    // The org-secret lookup always yields (DB round trip); the overlay lands
    // strictly before the fallback read — exactly the withCredential window.
    const pending = resolveProviderCredential({
      kek: {} as never,
      orgId,
      provider: "sandbox",
      platformEnv: process.env,
    });
    process.env[VAR] = "other-org-overlay-token0123456789";
    assert.equal(await pending, "other-org-overlay-token0123456789");
  });

  it("an explicit boot snapshot is immune to the same overlay", async () => {
    process.env[VAR] = "first-platform-token0123456789";
    const snapshot = { [VAR]: "boot-snapshot-token0123456789" };
    const pending = resolveProviderCredential({
      kek: {} as never,
      orgId,
      provider: "sandbox",
      platformEnv: snapshot,
    });
    process.env[VAR] = "other-org-overlay-token0123456789";
    assert.equal(await pending, "boot-snapshot-token0123456789");
  });

  it("org-secret precedence is unchanged (org key wins over platform)", async () => {
    await putSecret({
      kek,
      orgId,
      scopeType: "org",
      scopeId: orgId,
      name: VAR,
      value: "org-byo-key0123456789",
      createdBy: userId,
    });
    process.env[VAR] = "other-org-overlay-token0123456789";
    try {
      assert.equal(
        await resolveProviderCredential({
          kek,
          orgId,
          provider: "sandbox",
          platformEnv: { [VAR]: "boot-snapshot-token0123456789" },
        }),
        "org-byo-key0123456789",
      );
    } finally {
      await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    }
  });

  it("withProviderCredential threads the explicit snapshot end to end", async () => {
    // Ambient empty: legacy path would throw MissingCredentialError here.
    delete process.env[VAR];
    const seen = await withProviderCredential({
      kek: {} as never,
      orgId,
      provider: "sandbox",
      providerConfig: { url: "http://127.0.0.1:9" },
      platformEnv: platformProviderEnv({
        PI_POD_SANDBOX_TOKEN: "boot-snapshot-token0123456789",
      } as Record<string, unknown> as never),
      fn: async (provider, credentialScope) => ({ name: provider.name, scope: credentialScope }),
    });
    assert.equal(seen.name, "sandbox");
    assert.match(seen.scope, /^sha256:[0-9a-f]{64}$/);
  });
});
