/**
 * src/server/model-credentials/lease.ts — sanitized, provider-scoped access-token leases.
 *
 * A lease is what a pod may hold: OAuth entries with `refresh` stripped, plus api_key
 * entries unchanged. Acquisition walks providers serially so one request never holds many
 * locked pool connections at once. A provider outage must not kill a working lease — if a
 * due refresh fails transiently and the current access token is still valid, that token
 * ships and no failure is recorded.
 *
 * The aggregate revision is a SHA-256 of sorted `providerId:rowId:revision` lines over the
 * included providers only, so every process derives the same unchanged-lease value. The row
 * id is there because a removed and reconnected credential starts again at revision 1.
 *
 * Nothing in this file logs, throws, or returns refresh tokens, ciphertext, or raw
 * credential values.
 */
import { createHash } from "node:crypto";
import type { KekProvider } from "../secrets/crypto.js";
import { ensureFreshCredential, type RefreshExec, type RefreshOutcome } from "./refresh.js";
import {
  NON_EXPIRING_SQL_CUTOFF_MS,
  credentialNeedsRefresh,
  listCredentialMeta,
  readCredentialEntry,
  sanitizeCredentialEntry,
  type CredentialMeta,
} from "./store.js";
import type { CredentialLease, CredentialSubject, LeaseFailure, LeaseResult } from "./types.js";

const TERMINAL_FAILURE_CODES = new Set([
  "revoked",
  "invalid_grant",
  "missing_refresh_token",
  "migration_required",
]);

function isTerminalFailureCode(code: string | null | undefined): code is string {
  return typeof code === "string" && TERMINAL_FAILURE_CODES.has(code);
}

function isOauthDue(meta: CredentialMeta, minValidityMs: number): boolean {
  return meta.type === "oauth" && credentialNeedsRefresh(meta.expiresAt, minValidityMs);
}

function isCurrentlyValid(entry: Record<string, unknown>): boolean {
  if (entry["type"] !== "oauth") return true;
  const expires = entry["expires"];
  if (typeof expires !== "number" || !Number.isFinite(expires)) return true;
  if (expires === Number.MAX_SAFE_INTEGER || expires >= NON_EXPIRING_SQL_CUTOFF_MS) return true;
  return expires > Date.now();
}

function leaseExpiresAt(entry: Record<string, unknown>): number | undefined {
  const expires = entry["expires"];
  if (typeof expires !== "number" || !Number.isFinite(expires)) return undefined;
  if (expires === Number.MAX_SAFE_INTEGER || expires >= NON_EXPIRING_SQL_CUTOFF_MS) return undefined;
  return expires;
}

async function readMeta(subject: CredentialSubject, providerId: string): Promise<CredentialMeta | null> {
  const rows = await listCredentialMeta(subject);
  return rows.find((row) => row.providerId === providerId) ?? null;
}

/**
 * Deterministic aggregate revision: sha256 hex of sorted `providerId:rowId:revision` lines.
 * Order of `rows` does not matter; a change to any revision or row does.
 */
export function computeAggregateRevision(rows: Array<[providerId: string, rowId: string, revision: number]>): string {
  const lines = rows
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([providerId, rowId, revision]) => `${providerId}:${rowId}:${revision}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function acquireLease(
  kek: KekProvider,
  subject: CredentialSubject,
  providerIds: readonly string[],
  minValidityMs: number,
  opts?: { refreshExec?: RefreshExec },
): Promise<LeaseResult> {
  const providers: CredentialLease["providers"] = {};
  const failures: Record<string, LeaseFailure> = {};
  const included: Array<[providerId: string, rowId: string, revision: number]> = [];

  for (const providerId of providerIds) {
    const meta = await readMeta(subject, providerId);
    if (!meta) {
      failures[providerId] = { state: "missing" };
      continue;
    }
    if (isTerminalFailureCode(meta.lastFailureCode)) {
      failures[providerId] = { state: "reconnect_required", reason: meta.lastFailureCode };
      continue;
    }

    let refreshOutcome: RefreshOutcome | undefined;
    if (isOauthDue(meta, minValidityMs)) {
      refreshOutcome = await ensureFreshCredential(kek, subject, providerId, minValidityMs, opts);
      if (refreshOutcome.state === "missing") {
        failures[providerId] = { state: "missing" };
        continue;
      }
      if (refreshOutcome.state === "reconnect_required") {
        failures[providerId] = { state: "reconnect_required", reason: refreshOutcome.reason };
        continue;
      }
    }

    const entry = await readCredentialEntry(kek, subject, providerId);
    if (!entry) {
      failures[providerId] = { state: "missing" };
      continue;
    }

    if (isCurrentlyValid(entry)) {
      const freshMeta = (refreshOutcome ? await readMeta(subject, providerId) : meta) ?? meta;
      const revision = Number(freshMeta.revision);
      const sanitized = sanitizeCredentialEntry(entry);
      const item: {
        entry: Record<string, unknown>;
        expiresAt?: number;
        providerRevision: number;
      } = {
        entry: sanitized,
        providerRevision: Number.isFinite(revision) ? revision : 0,
      };
      const expiresAt = leaseExpiresAt(sanitized);
      if (expiresAt !== undefined) item.expiresAt = expiresAt;
      providers[providerId] = item;
      included.push([providerId, freshMeta.id, item.providerRevision]);
      continue;
    }

    if (refreshOutcome?.state === "temporarily_unavailable") {
      failures[providerId] = { state: "temporarily_unavailable" };
    }
  }

  return {
    lease: {
      revision: computeAggregateRevision(included),
      scope: [...providerIds],
      providers,
    },
    failures,
  };
}
