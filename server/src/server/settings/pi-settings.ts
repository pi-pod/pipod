import { createHash } from "node:crypto";
import { z } from "zod";
import {
  POD_PI_AGENT_DIR,
  filterSettings,
  findLiteralMcporterCredentials,
  findLiteralModelCredentials,
  installHostPackages,
  npmSpecOf,
  planModel,
  sanitizeModelsForTransport,
  selectableProviders,
  uploadHostConfig,
  type HostConfigPlan,
} from "../../core/hostconfig.js";
import type { Sandbox } from "../../core/providers/types.js";
import { mergeConfigLayers } from "../../core/userconfig.js";
import { badRequest } from "../httperrors.js";

export const MAX_PI_SETTINGS_BYTES = 256 * 1024;
export const MAX_PERSISTED_PI_SETTINGS_BYTES = 256 * 1024;
export const MAX_PI_SETTINGS_PACKAGES = 256;
export const MAX_PI_SETTINGS_PACKAGE_LENGTH = 2048;
export const MAX_PI_AGENT_FILES = 500;
export const MAX_PI_AGENT_PATH_BYTES = 1024;

export const PI_SETTINGS_FILE_NAMES = [
  "settings.json",
  "models.json",
  "mcporter.json",
  "subagents.json",
  "agents",
] as const;
export type PiSettingsFileName = (typeof PI_SETTINGS_FILE_NAMES)[number];

const PiSettingsFileSchema = z.record(z.unknown());
const PiAgentFilesSchema = z.record(z.string());

export const PiSettingsFilesSchema = z
  .object({
    settings: PiSettingsFileSchema.optional(),
    models: PiSettingsFileSchema.optional(),
    mcporter: PiSettingsFileSchema.optional(),
    subagents: PiSettingsFileSchema.optional(),
    agents: PiAgentFilesSchema.optional(),
  })
  .strict();
export type PiSettingsFiles = z.infer<typeof PiSettingsFilesSchema>;

export const ProjectPiSettingsFilesSchema = PiSettingsFilesSchema.omit({ models: true });

/** Two explicit scopes used by request-local launches and sanitized template custody. */
export const LocalPiSettingsSchema = z
  .object({
    user: PiSettingsFilesSchema.optional(),
    project: ProjectPiSettingsFilesSchema.optional(),
  })
  .strict();
export type LocalPiSettingsLayers = z.infer<typeof LocalPiSettingsSchema>;

/**
 * Why a template write rejects `{user, project}` instead of flattening it.
 *
 * The legacy nested input shape was removed by the Simplify-config change: new writes must
 * send the canonical flat bundle. Stored rows written before the removal still exist, so
 * {@link flattenTemplatePiSettings} stays as the read-time migration for them — but anything
 * newly authored goes through this message and flattened client-side instead.
 */
export const LEGACY_TEMPLATE_PI_SETTINGS_ERROR =
  "template piSettings no longer accepts the legacy {user, project} shape: send the canonical " +
  "flat bundle (settings, models, mcporter, subagents, agents) with the old project scope merged " +
  "over the user scope per file, keeping both settings.json packages lists";

/** 400 when a template write still carries the retired nested shape. Called by the input
 * schema's refinement and directly by storage canonicalization for programmatic callers. */
export function rejectLegacyTemplatePiSettings(input: unknown): void {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    if (Object.hasOwn(input, "user") || Object.hasOwn(input, "project")) {
      throw badRequest(LEGACY_TEMPLATE_PI_SETTINGS_ERROR);
    }
  }
}

/** Flat only. A legacy `{user, project}` payload also passes the loose second variant so the
 * union-level refinement can fail it with {@link LEGACY_TEMPLATE_PI_SETTINGS_ERROR} — a bare
 * "unrecognized key" report would say nothing about the migration. Non-legacy payloads that
 * miss the flat shape fail with the flat schema's own strict issues instead. */
export const TemplatePiSettingsInputSchema = z
  .union([PiSettingsFilesSchema, z.object({}).passthrough()])
  .superRefine((val, ctx) => {
    if (typeof val !== "object" || val === null) return;
    if ("user" in val || "project" in val) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: LEGACY_TEMPLATE_PI_SETTINGS_ERROR });
      return;
    }
    const flat = PiSettingsFilesSchema.safeParse(val);
    if (!flat.success) {
      for (const issue of flat.error.issues) ctx.addIssue(issue);
    }
  });
