/**
 * src/egress.ts — D5 / §11.1.
 *
 * The allow set lives in `.pi-pod/config.json` as `egress.allow`: a plain, committed,
 * reviewable list of hostnames. This file validates that list, adds the few hosts that
 * cannot be written down ahead of time, and maps the result onto what the provider can
 * actually enforce.
 *
 * What it deliberately does *not* do any more is decide what belongs in the allow set. That
 * used to be derived here from a table of env-var-name → endpoint, which made the effective
 * policy invisible: a credential the table did not know about produced a pod where the model
 * simply never answered, with nothing in the config to point at and no way to fix it short of
 * patching this file. The table survives below as {@link PROVIDER_ENDPOINT_HINTS}, demoted to
 * the one thing it is good at — telling you which line to add — with no authority over the
 * policy itself.
 */
import * as dns from "node:dns/promises";
import { aggregateIpv4, prefixLength } from "./cidr.js";
import { PiPodError } from "./errors.js";
import {
  BUILTIN_REGISTRY,
  PACKAGE_PROVIDERS,
  endpointForEnvKey,
  type ProviderRegistry,
} from "./piregistry.js";
import type { EgressAddressFamily, EgressEnforcement, EgressPolicy } from "./providers/types.js";
import type { EgressConfig } from "./config.js";

/**
 * Which endpoint a given credential is normally used against. **Advisory only.**
 *
 * Read by preflight to turn a silent failure into a specific instruction: carrying
 * `OPENROUTER_API_KEY` without `openrouter.ai` in the allow set is almost certainly a
 * mistake, and the useful thing to say is which line to add. Nothing here reaches the allow
 * set — a hint that quietly opened a host would be exactly the hidden derivation this module
 * was rewritten to remove.
 *
 * A key that is absent from this table is not suspicious, it is merely unknown: the check is
 * a convenience, and `egress.allow` remains the whole of the policy.
 */
/**
 * Model-provider keys are **not** listed here: those come from pi itself (§7.7, see
 * `piregistry.ts`), so the answer tracks whatever pi supports rather than whatever this file
 * was last edited to believe. What remains is the handful of credentials that are pi-pod's
 * own business and that pi has never heard of.
 */
export const PIPOD_ENDPOINT_HINTS: Record<string, string> = {
  GH_TOKEN: "github.com",
  GITHUB_TOKEN: "github.com",
  GIT_TOKEN: "github.com",
};

/**
 * What `--copy-pi-auth` credentials actually talk to (§7.4).
 *
 * Advisory, like the table above. The flag uploads `auth.json` rather than setting an env
 * var, so nothing keyed on env var names would ever notice it — and handing pi a credential
 * whose endpoint the allowlist blocks looks like a broken model rather than a firewall.
 */
export const PI_AUTH_HOST = "api.anthropic.com";

/** Anthropic hosts required by the maintained Claude Agent SDK package family. */
export const CLAUDE_AUTH_HOSTS: readonly string[] =
  PACKAGE_PROVIDERS.find((entry) => entry.package === "pi-claude-agent-sdk")?.facts.endpoints ?? [];

/**
 * Env vars whose *value* is a base URL: the host is taken from the value itself.
 *
 * One of the two things that cannot live in the committed default (§4.1). The env file is
 * gitignored and per-developer, so a self-hosted gateway or corporate proxy is known only at
 * preflight — writing it into `config.json` would either leak one developer's infrastructure
 * into the repo or block everyone else's.
 */
export const BASE_URL_KEYS = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "AZURE_OPENAI_ENDPOINT",
  "PI_BASE_URL",
];

