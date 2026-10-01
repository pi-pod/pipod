import { createHash } from "node:crypto";
import { PROVIDER_CREDENTIAL_VARS, loadProvider } from "../../core/providers/registry.js";
import type { SandboxProvider } from "../../core/providers/types.js";
import { HttpError } from "../httperrors.js";
import type { KekProvider } from "../secrets/crypto.js";
import { resolveProviderCredential } from "../secrets/store.js";
import type { ServerEnv } from "../env.js";
import { currentHostUrl, hostForPod, hostById, providerForHost, requireHostAwake, type PodHostIdentity } from "./hostidentity.js";

/** A launch says 400 (fix the request); an attach to an existing pod says 409. */
export class MissingCredentialError extends HttpError {
  constructor(
    public provider: string,
    hint: string,
  ) {
    super(400, `no ${provider} credential`, hint);
    this.name = "MissingCredentialError";
  }
}

/**
 * Provider adapters read their credential from process.env when they are built (the CLI's
 * contract, where one shell exports one key). Server-side the credential is per org (BYO key)
 * with the platform account as fallback, so construction is serialized under a lock while the
 * env var is swapped in.
 *
 * The lock covers exactly that: resolving the credential and building the adapter, which takes
 * the key onto itself and onto every sandbox handle it returns. The work — create, exec,
 * openPty, init scripts, image builds — runs outside, because none of it consults the
 * environment again. Anything held inside becomes queueing time for every other pod in the
 * process: a sandbox that takes half a minute to boot, or an image that takes minutes to
 * build, was making unrelated attaches wait past the point where their clients give up.
 */
let chain: Promise<unknown> = Promise.resolve();

/**
 * The platform's own provider keys, taken from the startup environment snapshot.
 *
 * Anything running outside the lock below must read platform credentials from here rather
 * than from `process.env`: while a provider call is in flight the lock has an organization's
 * BYO key installed under the same variable name, so a concurrent request that consults
 * `process.env` sees another org's custody and answers for the wrong provider.
 */
export function platformProviderEnv(env: ServerEnv): NodeJS.ProcessEnv {
  const snapshot: NodeJS.ProcessEnv = {};
  for (const envVar of Object.values(PROVIDER_CREDENTIAL_VARS)) {
    const value = env[envVar as keyof ServerEnv];
    if (typeof value === "string" && value.length > 0) snapshot[envVar] = value;
  }
  return snapshot;
}

/**
 * Immutable boot snapshot of the platform's provider credentials (env var -> key).
 *
 * Capture contract (cross-cutting, all roles): `main()` snapshots this ONCE from the parsed
 * `ServerEnv` BEFORE any provider overlay can exist, and every runtime caller threads it
 * explicitly (see `platformCredentialsOf`). Capacity/ledger helpers, sweeps, and any future
 * platform-token client MUST consume this same snapshot instead of copying ambient reads:
 * a `process.env` read taken while the credential lock below holds another org's BYO key
 * discloses that key to the wrong host and mis-attributes failures. Standalone operator CLIs
 * run in a fresh process with no overlay, so the ambient default remains safe for them.
 *
 * Capture timing: snapshot at server startup AFTER `loadEnv()` (never at module import),
 * so dotenv/`--env-file` values loaded before `main()` runs are included. An empty snapshot
 * is legal (pure-BYO deployments) — callers log its key names at boot and per-call misses
 * keep the existing `MissingCredentialError` semantics; emptiness is never silent.
 */
export type PlatformCredentialSnapshot = Readonly<Record<string, string>>;

/** Capture the boot snapshot. Pass the parsed startup env, never `process.env` mid-run. */
export function snapshotPlatformCredentials(env: ServerEnv): PlatformCredentialSnapshot {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(platformProviderEnv(env))) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return Object.freeze(out);
}

/** Provider key names present in a snapshot (never values) — safe for boot logging. */
export function describePlatformCredentials(snapshot: PlatformCredentialSnapshot): string {
  const names = Object.keys(snapshot).sort();
  return names.length > 0 ? names.join(", ") : "(none — BYO-only deployment)";
}

/**
 * The snapshot a deps-carrying caller must use: the threaded boot capture when present,
 * otherwise derived from the caller's immutable `ServerEnv` (equally overlay-proof, since
 * `ServerEnv` is parsed once at startup and never mutated by the lock). Never falls back
 * to `process.env`: that read is only safe in fresh CLI processes, which pass explicitly.
 */
