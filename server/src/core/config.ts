/**
 * src/config.ts — `.pi-pod/config.json` loading, validation and defaulting (§4.1).
 *
 * Parsed as JSONC so the annotated example in the spec is valid as written. Validation is
 * hand-rolled rather than schema-library-driven so that every message can name the offending
 * path and say what to do about it. Unknown keys warn (forward compatibility: a config
 * written for a newer launcher should still run); wrong types are hard errors.
 *
 * Two files feed one config: the machine-wide `~/.pi-pod/config.json` first, the repo's own
 * `.pi-pod/config.json` on top, merged per key (see `userconfig.ts`). Validation runs on the
 * merged result — that is the config the session actually gets — and each finding is then
 * attributed back to the file that supplied the value, so an error never names a file that is
 * already correct.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChordConfig } from "./client/runtime/chords.js";
import { POD_SUBCOMMANDS } from "./client/runtime/pod-commands.js";
import { PiPodError } from "./errors.js";
import { DEFAULT_HOST_CONFIG, type HostConfigSelection } from "./hostconfig.js";
import { defaultImageRef, launcherVersion } from "./image.js";
import { parseJsonc } from "./jsonc.js";
import { configProvenance, displayPath, layerOf, mergeConfigLayers, userConfigPath, type ConfigProvenanceEntry } from "./userconfig.js";

export const CONFIG_DIR = ".pi-pod";
export const CONFIG_RELATIVE_PATH = path.join(CONFIG_DIR, "config.json");

export type InitOnFailure = "abort" | "prompt" | "continue";
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
  /** Which parts of the host's `~/.pi/agent` travel into the pod (§7.5). */
  hostConfig: HostConfigSelection;
  /** `Ctrl-\`-prefixed keystroke aliases for the /pod commands (§7). */
  chords: ChordConfig;
  /**
   * Whether a fresh session names itself from its first prompt (§5.4).
   *
   * The name is pi's own `session_info` name — the thing `/name` sets, the terminal tab shows
   * and `pi-pod list` mirrors — so "off" costs the automatic naming, not the feature.
   */
  sessionNaming: SessionNaming;
}

export interface ResourcesConfig {
  cpu: number;
  memoryGB: number;
  diskGB: number;
}

export interface PiPodConfig {
  /** Empty string until the CLI resolves it (flag → config → credential detection, §4.1). */
  provider: string;
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
  envFile: string;
  initScript: string;
  /** Project bake layer: deterministic, secretless setup baked into the derived image. */
  bakeScript: string;
  initTimeoutSeconds: number;
  initOnFailure: InitOnFailure;
  pi: PiConfig;
  /**
   * Provider names launches may not use. A denylist rather than an allowlist because the
   * default is "everything the deployment supports"; merged by union across config layers
   * (org → template → project) — a denial can never be un-set by a lower layer.
   */
  deniedProviders: string[];
  /** Reuse this repo+branch's newest stopped pod instead of creating one (§6.5). */
  reuse: boolean;
  idleTimeoutMinutes: number;
  /** Canonical inactivity archive interval. Legacy archiveAfterDays is converted into this at parse time. */
  archiveAfterMinutes: number;
  labels: Record<string, string>;
  /**
   * Per-provider adapter wiring (`providers.<name>`), kept by this fork because the server's
   * own lifecycle reads it: planning freezes the placed sandbox host's URL here, and every
   * later start/stop/archive/image call dials the block the pod was launched with.
   *
   * Server-side only. The CLI dropped the key, so it must be projected out of anything sent
   * to a client (`clientFacingConfig`) — both because a current CLI warns `providers: unknown
   * key (ignored)` on it, and because the block is deployment wiring no client needs.
   */
  providers: Record<string, Record<string, unknown>>;
}