export interface RepoDerivationInput {
  /** Env var names present in the env file — values are never needed here. */
  envKeys: string[];
  /** Values only for the BASE_URL_KEYS, whose host is part of the policy. */
  baseUrlValues?: Record<string, string>;
  /**
   * Endpoints of the providers the *host's* pi settings let this pod select (§7.5, §7.7).
   *
   * The third thing a committed file cannot state, and the last one still missing. `.pi-pod/`
   * is reviewed by a team; `~/.pi/agent/settings.json` is one developer's model choice, changed
   * for another project weeks ago, and it is what decides which endpoint the pod's pi will dial.
   * An allow set written when the repo used Anthropic does not know that this laptop now boots
   * into `openai-codex` — and pi-pod carries that laptop's credential in by default, so the pod
   * comes up authenticated for a provider it cannot reach.
   *
   * Measured in a live pod: `chatgpt.com` and `auth.openai.com` refused, and pi answered
   * `Error: fetch failed`, four times, then gave up. Nothing in that says "firewall"; it reads
   * as a bad token, and the credential is the one thing that was fine.
   *
   * Deliberately narrow. Only providers the carried settings actually name — never every key in
   * the environment, which would open a host per credential the user happens to have exported.
   * Each entry names its provider in {@link DerivedHost.reason}, so `doctor` and `--dry-run`
   * print who asked for it, and `"builtins": false` declines all of it as it always has.
   */
  providerEndpoints?: Array<{ provider: string; endpoints: string[] }>;
  /**
   * The pod provider's own control-plane host (§8).
   *
   * The in-pod keepalive dials it to vouch for running work; an allow set without it turns
   * the keepalive into a silent no-op. Derived rather than configured because it is a fact
   * about this machine's provider settings (`apiUrl` or an equivalent provider URL), not
   * something a committed list can know.
   */
  podProviderApi?: { name: string; host: string } | null;
}

export interface DerivedHost {
  host: string;
  /** Why this host is in the allow set — printed by `doctor` and `--verbose`. */
  reason: string;
}

/**
 * The only hosts still derived rather than configured (§11.1).
 *
 * All are facts about *this machine* rather than defaults: a base URL comes out of a
 * gitignored file, and the provider pi will dial comes out of a home directory the project has
 * never seen. Everything a static list can express belongs in `egress.allow` instead, where it
 * can be read and reviewed.
 */
export function deriveRepoHosts(input: RepoDerivationInput): DerivedHost[] {
  const out: DerivedHost[] = [];
  const seen = new Set<string>();
  const add = (host: string, reason: string) => {
    const normalized = host.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ host: normalized, reason });
  };

  if (input.podProviderApi) {
    add(input.podProviderApi.host, `${input.podProviderApi.name} api (in-pod keepalive)`);
  }

  const keys = new Set(input.envKeys);
  for (const key of BASE_URL_KEYS) {
    if (!keys.has(key)) continue;
    const value = input.baseUrlValues?.[key];
    const host = value ? hostFromUrlLike(value) : null;
    if (host) add(host, `base URL (${key})`);
  }

  for (const { provider, endpoints } of input.providerEndpoints ?? []) {
    for (const group of siblingGroups(endpoints)) {
      const reason =
        group.members.length > 1
          ? `pi provider ${provider} (host pi settings; wildcard for ${group.members.join(", ")})`
          : `pi provider ${provider} (host pi settings)`;
      add(group.entry, reason);
    }
  }

  return out;
}

/**
 * One provider's endpoints, grouped so siblings become a single wildcard.
 *
 * Providers may cap the allow set, and one provider can otherwise spend two of them on one
 * domain: pi's inference host and its OAuth-refresh host are siblings by construction
 * (`api.x.ai` and `auth.x.ai`, `api.anthropic.com` and `console.anthropic.com`). A group of two
 * or more endpoints that share a parent domain collapses into `*.parent`, which the provider's
 * wildcard rule treats as covering the apex and every subdomain — the same allowance, one entry.
 *
 * The parent is the host minus its first label, and only hosts of three or more labels
 * have one to give up: grouping `cursor.com` under `*.com` would be a much wider policy
 * than anyone wrote. Siblings only, by the same rule — Bedrock's two regional hosts
 * (`bedrock-runtime.us-east-1.amazonaws.com`, `…eu-central-1…`) have different parents and
 * stay separate, because their common suffix is all of `amazonaws.com`.
 *
 * Done here rather than at enforcement time so the widening stays visible: `doctor` and
 * `--dry-run` print the wildcard with the members it stands for, where a silent collapse
 * inside `resolveForProvider` would be a policy change nobody reviewed (D5).
 */
function siblingGroups(endpoints: string[]): Array<{ entry: string; members: string[] }> {
  const byParent = new Map<string, string[]>();
  for (const raw of endpoints) {
    const host = raw.trim().toLowerCase();
    const labels = host.split(".");
    const parent = labels.length > 2 ? labels.slice(1).join(".") : host;
    const members = byParent.get(parent);
    if (members) members.push(host);
    else byParent.set(parent, [host]);
  }
  return [...byParent].map(([parent, members]) => ({
    entry: members.length > 1 ? `*.${parent}` : members[0]!,
    members,
  }));
}

