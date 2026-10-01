import { bundledPiVersion } from "../../core/client/piversion.js";
import { PI_THINKING_LEVELS, type PiPodConfig } from "../../core/config.js";
import {
  bakeDigest,
  composeBakeScript,
  launcherVersion,
  packageRoot,
  resolveImageRecipe,
  type ImageRecipe,
} from "../../core/image.js";
import { allowsHost, cidrWildcardProblem } from "../../core/egress.js";
import type { EffectivePolicy } from "../../core/egress.js";
import { retentionReport } from "../../core/lifecycle.js";
import { capabilityFindings } from "../../core/preflight.js";
import { DEFAULT_PROVIDER, PROVIDER_CREDENTIAL_VARS, loadProvider } from "../../core/providers/registry.js";
import { supportsImageBuild, supportsImageMirror, type SandboxProvider } from "../../core/providers/types.js";
import type { ConfigProvenanceEntry } from "../../core/userconfig.js";
import type { ServerEnv } from "../env.js";
import { badRequest, conflict, serviceUnavailable, HttpError } from "../httperrors.js";
import {
  credentialProvidersFor,
  resolvePodCredentialContract,
  resolveRequiredCredentialProviders,
} from "../model-credentials/dependencies.js";
import { classifyCredentialMeta } from "../model-credentials/login.js";
import { listCredentialMeta, type CredentialMeta } from "../model-credentials/store.js";
import { checkProviderCredential, resolveSecrets } from "../secrets/store.js";
import { assertProviderNotDenied, assertProviderPermitted, resolveSettings, type Clamp, type OrgPolicy } from "../settings/merge.js";
import { HOST_PROVIDER_NAME } from "../../core/providers/host.js";
import {
  planLocalPiSettings,
  type LocalPiSettingsLayers,
  type PlannedPiSettings,
} from "../settings/pi-settings.js";
import { getTemplate, type TemplateRow } from "../templates/store.js";
import {
  loadProviderRegistry,
  PACKAGE_PROVIDERS,
  packagesInclude,
  providerFacts,
  withPackageProviders,
  type ProviderRegistry,
} from "../../core/piregistry.js";
import { composePodEnv, type LaunchEnvLayers } from "./launchenv.js";
import {
  applyPiResourceOverrides,
  normalizePiResources,
  type PiResourceOverrides,
} from "./pi-resources.js";
import { platformProviderEnv } from "./providercred.js";
import { SANDBOX_PROVIDER_NAME } from "./sandboxfleet.js";
import { staticHostForUrl, hostById, currentHostUrl, requireHostAwake, openHostAuth, providerForHost } from "./hostidentity.js";
import { getSandboxHostBackend } from "./hostbackend/index.js";
import { buildCreateOwner } from "./owner-identity.js";
import { platformToken } from "./operations.js";
import { assertSandboxShapeGate, isAdmissionDetailLike, OWNED_BOX_DISK_CEILING_GB, platformDiskDefault, resolveShape } from "./capacity.js";
import { edition, ownedHosts } from "../edition.js";
import { platformArchiveMaxMinutes, resolveEffectiveRetention } from "./retention-policy.js";
import type { InitScope, PodServiceDeps, ResolvedConfigReport } from "./types.js";
import { assertLaunchContextSupported, type LaunchContext } from "./launch-context.js";

/** Without PUBLIC_URL the injected PI_POD_SERVER_URL is empty, so the in-pod skill points the
 * agent at a broken endpoint and self-service template authoring fails silently (spec §8.5). */
export const PUBLIC_URL_UNSET_WARNING =
  "PUBLIC_URL is not configured, so this pod cannot call back to the server: self-service template authoring is unavailable";
export const LEGACY_PROJECT_LAYERS_WARNING =
  "project launch layers are retired: pod settings, env, scripts and Pi files apply through templates and server bundles now — push them with pi-pod push (upgrade pi pod if you have no push command)";
export const TEMPLATE_PROJECT_PREVIEW_WARNING =
  "projectConfig with a selected template is a legacy bootstrap preview combination; projectConfig was applied as the most specific defaults layer";
/** Provider-native idle is only the crash fallback; the database reaper enforces shorter policy. */
export const HOSTED_PROVIDER_IDLE_FLOOR_MINUTES = 3;

export function hostedProviderIdleTimeoutMinutes(configuredMinutes: number): number {
  return configuredMinutes === 0 ? 0 : Math.max(HOSTED_PROVIDER_IDLE_FLOOR_MINUTES, configuredMinutes);
}

