import * as fs from "node:fs";
import * as path from "node:path";
import { findConfigPath, PROJECT_ENV_FILE, nonBundleKeysFound, retiredLocalKeysFound, retiredProviderConfigKeysFound, RETIRED_PROVIDER_CONFIG_KEYS, stripNonBundleKeys, validateConfig, type PiPodConfig } from "../config.js";
import { parseDotenv } from "../dotenv.js";
import { PiPodError } from "../errors.js";
import { parseJsonc } from "../jsonc.js";
import { confirm } from "../prompt.js";
import { legacyUserEnvWarning, mergeConfigLayers } from "../userconfig.js";
import { toOutgoingBundleConfig } from "./bundle-source.js";
import { assertMachineConfigCurrent } from "./launch-overlays.js";
import type { AccountClient, ApiTemplate, PiLaunchOverrides, ResolveReport } from "./api.js";
import { PI_RESOURCE_KEYS, sameResourceList } from "./launch-resources.js";
import type { AccountLaunchFlags, AccountLaunchPlan } from "./launch-types.js";
import {
  machineClientConfig,
  readHostConfig,
  resolveLaunchTemplateRef,
  takeClientOnlyKeys,
} from "./launch-overlays.js";
import { egressAllowsHost } from "./launch-seed.js";
import {
  withWorkstationWait,
  workstationDemandOf,
  workstationHeadline,
  workstationHint,
  type WorkstationCycleTracker,
} from "./workstation.js";
import {
  makeGitRunner,
  planWorkspaceSeed,
  probeWorkspaceSeed,
  resolveSeedRoot,
  type SeedCredential,
  type WorkspaceSeedPlan,
} from "./workspace-seed.js";

export interface PlanAccountLaunchOptions {
  /** False after bootstrap is declined: resolve org/user defaults without a request-local preview. */
  bootstrapPreview?: boolean;
  /** Shared with the later launch wait so two stopped cycles count once per invocation. */
  cycles?: WorkstationCycleTracker;
}

