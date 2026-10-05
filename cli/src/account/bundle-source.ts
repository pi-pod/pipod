import * as fs from "node:fs";
import * as path from "node:path";
import { CLIENT_ONLY_PI_KEYS, CONFIG_DIR, findConfigPath, PROJECT_BAKE_SCRIPT, PROJECT_ENV_FILE, PROJECT_INIT_SCRIPT, nonBundleKeysFound, stripNonBundleKeys, validateConfig } from "../config.js";
import { parseDotenv } from "../dotenv.js";
import { PiPodError } from "../errors.js";
import { HOST_PI_AGENT_SUBPATH, filterSettings, hostHome, sanitizeModelsForTransport } from "../hostconfig.js";
import { parseJsonc } from "../jsonc.js";
import { isProviderCredentialVar } from "../providers/registry.js";
import { mergeSecretResolver, resolveSecretRefs, type SecretResolverConfig } from "../secret-refs.js";
import { mergeConfigLayers, userConfigPath } from "../userconfig.js";
import type { ApiSettingsBundle, ApiTemplate, PiSettingsFilesBody } from "./api.js";
import {
  readHostConfig,
  readSecretResolverLayers,
  takeClientOnlyKeys,
} from "./launch-overlays.js";

export type BundleSourceKind = "project" | "user-dir" | "org-dir";
export type EnvSnapshot = Record<string, { value: string; source: string }>;

/** Where each source kind keeps its Pi files, relative to the source root. */
const PI_SUBPATH: Record<BundleSourceKind, string> = {
  // Project scope is `<repo>/.pi/` (Pi's project tree). User-directory scope is
  // `~/.pi/agent/` (Pi's global tree). `$HOME/.pi/settings.json` is not a path Pi reads.
  project: ".pi",
  "user-dir": HOST_PI_AGENT_SUBPATH,
  "org-dir": "pi",
};

export const ORG_SOURCE_SUBDIR = path.join(".pi-pod", "org");

export interface CompiledBundleSource {
  kind: BundleSourceKind;
  config: Record<string, unknown>;
  initScript: string;
  bakeScript: string;
  piFiles: PiSettingsFilesBody;
  env: EnvSnapshot;
  warnings: string[];
  name: string;
  templateRef: string | null;
  projectRoot: string | null;
  /** The directory the source files were read from: project root, home, or the org dir. */
  root: string;
  configPath: string;
}

function parseConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed = parseJsonc(fs.readFileSync(file, "utf8"), file);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PiPodError(`${file} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** `~/.pi-pod/org/` unless the caller keeps the org source elsewhere (say, in a repo). */
export function orgSourceDir(args: { dir?: string | undefined; home?: string | undefined }): string {
  if (args.dir) return path.resolve(args.dir);
  const home = hostHome(args.home);
  if (!home) throw new PiPodError("cannot locate ~/.pi-pod/org: HOME is unset", { hint: "pass --dir <path>" });
  return path.join(home, ORG_SOURCE_SUBDIR);
}

function safePiDir(root: string, subpath: string): string | null {
  const directory = path.join(root, subpath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PiPodError(`${directory} must be a real directory, not a symlink`);
  }
  return directory;
}

function safePiFile(
  root: string,
  subpath: string,
  name: "settings.json" | "models.json" | "mcporter.json" | "subagents.json",
): string | null {
  const directory = safePiDir(root, subpath);
  if (!directory) return null;
  const file = path.join(directory, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new PiPodError(`${file} must be a regular file, not a symlink`);
  const realRoot = fs.realpathSync(root);
  const relative = path.relative(realRoot, fs.realpathSync(file));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PiPodError(`${file} resolves outside the source directory`);
  }
  return file;
}

/** Read regular UTF-8 agent files without following symlinks. */
function readPiAgentsDirectory(
  directory: string,
  label: string,
): { files: Record<string, string>; warnings: string[] } | undefined {
  let root: fs.Stats;
  try {
    root = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new PiPodError(`${directory} must be a real directory, not a symlink`);
  }
  const files: Record<string, string> = {};
  const warnings: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      const relative = path.relative(directory, file).split(path.sep).join("/");
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) warnings.push(`${label} agents/${relative} is a symlink — skipped`);
      else if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        try {
          files[relative] = decoder.decode(fs.readFileSync(file));
        } catch {
          throw new PiPodError(`${file} must contain valid UTF-8 text`);
        }
      } else warnings.push(`${label} agents/${relative} is not a regular file — skipped`);
    }
  };
  walk(directory);
  return { files, warnings };
}

/**
 * The single deep boundary for every outgoing server-bundle config: client-only
 * metadata (template pin, secretResolver, $schema, client-only `pi` keys) and every
 * key the bundle-write contract rejects never reach the server.
 */
export function toOutgoingBundleConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const taken = takeClientOnlyKeys(raw);
  return stripNonBundleKeys({ ...taken.config });
}

/** The persistent server bundle never receives launcher UI/preferences metadata. */
function podConfigOnly(raw: Record<string, unknown>): ReturnType<typeof takeClientOnlyKeys> {
  const taken = takeClientOnlyKeys(raw);
  return { ...taken, config: toOutgoingBundleConfig(raw) };
}

function checkedConfig(raw: Record<string, unknown>, file: string) {
  const report = validateConfig(raw);
  if (report.errors.length > 0) {
    throw new PiPodError(`${file}: ${report.errors.join("; ")}`);
  }
  return report;
}

function readScript(root: string, relative: string): string {
  const file = path.resolve(root, relative);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/**
 * A dotenv file as push/diff input. `names` keeps values empty: a diff only compares secret
 * names, so it never resolves `op://` references or otherwise needs the values.
 */
async function readEnvSnapshot(
  envPath: string,
  mode: true | "names",
  resolver: SecretResolverConfig | null,
  home: string | undefined,
): Promise<EnvSnapshot> {
  const env: EnvSnapshot = {};
  if (!fs.existsSync(envPath)) return env;
  const parsed = parseDotenv(fs.readFileSync(envPath, "utf8"));
  if (mode === "names") {
    for (const name of Object.keys(parsed.values)) env[name] = { value: "", source: envPath };
    return env;
  }
  const values = await resolveSecretRefs(parsed.values, resolver, { home });
  for (const [name, value] of Object.entries(values)) env[name] = { value, source: envPath };
  return env;
}

/** Compile one local source layer verbatim; no org/user/template defaults are merged in. */
export async function compileBundleSource(args: {
  source: BundleSourceKind;
  cwd?: string;
  home?: string;
  /** `false` skips env files entirely; `"names"` reads keys without resolving values. */
  includeEnv?: boolean | "names";
  /** org-dir only: where the org source lives instead of ~/.pi-pod/org. */
  dir?: string;
}): Promise<CompiledBundleSource> {
  const cwd = args.cwd ?? process.cwd();
  const envMode = args.includeEnv === false ? false : args.includeEnv === "names" ? "names" : true;
  if (args.source === "project") {
    const configPath = findConfigPath(cwd, { home: args.home });
    if (!configPath) {
      throw new PiPodError("no project .pi-pod/config.json found", {
        hint: "run `pipod init`, or name the `user` or `org` layer to work outside a project",
      });
    }
    const root = path.dirname(path.dirname(configPath));
    const raw = parseConfig(configPath);
    const taken = podConfigOnly(raw);
    const report = checkedConfig(raw, configPath);
    const localPi = readPiFiles(root, report.config, "project");
    let env: EnvSnapshot = {};
    if (envMode) {
      const resolvers = readSecretResolverLayers({ cwd: root, home: args.home });
      env = await readEnvSnapshot(
        path.join(root, PROJECT_ENV_FILE),
        envMode,
        mergeSecretResolver(resolvers.machine, resolvers.project),
        args.home,
      );
    }
    const rawName = raw["name"];
    return {
      kind: "project",
      config: taken.config,
      initScript: readScript(root, PROJECT_INIT_SCRIPT),
      bakeScript: readScript(root, PROJECT_BAKE_SCRIPT),
      piFiles: localPi.files,
      env,
      warnings: [...report.warnings, ...localPi.warnings],
      name: typeof rawName === "string" && rawName.trim() ? rawName : path.basename(root),
      templateRef: taken.template,
      projectRoot: root,
      root,
      configPath,
    };
  }

  if (args.source === "org-dir") {
    const root = orgSourceDir({ dir: args.dir, home: args.home });
    if (!fs.existsSync(root)) {
      throw new PiPodError(`no org source directory at ${root}`, {
        hint: "run `pipod pull org` to create it from the server bundle, or pass --dir <path>",
      });
    }
    const configPath = path.join(root, "config.json");
    const raw = parseConfig(configPath);
    const taken = podConfigOnly(raw);
    const report = checkedConfig(raw, configPath);
    const localPi = readPiFiles(root, report.config, "org-dir");
    let env: EnvSnapshot = {};
    if (envMode) {
      // Machine resolver first, then the org dir's own `secretResolver`, like project env files.
      const machine = takeClientOnlyKeys(readHostConfig(args.home)).secretResolver;
      env = await readEnvSnapshot(
        path.join(root, ORG_ENV_FILE),
        envMode,
        mergeSecretResolver(machine, taken.secretResolver),
        args.home,
      );
    }
    return {
      kind: "org-dir",
      config: taken.config,
      initScript: readScript(root, ORG_SCRIPTS.init),
      bakeScript: readScript(root, ORG_SCRIPTS.bake),
      piFiles: localPi.files,
      env,
      warnings: [...report.warnings, ...localPi.warnings],
      name: "org settings",
      templateRef: taken.template,
      projectRoot: null,
      root,
      configPath,
    };
  }

  const configPath = userConfigPath(args.home);
  if (!configPath) throw new PiPodError("cannot locate ~/.pi-pod/config.json: HOME is unset");
  const raw = readHostConfig(args.home);
  const taken = podConfigOnly(raw);
  const report = checkedConfig(raw, configPath);
  const home = path.dirname(path.dirname(configPath));
  const piFiles = readPiFiles(home, report.config, "user-dir");
  return {
    kind: "user-dir",
    config: taken.config,
    initScript: "",
    bakeScript: "",
    piFiles: piFiles.files,
    env: {},
    warnings: [...report.warnings, ...piFiles.warnings],
    name: "user settings",
    templateRef: taken.template,
    projectRoot: null,
    root: home,
    configPath,
  };
}

/** The org source dir is flat: scripts and env sit next to config.json. */
const ORG_SCRIPTS = { init: "init.sh", bake: "bake.sh" } as const;
const ORG_ENV_FILE = "env";

/** Push-time-only Pi source compilation and sanitization. Launches never call this. */
function readPiFiles(
  root: string,
  config: ReturnType<typeof validateConfig>["config"],
  kind: BundleSourceKind,
): { files: PiSettingsFilesBody; warnings: string[] } {
  const files: PiSettingsFilesBody = {};
  const warnings: string[] = [];
  const scope = kind === "user-dir" ? "user" : kind === "org-dir" ? "org" : "project";
  const relative = PI_SUBPATH[kind];
  const settingsPath = safePiFile(root, relative, "settings.json");
  if (settingsPath) {
    const filtered = filterSettings(fs.readFileSync(settingsPath, "utf8"), settingsPath, {
      packages: config.pi.hostConfig.packages,
    });
    if (Object.keys(filtered.settings).length > 0) files.settings = filtered.settings;
    if (filtered.dropped.length > 0) warnings.push(`local Pi ${scope} settings omitted host-coupled keys: ${filtered.dropped.join(", ")}`);
  }
  const modelsPath = safePiFile(root, relative, "models.json");
  if (modelsPath) {
    const raw = parseConfig(modelsPath);
    const sanitized = sanitizeModelsForTransport(raw);
    if (Object.keys(sanitized.models).length > 0) files.models = sanitized.models;
    if (sanitized.dropped.length > 0) warnings.push(`local Pi models omitted credential values: ${sanitized.dropped.join(", ")}`);
  }
  for (const [fileName, key] of [["mcporter.json", "mcporter"], ["subagents.json", "subagents"]] as const) {
    const file = safePiFile(root, relative, fileName);
    if (file) files[key] = parseConfig(file);
  }
  const piDir = safePiDir(root, relative);
  const agents = piDir ? readPiAgentsDirectory(path.join(piDir, "agents"), `local Pi ${scope}`) : undefined;
  if (agents) {
    files.agents = agents.files;
    warnings.push(...agents.warnings);
  }
  const bytes = Buffer.byteLength(JSON.stringify(files));
  if (bytes > 256 * 1024) throw new PiPodError(`${scope} Pi settings bundle exceeds 262144 bytes`);
  return { files, warnings };
}

/** Exposed for push-source validation tests; launch planning never calls it. */
export function readProjectPiSourceFiles(args: {
  projectRoot: string;
  config: ReturnType<typeof validateConfig>["config"];
}): { files: PiSettingsFilesBody; warnings: string[] } {
  return readPiFiles(args.projectRoot, args.config, "project");
}

/** Normalize flat P1 template files and legacy {user,project} files for cheap compatibility. */
export function flatPiSettings(value: unknown, preferred?: "user" | "project"): PiSettingsFilesBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const flatKeys = ["settings", "models", "mcporter", "subagents", "agents"];
  if (flatKeys.some((key) => Object.hasOwn(raw, key))) return raw as PiSettingsFilesBody;
  if (preferred) return flatPiSettings(raw[preferred]);
  const user = flatPiSettings(raw["user"]);
  const project = flatPiSettings(raw["project"]);
  const merged = mergeConfigLayers(user, project);
  return (merged && typeof merged === "object" && !Array.isArray(merged) ? merged : {}) as PiSettingsFilesBody;
}

