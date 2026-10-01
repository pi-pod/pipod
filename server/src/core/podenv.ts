/**
 * src/podenv.ts — host-only recipe for restoring pod environment variables after a provider
 * stop discards its creation-time environment.
 *
 * Secret values never land here. Each pod gets an independent mode-600 recipe containing only
 * source paths, key names, and pi-pod's non-secret runtime markers. Current values are reread
 * when the pod resumes, so key rotation works without creating a second secret store.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { LoadedConfig } from "./config.js";
import { parseDotenv } from "./dotenv.js";
import { PiPodError } from "./errors.js";
import { hostHome } from "./hostconfig.js";
import { LABEL_ENV_RECIPE, LABEL_PROJECT, RESERVED_ENV_NAMES, sanitizeLabelValue } from "./labels.js";
import { warn } from "./log.js";
import { layerEnv, type SessionPlan } from "./preflight.js";
import { registerSecrets } from "./redact.js";
import type { SandboxInfo, SandboxProvider } from "./providers/types.js";
import { USER_CONFIG_DIR, userEnvPath } from "./userconfig.js";

export const POD_ENV_SOURCES_DIR = "pod-env-sources";

interface EnvSourceLayer {
  path: string;
  keys: string[];
}

export interface PodEnvSources {
  version: 2;
  project: string;
  projectRoot: string;
  /** Identity of the project root at record time, so a moved/reused path cannot leak secrets. */
  projectIdentity: { path: string; device: string; inode: string };
  machine: EnvSourceLayer | null;
  projectEnv: EnvSourceLayer | null;
  shellKeys: string[];
  /** Names whose effective launch value was nonblank. Resume refuses to lose any of them. */
  requiredKeys: string[];
  /** Reserved, non-secret values known only to the launcher process that created the pod. */
  markers: Record<string, string>;
}

function safeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function projectIdentityOf(projectRoot: string): PodEnvSources["projectIdentity"] {
  const stat = fs.statSync(projectRoot, { bigint: true });
  return { path: projectRoot, device: String(stat.dev), inode: String(stat.ino) };
}

export function podEnvSourcePath(
  providerName: string,
  podId: string,
  home: string | null = hostHome(),
): string | null {
  if (!home) return null;
  return path.join(
    home,
    USER_CONFIG_DIR,
    POD_ENV_SOURCES_DIR,
    safeSegment(providerName),
    `${safeSegment(podId)}.json`,
  );
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validLayer(value: unknown): value is EnvSourceLayer | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const layer = value as Partial<EnvSourceLayer>;
  return typeof layer.path === "string" && stringArray(layer.keys);
}

function validMarkers(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reserved = new Set<string>(RESERVED_ENV_NAMES);
  return Object.entries(value).every(([key, marker]) => reserved.has(key) && typeof marker === "string");
}

function readRecipe(
  providerName: string,
  podId: string,
  home: string | null,
): { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; recipe: PodEnvSources } {
  const file = podEnvSourcePath(providerName, podId, home);
  if (!file || !fs.existsSync(file)) return { kind: "missing" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PodEnvSources>;
    if (
      parsed.version === 2 &&
      typeof parsed.project === "string" &&
      typeof parsed.projectRoot === "string" &&
      parsed.projectIdentity &&
      typeof parsed.projectIdentity.path === "string" &&
      typeof parsed.projectIdentity.device === "string" &&
      typeof parsed.projectIdentity.inode === "string" &&
      validLayer(parsed.machine) &&
      validLayer(parsed.projectEnv) &&
      stringArray(parsed.shellKeys) &&
      stringArray(parsed.requiredKeys) &&
      validMarkers(parsed.markers)
    ) {
      return { kind: "ok", recipe: parsed as PodEnvSources };
    }
  } catch {
    // Reported as invalid below. Never interpret a partial recipe.
  }
  return { kind: "invalid" };
}

/** Test/documentation seam: returns null for a missing or invalid recipe. */
export function readPodEnvSources(
  providerName: string,
  podId: string,
  home: string | null = hostHome(),
): PodEnvSources | null {
  const found = readRecipe(providerName, podId, home);
  return found.kind === "ok" ? found.recipe : null;
}