function hostFromUrlLike(value: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(candidate).hostname;
  } catch {
    return null;
  }
}

/**
 * Credentials carried into the pod whose usual endpoint nothing allows (§11.1).
 *
 * Purely diagnostic. The failure it heads off is the least legible one pi-pod can produce —
 * the model returning a connection error that looks like an outage, or like a bad key, and
 * never like a firewall.
 */
export interface EndpointHint {
  envKey: string;
  host: string;
}

export function missingEndpointHints(
  envKeys: string[],
  allowed: string[],
  registry: ProviderRegistry = BUILTIN_REGISTRY,
): EndpointHint[] {
  const out: EndpointHint[] = [];
  const seen = new Set<string>();
  for (const key of envKeys) {
    // pi's answer first, so a provider pi added last week is recognized without a pi-pod
    // release; pi-pod's own credentials (git tokens) fill in what pi does not model.
    const host = endpointForEnvKey(registry, key) ?? PIPOD_ENDPOINT_HINTS[key];
    if (!host || seen.has(host)) continue;
    if (allowsHost(allowed, host)) continue;
    seen.add(host);
    out.push({ envKey: key, host });
  }
  return out;
}

/**
 * Whether an allow set covers `host`, under the provider's wildcard rule.
 *
 * The provider wildcard rule treats `*.example.com` as covering "the base domain and its
 * subdomains", so a wildcard matches the apex as well as anything under it. Kept conservative
 * on purpose: this
 * only ever suppresses a warning, so being too strict costs a redundant hint while being too
 * loose costs a silent failure.
 */
export function allowsHost(allowed: string[], host: string): boolean {
  const target = host.trim().toLowerCase();
  return allowed.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === target) return true;
    if (!entry.startsWith("*.")) return false;
    const base = entry.slice(2);
    return target === base || target.endsWith(`.${base}`);
  });
}

// ---------------------------------------------------------------------------
// Entry validation
// ---------------------------------------------------------------------------

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z]{2,63}\.?$/i;

export function isIPv4(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isIPv6(addr: string): boolean {
  // Deliberately permissive: this only has to distinguish "an address" from "a hostname",
  // and it is used to *reject*, so over-matching a malformed address is harmless.
  return addr.includes(":") && /^[0-9a-f:.]+$/i.test(addr);
}

export function isHostname(entry: string): boolean {
  return HOSTNAME_RE.test(entry);
}

/** `*.example.com` — allows the base domain and everything under it. */
export function isWildcard(entry: string): boolean {
  return entry.startsWith("*.");
}

/** The hostname a wildcard is anchored to; the entry itself when it is not one. */
export function wildcardBase(entry: string): string {
  return isWildcard(entry) ? entry.slice(2) : entry;
}

/**
 * Allow-set entries are hostnames, optionally wildcarded. Addresses are refused (§11.1).
 *
 * An IP in a committed allowlist is a snapshot of DNS on the day someone ran `dig`, and it
 * rots silently: the endpoint moves, the pod keeps its old address, and the session fails
 * mid-flight with a connection error rather than anything naming this file. Hostnames are
 * also the only form a provider can enforce without resolving them for us, which is what
 * makes CDN-backed endpoints work at all.
 */
export function validateAllowEntry(entry: string): string | null {
  const e = entry.trim();
  if (e === "") return "empty entry";

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e)) {
    return `"${entry}" includes a scheme — entries are bare hostnames (no protocol, port, or path)`;
  }
  if (e.includes("/")) {
    return (
      `"${entry}" looks like a CIDR or a URL path. Allowlist entries are hostnames: ` +
      "an address range cannot be kept correct in a committed file"
    );
  }
  if (e.includes(":")) {
    // Catches both `host:443` and a bare IPv6 literal.
    return `"${entry}" includes a port or is an IP address — entries are bare hostnames`;
  }
  if (isIPv4(e)) {
    return (
      `"${entry}" is an IP address. Use the hostname instead — an address baked into a ` +
      "committed allowlist stops matching the moment the endpoint moves"
    );
  }

  const base = wildcardBase(e);
  if (isWildcard(e) && !base.includes(".")) {
    return `"${entry}" would allow an entire top-level domain`;
  }
  if (base.includes("*")) {
    return `"${entry}" — a wildcard is only valid as a leading "*." label`;
  }
  if (!isHostname(base)) return `"${entry}" is not a valid hostname`;
  return null;
}

