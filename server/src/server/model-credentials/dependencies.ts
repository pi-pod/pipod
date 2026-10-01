/**
 * src/server/model-credentials/dependencies.ts — which credentials a pod actually needs.
 *
 * Model provider ids are not always credential provider ids. `claude-bridge` authenticates
 * through Pi's `anthropic` entry; installing `pi-claude-agent-sdk` (or the legacy
 * `pi-claude-bridge`) needs that same Anthropic grant even when the selected model is
 * something else, because the package exposes tools like AskClaude.
 *
 * Broker login is narrower still: only the pinned Pi builtins in {@link BROKER_OAUTH_PROVIDERS}
 * have an OAuth flow the control plane will run, and `claude-bridge` itself is not loginable.
 */
import {
  BUILTIN_REGISTRY,
  PACKAGE_PROVIDERS,
  packagesInclude,
  providerFacts,
} from "../../core/piregistry.js";

export const MODEL_CREDENTIAL_DEPENDENCIES: Record<string, readonly string[]> = {
  "claude-bridge": ["anthropic"],
};

/** The pi builtins whose OAuth login the server's pinned pi supports. */
export const BROKER_OAUTH_PROVIDERS = [
  "anthropic",
  "github-copilot",
  "kimi-coding",
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

/** Credential provider ids for a model/package provider. Unknown ids default to themselves. */
export function credentialProvidersFor(providerId: string): readonly string[] {
  return MODEL_CREDENTIAL_DEPENDENCIES[providerId] ?? [providerId];
}

/**
 * What the broker can log this provider in as.
 *
 * OAuth is allowlisted — not every Pi OAuth host is one the control plane will drive.
 * API-key login follows the builtin registry's env keys; package-only ids such as
 * `claude-bridge` therefore come back unsupported (their dependency is the loginable one).
 */
export function brokerCapability(providerId: string): BrokerCapability {
  const oauth = BROKER_OAUTH_PROVIDER_SET.has(providerId);
  const facts = providerFacts(BUILTIN_REGISTRY, providerId);
  const apiKey = (facts?.envKeys.length ?? 0) > 0;
  return { oauth, apiKey, supported: oauth || apiKey };
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
