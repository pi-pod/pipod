/**
 * Operator key-lifecycle tooling (secure-secrets plan Phase 3): inventory, verify,
 * legacy-format migration, and KEK rewrapping across every encrypted table.
 *
 * Tables covered: `secrets`, `model_credentials`, `pi_auth`, `pod_launch_env`, and
 * `pi_settings` when it exists (migration 012 dropped it, so live databases report
 * it absent; retained legacy rows still migrate and rewrap like every other table —
 * the plan's retention decision governs deletion, never encryption migration).
 *
 * Safety rules, enforced throughout:
 * - Reports carry counts and opaque row ids only — never plaintext values, never raw
 *   crypto/provider error text (those can quote plaintext). Crypto failures are mapped
 *   to fixed failure codes; see {@link RowFailureCode}.
 * - Batches are bounded, idempotent, and resumable: `migrate` only touches v1 rows,
 *   `rewrap` only touches v2 rows not on the current KEK, and every write is a
 *   compare-and-swap on (ciphertext, encryption_version, key_id) under
 *   `SELECT ... FOR UPDATE SKIP LOCKED`, so a concurrent refresh writer or a second
 *   operator run can never clobber a row — the loser counts as `contended` and a
 *   re-run picks the row up again.
 * - Traversal is bounded keyset paging by primary key: after each batch the cursor
 *   advances past every visited row (migrated, failed, or contended alike), so each
 *   row is processed exactly once per run — a failing row can neither inflate its
 *   count nor starve healthy rows behind it. A final predicate count always runs
 *   afterwards, so rows skipped by SKIP LOCKED (or claimed concurrently) surface as
 *   `remaining` and the caller (CLI) exits non-zero instead of reporting success.
 * - Unreadable rows are never skipped-and-succeeded: they are recorded as failures
 *   and the caller (CLI) exits non-zero while the remaining rows still progress.
 */

import { getPool, type Queryable } from "../db/index.js";
import {
  decryptSecret,
  encryptSecret,
  ENCRYPTION_VERSION_V1,
  ENCRYPTION_VERSION_V2,
  rewrapSecret,
  SecretCryptoError,
  DecryptionFailedError,
  MalformedEnvelopeError,
  UnknownKekError,
  UnsupportedVersionError,
  type KekProvider,
} from "./crypto.js";
import {
  modelCredentialContext,
  piAuthContext,
  piSettingsContext,
  podLaunchEnvContext,
  secretContext,
  type EncryptionContext,
} from "./context.js";

/** Fixed failure codes for row-level crypto outcomes. Never carries values or errors. */
export type RowFailureCode =
  | "unreadable"
  | "unknown-key"
  | "malformed"
  | "unsupported-version"
  | "bad-context";

export interface RowFailure {
  /** Encrypted table holding the row. */
  table: string;
  /** Opaque primary-key value. Safe to log: reveals nothing about the plaintext. */
  id: string;
  code: RowFailureCode;
}

export interface TableInventory {
  table: string;
  /** False when the table does not exist (expected for pi_settings). */
  present: boolean;
  total: number;
  byVersion: Record<number, number>;
  byKeyId: Record<string, number>;
  /** Distinct key ids no configured KEK can unwrap (empty without a kek argument). */
  unconfiguredKeyIds: string[];
}

export interface InventoryReport {
  tables: TableInventory[];
}

export interface VerifyReport {
  checked: number;
  ok: number;
  /** Total failed rows (failures[] is capped at MAX_FAILURE_IDS ids). */
  failed: number;
  failures: RowFailure[];
}

export interface MigrateReport {
  scanned: number;
  /** v1 rows converted to context-bound v2 under the current KEK. */
  migrated: number;
  /** Rows claimed by a concurrent writer; re-run to pick them up. */
  contended: number;
  /** Total failed rows (failures[] is capped at MAX_FAILURE_IDS ids). */
  failed: number;
  failures: RowFailure[];
  /** Rows still matching the v1 predicate after traversal (failed, contended, or locked). */
  remaining: number;
}