export interface LoadedConfig {
  config: PiPodConfig;
  /**
   * Absolute path of the repo config file, or null when this repo has no `.pi-pod/` of its own
   * and the machine-wide layer is the whole config.
   */
  configPath: string | null;
  /**
   * Absolute path of the machine-wide layer, when one took part. Null when the file does not
   * exist, when there is no home directory, or when the run declined it (`--no-user-config`).
   */
  userConfigPath: string | null;
  /** Absolute project root (the directory containing `.pi-pod/`, or the cwd). */
  projectRoot: string;
  /**
   * Did either layer actually name an `image`?
   *
   * The difference matters at launch: a pin is used verbatim, while a derived tag has to be
   * re-derived against *this* provider — on one that sizes per image, the tag carries the
   * sizing, so `pi-pod-base:0.1.0` is not the artifact anyone ever built. Without this flag the
   * launcher cannot tell "the user chose this image" from "nobody said", and the second case
   * would fail asking for a tag that does not exist.
   */
  imagePinned: boolean;
  /** Non-fatal validation findings, surfaced by `doctor` and `--verbose`. */
  warnings: string[];
  /** Which layer supplied each explicitly-configured leaf value (later layers win). */
  provenance?: ConfigProvenanceEntry[];
}

/**
 * The image a config that names none boots from (§12).
 *
 * Derived from the installed launcher rather than written down anywhere, which is what makes
 * `image` safe to leave out at all: a pin *is* allowed to go stale, and one sitting in a
 * machine-wide config would go stale on the next upgrade and outrank every repo that had not
 * pinned its own — an error naming an image, raised in a repo, caused by a file in a home
 * directory. `pi-pod init` leaves the image derived unless `--image` pins one explicitly;
 * `pi-pod image build` keeps an existing pin current.
 */
export function defaultImage(): string {
  return defaultImageRef(launcherVersion());
}

/** The pi-tui KeyId the chord prefix defaults to (§7). */
export const DEFAULT_CHORD_PREFIX = "ctrl+\\";

/**
 * One ending per /pod subcommand every client can run (§4).
 *
 * `shell` is deliberately unbound. This fork keeps the subcommand — a server session owns a
 * provider PTY, which is what it needs — but the CLI retired it, and these defaults travel to
 * every client inside the resolved launch config. A default binding for a command the CLI no
 * longer has would print "`shell` is no longer a pod command — this binding is ignored" on
 * every launch. `/pod shell` stays typeable where it is supported.
 */
export const DEFAULT_CHORD_BINDINGS: Record<string, string> = {
  d: "detach",
  a: "archive",
  s: "status",
  l: "list",
  w: "switch",
};

