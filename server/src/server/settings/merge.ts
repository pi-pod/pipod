import { z } from "zod";
import { validateConfig, type PiPodConfig } from "../../core/config.js";
import { isSupportedProvider, supportedProviders } from "../../core/providers/registry.js";
import { configProvenance, mergeConfigLayers, type ConfigProvenanceEntry } from "../../core/userconfig.js";
import { query } from "../db/index.js";
import { badRequest, conflict } from "../httperrors.js";
import {
  canonicalizePiSettingsFilesForStorage,
  flattenTemplatePiSettings,
  mergePiSettingsFileSets,
  type PiSettingsFiles,
} from "./pi-settings.js";

export type SettingsScope = "org_defaults" | "user_defaults" | "org_policy";
export type TemplateScope = "org" | "user";

/**
 * Org policy is constraints, not defaults (spec §6): ceilings and denials applied after
 * everything else. Policy can only narrow what the repo contract and defaults allow.
 */
export const PolicySchema = z
  .object({
    maxIdleTimeoutMinutes: z.number().int().positive().optional(),
    maxArchiveAfterMinutes: z.number().int().positive().optional(),
    allowedProviders: z.array(z.string()).optional(),
    /** Require every launch to select a stored template layer. */
    requireTemplate: z.boolean().optional(),
    /** Hosts that may never appear in an egress allowlist. */
    forbiddenEgressHosts: z.array(z.string()).optional(),
    requireEgressMode: z.enum(["allowlist"]).optional(),
    /** How many pods an org may have awake at the provider at once (spec §13), enforced on
     *  every launch and every wake. A stopped pod holds no slot; this only narrows the
     *  deployment's POD_MAX_CONCURRENT_PER_USER, never raises a user above it. */
    maxConcurrentPods: z.number().int().positive().optional(),
    /** Caps on server-launched child pods; lineage caps bound one tree's share of the awake
     *  pods, and unlike maxConcurrentPods they are checked at launch only. */
    nestedPods: z
      .object({
        enabled: z.boolean().optional(),
        maxDepth: z.number().int().min(0).max(8).optional(),
        maxChildrenPerPod: z.number().int().min(0).max(100).optional(),
        maxPodsPerLineage: z.number().int().min(1).max(500).optional(),
        allowFileSend: z.boolean().optional(),
        allowFileReceive: z.boolean().optional(),
      })
      .strict()
      .optional(),
    notifications: z.object({ redacted: z.boolean().optional() }).optional(),
  })
  .strict();

export type OrgPolicy = z.infer<typeof PolicySchema>;

export const RETIRED_POLICY_WARNING =
  'stored org policy key "allowProjectLayer" is retired and was ignored';

/** Existing rows may retain retired policy keys. Reads strip or convert them so rolling
 * upgrades keep resolving; writes still go through the strict public schema and reject them. */
export function parseStoredPolicy(raw: unknown): { policy: OrgPolicy; warnings: string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { policy: PolicySchema.parse(raw), warnings: [] };
  }
  const clean = { ...(raw as Record<string, unknown>) };
  const retiredPresent = Object.hasOwn(clean, "allowProjectLayer");
  delete clean["allowProjectLayer"];
  // The day-valued archive ceiling folded into the minute one; a stored value keeps clamping.
  const days = clean["maxArchiveAfterDays"];
  delete clean["maxArchiveAfterDays"];
  if (clean["maxArchiveAfterMinutes"] === undefined && typeof days === "number") {
    clean["maxArchiveAfterMinutes"] = days * 24 * 60;
  }
  return {
    policy: PolicySchema.parse(clean),
    warnings: retiredPresent ? [RETIRED_POLICY_WARNING] : [],
  };
}

export interface Clamp {
  path: string;
  from: unknown;
  to: unknown;
  reason: string;
}

