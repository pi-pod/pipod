import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import path from "node:path";
import pg from "pg";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { migrate } from "../src/server/db/migrate.js";
import { uuidv7 } from "../src/server/ids.js";
import { ensureFreshCredential } from "../src/server/model-credentials/refresh.js";
import {
  decryptSecret,
  encryptSecret,
  ENCRYPTION_VERSION_V1,
  ENCRYPTION_VERSION_V2,
  EnvKekProvider,
} from "../src/server/secrets/crypto.js";
import {
  modelCredentialContext,
  piAuthContext,
  piSettingsContext,
  podLaunchEnvContext,
  secretContext,
} from "../src/server/secrets/context.js";
import {
  assertConfiguredKeyReferences,
  collectInventory,
  migrateLegacyEnvelopes,
  rewrapToCurrentKek,
  verifyEncryptedRecords,
} from "../src/server/secrets/maintenance.js";

// Disposable canary fixtures. Compared after decrypt, or asserted ABSENT from every
// report/CLI output — never logged by the code under test.
const CANARY = `secmaint-canary-${randomBytes(8).toString("hex")}`;

const b64 = () => randomBytes(32).toString("base64");
const OLD_B64 = b64();
const NEW_B64 = b64();
const oldKekOnly = () => new EnvKekProvider("kek-old", OLD_B64);
const rotatedKek = () => new EnvKekProvider("kek-new", NEW_B64, { "kek-old": OLD_B64 });
const retiredKek = () => new EnvKekProvider("kek-new", NEW_B64);

/**
 * Legacy v1 envelope builder. Nothing in src writes v1 anymore; the layout is
 * replicated here ([u16be wrappedLen][raw-wrapped DEK][sealed value], no AAD) so
 * migration reads stay under test. Uses only the public raw wrap API.
 */
