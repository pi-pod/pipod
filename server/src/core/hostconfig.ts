/**
 * src/hostconfig.ts — §7.5: carrying selected parts of the host's `~/.pi` into the pod.
 *
 * Project-level pi config (`.pi/` in the repo) travels naturally via the clone. The host's
 * *home* directory does not, and that is the default: D1 says the pod starts from the pushed
 * state, and a pod that silently inherits whatever is on one laptop is no longer the same pod
 * a teammate gets from the same repo. Everything here is opt-in, per item, by name.
 *
 * Three properties hold this together, and each exists because of something real in a live
 * `~/.pi/agent`:
 *
 *  1. **Allowlist, never a directory copy.** That tree is ~2 GB on a working machine, and
 *     most of it is `sessions/` — transcripts from every *other* repo the user has worked in.
 *     Putting those on third-party pod disk is a larger exposure than `--copy-pi-auth`, for
 *     no benefit. Only the names below can travel, so a cache directory added by a future pi
 *     release cannot start leaking on its own.
 *  2. **`settings.json` is filtered, not uploaded.** It carries host-coupled keys (hooks that
 *     shell out to things only the laptop has) and a `packages` list that pi would install at
 *     every cold start.
 *  3. **The model choice is reconciled before the pod exists.** `defaultProvider` can point at
 *     a provider whose credential is not in `.pi-pod/env`, and egress derivation reads env var
 *     *names* — so an unchecked settings upload produces a pod whose model is unreachable and
 *     whose allowlist has no idea. That is the same failure `--copy-pi-auth` already contributes
 *     an endpoint to avoid (§11.1), arriving by a different door.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PI_AUTH_HOST } from "./egress.js";
import { PiPodError } from "./errors.js";
import {
  BUILTIN_REGISTRY,
  PACKAGE_PROVIDERS,
  hasOAuthFlow,
  packageForProvider,
  providerFacts,
  type ProviderRegistry,
} from "./piregistry.js";
import type { Sandbox } from "./providers/types.js";

/** Where pi keeps user-level state, under the host home directory. */
export const HOST_PI_AGENT_SUBPATH = path.join(".pi", "agent");

/** The same directory inside the pod. `--copy-pi-auth` writes `auth.json` here too (§7.4). */
export const POD_PI_AGENT_DIR = "/root/.pi/agent";

/**
 * Top-level files that may travel when `settings` is on.
 *
 * `models.json` rides along with `settings.json` because it is the other half of one choice:
 * custom model definitions are what `defaultModel` and `enabledModels` refer to, and uploading
 * the reference without the definition produces a pi that cannot start the model it is set to.
 *
 * `mcporter.json` is pi-mcporter's user-scope policy (call timeout, tool exposure). It is
 * the only pi-mcporter config a pod can use: the project-scope `.pi/mcporter.json` loads
 * only after the project is trusted, and trust is keyed by host paths that do not exist in
 * the pod (§7.5). Inert when pi-mcporter is not among the carried packages.
 *
 * Deliberately absent: `auth.json` (that is `--copy-pi-auth`, which acknowledges itself),
 * `trust.json` (keyed by host paths, which do not exist in the pod), `sessions/`,
 * `run-history.jsonl`, `models-store.json`, `npm/`, `bin/`, and every `hooks-*.log`.
 */
export const SETTINGS_FILES = ["settings.json", "models.json", "mcporter.json"] as const;

/**
 * `settings.json` keys stripped on the way in, because they describe the host rather than a
 * preference.
 *
 * A denylist rather than a keep-list, on the same forward-compatibility bargain unknown config
 * keys get (§4.1): a preference pi adds next release should travel without a launcher upgrade.
 * The cost is that a *new* host-coupled key would travel once, until it is named here.
 *
 * `deviceId` (pi 1.0) identifies the installation to OpenAI when it signs in with ChatGPT; pi
 * keeps it out of project settings so clones never share one, and a pod is its own installation.
 */
export const HOST_COUPLED_SETTINGS_KEYS = ["hooks", "mcpServers", "deviceId"] as const;

const ENV_REFERENCE = /^\$(?:[A-Z_][A-Z0-9_]*|\{[A-Z_][A-Z0-9_]*\})$/;
const CREDENTIAL_FIELD =
  /(?:^|[-_])(?:api[-_]?key|api[-_]?token|access[-_]?token|auth(?:orization)?|auth[-_]?token|bearer|client[-_]?secret|credentials?|password|secret|token)$/i;

/**
 * Dotted paths in a models.json tree whose values are literal credentials rather than
 * `$ENV_VAR` references. The predicate mirrors `sanitizeModelsForTransport` exactly: a
 * credential-named field (or any `*key`/`*token`/`*secret` under `headers`) holding anything
 * but an env reference. Pure — it reports paths, never values — so both the CLI and the
 * server can reject at their own boundary with their own error type.
 */
export function findLiteralModelCredentials(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const visit = (value: unknown, pathParts: string[], inHeaders = false): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathParts, String(index)], inHeaders));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const credentialField = CREDENTIAL_FIELD.test(key) || (inHeaders && /(?:key|token|secret)$/i.test(key));
      // A credential field that survives sanitization (an env reference) is fine; anything
      // else — literal, command substitution, or a nested object — would be silently dropped.
      if (credentialField && (typeof child !== "string" || !ENV_REFERENCE.test(child))) {
        paths.push([...pathParts, key].join("."));
        continue;
      }
      visit(child, [...pathParts, key], inHeaders || key === "headers");
    }
  };
  visit(input, []);
  return paths;
}

/** Env-var names whose literal values are worth refusing rather than carrying. */
const MCPORTABLE_SECRET_ENV = /(?:api[-_]?key|token|secret|password|passwd|auth|bearer|credential)/i;
/** Header names that carry credentials rather than metadata. */
const MCPORTABLE_SECRET_HEADER =
  /^(?:authorization|proxy-authorization|cookie|x-api-key|x-auth-token|.*(?:api[-_]?key|auth[-_]?token|client[-_]?secret|access[-_]?token))$/i;
/** userinfo (`https://user:pass@host`) or a credential query parameter in an endpoint URL. */
const CREDENTIAL_URL = /:\/\/[^/\s]*@|[?&](?:api[_-]?key|token|secret|auth)=/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Dotted paths in an mcporter.json tree that embed literal credentials. Narrow by design:
 * only `mcpServers.<server>.env` entries with secret-like names, `headers` entries with
 * credential-like names, and endpoint URLs with userinfo or credential query parameters.
 * Command args, scripts, and prompt text are NOT scanned — no pattern can reliably tell a
 * flag value from prose, and claiming otherwise would be a false promise (plan §8).
 */
