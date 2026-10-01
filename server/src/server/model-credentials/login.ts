/**
 * Account-scoped provider login: one-shot tickets and server-side Pi login against
 * encrypted `model_credentials` custody.
 *
 * Tickets are minted like pod tokens (`mclt_` + 43 URL-safe chars, sha256 stored, 300 s TTL)
 * so the account JWT never appears in a WebSocket URL. Login itself runs Pi's ModelRuntime
 * over {@link dbCredentialStore} with a 10-minute deadline; OAuth success requires a usable
 * refresh grant (non-empty `refresh` or non-expiring `expires_at`) before the row is kept.
 */
import { createHash, randomBytes } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { query } from "../db/index.js";
import { HttpError } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import type { KekProvider } from "../secrets/crypto.js";
import { brokerCapability, type BrokerCapability } from "./dependencies.js";
import {
  credentialIsExpired,
  dbCredentialStore,
  deleteCredential,
  isoTimestamp,
  listCredentialMeta,
  readCredentialEntry,
  type CredentialMeta,
} from "./store.js";
import type {
  BrokerAuthInteraction,
  BrokerAuthType,
  CredentialReconnectReason,
  CredentialStatus,
  CredentialSubject,
} from "./types.js";

export const LOGIN_TICKET_PREFIX = "mclt_";
/** Tickets are one-shot and expire after 300 s (frozen protocol). */
export const LOGIN_TICKET_TTL_MS = 300_000;
/** Overall server-side login deadline. Only this ends a healthy flow, not proxy idle. */
export const LOGIN_DEADLINE_MS = 10 * 60 * 1000;

const TERMINAL_FAILURE_CODES = new Set<string>([
  "revoked",
  "invalid_grant",
  "missing_refresh_token",
  "migration_required",
]);

const TRANSIENT_RETRY_AFTER_MS = 60_000;

export type LoginExec = (
  providerId: string,
  authType: BrokerAuthType,
  interaction: BrokerAuthInteraction,
) => Promise<unknown>;

export interface ConsumedLoginTicket {
  id: string;
  orgId: string;
  userId: string;
  providerId: string;
  authType: BrokerAuthType;
  podId: string | null;
  expiresAt: string;
}

export function mintLoginTicketValue(): string {
  return `${LOGIN_TICKET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashLoginTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

export async function createLoginTicket(
  subject: CredentialSubject,
  providerId: string,
  authType: BrokerAuthType,
  podId?: string | null,
): Promise<{ ticket: string; expiresAt: string }> {
  const ticket = mintLoginTicketValue();
  const expiresAt = new Date(Date.now() + LOGIN_TICKET_TTL_MS).toISOString();
  await query(
    `INSERT INTO model_credential_login_tickets
       (id, ticket_hash, org_id, user_id, provider_id, auth_type, pod_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      uuidv7(),
      hashLoginTicket(ticket),
      subject.orgId,
      subject.userId,
      providerId,
      authType,
      podId ?? null,
      expiresAt,
    ],
  );
  return { ticket, expiresAt };
}

/**
 * One-shot consume: DELETE … RETURNING expiry, then reject if the returned row is already
 * stale. Expired tickets are removed rather than left to linger.
 */
export async function consumeLoginTicket(ticket: string): Promise<ConsumedLoginTicket | null> {
  const rows = await query<{
    id: string;
    org_id: string;
    user_id: string;
    provider_id: string;
    auth_type: BrokerAuthType;
    pod_id: string | null;
    expires_at: Date | string;
  }>(
    `DELETE FROM model_credential_login_tickets
      WHERE ticket_hash = $1
      RETURNING id, org_id, user_id, provider_id, auth_type, pod_id, expires_at`,
    [hashLoginTicket(ticket)],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const expiresAt = isoTimestamp(row.expires_at);
  if (!expiresAt || Date.parse(expiresAt) <= Date.now()) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    providerId: row.provider_id,
    authType: row.auth_type,
    podId: row.pod_id,
    expiresAt,
  };
}

/**
 * Metadata → CredentialStatus with no network. Terminal failure codes become
 * `reconnect_required`; a transient failure on an already-expired row becomes
 * `temporarily_unavailable` with retryAfter = lastFailureAt + 60s; otherwise ready.
 *
 * Exported for broker status listing. login.ts does not import broker.ts (broker.login
 * calls executeLogin; a reverse import would cycle).
 */
export function classifyCredentialMeta(meta: CredentialMeta, now: Date = new Date()): CredentialStatus {
  const failure = meta.lastFailureCode;
  if (failure && TERMINAL_FAILURE_CODES.has(failure)) {
    return {
      providerId: meta.providerId,
      type: meta.type,
      state: "reconnect_required",
      reason: failure as CredentialReconnectReason,
      revision: meta.revision,
    };
  }
  if (failure === "transient" && credentialIsExpired(meta.expiresAt, now)) {
    const retryAfterMs = meta.lastFailureAt
      ? meta.lastFailureAt.getTime() + TRANSIENT_RETRY_AFTER_MS
      : undefined;
    return {
      providerId: meta.providerId,
      type: meta.type,
      state: "temporarily_unavailable",
      ...(retryAfterMs !== undefined ? { retryAfter: new Date(retryAfterMs).toISOString() } : {}),
      revision: meta.revision,
    };
  }
  const expiresAt = isoTimestamp(meta.expiresAt);
  const lastRefreshAt = isoTimestamp(meta.lastRefreshAt);
  return {
    providerId: meta.providerId,
    type: meta.type,
    state: "ready",
    ...(expiresAt ? { expiresAt } : {}),
    ...(lastRefreshAt ? { lastRefreshAt } : {}),
    revision: meta.revision,
  };
}