export function hostedProviderIdleReport(
  provider: SandboxProvider,
  configuredMinutes: number,
): { providerIdleTimeoutMinutes: number; providerIdleTimeoutMinimumApplied: boolean } {
  return {
    providerIdleTimeoutMinutes: retentionReport(provider, {
      idleTimeoutMinutes: hostedProviderIdleTimeoutMinutes(configuredMinutes),
      archiveAfterMinutes: 0,
    }).idleTimeoutMinutes,
    providerIdleTimeoutMinimumApplied:
      configuredMinutes > 0 && hostedProviderIdleTimeoutMinutes(configuredMinutes) !== configuredMinutes,
  };
}
/** Server builtins (spec §13): the server's own host, always present in an allowlist so the
 * pod can call back (§8.5). Sessions cannot function without that callback, so org policy
 * forbidden hosts never remove it. Pure for tests. */
export function serverBuiltinHosts(args: { publicUrl: string | undefined }): string[] {
  const hosts: string[] = [];
  if (args.publicUrl) {
    try {
      hosts.push(new URL(args.publicUrl).hostname);
    } catch {
      // PUBLIC_URL is schema-validated; an unparsable value only costs the builtin entry.
    }
  }
  return hosts;
}

/** Apply org denials after every derived source, including git/env/provider builtins. */
export function withoutForbiddenEgressHosts(
  policy: EffectivePolicy,
  forbiddenHosts: string[],
): EffectivePolicy {
  if (policy.mode === "open" || forbiddenHosts.length === 0) return policy;
  const forbidden = forbiddenHosts.map((host) => host.toLowerCase());
  return {
    ...policy,
    entries: policy.entries.filter((entry) =>
      !forbidden.some(
        (host) => allowsHost([host], entry.host) || allowsHost([entry.host], host),
      ),
    ),
  };
}

/** Provider endpoints implied by Pi auth and selected settings, using package facts too. */
export function piProviderEndpoints(
  registry: ProviderRegistry,
  args: {
    authProviders?: string[];
    settingsProviders?: string[];
    packages?: string[];
    forbiddenEgressHosts?: string[];
  },
): Array<{ provider: string; endpoints: string[] }> {
  const augmented = withPackageProviders(registry, args.packages ?? []);
  const providers = [...(args.authProviders ?? []), ...(args.settingsProviders ?? [])].filter(
    (provider, index, all) => all.indexOf(provider) === index,
  );
  const forbidden = new Set((args.forbiddenEgressHosts ?? []).map((host) => host.toLowerCase()));
  return providers.map((provider) => ({
    provider,
    endpoints: (providerFacts(augmented, provider)?.endpoints ?? []).filter(
      (host) => !forbidden.has(host.toLowerCase()),
    ),
  }));
}
/** Setup scripts concatenate in layer order. Blank scripts drop out. */
export function buildInitSteps(scripts: {
  org: string;
  user?: string;
  template: string | null;
  templateScope?: "org" | "user";
  project?: string | null;
}): Array<{ scope: InitScope; script: string }> {
  const steps: Array<{ scope: InitScope; script: string }> = [];
  const templateScope = scripts.templateScope ?? "user";
  if (scripts.org.trim()) steps.push({ scope: "org", script: scripts.org });
  if (templateScope === "org" && scripts.template?.trim()) {
    steps.push({ scope: "template", script: scripts.template });
  }
  if (scripts.user?.trim()) steps.push({ scope: "user", script: scripts.user });
  if (templateScope === "user" && scripts.template?.trim()) {
    steps.push({ scope: "template", script: scripts.template });
  }
  if (scripts.project?.trim()) steps.push({ scope: "project", script: scripts.project });
  return steps;
}

/** Bake scripts follow the same scope-positioned order; the result is an image input. */
export function buildBakeSteps(scripts: {
  org: string;
  user?: string;
  template: string | null;
  templateScope?: "org" | "user";
  project?: string | null;
}): Array<{ scope: InitScope; script: string }> {
  return buildInitSteps(scripts);
}

export const ACCOUNT_THINKING_LEVELS = PI_THINKING_LEVELS;

/**
 * What one launch may choose about the Pi it starts: the model and thinking level it runs at,
 * and the resource files it loads (§ pi-resources). Both are selections over the resolved
 * configuration — never arbitrary arguments, environment, or a different command.
 */
export interface PiLaunchOverrides extends PiResourceOverrides {
  model?: string;
  thinking?: (typeof ACCOUNT_THINKING_LEVELS)[number];
}

/** Apply the request-only selection last so it outranks every configured settings layer. */
export function applyPiLaunchOverrides(config: PiPodConfig, overrides?: PiLaunchOverrides | null): void {
  if (!overrides) return;
  if (overrides.model !== undefined) config.pi.model = overrides.model;
  if (overrides.thinking !== undefined) config.pi.thinking = overrides.thinking;
  // Resources are additive argv, not a replaced value: they are added ahead of whatever
  // pi.args already configures, and persist with it (see pi-resources.ts).
  applyPiResourceOverrides(config, overrides);
}