/** Resolve the server-resident chain; local project config is sent only for bootstrap preview. */
export async function planAccountLaunch(
  client: AccountClient,
  flags: AccountLaunchFlags,
  cwd = process.cwd(),
  piOverrides?: PiLaunchOverrides,
  options: PlanAccountLaunchOptions = {},
): Promise<AccountLaunchPlan> {
  const configPath = findConfigPath(cwd, { home: flags.home });
  const projectRoot = configPath === null ? null : path.dirname(path.dirname(configPath));
  // No `.pi-pod/config.json` above cwd: nothing configured describes this directory, so the
  // launch seeds the pod from the directory itself (clone when exact, archive otherwise).
  const isSourceLessLaunch = configPath === null;
  const projectRawFull = configPath
    ? (parseJsonc(fs.readFileSync(configPath, "utf8"), configPath) as Record<string, unknown>)
    : {};
  const retiredLocal = retiredLocalKeysFound(projectRawFull);
  if (retiredLocal.length > 0) {
    throw new PiPodError(
      `${configPath}: retired config key${retiredLocal.length === 1 ? "" : "s"} ${retiredLocal.map((k) => k.path).join(", ")}`,
      { hint: retiredLocal.map((k) => k.hint).join("; ") },
    );
  }
  const machineRaw = readHostConfig(flags.home);
  assertMachineConfigCurrent(machineRaw, flags.home);
  // Retired provider-selection keys warn-and-ignore on every local layer: old files keep
  // running with a migration warning instead of failing the launch.
  const retiredProviderWarnings = [
    ...retiredProviderConfigKeysFound(projectRawFull).map((key) => `${key}: ${RETIRED_PROVIDER_CONFIG_KEYS[key]!}`),
    ...retiredProviderConfigKeysFound(machineRaw).map((key) => `${key}: ${RETIRED_PROVIDER_CONFIG_KEYS[key]!}`),
  ];
  const projectTaken = takeClientOnlyKeys(projectRawFull);
  const machineTaken = takeClientOnlyKeys(machineRaw);
  const projectConfig = podSourceConfig(projectTaken.config);
  const templateRef = resolveLaunchTemplateRef(flags, {
    project: projectTaken.template,
    machine: machineTaken.template,
  });
  const template = templateRef ? await resolveTemplate(client, templateRef) : undefined;
  const templateId = template?.id;
  const bootstrapPreview = templateId === undefined && projectRoot !== null && options.bootstrapPreview !== false;

  const report = await resolveOrFail(client, {
    ...(templateId ? { templateId } : {}),
    ...(bootstrapPreview ? { projectConfig } : {}),
    ...(piOverrides ? { piOverrides } : {}),
    ...(flags.forkFrom ? { forkFrom: flags.forkFrom } : {}),
    checkImage: flags.dryRun === true,
  }, piOverrides, {
    // A dry run and doctor must report a sleeping workstation, not sit in the launch wait.
    wait: flags.dryRun !== true,
    ...(options.cycles ? { cycles: options.cycles } : {}),
  });
  confirmPiOverridesEcho(report, piOverrides);

  const clientViewRaw = mergeConfigLayers(stripNonBundleKeys(report.config), machineClientConfig(machineRaw));
  const merged = validateConfig(clientViewRaw as Record<string, unknown>);
  if (merged.errors.length > 0) {
    throw new PiPodError(
      `invalid configuration from server resolve:\n${merged.errors.map((e, i) => `  ${merged.errorPaths[i]}: ${e}`).join("\n")}`,
      { hint: "the server-resolved org/template/user/policy chain is authoritative; machine client preferences apply locally" },
    );
  }
  const config = {
    ...merged.config,
    template: templateRef ?? null,
  };
  const warnings = [...report.warnings, ...merged.warnings, ...retiredProviderWarnings];
  // Resolve also includes default UI preferences; they are not stored bundle drift,
  // and pushing cannot remove them. The client silently supplies its own preferences.
  // Retired provider keys are the same case: the server strips them from every stored
  // layer before merging, so any that arrive here are server-computed, not pushable drift.
  const droppedServer = nonBundleKeysFound(report.config).filter(
    (key) =>
      key !== "pi.chords" &&
      key !== "pi.sessionNaming" &&
      !Object.hasOwn(RETIRED_PROVIDER_CONFIG_KEYS, key),
  );
  if (droppedServer.length > 0) {
    warnings.push(
      `the server bundle still carries non-bundle keys (${droppedServer.join(", ")}) — they are ignored; run \`pipod push\` to clear them`,
    );
  }
  const legacyEnv = legacyUserEnvWarning(flags.home);
  if (legacyEnv) warnings.push(legacyEnv);

  if (projectRoot !== null) {
    const envPath = path.join(projectRoot, PROJECT_ENV_FILE);
    if (fs.existsSync(envPath)) {
      const count = parseDotenv(fs.readFileSync(envPath, "utf8")).entries.length;
      if (count > 0) {
        warnings.push(
          `.pi-pod/env contains ${count} entr${count === 1 ? "y" : "ies"}; launch-time project env is retired — ` +
            "apply values through template/user secrets custody with `pipod push --with-secrets` or `pipod secrets set`",
        );
      }
    }
    if (!bootstrapPreview && templateId === undefined && Object.keys(projectConfig).length > 0) {
      warnings.push(
        "project pod settings apply only through a template now — run `pipod push` or approve the launch bootstrap prompt",
      );
    }
  }

  // Workspace seeding is transport, not a settings layer. It is performed after provisioning,
  // so none of its generated material enters resolve or launch bodies.
  let workspaceSeed: WorkspaceSeedPlan | undefined;
  let workspaceSeedCredential: SeedCredential | undefined;
  let seedRoot: string | null = null;
  if (isSourceLessLaunch) {
    const planned = await planSourceLessSeed(cwd, flags, config.egress);
    workspaceSeed = planned.plan;
    workspaceSeedCredential = planned.credential;
    seedRoot = planned.plan.kind === "none" ? null : planned.plan.root;
  } else if (templateId === undefined && projectRoot !== null && !flags.forkFrom) {
    // A configured project keeps its established transport: the tree is copied over
    // `/pods/:id/files` after provisioning. The git probe only explains the copy; it never
    // reads credentials, because nothing here would forward them.
    workspaceSeed = await planConfiguredProjectSeed(projectRoot);
    seedRoot = projectRoot;
  }

  const rawName = projectRawFull["name"];
  const projectName = projectRoot === null
    ? undefined
    : typeof rawName === "string" && rawName.length > 0
      ? rawName
      : path.basename(projectRoot);
  return {
    ...(projectName ? { projectName } : {}),
    ...(templateId ? { templateId, templateScope: template?.scope ?? "org" } : {}),
    bootstrapPreview,
    config,
    projectRoot,
    warnings,
    resolve: report,
    ...(workspaceSeed ? { workspaceSeed } : {}),
    ...(workspaceSeedCredential ? { workspaceSeedCredential } : {}),
    seedRoot,
  };
}

