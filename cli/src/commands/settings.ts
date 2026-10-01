import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { AccountClient, ApiSettingsBundle, PutSettingsBundleBody } from "../account/api.js";
import { nonBundleKeysFound, validateConfig } from "../config.js";
import { PiPodError } from "../errors.js";
import { parseJsonc } from "../jsonc.js";
import { info, out, warn } from "../log.js";

export interface SettingsFlags {
  client: AccountClient;
  editor?: string;
}

type SettingsScope = "user" | "org";

const USAGE = "usage: pipod settings <user|org> [show | edit | set <key> <json-value>]";

function readBundle(client: AccountClient, scope: SettingsScope): Promise<ApiSettingsBundle> {
  return scope === "user" ? client.getUserSettings() : client.getOrgSettings();
}

/** Config-only writes omit scripts and Pi files so the server leaves them untouched. */
function writeBundle(client: AccountClient, scope: SettingsScope, body: PutSettingsBundleBody): Promise<{ version: number }> {
  return scope === "user" ? client.putUserSettings(body) : client.putOrgSettings(body);
}

/** The bundle-write contract rejects these on the server (400) — fail here with the fix. */
function assertBundleConfigSendable(config: Record<string, unknown>): void {
  const dropped = nonBundleKeysFound(config);
  if (dropped.length > 0) {
    throw new PiPodError(`not sent: the server bundle no longer accepts ${dropped.join(", ")}`, {
      hint: "local-only keys stay in local files (`template`, `secretResolver`, `pi.chords`); pass --reuse at launch; retired keys must be deleted",
    });
  }
}

/** Validate an edited bundle config locally before it touches the network. */
function assertBundleConfigValid(config: Record<string, unknown>, scope: SettingsScope): void {
  const report = validateConfig(config);
  for (const warning of report.warnings) warn(`${scope} settings: ${warning}`);
  if (report.errors.length > 0) {
    throw new PiPodError(`invalid ${scope} settings config: ${report.errors.join("; ")}`, {
      hint: "fix the config or edit it back — nothing was sent",
    });
  }
}

export async function runSettings(args: string[], flags: SettingsFlags): Promise<number> {
  const [scope = "user", action = "show", ...rest] = args;
  if (scope !== "user" && scope !== "org") {
    throw new PiPodError(`unknown settings scope "${scope}"`, {
      hint: `${USAGE}; templates are managed with \`pipod templates\``,
    });
  }
  if (action === "show") {
    if (rest.length > 0) throw new PiPodError(`usage: pipod settings ${scope}`);
    out(JSON.stringify(await readBundle(flags.client, scope), null, 2));
    return 0;
  }
  if (action === "edit") return editSettings(scope, flags);
  if (action === "set") return setSetting(scope, rest, flags.client);
  throw new PiPodError(`unknown settings action "${action}"`, { hint: "actions: show, edit, set" });
}

async function editSettings(scope: SettingsScope, flags: SettingsFlags): Promise<number> {
  const current = await readBundle(flags.client, scope);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-settings-"));
  const file = path.join(directory, "config.json");
  try {
    fs.writeFileSync(file, `${JSON.stringify(current.config, null, 2)}\n`, { mode: 0o600 });
    const editor = flags.editor ?? process.env["VISUAL"] ?? process.env["EDITOR"];
    if (!editor) throw new PiPodError("$EDITOR is not set");
    const edited = spawnSync("/bin/sh", ["-c", 'exec $EDITOR "$1"', "pi-pod-settings", file], {
      stdio: "inherit",
      env: { ...process.env, EDITOR: editor },
    });
    if (edited.error) throw new PiPodError(`could not run editor: ${edited.error.message}`);
    if (edited.status !== 0) throw new PiPodError(`editor exited with status ${edited.status ?? "unknown"}`);
    const config = readObject(file);
    assertBundleConfigSendable(config);
    assertBundleConfigValid(config, scope);
    const result = await writeBundle(flags.client, scope, { config, version: current.version });
    info(`updated ${scope} settings v${result.version}`);
    return 0;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function setSetting(scope: SettingsScope, args: string[], client: AccountClient): Promise<number> {
  const [dotPath, rawValue, ...extra] = args;
  if (!dotPath || rawValue === undefined || extra.length > 0) {
    throw new PiPodError(`usage: pipod settings ${scope} set <key> <json-value>`);
  }
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch (error) {
    throw new PiPodError(`value is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      hint: `quote strings as JSON, for example: pipod settings ${scope} set pi.model ` + "'\"provider/model\"'",
    });
  }
  const current = await readBundle(client, scope);
  const config = structuredClone(current.config);
  setDotPath(config, dotPath, value);
  assertBundleConfigSendable(config);
  assertBundleConfigValid(config, scope);
  const result = await writeBundle(client, scope, { config, version: current.version });
  info(`set ${scope} setting ${dotPath} (v${result.version})`);
  return 0;
}

function readObject(file: string): Record<string, unknown> {
  const value = parseJsonc(fs.readFileSync(file, "utf8"), file);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PiPodError(`${file} must contain a JSON object`);
  return value as Record<string, unknown>;
}

export function setDotPath(target: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  if (parts.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))) {
    throw new PiPodError(`invalid settings key path: ${dotPath}`);
  }
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (existing === undefined) cursor[part] = {};
    else if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      throw new PiPodError(`cannot set ${dotPath}: ${part} is not an object`);
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}