/** Provider id the pod will boot into: launch override / pi.model, else settings defaultProvider. */
export function launchModelProvider(
  config: Pick<PiPodConfig, "pi">,
  piSettings: PlannedPiSettings | null,
): string | null {
  const configured = config.pi.model?.split("/")[0]?.trim();
  if (configured) return configured;
  const fromSettings = piSettings?.plan.model?.provider?.trim();
  return fromSettings || null;
}

function credentialRequiredBy(
  credentialProvider: string,
  modelProvider: string | null,
  packages: readonly string[],
): string {
  if (modelProvider && credentialProvidersFor(modelProvider).includes(credentialProvider)) {
    return modelProvider;
  }
  for (const entry of PACKAGE_PROVIDERS) {
    if (!entry.credentialProviders?.includes(credentialProvider)) continue;
    if (!packagesInclude(packages, entry.package)) continue;
    return entry.providers[0] ?? entry.package;
  }
  return credentialProvider;
}

function reconnectRequiredError(providerId: string, requiredBy: string): never {
  throw conflict("credential_reconnect_required", {
    code: "credential_reconnect_required",
    message: `The saved ${providerId} credential must be reconnected.`,
    provider: providerId,
    requiredBy,
  });
}

/**
 * Account credential metadata for a launch: ready stored ids (no contents) plus the
 * authorized contract. Throws 409 `credential_reconnect_required` when a required
 * provider is already in terminal reconnect state. Missing required rows are allowed.
 */
export function planLaunchCredentials(args: {
  metas: CredentialMeta[];
  config: Pick<PiPodConfig, "pi">;
  piSettings: PlannedPiSettings | null;
}): { piAuth: { providers: string[] } | null; credentialContract: string[] } {
  const modelProvider = launchModelProvider(args.config, args.piSettings);
  const packages = args.piSettings?.plan.packages ?? [];
  const selectableProviders = args.piSettings?.plan.providers ?? [];
  const accountProviders = args.metas.map((meta) => meta.providerId);
  const readyProviders = args.metas
    .filter((meta) => classifyCredentialMeta(meta).state === "ready")
    .map((meta) => meta.providerId);
  // A launch that names no model choice (no pinned model, no selectable settings
  // providers) would otherwise materialize an empty lease: the catalog a pod's pi can
  // offer is exactly the providers it holds auth for, and pi only discovers those from
  // its pod-local auth.json. Pi then answers an empty catalog with an unknown current
  // model and no client can ever discover or select the ready provider — the model-less
  // deadlock (M5). Only this case bootstraps the contract from ready providers, the
  // same ready set already advertised as piAuthProviders and already unioned into the
  // egress endpoints. Launches with an explicit model or settings selection keep their
  // narrow contract (least privilege; multi-provider reachability stays on the
  // settings-selectables path and on `set`, which extends the contract per model).
  // Reconnect-required and missing rows stay out: the lease tolerates them the same
  // way it tolerates missing required rows.
  const namesModelChoice =
    (modelProvider ?? "").length > 0 || selectableProviders.some((id) => id.length > 0);
  const credentialContract = [
    ...new Set([
      ...resolvePodCredentialContract({
        modelProvider: modelProvider ?? "",
        selectableProviders,
        packages,
        accountProviders,
      }),
      ...(namesModelChoice ? [] : readyProviders),
    ]),
  ]
    .filter((id) => id.length > 0)
    .sort();
  const required = resolveRequiredCredentialProviders({
    modelProvider: modelProvider ?? "",
    packages,
  }).filter((id) => id.length > 0);

  const byId = new Map(args.metas.map((meta) => [meta.providerId, meta]));
  for (const providerId of required) {
    const meta = byId.get(providerId);
    if (!meta) continue;
    if (classifyCredentialMeta(meta).state !== "reconnect_required") continue;
    reconnectRequiredError(providerId, credentialRequiredBy(providerId, modelProvider, packages));
  }

  return {
    piAuth: readyProviders.length > 0 ? { providers: readyProviders } : null,
    credentialContract,
  };
}

/** Legacy CLI launch shape retained at the version-skew boundary. Planning ignores every
 * settings field; `name` remains only as historical pod/reuse attribution. */
export interface LaunchProject {
  name: string;
  config: unknown;
  env: Record<string, string>;
  initScript: string;
  bakeScript?: string;
}

/**
 * Everything a launch resolves before the pod row exists — also the resolve endpoint's
 * answer (POST /pods/resolve), so a CLI dry-run and the provisioning path can never
 * disagree about the merged config, the clamps, or the credential check.
 */
