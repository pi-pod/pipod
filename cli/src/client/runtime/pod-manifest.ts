/**
 * src/client/runtime/pod-manifest.ts — LocalTuiManifestV1 validation.
 *
 * The pod's manifest is agent-writable data: everything here is validated as untrusted
 * input before it can influence the local TUI. The `uiSettings` schema below IS the
 * filtering — there is no separate allowlist subsystem. Command-, path-, and code-valued
 * pi settings keys (externalEditor, shellPath, shellCommandPrefix, npmCommand, packages,
 * hooks, MCP config) are simply not fields, so they never cross, whatever the pod sends.
 * New pi settings default to not-synced; adding one here is a value-shape review.
 */

export const POD_MANIFEST_MAX_THEMES = 20;
export const POD_MANIFEST_MAX_EXTENSIONS = 100;
export const POD_MANIFEST_MAX_DIAGNOSTICS = 50;
export const POD_MANIFEST_MAX_ARGV = 64;

/** A theme file name the derived agent dir will write: one safe path segment, no dotfiles. */
export const SAFE_THEME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PodThemeFile {
  name: string;
  theme: Record<string, unknown>;
}

/** Directly configured npm package identity; the wire key remains `extensions` for compatibility. */
export interface PodExtensionIdentity {
  name: string;
  version: string;
}

export interface PodTuiManifest {
  digest: string;
  bootDigest: string | null;
  launchArgv: string[];
  /** The validated display-key projection, ready to overlay on host settings. */
  uiSettings: Record<string, unknown>;
  themes: PodThemeFile[];
  /** Direct package identities used to detect extension-rendering drift. */
  extensions: PodExtensionIdentity[];
  diagnostics: string[];
}

type FieldValidator = (value: unknown) => unknown;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function cleanString(max: number): FieldValidator {
  return (value) =>
    typeof value === "string" && value.length > 0 && value.length <= max && !hasControlChars(value)
      ? value
      : undefined;
}

const bool: FieldValidator = (value) => (value === true || value === false ? value : undefined);

function intIn(min: number, max: number): FieldValidator {
  return (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      ? value
      : undefined;
}

function oneOf(...allowed: unknown[]): FieldValidator {
  return (value) => (allowed.includes(value) ? value : undefined);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function subObject(fields: Record<string, FieldValidator>): FieldValidator {
  return (value) => {
    if (!isPlainObject(value)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, validate] of Object.entries(fields)) {
      if (value[key] === undefined) continue;
      const sanitized = validate(value[key]);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
}

/**
 * The display-safe projection of pi's Settings, field by field. Every value shape is pinned:
 * a pod cannot smuggle an object where a boolean belongs or an unbounded string anywhere.
 */
const UI_SETTINGS_SCHEMA: Record<string, FieldValidator> = {
  // May be a plain name or pi's "light/dark" auto pair.
  theme: cleanString(128),
  hideThinkingBlock: bool,
  showCacheMissNotices: bool,
  quietStartup: bool,
  collapseChangelog: bool,
  showHardwareCursor: bool,
  doubleEscapeAction: oneOf("fork", "tree", "none"),
  treeFilterMode: oneOf("default", "no-tools", "user-only", "labeled-only", "all"),
  editorPaddingX: intIn(0, 32),
  outputPad: oneOf(0, 1),
  autocompleteMaxVisible: intIn(1, 50),
  markdown: subObject({
    codeBlockIndent: (value) =>
      typeof value === "string" && value.length <= 8 && /^[ \t]*$/.test(value) ? value : undefined,
    mermaid: oneOf("off", "final", "streaming"),
  }),
  terminal: subObject({
    showImages: bool,
    imageWidthCells: intIn(1, 500),
    clearOnShrink: bool,
    showTerminalProgress: bool,
  }),
  images: subObject({ autoResize: bool, blockImages: bool }),
  warnings: subObject({ anthropicExtraUsage: bool }),
  tuiMode: oneOf("regular", "fullscreen"),
  fullscreenExitOutput: oneOf("transcript", "resume-hint"),
  fullscreenScrollbar: oneOf("hidden", "auto", "always"),
};

export function validateUiSettings(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, validate] of Object.entries(UI_SETTINGS_SCHEMA)) {
    if (value[key] === undefined) continue;
    const sanitized = validate(value[key]);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

const MAX_THEME_ENTRIES = 120;
const themeValue: FieldValidator = (value) => {
  if (typeof value === "string") return cleanString(64)(value);
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;
  return undefined;
};

function sanitizeThemeMap(value: unknown, keyPattern: RegExp): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_THEME_ENTRIES) return null;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    if (!keyPattern.test(key)) return null;
    const sanitized = themeValue(raw);
    if (sanitized === undefined) return null;
    out[key] = sanitized;
  }
  return out;
}