export interface ResolvedSettings {
  config: PiPodConfig;
  /** Which explicit layer supplied each configured leaf value (later layers win). */
  provenance: ConfigProvenanceEntry[];
  /** Whether any explicit settings layer named image (custom pins are never auto-built). */
  imagePinned: boolean;
  /** Every clamp that changed the result — reported in the launch response, never silent. */
  clamps: Clamp[];
  /** Which layers denied each provider name — the denial message names its authors. */
  deniedProviderOrigins: Record<string, string[]>;
  warnings: string[];
  /** Participating defaults layers, in launch precedence order. */
  layerOrder: Array<"org" | "template" | "user" | "project">;
  /** Stored flat Pi file sets merged through the persistent bundle chain (materialized in P3). */
  piFiles: PiSettingsFiles;
  initScripts: { org: string; user: string };
  bakeScripts: { org: string; user: string };
  policy: OrgPolicy;
}

export const MAX_INIT_SCRIPT_BYTES = 256 * 1024;

export interface SettingsLayerRow {
  config: Record<string, unknown>;
  version: number;
  initScript: string;
  bakeScript: string;
  piFiles: PiSettingsFiles;
}

export async function readLayer(scopeType: SettingsScope, scopeId: string, orgId: string): Promise<SettingsLayerRow> {
  const row = await query<{ config: Record<string, unknown>; version: number; init_script: string; bake_script: string; pi_settings: PiSettingsFiles }>(
    "SELECT config, version, init_script, bake_script, pi_settings FROM settings WHERE scope_type = $1 AND scope_id = $2 AND org_id = $3",
    [scopeType, scopeId, orgId],
  );
  const found = row.rows[0];
  if (!found) return { config: {}, version: 0, initScript: "", bakeScript: "", piFiles: {} };
  return {
    // Every read of a stored bundle drops the keys this schema retired, so neither the GET that
    // serves this row nor the launch chain it feeds can hand a client a key it would call
    // unknown. Policy rows come through here too; their key space is disjoint from the config
    // one, and parseStoredPolicy() handles the retired key they do have.
    config: stripRetiredConfigKeys(found.config) as Record<string, unknown>,
    version: found.version,
    initScript: found.init_script,
    bakeScript: found.bake_script,
    piFiles: found.pi_settings,
  };
}

