/**
 * src/server/model-credentials/dependencies.ts — which credentials a pod actually needs.
 *
 * Model provider ids are not always credential provider ids. `claude-bridge` authenticates
 * through Pi's `anthropic` entry; installing `pi-claude-agent-sdk` (or the legacy
 * `pi-claude-bridge`) needs that same Anthropic grant even when the selected model is
 * something else, because the package exposes tools like AskClaude.
 *
 * Broker login is narrower still: it covers the builtins of the server's pinned Pi, OAuth only
 * for those in {@link BROKER_OAUTH_PROVIDERS}, and `claude-bridge` itself is not loginable.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PACKAGE_PROVIDERS, packagesInclude } from "../../core/piregistry.js";

export const MODEL_CREDENTIAL_DEPENDENCIES: Record<string, readonly string[]> = {
  "claude-bridge": ["anthropic"],
};

/**
 * The pi builtins whose OAuth login the broker runs. The broker logs in on the server, never
 * where the user's browser is, so each flow here was checked against the pinned pi for a way to
 * finish remotely: a device code, a pasted code, or a pasted redirect URL. Check a new pi OAuth
 * provider the same way before listing it.
 */
export const BROKER_OAUTH_PROVIDERS = [
  "anthropic",
  "github-copilot",
  "kimi-coding",
  "meta",
  "openai",
  "openai-codex",
  "openrouter",
  "radius",
  "xai",
] as const;

const BROKER_OAUTH_PROVIDER_SET: ReadonlySet<string> = new Set(BROKER_OAUTH_PROVIDERS);

export interface BrokerCapability {
  oauth: boolean;
  apiKey: boolean;
  supported: boolean;
}

/** How the server's pinned pi lets one builtin provider authenticate. */
export interface PinnedPiProvider {
  id: string;
  name: string;
  oauth?: { name: string; loginLabel?: string };
  apiKey: boolean;
}

let pinnedProviders: Promise<ReadonlyMap<string, PinnedPiProvider>> | undefined;

/**
 * The pinned pi's builtin providers, read from the same `ModelRuntime` that runs broker logins,
 * so the broker never offers a login pi would refuse or hides one it accepts. Loaded once,
 * without credential files or model-catalog network.
 */
export function pinnedPiProviders(): Promise<ReadonlyMap<string, PinnedPiProvider>> {
  pinnedProviders ??= loadPinnedPiProviders().catch((error: unknown) => {
    pinnedProviders = undefined;
    throw error;
  });
  return pinnedProviders;
}

async function loadPinnedPiProviders(): Promise<ReadonlyMap<string, PinnedPiProvider>> {
  const runtime = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_providerId, fn) => fn(undefined),
      delete: async () => {},
    },
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const providers = new Map<string, PinnedPiProvider>();
  for (const provider of runtime.getProviders()) {
    const oauth = provider.auth?.oauth;
    providers.set(provider.id, {
      id: provider.id,
      name: provider.name,
      ...(oauth ? { oauth: { name: oauth.name, ...(oauth.loginLabel ? { loginLabel: oauth.loginLabel } : {}) } } : {}),
      apiKey: provider.auth?.apiKey !== undefined,
    });
  }
  return providers;
}

/** Credential provider ids for a model/package provider. Unknown ids default to themselves. */
export function credentialProvidersFor(providerId: string): readonly string[] {
  return MODEL_CREDENTIAL_DEPENDENCIES[providerId] ?? [providerId];
}

/** {@link brokerCapability} for a provider already looked up in {@link pinnedPiProviders}. */
export function capabilityOf(provider: PinnedPiProvider | undefined): BrokerCapability {
  const oauth = provider?.oauth !== undefined && BROKER_OAUTH_PROVIDER_SET.has(provider.id);
  const apiKey = provider?.apiKey ?? false;
  return { oauth, apiKey, supported: oauth || apiKey };
}

/**
 * What the broker can log this provider in as: OAuth when the pinned pi has a flow listed in
 * {@link BROKER_OAUTH_PROVIDERS}, an API key whenever pi accepts one. Ids pi does not ship —
 * package providers such as `claude-bridge` — are unsupported; their dependency is the
 * loginable one.
 */
export async function brokerCapability(providerId: string): Promise<BrokerCapability> {
  return capabilityOf((await pinnedPiProviders()).get(providerId));
}

function uniqueSorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Credential providers required for this model plus every installed package that declares
 * `credentialProviders`. Package specs are matched the same way {@link packagesInclude} matches
 * Claude Code packages in hostconfig: by leaf name, so `npm:pi-claude-agent-sdk@1.2.3` and
 * `npm:pi-claude-bridge` both count.
 */
export function resolveRequiredCredentialProviders(opts: {
  modelProvider: string;
  packages: readonly string[];
}): string[] {
  const ids: string[] = [...credentialProvidersFor(opts.modelProvider)];
  for (const entry of PACKAGE_PROVIDERS) {
    if (!packagesInclude(opts.packages, entry.package)) continue;
    if (!entry.credentialProviders) continue;
    ids.push(...entry.credentialProviders);
  }
  return uniqueSorted(ids);
}

/**
 * The pod's authorized credential-provider set: everything required for launch, plus any
 * stored account credentials that a selectable model would actually consume.
 *
 * Selectable ids are expanded through {@link credentialProvidersFor} before intersecting
 * account storage, so switching to `claude-bridge` leases `anthropic` rather than a
 * non-existent `claude-bridge` row.
 */
export function resolvePodCredentialContract(opts: {
  modelProvider: string;
  selectableProviders: readonly string[];
  packages: readonly string[];
  accountProviders: readonly string[];
}): string[] {
  const required = resolveRequiredCredentialProviders({
    modelProvider: opts.modelProvider,
    packages: opts.packages,
  });
  const account = new Set(opts.accountProviders);
  const selectableDeps: string[] = [];
  for (const providerId of opts.selectableProviders) {
    for (const dep of credentialProvidersFor(providerId)) {
      if (account.has(dep)) selectableDeps.push(dep);
    }
  }
  return uniqueSorted([...required, ...selectableDeps]);
}
