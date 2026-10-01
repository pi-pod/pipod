import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { backfillPiAuthToModelCredentials } from "../src/server/model-credentials/backfill.js";
import { piAuthContext } from "../src/server/secrets/context.js";
import { encryptSecret, EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

/**
 * Static v1 (legacy, pre-Phase-2) pi_auth envelopes. There is deliberately no
 * legacy writer anymore, so these vectors are frozen hex minted from the old
 * layout ([u16be wrappedLen][wrapped DEK][sealed], no AAD) under the fixed
 * test-only KEK below. They exercise the bounded v1 reader on the backfill path.
 */
const FIXTURE_KEK_B64 = Buffer.alloc(32, 7).toString("base64");
const FIXTURE_KEY_ID = "backfill-fixture-kek";
const V1_SPLIT_BLOB_HEX =
  "003c469a1ddda799e95ca123c2330dc22f883897f20fc400d2f3a9f973a0217729ee26410c91f72d4902597ff90f75fb893e3247edffec1f780ab915250a172e3c66a5f210a11eda75b9f7a499c8bfc51c8506732471fb3bf307c3b7e80e6ad886d7915391f1c958da66d8cdaa0dd957ee1056826a47f68337bb358e705d3e58420e83534856a4327bb0cc23e9fd8b0f43ffbeea28e819d4e6e9103ad7bf17441b4de8ba00fdf7dd8b722416269c88495ddcccae6bbfccebda2f2a62d3323ddc61b21d22dd0752bca8cb539cecc7de40fc0984646f8a5e8cbd33144f";
const V1_NON_EXPIRING_HEX =
  "003c270ef047688b66585404d82cbb791d506e354b89300c859b8923438e661cad98c9aa0db6eed1c8967baf54e82b20e647773d083d3dc12e331adbee04b862e5b8fc4cac5a65b3ce2fe7e4ee05d3a0f436d049e7827dc1a1088569a6b99b02d9e3eaabe1fabda5937971b7cbb037b53759695fa0d5a57dc96c823774ba841a217ea4ca46de377f5463f4271d7f7f3063d90aca19423d901b0b2f198ad42912aa08286d84cb9176ac72b4b97e0f6f6502e026";
const V1_MALFORMED_MARKER_HEX =
  "003c25b25a049f5cc473fe7fbdd94c1388cab629dddd4299b86caa660ae9f262a5126c8dce9bfcbc6e2a9ba913b35f632a32f76bc023b44f3d92e067794cb56055f97e5d9690da2f7659458c1b4fdf708501d30eac203b80cfb40a65da363992468046f71df2b0f65fa4b92b47bca116fe4f27553f";
const V1_VALID_XAI_HEX =
  "003c9fa4b94649d167d79f0072344c8d14327bf3a05d66ea8167b1bd4c1cd317bf782dd209e2bc1268351f6a2fb976cc135b1ede3e72d941db46b7462b5f8a5d06a524788715516f6096c98336a145ea7508b3de4b3172c3ac057277718382039f575567fd5614188e553e48123dcf327b680be26927a0f3284adc71c3c024cc59b50726a84b";

describe("pi_auth model credential backfill (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  const kek = new EnvKekProvider(FIXTURE_KEY_ID, FIXTURE_KEK_B64);

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'model credential backfill test')", [orgId]);
    await query(
      "INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)",
      [userId, `${userId}@example.test`, otherUserId, `${otherUserId}@example.test`],
    );
  });

  beforeEach(async () => {
    await query("DELETE FROM model_credentials WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pi_auth WHERE org_id = $1", [orgId]);
  });

  after(async () => {
    await query("DELETE FROM model_credentials WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pi_auth WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id IN ($1, $2)", [userId, otherUserId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  /** Legacy (v1, unbound) pi_auth fixture row, exactly as pre-Phase-2 servers left it. */
  async function insertV1PiAuth(rowUserId: string, hex: string, providers: string[]): Promise<void> {
    await query(
      `INSERT INTO pi_auth (id, org_id, user_id, ciphertext, key_id, encryption_version, providers)
       VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [uuidv7(), orgId, rowUserId, Buffer.from(hex, "hex"), FIXTURE_KEY_ID, providers],
    );
  }

  it("splits a legacy blob once, preserves ciphertext on rerun, and marks an incomplete OAuth grant", async () => {
    await insertV1PiAuth(userId, V1_SPLIT_BLOB_HEX, ["anthropic", "openrouter"]);
    const legacyBefore = Buffer.from(
      (await query<{ ciphertext: Buffer }>("SELECT ciphertext FROM pi_auth WHERE org_id = $1", [orgId])).rows[0]!.ciphertext,
    );

    assert.deepEqual(await backfillPiAuthToModelCredentials(kek), {
      users: 1,
      providers: 2,
      skipped: 0,
    });
    const first = await query<{
      provider_id: string;
      ciphertext: Buffer;
      encryption_version: number;
      last_failure_code: string | null;
    }>(
      `SELECT provider_id, ciphertext, encryption_version, last_failure_code
         FROM model_credentials
        WHERE org_id = $1 AND user_id = $2
        ORDER BY provider_id`,
      [orgId, userId],
    );
    assert.equal(first.rowCount, 2);
    assert.equal(first.rows[0]?.provider_id, "anthropic");
    assert.equal(first.rows[0]?.last_failure_code, "migration_required");
    assert.equal(Number(first.rows[0]?.encryption_version), 2);
    assert.equal(first.rows[1]?.provider_id, "openrouter");
    assert.equal(first.rows[1]?.last_failure_code, null);
    assert.equal(Number(first.rows[1]?.encryption_version), 2);
    const firstCiphertexts = first.rows.map((row) => Buffer.from(row.ciphertext));

    assert.deepEqual(await backfillPiAuthToModelCredentials(kek), {
      users: 1,
      providers: 0,
      skipped: 2,
    });
    const second = await query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM model_credentials
        WHERE org_id = $1 AND user_id = $2
        ORDER BY provider_id`,
      [orgId, userId],
    );
    assert.deepEqual(second.rows.map((row) => row.ciphertext), firstCiphertexts);
    const legacyAfter = (await query<{ ciphertext: Buffer }>("SELECT ciphertext FROM pi_auth WHERE org_id = $1", [orgId])).rows[0]!.ciphertext;
    assert.deepEqual(legacyAfter, legacyBefore, "the rollback source remains untouched");
  });

  it("keeps a non-expiring OAuth exchange ready when it has no refresh token", async () => {
    await insertV1PiAuth(userId, V1_NON_EXPIRING_HEX, ["openrouter"]);

    assert.deepEqual(await backfillPiAuthToModelCredentials(kek), {
      users: 1,
      providers: 1,
      skipped: 0,
    });
    const migrated = await query<{ expires_at: Date | null; last_failure_code: string | null }>(
      `SELECT expires_at, last_failure_code FROM model_credentials
        WHERE org_id = $1 AND user_id = $2 AND provider_id = 'openrouter'`,
      [orgId, userId],
    );
    assert.equal(migrated.rows[0]?.expires_at, null);
    assert.equal(migrated.rows[0]?.last_failure_code, null);
  });

  it("continues after a malformed legacy row without logging decrypted contents", async () => {
    const malformedMarker = "malformed-credential-marker";
    await insertV1PiAuth(userId, V1_MALFORMED_MARKER_HEX, []);
    await insertV1PiAuth(otherUserId, V1_VALID_XAI_HEX, ["xai"]);

    const originalError = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      assert.deepEqual(await backfillPiAuthToModelCredentials(kek), {
        users: 1,
        providers: 1,
        skipped: 0,
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.includes(malformedMarker), false);
    assert.equal(
      (await query("SELECT 1 FROM model_credentials WHERE org_id = $1 AND user_id = $2 AND provider_id = 'xai'", [
        orgId,
        otherUserId,
      ])).rowCount,
      1,
    );
  });

  it("backfills a context-bound v2 pi_auth row and rejects one transplanted across users", async () => {
    const bound = encryptSecret(
      kek,
      JSON.stringify({ anthropic: { type: "api_key", key: "v2-bound-key" } }),
      piAuthContext(orgId, userId),
    );
    // Same plaintext shape, but bound to userId while stored under otherUserId:
    // authentication must fail closed without leaking the value.
    const transplanted = encryptSecret(
      kek,
      JSON.stringify({ xai: { type: "api_key", key: "transplanted-key" } }),
      piAuthContext(orgId, userId),
    );
    await query(
      `INSERT INTO pi_auth (id, org_id, user_id, ciphertext, key_id, encryption_version, providers)
       VALUES ($1, $2, $3, $4, $5, $6, '{anthropic}'), ($7, $2, $8, $9, $10, $6, '{xai}')`,
      [
        uuidv7(), orgId, userId, bound.ciphertext, bound.keyId, bound.encryptionVersion,
        uuidv7(), otherUserId, transplanted.ciphertext, transplanted.keyId,
      ],
    );

    const originalError = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      assert.deepEqual(await backfillPiAuthToModelCredentials(kek), {
        users: 1,
        providers: 1,
        skipped: 0,
      });
    } finally {
      console.error = originalError;
    }
    const logText = logs.join("\n");
    assert.equal(logText.includes("v2-bound-key"), false);
    assert.equal(logText.includes("transplanted-key"), false);
    assert.equal(
      (await query("SELECT 1 FROM model_credentials WHERE org_id = $1 AND user_id = $2 AND provider_id = 'anthropic'", [
        orgId,
        userId,
      ])).rowCount,
      1,
      "the correctly bound v2 row backfills",
    );
    assert.equal(
      (await query("SELECT 1 FROM model_credentials WHERE org_id = $1 AND user_id = $2", [orgId, otherUserId])).rowCount,
      0,
      "the transplanted v2 row is rejected, not copied",
    );
  });
});