export const DEFAULT_CONFIG: Omit<PiPodConfig, "provider" | "image"> = {
  // Deliberately below spec §4.1's suggested 4 / 8 / 20, which was written without reference
  // to any provider's real quotas: a disk default can exceed a provider's per-sandbox cap and
  // make a scaffolded repo fail its very first `image build`. These
  // values sit clear of the default tier's limits and are ample for a clone plus
  // dependencies. A default that does not work out of the box is worse than a conservative
  // one — raise these if your org has higher limits (on providers that size per image, a
  // change derives a fresh tag on the next build/launch; no `--force` needed).
  resources: { cpu: 2, memoryGB: 4, diskGB: 5 },
  egress: { mode: "open", builtins: true, allow: [] },
  name: null,
  template: null,
  workdir: "/workspace",
  envFile: ".pi-pod/env",
  initScript: ".pi-pod/init.sh",
  bakeScript: ".pi-pod/bake.sh",
  initTimeoutSeconds: 600,
  initOnFailure: "abort",
  // A two-key prefix chord rather than a single key, because every single key worth pressing
  // is already bound inside pi — a single-key binding would have to be swallowed permanently.
  // A chord only *borrows* its prefix: a lone `Ctrl-\` is released to the editor intact, ahead
  // of the key that followed, the moment that key turns out not to be one of the endings.
  //
  // One ending per /pod subcommand, because a chord is defined as a keystroke alias for the
  // command and nothing more. The leave family is why the prefix exists at all: leaving a
  // session and being finished with a pod are different things, and only the user knows which
  // one this is. `d` walks away and leaves the pod running for `pi-pod attach`; `c` closes it
  // down (disk kept); `a` archives it (disk to cold storage). The last two are the fifteen
  // minutes of idle billing you would otherwise pay for knowing you were done — and neither is
  // destructive, so getting the choice wrong costs a slower `pi-pod attach` and nothing else
  // (§9). Stop keeps `c` from the byte-path era rather than taking `s`, which frees `s` for
  // status and avoids the stop/status/switch collision.
  //
  // The prefix is chosen to be one nothing binds. `Ctrl-\` is 0x1C, which no TUI uses, and raw
  // mode clears ISIG so it does not raise SIGQUIT either. `Ctrl-M` is the trap to avoid — it is
  // byte-identical to Enter (both 0x0D), so it would intercept every Enter press.
  //
  // hostConfig carries the host's pi settings and extension list by default, so a pod is the
  // pi you already use rather than a stranger's. What it will *not* do at any setting is sweep
  // the directory: skills and loose extensions are named one by one, and session transcripts
  // never travel at all (§7.5). The extension list is also baked into the image (§12) — a
  // session should not re-download the same few hundred megabytes every time.
  pi: {
    model: null,
    thinking: null,
    command: "pi",
    args: [],
    hostConfig: DEFAULT_HOST_CONFIG,
    chords: { enabled: true, prefix: DEFAULT_CHORD_PREFIX, bindings: DEFAULT_CHORD_BINDINGS },
    // On by default because the alternative is a terminal full of tabs all titled the same
    // thing. One ~50-token completion on the session's own model, once per fresh session.
    sessionNaming: "auto",
  },
  deniedProviders: [],
  // Off by default: a fresh pod per session is the documented contract. "reuse": true (or
  // --reuse) trades that for speed: the newest stopped pod for this repo+branch is started,
  // fast-forwarded, and re-inited on its warm disk; anything unsafe falls back to a fresh pod.
  reuse: false,
  // A detached pod is not free, and nobody remembers to clean up. The provider stops it
  // once its pi sessions have been quiet this long; stopping preserves the disk, so the clone
  // and any uncommitted work survive. 0 requests disabled auto-stop; a provider that requires
  // a deadline substitutes and reports its maximum instead (see capability findings).
  idleTimeoutMinutes: 15,
  // Minutes a provider-stopped pod may sit before it moves to restorable cold storage.
  archiveAfterMinutes: 60,
  labels: {},
  providers: {},
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
   * Kept alongside the rendered strings rather than replacing them, because the message is
   * what everything downstream prints and the path is only needed by one caller: `loadConfig`,
   * which uses it to say *which of the two config files* a finding came from. Empty where the
   * finding is not about a single key.
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
      if (!known.includes(key)) {
        const full = pathStr === "" ? key : `${pathStr}.${key}`;
        this.warn(full, `${full}: unknown key (ignored)`);
      }
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
  "provider",
  "image",
  "resources",
  "egress",
  "name",
  "template",
  "workdir",
  "envFile",
  "initScript",
  "bakeScript",
  "initTimeoutSeconds",
  "initOnFailure",
  "pi",
  "deniedProviders",
  "reuse",
  "idleTimeoutMinutes",
  "archiveAfterMinutes",
  "archiveAfterDays",
  "labels",
  "providers",
];

export interface ParsedConfigResult {
  config: PiPodConfig;
  warnings: string[];
  errors: string[];
  /** Config path per finding, positionally parallel to `errors` / `warnings`. */
  errorPaths: string[];
  warningPaths: string[];
  /** False when `image` was defaulted rather than named — see {@link LoadedConfig.imagePinned}. */
  imagePinned: boolean;
}

