import { PROVIDER_META } from "./meta.js";

export const PROVIDER_CREDENTIAL_VARS: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_META).map(([name, meta]) => [name, meta.credentialEnv]),
);

/**
 * Credential names stay reserved after an adapter is retired. Otherwise an old project env
 * can silently turn a former control-plane key into an ordinary secret injected into a pod.
 */
export const RETIRED_PROVIDER_CREDENTIAL_VARS = ["BOX_API_KEY", "E2B_API_KEY", "DAYTONA_API_KEY"] as const;

const providerCredentialVars = new Set<string>([
  ...Object.values(PROVIDER_CREDENTIAL_VARS),
  ...RETIRED_PROVIDER_CREDENTIAL_VARS,
]);

export function isProviderCredentialVar(name: string): boolean {
  return providerCredentialVars.has(name);
}

export const DEFAULT_PROVIDER = "sandbox";

export function supportedProviders(): string[] {
  const names = Object.keys(PROVIDER_META);
  return [DEFAULT_PROVIDER, ...names.filter((name) => name !== DEFAULT_PROVIDER).sort()];
}

export function isSupportedProvider(name: string): boolean {
  return Object.hasOwn(PROVIDER_META, name);
}