// ---------------------------------------------------------------------------
// Policy assembly
// ---------------------------------------------------------------------------

export interface EffectivePolicy {
  mode: "open" | "allowlist";
  /** Hostnames and wildcards as written, with provenance. */
  entries: DerivedHost[];
}

export function buildEffectivePolicy(
  egress: EgressConfig,
  derivation: RepoDerivationInput,
): EffectivePolicy {
  if (egress.mode === "open") return { mode: "open", entries: [] };

  const entries: DerivedHost[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];

  // Config first: it is the authoritative, reviewable list, so it should be what provenance
  // credits when the same host also falls out of the repo.
  for (const raw of egress.allow) {
    const problem = validateAllowEntry(raw);
    if (problem) {
      problems.push(problem);
      continue;
    }
    const host = raw.trim().toLowerCase();
    if (seen.has(host)) continue;
    seen.add(host);
    entries.push({ host, reason: "egress.allow (config)" });
  }

  if (problems.length > 0) {
    throw new PiPodError(`invalid egress.allow entries:\n${problems.map((p) => `  - ${p}`).join("\n")}`, {
      hint: 'entries are hostnames ("api.example.com") or wildcards ("*.example.com")',
    });
  }

  if (egress.builtins) {
    for (const derived of deriveRepoHosts(derivation)) {
      // A wildcard already in the config covers it; adding the apex too would spend an entry
      // against the provider's cap for nothing.
      if (seen.has(derived.host) || allowsHost([...seen], derived.host)) continue;
      seen.add(derived.host);
      entries.push(derived);
    }
  }

  if (entries.length === 0) {
    throw new PiPodError('egress.mode is "allowlist" but the allow set is empty', {
      hint:
        'add hosts to "egress.allow" in .pi-pod/config.json, or opt out explicitly with ' +
        '"egress.mode": "open"',
    });
  }

  return { mode: "allowlist", entries };
}

// ---------------------------------------------------------------------------
// Enforcement mapping (§3.2)
// ---------------------------------------------------------------------------

export interface CidrWildcardProblem {
  message: string;
  hint: string;
}

/**
 * CIDR enforcement has no finite expansion for a wildcard. Keep this structural failure ahead
 * of DNS and bound its text so doctor/dry-run never becomes a wall of configured hostnames.
 */
export function cidrWildcardProblem(
  entries: readonly string[],
  providerName?: string,
): CidrWildcardProblem | null {
  const wildcards = [...new Set(entries.map((entry) => entry.trim()).filter(isWildcard))];
  if (wildcards.length === 0) return null;
  const shown = wildcards.slice(0, 3).map((entry) => `"${entry}"`).join(", ");
  const remainder = wildcards.length - 3;
  const subject = providerName ? `provider "${providerName}"` : "this provider";
  return {
    message:
      `${subject} enforces egress by CIDR and cannot expand wildcard allowlist ` +
      `entries: ${shown}${remainder > 0 ? `, and ${remainder} more` : ""}`,
    hint:
      "replace each wildcard with the concrete hostnames the pod needs, choose a provider with " +
      'domain-based egress enforcement, or set egress.mode to "open" if unrestricted egress is acceptable',
  };
}

export interface ResolvedEntry {
  /** The hostname or wildcard as configured. */
  source: string;
  reason: string;
  /** What the provider will actually enforce. */
  enforced: string[];
  /** True when a hostname expanded to many addresses — likely a shared CDN range. */
  wideFanout: boolean;
}

export interface ResolutionResult {
  policy: EgressPolicy;
  resolved: ResolvedEntry[];
  warnings: string[];
  /** Set when entries had to be merged to fit the provider's limit (§11.1). */
  aggregation?: { from: number; to: number; cidrs: string[] };
}

/** A hostname resolving to more than this many addresses is treated as CDN-backed. */
const WIDE_FANOUT_THRESHOLD = 4;

