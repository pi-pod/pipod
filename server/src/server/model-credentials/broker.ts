/**
 * Account-scoped model-credential broker: status, login, lease, and removal
 * over the provider-scoped store. Other server modules should depend on
 * {@link ModelCredentialBroker} rather than calling store/refresh/login pieces
 * directly.
 *
 * Audit details name providers and bounded outcomes only — never entries,
 * refresh tokens, ciphertext, or raw provider errors.
 */
import { audit } from "../audit.js";
import { HttpError } from "../httperrors.js";
import type { KekProvider } from "../secrets/crypto.js";
import { capabilityOf, pinnedPiProviders } from "./dependencies.js";
import { acquireLease } from "./lease.js";
import {
  classifyCredentialMeta,
  executeLogin,
  type LoginExec,
} from "./login.js";
import { type RefreshExec } from "./refresh.js";
import { deleteCredential, listCredentialMeta } from "./store.js";
import type {
  BrokerAuthInteraction,
  BrokerAuthType,
  CredentialStatus,
  CredentialSubject,
  LeaseResult,
  ModelCredentialBroker,
} from "./types.js";

export { classifyCredentialMeta };

/** Injectable seams so route tests can drive login prompts and refresh without Pi network. */
export interface ModelCredentialBrokerSeams {
  loginExec?: LoginExec;
  refreshExec?: RefreshExec;
}

/** One row of GET /v1/model-credentials `providers` (frozen protocol). */
export interface ConnectableProvider {
  id: string;
  name: string;
  oauth: { loginLabel: string } | null;
  apiKey: boolean;
  brokerSupported: boolean;
}

/**
 * Broker-connectable Pi builtins, sorted by id. Named as pi names them ("OpenAI", "OpenAI Codex
 * (legacy)"); the OAuth flow's own name or label says what signing in uses, because a provider
 * may take a subscription sign-in and an API key alike.
 */
export async function listConnectableProviders(): Promise<ConnectableProvider[]> {
  const connectable: ConnectableProvider[] = [];
  for (const provider of (await pinnedPiProviders()).values()) {
    const capability = capabilityOf(provider);
    if (!capability.supported) continue;
    connectable.push({
      id: provider.id,
      name: provider.name,
      oauth: capability.oauth
        ? { loginLabel: provider.oauth?.loginLabel ?? provider.oauth?.name ?? provider.name }
        : null,
      apiKey: capability.apiKey,
      brokerSupported: true,
    });
  }
  return connectable.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function classifiedOutcome(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "error";
}

async function auditBroker(args: {
  subject: CredentialSubject;
  action: string;
  providerId?: string;
  detail: Record<string, unknown>;
}): Promise<void> {
  await audit({
    orgId: args.subject.orgId,
    actorId: args.subject.userId,
    action: args.action,
    ...(args.providerId
      ? { targetType: "model_credential", targetId: args.providerId }
      : { targetType: "model_credentials" }),
    detail: args.detail,
  });
}

async function auditBrokerFailure(
  subject: CredentialSubject,
  action: string,
  providerId: string | undefined,
  error: unknown,
): Promise<void> {
  try {
    await auditBroker({
      subject,
      action,
      providerId,
      detail: {
        ...(providerId ? { provider: providerId } : {}),
        outcome: classifiedOutcome(error),
      },
    });
  } catch {
    // Failure audit must not replace the original error.
  }
}

export function createModelCredentialBroker(
  kek: KekProvider,
  seams?: ModelCredentialBrokerSeams,
): ModelCredentialBroker {
  return {
    async status(subject: CredentialSubject): Promise<CredentialStatus[]> {
      try {
        const metas = await listCredentialMeta(subject);
        const statuses = metas.map((meta) => classifyCredentialMeta(meta));
        await auditBroker({
          subject,
          action: "model_credentials.status",
          detail: {
            providers: statuses.map((status) => ({
              provider: status.providerId,
              state: status.state,
            })),
          },
        });
        return statuses;
      } catch (error) {
        await auditBrokerFailure(subject, "model_credentials.status", undefined, error);
        throw error;
      }
    },

    async login(
      subject: CredentialSubject,
      providerId: string,
      authType: BrokerAuthType,
      interaction: BrokerAuthInteraction,
      opts?: { signal?: AbortSignal },
    ): Promise<CredentialStatus> {
      try {
        const status = await executeLogin(kek, subject, providerId, authType, interaction, {
          signal: opts?.signal,
          loginExec: seams?.loginExec,
        });
        await auditBroker({
          subject,
          action: "model_credentials.login",
          providerId,
          detail: { provider: providerId, outcome: "ok", state: status.state },
        });
        return status;
      } catch (error) {
        await auditBrokerFailure(subject, "model_credentials.login", providerId, error);
        throw error;
      }
    },

    async lease(
      subject: CredentialSubject,
      providerIds: readonly string[],
      minValidityMs: number,
    ): Promise<LeaseResult> {
      try {
        const result = await acquireLease(kek, subject, providerIds, minValidityMs, {
          refreshExec: seams?.refreshExec,
        });
        const failures: Record<string, string> = {};
        for (const [id, failure] of Object.entries(result.failures)) {
          failures[id] = failure.state;
        }
        await auditBroker({
          subject,
          action: "model_credentials.lease",
          detail: {
            providers: [...providerIds],
            included: Object.keys(result.lease.providers),
            failures,
          },
        });
        return result;
      } catch (error) {
        await auditBrokerFailure(subject, "model_credentials.lease", undefined, error);
        throw error;
      }
    },

    async remove(subject: CredentialSubject, providerId: string): Promise<boolean> {
      try {
        const removed = await deleteCredential(subject, providerId);
        await auditBroker({
          subject,
          action: "model_credentials.remove",
          providerId,
          detail: { provider: providerId, outcome: removed ? "removed" : "missing" },
        });
        return removed;
      } catch (error) {
        await auditBrokerFailure(subject, "model_credentials.remove", providerId, error);
        throw error;
      }
    },
  };
}
