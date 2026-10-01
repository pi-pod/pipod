/**
 * src/piregistry.ts — where pi-pod learns what pi's providers are (§7.7).
 *
 * Three facts about a pi provider decide whether a pod can use it: which env vars authenticate
 * it, which endpoints it talks to, and whether the credential we are carrying covers it. All
 * three used to be hardcoded here, and a hardcoded copy of someone else's list is wrong in one
 * direction only — it goes stale. Measured against pi 0.82.0, the static table was missing
 * seventeen providers outright (`openai-codex`, `github-copilot`, `zai`, the `xiaomi-*` and
 * `qwen-*` families, …), had `together` pointed at the wrong hostname, and listed two providers
 * (`cohere`, `perplexity`) that pi does not have. Every one of those is a session that either
 * gets refused with a wrong explanation or boots into a firewall.
 *
 * pi already publishes all of it. `@earendil-works/pi-ai` exports `getBuiltinProviders()`,
 * `getBuiltinModels(id)` — whose models carry the `baseUrl` the allow set needs — and
 * `findEnvKeys(id, env)`. So when the host has pi installed, that is the source, and the list
 * updates when pi updates without anyone editing this file.
 *
 * The fallback is not optional, though: pi-pod's whole premise is that pi lives in the *image*
 * and the host is only a terminal (§1). A CI runner or a fresh laptop can legitimately have no
 * pi at all, and a launcher that could only work on machines already running the thing it
 * launches would be a strange tool. So a static table survives below as the fallback, and
 * preflight says which source produced the answer.
 *
 * What is *not* derivable is noted at {@link OAUTH_REFRESH_HOSTS}.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { debug } from "./log.js";

/** What pi-pod needs to know about one provider. */
export interface ProviderFacts {
  /** Env var names that authenticate it, best-first. Empty for OAuth-only providers. */
  envKeys: string[];
  /** Hostnames it talks to — inference plus, for OAuth providers, token refresh. */
  endpoints: string[];
}

export interface ProviderRegistry {
  /** Named in findings, because "pi-pod does not recognize this" means different things. */
  source: "host pi" | "built-in";
  providers: Record<string, ProviderFacts>;
}

/**
 * OAuth token-refresh hosts, which pi does not publish declaratively.
 *
 * `getBuiltinModels()` gives inference endpoints, because a model has a `baseUrl`. The refresh
 * endpoint lives inside each OAuth flow implementation as a constant, so there is nothing to
 * enumerate. It is also the host that gets forgotten: it is usually on a *different domain*
 * from the inference host, and a stored access token is typically stale by the time a pod
 * boots — which makes the refresh the pod's first request, not a rare one. An allow set that
 * covers only inference therefore looks complete and fails immediately.
 *
 * Short, and slow-moving: a provider adds an OAuth flow once. Verified against pi 0.82.0
 * (`pi-ai/dist/auth/oauth/`).
 */
export const OAUTH_REFRESH_HOSTS: Record<string, string[]> = {
  "openai-codex": ["auth.openai.com"],
  anthropic: ["console.anthropic.com"],
  "github-copilot": ["github.com", "api.github.com"],
  openrouter: ["openrouter.ai"],
  xai: ["auth.x.ai"],
  "kimi-coding": ["api.kimi.com"],
};

/**
 * The fallback table, used when the host has no pi to ask.
 *
 * A snapshot of pi 0.82.0 rather than a hand-curated list — the point is to be wrong in the
 * same way pi is, not in a way of our own. Regenerate it from a host that has pi with
 * `npm run lint`, which reports drift when it can reach one.
 */