function sealV1(kek: EnvKekProvider, value: string): { ciphertext: Buffer; keyId: string } {
  const dataKey = randomBytes(32);
  const wrapped = kek.wrap(dataKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
  const sealed = Buffer.concat([iv, cipher.getAuthTag(), body]);
  const header = Buffer.alloc(2);
  header.writeUInt16BE(wrapped.length);
  return { ciphertext: Buffer.concat([header, wrapped, sealed]), keyId: kek.keyId };
}

// Own disposable database on the same server (never the shared suite database):
// created in before(), migrated, dropped in after().
const serverUrl =
  process.env["PI_POD_TEST_DATABASE_URL"] ?? "postgres://postgres@127.0.0.1:55439/secure_secrets_test";

let reachable = false;
try {
  const probe = new pg.Pool({ connectionString: serverUrl });
  await probe.query("SELECT 1");
  await probe.end();
  reachable = true;
} catch {
  reachable = false;
}

const dbName = `secmaint_${process.pid}_${randomBytes(3).toString("hex")}`;

function ownUrl(): string {
  const u = new URL(serverUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe(
  "secrets maintenance (postgres)",
  { skip: reachable ? false : `postgres not reachable at ${serverUrl}` },
  () => {
    const orgId = uuidv7();
    const userId = uuidv7();
    const templateId = uuidv7();
    const podId = uuidv7();
    let dbUrl = "";

    async function seedOrgUserPod(): Promise<void> {
      await query("INSERT INTO organizations (id, name) VALUES ($1, 'secmaint org')", [orgId]);
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
      await query(
        `INSERT INTO pods (id, org_id, user_id, provider, state, resolved_config, name, provider_state)
         VALUES ($1, $2, $3, 'host', 'archived', '{}', 'secmaint pod', 'stopped')`,
        [podId, orgId, userId],
      );
    }

    async function insertSecretRow(o: {
      id?: string;
      ciphertext: Buffer;
      keyId: string;
      version: number;
      name?: string;
    }): Promise<string> {
      const id = o.id ?? uuidv7();
      await query(
        `INSERT INTO secrets (id, org_id, scope_type, scope_id, name, ciphertext, key_id, encryption_version)
         VALUES ($1, $2, 'user', $3, $4, $5, $6, $7)`,
        [id, orgId, userId, o.name ?? `K_${id.slice(0, 8)}`, o.ciphertext, o.keyId, o.version],
      );
      return id;
    }

    before(async () => {
      const admin = new pg.Pool({ connectionString: serverUrl });
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await admin.end();
      }
      const migrationsDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "migrations");
      dbUrl = ownUrl();
      await migrate(dbUrl, migrationsDir);
      initPool(dbUrl);
      await seedOrgUserPod();
    });

    after(async () => {
      await closePool();
      const admin = new pg.Pool({ connectionString: serverUrl });
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await admin.end();
      }
    });

    it("migration 049 labels rows v1 by default and bounds versions to (1,2)", async () => {
      const v1 = sealV1(oldKekOnly(), CANARY);
      const cols = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'encryption_version'
            AND table_name IN ('secrets','model_credentials','pi_auth','pod_launch_env')`,
      );
      assert.equal(cols.rows.length, 4);
      const piSettings = await query("SELECT to_regclass('public.pi_settings') AS oid");
      assert.equal(piSettings.rows[0]?.["oid"], null);

      // Omitted column defaults to 1 (pre-Phase-2 writer shape).
      const id = uuidv7();
      await query(
        `INSERT INTO secrets (id, org_id, scope_type, scope_id, name, ciphertext, key_id)
         VALUES ($1, $2, 'org', $2, 'DEFAULT_LABEL', $3, 'kek-old')`,
        [id, orgId, v1.ciphertext],
      );
      const got = await query<{ encryption_version: number }>("SELECT encryption_version FROM secrets WHERE id = $1", [
        id,
      ]);
      assert.equal(got.rows[0]?.["encryption_version"], 1);
      // Out-of-range versions are rejected, not stored.
      await assert.rejects(
        query("UPDATE secrets SET encryption_version = 3 WHERE id = $1", [id]),
        /check constraint/i,
      );
      await query("DELETE FROM secrets WHERE id = $1", [id]);
    });

    it("startup check blocks on missing keys and passes once they are configured", async () => {
      const v1 = sealV1(oldKekOnly(), CANARY);
      const rowId = await insertSecretRow({ ciphertext: v1.ciphertext, keyId: "kek-old", version: 1 });
      try {
        await assert.rejects(assertConfiguredKeyReferences(retiredKek()), (e: unknown) => {
          const msg = (e as Error).message;
          assert.match(msg, /kek-old/);
          assert.doesNotMatch(msg, new RegExp(CANARY));
          return true;
        });
        await assert.doesNotReject(assertConfiguredKeyReferences(rotatedKek()));
      } finally {
        await query("DELETE FROM secrets WHERE id = $1", [rowId]);
      }
    });

    it("inventory counts every table by format and key id", async () => {
      const kek = rotatedKek();
      const v1 = sealV1(oldKekOnly(), CANARY);
      const v2old = encryptSecret(oldKekOnly(), CANARY, secretContext(orgId, "user", userId, "INV_OLD"));
      const v2new = encryptSecret(kek, CANARY, secretContext(orgId, "user", userId, "INV_NEW"));
      const ids = [
        await insertSecretRow({ ciphertext: v1.ciphertext, keyId: "kek-old", version: 1, name: "INV_V1" }),
        await insertSecretRow({ ciphertext: v2old.ciphertext, keyId: "kek-old", version: 2, name: "INV_OLD" }),
        await insertSecretRow({ ciphertext: v2new.ciphertext, keyId: "kek-new", version: 2, name: "INV_NEW" }),
      ];
      try {
        const inv = await collectInventory(kek);
        const secrets = inv.tables.find((t) => t.table === "secrets")!;
        assert.equal(secrets.present, true);
        assert.equal(secrets.byVersion[1], 1);
        assert.equal(secrets.byVersion[2], 2);
        assert.equal(secrets.byKeyId["kek-old"], 2);
        assert.equal(secrets.byKeyId["kek-new"], 1);
        assert.deepEqual(secrets.unconfiguredKeyIds, []);
        const retired = await collectInventory(retiredKek());
        assert.deepEqual(retired.tables.find((t) => t.table === "secrets")!.unconfiguredKeyIds, ["kek-old"]);
        const piSettings = inv.tables.find((t) => t.table === "pi_settings")!;
        assert.equal(piSettings.present, false);
        assert.doesNotMatch(JSON.stringify(inv), new RegExp(CANARY));
      } finally {
        await query("DELETE FROM secrets WHERE id = ANY($1)", [ids]);
      }
    });

    it("inventory counts hostile key ids as data, not prototype writes", async () => {
      const protoKek = new EnvKekProvider("__proto__", b64());
      const ctx = secretContext(orgId, "user", userId, "PROTO_ME");
      const sealed = encryptSecret(protoKek, CANARY, ctx);
      const rowId = await insertSecretRow({
        ciphertext: sealed.ciphertext,
        keyId: "__proto__",
        version: 2,
        name: "PROTO_ME",
      });
      try {
        const inv = await collectInventory(protoKek);
        const secrets = inv.tables.find((t) => t.table === "secrets")!;
        assert.equal(secrets.byKeyId["__proto__"], 1);
        assert.ok(secrets.total >= 1);
        assert.deepEqual(secrets.unconfiguredKeyIds, []);
        const without = await collectInventory(retiredKek());
        assert.deepEqual(without.tables.find((t) => t.table === "secrets")!.unconfiguredKeyIds, ["__proto__"]);
        const ver = await verifyEncryptedRecords(protoKek);
        assert.equal(ver.failed, 0);
        assert.doesNotMatch(JSON.stringify(inv), new RegExp(CANARY));
      } finally {
        await query("DELETE FROM secrets WHERE id = $1", [rowId]);
      }
    });

    it("verify authenticates all tables and reports opaque failures without values", async () => {
      const kek = rotatedKek();
      const sctx = secretContext(orgId, "user", userId, "VERIFY_ME");
      const sealed = encryptSecret(kek, CANARY, sctx);
      const sid = await insertSecretRow({ ciphertext: sealed.ciphertext, keyId: sealed.keyId, version: 2, name: "VERIFY_ME" });
      const mc = encryptSecret(oldKekOnly(), CANARY, modelCredentialContext(orgId, userId, "verify-provider"));
      const mcId = uuidv7();
      await query(
        `INSERT INTO model_credentials (id, org_id, user_id, provider_id, credential_type, ciphertext, key_id, encryption_version)
         VALUES ($1, $2, $3, 'verify-provider', 'api_key', $4, 'kek-old', 2)`,
        [mcId, orgId, userId, mc.ciphertext],
      );
      const pa = encryptSecret(oldKekOnly(), CANARY, piAuthContext(orgId, userId));
      const paId = uuidv7();
      await query(`INSERT INTO pi_auth (id, org_id, user_id, ciphertext, key_id, encryption_version) VALUES ($1, $2, $3, $4, 'kek-old', 2)`, [
        paId,
        orgId,
        userId,
        pa.ciphertext,
      ]);
      const le = encryptSecret(oldKekOnly(), CANARY, podLaunchEnvContext(podId));
      await query(`INSERT INTO pod_launch_env (pod_id, ciphertext, key_id, encryption_version) VALUES ($1, $2, 'kek-old', 2)`, [
        podId,
        le.ciphertext,
      ]);
      // Tamper one copy: any flipped byte breaks v2 authentication.
      const bad = Buffer.from(sealed.ciphertext);
      bad[bad.length - 1]! ^= 0x01;
      const badId = await insertSecretRow({ ciphertext: bad, keyId: sealed.keyId, version: 2, name: "VERIFY_BAD" });
      try {
        const report = await verifyEncryptedRecords(kek, { batchSize: 2 });
        assert.equal(report.failed, 1);
        assert.equal(report.failures.length, 1);
        assert.deepEqual(report.failures[0], { table: "secrets", id: badId, code: "unreadable" });
        assert.equal(report.ok, report.checked - 1);
        assert.doesNotMatch(JSON.stringify(report), new RegExp(CANARY));
      } finally {
        await query("DELETE FROM secrets WHERE id = ANY($1)", [[sid, badId]]);
        await query("DELETE FROM model_credentials WHERE id = $1", [mcId]);
        await query("DELETE FROM pi_auth WHERE id = $1", [paId]);
        await query("DELETE FROM pod_launch_env WHERE pod_id = $1", [podId]);
      }
    });

    it("migrate converts v1 rows to bound v2 under the current KEK, resumably", async () => {
      const kek = rotatedKek();
      const old = oldKekOnly();
      const rows: { table: string; id: string; ctx: Parameters<typeof encryptSecret>[2] }[] = [];
      const sctx = secretContext(orgId, "user", userId, "MIG_ME");
      const v1s = sealV1(old, CANARY);
      const sid = await insertSecretRow({ ciphertext: v1s.ciphertext, keyId: "kek-old", version: 1, name: "MIG_ME" });
      rows.push({ table: "secrets", id: sid, ctx: sctx });
      const mcId = uuidv7();
      const mcCtx = modelCredentialContext(orgId, userId, "mig-provider");
      await query(
        `INSERT INTO model_credentials (id, org_id, user_id, provider_id, credential_type, ciphertext, key_id, encryption_version)
         VALUES ($1, $2, $3, 'mig-provider', 'api_key', $4, 'kek-old', 1)`,
        [mcId, orgId, userId, sealV1(old, CANARY).ciphertext],
      );
      rows.push({ table: "model_credentials", id: mcId, ctx: mcCtx });
      const first = await migrateLegacyEnvelopes(kek, { batchSize: 1 });
      assert.equal(first.failed, 0);
      assert.ok(first.migrated >= 2);
      assert.doesNotMatch(JSON.stringify(first), new RegExp(CANARY));
      for (const r of rows) {
        const idCol = "id";
        const got = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
          `SELECT ciphertext, key_id, encryption_version FROM ${r.table} WHERE ${idCol} = $1`,
          [r.id],
        );
        const row = got.rows[0]!;
        assert.equal(row.encryption_version, ENCRYPTION_VERSION_V2);
        assert.equal(row.key_id, "kek-new");
        assert.equal(decryptSecret(kek, row.ciphertext, row.key_id, r.ctx, row.encryption_version), CANARY);
      }
      // Second run is a no-op: idempotent and resumable.
      const second = await migrateLegacyEnvelopes(kek, { batchSize: 1 });
      assert.equal(second.migrated, 0);
      assert.equal(second.failed, 0);
      assert.equal(second.remaining, 0);
      await query("DELETE FROM secrets WHERE id = $1", [sid]);
      await query("DELETE FROM model_credentials WHERE id = $1", [mcId]);
    });

    it("migrate records unreadable rows without blocking the rest", async () => {
      const kek = rotatedKek();
      const good = sealV1(oldKekOnly(), CANARY);
      const goodId = await insertSecretRow({ ciphertext: good.ciphertext, keyId: "kek-old", version: 1, name: "MIG_GOOD" });
      const truncated = Buffer.from(good.ciphertext.subarray(0, 8));
      const badId = await insertSecretRow({ ciphertext: truncated, keyId: "kek-old", version: 1, name: "MIG_BAD" });
      try {
        const report = await migrateLegacyEnvelopes(kek, { batchSize: 10 });
        assert.equal(report.migrated, 1);
        assert.equal(report.failed, 1);
        assert.equal(report.remaining, 1);
        assert.equal(report.failures.length, 1);
        assert.equal(report.failures[0]?.["table"], "secrets");
        assert.equal(report.failures[0]?.["id"], badId);
        assert.doesNotMatch(JSON.stringify(report), new RegExp(CANARY));
        const row = await query<{ encryption_version: number }>(
          "SELECT encryption_version FROM secrets WHERE id = $1",
          [goodId],
        );
        assert.equal(row.rows[0]?.["encryption_version"], 2);
      } finally {
        await query("DELETE FROM secrets WHERE id = ANY($1)", [[goodId, badId]]);
      }
    });

    it("rewrap moves v2 rows onto the current KEK preserving plaintext", async () => {
      const kek = rotatedKek();
      const old = oldKekOnly();
      const ctx = secretContext(orgId, "user", userId, "REWRAP_ME");
      const v2old = encryptSecret(old, CANARY, ctx);
      const rowId = await insertSecretRow({ ciphertext: v2old.ciphertext, keyId: "kek-old", version: 2, name: "REWRAP_ME" });
      try {
        const report = await rewrapToCurrentKek(kek, { batchSize: 1 });
        assert.equal(report.failed, 0);
        assert.ok(report.rewrapped >= 1);
        const got = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
          "SELECT ciphertext, key_id, encryption_version FROM secrets WHERE id = $1",
          [rowId],
        );
        const row = got.rows[0]!;
        assert.equal(row.key_id, "kek-new");
        assert.equal(row.encryption_version, 2);
        assert.equal(decryptSecret(kek, row.ciphertext, row.key_id, ctx, row.encryption_version), CANARY);
        // Transplant still rejected after rewrap: payload AAD was authenticated first.
        const wrong = secretContext(orgId, "template", templateId, "OTHER");
        assert.throws(() => decryptSecret(kek, row.ciphertext, row.key_id, wrong, row.encryption_version));
        const again = await rewrapToCurrentKek(kek);
        assert.equal(again.rewrapped, 0);
      } finally {
        await query("DELETE FROM secrets WHERE id = $1", [rowId]);
      }
    });

    it("full rotation ends with the old key droppable and reports value-free", async () => {
      const old = oldKekOnly();
      const kek = rotatedKek();
      const v1 = sealV1(old, CANARY);
      const rowId = await insertSecretRow({ ciphertext: v1.ciphertext, keyId: "kek-old", version: 1, name: "ROT_ME" });
      try {
        const mig = await migrateLegacyEnvelopes(kek);
        assert.equal(mig.failed, 0);
        const rw = await rewrapToCurrentKek(kek);
        assert.equal(rw.failed, 0);
        const ver = await verifyEncryptedRecords(retiredKek());
        assert.equal(ver.failed, 0);
        // Old key no longer referenced anywhere: retirement is safe.
        await assert.doesNotReject(assertConfiguredKeyReferences(retiredKek()));
        const status = await collectInventory(retiredKek());
        assert.deepEqual(status.tables.flatMap((t) => t.unconfiguredKeyIds), []);
        for (const report of [mig, rw, ver, status]) {
          assert.doesNotMatch(JSON.stringify(report), new RegExp(CANARY));
        }
        assert.equal(
          decryptSecret(
            retiredKek(),
            (await query<{ ciphertext: Buffer }>("SELECT ciphertext FROM secrets WHERE id = $1", [rowId])).rows[0]!
              .ciphertext,
            "kek-new",
            secretContext(orgId, "user", userId, "ROT_ME"),
            2,
          ),
          CANARY,
        );
      } finally {
        await query("DELETE FROM secrets WHERE id = $1", [rowId]);
      }
    });

    it("migrates retained legacy pi_settings rows under their own domain", async () => {
      // Historical 011 shape (identity columns adapted to post-045 text ids, as
      // pi_auth carries today). The table is created only in this disposable test
      // database; migration 049 covers it conditionally in real databases.
      await query(
        `CREATE TABLE pi_settings (
           id uuid PRIMARY KEY,
           org_id text NOT NULL REFERENCES organizations(id),
           user_id text NOT NULL REFERENCES users(id),
           ciphertext bytea NOT NULL,
           key_id text NOT NULL,
           version integer NOT NULL DEFAULT 1,
           files text[] NOT NULL DEFAULT '{}',
           byte_size integer NOT NULL,
           package_count integer NOT NULL DEFAULT 0,
           dropped_keys text[] NOT NULL DEFAULT '{}',
           digest text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now(),
           updated_at timestamptz NOT NULL DEFAULT now(),
           UNIQUE (org_id, user_id)
         )`,
      );
      await query(
        `ALTER TABLE pi_settings ADD COLUMN encryption_version integer NOT NULL DEFAULT 1
           CONSTRAINT pi_settings_encryption_version_check CHECK (encryption_version IN (1, 2))`,
      );
      try {
        const kek = rotatedKek();
        const ctx = piSettingsContext(orgId, "user", userId);
        const v1 = sealV1(oldKekOnly(), CANARY);
        const v1Id = uuidv7();
        await query(
          `INSERT INTO pi_settings (id, org_id, user_id, ciphertext, key_id, files, byte_size, digest, encryption_version)
           VALUES ($1, $2, $3, $4, 'kek-old', '{}', 0, 'x', 1)`,
          [v1Id, orgId, userId, v1.ciphertext],
        );
        const v2old = encryptSecret(oldKekOnly(), CANARY, ctx);
        const v2Id = uuidv7();
        const user2 = uuidv7();
        await query("INSERT INTO users (id, email) VALUES ($1, $2)", [user2, `${user2}@example.test`]);
        const ctx2 = piSettingsContext(orgId, "user", user2);
        const v2old2 = encryptSecret(oldKekOnly(), CANARY, ctx2);
        await query(
          `INSERT INTO pi_settings (id, org_id, user_id, ciphertext, key_id, files, byte_size, digest, encryption_version)
           VALUES ($1, $2, $3, $4, 'kek-old', '{}', 0, 'x', 2)`,
          [v2Id, orgId, user2, v2old2.ciphertext],
        );
        void v2old;
        const inv = await collectInventory(kek);
        const piSettings = inv.tables.find((t) => t.table === "pi_settings")!;
        assert.equal(piSettings.present, true);
        assert.equal(piSettings.byVersion[1], 1);
        assert.equal(piSettings.byVersion[2], 1);
        const ver = await verifyEncryptedRecords(kek);
        assert.equal(ver.failed, 0);
        const mig = await migrateLegacyEnvelopes(kek);
        assert.equal(mig.failed, 0);
        assert.equal(mig.remaining, 0);
        const got = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
          "SELECT ciphertext, key_id, encryption_version FROM pi_settings WHERE id = $1",
          [v1Id],
        );
        const migratedRow = got.rows[0]!;
        assert.equal(migratedRow.encryption_version, ENCRYPTION_VERSION_V2);
        assert.equal(migratedRow.key_id, "kek-new");
        assert.equal(
          decryptSecret(kek, migratedRow.ciphertext, migratedRow.key_id, ctx, migratedRow.encryption_version),
          CANARY,
        );
        // Same identity under the pi_auth domain must NOT authenticate: legacy rows
        // migrate under their own domain, never pi_auth's.
        assert.throws(() =>
          decryptSecret(
            kek,
            migratedRow.ciphertext,
            migratedRow.key_id,
            piAuthContext(orgId, userId),
            migratedRow.encryption_version,
          ),
        );
        const rw = await rewrapToCurrentKek(kek);
        assert.equal(rw.failed, 0);
        assert.equal(rw.pendingLegacy, 0);
        assert.equal(rw.remaining, 0);
        const got2 = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
          "SELECT ciphertext, key_id, encryption_version FROM pi_settings WHERE id = $1",
          [v2Id],
        );
        const rewrappedRow = got2.rows[0]!;
        assert.equal(rewrappedRow.key_id, "kek-new");
        assert.equal(
          decryptSecret(kek, rewrappedRow.ciphertext, rewrappedRow.key_id, ctx2, rewrappedRow.encryption_version),
          CANARY,
        );
        assert.doesNotMatch(JSON.stringify([ver, mig, rw]), new RegExp(CANARY));
      } finally {
        await query("DROP TABLE pi_settings");
      }
    });

    it("rows locked by a concurrent writer report as remaining, then migrate on retry", async () => {
      const kek = rotatedKek();
      const v1 = sealV1(oldKekOnly(), CANARY);
      const rowId = await insertSecretRow({ ciphertext: v1.ciphertext, keyId: "kek-old", version: 1, name: "LOCK_ME" });
      const holder = new pg.Pool({ connectionString: dbUrl });
      const blocker = await holder.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM secrets WHERE id = $1 FOR UPDATE", [rowId]);
        const blocked = await migrateLegacyEnvelopes(kek, { batchSize: 10 });
        assert.equal(blocked.scanned, 0);
        assert.equal(blocked.migrated, 0);
        assert.equal(blocked.failed, 0);
        assert.ok(blocked.remaining >= 1);
        await blocker.query("ROLLBACK");
        const retry = await migrateLegacyEnvelopes(kek, { batchSize: 10 });
        assert.equal(retry.migrated, 1);
        assert.equal(retry.failed, 0);
        assert.equal(retry.remaining, 0);
        const got = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number }>(
          "SELECT ciphertext, key_id, encryption_version FROM secrets WHERE id = $1",
          [rowId],
        );
        const row = got.rows[0]!;
        assert.equal(
          decryptSecret(kek, row.ciphertext, row.key_id, secretContext(orgId, "user", userId, "LOCK_ME"), row.encryption_version),
          CANARY,
        );
      } finally {
        blocker.release();
        await holder.end();
        await query("DELETE FROM secrets WHERE id = $1", [rowId]);
      }
    });

    it("rewrap yields to a real OAuth refresh and never overwrites the rotated grant", async () => {
      const providerId = "maintenance-concurrent-refresh";
      const context = modelCredentialContext(orgId, userId, providerId);
      const entry = { type: "oauth", access: CANARY, refresh: "test-refresh", expires: 1 };
      const sealed = encryptSecret(oldKekOnly(), JSON.stringify(entry), context);
      const rowId = uuidv7();
      await query(`INSERT INTO model_credentials
        (id, org_id, user_id, provider_id, credential_type, ciphertext, key_id, encryption_version, expires_at)
        VALUES ($1, $2, $3, $4, 'oauth', $5, $6, 2, to_timestamp(1))`,
      [rowId, orgId, userId, providerId, sealed.ciphertext, sealed.keyId]);
      let entered!: () => void;
      let release!: () => void;
      const inRefresh = new Promise<void>((resolve) => { entered = resolve; });
      const continueRefresh = new Promise<void>((resolve) => { release = resolve; });
      const next = { ...entry, access: `${CANARY}-rotated`, expires: Date.now() + 3_600_000 };
      const refreshing = ensureFreshCredential(rotatedKek(), { orgId, userId }, providerId, 60_000, {
        refreshExec: async () => { entered(); await continueRefresh; return next; },
      });
      try {
        await inRefresh;
        const during = await rewrapToCurrentKek(rotatedKek(), { batchSize: 1 });
        assert.ok(during.remaining >= 1);
        release();
        assert.deepEqual(await refreshing, { state: "ready" });
        const afterRefresh = await rewrapToCurrentKek(rotatedKek(), { batchSize: 1 });
        assert.equal(afterRefresh.remaining, 0);
        const result = await query<{ ciphertext: Buffer; key_id: string; encryption_version: number; revision: string }>(
          "SELECT ciphertext, key_id, encryption_version, revision FROM model_credentials WHERE id = $1", [rowId]);
        const row = result.rows[0]!;
        assert.equal(row.key_id, "kek-new");
        assert.equal(Number(row.revision), 2);
        assert.deepEqual(JSON.parse(decryptSecret(rotatedKek(), row.ciphertext, row.key_id, context, row.encryption_version)), next);
      } finally {
        release();
        await refreshing;
        await query("DELETE FROM model_credentials WHERE id = $1", [rowId]);
      }
    });

    it("operator CLI drives rewrap/migrate/verify/status with safe exit codes", async () => {
      const v1 = sealV1(oldKekOnly(), CANARY);
      const v1Id = await insertSecretRow({ ciphertext: v1.ciphertext, keyId: "kek-old", version: 1, name: "CLI_V1" });
      const ctx = secretContext(orgId, "user", userId, "CLI_V2");
      const v2old = encryptSecret(oldKekOnly(), CANARY, ctx);
      const v2Id = await insertSecretRow({ ciphertext: v2old.ciphertext, keyId: "kek-old", version: 2, name: "CLI_V2" });
      const env = {
        ...process.env,
        DATABASE_URL: dbUrl,
        SECRETS_KEK: NEW_B64,
        SECRETS_KEK_ID: "kek-new",
        SECRETS_KEK_PREVIOUS: JSON.stringify({ "kek-old": OLD_B64 }),
      };
      const cwd = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
      const runCli = (...args: string[]) =>
        spawnSync(process.execPath, ["--import", "tsx", "src/secrets-maintenance.ts", ...args], {
          cwd,
          env,
          encoding: "utf8",
          timeout: 120_000,
        });
      try {
        // Rewrap first: it rewraps what it can, but legacy rows are outside its
        // power, so it must refuse success rather than bless a key retirement
        // that would strand them.
        const early = runCli("rewrap");
        assert.equal(early.status, 1, early.stderr);
        assert.match(early.stdout, /rewrapped=1\b/);
        assert.match(early.stdout, /pendingLegacy=1\b/);
        const mig = runCli("migrate", "--batch-size", "5");
        assert.equal(mig.status, 0, mig.stderr);
        assert.match(mig.stdout, /migrated=1\b/);
        const rw = runCli("rewrap");
        assert.equal(rw.status, 0, rw.stderr);
        assert.match(rw.stdout, /rewrapped=0\b/);
        assert.match(rw.stdout, /pendingLegacy=0\b/);
        const ver = runCli("verify");
        assert.equal(ver.status, 0, ver.stderr);
        assert.match(ver.stdout, /failed=0/);
        const status = runCli("status");
        assert.equal(status.status, 0, status.stderr);
        assert.match(status.stdout, /secrets/);
        assert.match(status.stdout, /model_credentials/);
        assert.match(status.stdout, /kek-new\(2\)/);
        for (const out of [early.stdout, mig.stdout, rw.stdout, ver.stdout, status.stdout]) {
          assert.doesNotMatch(out, new RegExp(CANARY));
        }
        const bad = runCli("bogus");
        assert.notEqual(bad.status, 0);
      } finally {
        await query("DELETE FROM secrets WHERE id = ANY($1)", [[v1Id, v2Id]]);
      }
    });
  },
);