export interface RewrapReport {
  scanned: number;
  /** v2 rows re-wrapped from a retired KEK onto the current one. */
  rewrapped: number;
  contended: number;
  /** Total failed rows (failures[] is capped at MAX_FAILURE_IDS ids). */
  failed: number;
  failures: RowFailure[];
  /** Rows still matching the rewrap predicate after traversal. */
  remaining: number;
  /**
   * Rows not yet on v2, which rewrap cannot touch: run `migrate` first. Retiring a
   * key while this is non-zero strands those rows on the retired KEK, so the CLI
   * refuses to report success.
   */
  pendingLegacy: number;
}

export const DEFAULT_BATCH_SIZE = 200;
export const MAX_BATCH_SIZE = 10_000;
/** Truncate stored failure-id lists so one bad key cannot grow a report without bound. */
export const MAX_FAILURE_IDS = 500;

interface Row {
  id: string;
  ciphertext: Buffer;
  key_id: string;
  encryption_version: number;
  org_id?: string;
  scope_type?: string;
  scope_id?: string;
  name?: string;
  user_id?: string;
  provider_id?: string;
  pod_id?: string;
  owner_user_id?: string | null;
}

type ContextBuilder = (row: Row) => EncryptionContext;

interface TableSpec {
  table: string;
  /** Primary-key column, used for opaque reporting, paging, and CAS writes. */
  idColumn: string;
  /** Columns selected for context building, in addition to the custody columns. */
  identitySelect: string;
  buildContext: ContextBuilder;
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new BadContextError();
  return value;
}

class BadContextError extends Error {}

/** Trusted row identity for `secrets`: (org_id, scope_type, scope_id, name). */
function secretRowContext(row: Row): EncryptionContext {
  const scopeType = requireText(row.scope_type);
  if (scopeType !== "org" && scopeType !== "user" && scopeType !== "template") {
    throw new BadContextError();
  }
  return secretContext(requireText(row.org_id), scopeType, requireText(row.scope_id), requireText(row.name));
}

function modelCredentialRowContext(row: Row): EncryptionContext {
  return modelCredentialContext(requireText(row.org_id), requireText(row.user_id), requireText(row.provider_id));
}

function piAuthRowContext(row: Row): EncryptionContext {
  return piAuthContext(requireText(row.org_id), requireText(row.user_id));
}

function piSettingsRowContext(row: Row): EncryptionContext {
  // Historical 011 rows are user-scoped: (org_id, user_id), bound under the
  // pi_settings domain — never the pi_auth domain, which is a different record
  // type with its own AAD label. A scope-shaped table would carry scope columns.
  if (typeof row.scope_type === "string" && typeof row.scope_id === "string") {
    return piSettingsContext(requireText(row.org_id), row.scope_type, row.scope_id);
  }
  return piSettingsContext(requireText(row.org_id), "user", requireText(row.user_id));
}

function podLaunchEnvRowContext(row: Row): EncryptionContext {
  return podLaunchEnvContext(requireText(row.pod_id ?? row.id));
}

const TABLE_SPECS: TableSpec[] = [
  {
    table: "sandbox_host_auth",
    idColumn: "id",
    identitySelect: "owner_user_id",
    buildContext: (row) => ({ kind: "sandbox_host", hostId: requireText(row.id), ownerUserId: row.owner_user_id == null ? "" : requireText(row.owner_user_id) }),
  },
  {
    table: "secrets",
    idColumn: "id",
    identitySelect: "org_id, scope_type, scope_id, name",
    buildContext: secretRowContext,
  },
  {
    table: "model_credentials",
    idColumn: "id",
    identitySelect: "org_id, user_id, provider_id",
    buildContext: modelCredentialRowContext,
  },
  {
    table: "pi_auth",
    idColumn: "id",
    identitySelect: "org_id, user_id",
    buildContext: piAuthRowContext,
  },
  {
    table: "pi_settings",
    idColumn: "id",
    identitySelect: "org_id, user_id",
    buildContext: piSettingsRowContext,
  },
  {
    table: "pod_launch_env",
    idColumn: "pod_id",
    identitySelect: "pod_id",
    buildContext: podLaunchEnvRowContext,
  },
];