export function findLiteralMcporterCredentials(input: unknown): string[] {
  const paths: string[] = [];
  if (!isRecord(input)) return paths;
  const servers = isRecord(input["mcpServers"]) ? (input["mcpServers"] as Record<string, unknown>) : null;
  if (!servers) return paths;
  for (const [serverName, server] of Object.entries(servers)) {
    if (!isRecord(server)) continue;
    const base = `mcpServers.${serverName}`;
    if (isRecord(server["env"])) {
      for (const [name, value] of Object.entries(server["env"] as Record<string, unknown>)) {
        if (
          typeof value === "string" &&
          value.trim() !== "" &&
          !ENV_REFERENCE.test(value) &&
          MCPORTABLE_SECRET_ENV.test(name)
        ) {
          paths.push(`${base}.env.${name}`);
        }
      }
    }
    if (isRecord(server["headers"])) {
      for (const [name, value] of Object.entries(server["headers"] as Record<string, unknown>)) {
        if (
          typeof value === "string" &&
          value.trim() !== "" &&
          !ENV_REFERENCE.test(value) &&
          MCPORTABLE_SECRET_HEADER.test(name)
        ) {
          paths.push(`${base}.headers.${name}`);
        }
      }
    }
    for (const key of ["url", "baseUrl", "endpoint"] as const) {
      const value = server[key];
      if (typeof value === "string" && CREDENTIAL_URL.test(value)) {
        paths.push(`${base}.${key}`);
      }
    }
  }
  return paths;
}

/** Strip literal/command model credentials before a settings file crosses a machine boundary. */
export function sanitizeModelsForTransport(
  input: Record<string, unknown>,
): { models: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  const visit = (value: unknown, pathParts: string[], inHeaders = false): unknown => {
    if (Array.isArray(value)) {
      return value.map((item, index) => visit(item, [...pathParts, String(index)], inHeaders));
    }
    if (value === null || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const credentialField = CREDENTIAL_FIELD.test(key) || (inHeaders && /(?:key|token|secret)$/i.test(key));
      if (credentialField && (typeof child !== "string" || !ENV_REFERENCE.test(child))) {
        dropped.push([...pathParts, key].join("."));
        continue;
      }
      result[key] = visit(child, [...pathParts, key], inHeaders || key === "headers");
    }
    return result;
  };
  return { models: visit(input, []) as Record<string, unknown>, dropped };
}

/**
 * Ceilings on what an allowlisted name can drag in. A skill directory is arbitrary user
 * content and an extension may have vendored its dependencies; either can be enormous, and
 * "the pod took four minutes to start" is a bad way to discover that.
 */
export const MAX_HOST_CONFIG_BYTES = 4 * 1024 * 1024;
export const MAX_HOST_CONFIG_FILES = 500;

/** Never worth carrying, and `.git` inside a skill would double its size. */
const SKIPPED_NAMES = new Set([".git", ".DS_Store"]);

export interface HostConfigSelection {
  /** Upload the filtered `settings.json` (+ `models.json` and `mcporter.json` when they exist). */
  settings: boolean;
  /**
   * Keep `settings.packages` — the extensions, skills and themes pi installs for itself.
   * On by default: carrying someone's settings without their extensions delivers a pi that
   * is configured for tools it does not have. Set false for a leaner cold start.
   */
  packages: boolean;
  /** Names under `~/.pi/agent/skills/`. */
  skills: string[];
  /** Names under `~/.pi/agent/extensions/` (a file or a directory). */
  extensions: string[];
}

export const DEFAULT_HOST_CONFIG: HostConfigSelection = {
  // On by default: the common case is one person running pods for their own repos, and a pi
  // that has forgotten their model, theme and extensions is a worse surprise than a pod that
  // is not byte-identical to a teammate's. Teams that want the stricter property set
  // `"settings": false` in the committed config; `--no-copy-pi-config` does it for one run.
  settings: true,
  // Only meaningful once `settings` is on, and then it is the answer people expect: the
  // extensions come with the settings that name them.
  packages: true,
  // Still empty, and still by name. These are the entries that can be arbitrarily large, and
  // "everything in the directory" is the one thing this design will not do (see above).
  skills: [],
  extensions: [],
};

/** Where `--copy-pi-auth` reads the host's pi OAuth credential from (§7.4). */
export function hostPiAuthPath(home: string): string {
  return path.join(home, HOST_PI_AGENT_SUBPATH, "auth.json");
}

/** The host home directory, or null when the environment does not say. */
export function hostHome(explicit?: string | undefined): string | null {
  return explicit ?? process.env["HOME"] ?? process.env["USERPROFILE"] ?? null;
}

export function hostConfigRequested(selection: HostConfigSelection): boolean {
  return (
    selection.settings || selection.skills.length > 0 || selection.extensions.length > 0
  );
}

/**
 * Just the package list, read cheaply and without throwing.
 *
 * The image tag carries a digest of this (§12), and the tag has to be settled *before*
 * preflight — it is what preflight validates. Full planning happens there and produces the
 * same list from the same file; this is the early peek that decides which image the session
 * is even about.
 *
 * Never throws: a malformed `settings.json` is a real error, but preflight is where it gets
 * reported with a path and a remedy. Failing here would surface it as an image problem.
 */
export function readHostPackages(selection: HostConfigSelection, home?: string | undefined): string[] {
  if (!selection.settings || !selection.packages) return [];
  const resolved = hostHome(home);
  if (!resolved) return [];
  return packagesIn(path.join(resolved, HOST_PI_AGENT_SUBPATH, "settings.json"));
}

/**
 * Extensions the *repo* declares — what `pi install -l` writes to `.pi/settings.json` (§7.5).
 *
 * Read from the working tree rather than left to the clone, because three separate things stop
 * a project extension reaching the pod on its own, and only this one is pi-pod's to fix:
 *
 *  1. `.pi/settings.json` is routinely untracked, so D1's "the pod clones the pushed state"
 *     means it does not travel at all. `pi install -l` today, `pi-pod` a minute later, and the
 *     pod has never heard of the package.
 *  2. Project packages install under `.pi/npm` in the clone, which pi guards behind
 *     `assertProjectTrustedForScope` — and `trust.json` is host-path-keyed, so it never travels
 *     either. Measured: in a fresh untrusted directory those packages are silently skipped.
 *  3. The image digest read only the host list, so nothing rebuilt.
 *
 * So these are carried at *user* scope in the pod instead: same packages, installed somewhere
 * that needs no trust decision pi-pod is not entitled to make on the user's behalf. A pod runs
 * exactly one repo, so the distinction that scope draws on a laptop — this project versus all
 * the others — has nothing to separate there.
 */
export function readProjectPackages(repoRoot: string): string[] {
  return packagesIn(path.join(repoRoot, ".pi", "settings.json"));
}

/** Raw contents of the project's bake script (`config.bakeScript`), "" when absent. */
export function readProjectBakeScript(repoRoot: string, relPath: string): string {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  } catch {
    return "";
  }
}