export type TemplatePiSettingsInput = z.infer<typeof PiSettingsFilesSchema>;

export interface PiSettingsMeta {
  files: PiSettingsFileName[];
  bytes: number;
  packageCount: number;
  droppedKeys: string[];
}

export interface PlannedPiSettings {
  plan: HostConfigPlan;
  /** Project-scoped files are written after init so they cannot make a clone workdir non-empty. */
  projectUploads: HostConfigPlan["uploads"];
  files: PiSettingsFiles;
  meta: PiSettingsMeta;
}

/** Identity of the Pi files and packages a launch writes into its pod — what a warm disk keeps. */
export function piSettingsDigest(settings: PlannedPiSettings): string {
  return createHash("sha256")
    .update(JSON.stringify({ files: settings.files, packages: settings.plan.packages }))
    .digest("hex");
}

function canonical(value: Record<string, unknown>): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function objectOrError(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be a JSON object`);
  }
  return { ...(value as Record<string, unknown>) };
}

function sourceOfPackage(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() ? entry : null;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const source = (entry as { source?: unknown }).source;
  return typeof source === "string" && source.trim() ? source : null;
}

function packageEntries(
  settings: Record<string, unknown>,
  label: string,
): Array<{ source: string; value: unknown }> {
  if (settings["packages"] !== undefined && !Array.isArray(settings["packages"])) {
    throw badRequest(`${label} packages must be an array`);
  }
  const entries = Array.isArray(settings["packages"]) ? settings["packages"] : [];
  return entries.map((value) => {
    const source = sourceOfPackage(value);
    if (source === null) {
      throw badRequest(`every ${label} package must be a source string or an object with source`);
    }
    if (Buffer.byteLength(source) > MAX_PI_SETTINGS_PACKAGE_LENGTH) {
      throw badRequest(`a ${label} package source exceeds ${MAX_PI_SETTINGS_PACKAGE_LENGTH} bytes`);
    }
    // installHostPackages uses a shared `sh -c` npm probe. Single quotes and line controls
    // could escape its per-source quoting; reject them before the value reaches that boundary.
    if (source.includes("'") || /[\0\r\n]/.test(source)) {
      throw badRequest(`${label} package sources cannot contain quotes or control characters`);
    }
    return { source, value };
  });
}

function mergedObject(
  lower: Record<string, unknown> | undefined,
  upper: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!lower && !upper) return undefined;
  return objectOrError(mergeConfigLayers(lower ?? {}, upper ?? {}), "merged Pi settings file");
}

function mergedSettingsFile(
  lower: Record<string, unknown> | undefined,
  upper: Record<string, unknown> | undefined,
  labels: { lower: string; upper: string },
): Record<string, unknown> | undefined {
  // Validate each declaration before merging. A valid higher array must not hide a malformed
  // lower `packages` value (and vice versa) at this trust boundary.
  if (lower !== undefined) packageEntries(lower, labels.lower);
  if (upper !== undefined) packageEntries(upper, labels.upper);
  const merged = mergedObject(lower, upper);
  if (!merged) return undefined;
  const lowerPackages = Array.isArray(lower?.["packages"]) ? lower["packages"] : [];
  const upperPackages = Array.isArray(upper?.["packages"]) ? upper["packages"] : [];
  if (lowerPackages.length > 0 || upperPackages.length > 0) {
    // planLocalPiSettings validates and de-duplicates by source after both bundle and scope
    // merges. Preserve both declarations here instead of applying the normal array-replace rule.
    merged["packages"] = [...lowerPackages, ...upperPackages];
  }
  return merged;
}

function filteredSettings(
  value: Record<string, unknown> | undefined,
  scope: "user" | "project",
  packages: boolean,
): { settings?: Record<string, unknown>; dropped: string[] } {
  if (value === undefined) return { dropped: [] };
  const raw = objectOrError(value, `${scope} settings.json`);
  const filtered = filterSettings(JSON.stringify(raw), `${scope} settings.json`, { packages });
  return {
    settings: filtered.settings,
    dropped: filtered.dropped.map((key) => `${scope}.${key}`),
  };
}

function agentEntries(
  value: Record<string, string> | undefined,
  scope: "user" | "project",
): Array<{ relative: string; contents: Uint8Array }> {
  if (value === undefined) return [];
  const raw = objectOrError(value, `${scope} agents`);
  return Object.entries(raw)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relative, content]) => {
      if (typeof content !== "string") throw badRequest(`${scope} agent ${relative} must be UTF-8 text`);
      const segments = relative.split("/");
      if (
        relative.length === 0 ||
        relative.startsWith("/") ||
        relative.includes("\\") ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        throw badRequest(`${scope} agent paths must be safe relative paths`);
      }
      if (Buffer.byteLength(relative) > MAX_PI_AGENT_PATH_BYTES) {
        throw badRequest(`${scope} agent path exceeds ${MAX_PI_AGENT_PATH_BYTES} bytes`);
      }
      return { relative, contents: Buffer.from(content, "utf8") };
    });
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => [key, canonicalJsonValue(child)]),
  );
}

/** Read-time migration for template rows written before the legacy `{user, project}` input
 * shape was removed. Project wins per file while settings package declarations remain
 * additive. New flat rows pass through unchanged. Retained for stored rows only — new writes
 * go through {@link rejectLegacyTemplatePiSettings} instead. */
export function flattenTemplatePiSettings(input: unknown): PiSettingsFiles {
  const flat = PiSettingsFilesSchema.safeParse(input);
  if (flat.success) return flat.data;
  const legacy = LocalPiSettingsSchema.safeParse(input);
  if (!legacy.success) {
    throw badRequest(
      "invalid Pi settings bundle",
      legacy.error.issues.map((issue) => `${issue.path.join(".") || "piSettings"}: ${issue.message}`),
    );
  }
  const user = legacy.data.user;
  const project = legacy.data.project;
  const merged: PiSettingsFiles = {};
  const settings = mergedSettingsFile(user?.settings, project?.settings, {
    lower: "template user settings.json",
    upper: "template project settings.json",
  });
  const models = user?.models;
  const mcporter = mergedObject(user?.mcporter, project?.mcporter);
  const subagents = mergedObject(user?.subagents, project?.subagents);
  const agents = mergedObject(user?.agents, project?.agents);
  if (settings) merged.settings = settings;
  if (models) merged.models = models;
  if (mcporter) merged.mcporter = mcporter;
  if (subagents) merged.subagents = subagents;
  if (agents) merged.agents = PiAgentFilesSchema.parse(agents);
  return PiSettingsFilesSchema.parse(merged);
}

/** Merge flat bundle file sets in specificity order. */
export function mergePiSettingsFileSets(...layers: Array<PiSettingsFiles | null | undefined>): PiSettingsFiles {
  let merged: PiSettingsFiles = {};
  for (const layerRaw of layers) {
    if (!layerRaw) continue;
    const layer = PiSettingsFilesSchema.parse(layerRaw);
    const next: PiSettingsFiles = {};
    const settings = mergedSettingsFile(merged.settings, layer.settings, {
      lower: "lower bundle settings.json",
      upper: "higher bundle settings.json",
    });
    const models = mergedObject(merged.models, layer.models);
    const mcporter = mergedObject(merged.mcporter, layer.mcporter);
    const subagents = mergedObject(merged.subagents, layer.subagents);
    const agents = mergedObject(merged.agents, layer.agents);
    if (settings) next.settings = settings;
    if (models) next.models = models;
    if (mcporter) next.mcporter = mcporter;
    if (subagents) next.subagents = subagents;
    if (agents) next.agents = PiAgentFilesSchema.parse(agents);
    merged = next;
  }
  return PiSettingsFilesSchema.parse(merged);
}

/**
 * Bundles are readable configuration, not secret custody. Literal credentials that have a
 * supported reference alternative (`$ENV_VAR`, backed by secrets) are rejected — naming
 * scope/path only, never values — instead of being silently stripped. Silent stripping taught
 * users their secret was stored when it was actually dropped; an explicit error teaches the
 * reference mechanism. Shapes that cannot be reliably scanned (agent prompts, subagent blobs,
 * command args) are left alone and documented as readable config.
 */
function rejectLiteralBundleCredentials(
  files: { models?: unknown; mcporter?: unknown },
  label: string,
): void {
  if (files.models !== undefined) {
    const paths = findLiteralModelCredentials(objectOrError(files.models, `${label} models.json`));
    if (paths.length > 0) {
      const shown = paths.slice(0, 5).join(", ");
      throw badRequest(
        `${label} models.json embeds literal credentials at ${shown}${paths.length > 5 ? ` and ${paths.length - 5} more` : ""}`,
        "store the credential as a secret and reference it as $ENV_VAR instead",
      );
    }
  }
  if (files.mcporter !== undefined) {
    const paths = findLiteralMcporterCredentials(files.mcporter);
    if (paths.length > 0) {
      const shown = paths.slice(0, 5).join(", ");
      throw badRequest(
        `${label} mcporter.json embeds literal credentials at ${shown}${paths.length > 5 ? ` and ${paths.length - 5} more` : ""}`,
        "store the credential as a secret and reference it as $ENV_VAR instead",
      );
    }
  }
}

/** Prepare one flat file set for plaintext bundle custody. */
export function canonicalizePiSettingsFilesForStorage(input: unknown): PiSettingsFiles {
  const parsed = PiSettingsFilesSchema.safeParse(input);
  if (!parsed.success) {
    throw badRequest(
      "invalid Pi settings bundle",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "piFiles"}: ${issue.message}`),
    );
  }
  rejectLiteralBundleCredentials({ models: parsed.data.models, mcporter: parsed.data.mcporter }, "bundle");
  const sanitized: PiSettingsFiles = {};
  if (parsed.data.settings !== undefined) {
    sanitized.settings = filteredSettings(parsed.data.settings, "user", true).settings!;
  }
  if (parsed.data.models !== undefined) {
    sanitized.models = sanitizeModelsForTransport(
      objectOrError(parsed.data.models, "models.json"),
    ).models;
  }
  if (parsed.data.mcporter !== undefined) {
    sanitized.mcporter = objectOrError(parsed.data.mcporter, "mcporter.json");
  }
  if (parsed.data.subagents !== undefined) {
    sanitized.subagents = objectOrError(parsed.data.subagents, "subagents.json");
  }
  if (parsed.data.agents !== undefined) {
    sanitized.agents = Object.fromEntries(
      agentEntries(parsed.data.agents, "user").map((entry) => [
        entry.relative,
        new TextDecoder().decode(entry.contents),
      ]),
    );
  }

  let canonicalText: string;
  let canonicalBundle: PiSettingsFiles;
  try {
    canonicalText = JSON.stringify(canonicalJsonValue(sanitized));
    canonicalBundle = PiSettingsFilesSchema.parse(JSON.parse(canonicalText));
  } catch {
    throw badRequest("Pi settings bundle must contain only JSON values");
  }
  if (Buffer.byteLength(canonicalText, "utf8") > MAX_PERSISTED_PI_SETTINGS_BYTES) {
    throw badRequest(`canonical Pi settings bundle exceeds ${MAX_PERSISTED_PI_SETTINGS_BYTES} bytes`);
  }
  planLocalPiSettings({ user: canonicalBundle });
  return canonicalBundle;
}