export interface BundleDiff {
  changed: boolean;
  lines: string[];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function configLeaves(value: unknown, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 0) for (const [key, child] of entries) configLeaves(child, prefix ? `${prefix}.${key}` : key, out);
    else if (prefix) out.set(prefix, value);
  } else if (prefix) out.set(prefix, value);
  return out;
}

export function diffBundle(
  source: Pick<CompiledBundleSource, "config" | "initScript" | "bakeScript" | "piFiles" | "env">,
  destination: { config: Record<string, unknown>; initScript?: string | null; bakeScript?: string | null; piFiles?: unknown },
  destinationSecretNames: string[] = [],
): BundleDiff {
  const lines: string[] = [];
  let changed = false;
  const before = configLeaves(stripNonBundleKeys(destination.config ?? {}));
  const after = configLeaves(stripNonBundleKeys(source.config));
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (stable(before.get(key)) === stable(after.get(key)) && before.has(key) === after.has(key)) continue;
    changed = true;
    const oldValue = before.has(key) ? stable(before.get(key)) : "(absent)";
    const newValue = after.has(key) ? stable(after.get(key)) : "(absent)";
    lines.push(`config ${key}: ${oldValue} → ${newValue}`);
  }
  for (const [label, local, remote] of [
    ["init script", source.initScript, destination.initScript ?? ""],
    ["bake script", source.bakeScript, destination.bakeScript ?? ""],
  ] as const) {
    if (local === remote) continue;
    lines.push(`${label}: changed`);
    changed = true;
  }
  const currentPi = flatPiSettings(destination.piFiles ?? {});
  for (const key of ["settings", "models", "mcporter", "subagents"] as const) {
    if (stable(source.piFiles[key]) === stable(currentPi[key])) continue;
    lines.push(`Pi ${key}.json: changed`);
    changed = true;
  }
  const localAgents = source.piFiles.agents ?? {};
  const remoteAgents = currentPi.agents ?? {};
  const agentPaths = [...new Set([...Object.keys(localAgents), ...Object.keys(remoteAgents)])].sort();
  for (const agentPath of agentPaths) {
    const same = Object.hasOwn(localAgents, agentPath) && Object.hasOwn(remoteAgents, agentPath) &&
      localAgents[agentPath] === remoteAgents[agentPath];
    if (same) continue;
    lines.push(`Pi agents/${agentPath}: changed`);
    changed = true;
  }
  const localNames = Object.keys(source.env).filter((name) => !isProviderCredentialVar(name)).sort();
  const remoteNames = [...destinationSecretNames].sort();
  for (const name of [...new Set([...localNames, ...remoteNames])].sort()) {
    const state = localNames.includes(name) ? (remoteNames.includes(name) ? "present (value hidden)" : "add") : "destination only";
    lines.push(`secret ${name}: ${state}`);
  }
  return { changed, lines };
}