/** `packages` out of a pi settings file, tolerating absence and junk. */
function packagesIn(settingsPath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const packages = Array.isArray(parsed["packages"]) ? parsed["packages"] : [];
    return packages
      .map((entry) => (typeof entry === "string" ? entry : (entry as { source?: string })?.source))
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  } catch {
    // Absent is the common case, and malformed is preflight's to report with a path and a
    // remedy — surfacing it here would present it as an image problem.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Model reconciliation
// ---------------------------------------------------------------------------

export interface ModelPlan {
  /** `defaultProvider` from the filtered settings. */
  provider: string;
  /** `defaultModel`, when set — reported, never validated (pi owns the model list). */
  model: string | null;
  /** True when the provider registry (§7.7) knows this provider at all. */
  known: boolean;
  /** Env vars that would satisfy it; empty for an OAuth-only or unknown provider. */
  envKeys: string[];
  /** Endpoints this provider needs open, contributed to the allow set (§11.1). */
  endpoints: string[];
  /**
   * The host file this came from. Carried so the error can name it: the whole difficulty of
   * this failure is that it is caused by a file on the user's laptop, during a command they
   * ran in a repo, about a setting they very likely changed for unrelated reasons.
   */
  sourcePath: string;
}

export function planModel(
  settings: Record<string, unknown>,
  sourcePath: string,
  registry: ProviderRegistry = BUILTIN_REGISTRY,
): ModelPlan | null {
  const provider = typeof settings["defaultProvider"] === "string" ? settings["defaultProvider"] : null;
  if (!provider) return null;

  const model = typeof settings["defaultModel"] === "string" ? settings["defaultModel"] : null;
  const facts = providerFacts(registry, provider);

  return {
    provider,
    model,
    // Known now means "pi has this provider", not "an env var authenticates it". The two came
    // apart with `openai-codex`, which pi ships and which no env var authenticates at all —
    // under the old spelling it read as a provider pi-pod had never heard of.
    known: facts !== undefined,
    envKeys: facts?.envKeys ?? [],
    endpoints: facts?.endpoints ?? [],
    sourcePath,
  };
}

/**
 * Every provider this pod's pi can be switched to, not just the one it boots into.
 *
 * `defaultProvider` decides the first model; `enabledModels` decides the rest of the `Ctrl+P`
 * cycle, and a user who put three providers in that list means to use three providers. Deriving
 * reachability from the default alone produces a pod that works until the first model switch
 * and then fails with a network error — which is the same misreadable failure one step later.
 *
 * Entries are `provider/model`, sometimes with more slashes (`openrouter/moonshotai/kimi-k3`),
 * so the provider is the first segment and nothing else needs parsing.
 */
export function selectableProviders(settings: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (id: unknown) => {
    if (typeof id !== "string") return;
    const provider = id.split("/")[0]?.trim();
    if (provider && !out.includes(provider)) out.push(provider);
  };

  add(settings["defaultProvider"]);
  const enabled = settings["enabledModels"];
  if (Array.isArray(enabled)) for (const entry of enabled) add(entry);
  return out;
}

/**
 * Providers the env file *does* authenticate, best-first.
 *
 * The most useful thing an unusable-model error can say is which model would work, because
 * the mismatch is nearly always accidental — a host default changed for another project,
 * not a decision about this repo.
 */
export function credentialedProviders(
  envKeys: string[],
  registry: ProviderRegistry = BUILTIN_REGISTRY,
): Array<{ provider: string; envKey: string }> {
  const out: Array<{ provider: string; envKey: string }> = [];
  const seen = new Set<string>();
  for (const [provider, facts] of Object.entries(registry.providers)) {
    const envKey = facts.envKeys.find((k) => envKeys.includes(k));
    if (!envKey) continue;
    // Providers that share one key set (`opencode`/`opencode-go`) are one choice, not two;
    // naming both would be noise in an error that is trying to be short.
    const identity = facts.envKeys.join("\0");
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({ provider, envKey });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §7.4 — pods borrow access tokens; refresh tokens never leave the host
// ---------------------------------------------------------------------------

/**
 * The one rule that makes a copied `auth.json` safe: xAI, Anthropic, OpenAI and every
 * other OAuth provider here rotates its refresh token on use, so two environments holding
 * the same one are in a race — the first to refresh revokes the other. Measured in
 * practice: a pod refreshed the shared grant and *both* sides ended with
 * `invalid_grant: Refresh token has been revoked`, the failure this section exists to
 * prevent.
 *
 * So the host is the only refresher. The pod's copy of `auth.json` carries each OAuth
 * entry's access token and expiry and nothing else; a pod can *use* a credential but can
 * never rotate one. Fresh access tokens reach a running pod through the auth sync
 * (lifecycle) or, in account mode, through the server broker — which is the single
 * refresh authority there.
 *
 * An entry that does not parse or is not an object is carried untouched: pi owns the
 * format, and a sanitizer that dropped what it did not recognize would log pods out.
 */
export function sanitizePiAuthContents(contents: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return contents;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return contents;
  for (const entry of Object.values(parsed as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record["type"] === "oauth") delete record["refresh"];
  }
  return JSON.stringify(parsed, null, 2) + "\n";
}


/**
 * Providers whose host `auth.json` entry is OAuth — the set that needs a fresh access token
 * minted on the host before the sanitized copy travels. Values are never read; the `type`
 * field decides and nothing else.
 */
export function readPiAuthOAuthProviders(home: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(hostPiAuthPath(home), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, entry]) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
        return (entry as Record<string, unknown>)["type"] === "oauth";
      })
      .map(([provider]) => provider)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The model a `pi auth print-bearer-token` probe is asked about when the host's own settings
 * do not offer one for the provider. The subcommand requires `--model`, but the credential it
 * prints is per-provider, and pi resolves these ids fuzzily — any resolvable id answers the
 * same question. Known OAuth providers need an entry; anything else is skipped rather than
 * guessed at.
 */
export const PI_AUTH_PROBE_DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  "openai-codex": "gpt-5",
  xai: "grok-4.5",
  "google-gemini-cli": "gemini-2.5-pro",
  "kimi-coding": "kimi-for-coding",
  meta: "muse-spark-1.2",
};

/**
 * Which model to probe a provider with: the host's selected model when it belongs to the
 * provider (the answer most likely to resolve), else the table above, else null — unknown
 * providers are carried sanitized but unprobed.
 */
export function piAuthProbeModel(
  provider: string,
  hostModel: { provider: string; model: string } | null,
): string | null {
  if (hostModel && hostModel.provider === provider && hostModel.model) return hostModel.model;
  return PI_AUTH_PROBE_DEFAULT_MODELS[provider] ?? null;
}

/**
 * The exact command the host refresh probe runs: prints the provider's current credential,
 * refreshing and persisting through pi's normal
 * path when the stored token is inside the print command's minimum validity.
 */
export function piAuthPrintBearerCommand(provider: string, model: string): string {
  return `pi auth print-bearer-token --provider ${provider} --model ${model}`;
}