export const BUILTIN_PROVIDERS: Record<string, ProviderFacts> = {
  "amazon-bedrock": { envKeys: [], endpoints: ["bedrock-runtime.us-east-1.amazonaws.com", "bedrock-runtime.eu-central-1.amazonaws.com"] },
  "ant-ling": { envKeys: ["ANT_LING_API_KEY"], endpoints: ["api.ant-ling.com"] },
  anthropic: { envKeys: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], endpoints: ["api.anthropic.com"] },
  "azure-openai-responses": { envKeys: ["AZURE_OPENAI_API_KEY"], endpoints: [] },
  baseten: { envKeys: ["BASETEN_API_KEY"], endpoints: ["inference.baseten.co"] },
  cerebras: { envKeys: ["CEREBRAS_API_KEY"], endpoints: ["api.cerebras.ai"] },
  "cloudflare-ai-gateway": { envKeys: ["CLOUDFLARE_API_KEY"], endpoints: ["gateway.ai.cloudflare.com"] },
  "cloudflare-workers-ai": { envKeys: ["CLOUDFLARE_API_KEY"], endpoints: ["api.cloudflare.com"] },
  deepseek: { envKeys: ["DEEPSEEK_API_KEY"], endpoints: ["api.deepseek.com"] },
  fireworks: { envKeys: ["FIREWORKS_API_KEY"], endpoints: ["api.fireworks.ai"] },
  "github-copilot": { envKeys: ["COPILOT_GITHUB_TOKEN"], endpoints: ["api.individual.githubcopilot.com"] },
  google: { envKeys: ["GEMINI_API_KEY"], endpoints: ["generativelanguage.googleapis.com"] },
  "google-vertex": { envKeys: ["GOOGLE_CLOUD_API_KEY"], endpoints: [] },
  groq: { envKeys: ["GROQ_API_KEY"], endpoints: ["api.groq.com"] },
  huggingface: { envKeys: ["HF_TOKEN"], endpoints: ["router.huggingface.co"] },
  "kimi-coding": { envKeys: ["KIMI_API_KEY"], endpoints: ["api.kimi.com"] },
  minimax: { envKeys: ["MINIMAX_API_KEY"], endpoints: ["api.minimax.io"] },
  "minimax-cn": { envKeys: ["MINIMAX_CN_API_KEY"], endpoints: ["api.minimaxi.com"] },
  mistral: { envKeys: ["MISTRAL_API_KEY"], endpoints: ["api.mistral.ai"] },
  moonshotai: { envKeys: ["MOONSHOT_API_KEY"], endpoints: ["api.moonshot.ai"] },
  "moonshotai-cn": { envKeys: ["MOONSHOT_API_KEY"], endpoints: ["api.moonshot.cn"] },
  nvidia: { envKeys: ["NVIDIA_API_KEY"], endpoints: ["integrate.api.nvidia.com"] },
  openai: { envKeys: ["OPENAI_API_KEY"], endpoints: ["api.openai.com"] },
  "openai-codex": { envKeys: [], endpoints: ["chatgpt.com"] },
  opencode: { envKeys: ["OPENCODE_API_KEY"], endpoints: ["opencode.ai"] },
  "opencode-go": { envKeys: ["OPENCODE_API_KEY"], endpoints: ["opencode.ai"] },
  openrouter: { envKeys: ["OPENROUTER_API_KEY"], endpoints: ["openrouter.ai"] },
  "qwen-token-plan": { envKeys: ["QWEN_TOKEN_PLAN_API_KEY"], endpoints: ["token-plan.ap-southeast-1.maas.aliyuncs.com"] },
  "qwen-token-plan-cn": { envKeys: ["QWEN_TOKEN_PLAN_CN_API_KEY"], endpoints: ["token-plan.cn-beijing.maas.aliyuncs.com"] },
  together: { envKeys: ["TOGETHER_API_KEY"], endpoints: ["api.together.ai"] },
  "vercel-ai-gateway": { envKeys: ["AI_GATEWAY_API_KEY"], endpoints: ["ai-gateway.vercel.sh"] },
  xai: { envKeys: ["XAI_API_KEY"], endpoints: ["api.x.ai"] },
  xiaomi: { envKeys: ["XIAOMI_API_KEY"], endpoints: ["api.xiaomimimo.com"] },
  "xiaomi-token-plan-ams": { envKeys: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], endpoints: ["token-plan-ams.xiaomimimo.com"] },
  "xiaomi-token-plan-cn": { envKeys: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"], endpoints: ["token-plan-cn.xiaomimimo.com"] },
  "xiaomi-token-plan-sgp": { envKeys: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"], endpoints: ["token-plan-sgp.xiaomimimo.com"] },
  zai: { envKeys: ["ZAI_API_KEY"], endpoints: ["api.z.ai"] },
  "zai-coding-cn": { envKeys: ["ZAI_CODING_CN_API_KEY"], endpoints: ["open.bigmodel.cn"] },
};

// ---------------------------------------------------------------------------
// §7.7 — providers that arrive with a package rather than with pi
// ---------------------------------------------------------------------------

/**
 * What an extension package adds to pi's provider list.
 *
 * `getBuiltinProviders()` answers for pi, and pi only. A provider registered by an extension
 * — `pi.registerProvider("cursor", …)` inside `pi-cursor-sdk`, `"claude-bridge"` inside
 * `pi-claude-bridge` — is invisible to it by construction, because the registration happens at
 * runtime inside a pi that is not running. Everything keyed on the registry therefore stopped
 * at the package boundary, and all of it in the same direction: the env var that authenticates
 * the provider was not a name pi-pod recognized, so it did not travel; the endpoint was not one
 * it knew, so nothing warned it was blocked; and the credential check fell through to "pi-pod
 * does not recognize this provider". Measured in a live pod: `cursor` reached the pod with no
 * `CURSOR_API_KEY` in its environment and `cursor.com` refused by the allowlist, and pi
 * answered `Cursor SDK runs require a Cursor SDK API key` — which reads as a login problem on
 * the host, where the key is in fact exported and working.
 *
 * A declared table, and it has to be one: the alternative is executing a third-party extension
 * in the launcher process to see what it registers. The cost of declaring is the usual one —
 * it goes stale — but it is bounded here in a way {@link BUILTIN_PROVIDERS} is not. This lists
 * only packages pi-pod already has to know about by name (the Claude bridge was hardcoded in
 * `hostconfig.ts` before this table existed), and a package that is missing from it degrades
 * to exactly the behaviour of today rather than to something worse.
 *
 * Entries apply **only when the package is actually going into the pod** (§7.6's rule,
 * generalized): the package list pi-pod is already computing for the image is the gate, so a
 * machine that has never installed `pi-cursor-sdk` neither carries its key nor opens its host.
 */
export interface PackageProvider {
  /** npm package name, as `settings.packages` spells it minus source and version. */
  package: string;
  /** Provider ids this package registers with pi. */
  providers: string[];
  /**
   * Credential provider ids this package needs even when they are not the selected model.
   * The Claude bridge registers `claude-bridge` but authenticates through Pi's `anthropic` entry.
   */
  credentialProviders?: string[];
  facts: ProviderFacts;
}

export const PACKAGE_PROVIDERS: PackageProvider[] = [
  {
    package: "pi-claude-agent-sdk",
    providers: ["claude-bridge"],
    credentialProviders: ["anthropic"],
    // The maintained Agent SDK provider resolves Anthropic credentials through Pi before
    // every child process. Include both inference and subscription OAuth hosts so a saved
    // Pi login remains usable under an allowlist.
    facts: { envKeys: ["ANTHROPIC_API_KEY"], endpoints: ["api.anthropic.com", "platform.claude.com"] },
  },
  {
    // Legacy package name retained for existing machine settings.
    package: "pi-claude-bridge",
    providers: ["claude-bridge"],
    credentialProviders: ["anthropic"],
    facts: { envKeys: ["ANTHROPIC_API_KEY"], endpoints: ["api.anthropic.com", "platform.claude.com"] },
  },
  {
    package: "pi-meta-oauth",
    providers: ["meta"],
    // Device login and daily model-key minting use separate Meta hosts.
    facts: { envKeys: [], endpoints: ["api.meta.ai", "auth.meta.com"] },
  },
  {
    package: "pi-cursor-sdk",
    providers: ["cursor"],
    // `CURSOR_API_KEY`, or the same key stored under `cursor` in pi's `auth.json` by
    // `/login`. Both routes are covered without a special case: the env var by the table
    // below, the stored credential by the `auth.json` key scan (§7.7), which reads entries by
    // name and so has never cared whether pi or a package owns the provider.
    //
    // Three hosts, and `api2.cursor.sh` is the one that matters — a *different domain* from
    // the `cursor.com` the extension declares as its `baseUrl`. That is where `@cursor/sdk`
    // exchanges the API key and runs its RPC, so an allow set holding only the declared base
    // URL looks complete and fails on the first turn. It is the same trap the OAuth refresh
    // hosts are documented for, one layer further out; measured in a pod that had the key,
    // had `cursor.com` open, and died with `Failed to connect to API key exchange endpoint`.
    facts: {
      envKeys: ["CURSOR_API_KEY"],
      endpoints: ["api2.cursor.sh", "api.cursor.com", "cursor.com"],
    },
  },
];

/**
 * `npm:pi-cursor-sdk@1.2.3` → `pi-cursor-sdk`; `git:github.com/x/pi-claude-agent-sdk` → the same.
 *
 * The package *name* is the only stable part of a spec, which is why matching is by leaf.
 */
export function packageLeafName(spec: string): string {
  const withoutSource = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
  const withoutVersion = withoutSource.replace(/@[^@/]*$/, "");
  // The `#ref` a git spec may end with is not part of the name; everything before the last
  // separator is an org, a host, or both, and none of it identifies the package.
  return withoutVersion.replace(/#.*$/, "").split("/").pop() ?? "";
}

/** Does this list of package specs contain `name`? */
export function packagesInclude(specs: readonly string[], name: string): boolean {
  return specs.some((spec) => packageLeafName(spec) === name);
}

/**
 * The registry, plus whatever the packages going into this pod register.
 *
 * Applied *over* the source table rather than into it: a package that shadows a provider pi
 * already ships would be a pi problem to resolve at runtime, and pi-pod guessing at the winner
 * would only add a second answer. Builtins therefore win here, and the table above adds names
 * pi does not have.
 */
export function withPackageProviders(registry: ProviderRegistry, packages: readonly string[]): ProviderRegistry {
  const additions: Record<string, ProviderFacts> = {};
  for (const entry of PACKAGE_PROVIDERS) {
    if (!packagesInclude(packages, entry.package)) continue;
    for (const id of entry.providers) {
      if (Object.hasOwn(registry.providers, id)) continue;
      additions[id] = entry.facts;
    }
  }
  if (Object.keys(additions).length === 0) return registry;
  return { source: registry.source, providers: { ...registry.providers, ...additions } };
}

/** The package that supplies a provider id, when one does. Named in findings. */
export function packageForProvider(provider: string): string | undefined {
  return PACKAGE_PROVIDERS.find((e) => e.providers.includes(provider))?.package;
}

/**
 * `gemini` is pi-pod's own alias, kept because `.pi-pod/config.json` files in the wild use it
 * and pi resolves it to `google`. Aliases are ours, not pi's, so they are applied over whatever
 * source produced the table rather than living in it.
 */
const PROVIDER_ALIASES: Record<string, string> = { gemini: "google" };

export const BUILTIN_REGISTRY: ProviderRegistry = {
  source: "built-in",
  providers: withDerived(BUILTIN_PROVIDERS),
};

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Does pi ship an interactive login for this provider?
 *
 * The distinction that decides whether a missing credential is a *block* or a *warning*. For
 * `groq`, no key means no key: the remedy is one line in the env file and refusing is right.
 * For `github-copilot` the env var exists but is not how anyone authenticates it — the remedy
 * is `/login`, and refusing the launch with "add COPILOT_GITHUB_TOKEN" would send the user
 * after a variable they will never have.
 */
export function hasOAuthFlow(provider: string): boolean {
  return Object.hasOwn(OAUTH_REFRESH_HOSTS, PROVIDER_ALIASES[provider] ?? provider);
}

export function providerFacts(registry: ProviderRegistry, provider: string): ProviderFacts | undefined {
  return registry.providers[PROVIDER_ALIASES[provider] ?? provider] ?? registry.providers[provider];
}

/**
 * Which endpoint a given env var is normally used against. **Advisory only** — see
 * `PROVIDER_ENDPOINT_HINTS` in egress.ts for why nothing here reaches the allow set.
 *
 * First provider wins where two share a key (`OPENCODE_API_KEY`, `MOONSHOT_API_KEY`): the check
 * exists to name one line to add, and listing every claimant would make it noise.
 */
export function endpointForEnvKey(registry: ProviderRegistry, envKey: string): string | undefined {
  for (const facts of Object.values(registry.providers)) {
    if (facts.envKeys.includes(envKey) && facts.endpoints[0]) return facts.endpoints[0];
  }
  return undefined;
}

/** Every env var name the registry knows, for `doctor` and drift checks. */
export function knownEnvKeys(registry: ProviderRegistry): string[] {
  return [...new Set(Object.values(registry.providers).flatMap((f) => f.envKeys))].sort();
}

// ---------------------------------------------------------------------------
// Loading from the host's pi
// ---------------------------------------------------------------------------

let cached: Promise<ProviderRegistry> | null = null;

/**
 * The registry for this run: the host's pi when it can be reached, the built-in table otherwise.
 *
 * Cached for the process. Never throws and never blocks a launch — a host without pi, a pi laid
 * out somewhere unfamiliar, and a pi whose exports have moved all land on the fallback with a
 * debug line, because none of them is a reason a pod cannot start.
 */
export function loadProviderRegistry(opts: { piPath?: string | undefined } = {}): Promise<ProviderRegistry> {
  cached ??= loadUncached(opts);
  return cached;
}

/** Tests run several hosts in one process. */
export function resetProviderRegistry(): void {
  cached = null;
}

async function loadUncached(opts: { piPath?: string | undefined }): Promise<ProviderRegistry> {
  const dir = piAiDir(opts.piPath);
  if (!dir) {
    debug("no @earendil-works/pi-ai beside the host's pi — using the built-in provider table");
    return BUILTIN_REGISTRY;
  }

  try {
    // Importing the user's own pi, in the launcher process. The same trust as reading their
    // settings.json and running their `pi`: these two modules are provider *data*, and pi-pod
    // is already about to execute far more of this machine's pi inside the pod.
    const all = (await import(pathToUrl(path.join(dir, "dist", "providers", "all.js")))) as {
      getBuiltinProviders(): string[];
      getBuiltinModels(id: string): Array<{ baseUrl?: string }>;
    };
    const envKeysModule = (await import(pathToUrl(path.join(dir, "dist", "env-api-keys.js")))) as {
      findEnvKeys(provider: string, env?: unknown): string[] | undefined;
    };

    // `findEnvKeys` filters to vars that are actually *set*, so a real environment would answer
    // "which of these do you have" when the question is "which of these exist". An env that is
    // truthy for every name turns it back into the full list.
    const everyVarSet = new Proxy(
      {},
      { get: (_t, key) => (typeof key === "string" ? "1" : undefined), has: () => true },
    );

    const providers: Record<string, ProviderFacts> = {};
    for (const id of all.getBuiltinProviders()) {
      providers[id] = {
        envKeys: envKeysModule.findEnvKeys(id, everyVarSet) ?? [],
        endpoints: hostnamesOf(all.getBuiltinModels(id).map((m) => m.baseUrl)),
      };
    }

    if (Object.keys(providers).length === 0) throw new Error("pi-ai reported no providers");
    debug(`provider table from the host's pi: ${Object.keys(providers).length} providers (${dir})`);
    return { source: "host pi", providers: withDerived(providers) };
  } catch (e) {
    debug(`could not read the host's pi provider table (${e instanceof Error ? e.message : String(e)}) — using the built-in one`);
    return BUILTIN_REGISTRY;
  }
}

/** Fold in what pi does not publish, for either source. */
function withDerived(providers: Record<string, ProviderFacts>): Record<string, ProviderFacts> {
  const out: Record<string, ProviderFacts> = {};
  for (const [id, facts] of Object.entries(providers)) {
    const refresh = OAUTH_REFRESH_HOSTS[id] ?? [];
    out[id] = { envKeys: facts.envKeys, endpoints: [...new Set([...facts.endpoints, ...refresh])] };
  }
  // An OAuth provider the source has never heard of still needs its refresh host named.
  for (const [id, refresh] of Object.entries(OAUTH_REFRESH_HOSTS)) {
    out[id] ??= { envKeys: [], endpoints: [...refresh] };
  }
  return out;
}

/**
 * Base URLs are templates as often as not (`{location}-aiplatform.googleapis.com`), and a
 * template in the allow set is a hostname that matches nothing. Dropped rather than guessed at.
 */
function hostnamesOf(baseUrls: Array<string | undefined>): string[] {
  const hosts = new Set<string>();
  for (const url of baseUrls) {
    if (!url) continue;
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host && !host.includes("{") && !host.includes("*")) hosts.add(host);
    } catch {
      /* not a URL — nothing to contribute */
    }
  }
  return [...hosts];
}

