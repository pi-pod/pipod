/**
 * src/config.ts — `.pi-pod/config.json` loading, validation and defaulting (§4.1).
 *
 * Parsed as JSONC so the annotated example in the spec is valid as written. Validation is
 * hand-rolled rather than schema-library-driven so that every message can name the offending
 * path and say what to do about it. Unknown keys warn (forward compatibility: a config
 * written for a newer launcher should still run); wrong types are hard errors.
 *
 * Account launches send the project file to the server; machine config is client preferences
 * only. The lower-level validation and legacy loader remain useful to tests and compatibility
 * callers, while launch planning owns the server-visible layer boundary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChordConfig } from "./client/runtime/chords.js";
import { POD_SUBCOMMANDS } from "./client/runtime/pod-commands.js";
import { DEFAULT_HOST_CONFIG, type HostConfigSelection } from "./hostconfig.js";
import { defaultImageRef, launcherVersion } from "./image.js";
import { userConfigPath } from "./userconfig.js";

export const CONFIG_DIR = ".pi-pod";
export const CONFIG_RELATIVE_PATH = path.join(CONFIG_DIR, "config.json");

export type InitOnFailure = "abort" | "prompt" | "continue";
/**
 * Conventional project file paths. These used to be configurable (`envFile`, `initScript`,
 * `bakeScript`); they are fixed now so the server bundle never stores client filesystem
 * layout. See docs/config-simplification.md.
 */
export const PROJECT_ENV_FILE = path.join(CONFIG_DIR, "env");
export const PROJECT_INIT_SCRIPT = path.join(CONFIG_DIR, "init.sh");
export const PROJECT_BAKE_SCRIPT = path.join(CONFIG_DIR, "bake.sh");

/**
 * Top-level config keys retired by the config simplification, each with its migration.
 * Presence is a hard error (not an unknown-key warning): a custom script path that is
 * silently ignored would read the wrong file, and a no-op key that is silently kept
 * would never get cleaned up.
 */
export const REMOVED_CONFIG_KEYS: Record<string, string> = {
  envFile: `envFile was removed — the project env file is always ${PROJECT_ENV_FILE}; move your file there and delete this key`,
  initScript: `initScript was removed — the project init script is always ${PROJECT_INIT_SCRIPT}; move your script there and delete this key`,
  bakeScript: `bakeScript was removed — the project bake script is always ${PROJECT_BAKE_SCRIPT}; move your script there and delete this key`,
  reuse: "reuse was removed — pass --reuse to reuse a stopped project pod (fresh pods are the default); delete this key",
};

/**
 * Retired `pi.hostConfig` name lists. Neither ever reached the server (zero server reads)
 * nor selected anything locally — the whole local agents directory always syncs — so
 * they were pure no-ops. `settings`/`packages` stay live.
 */
export const REMOVED_HOSTCONFIG_KEYS: Record<string, string> = {
  skills: "pi.hostConfig.skills was removed — it never selected anything; delete this key (the whole local agents directory still syncs)",
  extensions: "pi.hostConfig.extensions was removed — it never selected anything; delete this key",
};

/**
 * Retired sandbox-provider selection keys. Single-provider build: `sandbox` is the only
 * backend, so both are warn-and-ignore locally and stripped from every outgoing bundle.
 * Old project/template/org files keep running with a migration warning instead of failing.
 */
export const RETIRED_PROVIDER_CONFIG_KEYS: Record<string, string> = {
  provider: "provider was removed — sandbox is the only backend; delete this key",
  deniedProviders: "deniedProviders was removed — sandbox is the only backend; delete this key",
};

/** Names from RETIRED_PROVIDER_CONFIG_KEYS present on a raw config object. */
export function retiredProviderConfigKeysFound(raw: Record<string, unknown>): string[] {
  return Object.keys(RETIRED_PROVIDER_CONFIG_KEYS).filter((key) => Object.hasOwn(raw, key));
}

/**
 * Keys that stay valid locally but must never travel in a server bundle: the server
 * rejects them on write (400). `template` is the local pin (a template id travels
 * instead); `reuse` is retired locally but old bundles may still carry it; the rest
 * are retired path pointers and hostConfig name lists — listed here as defense for
 * old files and old bundles.
 */
