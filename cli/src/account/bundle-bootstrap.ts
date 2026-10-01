import * as fs from "node:fs";
import type { AccountClient, ApiSettingsBundle, ApiTemplate } from "./api.js";
import { compileBundleSource, diffBundle, settingsBundle, templateBundle, type CompiledBundleSource } from "./bundle-source.js";
import { findTemplate } from "./template-ref.js";
import { stripJsonComments } from "../jsonc.js";
import { PiPodError } from "../errors.js";
import { confirm } from "../prompt.js";

export async function bootstrapProjectTemplate(args: {
  client: AccountClient;
  cwd: string;
  home?: string;
  confirmCreate?: (question: string) => Promise<boolean>;
}): Promise<ApiTemplate | null> {
  const source = await compileBundleSource({ source: "project", cwd: args.cwd, home: args.home });
  if (source.templateRef) return null;
  const question = `create template \`${source.name}\` from this project's config and pin it in .pi-pod/config.json?`;
  const approved = args.confirmCreate
    ? await args.confirmCreate(question)
    : await confirm(question, { nonInteractiveDefault: false });
  if (!approved) return null;
  const created = await args.client.createTemplate({
    name: source.name,
    config: source.config,
    initScript: source.initScript,
    bakeScript: source.bakeScript,
    piSettings: source.piFiles,
  });
  try {
    pinTemplateRef(source.configPath, created.name);
  } catch (error) {
    throw new PiPodError(`created template ${created.name}, but could not pin it in ${source.configPath}`, {
      hint: `add \"template\": ${JSON.stringify(created.name)} to that file`,
      cause: error,
    });
  }
  return created;
}

/** Insert a top-level JSONC property while retaining comments/spacing whenever the object is ordinary. */
export function pinTemplateRef(configPath: string, template: string): void {
  const text = fs.readFileSync(configPath, "utf8");
  const stripped = stripJsonComments(text);
  const close = stripped.lastIndexOf("}");
  if (close < 0 || stripped.slice(close + 1).trim() !== "") {
    throw new PiPodError(`cannot pin template in ${configPath}: expected a top-level JSON object`);
  }
  const prefix = text.slice(0, close);
  // Add a sentinel before comment stripping so the JSONC tokenizer does not erase an
  // existing trailing comma as though the closing brace immediately followed it.
  const before = stripJsonComments(`${prefix}null`).slice(0, -4).trimEnd();
  const last = before.at(-1);
  const separator = last === "{" || last === "," ? "" : ",";
  const entry = `  "template": ${JSON.stringify(template)}\n`;
  const trimmed = prefix.trimEnd();
  // A trailing line comment would swallow anything appended after it; the sentinel probe
  // says whether the last significant line can safely take the separator inline.
  const canInline = stripJsonComments(`${trimmed}null`).trimEnd().endsWith("null");
  const needsNewline = prefix.length > 0 && !prefix.endsWith("\n");
  const body = canInline
    ? `${trimmed}${separator}\n${entry}`
    : `${prefix}${separator}${needsNewline ? "\n" : ""}${entry}`;
  fs.writeFileSync(configPath, `${body}${text.slice(close)}`);
}

export async function projectTemplateStaleness(args: {
  client: AccountClient;
  cwd: string;
  home?: string;
}): Promise<string | null> {
  const source = await compileBundleSource({ source: "project", cwd: args.cwd, home: args.home, includeEnv: false });
  if (!source.templateRef) return null;
  const template = await findTemplate(args.client, source.templateRef);
  const drift = diffBundle(source, templateBundle(template));
  if (!drift.changed) return null;
  const version = template.version !== undefined ? ` v${template.version}` : "";
  return `local config differs from template ${template.name}${version} — ` +
    "run `pipod push` to upload or `pipod pull` to adopt the template";
}

/** Name the differing parts of a diff, at most four of them, for a one-line drift warning. */
function driftSummary(lines: string[]): string {
  const labels: string[] = [];
  for (const line of lines) {
    if (line.startsWith("config ")) labels.push(line.slice(0, line.indexOf(": ")));
    else if (line.endsWith(": changed")) labels.push(line.slice(0, -": changed".length));
  }
  return labels.length > 4 ? `${labels.slice(0, 4).join(", ")}, …` : labels.join(", ");
}

/**
 * `~/.pi-pod/config.json` + `~/.pi/agent/` are the user layer's local source now, so a launch
 * says when they and the server bundle have drifted apart. A missing source reads as empty.
 */
export async function userLayerStaleness(args: {
  client: AccountClient;
  home?: string;
}): Promise<string | null> {
  let source: CompiledBundleSource;
  try {
    source = await compileBundleSource({ source: "user-dir", home: args.home, includeEnv: false });
  } catch (error) {
    // A drift check is advisory; an unreadable local file must not take the launch down.
    if (error instanceof PiPodError) return `user settings source: ${error.message}`;
    throw error;
  }
  let current: ApiSettingsBundle;
  try {
    current = await args.client.getUserSettings();
  } catch (error) {
    // Pod tokens may launch but cannot read the user bundle; the advisory check has no answer.
    if (error instanceof PiPodError && error.status === 403) return null;
    throw error;
  }
  const drift = diffBundle(source, settingsBundle(current));
  if (!drift.changed) return null;
  return `local user settings differ from the server user bundle v${current.version} ` +
    `(${driftSummary(drift.lines)}) — ` +
    "run `pipod push user` to upload or `pipod pull user` to adopt the server copy";
}