export interface PodLaunchPlan {
  sandboxHostId: string | null;
  template: TemplateRow | null;
  project: LaunchProject | null;
  config: PiPodConfig;
  /** Which explicit layer supplied each configured leaf value (later layers win). */
  provenance: ConfigProvenanceEntry[];
  imageRecipe: ImageRecipe;
  /**
   * Managed siblings of `imageRecipe` with the bake layer and/or packages stripped, best
   * first: an already-published one can boot this launch while the full image builds behind
   * it (packages install per session; the bake script runs live as a pre-init step).
   */
  fallbackRecipes: ImageRecipe[];
  /** The composed bake layers this launch expects in its image; "" when there are none. */
  bakeScript: string;
  clamps: Clamp[];
  policy: OrgPolicy;
  providerName: string;
  /** Whether this provider can supply a missing managed runtime image: buildable or mirrorable. */
  imageBuildable: boolean;
  /** Which custody would supply the provider key; null means the launch cannot provision. */
  credential: { envVar: string; source: "org-secret" | "platform" } | null;
  /** Ready stored account credential provider ids; never contents. */
  piAuth: { providers: string[] } | null;
  /** Authorized credential-provider set frozen onto the pod row at launch. */
  credentialContract: string[];
  piSettings: PlannedPiSettings | null;
  initSteps: Array<{ scope: InitScope; script: string }>;
  podName: string;
  workdir: string;
  podEnv: Record<string, string>;
  /** The layers behind `podEnv` that only this launch request carries (§7). */
  launchEnvLayers: LaunchEnvLayers;
  report: ResolvedConfigReport;
  /**
   * True when the sandbox URL was fleet-placed (not an explicit template/org
   * URL): provisioning may authoritatively re-place it when the capacity
   * wait is enabled, instead of trusting the plan-time probe.
   */
  hostPlacedByPlan: boolean;
}

/** Reject provider/config combinations that cannot honor the pod contract before a row exists. */
export function assertHostedProviderCompatibility(
  config: Pick<PiPodConfig, "egress">,
  provider: Pick<SandboxProvider, "name" | "capabilities">,
): void {
  if (config.egress.mode === "allowlist" && provider.capabilities.egressEnforcement === "cidr") {
    const problem = cidrWildcardProblem(config.egress.allow, provider.name);
    if (problem) throw badRequest(problem.message, problem.hint);
  }
}

export function effectiveProviderResources(
  providerName: string,
  requested: PiPodConfig["resources"],
  maximums: Partial<PiPodConfig["resources"]>,
): { resources: PiPodConfig["resources"]; warnings: string[] } {
  const resources = { ...requested };
  const warnings: string[] = [];
  const display = (value: number): string => String(Math.round(value * 100) / 100);

  for (const field of ["cpu", "memoryGB", "diskGB"] as const) {
    const maximum = maximums[field];
    if (
      maximum === undefined ||
      !Number.isFinite(maximum) ||
      maximum <= 0 ||
      resources[field] <= maximum
    ) continue;
    const configured = resources[field];
    resources[field] = maximum;
    warnings.push(
      `${field} is configured as ${display(configured)}, but ${providerName} supports at most ` +
        `${display(maximum)} — using ${display(maximum)}`,
    );
  }
  return { resources, warnings };
}

/** Ceilings every launch in this deployment is clamped to, regardless of provider (POD_MAX_*). */
export function deploymentResourceMaximums(
  env: Partial<Pick<ServerEnv, "POD_MAX_CPU" | "POD_MAX_MEMORY_GB" | "POD_MAX_DISK_GB">>,
): Partial<PiPodConfig["resources"]> {
  return { cpu: env.POD_MAX_CPU, memoryGB: env.POD_MAX_MEMORY_GB, diskGB: env.POD_MAX_DISK_GB };
}