function writeRecipe(file: string, recipe: PodEnvSources): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(dir), 0o700);
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(recipe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Effective launch environment, before pi-pod's own creation/runtime markers. */
export function effectivePlanEnv(plan: Pick<SessionPlan, "hostEnv" | "userEnv" | "env">): Record<string, string> {
  return layerEnv(layerEnv(plan.hostEnv, plan.userEnv), plan.env);
}

/** Persist this pod's value-free restoration recipe after the provider returns its id. */
export function rememberPodEnvSources(
  provider: SandboxProvider,
  podId: string,
  plan: SessionPlan,
  markers: Record<string, string>,
  home: string | null = plan.hostHomePath,
): void {
  if (provider.capabilities.environmentPersistence !== "rehydrate") return;

  const effective = effectivePlanEnv(plan);
  const file = podEnvSourcePath(provider.name, podId, home);
  if (!file) {
    throw new PiPodError("cannot make this pod's environment resumable: the host has no home directory", {
      hint: "set $HOME so pi-pod can store a value-free restoration recipe under ~/.pi-pod/",
    });
  }

  writeRecipe(file, {
    version: 2,
    project: plan.project,
    projectRoot: plan.projectRoot,
    projectIdentity: projectIdentityOf(plan.projectRoot),
    machine:
      plan.userEnvKeys.length > 0
        ? { path: userEnvPath(home!)!, keys: [...plan.userEnvKeys] }
        : null,
    projectEnv:
      plan.envKeys.length > 0
        ? { path: path.join(plan.projectRoot, plan.config.envFile), keys: [...plan.envKeys] }
        : null,
    shellKeys: Object.keys(plan.hostEnv),
    requiredKeys: Object.entries(effective)
      .filter(([, value]) => value.trim() !== "")
      .map(([key]) => key),
    markers: { ...markers },
  });
}

export function forgetPodEnvSources(
  providerName: string,
  podId: string,
  home: string | null = hostHome(),
): void {
  const file = podEnvSourcePath(providerName, podId, home);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
    fs.rmdirSync(path.dirname(file));
  } catch {
    // Remote deletion already succeeded. A stale value-free recipe is harmless.
  }
}

function selectedFileEnv(layer: EnvSourceLayer | null): Record<string, string> {
  if (!layer || !fs.existsSync(layer.path)) return {};
  const parsed = parseDotenv(fs.readFileSync(layer.path, "utf8")).values;
  return Object.fromEntries(layer.keys.map((key) => [key, parsed[key] ?? ""]));
}

function selectedShellEnv(keys: string[], env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, env[key] ?? ""]));
}

function assertRequiredEnv(env: Record<string, string>, requiredKeys: string[], podId: string): void {
  const missing = requiredKeys.filter((key) => (env[key] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new PiPodError(`cannot restore pod ${podId}'s environment: ${missing.join(", ")} no longer has a value`, {
      hint:
        "restore those keys in their original env file or export them in this shell, then attach again.\n" +
        "pi-pod stores only source paths and key names, never secret values.",
    });
  }
}

function assertRecipeProjectSource(recipe: PodEnvSources, podId: string): void {
  if (!recipe.projectEnv) return;
  const relative = path.relative(recipe.projectRoot, recipe.projectEnv.path);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PiPodError(`cannot restore pod ${podId}: its project env source escapes the recorded project`);
  }
  try {
    const current = projectIdentityOf(recipe.projectRoot);
    const recorded = recipe.projectIdentity;
    if (current.path !== recorded.path || current.device !== recorded.device || current.inode !== recorded.inode) {
      throw new Error("project identity changed");
    }
  } catch {
    throw new PiPodError(`cannot restore pod ${podId}: its original project directory no longer identifies ${recipe.project}`, {
      hint: `restore the project at ${recipe.projectRoot}, or delete and recreate the pod`,
    });
  }
}

/** Resolve current values and non-secret markers for a stopped pod without persisting secrets. */
export async function restorePodEnv(
  loaded: LoadedConfig,
  provider: SandboxProvider,
  target: SandboxInfo,
  opts: {
    copyPiEnv?: boolean;
    env?: NodeJS.ProcessEnv;
    home?: string | null;
  } = {},
): Promise<Record<string, string>> {
  if (provider.capabilities.environmentPersistence !== "rehydrate") return {};

  const home = opts.home === undefined ? hostHome() : opts.home;
  const found = readRecipe(provider.name, target.id, home);
  const hostEnv = opts.env ?? process.env;

  if (found.kind === "ok") {
    const recipe = found.recipe;
    if (sanitizeLabelValue(recipe.project) !== target.labels[LABEL_PROJECT]) {
      throw new PiPodError(`cannot restore pod ${target.id}: its environment recipe belongs to another project`);
    }
    assertRecipeProjectSource(recipe, target.id);
    const shell = selectedShellEnv(recipe.shellKeys, hostEnv);
    const machine = selectedFileEnv(recipe.machine);
    const projectEnv = selectedFileEnv(recipe.projectEnv);
    const secrets = layerEnv(layerEnv(shell, machine), projectEnv);
    assertRequiredEnv(secrets, recipe.requiredKeys, target.id);
    registerSecrets(secrets);
    return { ...secrets, ...recipe.markers };
  }
  const state = found.kind === "invalid" ? "is invalid" : "is missing";
  throw new PiPodError(`cannot restore pod ${target.id}: its host environment recipe ${state}`, {
    hint:
      "the recipe stores no secret values, but its source paths and key names are required.\n" +
      "restore the matching file under ~/.pi-pod/pod-env-sources/ or delete and recreate the pod\n" +
      "(pods created before this pi-pod version have no recipe).",
  });
}
