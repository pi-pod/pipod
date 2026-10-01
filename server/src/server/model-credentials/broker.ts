/**
 * Account-scoped model-credential broker: status, login, lease, and removal
 * over the provider-scoped store. Other server modules should depend on
 * {@link ModelCredentialBroker} rather than calling store/refresh/login pieces
 * directly.
 *
 * Audit details name providers and bounded outcomes only — never entries,
 * refresh tokens, ciphertext, or raw provider errors.
 */
import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import { audit } from "../audit.js";
import { HttpError } from "../httperrors.js";
import type { KekProvider } from "../secrets/crypto.js";
import { BROKER_OAUTH_PROVIDERS, brokerCapability } from "./dependencies.js";
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

function listingCredentialStore(): NonNullable<CreateModelRuntimeOptions["credentials"]> {
  return {
    read: async () => undefined,
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
}

let connectableCache: ConnectableProvider[] | undefined;
let connectableInflight: Promise<ConnectableProvider[]> | undefined;

/**
 * Broker-connectable Pi builtins: names and OAuth loginLabel from ModelRuntime,
 * capabilities from {@link brokerCapability}. Cached after the first successful
 * load. Create options forbid credential files and model-catalog network.
 */
export async function listConnectableProviders(): Promise<ConnectableProvider[]> {
  if (connectableCache) return connectableCache;
  if (!connectableInflight) {
    connectableInflight = loadConnectableProviders().then(
      (list) => {
        connectableCache = list;
        connectableInflight = undefined;
        return list;
      },
      (error) => {
        connectableInflight = undefined;
        throw error;
      },
    );
  }
  return connectableInflight;
}

async function loadConnectableProviders(): Promise<ConnectableProvider[]> {
  const runtime = await ModelRuntime.create({
    credentials: listingCredentialStore(),
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const byId = new Map<string, ConnectableProvider>();
  for (const provider of runtime.getProviders()) {
    const listed = connectableFromRuntime(provider.id, provider.name, provider.auth);
    if (listed) byId.set(listed.id, listed);
  }
  for (const id of BROKER_OAUTH_PROVIDERS) {
    if (byId.has(id)) continue;
    const listed = connectableFromRuntime(id, id, undefined);
    if (listed) byId.set(listed.id, listed);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function connectableFromRuntime(
  id: string,
  name: string,
  auth: { oauth?: { name: string; loginLabel?: string }; apiKey?: { name: string } } | undefined,
): ConnectableProvider | null {
  const capability = brokerCapability(id);
  if (!capability.supported) return null;
  const loginLabel = auth?.oauth?.loginLabel ?? auth?.oauth?.name ?? name;
  return {
    id,
    name: capability.oauth ? (auth?.oauth?.name ?? name) : name,
    oauth: capability.oauth ? { loginLabel } : null,
    apiKey: capability.apiKey,
    brokerSupported: true,
  };
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
