/**
 * `~/.pi-pod/` client state. config.json holds client preferences only; pod settings live in
 * organization, template, and project layers. This module also retains generic deep-merge and
 * provenance helpers shared with config validation and historical callers.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hostHome } from "./hostconfig.js";
import { packageRoot } from "./image.js";

/** Same name as the repo directory, one level up in the hierarchy — deliberately. */
export const USER_CONFIG_DIR = ".pi-pod";
export const USER_CONFIG_FILE = "config.json";

/** Server-scope sync files (`org.env`, `user.env`, `template-<name>.env`), mode 600. */
export const USER_SECRETS_DIR = "secrets";

/** The packaged template `~/.pi-pod/` starts life as. */
export const USER_CONFIG_TEMPLATE_PATH = ["templates", "user-config.jsonc"] as const;

/** The retired machine secrets layer — read only to warn a migrator, never as a source. */
const LEGACY_USER_ENV_FILE = "env";

export function userConfigDir(home?: string | undefined): string | null {
  const resolved = hostHome(home);
  return resolved ? path.join(resolved, USER_CONFIG_DIR) : null;
}

export function userConfigPath(home?: string | undefined): string | null {
  const dir = userConfigDir(home);
  return dir ? path.join(dir, USER_CONFIG_FILE) : null;
}

export function userSecretsDir(home?: string | undefined): string | null {
  const dir = userConfigDir(home);
  return dir ? path.join(dir, USER_SECRETS_DIR) : null;
}

/**
 * A warning when `~/.pi-pod/env` still holds keys. The machine secrets layer is gone: its
 * job is done by the synced `user` scope (or a project env file). The file is never read as
 * a secret source and never deleted — only the person who put keys in it knows which scope
 * each one belongs in. Empty and comments-only files are ignored.
 */
export function legacyUserEnvWarning(home?: string | undefined): string | null {
  const dir = userConfigDir(home);
  if (!dir) return null;
  const file = path.join(dir, LEGACY_USER_ENV_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const names = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => (line.startsWith("export ") ? line.slice(7).trim() : line))
    .filter((line) => {
      const eq = line.indexOf("=");
      return eq > 0 && line.slice(eq + 1).trim() !== "";
    })
    .map((line) => line.slice(0, line.indexOf("=")).trim());
  if (names.length === 0) return null;
  return (
    `${displayPath(file, home)} is no longer read (${names.join(", ")}) — move each value into ` +
    `~/.pi-pod/secrets/user.env and run \`pipod secrets sync user\`, or into a project .pi-pod/env, ` +
    `then delete the file`
  );
}

/**
 * A packaged template's contents, or null when the file is missing.
 *
 * Static assets rather than strings built from {@link DEFAULT_CONFIG}, because the install hook
 * has to write them before `dist/` exists — `npm install` in a source checkout runs
 * `postinstall` before the build. Drift between template and defaults is caught by a unit test
 * that parses the config template and compares it against the built-in defaults, which is a
 * better place for that check than the install path anyway.
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
 * Create `~/.pi-pod/` if it is not there: the config, and the secrets sync directory.
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

  const created: string[] = [];
  if (!fs.existsSync(target)) {
    const template = readTemplate(USER_CONFIG_TEMPLATE_PATH);
    if (template !== null) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        // wx: two pi pod invocations racing here must not have one clobber the other's file.
        fs.writeFileSync(target, template, { flag: "wx", mode: 0o644 });
        fs.chmodSync(target, 0o644);
        created.push(target);
      } catch {
        // Already there, or a home directory we cannot write. Neither stops a session.
      }
    }
  }

  // Mode 700 like the files it will hold: `secrets sync` should never find its default
  // directory missing, and never find it world-readable either.
  try {
    fs.mkdirSync(path.join(dir, USER_SECRETS_DIR), { recursive: true, mode: 0o700 });
  } catch {
    // Same tolerance as above.
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
 * Layers that agree are not reported as overriding each other because nothing was lost.
 */
export function configProvenance(
  layers: Array<{ name: string; raw: unknown }>,
): ConfigProvenanceEntry[] {
  const entries = new Map<string, { winner: string; value: string; over: string[] }>();
  const visit = (name: string, value: unknown, path: string): void => {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        visit(name, child, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    const serialized = JSON.stringify(value) ?? "undefined";
    const existing = entries.get(path);
    if (!existing) {
      entries.set(path, { winner: name, value: serialized, over: [] });
      return;
    }
    if (existing.winner !== name && existing.value !== serialized) existing.over.push(existing.winner);
    existing.winner = name;
    existing.value = serialized;
  };
  for (const layer of layers) {
    if (layer.raw == null || !isPlainObject(layer.raw)) continue;
    visit(layer.name, layer.raw, "");
  }
  return [...entries.entries()].map(([path, e]) => ({ path, winner: e.winner, over: e.over }));
}