/**
 * Merge two `auth.json` files provider-by-provider: the remote (server) entries win — the
 * server is the refresh authority in account mode, so its copy of a shared provider is the
 * rotated, living one — while providers only the local file knows survive. That is what
 * lets a host pull the broker's rotated grant back down without losing a login the server
 * has never seen. Unparseable input on either side answers the remote unchanged: the
 * server's copy is the one custody guarantees.
 */
export function mergePiAuthContents(local: string, remote: string): string {
  let localParsed: unknown;
  let remoteParsed: unknown;
  try {
    localParsed = JSON.parse(local);
    remoteParsed = JSON.parse(remote);
  } catch {
    return remote;
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(localParsed) || !isObject(remoteParsed)) return remote;
  return JSON.stringify({ ...localParsed, ...remoteParsed }, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// §7.7 — what the carried auth.json already authenticates
// ---------------------------------------------------------------------------

/**
 * Provider ids with an entry in the host's `auth.json`, read without touching a single value.
 *
 * This is the generalization that replaces guessing. pi's own resolution order is `--api-key`
 * → `auth.json` → environment → `models.json`, and `auth.json` holds both OAuth tokens and
 * API keys stored by `/login`. So the question "will the pod be authenticated for provider X"
 * has a direct answer in a file pi-pod is already carrying — no table of which providers use
 * OAuth, and no staleness, because the file is the user's own current state.
 *
 * It is what makes `openai-codex` work: nothing in the environment authenticates it, its
 * credential is a subscription OAuth token under that key, and the old endpoint-shaped guess
 * could not see it.
 *
 * Values are never read, returned or logged — only the keys.
 */
export function readPiAuthProviders(home: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(hostPiAuthPath(home), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    // Absent is the common case; malformed is pi's problem to report, not a reason to refuse
    // a launch that may not need this file at all.
    return [];
  }
}

/**
 * Provider API keys exported in the host's own shell — the third step of pi's resolution order,
 * and the one pi-pod used to drop on the floor.
 *
 * On the host, `export OPENAI_API_KEY=…` in a shell profile is a completely ordinary way to
 * authenticate pi, and until now it did not survive the trip: the key had to be written a second
 * time into `.pi-pod/env` to reach the pod. So a pod would refuse to launch, or boot to a dead
 * model, for a provider the user considers configured. Carrying these closes the last gap
 * between "pi works here" and "pi works in the pod".
 *
 * The scope is deliberately narrow, and it is the narrowness that makes this safe to have on by
 * default:
 *
 *  - **Names pi itself recognizes as provider credentials, and nothing else.** The list comes
 *    from the registry (§7.7), so this is never "copy the environment" — an unrelated secret in
 *    the host shell (`STRIPE_SECRET_KEY`, an internal token) is not a provider key and does not
 *    travel. A blanket copy is the one thing this will not do at any setting.
 *  - **`.pi-pod/env` always wins.** That file is the committed, reviewable, per-repo contract;
 *    an ambient host value must not quietly override what the repo says.
 *  - **Never a pod-control credential through this path.** Names the provider adapter
 *    claims, and pi-pod's own reserved names, are excluded outright. The provider key does
 *    reach the pod — injected explicitly for the in-pod keepalive (§8) and labeled as pod
 *    control — but on its own grounds, never disguised as one model key among many.
 *  - **Announced by name every run**, and registered with the redactor, like every other secret.
 */
export interface HostEnvSelection {
  /** `NAME` → value. Never logged; registered with the redactor by the caller. */
  values: Record<string, string>;
  /** `NAME` → the provider it authenticates, for the finding. */
  providers: Record<string, string>;
}

export function collectHostProviderEnv(opts: {
  registry: ProviderRegistry;
  /** The host environment. A parameter so tests need no real one. */
  env: Record<string, string | undefined>;
  /** Names already set by `.pi-pod/env`, which outrank anything ambient. */
  envFileKeys: string[];
  /** Names that must never travel: provider credentials and pi-pod's own markers. */
  excluded: string[];
}): HostEnvSelection {
  const values: Record<string, string> = {};
  const providers: Record<string, string> = {};

  const fileKeys = new Set(opts.envFileKeys);
  const excluded = new Set(opts.excluded);

  for (const [provider, facts] of Object.entries(opts.registry.providers)) {
    for (const name of facts.envKeys) {
      if (fileKeys.has(name) || excluded.has(name) || Object.hasOwn(values, name)) continue;
      const value = opts.env[name];
      if (typeof value !== "string" || value.trim() === "") continue;
      values[name] = value;
      providers[name] = provider;
    }
  }

  return { values, providers };
}

export interface CredentialCheck {
  ok: boolean;
  level: "ok" | "warn" | "error";
  message: string;
  hint?: string;
}

/**
 * Does the pod have a credential for the model these settings select?
 *
 * The order below is pi's own resolution order (`auth.json` → environment), because a check
 * that answers in a different order than the thing it is checking will eventually disagree
 * with it. pi's rule is that "a stored credential owns the provider: ambient/env is consulted
 * only when nothing is stored", so `auth.json` is asked first here too.
 *
 * Hard failure only where the answer is certain: a provider pi ships, with no stored credential
 * and none of its env vars set. Everything else warns — a package-supplied provider may well be
 * authenticated by something pi-pod has never heard of, and aborting a working setup over that
 * would make the feature not worth having.
 */
export function checkModelCredentials(
  model: ModelPlan,
  ctx: {
    /** Names the pod will have in its environment: the env file plus carried host vars. */
    envKeys: string[];
    copyPiAuth: boolean;
    /** Provider ids with an entry in the `auth.json` being carried (§7.7). */
    piAuthProviders?: string[];
    /** Repo-relative env file path, so the remedy names the file the user actually edits. */
    envFile: string;
  },
): CredentialCheck {
  // "host" leads, because that is the fact the user is missing: this came from their laptop,
  // not from the repo they ran the command in.
  const label = `host pi settings select ${model.provider}${model.model ? `/${model.model}` : ""}`;

  // 1. auth.json — a stored credential owns the provider, exactly as in pi. Package providers
  // can declare that they authenticate through a different Pi provider (claude-bridge uses
  // anthropic), so use the same package metadata that launch dependency resolution consumes.
  const credentialProviders =
    PACKAGE_PROVIDERS.find((entry) => entry.providers.includes(model.provider))?.credentialProviders ??
    [model.provider];
  const stored =
    ctx.copyPiAuth && credentialProviders.some((provider) => (ctx.piAuthProviders ?? []).includes(provider));
  if (stored) {
    return { ok: true, level: "ok", message: `${label}, authenticated by your host pi login (auth.json)` };
  }

  // 2. Environment — the env file plus any host provider vars being carried (§7.7).
  const present = model.envKeys.filter((k) => ctx.envKeys.includes(k));
  if (present.length > 0) {
    return { ok: true, level: "ok", message: `${label}, authenticated by $${present[0]}` };
  }

  if (!model.known) {
    return {
      ok: true,
      level: "warn",
      message: `${label}, which pi-pod does not recognize — its credential and endpoint cannot be verified`,
      hint:
        "if it is supplied by a package, note that pi.hostConfig.packages is what carries that\n" +
        "package in, and its endpoint needs an entry in egress.allow",
    };
  }

  // A provider that came in with a package (§7.7). Known enough to name the key, but never a
  // hard failure: the package may store its credential somewhere pi-pod is not modelling, and
  // refusing the launch would take away a session that pi would have started — degraded, with
  // its other providers intact — over one entry in the model cycle.
  const supplier = packageForProvider(model.provider);
  if (supplier) {
    return {
      ok: true,
      level: "warn",
      message: `${label}, but nothing carries a credential for it — the pod would start unauthenticated for ${model.provider}`,
      hint:
        `${supplier} authenticates from $${model.envKeys[0]} or the ${credentialProviders.join("/")} entry in\n` +
        `the host's ~/.pi/agent/auth.json. Export the key on this host (it is carried in automatically), or\n` +
        `connect that Pi provider before launching.`,
    };
  }

  // A subscription provider with nothing stored. Warned rather than blocked, and pointed at
  // `/login` rather than at a key: for `openai-codex` there is no env var to name at all, and
  // for `github-copilot` the one that exists is not how anybody authenticates it — refusing a
  // launch with "add COPILOT_GITHUB_TOKEN" sends the user after a variable they will never
  // have. Blocking would also be wrong on its own terms: the credential may arrive by a route
  // pi-pod is not modelling.
  if (model.envKeys.length === 0 || hasOAuthFlow(model.provider)) {
    const alternative = model.envKeys[0]
      ? `\nAn API key in ${ctx.envFile} ($${model.envKeys[0]}) works too, where you have one.`
      : "";
    return {
      ok: true,
      level: "warn",
      message: `${label}, a subscription provider with no entry in your host auth.json — the pod would start unauthenticated`,
      hint:
        `run \`pi\` on this host and \`/login ${model.provider}\`; the credential is then carried in` +
        ` automatically.${alternative}`,
    };
  }

  return {
    ok: false,
    level: "error",
    message: `${label}, which nothing in ${ctx.envFile} authenticates — the pod would have no working model`,
    hint: unusableModelHint(model, ctx, model.endpoints.some((e) => e === PI_AUTH_HOST)),
  };
}

/**
 * The remedy list for a blocked launch.
 *
 * Longer than this codebase's usual hint, deliberately. This is the one error a user can hit
 * without having asked pi-pod for anything: host settings travel by default (§7.5), so the
 * trigger is a file on their laptop, the command was run in a repo, and the setting was very
 * likely changed weeks ago for an unrelated project. An error that only says "add a key"
 * leaves them looking for the key in the wrong file.
 *
 * Ordered by what the user most likely meant, not by what is easiest to describe: using the
 * model they already have credentials for comes first, because a mismatch here is nearly
 * always accidental rather than a decision about this repo.
 */
function unusableModelHint(
  model: ModelPlan,
  ctx: { envKeys: string[]; envFile: string },
  oauthCovers: boolean,
): string {
  const lines = [`The setting is "defaultProvider": "${model.provider}" in:`, `    ${model.sourcePath}`, ""];

  const available = credentialedProviders(ctx.envKeys);
  if (available.length > 0) {
    const list = available.map((a) => `${a.provider} ($${a.envKey})`).join(", ");
    lines.push(
      `${ctx.envFile} does have credentials for: ${list}.`,
      `If you meant to use one of those, change the default on this host — run \`pi\` and pick`,
      `the model, or edit "defaultProvider" in the file above.`,
      "",
    );
  }

  lines.push(
    `To use ${model.provider} in the pod instead, add its key:`,
    `    echo '${model.envKeys[0]}=…' >> ${ctx.envFile}`,
  );

  // Only worth suggesting where the OAuth credential would actually authenticate this
  // provider — telling an openai user to log in with pi would send them somewhere useless.
  if (oauthCovers) {
    lines.push(
      "",
      `Or log in on this host (\`pi\`, then /login) — ~/.pi/agent/auth.json is carried in`,
      `automatically once it exists.`,
    );
  }

  lines.push(
    "",
    "To launch without your host settings at all:",
    "    pi-pod --no-copy-pi-config          (this run)",
    '    "pi": { "hostConfig": { "settings": false } }   (this repo, committed)',
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Settings filtering
// ---------------------------------------------------------------------------

export interface FilteredSettings {
  settings: Record<string, unknown>;
  /** Keys removed, for the preflight finding — a silent strip is a surprise later. */
  dropped: string[];
}

export function filterSettings(
  raw: string,
  sourcePath: string,
  opts: { packages: boolean },
): FilteredSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PiPodError(`${sourcePath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, {
      hint: 'fix it, or set "pi": { "hostConfig": { "settings": false } }',
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PiPodError(`${sourcePath} is not a JSON object`);
  }

  const settings = { ...(parsed as Record<string, unknown>) };
  const dropped: string[] = [];

  for (const key of HOST_COUPLED_SETTINGS_KEYS) {
    if (Object.hasOwn(settings, key)) {
      delete settings[key];
      dropped.push(key);
    }
  }

  // `packages` is pi's own extension manifest, and it is the *only* input to installation:
  // pi resolves each entry at startup and runs `npm install <spec> --prefix ~/.pi/agent/npm`
  // for anything missing, non-interactively, with no trust gate at user scope. So the pod
  // needs nothing but this list — never `npm/node_modules` (337 MB on a working machine),
  // and not `npm/package.json` either, which npm writes as a side effect of those installs
  // and pi otherwise creates empty. Carrying that manifest without this list installs
  // nothing; carrying a stale one would install packages the settings no longer name.
  //
  // The cost is real and lands at cold start: every entry is an install before pi is usable,
  // over the allowlist (registry.npmjs.org must be in egress.allow, §11.1). `packages: false` trades
  // the extensions for the startup time.
  if (!opts.packages && Object.hasOwn(settings, "packages")) {
    delete settings["packages"];
    dropped.push("packages");
  }

  return { settings, dropped };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface HostConfigUpload {
  /** Absolute path inside the pod. */
  podPath: string;
  contents: Uint8Array;
  mode: number;
  /** Host path it came from, for `--dry-run` and `--verbose`. */
  source: string;
}

export interface HostConfigPlan {
  /** False when nothing was selected — the default, and the fast path. */
  requested: boolean;
  /**
   * `settings.packages` as carried, in pi's `npm:`/`git:` source spelling. Empty when the
   * settings do not travel or declare none. Drives both the extra egress hosts those installs
   * need and the pre-install that keeps a failure from killing the session (§7.5).
   */
  packages: string[];
  uploads: HostConfigUpload[];
  totalBytes: number;
  /** `settings.json` keys stripped on the way in. */
  droppedKeys: string[];
  /** What the filtered settings point pi at, when they say. */
  model: ModelPlan | null;
  /**
   * Every provider the carried settings let pi select — `defaultProvider` plus `enabledModels`
   * (§7.7). The allow set is derived from this rather than from {@link model} alone, because a
   * model the user can reach with `Ctrl+P` is a model they mean to use.
   */
  providers: string[];
  /** Non-fatal findings: a name that does not exist, a symlink skipped. */
  warnings: string[];
  /** One line per selected item, for the plan printout. */
  items: string[];
}

export const EMPTY_HOST_CONFIG_PLAN: HostConfigPlan = {
  requested: false,
  packages: [],
  uploads: [],
  totalBytes: 0,
  droppedKeys: [],
  model: null,
  providers: [],
  warnings: [],
  items: [],
};

/**
 * Resolve the selection against the host's `~/.pi/agent`, on the host, before a pod exists.
 *
 * Missing names warn rather than fail: `.pi-pod/config.json` is committed, so a skill list in
 * it is a statement about the team's machines, and one developer not having installed a skill
 * yet is not a reason their session cannot start.
 */
export function planHostConfig(opts: {
  selection: HostConfigSelection;
  /** Host home directory. Defaults to $HOME; a parameter so tests need no real one. */
  home?: string | undefined;
  /** Provider facts, so the model reconciliation below tracks pi rather than a table (§7.7). */
  registry?: ProviderRegistry;
  /**
   * Extensions the repo itself declares (`pi install -l`). Carried whatever the host selection
   * says: they belong to the repo rather than to this laptop, so `--no-copy-pi-config` — which
   * is about leaving *your* setup behind — has no business dropping them.
   */
  projectPackages?: string[];
}): HostConfigPlan {
  const { selection } = opts;
  const projectPackages = opts.projectPackages ?? [];
  if (!hostConfigRequested(selection) && projectPackages.length === 0) {
    return EMPTY_HOST_CONFIG_PLAN;
  }

  // Not an error even though the selection asked for something: carrying host config is the
  // default now, and a machine with no discoverable home (a bare container, some CI runners)
  // must still be able to launch a pod. The caller reports it and moves on.
  const home = hostHome(opts.home);
  if (!home) {
    return {
      ...EMPTY_HOST_CONFIG_PLAN,
      requested: true,
      warnings: ["no host home directory ($HOME) — nothing to carry from it"],
    };
  }

  const agentDir = path.join(home, HOST_PI_AGENT_SUBPATH);
  const uploads: HostConfigUpload[] = [];
  const warnings: string[] = [];
  const items: string[] = [];
  let droppedKeys: string[] = [];
  let packages: string[] = [];
  let model: ModelPlan | null = null;
  let providers: string[] = [];

  if (!fs.existsSync(agentDir) && projectPackages.length === 0) {
    warnings.push(`${agentDir} does not exist — nothing to carry from the host`);
    return { ...EMPTY_HOST_CONFIG_PLAN, requested: true, warnings };
  }

  if (selection.settings && fs.existsSync(agentDir)) {
    const settingsPath = path.join(agentDir, "settings.json");
    if (fs.existsSync(settingsPath)) {
      const filtered = filterSettings(
        fs.readFileSync(settingsPath, "utf8"),
        settingsPath,
        { packages: selection.packages },
      );
      droppedKeys = filtered.dropped;
      packages = (Array.isArray(filtered.settings["packages"]) ? filtered.settings["packages"] : [])
        .map((entry) => (typeof entry === "string" ? entry : (entry as { source?: string })?.source))
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
      model = planModel(filtered.settings, settingsPath, opts.registry ?? BUILTIN_REGISTRY);
      providers = selectableProviders(filtered.settings);
      uploads.push({
        podPath: `${POD_PI_AGENT_DIR}/settings.json`,
        contents: Buffer.from(`${JSON.stringify(filtered.settings, null, 2)}\n`, "utf8"),
        mode: 0o600,
        source: settingsPath,
      });
      items.push(
        `settings.json${filtered.dropped.length ? ` (dropped: ${filtered.dropped.join(", ")})` : ""}`,
      );
    } else {
      warnings.push(`${settingsPath} not found — no host settings to carry`);
    }

    // Verbatim: it is a definition file pi wrote, and there is nothing host-coupled in it.
    const modelsPath = path.join(agentDir, "models.json");
    if (fs.existsSync(modelsPath)) {
      uploads.push({
        podPath: `${POD_PI_AGENT_DIR}/models.json`,
        contents: fs.readFileSync(modelsPath),
        mode: 0o600,
        source: modelsPath,
      });
      items.push("models.json");
    }

    // Verbatim too, but carried because of trust rather than despite it. pi-mcporter reads
    // its project policy (`.pi/mcporter.json`) only for a trusted project, and trust does
    // not travel (§7.5), so in a pod this user-scope file is the extension's entire policy:
    // without it every MCP call gets pi-mcporter's 30s default timeout. It holds no
    // credentials — those live in MCPorter's own config — so there is nothing to filter,
    // and without pi-mcporter among the packages it is inert.
    const mcporterPath = path.join(agentDir, "mcporter.json");
    if (fs.existsSync(mcporterPath)) {
      uploads.push({
        podPath: `${POD_PI_AGENT_DIR}/mcporter.json`,
        contents: fs.readFileSync(mcporterPath),
        mode: 0o600,
        source: mcporterPath,
      });
      items.push("mcporter.json");
    }
  }

  for (const [kind, names] of [
    ["skills", selection.skills],
    ["extensions", selection.extensions],
  ] as const) {
    for (const name of names) {
      const problem = validateName(name);
      if (problem) {
        throw new PiPodError(`pi.hostConfig.${kind}: ${problem}`, {
          hint: `entries name a single item directly under ~/.pi/agent/${kind}/`,
        });
      }

      const source = path.join(agentDir, kind, name);
      // lstat, not existsSync: the latter follows symlinks, so a link pointing somewhere that
      // does not exist would report as "not installed" — the one answer that is not true, and
      // the one that hides what the entry actually is.
      const stat = statOrNull(source);
      if (!stat) {
        warnings.push(`${kind}/${name} is not installed on this host — skipped`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        warnings.push(`${kind}/${name} is a symlink — skipped (its target could be anywhere)`);
        continue;
      }

      const before = uploads.length;
      collect(source, `${POD_PI_AGENT_DIR}/${kind}/${name}`, uploads, warnings, `${kind}/${name}`);
      const fileCount = uploads.length - before;
      items.push(`${kind}/${name}${fileCount > 1 ? ` (${fileCount} files)` : ""}`);
    }
  }

  // The repo's own extensions ride in the same file. pi would otherwise resolve them at
  // *project* scope, under `.pi/npm` in the clone, which it will not touch until the project
  // is trusted — and trust does not travel. User scope needs no such decision, and a pod runs
  // one repo, so there is nothing for the distinction to separate.
  const merged = [...new Set([...packages, ...projectPackages])];
  let plan: HostConfigPlan = {
    requested: true,
    packages: merged,
    uploads,
    totalBytes: 0,
    droppedKeys,
    model,
    providers,
    warnings,
    items,
  };
  if (merged.length !== packages.length || (merged.length > 0 && uploads.length === 0)) {
    plan = withPackages(plan, merged);
    const added = projectPackages.filter((p) => !packages.includes(p));
    if (added.length > 0) items.push(`.pi/settings.json packages (${added.length})`);
  }

  const totalBytes = plan.uploads.reduce((sum, u) => sum + u.contents.byteLength, 0);
  enforceCeilings(plan.uploads, totalBytes);

  return { ...plan, totalBytes };
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/** A name, not a path: `..` and separators would reach outside the allowlisted directory. */
function validateName(name: string): string | null {
  if (name.trim() === "") return "empty entry";
  if (name !== path.basename(name) || name === "." || name === "..") {
    return `"${name}" must be a bare name, not a path`;
  }
  return null;
}

function collect(
  source: string,
  podPath: string,
  uploads: HostConfigUpload[],
  warnings: string[],
  label: string,
): void {
  const stat = fs.lstatSync(source);

  if (stat.isSymbolicLink()) {
    warnings.push(`${label}: skipped symlink ${path.basename(source)}`);
    return;
  }

  if (stat.isFile()) {
    uploads.push({
      podPath,
      contents: fs.readFileSync(source),
      // Preserve the executable bit — a skill's helper script is useless without it — but
      // nothing wider than the owner: this is one user's config in a single-user pod.
      mode: stat.mode & 0o100 ? 0o700 : 0o600,
      source,
    });
    return;
  }

  if (!stat.isDirectory()) {
    warnings.push(`${label}: skipped ${path.basename(source)} (not a regular file)`);
    return;
  }

  for (const entry of fs.readdirSync(source).sort()) {
    if (SKIPPED_NAMES.has(entry)) continue;
    collect(path.join(source, entry), `${podPath}/${entry}`, uploads, warnings, label);
  }
}

function enforceCeilings(uploads: HostConfigUpload[], totalBytes: number): void {
  if (uploads.length > MAX_HOST_CONFIG_FILES) {
    throw new PiPodError(
      `pi.hostConfig selects ${uploads.length} files, over the ${MAX_HOST_CONFIG_FILES} limit`,
      { hint: heaviestHint(uploads) },
    );
  }
  if (totalBytes > MAX_HOST_CONFIG_BYTES) {
    throw new PiPodError(
      `pi.hostConfig selects ${formatBytes(totalBytes)}, over the ${formatBytes(MAX_HOST_CONFIG_BYTES)} limit`,
      { hint: heaviestHint(uploads) },
    );
  }
}

/** Naming the offender matters: the limit is nearly always one vendored dependency tree. */
function heaviestHint(uploads: HostConfigUpload[]): string {
  const byItem = new Map<string, number>();
  for (const u of uploads) {
    const key = u.podPath.slice(POD_PI_AGENT_DIR.length + 1).split("/").slice(0, 2).join("/");
    byItem.set(key, (byItem.get(key) ?? 0) + u.contents.byteLength);
  }
  const heaviest = [...byItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    `largest: ${heaviest.map(([k, bytes]) => `${k} (${formatBytes(bytes)})`).join(", ")}\n` +
    "drop it from pi.hostConfig, or bake it into the base image with `pi-pod image build` —\n" +
    "an asset every session needs belongs in the image, not in a per-session upload"
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Where pi keeps user-scope packages, and the command it installs them with.
 *
 * Both mirror pi 0.82.0 (`getNpmInstallRoot`, `getNpmInstallArgs`). Drift is survivable rather
 * than dangerous: if pi changes either, our pre-install lands somewhere pi ignores, pi installs
 * at startup as it does today, and the only thing lost is the safety net below.
 */
const POD_NPM_ROOT = `${POD_PI_AGENT_DIR}/npm`;

/** `npm:@scope/pkg@1.2.3` → `@scope/pkg@1.2.3`. Non-npm sources are pi's to handle. */
export function npmSpecOf(source: string): string | null {
  return source.startsWith("npm:") ? source.slice("npm:".length) : null;
}

/** `@scope/pkg@1.2.3` → `@scope/pkg`; `pkg@1` → `pkg`. The directory npm installs it into. */
export function npmPackageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** One launch-resolved package identity: the exact install the pod actually runs. */
export interface ResolvedInstalledPackage {
  name: string;
  version: string;
  source: string;
}

/**
 * Resolve the exact installed versions of the npm-sourced `settings.packages` entries, from
 * the pod's own install root. This is the code channel's attestation input: the client must
 * never re-resolve specs itself (version skew; dependency confusion), so the launch-time
 * truth is captured here and persisted on the pod row. Failure yields an empty set — the
 * client fails closed to data-only sync.
 */
export async function resolveInstalledPackages(
  sandbox: Sandbox,
  sources: string[],
): Promise<ResolvedInstalledPackage[]> {
  const npmSources = sources.filter((source) => npmSpecOf(source) !== null);
  if (npmSources.length === 0) return [];
  try {
    // npm ls exits non-zero for peer-dep complaints but still prints the JSON tree.
    const res = await sandbox.exec(
      ["sh", "-c", `npm ls --prefix ${POD_NPM_ROOT} --json --depth=0 2>/dev/null || true`],
      { timeoutMs: 120_000 },
    );
    const parsed = JSON.parse(res.output?.trim() || "{}") as {
      dependencies?: Record<string, { version?: unknown }>;
    };
    const deps = parsed.dependencies ?? {};
    const resolved: ResolvedInstalledPackage[] = [];
    for (const source of npmSources) {
      const name = npmPackageName(npmSpecOf(source)!);
      const version = deps[name]?.version;
      if (typeof version === "string" && version.length > 0) resolved.push({ name, version, source });
    }
    return resolved;
  } catch {
    return [];
  }
}

/**
 * Which of these packages are not already in the pod.
 *
 * The image bakes the host's package set (§12), so on a matching image every one of them is
 * present before the pod boots and there is nothing to install. Asking first turns that case
 * from a registry round-trip into one `test -d` per package, and leaves the install path for
 * what it is actually for: the delta after someone adds an extension without rebuilding.
 */
export async function missingPackages(sandbox: Sandbox, packages: string[]): Promise<string[]> {
  const specs = packages.filter((p) => npmSpecOf(p) !== null);
  if (specs.length === 0) return [];

  const dirs = specs.map((p) => `${POD_NPM_ROOT}/node_modules/${npmPackageName(npmSpecOf(p)!)}`);
  // One shell invocation rather than one exec per package: each exec is a provider round-trip,
  // and ten of those costs more than the install it is trying to avoid.
  const script = dirs.map((d, i) => `[ -d '${d}' ] || echo ${i}`).join("; ");
  const res = await sandbox.exec(["sh", "-c", script], { timeoutMs: 60_000 });
  if (res.exitCode !== 0) return packages;

  const missing = new Set(
    (res.output ?? "")
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isInteger(n)),
  );
  return specs.filter((_, i) => missing.has(i));
}

/**
 * Install the carried extensions *before* pi starts, so that a failure is ours to handle.
 *
 * pi installs `settings.packages` itself on first run, which is how this worked originally —
 * but an install that exits non-zero takes the pi process down with it, and the session ends
 * before the user reaches a prompt. That turns any transient registry hiccup, any package
 * needing a host the allowlist does not have, and any native module without a prebuild for
 * this platform into "the pod is broken" rather than "one extension is missing".
 *
 * Doing it here inverts that. The install runs where a non-zero exit is a value we can read,
 * and on failure the package list is dropped from the settings we upload — so pi starts,
 * without extensions, and says why. A degraded session beats no session.
 *
 * Returns the packages that should stay in `settings.json`.
 */
export async function installHostPackages(
  sandbox: Sandbox,
  packages: string[],
  ctx: { timeoutMs?: number; onOutput?: (chunk: Uint8Array) => void } = {},
): Promise<{ installed: string[]; failed: boolean; output: string; skipped: boolean }> {
  // Everything already baked into the image is the fast path, and the common one.
  const outstanding = await missingPackages(sandbox, packages);
  if (outstanding.length === 0) {
    return { installed: packages, failed: false, output: "", skipped: true };
  }

  const specs = outstanding.map(npmSpecOf).filter((s): s is string => s !== null);
  if (specs.length === 0) return { installed: packages, failed: false, output: "", skipped: true };

  await sandbox.exec(["mkdir", "-p", POD_NPM_ROOT], { timeoutMs: 60_000 });

  // One batch rather than one call per package: ten sequential installs is minutes of cold
  // start, and npm resolves a shared dependency tree once. The cost is that the batch is
  // all-or-nothing — which is why failure degrades to "no extensions" rather than guessing
  // which entry was at fault.
  const res = await sandbox.exec(
    ["npm", "install", ...specs, "--prefix", POD_NPM_ROOT, "--legacy-peer-deps"],
    {
      timeoutMs: ctx.timeoutMs ?? 10 * 60 * 1000,
      ...(ctx.onOutput ? { onStdout: ctx.onOutput, onStderr: ctx.onOutput } : {}),
    },
  );

  const output = res.output ?? "";
  if (res.exitCode === 0) return { installed: packages, failed: false, output, skipped: false };

  // Non-npm sources (git:, local paths) were never ours to install; leaving them in lets pi
  // try them itself. It is the npm batch that failed, and only that is dropped.
  // Packages the image already had are still fine; only the ones we just failed to fetch are
  // dropped, so a bad *new* extension does not cost the user the ones that were working.
  const failed = new Set(outstanding);
  return {
    installed: packages.filter((p) => npmSpecOf(p) === null || !failed.has(p)),
    failed: true,
    output,
    skipped: false,
  };
}

/**
 * Does a `settings.packages` entry name this client extension?
 *
 * `pi.clientExtensions` entries are bare npm package names (or paths, which never match a
 * package spec); the settings list uses pi's `npm:`/`git:` source spelling with optional
 * version suffixes, so `npm:pi-compact-transcript@1.2.3` matches `pi-compact-transcript`.
 */
export function packageSpecNamesClientExtension(spec: string, name: string): boolean {
  if (spec === name) return true;
  const npmSpec = npmSpecOf(spec);
  return npmSpec !== null && npmPackageName(npmSpec) === name;
}

/**
 * Drop the packages that will run client-side from the settings uploaded to the pod (§RPC-UI
 * client extensions). A listed extension runs in the launcher *instead of* the pod — never in
 * both — so its pod-side install is subtracted here. The image recipe is untouched: packages
 * stay baked into the image (harmless, pi loads only what settings name), so toggling
 * `pi.clientExtensions` never forces a rebuild.
 */
export function subtractClientExtensions(
  plan: HostConfigPlan,
  clientExtensions: string[],
): { plan: HostConfigPlan; removed: string[] } {
  if (clientExtensions.length === 0 || plan.packages.length === 0) return { plan, removed: [] };
  const removed = plan.packages.filter((spec) =>
    clientExtensions.some((name) => packageSpecNamesClientExtension(spec, name)),
  );
  if (removed.length === 0) return { plan, removed };
  const remaining = plan.packages.filter((spec) => !removed.includes(spec));
  return { plan: withPackages(plan, remaining), removed };
}

/** Rewrite the uploaded `settings.json` with a different package list. */
export function withPackages(plan: HostConfigPlan, packages: string[]): HostConfigPlan {
  const target = `${POD_PI_AGENT_DIR}/settings.json`;
  const render = (settings: Record<string, unknown>): Uint8Array => {
    if (packages.length > 0) settings["packages"] = packages;
    else delete settings["packages"];
    return Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
  };

  const existing = plan.uploads.find((u) => u.podPath === target);
  if (!existing) {
    // No host settings are travelling — `--no-copy-pi-config`, or a machine with no `~/.pi`.
    // The repo's own extensions still have to be declared somewhere for pi to install them,
    // so this is the whole file: a package list and nothing else.
    if (packages.length === 0) return { ...plan, packages };
    return {
      ...plan,
      packages,
      uploads: [
        ...plan.uploads,
        { podPath: target, contents: render({}), mode: 0o600, source: "(repo .pi/settings.json)" },
      ],
    };
  }

  const uploads = plan.uploads.map((upload) =>
    upload.podPath === target
      ? {
          ...upload,
          contents: render(
            JSON.parse(Buffer.from(upload.contents).toString("utf8")) as Record<string, unknown>,
          ),
        }
      : upload,
  );
  return { ...plan, packages, uploads };
}

/**
 * Write the planned files into the pod, before init and before pi starts.
 *
 * These land in `/root/.pi/agent`, while the repo's own `.pi/` arrives in the clone — two
 * different directories, so pi's own precedence resolves them and the project keeps the last
 * word without pi-pod arbitrating.
 */
export async function uploadHostConfig(sandbox: Sandbox, plan: HostConfigPlan): Promise<void> {
  if (plan.uploads.length === 0) return;

  const dirs = [...new Set(plan.uploads.map((u) => u.podPath.slice(0, u.podPath.lastIndexOf("/"))))];
  await sandbox.exec(["mkdir", "-p", ...dirs.sort()], { timeoutMs: 60_000 });

  for (const upload of plan.uploads) {
    await sandbox.uploadFile(upload.podPath, upload.contents, upload.mode);
  }
}
