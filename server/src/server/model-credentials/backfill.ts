import { query, tx } from "../db/index.js";
import { decryptSecret, type KekProvider } from "../secrets/crypto.js";
import { piAuthContext } from "../secrets/context.js";
import { expiresAtForStorage, upsertCredentialEntry } from "./store.js";

interface LegacyPiAuthRow {
  id: string;
  org_id: string;
  user_id: string;
  ciphertext: Buffer;
  key_id: string;
  encryption_version: number;
}

function isCredentialEntry(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>)["type"];
  return type === "oauth" || type === "api_key";
}

function requiresOAuthMigration(entry: Record<string, unknown>): boolean {
  if (entry["type"] !== "oauth" || expiresAtForStorage(entry) === null) return false;
  const refresh = entry["refresh"];
  return typeof refresh !== "string" || refresh.trim() === "";
}

/**
 * Split legacy whole-file custody into provider-scoped records without overwriting a
 * credential that already exists. The source pi_auth rows are intentionally left untouched.
 */
export async function backfillPiAuthToModelCredentials(
  kek: KekProvider,
): Promise<{ users: number; providers: number; skipped: number }> {
  const legacy = await query<LegacyPiAuthRow>(
    "SELECT id, org_id, user_id, ciphertext, key_id, encryption_version FROM pi_auth ORDER BY id",
  );
  const counts = { users: 0, providers: 0, skipped: 0 };

  for (const row of legacy.rows) {
    let parsed: unknown;
    try {
      // Legacy whole-file rows authenticate to (org, user); v1 rows predate
      // context binding and the bounded reader ignores it. Never log the error:
      // parser messages can quote plaintext.
      parsed = JSON.parse(
        decryptSecret(
          kek,
          row.ciphertext,
          row.key_id,
          piAuthContext(row.org_id, row.user_id),
          Number(row.encryption_version),
        ),
      );
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("legacy pi auth is not an object");
      }
    } catch {
      // Do not include the parse/decryption error: parser messages can quote plaintext.
      console.error(`model credential backfill: legacy row ${row.id} could not be read`);
      continue;
    }

    counts.users += 1;
    for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isCredentialEntry(value)) continue;
      try {
        const inserted = await tx(async (client) => {
          // API/gateway/worker processes can start together. Serialize their check+insert for
          // this subject/provider so the first stored provider record is never overwritten.
          const lockKey = JSON.stringify([row.org_id, row.user_id, providerId]);
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
          const existing = await client.query(
            `SELECT 1 FROM model_credentials
              WHERE org_id = $1 AND user_id = $2 AND provider_id = $3`,
            [row.org_id, row.user_id, providerId],
          );
          if (existing.rows[0]) return false;

          const subject = { orgId: row.org_id, userId: row.user_id };
          await upsertCredentialEntry(kek, subject, providerId, value, client);
          if (requiresOAuthMigration(value)) {
            await client.query(
              `UPDATE model_credentials
                  SET last_failure_code = 'migration_required',
                      last_failure_at = now(),
                      updated_at = now()
                WHERE org_id = $1 AND user_id = $2 AND provider_id = $3`,
              [row.org_id, row.user_id, providerId],
            );
          }
          return true;
        });
        if (inserted) counts.providers += 1;
        else counts.skipped += 1;
      } catch {
        // Continue with the remaining providers and users; never print entries or errors that
        // might carry provider responses or decrypted credential values.
        console.error(`model credential backfill: legacy row ${row.id} provider migration failed`);
      }
    }
  }

  return counts;
}