export async function writeLayer(args: {
  scopeType: SettingsScope;
  scopeId: string;
  orgId: string;
  config: Record<string, unknown>;
  /** Undefined leaves the layer's script unchanged; empty string clears it. */
  initScript?: string;
  /** Same update semantics as initScript. */
  bakeScript?: string;
  /** Undefined leaves the flat Pi file set unchanged; an empty object clears it. */
  piFiles?: PiSettingsFiles;
  expectedVersion: number;
  updatedBy: string;
}): Promise<number> {
  if (args.initScript !== undefined) {
    if (args.scopeType === "org_policy") throw badRequest("policy has no init script");
    if (Buffer.byteLength(args.initScript) > MAX_INIT_SCRIPT_BYTES) {
      throw badRequest(`init script exceeds ${MAX_INIT_SCRIPT_BYTES} bytes`);
    }
  }
  if (args.bakeScript !== undefined) {
    if (args.scopeType === "org_policy") throw badRequest("policy has no bake script");
    if (Buffer.byteLength(args.bakeScript) > MAX_INIT_SCRIPT_BYTES) {
      throw badRequest(`bake script exceeds ${MAX_INIT_SCRIPT_BYTES} bytes`);
    }
  }
  if (args.scopeType === "org_policy" && args.piFiles !== undefined) {
    throw badRequest("policy has no Pi files");
  }
  const piFiles = args.piFiles === undefined
    ? undefined
    : canonicalizePiSettingsFilesForStorage(args.piFiles);
  if (args.scopeType === "org_policy") {
    const parsed = PolicySchema.safeParse(args.config);
    if (!parsed.success) {
      throw badRequest("invalid policy", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    }
    assertAllowedProvidersSupported(args.config);
  } else {
    assertValidDefaultsConfig(args.config);
    assertDeniedProvidersSupported(args.config, args.scopeType === "org_defaults" ? "org" : "user");
  }
  const updated = await query<{ version: number }>(
    `INSERT INTO settings (id, scope_type, scope_id, org_id, config, init_script, bake_script, pi_settings, version, updated_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, COALESCE($7, ''), COALESCE($8, ''), COALESCE($9, '{}'::jsonb), 1, $5)
     ON CONFLICT (scope_type, scope_id, org_id)
     DO UPDATE SET config = EXCLUDED.config,
                   init_script = COALESCE($7, settings.init_script),
                   bake_script = COALESCE($8, settings.bake_script),
                   pi_settings = COALESCE($9, settings.pi_settings),
                   version = settings.version + 1,
                   updated_by = EXCLUDED.updated_by, updated_at = now()
     WHERE settings.version = $6
     RETURNING version`,
    [
      args.scopeType,
      args.scopeId,
      args.orgId,
      JSON.stringify(args.config),
      args.updatedBy,
      args.expectedVersion,
      args.initScript ?? null,
      args.bakeScript ?? null,
      piFiles === undefined ? null : JSON.stringify(piFiles),
    ],
  );
  const row = updated.rows[0];
  if (!row) throw conflict("version conflict: settings changed since you read them");
  return row.version;
}

/** Defaults layers share the pod-config schema; validate on a full merge so partial
 * layers (the normal case) do not fail for what they leave unsaid. Retired keys are rejected
 * against the raw layer first: the merged probe below cannot see them once stripping runs. */
export function assertValidDefaultsConfig(config: Record<string, unknown>): void {
  assertNoRetiredConfigKeys(config);
  const probe = validateConfig(mergeConfigLayers(baseConfig(), config));
  if (probe.errors.length > 0) {
    throw badRequest("invalid settings", probe.errors.map((e, i) => `${probe.errorPaths[i]}: ${e}`));
  }
}

function baseConfig(): Record<string, unknown> {
  // validateConfig() applies DEFAULT_CONFIG itself; the base layer only needs the keys the
  // defaults omit (provider and image are resolved at launch).
  return {};
}

/**
 * M0 old-client compatibility: org/user settings layers that name a retired
 * provider in deniedProviders must fail at write time with the supported
 * list, not store a row that later fails opaquely at merge. Same message
 * shape as the merge-time check so clients see one answer either way. Only
 * the provider names are echoed — never the full bundle or credentials.
 */
export function assertDeniedProvidersSupported(config: Record<string, unknown>, scopeLabel: string): void {
  const denied = config["deniedProviders"];
  if (denied === undefined) return;
  if (!Array.isArray(denied) || denied.some((entry) => typeof entry !== "string")) {
    throw badRequest(`${scopeLabel} deniedProviders must be an array of provider names`);
  }
  for (const name of denied as string[]) {
    if (!isSupportedProvider(name)) {
      throw badRequest(
        `${scopeLabel} deniedProviders names unknown provider "${name}"`,
        `supported providers: ${supportedProviders().join(", ")}`,
      );
    }
  }
}

/**
 * Same for org policy allowedProviders: reject retired names at write time
 * with the supported list. Launch-time assertProviderPermitted stays as the
 * enforcement point for known-but-unlisted providers.
 */
export function assertAllowedProvidersSupported(config: Record<string, unknown>): void {
  const allowed = config["allowedProviders"];
  if (allowed === undefined) return;
  if (!Array.isArray(allowed) || allowed.some((entry) => typeof entry !== "string")) {
    throw badRequest("policy allowedProviders must be an array of provider names");
  }
  for (const name of allowed as string[]) {
    if (!isSupportedProvider(name)) {
      throw badRequest(
        `org policy allowedProviders names unknown provider "${name}"`,
        `supported providers: ${supportedProviders().join(", ")}`,
      );
    }
  }
}

/** Merge the scope-positioned defaults chain. A selected template appears exactly once,
 * on the side of user defaults selected by its ownership scope. Policy clamps remain last. */
export function mergeSettingsLayers(args: {
  orgDefaults: Record<string, unknown>;
  userDefaults?: Record<string, unknown>;
  /** Organization-scoped scheduled jobs omit the complete user bundle. Defaults to true. */
  includeUserLayer?: boolean;
  orgPiFiles?: PiSettingsFiles;
  userPiFiles?: PiSettingsFiles;
  templateConfigRaw?: unknown | null;
  templatePiFilesRaw?: unknown | null;
  templateScope?: TemplateScope | null;
  projectConfigRaw?: unknown | null;
  policy: OrgPolicy;
  /** Explicit because a selected template may have an empty config object. */
  templateSelected?: boolean;
}): {
  config: PiPodConfig;
  provenance: ConfigProvenanceEntry[];
  layerOrder: Array<"org" | "template" | "user" | "project">;
  piFiles: PiSettingsFiles;
  imagePinned: boolean;
  clamps: Clamp[];
  deniedProviderOrigins: Record<string, string[]>;
  warnings: string[];
} {
  const userDefaults = args.userDefaults ?? {};
  const includeUserLayer = args.includeUserLayer !== false;
  // Stripped before the presence check below, so a preview layer whose only content is retired
  // keys is the empty layer it effectively is rather than one more name in the reported chain.
  const projectConfigRaw = stripRetiredConfigKeys(args.projectConfigRaw ?? null);
  const templateSelected = args.templateSelected ?? args.templateConfigRaw != null;
  const templateScope = templateSelected ? (args.templateScope ?? "user") : null;
  const projectConfigPresent =
    projectConfigRaw !== null &&
    (typeof projectConfigRaw !== "object" ||
      Array.isArray(projectConfigRaw) ||
      Object.keys(projectConfigRaw as Record<string, unknown>).length > 0);
  // Retired keys leave every layer before it is merged or described: they cannot change the
  // result, but left in they would each cost the client a warning and a provenance entry naming
  // the layer that still declares them (see stripRetiredConfigKeys).
  const namedLayers: Array<{ name: "org" | "template" | "user" | "project"; raw: unknown }> = [
    { name: "org", raw: stripRetiredConfigKeys(args.orgDefaults) },
    ...(templateScope === "org"
      ? [{ name: "template" as const, raw: stripRetiredConfigKeys(args.templateConfigRaw ?? {}) }]
      : []),
    ...(includeUserLayer ? [{ name: "user" as const, raw: stripRetiredConfigKeys(userDefaults) }] : []),
    ...(templateScope === "user"
      ? [{ name: "template" as const, raw: stripRetiredConfigKeys(args.templateConfigRaw ?? {}) }]
      : []),
    ...(projectConfigPresent
      ? [{ name: "project" as const, raw: projectConfigRaw }]
      : []),
  ];
  const configLayers = namedLayers.map((layer) => layer.raw);
  let merged: unknown = {};
  for (const layer of configLayers) merged = layerConfig(merged, layer);

  const parsed = validateConfig(merged);
  if (parsed.errors.length > 0) {
    throw badRequest(
      "invalid merged configuration",
      parsed.errors.map((e, i) => `${parsed.errorPaths[i]}: ${e}`),
    );
  }
  const config = parsed.config;
  const deniedProviderOrigins = collectDeniedProviderOrigins(namedLayers);
  config.deniedProviders = Object.keys(deniedProviderOrigins).sort();
  const templatePiFiles = templateSelected
    ? flattenTemplatePiSettings(args.templatePiFilesRaw ?? {})
    : {};
  const piFiles = mergePiSettingsFileSets(
    args.orgPiFiles,
    ...(templateScope === "org" ? [templatePiFiles] : []),
    ...(includeUserLayer ? [args.userPiFiles] : []),
    ...(templateScope === "user" ? [templatePiFiles] : []),
  );

  return {
    config,
    provenance: configProvenance(namedLayers),
    layerOrder: namedLayers.map((layer) => layer.name),
    piFiles,
    imagePinned: parsed.imagePinned,
    clamps: applyPolicyClamps(config, args.policy, { templateSelected }),
    deniedProviderOrigins,
    warnings: parsed.warnings,
  };
}

function collectDeniedProviderOrigins(
  layers: Array<{ name: string; raw: unknown }>,
): Record<string, string[]> {
  const origins: Record<string, string[]> = {};
  for (const layer of layers) {
    if (layer.raw === null || typeof layer.raw !== "object" || Array.isArray(layer.raw)) continue;
    const denied = (layer.raw as Record<string, unknown>)["deniedProviders"];
    if (denied === undefined) continue;
    if (!Array.isArray(denied) || denied.some((entry) => typeof entry !== "string")) {
      throw badRequest(`${layer.name} deniedProviders must be an array of provider names`);
    }
    for (const name of denied as string[]) {
      // A typo must not become a silent no-op denial.
      if (!isSupportedProvider(name)) {
        throw badRequest(
          `${layer.name} deniedProviders names unknown provider "${name}"`,
          `supported providers: ${supportedProviders().join(", ")}`,
        );
      }
      origins[name] = [...(origins[name] ?? []), layer.name];
    }
  }
  return origins;
}

/** The deniedProviders denial, applied once the launch's provider is known. */
export function assertProviderNotDenied(
  origins: Record<string, string[]>,
  provider: string,
): void {
  const deniedBy = origins[provider];
  if (deniedBy?.length) {
    throw badRequest(
      `provider "${provider}" is denied by ${deniedBy.join(" and ")} deniedProviders`,
      "pick another provider, or remove the denial from the layer(s) named above",
    );
  }
}

/**
 * One layer over another, with the legacy archive rule the CLI merge also applies:
 * a layer that says `archiveAfterDays` and not `archiveAfterMinutes` must not be shadowed by
 * a *lower* layer's minute value, or the higher layer silently stops applying. The CLI
 * and server have to answer this the same way for the same two files.
 */
function layerConfig(base: unknown, override: unknown): unknown {
  const over = override as Record<string, unknown> | null;
  const usesLegacyArchive =
    over !== null &&
    typeof over === "object" &&
    "archiveAfterDays" in over &&
    !("archiveAfterMinutes" in over);
  if (usesLegacyArchive && base !== null && typeof base === "object") {
    const stripped = Object.fromEntries(
      Object.entries(base as Record<string, unknown>).filter(([key]) => key !== "archiveAfterMinutes"),
    );
    return mergeConfigLayers(stripped, override);
  }
  return mergeConfigLayers(base, override);
}

/** Read persistent org, user, and policy rows, then apply the positioned launch chain. */
export async function resolveSettings(args: {
  orgId: string;
  userId: string;
  /** False only for organization-scoped scheduled jobs. */
  includeUserLayer?: boolean;
  templateConfigRaw?: unknown | null;
  templatePiFilesRaw?: unknown | null;
  templateScope: TemplateScope | null;
  /** Resolve-only bootstrap preview layer; launch callers leave this absent. */
  projectConfigRaw?: unknown | null;
  templateSelected?: boolean;
}): Promise<ResolvedSettings> {
  const emptyUserLayer: SettingsLayerRow = {
    config: {},
    version: 0,
    initScript: "",
    bakeScript: "",
    piFiles: {},
  };
  const [orgDefaults, userDefaults, policyRow] = await Promise.all([
    readLayer("org_defaults", args.orgId, args.orgId),
    args.includeUserLayer === false
      ? Promise.resolve(emptyUserLayer)
      : readLayer("user_defaults", args.userId, args.orgId),
    readLayer("org_policy", args.orgId, args.orgId),
  ]);
  const storedPolicy = parseStoredPolicy(policyRow.config ?? {});
  const policy = storedPolicy.policy;

  const merged = mergeSettingsLayers({
    orgDefaults: orgDefaults.config,
    userDefaults: userDefaults.config,
    includeUserLayer: args.includeUserLayer,
    orgPiFiles: orgDefaults.piFiles,
    userPiFiles: userDefaults.piFiles,
    templateConfigRaw: args.templateConfigRaw ?? null,
    templatePiFilesRaw: args.templatePiFilesRaw ?? null,
    templateScope: args.templateScope ?? null,
    projectConfigRaw: args.projectConfigRaw ?? null,
    policy,
    templateSelected: args.templateSelected,
  });

  return {
    ...merged,
    warnings: [...storedPolicy.warnings, ...merged.warnings],
    policy,
    initScripts: { org: orgDefaults.initScript, user: userDefaults.initScript },
    bakeScripts: { org: orgDefaults.bakeScript, user: userDefaults.bakeScript },
  };
}

/**
 * Org policy clamps, applied after every other layer (spec §6): ceilings and denials only,
 * never silent. Pure so every caller sees exactly the same behavior.
 */
export interface SettingsPolicyContext {
  templateSelected: boolean;
}

export function applyPolicyClamps(
  config: PiPodConfig,
  policy: OrgPolicy,
  context?: SettingsPolicyContext,
): Clamp[] {
  if (context && policy.requireTemplate === true && !context.templateSelected) {
    throw badRequest(
      "org policy requireTemplate requires a selected template",
      "select a template or ask an organization administrator to change the policy",
    );
  }
  const clamps: Clamp[] = [];

  if (policy.maxIdleTimeoutMinutes !== undefined) {
    const max = policy.maxIdleTimeoutMinutes;
    if (config.idleTimeoutMinutes === 0 || config.idleTimeoutMinutes > max) {
      clamps.push({
        path: "idleTimeoutMinutes",
        from: config.idleTimeoutMinutes,
        to: max,
        reason: "org policy maxIdleTimeoutMinutes",
      });
      config.idleTimeoutMinutes = max;
    }
  }

  const maxArchiveMinutes = policy.maxArchiveAfterMinutes;
  if (
    maxArchiveMinutes !== undefined &&
    (config.archiveAfterMinutes === 0 || config.archiveAfterMinutes > maxArchiveMinutes)
  ) {
    clamps.push({
      path: "archiveAfterMinutes",
      from: config.archiveAfterMinutes,
      to: maxArchiveMinutes,
      reason: "org policy maxArchiveAfterMinutes",
    });
    config.archiveAfterMinutes = maxArchiveMinutes;
  }

  if (policy.requireEgressMode === "allowlist" && config.egress.mode === "open") {
    clamps.push({
      path: "egress.mode",
      from: "open",
      to: "allowlist",
      reason: "org policy requireEgressMode",
    });
    config.egress.mode = "allowlist";
  }

  if (policy.forbiddenEgressHosts?.length) {
    const forbidden = new Set(policy.forbiddenEgressHosts.map((h) => h.toLowerCase()));
    const kept = config.egress.allow.filter((h) => !forbidden.has(h.toLowerCase()));
    if (kept.length !== config.egress.allow.length) {
      clamps.push({
        path: "egress.allow",
        from: config.egress.allow,
        to: kept,
        reason: "org policy forbiddenEgressHosts",
      });
      config.egress.allow = kept;
    }
  }

  return clamps;
}

/**
 * Top-level config keys this schema used to have, by the change that dropped each.
 *
 * A settings bundle is stored as JSON and nothing rewrites a row when the schema shrinks, so
 * rows written before these removals still carry the keys. The *values* have been inert ever
 * since: validateConfig() builds a PiPodConfig out of the keys it knows and drops the rest, and
 * what those keys used to configure is now fixed server-side (stop/teardown timeouts are
 * constants in core/lifecycle.ts; the orphan window belongs to `pi-pod gc`). What is not inert
 * is the *reporting*. The same pass that drops an unknown key also emits
 * "<key>: unknown key (ignored)", and configProvenance() walks the raw layers, so a stale row
 * costs a warning line and a provenance entry per key in every resolve and launch report every
 * member of that org receives — nine warnings on `pipod doctor` in the deployment that prompted
 * this, about keys most readers cannot even edit.
 *
 * This is the stored-bundle half of what {@link clientFacingConfig} does for the resolved
 * config: that projection hides keys the server still uses alongside the retired ones, this
 * one hides keys nobody uses. A key that ever comes back into the schema must leave the
 * retired lists — the settings tests assert every pre-Simplify entry here is still unknown
 * to validateConfig(), and {@link assertNoRetiredConfigKeys} rejects every entry here on
 * write with a removal error.
 */
export const RETIRED_TOP_LEVEL_KEYS = [
  // #45 dropped the server-side clone; a pod overlays the project it was launched from.
  "repo",
  // #200 stopped making pod exit and teardown configurable. autoDelete and deleteTimeoutSeconds
  // had already been demoted to a named-retired warning and a rename alias by then; #200 removed
  // that handling too, which is what turned them into plain unknown keys.
  "autoStopOnExit",
  "autoDelete",
  "orphanTtlMinutes",
  "stopTimeoutSeconds",
  "deleteTimeoutSeconds",
  // Simplify-config retired the client-only bundle keys the server never reads. Unlike the
  // entries above the fork's validator still parses these (local CLI flows use them), so what
  // makes them retired is the bundle contract, not the schema: reads strip them here and
  // writes reject them in assertNoRetiredConfigKeys.
  // The env file, init script and bake script travel as resolved content (the secrets table
  // and the init_script/bake_script columns) — the repo-relative paths that name them are the
  // CLI's to open on its own disk.
  "envFile",
  "initScript",
  "bakeScript",
  // The account template picker (body.templateId) and the reuse endpoint own these decisions;
  // a stored default for either would read as configuration while changing nothing.
  "template",
  "reuse",
];

/** The same, one level down under `pi`. All five went in #200. */
export const RETIRED_PI_KEYS = [
  // The pinned agent version and the fallback exit shell left with the byte-path launcher.
  "version",
  "shellOnExit",
  // The byte-path detach chords were replaced by pi.chords.bindings.
  "detachSequence",
  "detachStopSequence",
  "detachArchiveSequence",
];

/**
 * One more level down, under `pi.hostConfig`. The server enforces the two booleans
 * (`settings` and `packages` gate what the merged Pi files may carry into a pod), but the
 * name lists are host-disk selection — files the CLI uploads from its own machine — which no
 * server code reads. Simplify-config retired them from the bundle contract.
 */
export const RETIRED_PI_HOSTCONFIG_KEYS = ["skills", "extensions"];

/** Dotted paths of every retired key a bundle layer declares (e.g. `"envFile"`, `"pi.version"`,
 * `"pi.hostConfig.skills"`). Used for the write-time removal error. */
export function findRetiredConfigKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const found: string[] = [];
  const record = raw as Record<string, unknown>;
  for (const key of RETIRED_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(record, key)) found.push(key);
  }
  const pi = record["pi"];
  if (pi !== null && typeof pi === "object" && !Array.isArray(pi)) {
    const piRecord = pi as Record<string, unknown>;
    for (const key of RETIRED_PI_KEYS) {
      if (Object.hasOwn(piRecord, key)) found.push(`pi.${key}`);
    }
    const hostConfig = piRecord["hostConfig"];
    if (hostConfig !== null && typeof hostConfig === "object" && !Array.isArray(hostConfig)) {
      for (const key of RETIRED_PI_HOSTCONFIG_KEYS) {
        if (Object.hasOwn(hostConfig as Record<string, unknown>, key)) {
          found.push(`pi.hostConfig.${key}`);
        }
      }
    }
  }
  return found;
}

