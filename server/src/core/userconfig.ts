/**
 * src/userconfig.ts — the machine-wide settings layer, `~/.pi-pod/config.json`.
 *
 * Everything in `.pi-pod/` is a *repo* contract: committed, reviewable, the same for everyone
 * who clones it. That is the right default and it stays the default — but it leaves nowhere to
 * put the settings that are about the person rather than the project. Detach chords, an idle
 * window you are willing to pay for, the sizing your provider account actually allows: today
 * those are re-typed into every repo, and a repo that omits one silently gets pi-pod's built-in
 * answer instead of yours.
 *
 * So there are two layers, and exactly two:
 *
 *  1. `~/.pi-pod/config.json` — written at install time, seeded with pi-pod's own defaults.
 *  2. `<repo>/.pi-pod/config.json` — the committed contract, applied on top.
 *
 * The repo wins on every key it sets, per key rather than per file, so a repo that pins one
 * value does not silently discard the rest of your setup (§4.1). What it cannot do is *add* to
 * an array: a repo's `egress.allow` is that repo's whole allowlist, because the alternative —
 * a committed list that means something different on every laptop — is the opposite of what a
 * committed egress policy is for.
 *
 * The repo layer is an optional overlay: a machine-level ~/.pi-pod/config.json alone is
 * enough to launch. Only a machine with neither layer errors — a user-level file that can
 * launch pods in any directory is the point of the machine layer, not a decision taken away
 * from every repo.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hostHome } from "./hostconfig.js";
import { packageRoot } from "./image.js";

/** Same name as the repo directory, one level up in the hierarchy — deliberately. */
export const USER_CONFIG_DIR = ".pi-pod";
export const USER_CONFIG_FILE = "config.json";

/**
 * The machine-wide secrets file, the sibling of a repo's `.pi-pod/env` (§4.2).
 *
 * Same reasoning as the config layer, and the same precedence: keys here reach every pod this
 * machine launches, and a repo's own `env` overrides them key by key. It exists because the
 * alternative was writing `ANTHROPIC_API_KEY` into a fresh `.pi-pod/env` in every repo, and
 * because local-mode pi-pod already carries credentials off this machine by default — the
 * shell's provider keys and a sanitized `~/.pi/agent/auth.json`. A file you can read is a
 * better place for that than an environment you have to remember exporting.
 *
 * What it does not get is the shell-carry filter. Host provider keys are narrowed to names pi
 * itself recognizes (§7.7); this file is verbatim, so an unrelated secret written here really
 * does travel. That is the one new exposure, and it is why preflight names every key from it on
 * every run, exactly as it does for the repo's file.
 */
export const USER_ENV_FILE = "env";

/** The packaged templates `~/.pi-pod/` starts life as. */
export const USER_CONFIG_TEMPLATE_PATH = ["templates", "user-config.jsonc"] as const;
export const USER_ENV_TEMPLATE_PATH = ["templates", "user-env"] as const;

export function userConfigDir(home?: string | undefined): string | null {
  const resolved = hostHome(home);
  return resolved ? path.join(resolved, USER_CONFIG_DIR) : null;
}

export function userConfigPath(home?: string | undefined): string | null {
  const dir = userConfigDir(home);
  return dir ? path.join(dir, USER_CONFIG_FILE) : null;
}

export function userEnvPath(home?: string | undefined): string | null {
  const dir = userConfigDir(home);
  return dir ? path.join(dir, USER_ENV_FILE) : null;
}

/**
 * A packaged template's contents, or null when the file is missing.
 *
 * Static assets rather than strings built from {@link DEFAULT_CONFIG}, because the install hook
 * has to write them before `dist/` exists — `npm install` in a source checkout runs
 * `postinstall` before the build.
 */
export function readTemplate(relative: readonly string[]): string | null {
  try {
    return fs.readFileSync(path.join(packageRoot(), ...relative), "utf8");
  } catch {
    return null;
  }
}

export function readUserConfigTemplate(): string | null {
  return readTemplate(USER_CONFIG_TEMPLATE_PATH);
}

export interface EnsureUserConfigResult {
  /** Absolute path of the config, or null when there is no home directory to put it in. */
  path: string | null;
  /** Files this call actually wrote — the caller announces a real side effect, once. */
  created: string[];
}

/**
 * Create `~/.pi-pod/` if it is not there: the config, and the env file beside it.
 *
 * Idempotent and never destructive: existing files are left exactly as the user left them, with
 * no `--force` to say otherwise — clobbering real keys is not a thing an install hook should be
 * able to do. This runs at install time *and* at the top of every command, because the install
 * hook is the one part of this that a `--ignore-scripts` install, a `npm link` from a checkout,
 * or a copied binary can skip.
 *
 * Never throws. A read-only home directory is a reason to run without a user layer, not a
 * reason a session cannot start.
 */
