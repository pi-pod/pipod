import * as fs from "node:fs";
import * as path from "node:path";
import { PiPodError } from "./errors.js";

export const HOST_PI_AGENT_SUBPATH = path.join(".pi", "agent");
/** Mirrors the server's list; see its comment for why each key stays on this machine. */
export const HOST_COUPLED_SETTINGS_KEYS = ["hooks", "mcpServers", "deviceId"] as const;

export interface HostConfigSelection {
  settings: boolean;
  packages: boolean;
}

export const DEFAULT_HOST_CONFIG: HostConfigSelection = {
  settings: true,
  packages: true,
};

const ENV_REFERENCE = /^\$(?:[A-Z_][A-Z0-9_]*|\{[A-Z_][A-Z0-9_]*\})$/;
const CREDENTIAL_FIELD =
  /(?:^|[-_])(?:api[-_]?key|api[-_]?token|access[-_]?token|auth(?:orization)?|auth[-_]?token|bearer|client[-_]?secret|credentials?|password|secret|token)$/i;

export function sanitizeModelsForTransport(
  input: Record<string, unknown>,
): { models: Record<string, unknown>; dropped: string[] } {
  const dropped: string[] = [];
  const visit = (value: unknown, pathParts: string[], inHeaders = false): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...pathParts, String(index)], inHeaders));
    if (value === null || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const credentialField = CREDENTIAL_FIELD.test(key) || (inHeaders && /(?:key|token|secret)$/i.test(key));
      if (credentialField && (typeof child !== "string" || !ENV_REFERENCE.test(child))) {
        dropped.push([...pathParts, key].join("."));
        continue;
      }
      result[key] = visit(child, [...pathParts, key], inHeaders || key === "headers");
    }
    return result;
  };
  return { models: visit(input, []) as Record<string, unknown>, dropped };
}

export function hostHome(explicit?: string | undefined): string | null {
  return explicit ?? process.env["HOME"] ?? process.env["USERPROFILE"] ?? null;
}

export function hostPiAuthPath(home: string): string {
  return path.join(home, HOST_PI_AGENT_SUBPATH, "auth.json");
}

export function readPiAuthOAuthProviders(home: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(hostPiAuthPath(home), "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, entry]) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
        (entry as Record<string, unknown>)["type"] === "oauth")
      .map(([provider]) => provider)
      .sort();
  } catch {
    return [];
  }
}

export const PI_AUTH_PROBE_DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  "openai-codex": "gpt-5",
  xai: "grok-4.5",
  "google-gemini-cli": "gemini-2.5-pro",
  "kimi-coding": "kimi-for-coding",
  meta: "muse-spark-1.2",
};

export function piAuthProbeModel(
  provider: string,
  hostModel: { provider: string; model: string } | null,
): string | null {
  if (hostModel && hostModel.provider === provider && hostModel.model) return hostModel.model;
  return PI_AUTH_PROBE_DEFAULT_MODELS[provider] ?? null;
}

export function piAuthPrintBearerCommand(provider: string, model: string): string {
  return `pi auth print-bearer-token --provider ${provider} --model ${model}`;
}

export function mergePiAuthContents(local: string, remote: string): string {
  let localParsed: unknown;
  let remoteParsed: unknown;
  try {
    localParsed = JSON.parse(local);
    remoteParsed = JSON.parse(remote);
  } catch {
    return remote;
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(localParsed) || !isObject(remoteParsed)) return remote;
  return JSON.stringify({ ...localParsed, ...remoteParsed }, null, 2) + "\n";
}

export interface FilteredSettings {
  settings: Record<string, unknown>;
  dropped: string[];
}

export function filterSettings(
  raw: string,
  sourcePath: string,
  opts: { packages: boolean },
): FilteredSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PiPodError(`${sourcePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      hint: 'fix it, or set "pi": { "hostConfig": { "settings": false } }',
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PiPodError(`${sourcePath} is not a JSON object`);
  }
  const settings = { ...(parsed as Record<string, unknown>) };
  const dropped: string[] = [];
  for (const key of HOST_COUPLED_SETTINGS_KEYS) {
    if (!Object.hasOwn(settings, key)) continue;
    delete settings[key];
    dropped.push(key);
  }
  if (!opts.packages && Object.hasOwn(settings, "packages")) {
    delete settings["packages"];
    dropped.push("packages");
  }
  return { settings, dropped };
}

export function npmSpecOf(source: string): string | null {
  return source.startsWith("npm:") ? source.slice("npm:".length) : null;
}

export function npmPackageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

export function packageSpecNamesClientExtension(spec: string, name: string): boolean {
  if (spec === name) return true;
  const npmSpec = npmSpecOf(spec);
  return npmSpec !== null && npmPackageName(npmSpec) === name;
}