/**
 * Map the effective policy onto what the provider can enforce (§3.2):
 *  - "domain": hostnames and wildcards pass through untouched. The preferred path — the
 *              provider matches names at connection time, so a CDN that rotates addresses
 *              mid-session keeps working and DNS inside the pod is untouched.
 *  - "cidr":   hostnames are resolved to addresses at creation time and handed over as
 *              /32/-/128. Lossy by construction; wildcards cannot be expressed at all.
 */
export async function resolveForProvider(
  policy: EffectivePolicy,
  enforcement: EgressEnforcement,
  opts: {
    lookup?: (host: string, family: EgressAddressFamily) => Promise<string[]>;
    /** Address families the provider accepts in a CIDR allowlist (§3.2). */
    addressFamily?: EgressAddressFamily;
    /** Provider's maximum allowlist entries (§3.2). */
    maxEntries?: number | null;
  } = {},
): Promise<ResolutionResult> {
  if (policy.mode === "open") {
    return { policy: { mode: "open" }, resolved: [], warnings: [] };
  }

  if (enforcement === "domain") {
    const hosts = policy.entries.map((e) => e.host);
    const maxEntries = opts.maxEntries ?? null;
    if (maxEntries !== null && hosts.length > maxEntries) {
      // Nothing to aggregate: names have no arithmetic. Say which entries overflow and let a
      // human choose, rather than truncating into a policy nobody wrote.
      throw new PiPodError(
        `the allow set has ${hosts.length} entries but this provider accepts at most ${maxEntries}`,
        {
          hint:
            "collapse related hosts into one wildcard (*.example.com covers the base domain " +
            "and its subdomains), or remove something. The entries past the cap, and what " +
            "put them there:\n" +
            policy.entries
              .slice(maxEntries)
              .map((e) => `  - ${e.host} (${e.reason})`)
              .join("\n"),
        },
      );
    }
    return {
      policy: { mode: "allowlist", hosts },
      resolved: policy.entries.map((e) => ({
        source: e.host,
        reason: e.reason,
        enforced: [e.host],
        wideFanout: false,
      })),
      warnings: [],
    };
  }

  const wildcardProblem = cidrWildcardProblem(policy.entries.map((entry) => entry.host));
  if (wildcardProblem) {
    throw new PiPodError(wildcardProblem.message, { hint: wildcardProblem.hint });
  }

  // enforcement === "cidr"
  const lookup = opts.lookup ?? defaultLookup;
  const family = opts.addressFamily ?? "dual";
  const ipv4Only = family === "ipv4";
  const resolved: ResolvedEntry[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];

  for (const entry of policy.entries) {

    let addresses: string[];
    try {
      addresses = await lookup(entry.host, family);
    } catch (e) {
      failures.push(`${entry.host} (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }

    // Only hand over families the provider will accept. A host with no address in an
    // accepted family cannot be allowed at all, so say so rather than quietly omitting it.
    if (ipv4Only) addresses = addresses.filter((a) => isIPv4(a));

    if (addresses.length === 0) {
      failures.push(
        ipv4Only
          ? `${entry.host} (no IPv4 address — this provider's allowlist accepts IPv4 only)`
          : `${entry.host} (no addresses)`,
      );
      continue;
    }

    const cidrs = addresses.map((a) => (isIPv4(a) ? `${a}/32` : `${a}/128`));
    const wideFanout = addresses.length > WIDE_FANOUT_THRESHOLD;
    if (wideFanout) {
      warnings.push(
        `${entry.host} resolves to ${addresses.length} addresses — likely a shared CDN range. ` +
          "The enforced policy is coarser than the hostname list implies, and the endpoint may " +
          "fail mid-session if its addresses rotate.",
      );
    }
    resolved.push({ source: entry.host, reason: entry.reason, enforced: cidrs, wideFanout });
  }

  if (failures.length > 0) {
    throw new PiPodError(
      `could not resolve these allowlist hostnames to addresses:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
      {
        hint:
          "this provider enforces egress by CIDR, so every allowed hostname must resolve at " +
          "creation time — fix DNS, or drop the entries it cannot express",
      },
    );
  }

  const hosts = dedupe(resolved.flatMap((r) => r.enforced));

  // Providers cap how many networks an allowlist may contain, and a hostname list routinely
  // resolves past it. Merge the cheapest pairs until it fits, rather than truncating (which
  // would break connectivity silently) or giving up (which pushes users to open egress).
  const maxEntries = opts.maxEntries ?? null;
  if (maxEntries !== null && hosts.length > maxEntries) {
    if (!ipv4Only && hosts.some((h) => h.includes(":"))) {
      throw new PiPodError(
        `the allow set has ${hosts.length} entries but this provider accepts ${maxEntries}, ` +
          "and it cannot be aggregated because it mixes IPv4 and IPv6",
        { hint: 'trim egress.allow, or set egress.mode to "open" explicitly' },
      );
    }

    let aggregated;
    try {
      aggregated = aggregateIpv4(hosts, maxEntries);
    } catch (e) {
      throw new PiPodError(
        `the allow set has ${hosts.length} entries but this provider accepts at most ${maxEntries}, ` +
          `and it cannot be narrowed to fit: ${e instanceof Error ? e.message : String(e)}`,
        {
          hint:
            "reduce the hosts in play — trim egress.allow, or opt into unrestricted egress " +
            'with "mode": "open"',
        },
      );
    }

    warnings.push(
      `${hosts.length} resolved addresses exceed this provider's limit of ${maxEntries}; ` +
        `merged into ${aggregated.cidrs.length} broader network(s): ${aggregated.cidrs.join(", ")}. ` +
        "The enforced policy is coarser than the hostname list implies.",
    );
    for (const wide of aggregated.widePrefixes) {
      warnings.push(`${wide} is a very broad range (/${prefixLength(wide)}) — review whether it is acceptable`);
    }

    return {
      policy: { mode: "allowlist", hosts: aggregated.cidrs },
      resolved,
      warnings,
      aggregation: { from: hosts.length, to: aggregated.cidrs.length, cidrs: aggregated.cidrs },
    };
  }

  return { policy: { mode: "allowlist", hosts }, resolved, warnings };
}

async function defaultLookup(host: string, family: EgressAddressFamily): Promise<string[]> {
  const results = await dns.lookup(host, {
    all: true,
    verbatim: true,
    ...(family === "ipv4" ? { family: 4 } : {}),
  });
  return results.map((r) => r.address);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Compact description exported to the pod as `PI_POD_EGRESS` (§7.3, §11.1). */
export function describePolicy(policy: EgressPolicy): string {
  if (policy.mode === "open") return "open";
  return `allowlist:${policy.hosts.join(",")}`;
}

// ---------------------------------------------------------------------------
// Hosts-file seeding (§11.1)
// ---------------------------------------------------------------------------

export interface HostsEntry {
  hostname: string;
  addresses: string[];
}

/**
 * Map a CIDR-enforced allowlist back to `/etc/hosts` entries.
 *
 * An IP-based allowlist blocks DNS along with everything else: resolving a name means
 * reaching a nameserver on UDP/53, and that nameserver is not in the allow set. Spending
 * scarce entries on public resolvers would be a guess (the pod may use an internal one)
 * and would still leave resolution dependent on a service we did not intend to allow.
 *
 * Instead the launcher reuses the resolution it already performed to build the allowlist:
 * exactly the addresses that are permitted are the ones the pod will use.
 *
 * Returns nothing under `"domain"` enforcement, and that is the point — a provider matching
 * names at connection time leaves DNS working, so there is nothing to paper over.
 */
export function buildHostsEntries(resolved: ResolvedEntry[]): HostsEntry[] {
  const out: HostsEntry[] = [];
  for (const entry of resolved) {
    const addresses = entry.enforced
      .filter((e) => e.endsWith("/32"))
      .map((e) => e.slice(0, -"/32".length))
      .filter((a) => isIPv4(a));
    if (addresses.length > 0) out.push({ hostname: entry.source, addresses });
  }
  return out;
}

/** Render entries as a block appended to the pod's /etc/hosts. */
export function renderHostsFile(entries: HostsEntry[]): string {
  const lines = [
    "",
    "# --- pi-pod ---",
    "# The egress allowlist is enforced by IP, which blocks DNS too. These are the addresses",
    "# the launcher resolved when building the allowlist, so the names below resolve to",
    "# exactly what is permitted.",
  ];
  for (const entry of entries) {
    for (const address of entry.addresses) lines.push(`${address} ${entry.hostname}`);
  }
  lines.push("# --- end pi-pod ---", "");
  return lines.join("\n");
}