/**
 * Writes reject what reads silently strip: a bundle layer naming a retired key fails with the
 * removal spelled out, so a stale CLI surfaces one actionable error instead of storing a key
 * every later read would quietly drop. Called by both settings-layer and template validation.
 */
export function assertNoRetiredConfigKeys(raw: unknown): void {
  const retired = findRetiredConfigKeys(raw);
  if (retired.length > 0) {
    throw badRequest(
      `retired config key${retired.length === 1 ? "" : "s"} ${retired.map((key) => `"${key}"`).join(", ")} ${retired.length === 1 ? "is" : "are"} no longer accepted`,
      "remove them from the bundle and retry — the server ignores these keys, so dropping them changes nothing it does",
    );
  }
}

/**
 * A stored settings layer with the retired keys taken out, applied wherever stored bundle JSON
 * leaves the database: the settings row read ({@link readLayer}, which serves the org and user
 * bundle GETs), the template row read, and every layer {@link mergeSettingsLayers} folds
 * together — templates and the resolve-only project preview reach the merge without passing
 * through readLayer.
 *
 * Anything that is not an object is returned untouched: an unusable layer is the merge's to
 * reject with a path and a reason, not this projection's to quietly reshape. Writes are
 * likewise left alone — a bundle keeps whatever it was pushed with, and a row is cleaned only
 * when something rewrites it.
 */