const OUTGOING_STRIPPED_TOP_KEYS = [
  "template",
  "reuse",
  "envFile",
  "initScript",
  "bakeScript",
  "provider",
  "deniedProviders",
];

/** Names from REMOVED_CONFIG_KEYS present on a raw config object. */
export function removedConfigKeysFound(raw: Record<string, unknown>): string[] {
  return Object.keys(REMOVED_CONFIG_KEYS).filter((key) => Object.hasOwn(raw, key));
}

/** Names from REMOVED_HOSTCONFIG_KEYS present on a raw pi.hostConfig object. */
export function removedHostConfigKeysFound(raw: Record<string, unknown>): string[] {
  return Object.keys(REMOVED_HOSTCONFIG_KEYS).filter((key) => Object.hasOwn(raw, key));
}

/** Retired-key findings on one local file: dotted path plus its migration hint. */
export interface RetiredKeyFinding {
  path: string;
  hint: string;
}

/** Top-level and nested (`pi.hostConfig`) retired keys present on a raw local object. */
export function retiredLocalKeysFound(raw: Record<string, unknown>): RetiredKeyFinding[] {
  const found: RetiredKeyFinding[] = [];
  for (const key of removedConfigKeysFound(raw)) {
    found.push({ path: key, hint: REMOVED_CONFIG_KEYS[key]! });
  }
  const pi = raw["pi"];
  if (pi !== null && typeof pi === "object" && !Array.isArray(pi)) {
    const hostConfig = (pi as Record<string, unknown>)["hostConfig"];
    if (hostConfig !== null && typeof hostConfig === "object" && !Array.isArray(hostConfig)) {
      for (const key of removedHostConfigKeysFound(hostConfig as Record<string, unknown>)) {
        found.push({ path: `pi.hostConfig.${key}`, hint: REMOVED_HOSTCONFIG_KEYS[key]! });
      }
    }
  }
  return found;
}

/**
 * Client-only keys that live in local files but never in a bundle. `template` is covered
 * by the outgoing list; these are the rest.
 */
const CLIENT_ONLY_TOP_KEYS = ["$schema", "secretResolver"] as const;
const CLIENT_ONLY_PI_KEYS = ["chords", "sessionNaming"] as const;

/** Every dotted name a bundle payload must not contain: rejected keys plus client-only ones. */
export function nonBundleKeysFound(config: Record<string, unknown>): string[] {
  const found = outgoingStrippedKeysFound(config);
  for (const key of CLIENT_ONLY_TOP_KEYS) {
    if (Object.hasOwn(config, key) && !found.includes(key)) found.push(key);
  }
  const pi = config["pi"];
  if (pi !== null && typeof pi === "object" && !Array.isArray(pi)) {
    for (const key of CLIENT_ONLY_PI_KEYS) {
      const dotted = `pi.${key}`;
      if (Object.hasOwn(pi as Record<string, unknown>, key) && !found.includes(dotted)) {
        found.push(dotted);
      }
    }
  }
  return found;
}

/**
 * The single deep boundary for every outgoing server-bundle config: rejected keys and
 * client-only metadata are dropped, and a `pi` left holding only metadata is removed.
 */
export function stripNonBundleKeys<T extends Record<string, unknown>>(config: T): T {
  if (nonBundleKeysFound(config).length === 0) return config;
  const next = stripOutgoingConfigKeys({ ...config });
  for (const key of CLIENT_ONLY_TOP_KEYS) delete next[key];
  const pi = next["pi"];
  if (pi !== null && typeof pi === "object" && !Array.isArray(pi)) {
    const podPi = { ...(pi as Record<string, unknown>) };
    for (const key of CLIENT_ONLY_PI_KEYS) delete podPi[key];
    if (Object.keys(podPi).length > 0) (next as Record<string, unknown>)["pi"] = podPi;
    else delete next["pi"];
  }
  return next;
}

/**
 * Drop retired keys from server-resident config before validating it. Old templates and
 * bundles may still carry them; they were path pointers or no-ops, never pod settings.
 * Local files are validated strictly instead, so a stale local key fails closed.
 */
