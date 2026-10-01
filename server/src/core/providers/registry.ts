/**
 * src/providers/registry.ts — name → adapter map (§3.1).
 *
 * A hardcoded map in v1. Out-of-package plugin loading (`pi-pod-provider-<name>`) is a
 * future extension (§16), deliberately not a v1 feature: one registry entry is the whole
 * surface a new adapter has to touch.
 *
 * The adapter modules are imported lazily so that `pi-pod doctor` on a machine with a broken
 * provider SDK still reports something useful instead of failing at import time.
 */
import { PiPodError } from "../errors.js";
import { PROVIDER_META } from "./meta.js";
import type { SandboxProvider } from "./types.js";

export type ProviderLoader = () => Promise<(config: Record<string, unknown>) => SandboxProvider>;

const REGISTRY: Record<string, ProviderLoader> = {
  sandbox: async () => (await import("./sandbox.js")).createSandboxProvider,
  // Co-located pods: real construction happens in server wiring, which injects the
  // host-machine resolver; this entry exists so the name is a known provider everywhere
  // (deniedProviders validation, listings) and selecting it without placement fails loudly.
  host: async () => (await import("./host.js")).createUnresolvedHostProvider,
};

/**
 * Host env var holding each provider's credential.
 *
 * Derived from {@link PROVIDER_META}, the SDK-free declaration shared by adapters and
 * server credential custody. Host pods use their parent machine's transport, not a key.
 */
export const PROVIDER_CREDENTIAL_VARS: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_META).map(([name, meta]) => [name, meta.credentialEnv]),
);

/** Native sandbox is the default; host requires explicit co-located placement. */
export const DEFAULT_PROVIDER = "sandbox";

export function supportedProviders(): string[] {
  // Default first, then the rest alphabetically — listings and init's no-key fallback
  // both read from this order.
  const names = Object.keys(REGISTRY);
  return [
    DEFAULT_PROVIDER,
    ...names.filter((name) => name !== DEFAULT_PROVIDER).sort(),
  ].filter((name, i, all) => all.indexOf(name) === i && Object.hasOwn(REGISTRY, name));
}

export function isSupportedProvider(name: string): boolean {
  return Object.hasOwn(REGISTRY, name);
}

export async function loadProvider(
  name: string,
  providerConfig: Record<string, unknown> = {},
): Promise<SandboxProvider> {
  const loader = REGISTRY[name];
  if (!loader) {
    throw new PiPodError(`unknown provider "${name}"`, {
      hint: `supported providers: ${supportedProviders().join(", ")}`,
    });
  }
  const factory = await loader();
  return factory(providerConfig);
}

/** Test seam: lets the FakeProvider integration suite (§14) drive the real lifecycle. */
export function registerProvider(name: string, loader: ProviderLoader): void {
  REGISTRY[name] = loader;
}

export function unregisterProvider(name: string): void {
  delete REGISTRY[name];
}
