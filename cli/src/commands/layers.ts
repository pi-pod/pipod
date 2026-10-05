/**
 * src/commands/layers.ts — the `push` / `pull` / `diff` grammar shared by the three verbs.
 *
 * Every persistent server bundle has one local directory as its source of truth:
 *   template [<name>]  → this project (.pi-pod/, .pi/)
 *   user               → ~/.pi-pod/config.json + ~/.pi/agent/
 *   org                → ~/.pi-pod/org/ (or --dir <path>)
 *   policy             → policy.json in that same org directory
 * The verbs move a whole bundle between the two, git-style, after a diff preview.
 */
import { findConfigPath } from "../config.js";
import { PiPodError } from "../errors.js";
import { info, out, warn } from "../log.js";
import type { AccountClient, ApiTemplate } from "../account/api.js";
import {
  compileBundleSource,
  diffBundle,
  orgSourceDir,
  policySourcePath,
  settingsBundle,
  templateBundle,
  type BundleSourceKind,
  type CompiledBundleSource,
  type ServerBundle,
} from "../account/bundle-source.js";
import { findTemplate } from "../account/template-ref.js";
import { displayPath } from "../userconfig.js";

export type Layer = { kind: "template"; name?: string } | { kind: "user" } | { kind: "org" } | { kind: "policy" };

export interface LayerFlags {
  client: AccountClient;
  home?: string | undefined;
  cwd?: string | undefined;
  yes?: boolean | undefined;
}

export interface ParsedLayerArgs {
  layer: Layer;
  dir?: string;
  yes: boolean;
  withSecrets: boolean;
}

const LAYER_USAGE = "template [<name>], user, org, or policy";

/** Parse `[template [<name>] | user | org | policy] [--dir <path>] [--with-secrets] [-y]`. */
export function parseLayerArgs(
  verb: "push" | "pull" | "diff",
  args: string[],
  opts: { cwd: string; home?: string | undefined },
): ParsedLayerArgs {
  const positionals: string[] = [];
  let dir: string | undefined;
  let yes = false;
  let withSecrets = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dir") {
      dir = args[++i];
      if (!dir) throw new PiPodError("--dir needs a value");
    } else if (arg === "--with-secrets" && verb === "push") withSecrets = true;
    else if ((arg === "--yes" || arg === "-y") && verb !== "diff") yes = true;
    else if (arg.startsWith("-")) throw new PiPodError(`unexpected \`pipod ${verb}\` option "${arg}"`);
    else positionals.push(arg);
  }
  const [first, second, ...extra] = positionals;
  let layer: Layer;
  if (first === undefined) {
    if (findConfigPath(opts.cwd, { home: opts.home }) === null) {
      throw new PiPodError(`pipod ${verb} needs a layer: ${LAYER_USAGE}`, {
        hint: "inside a project the default is its pinned template; here there is no project",
      });
    }
    layer = { kind: "template" };
  } else if (first === "template") {
    layer = second === undefined ? { kind: "template" } : { kind: "template", name: second };
  } else if (first === "user" || first === "org" || first === "policy") {
    layer = { kind: first };
    if (second !== undefined) extra.unshift(second);
  } else {
    throw new PiPodError(`unknown layer "${first}"`, { hint: `layers: ${LAYER_USAGE}` });
  }
  if (extra.length > 0) throw new PiPodError(`unexpected \`pipod ${verb}\` argument(s): ${extra.join(" ")}`);
  if (dir !== undefined && layer.kind !== "org" && layer.kind !== "policy") {
    throw new PiPodError("--dir only applies to the org and policy layers");
  }
  return { layer, ...(dir !== undefined ? { dir } : {}), yes, withSecrets };
}

export function sourceKindOf(layer: Layer): BundleSourceKind {
  switch (layer.kind) {
    case "template": return "project";
    case "user": return "user-dir";
    case "org": return "org-dir";
    case "policy": return "policy-file";
  }
}

/** The server side of a layer, read fresh so writes can compare-and-swap against it. */
export interface RemoteLayer {
  bundle: ServerBundle;
  version: number | undefined;
  secretNames: string[];
  /** `template <name> v3`, `user settings v2`, `org settings v0`, `org policy v1` */
  label: string;
  template?: ApiTemplate;
  scope: "template" | "user" | "org" | "policy";
  scopeId: string;
}

export async function fetchRemoteLayer(
  client: AccountClient,
  layer: Layer,
  source: Pick<CompiledBundleSource, "templateRef">,
): Promise<RemoteLayer> {
  if (layer.kind === "template") {
    const ref = layer.name ?? source.templateRef;
    if (!ref) {
      throw new PiPodError("this project does not pin a template", {
        hint: "name one: `pipod push template <name>`; a first launch offers to bootstrap and pin one",
      });
    }
    const template = await findTemplate(client, ref);
    const listed = await client.listSecrets("template", template.id).catch(() => ({ secrets: [] }));
    const version = template.version;
    return {
      bundle: templateBundle(template),
      version,
      secretNames: listed.secrets.map((entry) => entry.name),
      label: `template ${template.name}${version !== undefined ? ` v${version}` : ""}`,
      template,
      scope: "template",
      scopeId: template.id,
    };
  }
  if (layer.kind === "policy") {
    const current = await client.getOrgPolicy();
    return {
      bundle: settingsBundle(current),
      version: current.version,
      secretNames: [],
      label: `org policy v${current.version}`,
      scope: "policy",
      scopeId: client.orgId,
    };
  }
  const current = layer.kind === "user" ? await client.getUserSettings() : await client.getOrgSettings();
  const scopeId = layer.kind === "user" ? client.userId : client.orgId;
  const listed = await client.listSecrets(layer.kind, scopeId).catch(() => ({ secrets: [] }));
  return {
    bundle: settingsBundle(current),
    version: current.version,
    secretNames: listed.secrets.map((entry) => entry.name),
    label: `${layer.kind} settings v${current.version}`,
    scope: layer.kind,
    scopeId,
  };
}

/** How the local side of a layer is named in diff headings and summaries. */
export function localLabel(layer: Layer, flags: { home?: string | undefined; dir?: string | undefined }): string {
  if (layer.kind === "template") return "project";
  if (layer.kind === "user") return "~/.pi-pod + ~/.pi/agent";
  if (layer.kind === "policy") return displayPath(policySourcePath({ dir: flags.dir, home: flags.home }), flags.home);
  return displayPath(orgSourceDir({ dir: flags.dir, home: flags.home }), flags.home);
}

export function printDiff(heading: string, lines: string[]): void {
  if (lines.length === 0) return;
  info(`${heading}:`);
  for (const line of lines) out(`  ${line}`);
}

/** `pipod diff [layer]`: report only; exit 1 on drift so scripts can gate on it. */
export async function runDiff(args: string[], flags: LayerFlags): Promise<number> {
  const cwd = flags.cwd ?? process.cwd();
  const parsed = parseLayerArgs("diff", args, { cwd, home: flags.home });
  const source = await compileBundleSource({
    source: sourceKindOf(parsed.layer),
    cwd,
    home: flags.home,
    includeEnv: "names",
    dir: parsed.dir,
  });
  for (const warning of source.warnings) warn(warning);
  const remote = await fetchRemoteLayer(flags.client, parsed.layer, source);
  const diff = diffBundle(source, remote.bundle, remote.secretNames);
  printDiff(`${localLabel(parsed.layer, { home: flags.home, dir: parsed.dir })} vs ${remote.label}`, diff.lines);
  if (!diff.changed) info(`${remote.label} is up to date`);
  return diff.changed ? 1 : 0;
}