export function stripRetiredConfigKeys(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (RETIRED_TOP_LEVEL_KEYS.includes(key)) continue;
    if (key !== "pi") {
      clean[key] = value;
      continue;
    }
    // A `pi` block left empty by the strip goes with them: an empty block declares nothing, and
    // keeping it would still count its layer as one that had something to say.
    const pi = strippedPiBlock(value);
    if (isEmptyObject(pi)) continue;
    clean[key] = pi;
  }
  return clean;
}

function strippedPiBlock(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (RETIRED_PI_KEYS.includes(key)) continue;
    if (key !== "hostConfig") {
      clean[key] = value;
      continue;
    }
    const hostConfig = strippedHostConfigBlock(value);
    if (isEmptyObject(hostConfig)) continue;
    clean[key] = hostConfig;
  }
  return clean;
}

function strippedHostConfigBlock(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([key]) => !RETIRED_PI_HOSTCONFIG_KEYS.includes(key),
    ),
  );
}

function isEmptyObject(value: unknown): boolean {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0
  );
}

/** A resolved config as a client is allowed to see it. See {@link clientFacingConfig}. */
export type ClientFacingConfig = Omit<
  PiPodConfig,
  "providers" | "envFile" | "initScript" | "bakeScript" | "template" | "reuse" | "pi"