export function templateBundle(template: ApiTemplate) {
  return {
    config: template.config ?? {},
    initScript: template.initScript ?? "",
    bakeScript: template.bakeScript ?? "",
    piFiles: flatPiSettings(template.piSettings ?? {}),
  };
}

export function settingsBundle(settings: ApiSettingsBundle) {
  return { ...settings, piFiles: settings.piFiles ?? {} };
}

export interface ServerBundle {
  config: Record<string, unknown>;
  initScript: string;
  bakeScript: string;
  piFiles: PiSettingsFilesBody;
}

export interface BundleWriteResult {
  /** Paths relative to the layer root. */
  written: string[];
  removed: string[];
  warnings: string[];
  root: string;
}

/** Keys the launcher owns locally, with CLIENT_ONLY_PI_KEYS; a pulled config never replaces them. */
const CLIENT_ONLY_TOP_KEYS = ["$schema", "template", "secretResolver"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(source, key)) out[key] = source[key];
  return out;
}

/** A pulled config wrapped around the client-only keys the local file already had. */
function mergePulledConfig(existing: Record<string, unknown>, pulled: Record<string, unknown>): Record<string, unknown> {
  const pod = podConfigOnly(pulled).config;
  const top = pick(existing, CLIENT_ONLY_TOP_KEYS);
  const next: Record<string, unknown> = {
    ...("$schema" in top ? { $schema: top["$schema"] } : {}),
    ...pod,
    ...("template" in top ? { template: top["template"] } : {}),
    ...("secretResolver" in top ? { secretResolver: top["secretResolver"] } : {}),
  };
  const clientPi = isPlainObject(existing["pi"]) ? pick(existing["pi"], CLIENT_ONLY_PI_KEYS) : {};
  const pi = { ...(isPlainObject(pod["pi"]) ? pod["pi"] : {}), ...clientPi };
  if (Object.keys(pi).length > 0) next["pi"] = pi;
  return next;
}