export async function executeLogin(
  kek: KekProvider,
  subject: CredentialSubject,
  providerId: string,
  authType: BrokerAuthType,
  interaction: BrokerAuthInteraction,
  opts?: { signal?: AbortSignal; loginExec?: LoginExec },
): Promise<CredentialStatus> {
  const capability = brokerCapability(providerId);
  const methodSupported = authType === "oauth" ? capability.oauth : capability.apiKey;
  if (!methodSupported) {
    throw unsupportedLoginError(providerId, authType, capability);
  }

  await runWithLoginDeadline(opts?.signal, interaction.signal, async (signal) => {
    const wired = withInteractionSignal(interaction, signal);
    const exec =
      opts?.loginExec ??
      ((id, type, wiredInteraction) => defaultLoginExec(kek, subject, id, type, wiredInteraction));
    await exec(providerId, authType, wired);
  });

  const entry = await readCredentialEntry(kek, subject, providerId);
  const meta = (await listCredentialMeta(subject)).find((row) => row.providerId === providerId) ?? null;
  const storedOauth = authType === "oauth" || meta?.type === "oauth" || entry?.["type"] === "oauth";
  if (storedOauth && !hasUsableOAuthRefresh(entry, meta)) {
    await deleteCredential(subject, providerId);
    throw missingRefreshTokenError(providerId);
  }
  if (!meta) {
    throw new HttpError(400, "login_failed", {
      code: "login_failed",
      message: "Login did not store a credential.",
      provider: providerId,
    });
  }

  return classifyCredentialMeta(meta);
}

async function defaultLoginExec(
  kek: KekProvider,
  subject: CredentialSubject,
  providerId: string,
  authType: BrokerAuthType,
  interaction: BrokerAuthInteraction,
): Promise<void> {
  const runtime = await ModelRuntime.create({
    credentials: dbCredentialStore(kek, subject),
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
    signal: interaction.signal,
  });
  await runtime.login(providerId, authType, interaction);
}

function hasUsableOAuthRefresh(
  entry: Record<string, unknown> | null,
  meta: CredentialMeta | null,
): boolean {
  const refresh = entry?.["refresh"];
  const nonemptyRefresh = typeof refresh === "string" && refresh.trim().length > 0;
  const nonExpiring = meta != null && meta.expiresAt == null;
  return nonemptyRefresh || nonExpiring;
}

function unsupportedLoginError(
  providerId: string,
  authType: BrokerAuthType,
  capability: BrokerCapability,
): HttpError {
  let message: string;
  if (!capability.supported) {
    message = `Account login is not supported for provider "${providerId}".`;
  } else if (capability.apiKey && authType === "oauth") {
    message = `Account oauth login is not supported for provider "${providerId}". Store a scoped API-key secret instead.`;
  } else {
    message = `Account ${authType} login is not supported for provider "${providerId}".`;
  }
  return new HttpError(400, "credential_provider_unsupported", {
    code: "credential_provider_unsupported",
    message,
    provider: providerId,
  });
}

function missingRefreshTokenError(providerId: string): HttpError {
  return new HttpError(400, "missing_refresh_token", {
    code: "missing_refresh_token",
    message: "OAuth login did not produce a usable refresh token.",
    provider: providerId,
  });
}

function withInteractionSignal(
  interaction: BrokerAuthInteraction,
  signal: AbortSignal,
): BrokerAuthInteraction {
  return {
    ...interaction,
    signal,
    prompt: (prompt) => {
      signal.throwIfAborted();
      return interaction.prompt(prompt);
    },
    notify: (event) => interaction.notify(event),
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const err = new Error("login cancelled");
  err.name = "AbortError";
  return err;
}

/**
 * Bounds the interactive login. A provider that never answers must not hold the WebSocket
 * (or a pool connection inside dbCredentialStore.modify) indefinitely; the caller's abort
 * and the 10-minute deadline both cancel the in-flight interaction.
 */
async function runWithLoginDeadline<T>(
  external: AbortSignal | undefined,
  interactionSignal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`login timed out after ${LOGIN_DEADLINE_MS}ms`));
  }, LOGIN_DEADLINE_MS);
  const sources = [controller.signal, external, interactionSignal].filter(
    (s): s is AbortSignal => s != null,
  );
  const signal = sources.length === 1 ? sources[0]! : AbortSignal.any(sources);

  const workPromise = work(signal);
  // Losing the race leaves `work` to reject later with nobody listening, which Node treats
  // as an unhandled rejection — this claims it without hiding the rejection from the race.
  workPromise.catch(() => {});

  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(abortReason(signal));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => {});

  try {
    return await Promise.race([workPromise, aborted]);
  } finally {
    clearTimeout(timer);
  }
}
