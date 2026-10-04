/**
 * src/server/model-credentials/refresh.ts — provider-scoped refresh authority.
 *
 * OAuth providers rotate their refresh token on every use, so two environments holding the
 * same one are in a race — the first to refresh revokes the other. The rule that ends the
 * race: pods never hold a refresh token. They borrow access tokens, and the *server* is the
 * only environment that ever refreshes.
 *
 * This module refreshes one provider row at a time. Refreshing goes through pi's own runtime
 * (`ModelRuntime` over a single-entry in-memory store), so every provider pi knows refreshes
 * exactly the way pi would — endpoint, client id, rotation semantics — rather than through a
 * second, drifting implementation. The row is locked `FOR UPDATE` across the pass: two
 * concurrent refreshes of one grant is precisely the race this exists to prevent. That lock
 * is held across network I/O, so every step of the pass is bounded — an unbounded one wedged
 * the row for eleven hours, and because each waiting poll held a pool connection, the whole
 * API stopped answering rather than just this route.
 *
 * Error messages, thrown Errors, and any log line from this file name providers and
 * classifications only. They never embed refresh tokens, access tokens, ciphertext, or
 * provider response bodies.
 */
import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { tx, type Queryable } from "../db/index.js";
import { decryptSecret, encryptSecret, type KekProvider } from "../secrets/crypto.js";
import { modelCredentialContext } from "../secrets/context.js";
import { asDate, credentialNeedsRefresh, expiresAtForStorage, parseCredentialEntry } from "./store.js";
import type { CredentialSubject } from "./types.js";

/**
 * A pod asks early, not at the last second: thirty minutes of guaranteed validity means a
 * token handed out now survives any single request it will be used for, and the next poll
 * lands long before expiry.
 */
export const MIN_VALIDITY_MS = 30 * 60 * 1000;

/** How long one provider refresh may hold the row lock before giving up on the network call. */
export const REFRESH_BUDGET_MS = 20_000;

/**
 * Waiting on the lock is the common case when a pod polls while a refresh is already in flight.
 * Failing fast sheds that poll — the caller retries — instead of parking a pool connection on it.
 */
export const LOCK_TIMEOUT_MS = 5_000;

/**
 * The backstop for a pass that dies between statements: without it the transaction sits
 * `idle in transaction` holding the row until the cluster-wide timeout, which is a day away.
 */
export const IDLE_IN_TX_TIMEOUT_MS = REFRESH_BUDGET_MS + 10_000;

/** Postgres raises this when `lock_timeout` expires. */
export const LOCK_NOT_AVAILABLE = "55P03";

const TERMINAL_FAILURE_CODES = new Set([
  "revoked",
  "invalid_grant",
  "missing_refresh_token",
  "migration_required",
]);

export type RefreshOutcome =
  | { state: "ready" }
  | { state: "reconnect_required"; reason: string }
  | { state: "temporarily_unavailable" }
  | { state: "missing" };