export function platformCredentialsOf(deps: {
  env: ServerEnv;
  platformCredentials?: PlatformCredentialSnapshot;
}): PlatformCredentialSnapshot {
  return deps.platformCredentials ?? snapshotPlatformCredentials(deps.env);
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function withCredential<T>(args: {
  provider: string;
  credential: () => Promise<string | null>;
  providerConfig?: Record<string, unknown>;
  missingHint: string;
  fn: (provider: SandboxProvider, credentialScope: string) => Promise<T>;
}): Promise<T> {
  const envVar = PROVIDER_CREDENTIAL_VARS[args.provider];
  if (!envVar) return Promise.reject(new HttpError(400, `unknown provider "${args.provider}"`));
  // Decryption touches no shared state, so it stays off the lock's critical path.
  const built = args.credential().then((credential) => {
    if (!credential) throw new MissingCredentialError(args.provider, args.missingHint);
    const task = chain.then(async () => {
      const previous = process.env[envVar];
      process.env[envVar] = credential;
      try {
        return await loadProvider(args.provider, args.providerConfig ?? {});
      } finally {
        if (previous === undefined) delete process.env[envVar];
        else process.env[envVar] = previous;
      }
    });
    chain = task.catch(() => {});
    return task.then((provider) => ({ provider, credential }));
  });
  return built.then(({ provider, credential }) =>
    args.fn(
      provider,
      `sha256:${createHash("sha256")
        .update(args.provider)
        .update("\0")
        .update(canonicalJson(args.providerConfig ?? {}))
        .update("\0")
        .update(credential)
        .digest("hex")}`,
    ),
  );
}

export async function withProviderCredential<T>(args: {
  pod?: PodHostIdentity;
  sandboxHostId?: string | null;
  ownerUserId?: string;
  kek: KekProvider;
  orgId: string;
  provider: string;
  providerConfig?: Record<string, unknown>;
  /**
   * Boot snapshot of the platform credentials (see `snapshotPlatformCredentials`).
   * REQUIRED explicit input — server runtime callers pass `platformCredentialsOf(deps)`.
   * There is deliberately no ambient default: reading `process.env` here is only safe in
   * fresh CLI processes with no overlay in flight, and those pass `process.env` explicitly
   * so the choice is visible. A concurrent call inside another org's lock window would
   * otherwise resolve that org's BYO key as this org's platform fallback (cross-tenant
   * confusion). Required (not optional) so a future caller cannot silently reintroduce it.
   */
  platformEnv: PlatformCredentialSnapshot | NodeJS.ProcessEnv;
  fn: (provider: SandboxProvider, credentialScope: string) => Promise<T>;
}): Promise<T> {
  const envVar = PROVIDER_CREDENTIAL_VARS[args.provider];
  const platformEnv = args.platformEnv;
  let providerConfig = args.providerConfig;
  if (args.pod || args.sandboxHostId) {
    const host = args.pod ? await hostForPod(args.pod) : await hostById(args.sandboxHostId!);
    if (args.sandboxHostId && !host) throw new HttpError(409, "host registration is missing");
    if (host) {
      if (host.owner_user_id != null && host.owner_user_id !== (args.pod?.user_id ?? args.ownerUserId)) {
        throw new HttpError(409, "host custody mismatch");
      }
      requireHostAwake(host);
      if (host.auth_ciphertext !== null || host.owner_user_id !== null) {
        const built = providerForHost(host, args.kek, providerConfig ?? {}, platformEnv.PI_POD_SANDBOX_TOKEN ?? null);
        return args.fn(built.provider, built.credentialScope);
      }
      providerConfig = { ...providerConfig, url: currentHostUrl(host) };
    }
  }
  return withCredential({
    provider: args.provider,
    providerConfig,
    credential: () => resolveProviderCredential({
      kek: args.kek,
      orgId: args.orgId,
      provider: args.provider,
      platformEnv,
    }),
    missingHint: `store an org secret named ${envVar ?? "the provider key"} or configure the platform account`,
    fn: args.fn,
  });
}

/** Platform-only credential path used by best-effort rollout prewarming. */
export function withPlatformProviderCredential<T>(args: {
  provider: string;
  credential: string;
  providerConfig?: Record<string, unknown>;
  fn: (provider: SandboxProvider, credentialScope: string) => Promise<T>;
}): Promise<T> {
  return withCredential({
    provider: args.provider,
    providerConfig: args.providerConfig,
    credential: async () => args.credential,
    missingHint: "configure the platform provider credential",
    fn: args.fn,
  });
}