/**
 * Decide how a directory with no `.pi-pod/config.json` reaches the pod. Forks, co-location and
 * `--no-seed` opt out before any probe runs; a dry run probes locally and anonymously but never
 * reads or forwards credentials, so `--dry-run` can be scripted without a prompt.
 */
async function planSourceLessSeed(
  cwd: string,
  flags: AccountLaunchFlags,
  egress: PiPodConfig["egress"],
): Promise<{ plan: WorkspaceSeedPlan; credential?: SeedCredential }> {
  if (flags.seed === false) return { plan: { kind: "none", reason: "--no-seed" } };
  if (flags.forkFrom) return { plan: { kind: "none", reason: "fork copies the conversation, not the workspace" } };
  if (flags.on) return { plan: { kind: "none", reason: "a co-located pod shares its host's workdir" } };
  const root = resolveSeedRoot(cwd, { home: flags.home });
  if (!root.ok) return { plan: { kind: "none", reason: root.reason } };
  return planWorkspaceSeed({
    root: root.root,
    subdir: root.subdir,
    git: makeGitRunner(root.root),
    credentials: flags.dryRun ? "skip" : "probe",
    egressAllows: (host) => egressAllowsHost(egress, host),
    confirmCredentialForwarding: (host) =>
      confirm(
        `forward your git credentials for ${host} so the pod can clone this private repository? ` +
          "(they are used for one clone and never stored; declining sends an archive instead)",
        { nonInteractiveDefault: false, assumeYes: flags.yes },
      ),
  });
}

/** The legacy `/files` copy every configured project without an init script has always received. */
async function planConfiguredProjectSeed(projectRoot: string): Promise<WorkspaceSeedPlan> {
  const probe = await probeWorkspaceSeed({ root: projectRoot, git: makeGitRunner(projectRoot), credentials: "skip" });
  const reason = probe.kind === "archive" ? probe.reason : `cloneable from ${probe.url} at ${probe.branch}`;
  return { kind: "copy", root: projectRoot, reason };
}

/** Strip client metadata from the one request that may preview project pod settings. */
function podSourceConfig(raw: Record<string, unknown>): Record<string, unknown> {
  return toOutgoingBundleConfig(raw);
}