export type RefreshExec = (
  entry: Record<string, unknown>,
  providerId: string,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

export type ClassifiedRefreshError =
  | { state: "reconnect_required"; reason: "invalid_grant" | "revoked" | "missing_refresh_token" }
  | { state: "temporarily_unavailable" };

interface CredentialRow {
  ciphertext: Buffer;
  key_id: string;
  encryption_version: number;
  credential_type: string;
  expires_at: Date | string | null;
  last_failure_code: string | null;
}

/**
 * Bounds one refresh. A provider that never answers must not decide how long the row stays
 * locked, so the pass moves on; the abandoned call is left to settle on its own.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  // Losing the race leaves `work` to reject later with nobody listening, which Node treats as an
  // unhandled rejection — this claims it without hiding the rejection from the race itself.
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`refresh timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function isLockNotAvailable(error: unknown): boolean {
  return (error as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

function isTerminalFailureCode(code: string | null | undefined): boolean {
  return typeof code === "string" && TERMINAL_FAILURE_CODES.has(code);
}

function hasUsableRefreshToken(entry: Record<string, unknown>): boolean {
  const refresh = entry["refresh"];
  return typeof refresh === "string" && refresh.trim().length > 0;
}

/**
 * Map a refresh/network failure onto a bounded classification. Only the error's message is
 * inspected, and only against a small regex — the message itself is never returned, logged,
 * or stored. pi reports every refresh failure the same way, so the provider's own wording is
 * all there is: Meta's identity token cannot be renewed, and pi says "Meta session expired"
 * when it stops minting keys.
 */
export function classifyRefreshError(error: unknown): ClassifiedRefreshError {
  const message = errorMessage(error);
  if (/revoked|session expired/i.test(message)) {
    return { state: "reconnect_required", reason: "revoked" };
  }
  if (/invalid_grant|invalid_client/i.test(message)) {
    return { state: "reconnect_required", reason: "invalid_grant" };
  }
  return { state: "temporarily_unavailable" };
}

async function persistRotatedEntry(
  client: Queryable,
  args: {
    kek: KekProvider;
    subject: CredentialSubject;
    providerId: string;
    entry: Record<string, unknown>;
  },
): Promise<void> {
  const { ciphertext, keyId, encryptionVersion } = encryptSecret(
    args.kek,
    JSON.stringify(args.entry),
    modelCredentialContext(args.subject.orgId, args.subject.userId, args.providerId),
  );
  await client.query(
    `UPDATE model_credentials
        SET ciphertext = $4,
            key_id = $5,
            encryption_version = $7,
            expires_at = $6,
            revision = model_credentials.revision + 1,
            last_refresh_at = now(),
            last_failure_code = NULL,
            last_failure_at = NULL,
            updated_at = now()
      WHERE org_id = $1 AND user_id = $2 AND provider_id = $3`,
    [args.subject.orgId, args.subject.userId, args.providerId, ciphertext, keyId, expiresAtForStorage(args.entry), encryptionVersion],
  );
}

async function persistFailure(
  client: Queryable,
  subject: CredentialSubject,
  providerId: string,
  code: string,
): Promise<void> {
  await client.query(
    `UPDATE model_credentials
        SET last_failure_code = $4,
            last_failure_at = now(),
            updated_at = now()
      WHERE org_id = $1 AND user_id = $2 AND provider_id = $3`,
    [subject.orgId, subject.userId, providerId, code],
  );
}

/**
 * Default refresh: a single-entry in-memory CredentialStore so pi's runtime can rotate this
 * provider the way it would against auth.json, without touching any other provider's grant.
 */
async function defaultRefreshExec(
  entry: Record<string, unknown>,
  providerId: string,
  minValidityMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const entries: Record<string, Record<string, unknown>> = {
    [providerId]: { ...entry },
  };
  const store = {
    read: (id: string) => Promise.resolve(entries[id]),
    list: () =>
      Promise.resolve(
        Object.entries(entries)
          .filter(([, v]) => v !== null && typeof v === "object" && (v["type"] === "oauth" || v["type"] === "api_key"))
          .map(([id, v]) => ({ providerId: id, type: v["type"] as "oauth" | "api_key" })),
      ),
    modify: async (
      id: string,
      fn: (current: Record<string, unknown> | undefined) => Promise<Record<string, unknown> | undefined>,
    ) => {
      // Pi CredentialStore: undefined from fn leaves the entry unchanged (it does not delete).
      const next = await fn(entries[id]);
      if (next !== undefined) entries[id] = next;
      return next ?? entries[id];
    },
    delete: (id: string) => {
      delete entries[id];
      return Promise.resolve();
    },
  };

  const runtime = await ModelRuntime.create({
    // The store speaks auth.json's own entry shape, which is exactly pi-ai's Credential
    // wire shape; that type just is not re-exported from the agent package, so the
    // assertion says it once, here.
    credentials: store as CreateModelRuntimeOptions["credentials"],
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
    signal,
  });
  await runtime.getAuth(providerId, { minOAuthValidityMs: minValidityMs, signal });
  const mutated = entries[providerId];
  if (!mutated) throw new Error("refresh removed the credential");
  return mutated;
}

export async function ensureFreshCredential(
  kek: KekProvider,
  subject: CredentialSubject,
  providerId: string,
  minValidityMs: number,
  opts?: { signal?: AbortSignal; refreshExec?: RefreshExec },
): Promise<RefreshOutcome> {
  opts?.signal?.throwIfAborted();
  try {
    return await tx(async (client) => {
      await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${IDLE_IN_TX_TIMEOUT_MS}`);

      const rows = await client.query<CredentialRow>(
        `SELECT ciphertext, key_id, encryption_version, credential_type, expires_at, last_failure_code
           FROM model_credentials
          WHERE org_id = $1 AND user_id = $2 AND provider_id = $3
          FOR UPDATE`,
        [subject.orgId, subject.userId, providerId],
      );
      const row = rows.rows[0];
      if (!row) return { state: "missing" } satisfies RefreshOutcome;

      if (isTerminalFailureCode(row.last_failure_code)) {
        return { state: "reconnect_required", reason: row.last_failure_code! };
      }
      if (row.credential_type !== "oauth" || !credentialNeedsRefresh(asDate(row.expires_at), minValidityMs)) {
        return { state: "ready" };
      }

      let entry: Record<string, unknown>;
      try {
        // JSON.parse may echo a slice of the plaintext; swallow it rather than classify/log it.
        // The context is this row's own identity; v1 legacy rows ignore it in the bounded reader.
        entry = parseCredentialEntry(
          decryptSecret(
            kek,
            row.ciphertext,
            row.key_id,
            modelCredentialContext(subject.orgId, subject.userId, providerId),
            Number(row.encryption_version),
          ),
        );
      } catch {
        await persistFailure(client, subject, providerId, "transient");
        return { state: "temporarily_unavailable" };
      }

      if (entry["type"] !== "oauth") return { state: "ready" };

      if (!hasUsableRefreshToken(entry)) {
        await persistFailure(client, subject, providerId, "missing_refresh_token");
        return { state: "reconnect_required", reason: "missing_refresh_token" };
      }

      const exec =
        opts?.refreshExec ??
        ((current, id, signal) => defaultRefreshExec(current, id, minValidityMs, signal));
      try {
        opts?.signal?.throwIfAborted();
        const next = await withDeadline(exec(entry, providerId, opts?.signal), REFRESH_BUDGET_MS);
        opts?.signal?.throwIfAborted();
        if (next === null || typeof next !== "object" || Array.isArray(next)) {
          await persistFailure(client, subject, providerId, "transient");
          return { state: "temporarily_unavailable" };
        }
        await persistRotatedEntry(client, { kek, subject, providerId, entry: next });
        return { state: "ready" };
      } catch (error) {
        if (opts?.signal?.aborted) throw error;
        const classified = !hasUsableRefreshToken(entry)
          ? ({ state: "reconnect_required", reason: "missing_refresh_token" } as const)
          : classifyRefreshError(error);
        const code = classified.state === "reconnect_required" ? classified.reason : "transient";
        await persistFailure(client, subject, providerId, code);
        return classified;
      }
    });
  } catch (error) {
    // 55P03 aborts the Postgres transaction; tx() rolls it back. Do not touch the row —
    // another refresh is in flight, and the caller may still read the current grant after.
    if (isLockNotAvailable(error)) return { state: "temporarily_unavailable" };
    throw error;
  }
}