export async function planPodLaunch(
  deps: PodServiceDeps,
  args: {
    orgId: string;
    userId: string;
    launchContext?: LaunchContext;
    /** False only for organization-scoped jobs, which launch without the owner's bundle. */
    includeUserBundle?: boolean;
    templateId?: string | null;
    project?: LaunchProject | null;
    /** Project config layer without the rest of a launch project — the resolve endpoint's form. */
    projectConfigRaw?: unknown | null;
    /** Project `.pi-pod/env` for resolve. */
    projectEnv?: Record<string, string> | null;
    /** Retired resolve input accepted and ignored for version skew. */
    projectBakeScript?: string | null;
    /** Retired request Pi files accepted and ignored for version skew. */
    piSettingsRaw?: LocalPiSettingsLayers | null;
    /** Covers accepted legacy machine fields that are discarded at the HTTP boundary. */
    legacyLaunchInputsPresent?: boolean;
    provider?: string | null;
    piOverrides?: PiLaunchOverrides | null;
  },
): Promise<PodLaunchPlan> {
  assertLaunchContextSupported(args.launchContext);
  const project = args.project ?? null;
  let template: TemplateRow | null = null;
  if (args.templateId) {
    template = await getTemplate(args.orgId, args.templateId, args.userId);
  }
  // POST /pods callers may still send the former project object during a rolling CLI
  // upgrade. Its identity can keep historical pod/reuse attribution, but none of its
  // settings are launch layers. Only /pods/resolve supplies projectConfigRaw, for the
  // template-bootstrap preview contract.
  const projectConfigRaw = args.projectConfigRaw ?? null;
  const retiredProjectInputsPresent =
    args.legacyLaunchInputsPresent === true ||
    project !== null ||
    (args.projectEnv !== undefined && args.projectEnv !== null) ||
    (args.projectBakeScript !== undefined && args.projectBakeScript !== null) ||
    args.piSettingsRaw != null;

  // Secret scopes, stored credential metadata, and org settings are independent database
  // reads. Keep the launch plan on the longest branch instead of paying for all three in series.
  const [secrets, credentialMetas, resolved] = await Promise.all([
    resolveSecrets({
      kek: deps.kek,
      orgId: args.orgId,
      userId: args.userId,
      includeUserLayer: args.includeUserBundle,
      templateId: template?.id ?? null,
    }),
    listCredentialMeta({ orgId: args.orgId, userId: args.userId }),
    resolveSettings({
      orgId: args.orgId,
      userId: args.userId,
      includeUserLayer: args.includeUserBundle,
      templateConfigRaw: template?.config ?? null,
      templatePiFilesRaw: template?.pi_settings ?? null,
      templateScope: template ? (template.owner_user_id === null ? "org" : "user") : null,
      projectConfigRaw,
      templateSelected: template !== null,
    }),
  ]);
  const { config, clamps, policy } = resolved;
  applyPiLaunchOverrides(config, args.piOverrides);
  const piResources = normalizePiResources(args.piOverrides);
  // Persistent bundle resolution already merged org → positioned template → user. Treat
  // that result as the pod's user-scope ~/.pi set; request project files never participate.
  const piSettings = planLocalPiSettings(
    Object.keys(resolved.piFiles).length > 0 ? { user: resolved.piFiles } : null,
    {
      packages: config.pi.hostConfig.packages,
      userSettings: config.pi.hostConfig.settings,
      workdir: config.workdir,
    },
  );
  const { piAuth, credentialContract } = planLaunchCredentials({
    metas: credentialMetas,
    config,
    piSettings,
  });

  const providerName = args.provider ?? (config.provider || null) ?? platformDefaultProvider(deps.env);
  assertProviderPermitted(policy, providerName);
  assertProviderNotDenied(resolved.deniedProviderOrigins, providerName);
  if (providerName === HOST_PROVIDER_NAME) {
    throw badRequest(
      'the "host" provider is selected by launch placement, not by provider config',
      "launch with `pi-pod launch --on <pod>` (or placement.host in the API) to co-locate a pod on an existing one",
    );
  }
  config.provider = providerName;
  const configuredProvider = config.providers[providerName] ?? {};
  if (providerName === SANDBOX_PROVIDER_NAME && ownedHosts(deps.env) && Object.hasOwn(configuredProvider, "url")) {
    throw badRequest("personal workstation launches cannot select an explicit sandbox URL");
  }
  const hostBackend = providerName === SANDBOX_PROVIDER_NAME ? getSandboxHostBackend(deps.env, { userId: args.userId, kek: deps.kek }) : null;
  // The requested shape is resolved BEFORE placement so the fleet choice sees actual
  // fit (§6.4). The 8GiB gate refuses here — never clamped 8→4 downstream (§7.4).
  // The platform disk default lands here too: 20 GiB for platform-funded native
  // launches with no explicit disk config (provenance-first, layers still win).
  if (providerName === SANDBOX_PROVIDER_NAME) {
    assertSandboxShapeGate(config.resources, deps.env);
    const provisionedDiskGB = ownedHosts(deps.env) ? await edition().ownedHostDiskGB(deps.env, args.userId) : undefined;
    const diskDefault = platformDiskDefault({
      providerName,
      explicitSandboxUrl: Object.hasOwn(configuredProvider, "url"),
      provenance: resolved.provenance,
      ...(provisionedDiskGB !== undefined ? { diskGB: provisionedDiskGB } : {}),
    });
    if (diskDefault) {
      config.resources.diskGB = diskDefault.diskGB;
      resolved.provenance.push(diskDefault.provenanceEntry);
    }
  }
  // Account clients omit provider wiring. Carry the selected stable host ID into
  // pod insertion and keep a public URL cache in the historical launch report.
  // Later calls resolve current transport by ID, never by this cached endpoint.
  // An explicit registered static URL resolves to its ID; unregistered BYO wiring
  // and the empty single-host deployment retain their legacy URL fallback.
  // First placement is request-aware (§6.4): filter by capability AND actual request fit,
  // rank by headroom. A lone candidate is still probed — stale/unreachable must read as
  // capacity, not as a blind create. On retryable capacity pressure at plan time the
  // provisional legacy choice stands in for preflight only; provisioning (which holds the
  // quota slot and the wait queue) re-places authoritatively. An unsupported shape fails
  // fast here: it is never queued and never retried.
  // A dedicated Box is created only after the pod row exists. Planning must
  // not wake or create the owner's shared workstation for a new pod.
  const dedicatedBox = providerName === SANDBOX_PROVIDER_NAME
    && ownedHosts(deps.env)
    && !Object.hasOwn(configuredProvider, "url");
  let placedHost =
    providerName === SANDBOX_PROVIDER_NAME && !Object.hasOwn(configuredProvider, "url") && !dedicatedBox
      ? await hostBackend!.placeHost(undefined, { kek: deps.kek, platformToken: platformToken(deps.env) })
      : null;
  if (
    providerName === SANDBOX_PROVIDER_NAME &&
    !Object.hasOwn(configuredProvider, "url") &&
    !dedicatedBox &&
    placedHost !== null
  ) {
    try {
      const requested = await hostBackend!.placeHostForRequest({
        kek: deps.kek,
        shape: resolveShape(config.resources),
        // Per-tenant degraded check (trusted launch context, never labels;
        // token from the boot snapshot, never ambient mid-overlay).
        ownerKey: buildCreateOwner({ userId: args.userId }).userKey,
        platformToken: platformToken(deps.env),
      });
      if (requested !== null) placedHost = requested.host;
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 400) throw error;
      if (error instanceof HttpError && error.statusCode !== 503) throw error;
      // Retryable capacity pressure (503) keeps the provisional host for
      // preflight; provisioning re-places authoritatively (or waits, when
      // enabled). NON-retryable evidence verdicts (legacy/floor/malformed/
      // mismatch) fail fast instead: falling back to the provisional pick
      // would place on a host the evidence just disqualified. Waiting
      // controls queueing, never whether verification happens.
      if (
        error instanceof HttpError &&
        isAdmissionDetailLike(error.detail) &&
        error.detail.retryable === false
      ) {
        throw error;
      }
    }
  }
  const identityHost = placedHost ? await hostById(placedHost.id)
    : providerName === SANDBOX_PROVIDER_NAME ? await staticHostForUrl(configuredProvider["url"]) : null;
  if (placedHost && !identityHost) throw serviceUnavailable("selected host registration is missing");
  if (identityHost?.owner_user_id != null && identityHost.owner_user_id !== args.userId) throw badRequest("host custody mismatch");
  if (identityHost) requireHostAwake(identityHost);
  const hostAuth = identityHost ? openHostAuth(deps.kek,identityHost) : null;
  const providerConfig = identityHost ? { ...configuredProvider, url:currentHostUrl(identityHost) } :
    providerName === SANDBOX_PROVIDER_NAME &&
    !Object.hasOwn(configuredProvider, "url") &&
    (placedHost !== null || typeof hostBackend!.fallbackUrl() === "string")
      ? { ...configuredProvider, url: placedHost?.url ?? hostBackend!.fallbackUrl() }
      : configuredProvider;
  config.providers[providerName] = providerConfig;
  // Whole-host disk retention replaces normal timed per-pod archival on Box.
  if (identityHost?.owner_user_id != null || dedicatedBox) config.archiveAfterMinutes = 0;
  const imageProvider = identityHost && hostAuth
    ? providerForHost(identityHost,deps.kek,providerConfig,null).provider
    : await loadProvider(providerName, providerConfig);

  // Preflight credential custody before consulting dynamic provider limits. Providers may
  // publish those limits without auth, but a missing key still means no launch can use them.
  const credential = hostAuth || dedicatedBox
    ? { envVar:"PI_POD_SANDBOX_TOKEN",source:"platform" as const }
    : await checkProviderCredential({
    kek: deps.kek,
    orgId: args.orgId,
    provider: providerName,
    platformEnv: platformProviderEnv(deps.env),
  });
  const maximums = credential && imageProvider.resourceMaximums
    ? await imageProvider.resourceMaximums(deps.env)
    : {};
  // The deployment ceiling applies first so its warning names the real limit; the provider's
  // own (possibly lower) maximums then apply to what is left.
  const deploymentMaximums = deploymentResourceMaximums(deps.env);
  if (ownedHosts(deps.env)) deploymentMaximums.diskGB = OWNED_BOX_DISK_CEILING_GB;
  const deploymentResolution = effectiveProviderResources(
    "this deployment",
    config.resources,
    deploymentMaximums,
  );
  const resourceResolution = effectiveProviderResources(
    providerName,
    deploymentResolution.resources,
    maximums,
  );
  config.resources = resourceResolution.resources;

  assertHostedProviderCompatibility(config, imageProvider);
  const imageBuildable = canPrepareManagedImage(imageProvider);
  const providerFindings = capabilityFindings(imageProvider, config);
  const providerError = providerFindings.find((finding) => finding.level === "error");
  if (providerError) throw badRequest(providerError.message, providerError.hint);
  const providerWarnings = [
    ...deploymentResolution.warnings,
    ...resourceResolution.warnings,
    ...providerFindings
      .filter((finding) => finding.level === "warn")
      .map((finding) => finding.message),
  ];
  // Selected Pi extension packages and the bake layers select an image variant with
  // both baked in (the Dockerfile installs pi-packages-npm.txt into /root/.pi/agent/npm and
  // runs bake.sh as the last layer), so a warm variant skips the npm install and the bake
  // work that would otherwise dominate provisioning. The stripped siblings are the fallback
  // ladder while the full variant has not been built yet.
  const bakeSteps = buildBakeSteps({
    org: resolved.bakeScripts.org,
    user: resolved.bakeScripts.user,
    template: template?.bake_script ?? null,
    templateScope: template?.owner_user_id === null ? "org" : "user",
  });
  const composedBake = composeBakeScript(bakeSteps);
  const imageRecipeInputs = {
    configuredRef: config.image,
    imagePinned: resolved.imagePinned,
    launcherVersion: launcherVersion(),
    piVersion: bundledPiVersion(),
    assetRoot: packageRoot(),
    provider: imageProvider,
    resources: config.resources,
  };
  const packages = piSettings?.plan.packages ?? [];
  const imageRecipe = resolveImageRecipe({
    ...imageRecipeInputs,
    packages,
    bakeScript: composedBake,
  });
  // Best first: a bake-bearing sibling only pays the per-session package install, while a
  // bake-less one re-runs the (usually slower) bake script live.
  const fallbackRecipes: ImageRecipe[] = [];
  if (imageRecipe.managed) {
    // imagePinned: false — a fallback is always the managed sibling, never a re-read of the pin.
    for (const candidate of [
      resolveImageRecipe({ ...imageRecipeInputs, imagePinned: false, packages: [], bakeScript: composedBake }),
      resolveImageRecipe({ ...imageRecipeInputs, imagePinned: false, packages, bakeScript: "" }),
      resolveImageRecipe({ ...imageRecipeInputs, imagePinned: false, packages: [], bakeScript: "" }),
    ]) {
      if (!candidate.managed || candidate.ref === imageRecipe.ref) continue;
      if (fallbackRecipes.some((r) => r.ref === candidate.ref)) continue;
      fallbackRecipes.push(candidate);
    }
  }
  config.image = imageRecipe.ref;

  if (config.egress.mode === "allowlist") {
    const builtins = serverBuiltinHosts({ publicUrl: deps.env.PUBLIC_URL });
    for (const host of builtins) {
      if (!config.egress.allow.some((h) => h.toLowerCase() === host)) config.egress.allow.push(host);
    }
  }

  const initSteps = buildInitSteps({
    org: resolved.initScripts.org,
    user: resolved.initScripts.user,
    template: template?.init_script ?? null,
    templateScope: template?.owner_user_id === null ? "org" : "user",
  });

  // A template-less, project-less launch has no name of its own yet; pi renames the pod
  // from its first prompt. Until then "default" names the built-in template, not anything
  // the person who launched it would recognise in a list of their pods.
  const podName = project?.name ?? template?.name ?? "New pod";
  // Every launch works in the same initially-empty workdir; the init scripts own its
  // contents (§5.2).
  const workdir = config.workdir;
  const launchEnvLayers: LaunchEnvLayers = { project: {} };
  const podEnv = composePodEnv(secrets.env, launchEnvLayers);
  const secretScopes: Record<string, string> = { ...secrets.origins };
  const secretShadows: Record<string, string[]> = {};
  const packageEgressWarnings =
    piSettings?.plan.packages.length &&
    config.egress.mode === "allowlist" &&
    !allowsHost(config.egress.allow, "registry.npmjs.org")
      ? [
          "Pi settings name packages, but egress does not allow registry.npmjs.org; " +
            "missing npm packages will be removed if preinstall cannot reach the registry",
        ]
      : [];
  // Platform retention ceiling (§3.1): scoped to platform-funded native sandboxes only.
  // BYOK and non-sandbox providers keep their documented behavior. The clamp is bounded
  // and reported — a requested zero/unlimited never bypasses the finite SaaS maximum.
  const retentionResolution = resolveEffectiveRetention({
    ownedBoxHost: identityHost?.owner_user_id != null,
    requestedMinutes: config.archiveAfterMinutes,
    orgMaxMinutes: policy.maxArchiveAfterMinutes,
    deploymentMaxMinutes: platformArchiveMaxMinutes(deps.env),
    providerName,
    credentialSource: credential?.source ?? null,
  });
  if (retentionResolution.effectiveArchiveAfterMinutes !== config.archiveAfterMinutes) {
    clamps.push(...retentionResolution.clamps);
    config.archiveAfterMinutes = retentionResolution.effectiveArchiveAfterMinutes;
  } else if (retentionResolution.clamps.length > 0) {
    clamps.push(...retentionResolution.clamps);
  }

  const report: ResolvedConfigReport = {
    config,
    image: {
      ref: imageRecipe.ref,
      managed: imageRecipe.managed,
      provenance: imageRecipe.provenance,
      assetDigest: imageRecipe.assetDigest,
      status: "unknown",
    },
    clamps,
    configProvenance: resolved.provenance,
    layerOrder: resolved.layerOrder,
    secretKeys: Object.keys(podEnv).sort(),
    secretScopes,
    ...(Object.keys(secretShadows).length > 0 ? { secretShadows } : {}),
    initSteps: initSteps.map((s) => ({ scope: s.scope, status: "pending" })),
    ...(composedBake
      ? { bake: { digest: bakeDigest(composedBake), mode: "baked" as const, status: "pending" } }
      : {}),
    ...(piAuth ? { piAuthProviders: piAuth.providers } : {}),
    // Recorded because an argument list cannot be asked afterwards which paths this launch
    // required: every later start probes exactly this list before Pi runs.
    ...(piResources ? { piResources } : {}),
    ...(piSettings
      ? {
          piSettings: {
            files: piSettings.meta.files,
            bytes: piSettings.meta.bytes,
            packageCount: piSettings.meta.packageCount,
            droppedKeys: piSettings.meta.droppedKeys,
            status: "pending" as const,
          },
        }
      : {}),
    egress: { description: "", mode: config.egress.mode },
    workdir,
    warnings: [
      ...resolved.warnings,
      ...(retiredProjectInputsPresent ? [LEGACY_PROJECT_LAYERS_WARNING] : []),
      ...(template !== null && projectConfigRaw !== null ? [TEMPLATE_PROJECT_PREVIEW_WARNING] : []),
      ...(deps.env.PUBLIC_URL ? [] : [PUBLIC_URL_UNSET_WARNING]),
      ...packageEgressWarnings,
      ...providerWarnings,
      ...retentionResolution.warnings,
    ],
    notificationsRedacted: policy.notifications?.redacted ?? false,
    retention: {
      ...retentionReport(imageProvider, {
        idleTimeoutMinutes: config.idleTimeoutMinutes,
        archiveAfterMinutes: config.archiveAfterMinutes,
      }),
      ...hostedProviderIdleReport(imageProvider, config.idleTimeoutMinutes),
      ...(identityHost?.owner_user_id != null ? { effectiveArchiveAfterMinutes: 0 } : {}),
    },
  };

  return {
    sandboxHostId: identityHost?.id ?? null,
    template,
    project,
    config,
    provenance: resolved.provenance,
    imageRecipe,
    fallbackRecipes,
    bakeScript: composedBake,
    clamps,
    policy,
    providerName,
    imageBuildable,
    credential,
    piAuth,
    credentialContract,
    piSettings,
    initSteps,
    podName,
    workdir,
    podEnv,
    launchEnvLayers,
    report,
    // True when the sandbox URL was fleet-placed (not an explicit template/org
    // URL): provisioning may authoritatively re-place it when the capacity
    // wait is enabled, instead of trusting the plan-time probe.
    hostPlacedByPlan:
      providerName === SANDBOX_PROVIDER_NAME && !Object.hasOwn(configuredProvider, "url"),
  };
}
/**
 * Whether this provider can put a missing managed image where a launch needs it. Building one
 * is not the only way: a mirror-backed provider pulls the canonical tag into its own image
 * cache instead, and `ensureHostedImage` takes that path for it. Reading "cannot build" as
 * "cannot prepare" is what used to strand a self-hosted sandbox deployment whose mirror was
 * still empty when the server booted — every launch failed until someone restarted it.
 */
