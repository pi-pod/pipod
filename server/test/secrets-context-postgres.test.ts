import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { EnvKekProvider, SecretCryptoError } from "../src/server/secrets/crypto.js";
import { putSecret, resolveSecrets } from "../src/server/secrets/store.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
describe("secret row context binding (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgA = uuidv7();
  const orgB = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("context-test", randomBytes(32).toString("base64"));
  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'context a'), ($2, 'context b')", [orgA, orgB]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });
  after(async () => {
    await query("DELETE FROM secrets WHERE org_id IN ($1, $2)", [orgA, orgB]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id IN ($1, $2)", [orgA, orgB]);
    await closePool();
  });
  it("writes explicit v2 metadata and rejects ciphertext transplantation between organizations", async () => {
    for (const orgId of [orgA, orgB]) {
      await putSecret({ kek, orgId, scopeType: "user", scopeId: userId, name: "CONTEXT_CANARY",
        value: `disposable-context-${orgId}`, createdBy: userId });
    }
    const rows = await query<{ encryption_version: number; ciphertext: Buffer; key_id: string }>(
      "SELECT encryption_version, ciphertext, key_id FROM secrets WHERE org_id = $1", [orgA]);
    assert.equal(rows.rows[0]!.encryption_version, 2);
    const { ciphertext, key_id } = rows.rows[0]!;
    await query("UPDATE secrets SET ciphertext = $1, key_id = $2 WHERE org_id = $3", [ciphertext, key_id, orgB]);
    await assert.rejects(resolveSecrets({ kek, orgId: orgB, userId, templateId: null }),
      (error: unknown) => error instanceof SecretCryptoError && !error.message.includes("disposable-context"));
    assert.equal((await resolveSecrets({ kek, orgId: orgA, userId, templateId: null })).env["CONTEXT_CANARY"],
      `disposable-context-${orgA}`);
  });
  it("rejects relabeling a valid v2 envelope as legacy", async () => {
    await query("UPDATE secrets SET encryption_version = 1 WHERE org_id = $1", [orgA]);
    await assert.rejects(resolveSecrets({ kek, orgId: orgA, userId, templateId: null }), SecretCryptoError);
  });
});