export function stripRemovedConfigKeys<T extends Record<string, unknown>>(config: T): T {
  const hostConfig = (config["pi"] as Record<string, unknown> | undefined)?.["hostConfig"];
  const nested = hostConfig !== null && typeof hostConfig === "object" && !Array.isArray(hostConfig)
    ? removedHostConfigKeysFound(hostConfig as Record<string, unknown>)
    : [];
  if (
    removedConfigKeysFound(config).length === 0 &&
    retiredProviderConfigKeysFound(config).length === 0 &&
    nested.length === 0
  )
    return config;
  const next: Record<string, unknown> = { ...config };
  for (const key of Object.keys(REMOVED_CONFIG_KEYS)) delete next[key];
  for (const key of Object.keys(RETIRED_PROVIDER_CONFIG_KEYS)) delete next[key];
  if (nested.length > 0) {
    const pi = { ...((next["pi"] as Record<string, unknown>) ?? {}) };
    const hc = { ...((pi["hostConfig"] as Record<string, unknown>) ?? {}) };
    for (const key of Object.keys(REMOVED_HOSTCONFIG_KEYS)) delete hc[key];
    pi["hostConfig"] = hc;
    next["pi"] = pi;
  }
  return next as T;
}

/** Dotted names an outgoing bundle config would lose to the server write contract. */
export function outgoingStrippedKeysFound(config: Record<string, unknown>): string[] {
  const found = OUTGOING_STRIPPED_TOP_KEYS.filter((key) => Object.hasOwn(config, key));
  const pi = config["pi"];
  if (pi !== null && typeof pi === "object" && !Array.isArray(pi)) {
    const hostConfig = (pi as Record<string, unknown>)["hostConfig"];
    if (hostConfig !== null && typeof hostConfig === "object" && !Array.isArray(hostConfig)) {
      for (const key of removedHostConfigKeysFound(hostConfig as Record<string, unknown>)) {
        found.push(`pi.hostConfig.${key}`);
      }
    }
  }
  return found;
}

/**
 * Strip everything the server bundle-write contract rejects (400) from an outgoing
 * config payload. Local-only pins (`template`), the retired `reuse` key, retired
 * path pointers, and retired hostConfig name lists never reach the server.
 */
export function stripOutgoingConfigKeys<T extends Record<string, unknown>>(config: T): T {
  if (outgoingStrippedKeysFound(config).length === 0) return config;
  const next = stripRemovedConfigKeys({ ...config });
  for (const key of OUTGOING_STRIPPED_TOP_KEYS) delete next[key];
  return next;
}

export type EgressMode = "allowlist" | "open";
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface EgressConfig {
  mode: EgressMode;
  /**
   * Also allow the hosts implied by *this checkout*: the git remote, and any base URL named
   * in the env file (§11.1).
   *
   * Narrow on purpose. It used to switch on a table of env-var-name → endpoint compiled into
   * the launcher, which is now `egress.allow` — a list you can read. What remains under this
   * flag is only what a committed file cannot state: the remote changes when you change
   * remotes, and a base URL comes out of a gitignored env file.
   */
  builtins: boolean;
  /** The allowlist. Hostnames or `*.`-prefixed wildcards; never addresses. */
  allow: string[];
}

/** Who names a session: the model, from the first prompt, or nobody (§5.4). */
export type SessionNaming = "auto" | "off";

export interface PiConfig {
  /** Default model for a fresh Pi process; a per-launch selection wins. */
  model: string | null;
  /** Default reasoning effort for a fresh Pi process; a per-launch selection wins. */
  thinking: PiThinkingLevel | null;
  command: string;
  args: string[];
  /** Historical name for sanitization gates applied to stored/project Pi bundles. */
  hostConfig: HostConfigSelection;
  /** `Ctrl-\`-prefixed keystroke aliases for the /pod commands (§7). */
  chords: ChordConfig;
  /**
   * Whether a fresh session names itself from its first prompt (§5.4).
   *
   * The name is pi's own `session_info` name — the thing `/name` sets, the terminal tab shows
   * and `pipod list` mirrors — so "off" costs the automatic naming, not the feature.
   */
  sessionNaming: SessionNaming;
}