/** Copy credential values the transport dropped back into the pulled models at the same paths. */
function restoreModelCredentials(existing: Record<string, unknown>, pulled: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(pulled);
  const at = (target: unknown, parts: string[]): unknown => {
    let cursor = target;
    for (const part of parts) {
      if (cursor === null || typeof cursor !== "object") return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
  };
  for (const dotted of sanitizeModelsForTransport(existing).dropped) {
    const parts = dotted.split(".");
    const parent = at(result, parts.slice(0, -1));
    if (parent === null || typeof parent !== "object") continue;
    (parent as Record<string, unknown>)[parts.at(-1)!] = at(existing, parts);
  }
  return result;
}

function refuseSymlink(file: string): fs.Stats | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new PiPodError(`${file} is a symlink — pull refuses to write through it`);
  return stat;
}

class LayerWriter {
  readonly written: string[] = [];
  readonly removed: string[] = [];
  readonly warnings: string[] = [];
  /**
   * `confined`: every directory between the root and a written file must be a real one. A
   * project root is a checkout, and its author can make any of them a symlink elsewhere.
   */
  constructor(readonly root: string, private readonly confined = false) {}

  /** `null` content removes the file. Identical content is left untouched. */
  put(file: string, content: string | null): void {
    if (this.confined) {
      let ancestor = this.root;
      for (const part of path.relative(this.root, path.dirname(file)).split(path.sep).filter(Boolean)) {
        if (part === "..") throw new PiPodError(`${file} is outside ${this.root}`);
        ancestor = path.join(ancestor, part);
        const stat = refuseSymlink(ancestor);
        if (stat && !stat.isDirectory()) throw new PiPodError(`${ancestor} must be a directory`);
      }
    }
    const stat = refuseSymlink(file);
    const relative = path.relative(this.root, file);
    if (content === null) {
      if (!stat) return;
      fs.rmSync(file);
      this.removed.push(relative);
      return;
    }
    if (stat && fs.readFileSync(file, "utf8") === content) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    this.written.push(relative);
  }

