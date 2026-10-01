/**
 * src/client/runtime/pod-derived-config.ts — file-based materialization of pod TUI config.
 *
 * Two layers, per the pod-derived-tui-config plan: an immutable digest-keyed raw cache
 * shared by every launcher on this machine, and a throwaway per-launcher derived agent dir
 * that pi's own `SettingsManager.create(cwd, agentDir)` and theme loader read. The boundary
 * with pi stays at the filesystem: no proxies, no reach into pi's storage classes. Writes pi
 * makes (settings changes, model defaults) land in the derived dir and die with the session,
 * which is what makes them session-local.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOST_PI_AGENT_SUBPATH, hostHome } from "../../hostconfig.js";
import { SAFE_THEME_NAME, validatePodTuiManifest, type PodTuiManifest } from "./pod-manifest.js";

const CACHED_MANIFEST_MAX_BYTES = 1024 * 1024;

export function defaultPodCacheRoot(home?: string): string | null {
  const resolved = hostHome(home);
  return resolved ? path.join(resolved, ".pi", "pod-cache") : null;
}

export function defaultHostAgentDir(home?: string): string | null {
  const resolved = hostHome(home);
  return resolved ? path.join(resolved, HOST_PI_AGENT_SUBPATH) : null;
}

/** One safe path segment for cache layout; never trusts server host or pod id spelling. */
export function sanitizeCacheSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return (cleaned.length === 0 ? "_" : cleaned).slice(0, 128);
}

export function manifestCacheDir(cacheRoot: string, serverHost: string, podId: string): string {
  return path.join(cacheRoot, sanitizeCacheSegment(serverHost), sanitizeCacheSegment(podId), "manifest");
}

