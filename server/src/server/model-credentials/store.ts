/**
 * Provider-scoped encrypted persistence for account model credentials.
 *
 * Each row is one complete Pi credential entry (oauth or api_key), envelope-encrypted
 * with the same primitives as pi_auth / secrets. Metadata needed without decrypting
 * (type, expiry, revision, last refresh, bounded failure code) lives in columns.
 * Values are never logged.
 */
import type { CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import type pg from "pg";
import { query, tx, type Queryable } from "../db/index.js";
import { uuidv7 } from "../ids.js";
import { decryptSecret, encryptSecret, type KekProvider } from "../secrets/crypto.js";
import { modelCredentialContext } from "../secrets/context.js";
import type { CredentialSubject, CredentialType } from "./types.js";

export type PiCredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
export type PiCredential = NonNullable<Awaited<ReturnType<PiCredentialStore["read"]>>>;

/** OpenRouter and similar encode "non-expiring" as MAX_SAFE_INTEGER; also treat ≥ year 9000 as NULL. */
export const NON_EXPIRING_SQL_CUTOFF_MS = Date.UTC(9000, 0, 1);

const META_COLUMNS = `id, org_id, user_id, provider_id, credential_type, key_id, expires_at, revision,
       last_refresh_at, last_failure_code, last_failure_at, created_at, updated_at`;

export interface ModelCredentialRow {
  id: string;
  org_id: string;
  user_id: string;
  provider_id: string;
  credential_type: CredentialType;
  ciphertext: Buffer;
  key_id: string;
  expires_at: Date | null;
  revision: string | number;
  last_refresh_at: Date | null;
  last_failure_code: string | null;
  last_failure_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type ModelCredentialMetaRow = Omit<ModelCredentialRow, "ciphertext">;

export interface CredentialMeta {
  id: string;
  orgId: string;
  userId: string;
  providerId: string;
  type: CredentialType;
  keyId: string;
  expiresAt: Date | null;
  revision: number;
  lastRefreshAt: Date | null;
  lastFailureCode: string | null;
  lastFailureAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Ciphertext-bearing select shape: version travels so reads stay bound after migration 049. */
interface EncryptedCredentialRow {
  ciphertext: Buffer;
  key_id: string;
  encryption_version: number;
}

/** Trusted row identity for one (org, user, provider) credential row. */
function credentialContext(subject: CredentialSubject, providerId: string) {
  return modelCredentialContext(subject.orgId, subject.userId, providerId);
}

function decryptCredentialEntry(
  kek: KekProvider,
  subject: CredentialSubject,
  providerId: string,
  row: EncryptedCredentialRow,
): Record<string, unknown> {
  return parseCredentialEntry(
    decryptSecret(
      kek,
      row.ciphertext,
      row.key_id,
      credentialContext(subject, providerId),
      Number(row.encryption_version),
    ),
  );
}

async function runQuery<R extends pg.QueryResultRow>(
  db: Queryable | undefined,
  text: string,
  params: unknown[],
): Promise<pg.QueryResult<R>> {
  if (db) return db.query<R>(text, params);
  return query<R>(text, params);
}

export function parseRevision(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

export function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** ISO-8601 for status JSON; omitted when the timestamp is null (non-expiring / never refreshed). */
export function isoTimestamp(value: Date | string | null | undefined): string | undefined {
  const date = asDate(value ?? null);
  return date ? date.toISOString() : undefined;
}

export function credentialMetaFromRow(row: ModelCredentialMetaRow): CredentialMeta {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    providerId: row.provider_id,
    type: row.credential_type,
    keyId: row.key_id,
    expiresAt: asDate(row.expires_at),
    revision: parseRevision(row.revision),
    lastRefreshAt: asDate(row.last_refresh_at),
    lastFailureCode: row.last_failure_code,
    lastFailureAt: asDate(row.last_failure_at),
    createdAt: asDate(row.created_at) ?? new Date(0),
    updatedAt: asDate(row.updated_at) ?? new Date(0),
  };
}

/**
 * Derive the SQL `expires_at` value from a Pi credential entry.
 * API keys and non-finite / absurdly-far OAuth expiries (MAX_SAFE_INTEGER, ≥ year 9000)
 * store NULL — they are non-expiring for lease and status purposes.
 */
export function expiresAtForStorage(entry: Record<string, unknown>): Date | null {
  if (entry["type"] !== "oauth") return null;
  const expires = entry["expires"];
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
  if (expires === Number.MAX_SAFE_INTEGER || expires >= NON_EXPIRING_SQL_CUTOFF_MS) return null;
  return new Date(expires);
}

export function credentialTypeOf(entry: Record<string, unknown>): CredentialType {
  const type = entry["type"];
  if (type === "oauth" || type === "api_key") return type;
  throw new Error("credential entry type must be oauth or api_key");
}

/** True when the stored expiry has passed. NULL expiry is non-expiring. */
export function credentialIsExpired(expiresAt: Date | null, now: Date = new Date()): boolean {
  if (expiresAt == null) return false;
  return expiresAt.getTime() <= now.getTime();
}

/** True when an OAuth grant should be refreshed to satisfy minValidityMs. NULL expiry is not due. */
export function credentialNeedsRefresh(
  expiresAt: Date | null,
  minValidityMs: number,
  now: Date = new Date(),
): boolean {
  if (expiresAt == null) return false;
  return expiresAt.getTime() < now.getTime() + minValidityMs;
}

export function parseCredentialEntry(plaintext: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(plaintext);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stored model credential is not an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Deep-copy an entry and strip the OAuth refresh token only. Unknown fields are preserved
 * verbatim so provider-specific Pi fields survive into sanitized leases.
 */
export function sanitizeCredentialEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(entry);
  if (copy["type"] === "oauth") delete copy["refresh"];
  return copy;
}

export async function listCredentialMeta(
  subject: CredentialSubject,
  db?: Queryable,
): Promise<CredentialMeta[]> {
  const rows = await runQuery<ModelCredentialMetaRow>(
    db,
    `SELECT ${META_COLUMNS}
       FROM model_credentials
      WHERE org_id = $1 AND user_id = $2
      ORDER BY provider_id`,
    [subject.orgId, subject.userId],
  );
  return rows.rows.map(credentialMetaFromRow);
}

export async function readCredentialEntry(
  kek: KekProvider,
  subject: CredentialSubject,
  providerId: string,
  db?: Queryable,
): Promise<Record<string, unknown> | null> {
  const rows = await runQuery<EncryptedCredentialRow>(
    db,
    `SELECT ciphertext, key_id, encryption_version FROM model_credentials
      WHERE org_id = $1 AND user_id = $2 AND provider_id = $3`,
    [subject.orgId, subject.userId, providerId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return decryptCredentialEntry(kek, subject, providerId, row);
}

export async function upsertCredentialEntry(
  kek: KekProvider,
  subject: CredentialSubject,
  providerId: string,
  entry: Record<string, unknown>,
  db?: Queryable,
): Promise<CredentialMeta> {
  const credentialType = credentialTypeOf(entry);
  const expiresAt = expiresAtForStorage(entry);
  const { ciphertext, keyId, encryptionVersion } = encryptSecret(
    kek,
    JSON.stringify(entry),
    credentialContext(subject, providerId),
  );
  const rows = await runQuery<ModelCredentialMetaRow>(
    db,
    `INSERT INTO model_credentials (
       id, org_id, user_id, provider_id, credential_type, ciphertext, key_id,
       encryption_version, expires_at, revision, last_failure_code, last_failure_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, NULL, NULL)
     ON CONFLICT (org_id, user_id, provider_id)
     DO UPDATE SET
       credential_type = EXCLUDED.credential_type,
       ciphertext = EXCLUDED.ciphertext,
       key_id = EXCLUDED.key_id,
       encryption_version = EXCLUDED.encryption_version,
       expires_at = EXCLUDED.expires_at,
       revision = model_credentials.revision + 1,
       last_failure_code = NULL,
       last_failure_at = NULL,
       updated_at = now()
     RETURNING ${META_COLUMNS}`,
    [
      uuidv7(),
      subject.orgId,
      subject.userId,
      providerId,
      credentialType,
      ciphertext,
      keyId,
      encryptionVersion,
      expiresAt,
    ],
  );
  return credentialMetaFromRow(rows.rows[0]!);
}

export async function deleteCredential(
  subject: CredentialSubject,
  providerId: string,
  db?: Queryable,
): Promise<boolean> {
  const res = await runQuery(
    db,
    `DELETE FROM model_credentials
      WHERE org_id = $1 AND user_id = $2 AND provider_id = $3`,
    [subject.orgId, subject.userId, providerId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Pi-ai CredentialStore over `model_credentials`.
 *
 * `read` / `list` are plain queries (no decryption for list). `modify` is the only write
 * path used by ModelRuntime login/refresh: it runs in its own transaction, locks the
 * provider row `FOR UPDATE`. A returned entry is inserted or updated; returning `undefined`
 * deletes the provider row, as required by the broker's persistence contract. `delete` is
 * also available as the explicit logout path.
 */
export function dbCredentialStore(kek: KekProvider, subject: CredentialSubject): PiCredentialStore {
  const store = {
    async read(providerId: string, options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted();
      const entry = await readCredentialEntry(kek, subject, providerId);
      return (entry ?? undefined) as PiCredential | undefined;
    },
    async list(options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted();
      const metas = await listCredentialMeta(subject);
      return metas.map((meta) => ({ providerId: meta.providerId, type: meta.type }));
    },
    async modify(
      providerId: string,
      fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
      options?: { signal?: AbortSignal },
    ) {
      options?.signal?.throwIfAborted();
      return tx(async (client) => {
        const rows = await client.query<EncryptedCredentialRow>(
          `SELECT ciphertext, key_id, encryption_version FROM model_credentials
            WHERE org_id = $1 AND user_id = $2 AND provider_id = $3
            FOR UPDATE`,
          [subject.orgId, subject.userId, providerId],
        );
        const row = rows.rows[0];
        const current = row
          ? (decryptCredentialEntry(kek, subject, providerId, row) as PiCredential)
          : undefined;
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next === undefined) {
          await deleteCredential(subject, providerId, client);
          return undefined;
        }
        await upsertCredentialEntry(kek, subject, providerId, next as Record<string, unknown>, client);
        return next;
      });
    },
    async delete(providerId: string, options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted();
      await deleteCredential(subject, providerId);
    },
  };
  return store as PiCredentialStore;
}