/**
 * `@earendil-works/pi-ai` beside the host's `pi`, or null.
 *
 * Resolved from the binary rather than from pi-pod's own `node_modules`, because pi-pod does not
 * depend on pi and must not start. Both install layouts are checked at every ancestor: nested
 * (`<pkg>/node_modules/@earendil-works/pi-ai`, which is what Homebrew and a plain `npm i -g`
 * produce) and hoisted (`<node_modules>/@earendil-works/pi-ai`).
 */
export function piAiDir(piPath?: string | undefined): string | null {
  const bin = piPath ?? whichPi();
  if (!bin) return null;

  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(bin));
  } catch {
    return null;
  }

  const REL = path.join("@earendil-works", "pi-ai");
  for (let i = 0; i < 12; i++) {
    for (const candidate of [
      path.join(dir, "node_modules", REL),
      ...(path.basename(dir) === "node_modules" ? [path.join(dir, REL)] : []),
    ]) {
      if (fs.existsSync(path.join(candidate, "dist", "providers", "all.js"))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function whichPi(): string | null {
  try {
    const out = execFileSync("sh", ["-c", "command -v pi"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return out === "" ? null : out;
  } catch {
    // No pi on PATH — the normal case on a machine that only ever launches pods.
    return null;
  }
}

/** `import()` of an absolute path needs a URL on Windows, and tolerates one everywhere. */
function pathToUrl(absolute: string): string {
  return new URL(`file://${absolute.startsWith("/") ? "" : "/"}${absolute.split(path.sep).join("/")}`).href;
}