/** Validate + default an already-parsed config object. Exposed for unit tests. */
export function validateConfig(raw: unknown): ParsedConfigResult {
  const v = new Validator();
  const root = v.object("", raw);
  v.warnUnknownKeys("", root, TOP_LEVEL_KEYS);

  const d = DEFAULT_CONFIG;

  const resourcesRaw = v.object("resources", root["resources"]);
  v.warnUnknownKeys("resources", resourcesRaw, ["cpu", "memoryGB", "diskGB"]);

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
  v.warnUnknownKeys("pi.hostConfig", hostConfigRaw, ["settings", "packages", "skills", "extensions"]);

  const chordsRaw = v.object("pi.chords", piRaw["chords"]);
  v.warnUnknownKeys("pi.chords", chordsRaw, ["enabled", "prefix", "bindings"]);

  const providersRaw = v.object("providers", root["providers"]);
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [name, block] of Object.entries(providersRaw)) {
    // Blocks for other providers are ignored, so committed config stays valid across a
    // provider switch (§4.1). Only the shape is checked here; contents are the adapter's.
    providers[name] = v.object(`providers.${name}`, block);
  }

  const configuredArchiveMinutes =
    root["archiveAfterMinutes"] !== undefined
      ? v.int("archiveAfterMinutes", root["archiveAfterMinutes"], d.archiveAfterMinutes, { min: 0 })
      : root["archiveAfterDays"] !== undefined
        ? v.int("archiveAfterDays", root["archiveAfterDays"], 0, { min: 0 }) * 24 * 60
        : d.archiveAfterMinutes;
  if (root["archiveAfterMinutes"] !== undefined && root["archiveAfterDays"] !== undefined) {
    v.warn("archiveAfterDays", "archiveAfterDays is ignored when archiveAfterMinutes is set");
  }

  const config: PiPodConfig = {
    // "" means "nobody said": the CLI resolves it — flag, then this value, then whichever
    // provider the shell's API keys imply (auto-detection). Kept a plain string rather than
    // null so every consumer past that point still reads a concrete name.
    provider: v.string("provider", root["provider"], ""),
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
    envFile: v.string("envFile", root["envFile"], d.envFile),
    initScript: v.string("initScript", root["initScript"], d.initScript),
    bakeScript: v.string("bakeScript", root["bakeScript"], d.bakeScript),
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
        skills: v.stringArray("pi.hostConfig.skills", hostConfigRaw["skills"], d.pi.hostConfig.skills),
        extensions: v.stringArray(
          "pi.hostConfig.extensions",
          hostConfigRaw["extensions"],
          d.pi.hostConfig.extensions,
        ),
      },
      chords: parseChords(v, chordsRaw, d.pi.chords),
      sessionNaming: v.enumValue<SessionNaming>(
        "pi.sessionNaming",
        piRaw["sessionNaming"],
        ["auto", "off"],
        d.pi.sessionNaming,
      ),
    },
    deniedProviders: v.stringArray("deniedProviders", root["deniedProviders"], d.deniedProviders),
    reuse: v.bool("reuse", root["reuse"], d.reuse),
    // 0 is meaningful here (auto-stop off), so the floor is 0 rather than 1.
    idleTimeoutMinutes: v.int("idleTimeoutMinutes", root["idleTimeoutMinutes"], d.idleTimeoutMinutes, {
      min: 0,
    }),
    archiveAfterMinutes: configuredArchiveMinutes,
    labels: v.stringMap("labels", root["labels"], d.labels),
    providers,
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

  for (const [key, p] of [
    ["envFile", config.envFile],
    ["initScript", config.initScript],
    ["bakeScript", config.bakeScript],
  ] as const) {
    if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
      v.fail(key, `must be a relative path inside the project, got "${p}"`);
    }
  }

  // Archival is measured from the moment a pod *stops* (§9), and idle auto-stop is what
  // stops it. Turning auto-stop off therefore removes the trigger for archival as well: the
  // pod never goes quiet, never gets archived, and bills at the running rate until
  // someone runs `pi-pod gc`.
  if (config.idleTimeoutMinutes === 0) {
    v.warn(
      "idleTimeoutMinutes",
      "idleTimeoutMinutes: 0 requests disabled idle auto-stop. On providers that support it, " +
        "a detached pod runs (and bills) until `pi-pod gc`; providers requiring a deadline " +
        "report the effective maximum during preflight",
    );
  }

  // "open" leaves network policy to the provider; a stray allow list next to it is
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
 * `~/.pi-pod/config.json` never answers: the machine layer is deliberately the same name and
 * shape one level up (`userconfig.ts`), and adopting it would take `$HOME` for a project root.
 * The walk also stops *at* `$HOME` — a `.pi-pod/` above the home directory belongs to nobody's
 * project. Skipped whatever `--no-user-config` says: that flag drops the machine *layer*, it
 * does not promote the file to being some project's contract.
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

export interface LoadConfigOptions {
  cwd: string;
  /** Alternate repo config file (`--config`). The user layer still applies underneath it. */
  configPath?: string;
  /** Host home directory. Defaults to $HOME; a parameter so tests need no real one. */
  home?: string | undefined;
  /** False to ignore `~/.pi-pod/config.json` for this run (`--no-user-config`). */
  userConfig?: boolean;
}