export interface ResourcesConfig {
  cpu: number;
  memoryGB: number;
  diskGB: number;
}

export interface PiPodConfig {
  image: string;
  resources: ResourcesConfig;
  egress: EgressConfig;
  /** Project identity for pod naming, list scoping, and reuse; null derives it from the project directory name. */
  name: string | null;
  /**
   * Account-mode default template (name or id). Client-only: it selects which template
   * layer a launch applies, and never travels in a launch overlay. null = built-in default.
   */
  template: string | null;
  workdir: string;
  initTimeoutSeconds: number;
  initOnFailure: InitOnFailure;
  pi: PiConfig;
  idleTimeoutMinutes: number;
  /** Canonical inactivity archive interval, counted from the moment a pod stops. */
  archiveAfterMinutes: number;
  labels: Record<string, string>;
}

/** The managed image identity used when no layer pins one explicitly. */
export function defaultImage(): string {
  return defaultImageRef(launcherVersion());
}

/** The pi-tui KeyId the chord prefix defaults to (§7). */
export const DEFAULT_CHORD_PREFIX = "ctrl+\\";

/** One ending per /pod subcommand (§4). */
export const DEFAULT_CHORD_BINDINGS: Record<string, string> = {
  d: "detach",
  a: "archive",
  s: "status",
  l: "list",
  w: "switch",
};

export const DEFAULT_CONFIG: Omit<PiPodConfig, "image"> = {
  resources: { cpu: 2, memoryGB: 4, diskGB: 5 },
  egress: { mode: "open", builtins: true, allow: [] },
  name: null,
  template: null,
  workdir: "/workspace",
  initTimeoutSeconds: 600,
  initOnFailure: "abort",
  pi: {
    model: null,
    thinking: null,
    command: "pi",
    args: [],
    hostConfig: DEFAULT_HOST_CONFIG,
    chords: { enabled: true, prefix: DEFAULT_CHORD_PREFIX, bindings: DEFAULT_CHORD_BINDINGS },
    sessionNaming: "auto",
  },
  idleTimeoutMinutes: 15,
  archiveAfterMinutes: 60,
  labels: {},
};

// ---------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------

class Validator {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  /**
   * The config path each finding is about, positionally parallel to `errors` / `warnings`.
   *
   * Kept alongside rendered strings so launch planning can attribute merged-config findings.
   * Empty where the finding is not about a single key.
   */
  readonly errorPaths: string[] = [];
  readonly warningPaths: string[] = [];

  fail(pathStr: string, message: string): void {
    this.errors.push(`${pathStr}: ${message}`);
    this.errorPaths.push(pathStr);
  }

  /** A finding whose message already names the setting it is about. */
  failMessage(pathStr: string, message: string): void {
    this.errors.push(message);
    this.errorPaths.push(pathStr);
  }

  warn(pathStr: string, message: string): void {
    this.warnings.push(message);
    this.warningPaths.push(pathStr);
  }

  warnUnknownKeys(pathStr: string, obj: Record<string, unknown>, known: string[]): void {
    for (const key of Object.keys(obj)) {
      if (key === "$schema") continue;
      if (known.includes(key)) continue;
      const full = pathStr === "" ? key : `${pathStr}.${key}`;
      this.warn(full, `${full}: unknown key (ignored)`);
    }
  }