function db(dbOrUndefined?: Queryable): Queryable {
  return dbOrUndefined ?? getPool();
}

function pushFailure(list: RowFailure[], table: string, id: string, code: RowFailureCode): void {
  if (list.length < MAX_FAILURE_IDS) list.push({ table, id, code });
}

/** Map a decryption failure to a fixed code. Never propagates messages or values. */
function classifyCryptoError(error: unknown): RowFailureCode {
  if (error instanceof UnknownKekError) return "unknown-key";
  if (error instanceof MalformedEnvelopeError) return "malformed";
  if (error instanceof UnsupportedVersionError) return "unsupported-version";
  if (error instanceof DecryptionFailedError) return "unreadable";
  if (error instanceof SecretCryptoError) return "unreadable";
  return "unreadable";
}

async function tableExists(client: Queryable, table: string): Promise<boolean> {
  const res = await client.query("SELECT to_regclass($1) AS oid", [`public.${table}`]);
  return res.rows[0]?.["oid"] !== null;
}

function normalizeBatchSize(batchSize?: number): number {
  if (batchSize === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`batch size must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  }
  return batchSize;
}

function friendlyMissingColumn(error: unknown): void {
  // Migration 049 not applied yet: every maintenance query names encryption_version.
  const code = (error as { code?: unknown }).code;
  if (code === "42703") {
    throw new Error(
      "encrypted tables lack encryption_version (migration 049_encryption_version not applied); run migrations first",
    );
  }
}

/**
 * Startup safe check for `main.ts`: every stored key reference must resolve to a
 * configured KEK before backfill, listeners, or workers start. Throws a safe Error
 * naming only the missing key ids and affected row counts — never values.
 */
export class MissingKeyReferencesError extends Error {
  override readonly name = "MissingKeyReferencesError";
}

export async function assertConfiguredKeyReferences(
  kek: KekProvider,
  client?: Queryable,
): Promise<void> {
  const c = db(client);
  const missing: { table: string; keyId: string; rows: number }[] = [];
  for (const spec of TABLE_SPECS) {
    if (!(await tableExists(c, spec.table))) continue;
    let rows: { key_id: string; count: string }[];
    try {
      const res = await c.query<{ key_id: string; count: string }>(
        `SELECT key_id, COUNT(*) AS count FROM ${spec.table} GROUP BY key_id`,
      );
      rows = res.rows;
    } catch (error) {
      friendlyMissingColumn(error);
      throw error;
    }
    for (const row of rows) {
      if (!kek.hasKey(row.key_id)) {
        missing.push({ table: spec.table, keyId: row.key_id, rows: Number(row.count) });
      }
    }
  }
  if (missing.length > 0) {
    const detail = missing.map((m) => `${m.table}["${m.keyId}"] (${m.rows} rows)`).join(", ");
    throw new MissingKeyReferencesError(
      `startup blocked: encrypted rows reference KEK id(s) missing from configuration: ${detail}; ` +
        `add them to SECRETS_KEK_PREVIOUS before starting (see "secrets:maintenance status")`,
    );
  }
}

/** Count records by table, envelope format, and key id. Read-only. */
export async function collectInventory(kek?: KekProvider, client?: Queryable): Promise<InventoryReport> {
  const c = db(client);
  const tables: TableInventory[] = [];
  for (const spec of TABLE_SPECS) {
    if (!(await tableExists(c, spec.table))) {
      tables.push({ table: spec.table, present: false, total: 0, byVersion: {}, byKeyId: {}, unconfiguredKeyIds: [] });
      continue;
    }
    let rows: { encryption_version: number; key_id: string; count: string }[];
    try {
      const res = await c.query<{ encryption_version: number; key_id: string; count: string }>(
        `SELECT encryption_version, key_id, COUNT(*) AS count FROM ${spec.table} GROUP BY encryption_version, key_id`,
      );
      rows = res.rows;
    } catch (error) {
      friendlyMissingColumn(error);
      throw error;
    }
    // Maps, not object accumulation: a configured key id of "__proto__" must count
    // as data, not as a prototype assignment. Object.fromEntries defines own data
    // properties, so even "__proto__" stays a readable entry afterwards.
    const versionCounts = new Map<number, number>();
    const keyCounts = new Map<string, number>();
    let total = 0;
    for (const row of rows) {
      const n = Number(row.count);
      total += n;
      versionCounts.set(row.encryption_version, (versionCounts.get(row.encryption_version) ?? 0) + n);
      keyCounts.set(row.key_id, (keyCounts.get(row.key_id) ?? 0) + n);
    }
    const byKeyId: Record<string, number> = Object.fromEntries(keyCounts);
    tables.push({
      table: spec.table,
      present: true,
      total,
      byVersion: Object.fromEntries(versionCounts) as Record<number, number>,
      byKeyId,
      unconfiguredKeyIds: kek ? [...keyCounts.keys()].filter((id) => !kek.hasKey(id)).sort() : [],
    });
  }
  return { tables };
}

/**
 * Authenticate every encrypted record with its trusted row identity. Returns opaque
 * row ids for anything that fails; throws nothing for row-level failures.
 */
export async function verifyEncryptedRecords(
  kek: KekProvider,
  opts?: { db?: Queryable; batchSize?: number },
): Promise<VerifyReport> {
  const c = db(opts?.db);
  const limit = normalizeBatchSize(opts?.batchSize);
  const failures: RowFailure[] = [];
  let checked = 0;
  let ok = 0;
  let failed = 0;
  for (const spec of TABLE_SPECS) {
    if (!(await tableExists(c, spec.table))) continue;
    let lastId: string | null = null;
    for (;;) {
      let rows: Row[];
      try {
        const res = await c.query<Row>(
          `SELECT ${spec.idColumn} AS id, ciphertext, key_id, encryption_version, ${spec.identitySelect}
             FROM ${spec.table}
            WHERE ($1::text IS NULL OR ${spec.idColumn}::text > $1)
            ORDER BY ${spec.idColumn}::text LIMIT $2`,
          [lastId, limit],
        );
        rows = res.rows as Row[];
      } catch (error) {
        friendlyMissingColumn(error);
        throw error;
      }
      if (rows.length === 0) break;
      for (const row of rows) {
        checked += 1;
        lastId = row.id;
        let context: EncryptionContext;
        try {
          context = spec.buildContext(row);
        } catch {
          failed += 1;
          pushFailure(failures, spec.table, row.id, "bad-context");
          continue;
        }
        try {
          decryptSecret(kek, row.ciphertext, row.key_id, context, row.encryption_version);
          ok += 1;
        } catch (error) {
          failed += 1;
          pushFailure(failures, spec.table, row.id, classifyCryptoError(error));
        }
      }
      if (rows.length < limit) break;
    }
  }
  return { checked, ok, failed, failures };
}

async function countRemaining(
  c: Queryable,
  spec: TableSpec,
  predicate: string,
  params: unknown[],
): Promise<number> {
  const res = await c.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${spec.table} WHERE ${predicate}`, params);
  return Number(res.rows[0]?.["count"] ?? 0);
}