export function loadConfig(opts: LoadConfigOptions): LoadedConfig {
  const explicit = opts.configPath ? path.resolve(opts.cwd, opts.configPath) : null;
  const configPath = explicit ?? findConfigPath(opts.cwd, { home: opts.home });

  // An explicitly named file that is not there is a typo, not a repo without a contract.
  if (explicit && !fs.existsSync(explicit)) {
    throw new PiPodError(`config file not found: ${explicit}`, {
      hint: "run `pi-pod init` to scaffold it",
    });
  }

  const repoRaw = configPath ? parseJsonc(fs.readFileSync(configPath, "utf8"), configPath) : null;

  // The machine-wide layer, read first and applied underneath. A parse error in it is fatal
  // rather than skipped: silently ignoring a file the user edited would mean their settings
  // stopped applying and nothing said so.
  const userPath = opts.userConfig === false ? null : userConfigPath(opts.home);
  const userRaw =
    userPath && fs.existsSync(userPath) ? parseJsonc(fs.readFileSync(userPath, "utf8"), userPath) : null;
  const activeUserPath = userRaw === null ? null : userPath;

  // Neither layer. The repo config used to be mandatory, which made "run pi-pod anywhere"
  // impossible even with a fully configured machine — so what is actually required is that
  // *something* said what a pod is, not that the repo did.
  if (repoRaw === null && userRaw === null) {
    throw new PiPodError(`no ${CONFIG_RELATIVE_PATH} found in ${opts.cwd} or any parent directory`, {
      hint:
        "run `pi-pod init` to scaffold it, or pass --config <path>.\n" +
        "A project needs no config of its own once ~/.pi-pod/config.json exists — this machine has none.",
    });
  }

  // A repo's legacy day spelling must still outrank a lower user-layer minute default.
  // Remove only that shadowing base key before the ordinary deep merge; validation below
  // remains responsible for conversion and the deprecation warning.
  const repoLayer = (repoRaw ?? null) as Record<string, unknown> | null;
  const userLayer = (userRaw ?? null) as Record<string, unknown> | null;
  const repoUsesLegacyArchive =
    repoLayer !== null && "archiveAfterDays" in repoLayer && !("archiveAfterMinutes" in repoLayer);
  const userMergeBase =
    userLayer !== null && repoUsesLegacyArchive
      ? Object.fromEntries(Object.entries(userLayer).filter(([key]) => key !== "archiveAfterMinutes"))
      : userLayer;
  const merged = userMergeBase === null ? repoLayer : mergeConfigLayers(userMergeBase, repoLayer ?? {});
  const { config, warnings, errors, errorPaths, warningPaths, imagePinned } = validateConfig(merged);

  // Which file a finding is about. With one layer that is never in doubt and the message stays
  // as it always was; with two, the value that failed may have come from either file, and an
  // error naming the wrong one sends someone to read a file that is already correct.
  const attribute = (message: string, findingPath: string): string => {
    if (activeUserPath === null || configPath === null) return message;
    const layer = layerOf(findingPath, { user: userRaw, repo: repoRaw });
    if (layer === null) return message;
    const file = layer === "user" ? displayPath(activeUserPath, opts.home) : configPath;
    return `${message}  (from ${file})`;
  };

  if (errors.length > 0) {
    const lines = errors.map((e, i) => `  - ${attribute(e, errorPaths[i] ?? "")}`).join("\n");
    const source =
      configPath === null
        ? displayPath(activeUserPath!, opts.home)
        : activeUserPath === null
          ? configPath
          : `${configPath}, layered over ${displayPath(activeUserPath, opts.home)}`;
    throw new PiPodError(`invalid config (${source}):\n${lines}`, {
      hint: "the full field reference is in the comments of ~/.pi-pod/config.json and in pi-pod's docs/reference.md",
    });
  }

  // The project root is the directory containing `.pi-pod/` when the config lives there;
  // with --config pointing elsewhere (or no project config at all), it is the cwd. Everything
  // downstream reads paths relative to it (the env file, the init script, the project `.pi/`).
  const configDir = configPath === null ? null : path.dirname(configPath);
  const projectRoot =
    configDir === null
      ? path.resolve(opts.cwd)
      : path.basename(configDir) === CONFIG_DIR
        ? path.dirname(configDir)
        : path.resolve(opts.cwd);

  return {
    config,
    configPath,
    userConfigPath: activeUserPath,
    imagePinned,
    projectRoot,
    warnings: warnings.map((w, i) => attribute(w, warningPaths[i] ?? "")),
    provenance: configProvenance([
      { name: "machine", raw: userMergeBase },
      { name: "project", raw: repoLayer },
    ]),
  };
}