export function canPrepareManagedImage(provider: SandboxProvider): boolean {
  return supportsImageBuild(provider) || supportsImageMirror(provider);
}

export function hostedImageInitialState(
  recipe: ImageRecipe,
  imagePresent: boolean,
  providerName: string,
  imageBuildable: boolean,
): "preparing_image" | "provisioning" {
  if (imagePresent) return "provisioning";
  if (!recipe.managed) {
    throw badRequest(
      `image "${recipe.ref}" not found in the ${providerName} org`,
      "pin an existing provider image; pi pod only prepares its own derived runtime images automatically",
    );
  }
  if (!imageBuildable) {
    throw badRequest(
      `provider "${providerName}" cannot prepare managed image "${recipe.ref}"`,
      "the platform operator must preload the exact current pi-pod-base:<tag> into this provider's " +
        "image cache (the production deploy workflow does this after rollout, across the sandbox fleet)",
    );
  }
  return "preparing_image";
}
export function platformDefaultProvider(env: ServerEnv): string {
  const platformEnv = platformProviderEnv(env);
  const withKeys = Object.entries(PROVIDER_CREDENTIAL_VARS)
    .filter(([, envVar]) => Boolean(platformEnv[envVar]))
    .map(([name]) => name);
  return withKeys.length === 1 ? withKeys[0]! : DEFAULT_PROVIDER;
}