  object(pathStr: string, value: unknown, fallback: Record<string, unknown> = {}) {
    if (value === undefined) return fallback;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.fail(pathStr, `expected an object, got ${describe(value)}`);
      return fallback;
    }
    return value as Record<string, unknown>;
  }

  string(pathStr: string, value: unknown, fallback: string): string {
    if (value === undefined) return fallback;
    if (typeof value !== "string") {
      this.fail(pathStr, `expected a string, got ${describe(value)}`);
      return fallback;
    }
    return value;
  }

  requiredString(pathStr: string, value: unknown): string {
    if (value === undefined || value === null) {
      this.fail(pathStr, "is required");
      return "";
    }
    if (typeof value !== "string" || value.trim() === "") {
      this.fail(pathStr, `expected a non-empty string, got ${describe(value)}`);
      return "";
    }
    return value;
  }

  nullableString(pathStr: string, value: unknown, fallback: string | null): string | null {
    if (value === undefined) return fallback;
    if (value === null) return null;
    if (typeof value !== "string") {
      this.fail(pathStr, `expected a string or null, got ${describe(value)}`);
      return fallback;
    }
    return value;
  }

  bool(pathStr: string, value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      this.fail(pathStr, `expected true or false, got ${describe(value)}`);
      return fallback;
    }
    return value;
  }

  int(pathStr: string, value: unknown, fallback: number, opts: { min?: number } = {}): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      this.fail(pathStr, `expected an integer, got ${describe(value)}`);
      return fallback;
    }
    if (opts.min !== undefined && value < opts.min) {
      this.fail(pathStr, `must be >= ${opts.min}, got ${value}`);
      return fallback;
    }
    return value;
  }

  stringArray(pathStr: string, value: unknown, fallback: string[]): string[] {
    if (value === undefined) return fallback;
    if (!Array.isArray(value)) {
      this.fail(pathStr, `expected an array of strings, got ${describe(value)}`);
      return fallback;
    }
    const out: string[] = [];
    value.forEach((item, idx) => {
      if (typeof item !== "string") {
        this.fail(`${pathStr}[${idx}]`, `expected a string, got ${describe(item)}`);
        return;
      }
      out.push(item);
    });
    return out;
  }

  stringMap(
    pathStr: string,
    value: unknown,
    fallback: Record<string, string>,
  ): Record<string, string> {
    if (value === undefined) return fallback;
    const obj = this.object(pathStr, value);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== "string") {
        this.fail(`${pathStr}.${k}`, `expected a string, got ${describe(v)}`);
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  enumValue<T extends string>(pathStr: string, value: unknown, allowed: T[], fallback: T): T {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.fail(pathStr, `expected one of ${allowed.map((a) => `"${a}"`).join(", ")}, got ${describe(value)}`);
      return fallback;
    }
    return value as T;
  }

  nullableEnumValue<T extends string>(
    pathStr: string,
    value: unknown,
    allowed: readonly T[],
    fallback: T | null,
  ): T | null {
    if (value === undefined) return fallback;
    if (value === null) return null;
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      this.fail(pathStr, `expected null or one of ${allowed.map((a) => `"${a}"`).join(", ")}, got ${describe(value)}`);
      return fallback;
    }
    return value as T;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Chords (§7)
// ---------------------------------------------------------------------------

const CHORD_MODIFIERS: Record<string, string> = {
  c: "ctrl",
  ctrl: "ctrl",
  control: "ctrl",
  s: "shift",
  shift: "shift",
  a: "alt",
  m: "alt",
  alt: "alt",
  meta: "alt",
  super: "super",
  cmd: "super",
};

/** Canonical modifier order, so two spellings of one key compare equal. */
const CHORD_MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"];

const CHORD_SYMBOLS = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""));

const CHORD_NAMED_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert",
  "clear", "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

/**
 * A configured key in either spelling — the historical `C-\` or pi-tui's own `ctrl+\` — as the
 * KeyId `matchesKey` takes. Null when it names no key at all, which is a config error rather
 * than something to guess at: a keystroke is only testable by pressing it, and the moment you
 * would press it is at the end of a session, inside a provisioned pod.
 */
function normalizeChordKey(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;

  let base = text;
  const modifiers: string[] = [];
  const legacy = /^((?:[a-zA-Z]-)+)(.+)$/.exec(text);
  if (text.includes("+")) {
    const parts = text.split("+");
    base = parts[parts.length - 1]!;
    for (const part of parts.slice(0, -1)) modifiers.push(part.trim().toLowerCase());
  } else if (legacy) {
    for (const part of legacy[1]!.split("-")) {
      if (part !== "") modifiers.push(part.toLowerCase());
    }
    base = legacy[2]!;
  }

  const resolved = new Set<string>();
  for (const modifier of modifiers) {
    const name = CHORD_MODIFIERS[modifier];
    if (name === undefined) return null;
    resolved.add(name);
  }

  base = base.toLowerCase();
  const known =
    (base.length === 1 && ((base >= "a" && base <= "z") || (base >= "0" && base <= "9") || CHORD_SYMBOLS.has(base))) ||
    CHORD_NAMED_KEYS.has(base);
  if (!known) return null;

  return [...CHORD_MODIFIER_ORDER.filter((m) => resolved.has(m)), base].join("+");
}

