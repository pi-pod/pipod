import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { AccountClient } from "../account/api.js";
import { takeClientOnlyKeys } from "../account/launch-overlays.js";
import { findConfigPath, nonBundleKeysFound, validateConfig } from "../config.js";
import { PiPodError } from "../errors.js";
import { parseJsonc } from "../jsonc.js";
import { info, out, warn } from "../log.js";
import { fetchRemoteLayer, writeLayerConfig, type Layer, type RemoteLayer } from "./layers.js";

export interface SettingsFlags {
  client: AccountClient;
  editor?: string;
  cwd?: string | undefined;
  home?: string | undefined;
}

const USAGE =
  "usage: pipod settings [user | org | policy | template [<name>]] [show | edit | set <key> <value> | unset <key>]";
const ACTIONS = ["show", "edit", "set", "unset"];

type SettingsCommand =
  | { action: "show" }
  | { action: "edit" }
  | { action: "set"; key: string; value: unknown }
  | { action: "unset"; key: string };

/**
 * `pipod settings [layer] [action]`: show or change one server layer's config directly — the
 * same layers `pipod push` replaces whole. Writes carry only the config, so the server keeps the
 * layer's scripts and Pi files, and compare-and-swap on the version read.
 */
export async function runSettings(args: string[], flags: SettingsFlags): Promise<number> {
  const { layer, rest } = parseLayer(args);
  const command = parseCommand(layer, rest);
  const remote = await fetchRemoteLayer(flags.client, layer, {
    templateRef: layer.kind === "template" && layer.name === undefined ? pinnedTemplateRef(flags) : null,
  });
  if (command.action === "show") {
    out(JSON.stringify({ ...remote.bundle, version: remote.version }, null, 2));
    return 0;
  }
  const config = structuredClone(remote.bundle.config);
  if (command.action === "set") setDotPath(config, command.key, command.value);
  if (command.action === "unset") unsetDotPath(config, command.key);
  const next = command.action === "edit" ? editInEditor(config, flags) : config;
  assertConfigSendable(remote, next);
  const version = await writeLayerConfig(flags.client, remote, next);
  const done = command.action === "edit" ? "updated" : command.action;
  const key = command.action === "edit" ? "" : ` ${command.key}`;
  info(`${done} ${remote.name}${key}${version === undefined ? "" : ` (v${version})`}`);
  return 0;
}

/**
 * `[user | org | policy | template [<name>]]`, user when omitted. As with `pipod push`, a
 * template's name is optional and defaults to the project's pin; a word after `template` that
 * is an action is the action, so a template named like one is addressed by its id.
 */
function parseLayer(args: string[]): { layer: Layer; rest: string[] } {
  const [scope = "user", ...rest] = args;
  if (scope === "user" || scope === "org" || scope === "policy") return { layer: { kind: scope }, rest };
  if (scope === "template") {
    const [name, ...afterName] = rest;
    return name === undefined || ACTIONS.includes(name)
      ? { layer: { kind: "template" }, rest }
      : { layer: { kind: "template", name }, rest: afterName };
  }
  throw new PiPodError(`unknown settings layer "${scope}"`, { hint: USAGE });
}

function parseCommand(layer: Layer, args: string[]): SettingsCommand {
  const words = layer.kind === "template" && layer.name !== undefined ? `template ${layer.name}` : layer.kind;
  const [action = "show", ...rest] = args;
  switch (action) {
    case "show":
    case "edit":
      if (rest.length > 0) throw new PiPodError(`usage: pipod settings ${words} ${action}`);
      return { action };
    case "set": {
      const [key, raw, ...extra] = rest;
      if (!key || raw === undefined || extra.length > 0) throw new PiPodError(`usage: pipod settings ${words} set <key> <value>`);
      // JSON when it parses (2, true, ["a"]), otherwise the text itself: `set pi.model a/b`.
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      return { action, key, value };
    }
    case "unset": {
      const [key, ...extra] = rest;
      if (!key || extra.length > 0) throw new PiPodError(`usage: pipod settings ${words} unset <key>`);
      return { action, key };
    }
    default:
      throw new PiPodError(`unknown settings action "${action}"`, { hint: "actions: show, edit, set, unset" });
  }
}

/** The template this project pins in its .pi-pod/config.json; null outside a project or unpinned. */
function pinnedTemplateRef(flags: SettingsFlags): string | null {
  const configPath = findConfigPath(flags.cwd ?? process.cwd(), { home: flags.home });
  if (!configPath) return null;
  const raw = readObject(configPath);
  return takeClientOnlyKeys(raw).template || null;
}

/**
 * Check a changed config before it touches the network. Every layer but the policy holds pod
 * config (pipod-config(5)); the policy's schema lives on the server alone, which names any key
 * or value it refuses.
 */
function assertConfigSendable(remote: RemoteLayer, config: Record<string, unknown>): void {
  if (remote.scope === "policy") return;
  // The bundle-write contract rejects these on the server (400) — fail here with the fix.
  const dropped = nonBundleKeysFound(config);
  if (dropped.length > 0) {
    throw new PiPodError(`not sent: the server bundle no longer accepts ${dropped.join(", ")}`, {
      hint: "local-only keys stay in local files (`template`, `secretResolver`, `pi.chords`); pass --reuse at launch; retired keys must be deleted",
    });
  }
  const report = validateConfig(config);
  for (const warning of report.warnings) warn(`${remote.name}: ${warning}`);
  if (report.errors.length > 0) {
    throw new PiPodError(`invalid ${remote.name} config: ${report.errors.join("; ")}`, {
      hint: "fix the config or edit it back — nothing was sent",
    });
  }
}

/** Open the config in $VISUAL/$EDITOR and return what was saved. */
function editInEditor(config: Record<string, unknown>, flags: SettingsFlags): Record<string, unknown> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-settings-"));
  const file = path.join(directory, "config.json");
  try {
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const editor = flags.editor ?? process.env["VISUAL"] ?? process.env["EDITOR"];
    if (!editor) throw new PiPodError("$EDITOR is not set");
    const edited = spawnSync("/bin/sh", ["-c", 'exec $EDITOR "$1"', "pi-pod-settings", file], {
      stdio: "inherit",
      env: { ...process.env, EDITOR: editor },
    });
    if (edited.error) throw new PiPodError(`could not run editor: ${edited.error.message}`);
    if (edited.status !== 0) throw new PiPodError(`editor exited with status ${edited.status ?? "unknown"}`);
    return readObject(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Delete a dotted key, and any object it leaves empty. Absent already is fine. */
function unsetDotPath(target: Record<string, unknown>, dotPath: string): void {
  const [head, ...rest] = dotPath.split(".");
  const child = target[head!];
  if (rest.length === 0) {
    delete target[head!];
  } else if (child !== null && typeof child === "object" && !Array.isArray(child)) {
    unsetDotPath(child as Record<string, unknown>, rest.join("."));
    if (Object.keys(child).length === 0) delete target[head!];
  }
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
