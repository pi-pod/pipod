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
import { accountCustomProviders, customStatus, deleteCustomCredential, listCustomCredentialMeta, storeCustomLogin } from "./custom.js";
import { capabilityOf, pinnedPiProviders } from "./dependencies.js";
import { acquireLease } from "./lease.js";
import {
  classifyCredentialMeta,
  executeLogin,
  runWithLoginDeadline,
  type LoginExec,
} from "./login.js";
import { type RefreshExec } from "./refresh.js";
import { listCredentials } from "./sharing.js";
import { deleteCredential } from "./store.js";
import type {
  BrokerAuthInteraction,
  BrokerAuthType,
  CredentialListing,
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
  custom?: { baseUrl: string; binding: string };
}

/**
 * Broker-connectable Pi builtins and the account's supported custom providers, sorted by id.
 * Builtins are named as pi names them ("OpenAI", "OpenAI Codex
 * (legacy)"); the OAuth flow's own name or label says what signing in uses, because a provider
 * may take a subscription sign-in and an API key alike.
 */
export async function listConnectableProviders(subject: CredentialSubject): Promise<ConnectableProvider[]> {
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
  for (const [id, custom] of await accountCustomProviders(subject)) {
    connectable.push({ id, name: id, oauth: null, apiKey: true, brokerSupported: true, custom });
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
    async status(subject: CredentialSubject): Promise<CredentialListing> {
      try {
        const [listing, custom] = await Promise.all([listCredentials(subject), listCustomCredentialMeta(subject)]);
        if (custom.length) {
          const providers = await accountCustomProviders(subject);
          const builtins = new Set(listing.credentials.map((credential) => credential.providerId));
          for (const row of custom) {
            if (!builtins.has(row.provider_id)) {
              listing.credentials.push({ ...customStatus(row, providers.get(row.provider_id)?.binding), source: "own" });
            }
          }
        }
        await auditBroker({
          subject,
          action: "model_credentials.status",
          detail: {
            providers: listing.credentials.map((status) => ({
              provider: status.providerId,
              state: status.state,
              source: status.source,
            })),
          },
        });
        return listing;
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
      opts?: { signal?: AbortSignal; customBinding?: string | null },
    ): Promise<CredentialStatus> {
      try {
        const binding = opts?.customBinding;
        const status = binding && authType === "api_key"
          ? await runWithLoginDeadline(opts?.signal, interaction.signal, (signal) =>
            storeCustomLogin(kek, subject, providerId, binding, {
              ...interaction, signal, prompt: (prompt) => interaction.prompt({ ...prompt, signal }),
            }))
          : await executeLogin(kek, subject, providerId, authType, interaction, {
            signal: opts?.signal, loginExec: seams?.loginExec,
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
        const removed = await deleteCredential(subject, providerId) || await deleteCustomCredential(subject, providerId);
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