/**
 * Convert legacy v1 envelopes to context-bound v2 under the current KEK:
 * bounded legacy decrypt (no context exists to verify yet) followed by a v2
 * encrypt that binds the trusted row identity for the first time.
 *
 * Each row is visited exactly once per run via keyset paging; the cursor advances
 * past failures and contended rows alike. A final predicate count always runs, so
 * rows hidden by SKIP LOCKED (or claimed concurrently) report as `remaining`.
 */
export async function migrateLegacyEnvelopes(
  kek: KekProvider,
  opts?: { db?: Queryable; batchSize?: number },
): Promise<MigrateReport> {
  const c = db(opts?.db);
  const limit = normalizeBatchSize(opts?.batchSize);
  const failures: RowFailure[] = [];
  let scanned = 0;
  let migrated = 0;
  let contended = 0;
  let failed = 0;
  let remaining = 0;
  for (const spec of TABLE_SPECS) {
    if (!(await tableExists(c, spec.table))) continue;
    let lastId: string | null = null;
    for (;;) {
      const client = await getPoolOrClient(c);
      let batch: Row[];
      try {
        await client.query("BEGIN");
        const res = await client.query<Row>(
          `SELECT ${spec.idColumn} AS id, ciphertext, key_id, encryption_version, ${spec.identitySelect}
             FROM ${spec.table}
            WHERE encryption_version = $1 AND ($3::text IS NULL OR ${spec.idColumn}::text > $3)
            ORDER BY ${spec.idColumn}::text LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [ENCRYPTION_VERSION_V1, limit, lastId],
        );
        batch = res.rows as Row[];
        if (batch.length === 0) {
          await client.query("COMMIT");
          break;
        }
        for (const row of batch) {
          scanned += 1;
          lastId = row.id;
          let context: EncryptionContext;
          try {
            context = spec.buildContext(row);
          } catch {
            failed += 1;
            pushFailure(failures, spec.table, row.id, "bad-context");
            continue;
          }
          let plaintext: string;
          try {
            // v1 has no context binding to check; the reader still enforces framing,
            // sizes, and KEK authentication before this row gains a v2 binding.
            plaintext = decryptSecret(kek, row.ciphertext, row.key_id, context, row.encryption_version);
          } catch (error) {
            failed += 1;
            pushFailure(failures, spec.table, row.id, classifyCryptoError(error));
            continue;
          }
          const next = encryptSecret(kek, plaintext, context);
          const upd = await client.query(
            `UPDATE ${spec.table}
                SET ciphertext = $1, key_id = $2, encryption_version = $3, updated_at = now()
              WHERE ${spec.idColumn} = $4 AND ciphertext = $5 AND encryption_version = $6 AND key_id = $7`,
            [next.ciphertext, next.keyId, next.encryptionVersion, row.id, row.ciphertext, row.encryption_version, row.key_id],
          );
          if ((upd.rowCount ?? 0) === 1) {
            migrated += 1;
          } else {
            contended += 1;
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await tryRollback(client);
        friendlyMissingColumn(error);
        throw error;
      } finally {
        releaseIfPooled(client, c);
      }
    }
    // Always run, even when traversal saw nothing: rows locked by a concurrent
    // writer are invisible to SKIP LOCKED but still match, and must not read as done.
    remaining += await countRemaining(c, spec, "encryption_version = $1", [ENCRYPTION_VERSION_V1]);
  }
  return { scanned, migrated, contended, failed, failures, remaining };
}

/**
 * KEK rotation without payload re-encryption: v2 rows still wrapped under a retired
 * KEK are re-wrapped under the current one. `rewrapSecret` fully authenticates the
 * payload first, so a transplanted payload can never be laundered under fresh wrap.
 *
 * Rows not yet on v2 are outside rewrap's power (`rewrapSecret` is v2-only); they
 * are counted as `pendingLegacy` so key retirement never silently strands them —
 * run `migrate` first.
 */
export async function rewrapToCurrentKek(
  kek: KekProvider,
  opts?: { db?: Queryable; batchSize?: number },
): Promise<RewrapReport> {
  const c = db(opts?.db);
  const limit = normalizeBatchSize(opts?.batchSize);
  const failures: RowFailure[] = [];
  let scanned = 0;
  let rewrapped = 0;
  let contended = 0;
  let failed = 0;
  let remaining = 0;
  let pendingLegacy = 0;
  for (const spec of TABLE_SPECS) {
    if (!(await tableExists(c, spec.table))) continue;
    let lastId: string | null = null;
    for (;;) {
      const client = await getPoolOrClient(c);
      let batch: Row[];
      try {
        await client.query("BEGIN");
        const res = await client.query<Row>(
          `SELECT ${spec.idColumn} AS id, ciphertext, key_id, encryption_version, ${spec.identitySelect}
             FROM ${spec.table}
            WHERE encryption_version = $1 AND key_id <> $2
              AND ($4::text IS NULL OR ${spec.idColumn}::text > $4)
            ORDER BY ${spec.idColumn}::text LIMIT $3 FOR UPDATE SKIP LOCKED`,
          [ENCRYPTION_VERSION_V2, kek.keyId, limit, lastId],
        );
        batch = res.rows as Row[];
        if (batch.length === 0) {
          await client.query("COMMIT");
          break;
        }
        for (const row of batch) {
          scanned += 1;
          lastId = row.id;
          let context: EncryptionContext;
          try {
            context = spec.buildContext(row);
          } catch {
            failed += 1;
            pushFailure(failures, spec.table, row.id, "bad-context");
            continue;
          }
          let next: { ciphertext: Buffer; keyId: string; encryptionVersion: 2 };
          try {
            next = rewrapSecret(kek, row.ciphertext, row.key_id, context, row.encryption_version);
          } catch (error) {
            failed += 1;
            pushFailure(failures, spec.table, row.id, classifyCryptoError(error));
            continue;
          }
          const upd = await client.query(
            `UPDATE ${spec.table}
                SET ciphertext = $1, key_id = $2, encryption_version = $3, updated_at = now()
              WHERE ${spec.idColumn} = $4 AND ciphertext = $5 AND encryption_version = $6 AND key_id = $7`,
            [next.ciphertext, next.keyId, next.encryptionVersion, row.id, row.ciphertext, row.encryption_version, row.key_id],
          );
          if ((upd.rowCount ?? 0) === 1) {
            rewrapped += 1;
          } else {
            contended += 1;
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await tryRollback(client);
        friendlyMissingColumn(error);
        throw error;
      } finally {
        releaseIfPooled(client, c);
      }
    }
    remaining += await countRemaining(c, spec, "encryption_version = $1 AND key_id <> $2", [
      ENCRYPTION_VERSION_V2,
      kek.keyId,
    ]);
    pendingLegacy += await countRemaining(c, spec, "encryption_version <> $1", [ENCRYPTION_VERSION_V2]);
  }
  return { scanned, rewrapped, contended, failed, failures, remaining, pendingLegacy };
}

// --- Transaction helpers ------------------------------------------------------
// Maintenance runs against the shared pool in production but tests (and the CLI's
// single-threaded batches) may hand in any Queryable. Only a real pool can vend a
// dedicated client for multi-statement transactions; anything else runs the batch
// inline, which keeps the functions unit-testable without a pool.

type TxClient = Queryable & { release?: () => void };

function getPoolOrClient(c: Queryable): Promise<TxClient> {
  const maybePool = c as Partial<Pick<import("pg").Pool, "connect">>;
  if (typeof maybePool.connect === "function") {
    return (maybePool as import("pg").Pool).connect() as Promise<TxClient>;
  }
  return Promise.resolve(c as TxClient);
}

async function tryRollback(client: TxClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Rollback of a failed batch is best-effort; the original error propagates.
  }
}

function releaseIfPooled(client: TxClient, origin: Queryable): void {
  if (client !== origin && typeof client.release === "function") client.release();
}