function parseChords(v: Validator, raw: Record<string, unknown>, d: ChordConfig): ChordConfig {
  const prefixRaw = v.string("pi.chords.prefix", raw["prefix"], d.prefix);
  let prefix = normalizeChordKey(prefixRaw);
  if (prefix === null || !prefix.includes("+")) {
    v.fail("pi.chords.prefix", `expected a modified key such as "C-\\" or "ctrl+\\", got "${prefixRaw}"`);
    prefix = d.prefix;
  } else if (prefix === "ctrl+m") {
    // 0x0D is both Ctrl-M and Return: a chord here would hold every Enter press.
    v.fail("pi.chords.prefix", "C-m is what the terminal sends for Return — a chord on it would intercept every Enter press");
    prefix = d.prefix;
  }

  const subcommands = POD_SUBCOMMANDS.map((c) => c.name);
  const bindingsRaw = v.object("pi.chords.bindings", raw["bindings"]);
  const bindings: Record<string, string> = { ...d.bindings };
  const named = new Set<string>();
  for (const [key, value] of Object.entries(bindingsRaw)) {
    const at = `pi.chords.bindings.${key}`;
    const ending = normalizeChordKey(key);
    if (ending === null) {
      v.fail(at, `"${key}" names no key — use a single key such as "d", or a modified one such as "C-d"`);
      continue;
    }
    if (typeof value === "string" && value === "shell") {
      v.warn(at, "`shell` is no longer a pod command — this binding is ignored");
      continue;
    }
    if (typeof value !== "string" || !subcommands.includes(value)) {
      v.fail(at, `expected one of ${subcommands.map((n) => `"${n}"`).join(", ")}, got ${describe(value)}`);
      continue;
    }
    // A binding that can never fire is only discoverable at the worst possible moment.
    if (named.has(ending)) {
      v.fail(at, `binds ${ending} a second time — only one of the two could ever fire`);
      continue;
    }
    if (ending === prefix) {
      v.fail(at, `is the chord prefix itself — the prefix is consumed before an ending is read`);
      continue;
    }
    named.add(ending);
    bindings[ending] = value;
  }

  return { enabled: v.bool("pi.chords.enabled", raw["enabled"], d.enabled), prefix, bindings };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = [
  "image",
  "resources",
  "egress",
  "name",
  "template",
  "secretResolver",
  "workdir",
  "initTimeoutSeconds",
  "initOnFailure",
  "pi",
  "idleTimeoutMinutes",
  "archiveAfterMinutes",
  "labels",
];

export interface ParsedConfigResult {
  config: PiPodConfig;
  warnings: string[];
  errors: string[];
  /** Config path per finding, positionally parallel to `errors` / `warnings`. */
  errorPaths: string[];
  warningPaths: string[];
  /** False when `image` was defaulted rather than named. */
  imagePinned: boolean;
}

/** Validate + default an already-parsed config object. Exposed for unit tests. */
export function validateConfig(raw: unknown): ParsedConfigResult {
  const v = new Validator();
  const root = v.object("", raw);
  // Retired keys fail closed with a migration (never the generic unknown-key warning).
  // Retired provider-selection keys warn-and-ignore instead: single-provider build runs
  // old files with a migration warning rather than failing the launch.
  v.warnUnknownKeys("", root, [
    ...TOP_LEVEL_KEYS,
    ...Object.keys(REMOVED_CONFIG_KEYS),
    ...Object.keys(RETIRED_PROVIDER_CONFIG_KEYS),
  ]);
  for (const key of removedConfigKeysFound(root)) {
    v.fail(key, REMOVED_CONFIG_KEYS[key]!);
  }
  for (const key of retiredProviderConfigKeysFound(root)) {
    v.warn(key, `${key}: ${RETIRED_PROVIDER_CONFIG_KEYS[key]!}`);
  }

  const d = DEFAULT_CONFIG;

  const resourcesRaw = v.object("resources", root["resources"]);
  v.warnUnknownKeys("resources", resourcesRaw, ["cpu", "memoryGB", "diskGB"]);
  // The client never clamps resources itself: the server-resolved chain is authoritative and
  // reports any clamp explicitly. In particular an 8-GiB request is gated server-side — it
  // either receives 8 GiB on a qualified host or a clear refusal, never a silent 4-GiB clamp.

  const egressRaw = v.object("egress", root["egress"]);
  v.warnUnknownKeys("egress", egressRaw, ["mode", "builtins", "allow"]);

  const piRaw = v.object("pi", root["pi"]);
  v.warnUnknownKeys("pi", piRaw, [
    "model",
    "thinking",
    "command",
    "args",
    "hostConfig",
    "chords",
    "sessionNaming",
  ]);

  const hostConfigRaw = v.object("pi.hostConfig", piRaw["hostConfig"]);
  v.warnUnknownKeys("pi.hostConfig", hostConfigRaw, [
    "settings",
    "packages",
    ...Object.keys(REMOVED_HOSTCONFIG_KEYS),
  ]);
  for (const key of Object.keys(REMOVED_HOSTCONFIG_KEYS).filter((k) => Object.hasOwn(hostConfigRaw, k))) {
    v.fail(`pi.hostConfig.${key}`, REMOVED_HOSTCONFIG_KEYS[key]!);
  }

  const chordsRaw = v.object("pi.chords", piRaw["chords"]);
  v.warnUnknownKeys("pi.chords", chordsRaw, ["enabled", "prefix", "bindings"]);

  const config: PiPodConfig = {
    image: v.string("image", root["image"], defaultImage()),
    resources: {
      cpu: v.int("resources.cpu", resourcesRaw["cpu"], d.resources.cpu, { min: 1 }),
      memoryGB: v.int("resources.memoryGB", resourcesRaw["memoryGB"], d.resources.memoryGB, {
        min: 1,
      }),
      diskGB: v.int("resources.diskGB", resourcesRaw["diskGB"], d.resources.diskGB, { min: 1 }),
    },
    egress: {
      mode: v.enumValue<EgressMode>(
        "egress.mode",
        egressRaw["mode"],
        ["allowlist", "open"],
        d.egress.mode,
      ),
      builtins: v.bool("egress.builtins", egressRaw["builtins"], d.egress.builtins),
      allow: v.stringArray("egress.allow", egressRaw["allow"], d.egress.allow),
    },
    name: v.nullableString("name", root["name"], d.name),
    template: v.nullableString("template", root["template"], d.template),
    workdir: v.string("workdir", root["workdir"], d.workdir),
    initTimeoutSeconds: v.int("initTimeoutSeconds", root["initTimeoutSeconds"], d.initTimeoutSeconds, {
      min: 1,
    }),
    initOnFailure: v.enumValue<InitOnFailure>(
      "initOnFailure",
      root["initOnFailure"],
      ["abort", "prompt", "continue"],
      d.initOnFailure,
    ),
    pi: {
      model: v.nullableString("pi.model", piRaw["model"], d.pi.model),
      thinking: v.nullableEnumValue<PiThinkingLevel>(
        "pi.thinking",
        piRaw["thinking"],
        PI_THINKING_LEVELS,
        d.pi.thinking,
      ),
      command: v.string("pi.command", piRaw["command"], d.pi.command),
      args: v.stringArray("pi.args", piRaw["args"], d.pi.args),
      hostConfig: {
        settings: v.bool("pi.hostConfig.settings", hostConfigRaw["settings"], d.pi.hostConfig.settings),
        packages: v.bool("pi.hostConfig.packages", hostConfigRaw["packages"], d.pi.hostConfig.packages),
      },
      chords: parseChords(v, chordsRaw, d.pi.chords),
      sessionNaming: v.enumValue<SessionNaming>(
        "pi.sessionNaming",
        piRaw["sessionNaming"],
        ["auto", "off"],
        d.pi.sessionNaming,
      ),
    },
    // 0 is meaningful here (auto-stop off), so the floor is 0 rather than 1.
    idleTimeoutMinutes: v.int("idleTimeoutMinutes", root["idleTimeoutMinutes"], d.idleTimeoutMinutes, {
      min: 0,
    }),
    archiveAfterMinutes: v.int("archiveAfterMinutes", root["archiveAfterMinutes"], d.archiveAfterMinutes, {
      min: 0,
    }),
    labels: v.stringMap("labels", root["labels"], d.labels),
  };

  // Cross-field rules -------------------------------------------------------

  if (
    config.pi.model !== null &&
    (config.pi.model.length === 0 ||
      config.pi.model.length > 512 ||
      config.pi.model.trim() !== config.pi.model ||
      config.pi.model.startsWith("-"))
  ) {
    v.fail(
      "pi.model",
      "must be 1–512 characters, with no surrounding whitespace, and must not start with '-'",
    );
  }

  if (config.name !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.name)) {
    v.fail("name", "must be 1-64 characters of letters, digits, dots, dashes or underscores");
  }

  if (
    config.template !== null &&
    (config.template.length === 0 ||
      config.template.length > 100 ||
      config.template.trim() !== config.template)
  ) {
    v.fail(
      "template",
      "must be 1–100 characters, with no surrounding whitespace, or null to launch without a template",
    );
  }


  if (!path.posix.isAbsolute(config.workdir)) {
    v.fail("workdir", `must be an absolute path inside the sandbox, got "${config.workdir}"`);
  }

  // Archival is measured from the moment a pod *stops* (§9), and idle auto-stop is what
  // stops it. Turning auto-stop off therefore removes the trigger for archival as well: the
  // pod never goes quiet, never gets archived, and bills at the running rate until
  // someone runs `pipod gc`.
  if (config.idleTimeoutMinutes === 0) {
    v.warn(
      "idleTimeoutMinutes",
      "idleTimeoutMinutes: 0 requests disabled idle auto-stop. " +
        "A detached pod runs (and bills) until `pipod gc`; the server " +
        "reports the effective maximum during preflight",
    );
  }

  // "open" leaves network policy to the sandbox; a stray allow list next to it is
  // dead config that reads as protection.
  if (config.egress.mode === "open" && config.egress.allow.length > 0) {
    v.warn(
      "egress.allow",
      'egress.allow: ignored because egress.mode is "open" (all egress is permitted)',
    );
  }

  return {
    config,
    warnings: v.warnings,
    errors: v.errors,
    errorPaths: v.errorPaths,
    warningPaths: v.warningPaths,
    imagePinned: root["image"] !== undefined,
  };
}