> & {
  pi: Omit<PiPodConfig["pi"], "hostConfig"> & {
    hostConfig: Pick<PiPodConfig["pi"]["hostConfig"], "settings" | "packages">;
  };
};

/**
 * Everything in a resolved config except `providers` and the retired client-only keys.
 *
 * The CLI retired the providers key, and its validator warns about every top-level key it
 * does not know — so a server that sends `providers` (even the empty default) makes `pipod
 * doctor` and every launch print "providers: unknown key (ignored)". The block is also the
 * wrong thing to publish: planning writes the placed sandbox host's URL into it. The retired
 * bundle keys ({@link RETIRED_TOP_LEVEL_KEYS} and the hostConfig name lists) stay out for the
 * same warning reason: the CLI no longer accepts them on write, so the server must not hand
 * them back on read. The hostConfig booleans stay — the server enforces them at launch.
 *
 * Applied at the HTTP boundary only. The stored launch report keeps everything, because the
 * pod's whole later lifecycle dials the block frozen there.
 */
export function clientFacingConfig(config: PiPodConfig): ClientFacingConfig {
  const {
    providers: _providers,
    envFile: _envFile,
    initScript: _initScript,
    bakeScript: _bakeScript,
    template: _template,
    reuse: _reuse,
    pi,
    ...rest
  } = config;
  // Frozen reports predate the keys this projection drops: a stored row may carry no `pi` or
  // no `pi.hostConfig` at all, so narrow only what is actually there instead of assuming the
  // full resolved shape.
  if (pi === null || typeof pi !== "object" || Array.isArray(pi)) {
    return rest as ClientFacingConfig;
  }
  const { hostConfig, ...piRest } = pi as PiPodConfig["pi"] & { hostConfig?: unknown };
  if (hostConfig === null || typeof hostConfig !== "object" || Array.isArray(hostConfig)) {
    return { ...rest, pi: piRest } as ClientFacingConfig;
  }
  // Preserve only the fields the stored row actually declares: synthesizing
  // `settings: undefined` / `packages: undefined` would put keys on the wire the row never
  // had, and a strict client validator reports even undefined-valued unknown keys.
  const narrowed: Record<string, unknown> = {};
  for (const key of ["settings", "packages"]) {
    const value = (hostConfig as unknown as Record<string, unknown>)[key];
    if (value !== undefined) narrowed[key] = value;
  }
  return {
    ...rest,
    pi: { ...piRest, hostConfig: narrowed },
  } as ClientFacingConfig;
}

/** Provider permission is a hard denial, not a clamp — checked once the provider is known. */
export function assertProviderPermitted(policy: OrgPolicy, provider: string): void {
  if (policy.allowedProviders && !policy.allowedProviders.includes(provider)) {
    throw badRequest(
      `provider "${provider}" is not permitted by org policy`,
      `allowed: ${policy.allowedProviders.join(", ")}`,
    );
  }
}
