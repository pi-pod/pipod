/**
 * src/providers/meta.ts — one table used by the registry (credential custody,
 * pre-load error hints) and each adapter (injection env names, keepalive credentialEnvName,
 * dashboard URLs in auth errors). A static registry copy used to drift from adapters'
 * declarations and keeping them in step was a unit test's job — the table is the declaration.
 * SDK-free on purpose (D4).
 */

export interface ProviderMeta {
  /** Host env var holding this provider's credential (§7.3). */
  credentialEnv: string;
  /** Where a key is created, for the error that fires before any adapter could load. */
  dashboardUrl: string;
}

export const PROVIDER_META = {
  sandbox: {
    credentialEnv: "PI_POD_SANDBOX_TOKEN",
    dashboardUrl: "https://github.com/pi-pod/pipod/tree/main/sandbox#readme",
  },
} as const satisfies Record<string, ProviderMeta>;

export type BuiltinProviderName = keyof typeof PROVIDER_META;