/**
 * A theme is pure data: `{name, colors, vars?}` per pi's theme file format. Anything that
 * fails a shape check drops the whole theme — a partially-hostile theme has no safe half.
 */
export function validatePodTheme(name: unknown, theme: unknown): PodThemeFile | null {
  if (typeof name !== "string" || !SAFE_THEME_NAME.test(name)) return null;
  if (!isPlainObject(theme)) return null;
  const colors = sanitizeThemeMap(theme["colors"], /^[A-Za-z][A-Za-z0-9]{0,63}$/);
  if (colors === null || Object.keys(colors).length === 0) return null;
  const sanitized: Record<string, unknown> = { name, colors };
  if (theme["vars"] !== undefined) {
    const vars = sanitizeThemeMap(theme["vars"], /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
    if (vars === null) return null;
    if (Object.keys(vars).length > 0) sanitized["vars"] = vars;
  }
  return { name, theme: sanitized };
}

const DIGEST_PATTERN = /^[A-Za-z0-9]{8,64}$/;

function validateDigest(value: unknown): string | null {
  return typeof value === "string" && DIGEST_PATTERN.test(value) ? value : null;
}

const extensionName = cleanString(214);
const extensionVersion = cleanString(64);

/**
 * Validate one `tui_manifest` gateway frame into a typed manifest. Returns null when the
 * frame cannot be a manifest at all; individually malformed entries degrade to local
 * diagnostics instead of discarding the rest.
 */
export function validatePodTuiManifest(frame: {
  digest?: string | undefined;
  manifest?: Record<string, unknown> | undefined;
}): PodTuiManifest | null {
  const digest = validateDigest(frame.digest);
  if (digest === null || !isPlainObject(frame.manifest)) return null;
  const raw = frame.manifest;

  const diagnostics: string[] = [];
  if (Array.isArray(raw["diagnostics"])) {
    for (const entry of raw["diagnostics"].slice(0, POD_MANIFEST_MAX_DIAGNOSTICS)) {
      if (typeof entry === "string" && !hasControlChars(entry)) diagnostics.push(entry.slice(0, 300));
    }
  }

  const launchArgv: string[] = [];
  if (Array.isArray(raw["launchArgv"])) {
    for (const entry of raw["launchArgv"].slice(0, POD_MANIFEST_MAX_ARGV)) {
      if (typeof entry === "string" && entry.length <= 4096) launchArgv.push(entry);
    }
  }

  const themes: PodThemeFile[] = [];
  const seenThemeNames = new Set<string>();
  if (Array.isArray(raw["themes"])) {
    for (const entry of raw["themes"].slice(0, POD_MANIFEST_MAX_THEMES)) {
      if (!isPlainObject(entry)) continue;
      const theme = validatePodTheme(entry["name"], entry["theme"]);
      if (theme === null) {
        diagnostics.push(`theme ${JSON.stringify(entry["name"]).slice(0, 80)} failed validation and was dropped`);
        continue;
      }
      if (seenThemeNames.has(theme.name)) continue;
      seenThemeNames.add(theme.name);
      themes.push(theme);
    }
  }

  const extensions: PodExtensionIdentity[] = [];
  if (Array.isArray(raw["extensions"])) {
    for (const entry of raw["extensions"].slice(0, POD_MANIFEST_MAX_EXTENSIONS)) {
      if (!isPlainObject(entry)) continue;
      const name = extensionName(entry["name"]);
      const version = extensionVersion(entry["version"]);
      if (name === undefined || version === undefined) continue;
      if (/\s/.test(name as string) || /\s/.test(version as string)) continue;
      extensions.push({ name: name as string, version: version as string });
    }
  }

  return {
    digest,
    bootDigest: validateDigest(raw["bootDigest"]),
    launchArgv,
    uiSettings: validateUiSettings(raw["uiSettings"]),
    themes,
    extensions,
    diagnostics,
  };
}