function writeFileAtomic(target: string, contents: string): void {
  const tmp = `${target}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

/**
 * Write-once: a digest entry that already carries its completion marker is never rewritten,
 * so concurrent launchers on the same pod can share the cache without coordination.
 */
export function writeManifestCache(dir: string, manifest: PodTuiManifest): void {
  const entry = path.join(dir, sanitizeCacheSegment(manifest.digest));
  fs.mkdirSync(entry, { recursive: true, mode: 0o700 });
  const done = path.join(entry, "complete");
  if (!fs.existsSync(done)) {
    writeFileAtomic(path.join(entry, "manifest.json"), JSON.stringify(manifest));
    writeFileAtomic(done, "");
  }
  writeFileAtomic(path.join(dir, "latest"), manifest.digest);
}

/** Read a completed cache entry back, re-validating: cache contents are still just files. */
export function readManifestCache(dir: string, digest?: string): PodTuiManifest | null {
  try {
    let wanted = digest;
    if (wanted === undefined) {
      const latest = fs.readFileSync(path.join(dir, "latest"), "utf8").trim();
      if (latest.length === 0) return null;
      wanted = latest;
    }
    const entry = path.join(dir, sanitizeCacheSegment(wanted));
    if (!fs.existsSync(path.join(entry, "complete"))) return null;
    const target = path.join(entry, "manifest.json");
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > CACHED_MANIFEST_MAX_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as PodTuiManifest;
    return validatePodTuiManifest({
      digest: parsed.digest,
      manifest: {
        bootDigest: parsed.bootDigest,
        launchArgv: parsed.launchArgv,
        uiSettings: parsed.uiSettings,
        themes: parsed.themes,
        extensions: parsed.extensions,
        diagnostics: parsed.diagnostics,
      },
    });
  } catch {
    return null;
  }
}

export interface DerivedPodConfig {
  /** Per-launcher agent dir for `SettingsManager.create` — pod projection over host prefs. */
  agentDir: string;
  /** Synthetic empty project dir: kills the implicit host-project settings merge. */
  settingsCwd: string;
  /** Where validated pod theme JSON lands for pi's theme loader. */
  themesDir: string;
  /** Rewrite contents in place (paths never change); null falls back to host-only settings. */
  refresh(manifest: PodTuiManifest | null): void;
  dispose(): void;
}

function readHostSettings(hostAgentDir: string | null): Record<string, unknown> {
  if (hostAgentDir === null) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(hostAgentDir, "settings.json"), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Create the per-launcher derived agent dir. The settings file is the host's global
 * settings with the pod's validated `uiSettings` projection layered on top: host-only
 * concerns (externalEditor and friends — the *user's* own values) survive, pod display
 * preferences win, and hostile pod values can never reach the host-only keys because the
 * projection schema has no such fields.
 */
export function createDerivedPodConfig(opts: {
  cacheRoot: string;
  hostAgentDir: string | null;
}): DerivedPodConfig {
  const agentDir = path.join(
    opts.cacheRoot,
    "derived",
    `${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  const themesDir = path.join(agentDir, "themes");
  const settingsCwd = path.join(agentDir, "project");
  fs.mkdirSync(themesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(settingsCwd, { recursive: true, mode: 0o700 });
  fs.chmodSync(agentDir, 0o700);

  const refresh = (manifest: PodTuiManifest | null): void => {
    const host = readHostSettings(opts.hostAgentDir);
    const merged = manifest ? { ...host, ...manifest.uiSettings } : host;
    writeFileAtomic(path.join(agentDir, "settings.json"), `${JSON.stringify(merged, null, 2)}\n`);

    const wanted = new Map((manifest?.themes ?? []).map((theme) => [`${theme.name}.json`, theme]));
    for (const existing of fs.readdirSync(themesDir)) {
      if (!wanted.has(existing)) fs.rmSync(path.join(themesDir, existing), { force: true });
    }
    for (const [file, theme] of wanted) {
      if (!SAFE_THEME_NAME.test(theme.name)) continue;
      writeFileAtomic(path.join(themesDir, file), `${JSON.stringify(theme.theme, null, 2)}\n`);
    }
  };

  return {
    agentDir,
    settingsCwd,
    themesDir,
    refresh,
    dispose: () => {
      fs.rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Pod themes through pi's own loader
// ---------------------------------------------------------------------------

interface ThemeDiagnostic {
  type: "error";
  message: string;
  path?: string;
}

export interface PodThemeLoader {
  load(themesDir: string): { themes: unknown[]; diagnostics: ThemeDiagnostic[] };
}

/**
 * Pi's `loadThemeFromPath` parses and constructs a Theme exactly the way pi itself does,
 * defaults and validation included. It is not re-exported from pi's public entry, so this is
 * a deep import of the same module instance pi's dist uses — asserted by the surface canary
 * (scripts/check-runtime-surface.ts) so a pi upgrade that moves it fails loudly at lint.
 */
export async function loadPodThemeLoader(): Promise<PodThemeLoader | null> {
  try {
    const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const themeModule = (await import(new URL("modes/interactive/theme/theme.js", entryUrl).href)) as {
      loadThemeFromPath?: (themePath: string) => unknown;
    };
    const loadThemeFromPath = themeModule.loadThemeFromPath;
    if (typeof loadThemeFromPath !== "function") return null;
    return {
      load: (themesDir) => {
        const themes: unknown[] = [];
        const diagnostics: ThemeDiagnostic[] = [];
        let files: string[] = [];
        try {
          files = fs.readdirSync(themesDir).filter((file) => file.endsWith(".json")).sort();
        } catch {
          return { themes, diagnostics };
        }
        for (const file of files) {
          const full = path.join(themesDir, file);
          try {
            themes.push(loadThemeFromPath(full));
          } catch (error) {
            diagnostics.push({
              type: "error",
              message: `pod theme ${file}: ${error instanceof Error ? error.message : String(error)}`,
              path: full,
            });
          }
        }
        return { themes, diagnostics };
      },
    };
  } catch {
    return null;
  }
}