/** Template write boundary: flat input only, always stored flat. Stored legacy rows never
 * reach here — they are migrated on read by {@link flattenTemplatePiSettings}. */
export function canonicalizePiSettingsForStorage(input: unknown): PiSettingsFiles {
  rejectLegacyTemplatePiSettings(input);
  return canonicalizePiSettingsFilesForStorage(input);
}

/**
 * Merge one bundle's user and project Pi files for a launch. Project package declarations are
 * additive because Pi treats them as resources from a second scope; duplicate sources take the
 * project entry so its object-form filters win. Settings and mcporter are promoted to pod user
 * scope because path-keyed project trust deliberately does not travel. Subagent settings and
 * agent files retain their scopes so pi-subagents can enforce project trust and precedence.
 */
export function planLocalPiSettings(
  layers: LocalPiSettingsLayers | null | undefined,
  opts: { packages?: boolean; userSettings?: boolean; workdir?: string } = {},
): PlannedPiSettings | null {
  const effectiveLayers = opts.userSettings === false ? { project: layers?.project } : layers;
  if (!effectiveLayers?.user && !effectiveLayers?.project) return null;
  // Launch boundary: request-local layers bypass stored-bundle canonicalization, so the
  // same rejection runs here. Sanitization below stays as defense-in-depth.
  if (effectiveLayers.user) {
    rejectLiteralBundleCredentials(
      { models: effectiveLayers.user.models, mcporter: effectiveLayers.user.mcporter },
      "user",
    );
  }
  if (effectiveLayers.project) {
    // Project scope has no models.json (ProjectPiSettingsFilesSchema omits it); mcporter
    // merges up to pod user scope, so its literals are refused here too.
    rejectLiteralBundleCredentials({ mcporter: effectiveLayers.project.mcporter }, "project");
  }

  const carryPackages = opts.packages !== false;
  const userSettings = filteredSettings(effectiveLayers.user?.settings, "user", carryPackages);
  const projectSettings = filteredSettings(effectiveLayers.project?.settings, "project", carryPackages);
  const settings = mergedObject(userSettings.settings, projectSettings.settings);
  const userPackages = packageEntries(userSettings.settings ?? {}, "user settings.json");
  const projectPackages = packageEntries(projectSettings.settings ?? {}, "project settings.json");
  const packageValues = new Map<string, unknown>();
  for (const entry of [...userPackages, ...projectPackages]) packageValues.set(entry.source, entry.value);
  if (packageValues.size > MAX_PI_SETTINGS_PACKAGES) {
    throw badRequest(`merged settings.json names more than ${MAX_PI_SETTINGS_PACKAGES} packages`);
  }
  if (settings && (userPackages.length > 0 || projectPackages.length > 0)) {
    settings["packages"] = [...packageValues.values()];
  }

  const files: PiSettingsFiles = {};
  if (settings) files.settings = settings;
  let modelDroppedKeys: string[] = [];
  if (effectiveLayers.user?.models !== undefined) {
    const filtered = sanitizeModelsForTransport(
      objectOrError(effectiveLayers.user.models, "user models.json"),
    );
    files.models = filtered.models;
    modelDroppedKeys = filtered.dropped.map((key) => `user.models.${key}`);
  }
  const userMcporter =
    effectiveLayers.user?.mcporter === undefined
      ? undefined
      : objectOrError(effectiveLayers.user.mcporter, "user mcporter.json");
  const projectMcporter =
    effectiveLayers.project?.mcporter === undefined
      ? undefined
      : objectOrError(effectiveLayers.project.mcporter, "project mcporter.json");
  const mcporter = mergedObject(userMcporter, projectMcporter);
  if (mcporter) files.mcporter = mcporter;

  const userSubagents =
    effectiveLayers.user?.subagents === undefined
      ? undefined
      : objectOrError(effectiveLayers.user.subagents, "user subagents.json");
  const projectSubagents =
    effectiveLayers.project?.subagents === undefined
      ? undefined
      : objectOrError(effectiveLayers.project.subagents, "project subagents.json");
  if (userSubagents) files.subagents = userSubagents;
  const userAgents = agentEntries(effectiveLayers.user?.agents, "user");
  const projectAgents = agentEntries(effectiveLayers.project?.agents, "project");
  if (userAgents.length + projectAgents.length > MAX_PI_AGENT_FILES) {
    throw badRequest(`Pi settings launch overlay contains more than ${MAX_PI_AGENT_FILES} agent files`);
  }
  if (effectiveLayers.user?.agents !== undefined) files.agents = { ...effectiveLayers.user.agents };

  const uploads: HostConfigPlan["uploads"] = [];
  const projectUploads: HostConfigPlan["uploads"] = [];
  const items: PiSettingsFileName[] = [];
  const addItem = (item: PiSettingsFileName): void => {
    if (!items.includes(item)) items.push(item);
  };
  for (const [key, name] of [
    ["settings", "settings.json"],
    ["models", "models.json"],
    ["mcporter", "mcporter.json"],
    ["subagents", "subagents.json"],
  ] as const) {
    const value = files[key];
    if (!value) continue;
    uploads.push({
      podPath: `${POD_PI_AGENT_DIR}/${name}`,
      contents: canonical(value),
      mode: 0o600,
      source: `(launch Pi settings user ${name})`,
    });
    addItem(name);
  }
  for (const agent of userAgents) {
    uploads.push({
      podPath: `${POD_PI_AGENT_DIR}/agents/${agent.relative}`,
      contents: agent.contents,
      mode: 0o600,
      source: `(launch Pi settings user agents/${agent.relative})`,
    });
  }
  if (effectiveLayers.user?.agents !== undefined) addItem("agents");

  const projectPiDir = `${(opts.workdir ?? "/workspace").replace(/\/+$/, "")}/.pi`;
  if (projectSubagents) {
    projectUploads.push({
      podPath: `${projectPiDir}/subagents.json`,
      contents: canonical(projectSubagents),
      mode: 0o600,
      source: "(launch Pi settings project subagents.json)",
    });
    addItem("subagents.json");
  }
  for (const agent of projectAgents) {
    projectUploads.push({
      podPath: `${projectPiDir}/agents/${agent.relative}`,
      contents: agent.contents,
      mode: 0o600,
      source: `(launch Pi settings project agents/${agent.relative})`,
    });
  }
  if (effectiveLayers.project?.agents !== undefined) addItem("agents");
  if (uploads.length === 0 && projectUploads.length === 0) return null;

  const totalBytes = [...uploads, ...projectUploads].reduce(
    (sum, upload) => sum + upload.contents.byteLength,
    0,
  );
  if (totalBytes > MAX_PI_SETTINGS_BYTES) {
    throw badRequest(`Pi settings launch overlay exceeds ${MAX_PI_SETTINGS_BYTES} bytes`);
  }
  const packages = [...packageValues.keys()];
  const droppedKeys = [...userSettings.dropped, ...projectSettings.dropped, ...modelDroppedKeys];
  const plan: HostConfigPlan = {
    requested: true,
    packages,
    uploads,
    totalBytes,
    droppedKeys,
    model: settings ? planModel(settings, "merged launch Pi settings.json") : null,
    providers: settings ? selectableProviders(settings) : [],
    warnings: [],
    items,
  };
  return {
    plan,
    projectUploads,
    files,
    meta: {
      files: items,
      bytes: totalBytes,
      packageCount: packages.length,
      droppedKeys,
    },
  };
}