export function ensureUserConfig(opts: { home?: string | undefined } = {}): EnsureUserConfigResult {
  const dir = userConfigDir(opts.home);
  const target = userConfigPath(opts.home);
  if (!dir || !target) return { path: null, created: [] };

  const files: Array<{ path: string; template: readonly string[]; mode: number }> = [
    { path: target, template: USER_CONFIG_TEMPLATE_PATH, mode: 0o644 },
    // Mode 600 from the moment it exists, like `pi-pod init`'s `.pi-pod/env`: an empty secrets
    // file with the right permissions is the difference between a user pasting a key into it
    // and a user creating it themselves, wide open, and never noticing.
    { path: path.join(dir, USER_ENV_FILE), template: USER_ENV_TEMPLATE_PATH, mode: 0o600 },
  ];

  const created: string[] = [];
  for (const file of files) {
    if (fs.existsSync(file.path)) continue;
    const template = readTemplate(file.template);
    if (template === null) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // wx: two pi-pod invocations racing here must not have one clobber the other's file.
      fs.writeFileSync(file.path, template, { flag: "wx", mode: file.mode });
      fs.chmodSync(file.path, file.mode);
      created.push(file.path);
    } catch {
      // Already there, or a home directory we cannot write. Neither stops a session.
    }
  }

  return { path: target, created };
}

/** `/Users/x/.pi-pod/config.json` → `~/.pi-pod/config.json`, for messages. */
export function displayPath(target: string, home?: string | undefined): string {
  const resolved = hostHome(home);
  if (!resolved) return target;
  const rel = path.relative(resolved, target);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? target : path.join("~", rel);
}

/**
 * Merge one config layer over another, per key, all the way down.
 *
 * Objects recurse; everything else is replaced by the override, including `null` (which is a
 * real value here — `repo.branch: null` means "the branch the host is on") and arrays. Arrays
 * replacing rather than concatenating is the one rule worth stating out loud: an `egress.allow`
 * that meant "these hosts, plus whatever is in the reader's home directory" would make a
 * committed allowlist unreviewable.
 */
export function mergeConfigLayers(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;

  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = Object.hasOwn(base, key) ? mergeConfigLayers(base[key], value) : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Which layer set a config path, for attributing a validation error to the file that caused it.
 *
 * The whole point of a merged config is that the value pi-pod validated may have come from
 * either file, and an error that names the repo's config while the mistake is in the user's is
 * worse than one that names neither: it sends someone reading a file that is already correct.
 *
 * Array indices are stripped — `egress.allow[2]` is attributed to whichever layer supplied
 * `egress.allow`, which is the whole array either way.
 */
export function layerOf(
  configPath: string,
  layers: { user: unknown; repo: unknown },
): "user" | "repo" | null {
  if (configPath === "") return null;
  const keys = configPath
    .split(".")
    .map((segment) => segment.replace(/\[\d+\]$/, ""))
    .filter((segment) => segment !== "");

  if (resolve(layers.repo, keys) !== undefined) return "repo";
  if (resolve(layers.user, keys) !== undefined) return "user";
  return null;
}

function resolve(root: unknown, keys: string[]): unknown {
  let current = root;
  for (const key of keys) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** One explicitly-configured leaf value and which layer's setting of it won. */
export interface ConfigProvenanceEntry {
  /** Dotted config path, e.g. `pi.model` or `egress.allow`. Arrays are one leaf. */
  path: string;
  /** The last layer that set this path — the value the merged config carries. */
  winner: string;
  /** Earlier layers whose different explicit values were overridden, oldest first. */
  over: string[];
}

/**
 * Per-leaf provenance across ordered config layers (earliest first, later wins), matching
 * {@link mergeConfigLayers} semantics: objects recurse, arrays and scalars are leaves.
 *
 * This is the transparency half of an ordered hierarchy: a dry run must identify each
 * effective value and what it displaced. Callers pass the unified org/template/project chain;
 * layers that agree are not reported as overriding each other because nothing was lost.
 */
export function configProvenance(
  layers: Array<{ name: string; raw: unknown }>,
): ConfigProvenanceEntry[] {
  const entries = new Map<string, Array<{ name: string; value: string }>>();
  const visit = (name: string, value: unknown, path: string): void => {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        visit(name, child, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    const serialized = JSON.stringify(value) ?? "undefined";
    const declarations = entries.get(path) ?? [];
    declarations.push({ name, value: serialized });
    entries.set(path, declarations);
  };
  for (const layer of layers) {
    if (layer.raw == null || !isPlainObject(layer.raw)) continue;
    visit(layer.name, layer.raw, "");
  }
  return [...entries.entries()].map(([path, declarations]) => {
    const winner = declarations.at(-1)!;
    return {
      path,
      winner: winner.name,
      over: declarations.slice(0, -1)
        .filter((declaration) => declaration.value !== winner.value)
        .map((declaration) => declaration.name),
    };
  });
}