  json(file: string, value: Record<string, unknown> | null): void {
    this.put(file, value === null ? null : `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Comments cannot survive a JSON rewrite; say so once per file, only when it is rewritten. */
  noteComments(file: string): void {
    if (!fs.existsSync(file)) return;
    try {
      JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.warnings.push(`${file} had comments; pull rewrites it as plain JSON`);
    }
  }
}

function writePulledAgents(writer: LayerWriter, piDir: string, agents: Record<string, string> | undefined): void {
  const directory = path.join(piDir, "agents");
  const keep = new Set<string>();
  refuseSymlink(directory);
  for (const [relative, content] of Object.entries(agents ?? {})) {
    const parts = relative.split("/");
    if (path.isAbsolute(relative) || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new PiPodError(`server agents/${relative} is not a safe relative path`);
    }
    keep.add(parts.join(path.sep));
    // The server names the subdirectories; one that is a symlink in this checkout would
    // carry the write outside it.
    let ancestor = directory;
    for (const part of parts.slice(0, -1)) {
      ancestor = path.join(ancestor, part);
      const stat = refuseSymlink(ancestor);
      if (stat && !stat.isDirectory()) throw new PiPodError(`${ancestor} must be a directory`);
    }
    writer.put(path.join(directory, ...parts), content);
  }
  const stat = refuseSymlink(directory);
  if (!stat) return;
  if (!stat.isDirectory()) throw new PiPodError(`${directory} must be a directory`);
  const prune = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const entryStat = fs.lstatSync(file);
      if (entryStat.isSymbolicLink()) writer.warnings.push(`${file} is a symlink — left alone`);
      else if (entryStat.isDirectory()) {
        prune(file);
        if (fs.readdirSync(file).length === 0) fs.rmdirSync(file);
      } else if (entryStat.isFile() && !keep.has(path.relative(directory, file))) writer.put(file, null);
    }
  };
  prune(directory);
}

/**
 * Write a server bundle into a layer's local files. Everything the launcher owns locally
 * survives: client-only config keys, host-coupled Pi settings, and model credential values.
 * Secrets are write-only on the server and are never written here.
 */
export function writeBundleSource(args: {
  kind: BundleSourceKind;
  bundle: ServerBundle;
  cwd?: string;
  home?: string;
  dir?: string;
}): BundleWriteResult {
  const { kind, bundle } = args;
  let root: string;
  let configPath: string;
  if (kind === "project") {
    const found = findConfigPath(args.cwd ?? process.cwd(), { home: args.home });
    if (!found) throw new PiPodError("no project .pi-pod/config.json found", { hint: "run `pipod init` first" });
    configPath = found;
    root = path.dirname(path.dirname(found));
  } else if (kind === "org-dir") {
    root = orgSourceDir({ dir: args.dir, home: args.home });
    configPath = path.join(root, "config.json");
  } else {
    const userPath = userConfigPath(args.home);
    if (!userPath) throw new PiPodError("cannot locate ~/.pi-pod/config.json: HOME is unset");
    configPath = userPath;
    root = path.dirname(path.dirname(userPath));
  }
  const writer = new LayerWriter(root, kind === "project");
  const retired = nonBundleKeysFound(bundle.config);
  if (retired.length > 0) {
    writer.warnings.push(`the server bundle still carries non-bundle keys (${retired.join(", ")}) — they are dropped, not written`);
  }
  const existingConfig = parseConfig(configPath);
  const nextConfig = mergePulledConfig(existingConfig, bundle.config);
  const report = checkedConfig(nextConfig, `${kind} bundle config`);
  // A JSONC file never matches its JSON rendering byte for byte, so rewriting on any textual
  // difference would flatten a commented file on a pull that changed no pod setting at all.
  const podChanged = stable(podConfigOnly(existingConfig).config) !== stable(podConfigOnly(bundle.config).config);
  if (podChanged || !fs.existsSync(configPath)) {
    writer.noteComments(configPath);
    writer.json(configPath, nextConfig);
  }

  if (kind === "project") {
    writer.put(path.resolve(root, PROJECT_INIT_SCRIPT), bundle.initScript || null);
    writer.put(path.resolve(root, PROJECT_BAKE_SCRIPT), bundle.bakeScript || null);
  } else if (kind === "org-dir") {
    writer.put(path.join(root, ORG_SCRIPTS.init), bundle.initScript || null);
    writer.put(path.join(root, ORG_SCRIPTS.bake), bundle.bakeScript || null);
  } else if (bundle.initScript || bundle.bakeScript) {
    writer.warnings.push("the user bundle's scripts have no local file and were not written");
  }

  const piDir = path.join(root, PI_SUBPATH[kind]);
  refuseSymlink(piDir);
  const piFiles = flatPiSettings(bundle.piFiles);
  const settingsPath = path.join(piDir, "settings.json");
  const localOnly = refuseSymlink(settingsPath)
    ? (() => {
        const filtered = filterSettings(fs.readFileSync(settingsPath, "utf8"), settingsPath, {
          packages: report.config.pi.hostConfig.packages,
        });
        const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        return pick(raw, filtered.dropped);
      })()
    : {};
  const nextSettings = { ...localOnly, ...piFiles.settings };
  writer.json(settingsPath, Object.keys(nextSettings).length > 0 ? nextSettings : null);

  const modelsPath = path.join(piDir, "models.json");
  if (piFiles.models) {
    const existingModels = refuseSymlink(modelsPath) ? parseConfig(modelsPath) : {};
    const nextModels = restoreModelCredentials(existingModels, piFiles.models);
    if (stable(existingModels) !== stable(nextModels)) writer.noteComments(modelsPath);
    writer.json(modelsPath, nextModels);
  } else writer.json(modelsPath, null);

  writer.json(path.join(piDir, "mcporter.json"), piFiles.mcporter ?? null);
  writer.json(path.join(piDir, "subagents.json"), piFiles.subagents ?? null);
  writePulledAgents(writer, piDir, piFiles.agents);
  return { written: writer.written, removed: writer.removed, warnings: writer.warnings, root };
}