/** A path with symlinks resolved, or the path itself when it cannot be resolved. */
function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The same file or directory by two names.
 *
 * Compared through `realpath` because git reports the toplevel with symlinks resolved and a cwd
 * generally is not — on macOS `/var` is a symlink to `/private/var`, which is where both the
 * temp dirs the tests run in and many real checkouts live.
 */
function samePath(a: string, b: string): boolean {
  return a === b || realpathOr(a) === realpathOr(b);
}

export interface FindConfigOptions {
  /** Host home directory. Defaults to $HOME; a parameter so tests need no real one. */
  home?: string | undefined;
}

/**
 * The nearest *project* `.pi-pod/config.json` at or above `startDir`, or null when there is
 * none. Purely a filesystem walk — no version-control tool is consulted.
 *
 * `~/.pi-pod/config.json` never answers: it is client preferences, not a project contract.
 * The walk also stops *at* `$HOME` — a `.pi-pod/` above the home directory belongs to nobody's
 * project.
 */
export function findConfigPath(startDir: string, opts: FindConfigOptions = {}): string | null {
  const userPath = userConfigPath(opts.home);
  const homeDir = userPath !== null ? path.dirname(path.dirname(userPath)) : null;

  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_RELATIVE_PATH);
    if (fs.existsSync(candidate) && !(userPath !== null && samePath(candidate, userPath))) {
      return candidate;
    }
    if (homeDir !== null && samePath(dir, homeDir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