/** Resolve on the server and fail closed when it is unavailable or incompatible. */
async function resolveOrFail(
  client: AccountClient,
  body: Parameters<AccountClient["resolve"]>[0],
  piOverrides?: PiLaunchOverrides,
  wait: { wait: boolean; cycles?: WorkstationCycleTracker } = { wait: true },
): Promise<ResolveReport> {
  let resolved: ResolveReport | null;
  try {
    // Preflight is the FIRST thing a cold launch does, so on the SaaS edition it is also the
    // first call to meet a sleeping personal workstation: resolving a launch has to place it,
    // and placing it starts it. A real launch waits here. A dry run only reports the demand.
    // Resolve creates no pod row, so retrying it does not create a second pod.
    const attempt = () => client.resolve(body);
    if (!wait.wait) {
      try {
        resolved = await attempt();
      } catch (error) {
        const demand = workstationDemandOf(error);
        if (demand) {
          throw new PiPodError(workstationHeadline(demand), {
            hint: workstationHint(demand),
            status: 503,
            code: demand.reason,
            cause: error,
          });
        }
        throw error;
      }
    } else {
      resolved = await withWorkstationWait(client, attempt, {
        ...(wait.cycles ? { cycles: wait.cycles } : {}),
      });
    }
  } catch (error) {
    if (error instanceof PiPodError && error.status === 400) {
      if (
        piOverrides &&
        /(?:unrecognized|unknown)[^\n]*piOverrides|piOverrides[^\n]*(?:unrecognized|unknown)/i.test(error.message)
      ) {
        throw new PiPodError("the account server does not support per-launch Pi overrides", {
          hint: "deploy the matching pi pod server before setting --model, --thinking, --extension, --skill, or --prompt-template per launch",
          cause: error,
        });
      }
      if (body.forkFrom && /(?:unrecognized|unknown|unexpected)[^\n]*forkFrom|forkFrom[^\n]*(?:unrecognized|unknown|unexpected)/i.test(error.message)) {
        throw new PiPodError("the account server does not support forking a session into a new pod", {
          hint: "deploy the matching pi pod server before using `pipod fork`",
          cause: error,
        });
      }
      // Production scrubs schema errors to this generic message, including old
      // servers rejecting the new nested keys. Keep the refusal, not an invented
      // diagnosis, but give resource callers an actionable compatibility hint.
      if (piOverrides && PI_RESOURCE_KEYS.some((key) => (piOverrides[key]?.length ?? 0) > 0) && /validation failed/i.test(error.message)) {
        throw new PiPodError(error.message, {
          status: error.status,
          hint: "check the launch settings and pod-local paths; resource selection requires a server supporting per-launch --extension, --skill and --prompt-template — upgrade an older server",
          cause: error,
        });
      }
    }
    throw error;
  }
  if (!resolved) {
    throw new PiPodError("the account server is too old for CLI launches", {
      hint: "deploy the matching pi pod server before launching",
    });
  }
  return resolved;
}

/**
 * Fail closed when the server did not echo the requested overrides back. A server that
 * predates a field answers without it — launching anyway would bill a pod whose Pi boots
 * without the requested model or resources, which reads as success until the first prompt.
 * Empty resource arrays are an additive no-op and need no echo; every requested entry must
 * come back exactly, order included.
 */
function confirmPiOverridesEcho(resolved: ResolveReport, piOverrides?: PiLaunchOverrides): void {
  if (!piOverrides) return;
  const echoed = resolved.piOverrides;
  const confirmed =
    echoed !== null &&
    echoed !== undefined &&
    echoed.model === piOverrides.model &&
    echoed.thinking === piOverrides.thinking &&
    PI_RESOURCE_KEYS.every(
      (key) => (piOverrides[key] ?? []).length === 0 || sameResourceList(piOverrides[key], echoed[key]),
    );
  if (!confirmed) {
    throw new PiPodError("the account server did not confirm the per-launch Pi overrides", {
      hint: "deploy the matching pi pod server before setting --model, --thinking, --extension, --skill, or --prompt-template per launch",
    });
  }
}

/** Resolve a visible template by id or name; personal templates shadow org names. */
export async function resolveTemplate(client: AccountClient, ref: string): Promise<ApiTemplate> {
  const { templates } = await client.listTemplates();
  const byId = templates.find((template) => template.id === ref);
  const named = templates
    .filter((template) => template.name.toLowerCase() === ref.toLowerCase())
    .sort((a, b) => (a.scope === "user" ? 0 : 1) - (b.scope === "user" ? 0 : 1));
  const found = byId ?? named[0];
  if (!found) {
    const names = templates.map((template) => template.name);
    throw new PiPodError(`template not found: ${ref}`, {
      hint: names.length > 0 ? `templates: ${names.join(", ")}` : "this organization has no templates",
    });
  }
  return found;
}

export async function resolveTemplateId(client: AccountClient, ref: string): Promise<string> {
  return (await resolveTemplate(client, ref)).id;
}
