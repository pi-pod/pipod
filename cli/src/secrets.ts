/**
 * src/secrets.ts — the four places a secret can live, and who wins.
 *
 * A secret reaching a pod can come from three server scopes and one file on disk, and the
 * file outranks the server. Someone who sets an org secret and sees a different value in the
 * pod has no way to discover that a repo dotenv beat it, so every command here names the
 * scope it is acting on and the listing attributes each name to the layer that won.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AccountClient, ServerSecretScope } from "./account/api.js";
import { PROJECT_ENV_FILE } from "./config.js";
import { parseDotenv } from "./dotenv.js";
import { PiPodError } from "./errors.js";
import { isSecretRef } from "./secret-refs.js";
import { userSecretsDir } from "./userconfig.js";

/** Lowest precedence first — the order the launch merges them in. */
export const SECRET_SCOPES = ["org", "user", "template", "project"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

const SERVER_SCOPES: readonly SecretScope[] = ["org", "user", "template"];

export function isServerScope(scope: SecretScope): scope is ServerSecretScope & SecretScope {
  return SERVER_SCOPES.includes(scope);
}

export interface SecretOrigin {
  scope: SecretScope;
  /** File path for `project`, scope id for the server scopes. */
  source: string;
}

export interface SecretRow {
  name: string;
  /** The layer whose value the pod actually sees. */
  winner: SecretOrigin;
  /** Layers that set the same name and lost, lowest precedence first. */
  shadowed: SecretOrigin[];
}

export interface SecretScopeTarget {
  scope: SecretScope;
  /** Server scope id, or the file path for `project`. */
  id: string;
  label: string;
}

/** Where the project push-time env source lives, whether or not the file exists yet. */
export function projectEnvPath(cwd: string): string {
  return path.resolve(cwd, PROJECT_ENV_FILE);
}

function readFileLayer(file: string | null): { names: string[]; refs: Set<string> } {
  if (!file || !fs.existsSync(file)) return { names: [], refs: new Set() };
  const values = parseDotenv(fs.readFileSync(file, "utf8")).values;
  const names = Object.keys(values);
  return { names, refs: new Set(names.filter((name) => isSecretRef(values[name]!))) };
}

/** Default file for `pipod secrets sync <scope>`: `~/.pi-pod/secrets/<scope>.env`. */
export function defaultSyncEnvPath(scopeToken: string, home?: string): string {
  const dir = userSecretsDir(home);
  if (!dir) throw new PiPodError("cannot locate ~/.pi-pod/secrets on this machine");
  const [head, ...rest] = scopeToken.split("/");
  const file =
    head === "template" && rest.length > 0 ? `template-${rest.join("-")}.env` : `${head ?? scopeToken}.env`;
  return path.join(dir, file);
}

export interface CollectOptions {
  cwd: string;
  home?: string | undefined;
  client: AccountClient;
  /** The selected template, whose server scope sits below the project file. */
  template?: { id: string; name: string } | null;
}

/**
 * Reads names from every layer that applies here. Values are never fetched: the server's
 * secret API is write-only by design, and printing the local ones would defeat the point.
 */
export async function collectSecrets(opts: CollectOptions): Promise<{
  rows: SecretRow[];
  layers: Array<{ scope: SecretScope; source: string; count: number; reachable: boolean }>;
}> {
  const perScope = new Map<
    SecretScope,
    { source: string; names: string[]; refs?: Set<string>; reachable: boolean }
  >();

  const projectFile = projectEnvPath(opts.cwd);

  const targets: Array<[SecretScope, string, string]> = [
    ["org", opts.client.orgId, "org"],
    ["user", opts.client.userId, "you"],
  ];
  if (opts.template) targets.push(["template", opts.template.id, `template ${opts.template.name}`]);
  for (const [scope, id, label] of targets) {
    try {
      const res = await opts.client.listSecrets(scope as ServerSecretScope, id);
      perScope.set(scope, { source: label, names: res.secrets.map((secret) => secret.name), reachable: true });
    } catch {
      perScope.set(scope, { source: label, names: [], reachable: false });
    }
  }

  const project = readFileLayer(projectFile);
  perScope.set("project", {
    source: projectFile,
    names: project.names,
    refs: project.refs,
    reachable: true,
  });

  const byName = new Map<string, SecretOrigin[]>();
  for (const scope of SECRET_SCOPES) {
    const layer = perScope.get(scope);
    if (!layer) continue;
    for (const name of layer.names) {
      const list = byName.get(name) ?? [];
      const source = layer.refs?.has(name) ? `${layer.source} (ref)` : layer.source;
      list.push({ scope, source });
      byName.set(name, list);
    }
  }

  const rows: SecretRow[] = [...byName.entries()]
    .map(([name, origins]) => ({
      name,
      winner: origins[origins.length - 1]!,
      shadowed: origins.slice(0, -1),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const layers = SECRET_SCOPES.filter((s) => perScope.has(s)).map((scope) => {
    const l = perScope.get(scope)!;
    return { scope, source: l.source, count: l.names.length, reachable: l.reachable };
  });

  return { rows, layers };
}

/**
 * Resolves a user-supplied scope token. Template scopes carry which template, because
 * "template" alone is not an address: `template/web-dev` or `template/<uuid>`.
 */
export async function resolveScopeTarget(
  token: string,
  opts: { client: AccountClient; cwd: string; home?: string | undefined },
): Promise<SecretScopeTarget> {
  const [head, ...rest] = token.split("/");
  if (head === "machine") {
    throw new PiPodError("the machine secret scope was removed", {
      hint: "put the value in ~/.pi-pod/secrets/user.env and `pipod secrets sync user`, or in the project .pi-pod/env",
    });
  }
  const scope = head as SecretScope;
  if (!(SECRET_SCOPES as readonly string[]).includes(scope)) {
    throw new PiPodError(`unknown secret scope "${token}"`, {
      hint: `scopes, lowest precedence first: ${SECRET_SCOPES.join(", ")} (templates are addressed as template/<name>)`,
    });
  }

  if (scope === "project") {
    const file = projectEnvPath(opts.cwd);
    return { scope, id: file, label: path.relative(opts.cwd, file) || file };
  }

  if (scope === "org") return { scope, id: opts.client.orgId, label: "org" };
  if (scope === "user") return { scope, id: opts.client.userId, label: "you" };

  const which = rest.join("/");
  if (!which) {
    throw new PiPodError("template secrets need a template", {
      hint: "address it as `template/<name>` or `template/<id>`",
    });
  }
  const { templates } = await opts.client.listTemplates();
  const match =
    templates.find((t) => t.id === which) ??
    templates.find((t) => t.name.toLowerCase() === which.toLowerCase());
  if (!match) {
    throw new PiPodError(`no template named "${which}" in this org`, {
      hint: "list them with `pipod templates`",
    });
  }
  return { scope, id: match.id, label: `template ${match.name}` };
}

/**
 * Upserts one key in a dotenv file, preserving the rest of it verbatim. These files are
 * hand-edited far more often than they are written by a tool, so comments, ordering and
 * `export ` prefixes all survive a write.
 */
export function upsertDotenv(file: string, name: string, value: string): "created" | "updated" {
  const existed = fs.existsSync(file);
  const text = existed ? fs.readFileSync(file, "utf8") : "";
  const lines = text.split("\n");
  const line = `${name}=${quoteIfNeeded(value)}`;

  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq > 0 && body.slice(0, eq).trim() === name) {
      lines[i] = trimmed.startsWith("export ") ? `export ${line}` : line;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 });
  // An existing file may predate the mode argument, which only applies on create.
  fs.chmodSync(file, 0o600);
  return replaced ? "updated" : "created";
}

export function removeFromDotenv(file: string, name: string): boolean {
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const kept = lines.filter((raw) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return true;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf("=");
    return !(eq > 0 && body.slice(0, eq).trim() === name);
  });
  if (kept.length === lines.length) return false;
  fs.writeFileSync(file, kept.join("\n"), { mode: 0o600 });
  return true;
}

/** Values are literal in this format, so anything with whitespace or quotes gets wrapped. */
function quoteIfNeeded(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