/** Preserve object-form resource filters while pruning package sources that failed to install. */
function withRetainedPackages(plan: HostConfigPlan, retainedSources: string[]): HostConfigPlan {
  const retained = new Set(retainedSources);
  const target = `${POD_PI_AGENT_DIR}/settings.json`;
  const uploads = plan.uploads.map((upload) => {
    if (upload.podPath !== target) return upload;
    const settings = JSON.parse(new TextDecoder().decode(upload.contents)) as Record<string, unknown>;
    const entries = Array.isArray(settings["packages"]) ? settings["packages"] : [];
    const kept = entries.filter((entry) => {
      const source = sourceOfPackage(entry);
      return source !== null && retained.has(source);
    });
    if (kept.length > 0) settings["packages"] = kept;
    else delete settings["packages"];
    return { ...upload, contents: canonical(settings) };
  });
  return { ...plan, packages: retainedSources, uploads };
}

export interface PiSettingsInstallResult {
  plan: HostConfigPlan;
  status: "ready" | "degraded";
  installedPackageCount: number;
  failedPackageCount: number;
}

/** Install packages first, then upload settings rewritten to prevent Pi retrying failed npm entries. */
export async function installPiSettings(
  sandbox: Sandbox,
  plan: HostConfigPlan,
): Promise<PiSettingsInstallResult> {
  let installed: { installed: string[]; failed: boolean };
  try {
    installed = await installHostPackages(sandbox, plan.packages);
  } catch {
    // Provider transport/timeouts are installation failures too. Keep non-npm sources, which
    // this installer never executes, and remove npm entries so Pi can still reach a prompt.
    installed = { installed: plan.packages.filter((source) => npmSpecOf(source) === null), failed: true };
  }
  const finalPlan = installed.failed ? withRetainedPackages(plan, installed.installed) : plan;
  await uploadHostConfig(sandbox, finalPlan);
  return {
    plan: finalPlan,
    status: installed.failed ? "degraded" : "ready",
    installedPackageCount: installed.installed.length,
    failedPackageCount: plan.packages.length - installed.installed.length,
  };
}

/** Write project-scoped subagent settings after init has populated the workdir. */
export async function installProjectPiSettings(
  sandbox: Sandbox,
  uploads: HostConfigPlan["uploads"],
): Promise<void> {
  if (uploads.length === 0) return;
  const totalBytes = uploads.reduce((sum, upload) => sum + upload.contents.byteLength, 0);
  await uploadHostConfig(sandbox, {
    requested: true,
    packages: [],
    uploads,
    totalBytes,
    droppedKeys: [],
    model: null,
    providers: [],
    warnings: [],
    items: ["project agents"],
  });
}
