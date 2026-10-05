import * as fs from "node:fs";
import * as path from "node:path";
import {
  CLIENT_ONLY_PI_KEYS,
  findConfigPath,
  retiredLocalKeysFound,
  stripNonBundleKeys,
  validateConfig,
  type PiPodConfig,
} from "../config.js";
import { PiPodError } from "../errors.js";
import { parseJsonc } from "../jsonc.js";
import {
  parseSecretResolver,
  type SecretResolverConfig,
} from "../secret-refs.js";
import { displayPath, mergeConfigLayers, userConfigPath } from "../userconfig.js";
import type { AccountClient } from "./api.js";
import type { AccountLaunchFlags } from "./launch-types.js";
import { resolveSeedRoot } from "./workspace-seed.js";

export function readHostConfig(home?: string | undefined): Record<string, unknown> {
  const file = userConfigPath(home);
  if (!file || !fs.existsSync(file)) return {};
  try {
    return parseJsonc(fs.readFileSync(file, "utf8"), file) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof PiPodError) throw e;
    throw new PiPodError(`could not parse ${displayPath(file, home)}`, {
      hint: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Fail closed on retired keys in the machine layer. Only the client-only `pi` keys (plus the
 * template pin and secretResolver) are ever read from `~/.pi-pod/config.json`, so a
 * stale path pointer or name list there would otherwise vanish without a word.
 */
export function assertMachineConfigCurrent(raw: Record<string, unknown>, home?: string | undefined): void {
  const retired = retiredLocalKeysFound(raw);
  if (retired.length === 0) return;
  const file = userConfigPath(home) ?? "~/.pi-pod/config.json";
  throw new PiPodError(
    `${displayPath(file, home)}: retired key${retired.length === 1 ? "" : "s"} ${retired.map((k) => k.path).join(", ")}`,
    { hint: retired.map((k) => k.hint).join("; ") },
  );
}

/** Split local-only preferences from pod settings. The remaining keys are source/drift input only. */
export function takeClientOnlyKeys(raw: Record<string, unknown>): {
  config: Record<string, unknown>;
  template: string | null;
  secretResolver: SecretResolverConfig | null;
} {
  const afterTemplate = takeTemplate(raw);
  const afterResolver = takeSecretResolver(afterTemplate.config);
  return {
    config: afterResolver.config,
    template: afterTemplate.template,
    secretResolver: afterResolver.secretResolver,
  };
}

function takeTemplate(raw: Record<string, unknown>): {
  config: Record<string, unknown>;
  template: string | null;
} {
  if (!Object.hasOwn(raw, "template")) return { config: raw, template: null };
  const { template, ...config } = raw;
  if (template === null) return { config, template: "" };
  if (typeof template === "string" && template.length > 0) return { config, template };
  return { config, template: null };
}

function takeSecretResolver(raw: Record<string, unknown>): {
  config: Record<string, unknown>;
  secretResolver: SecretResolverConfig | null;
} {
  if (!Object.hasOwn(raw, "secretResolver")) return { config: raw, secretResolver: null };
  const { secretResolver, ...config } = raw;
  return { config, secretResolver: parseSecretResolver(secretResolver) };
}

/** `--template` wins; otherwise the project pin, then the machine pin. An explicit null pin means none. */
export function resolveLaunchTemplateRef(
  flags: Pick<AccountLaunchFlags, "template">,
  layers: { project: string | null; machine: string | null },
): string | undefined {
  if (flags.template) return flags.template;
  if (layers.project !== null) return layers.project || undefined;
  if (layers.machine !== null) return layers.machine || undefined;
  return undefined;
}

/** The client-only subset retained from ~/.pi-pod/config.json. */
export function machineClientConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const pi = isPlainObjectValue(raw["pi"]) ? raw["pi"] : {};
  const clientPi = Object.fromEntries(
    Object.entries(pi).filter(([key]) => (CLIENT_ONLY_PI_KEYS as readonly string[]).includes(key)),
  );
  return Object.keys(clientPi).length > 0 ? { pi: clientPi } : {};
}

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Machine then project secret resolvers are retained for push-time env compilation. */
export function readSecretResolverLayers(opts: {
  cwd: string;
  home?: string;
}): { machine: SecretResolverConfig | null; project: SecretResolverConfig | null } {
  const machine = takeClientOnlyKeys(readHostConfig(opts.home)).secretResolver;
  const configPath = findConfigPath(opts.cwd, { home: opts.home });
  const project = configPath
    ? takeClientOnlyKeys(parseJsonc(fs.readFileSync(configPath, "utf8"), configPath) as Record<string, unknown>)
        .secretResolver
    : null;
  return { machine, project };
}

/** Shared by attach/send: recover project context and overlay only machine client preferences. */
export async function localConfigView(
  client: AccountClient,
  cwd = process.cwd(),
  opts: { home?: string | undefined; templateId?: string | null } = {},
): Promise<{ config: PiPodConfig; projectRoot: string | null }> {
  let projectRawFull: Record<string, unknown> = {};
  let projectRoot: string | null = null;
  const configPath = findConfigPath(cwd, { home: opts.home });
  if (configPath !== null) {
    projectRoot = path.dirname(path.dirname(configPath));
    projectRawFull = parseJsonc(fs.readFileSync(configPath, "utf8"), configPath) as Record<string, unknown>;
  }
  const machineRaw = readHostConfig(opts.home);
  assertMachineConfigCurrent(machineRaw, opts.home);
  const applyClientPreferences = (raw: unknown): PiPodConfig | null => {
    const serverView = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? stripNonBundleKeys(raw as Record<string, unknown>)
      : raw;
    const withMachine = mergeConfigLayers(serverView, machineClientConfig(machineRaw));
    const parsed = validateConfig(withMachine as Record<string, unknown>);
    if (parsed.errors.length > 0) return null;
    return parsed.config;
  };
  const resolved = await client.resolve({
    ...(opts.templateId ? { templateId: opts.templateId } : {}),
    checkImage: false,
  }).catch(() => null);
  const serverView = resolved ? applyClientPreferences(resolved.config) : null;
  if (serverView) return { config: serverView, projectRoot };

  // Attach remains possible through a transient/old-server resolve failure, but local pod
  // source keys are not resurrected as a launch-local layer.
  const fallback = applyClientPreferences({}) ?? validateConfig({}).config;
  return { config: fallback, projectRoot };
}

/** A template pinned by the current project, or null outside one or when no pin is set. */
export function currentProjectTemplateRef(cwd = process.cwd(), home?: string | undefined): string | null {
  const configPath = findConfigPath(cwd, { home });
  if (configPath === null) return null;
  try {
    const raw = parseJsonc(fs.readFileSync(configPath, "utf8"), configPath) as Record<string, unknown>;
    const template = raw["template"];
    return typeof template === "string" && template.length > 0 ? template : null;
  } catch {
    // Preserve project-scoped listing when local config cannot supply a usable template pin.
    return null;
  }
}

/**
 * The project a directory belongs to, by name: its config's `name`, else the directory holding
 * `.pi-pod/`; without config, the git repository's root directory, else the directory itself —
 * the same root a launch seeds from. Launches record it on the pod; lists, the default pod of
 * stop/attach, and --reuse go by it. Null in the home directory and at /, which are no project.
 */
export function currentProjectName(cwd = process.cwd(), home?: string | undefined): string | null {
  const configPath = findConfigPath(cwd, { home });
  if (configPath === null) {
    const root = resolveSeedRoot(cwd, home ? { home } : undefined);
    return root.ok ? path.basename(root.root) : null;
  }
  try {
    const raw = parseJsonc(fs.readFileSync(configPath, "utf8"), configPath) as Record<string, unknown>;
    const name = raw["name"];
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    // A broken project config still scopes by its directory name.
  }
  return path.basename(path.dirname(path.dirname(configPath)));
}
