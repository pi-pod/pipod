import { buildPiArgv } from "../piargv.js";
import { CancelledError, PiPodError } from "../errors.js";
import { color, info, step, warn } from "../log.js";
import type { AccountClient, ApiPod } from "./api.js";
import { parseAccountLaunchPiArgs } from "./launch-args.js";
import { planAccountLaunch } from "./launch-preflight.js";
import {
  launchRidingOutBlips,
  podReadySummary,
  printLaunchReport,
  tryAccountReuse,
  watchProvisioning,
} from "./launch-provision.js";
import type {
  AccountLaunchFlags,
  AccountLaunchPlan,
  RunAccountLaunchOptions,
} from "./launch-types.js";
import { seedWorkspace } from "./launch-seed.js";
import { runAccountSession } from "./session.js";
import { describeWorkspaceSeed } from "./workspace-seed.js";
import { displayRef } from "./ref.js";
import { withCapacityHint } from "./capacity-errors.js";
import { selectAccountPod } from "./pods.js";
import { bootstrapProjectTemplate, projectTemplateStaleness, userLayerStaleness } from "./bundle-bootstrap.js";
import { createWorkstationCycleTracker } from "./workstation.js";


/** `--on <pod|self>`: validate the combination and resolve the ref to a placement body. */
async function resolvePlacementFlag(
  client: RunAccountLaunchOptions["client"],
  flags: AccountLaunchFlags,
): Promise<{ host: string } | undefined> {
  if (!flags.on) return undefined;
  if (flags.forkFrom) {
    throw new PiPodError("forking into a co-located pod is not supported yet", {
      hint: "fork without --on, or launch a plain co-located pod",
    });
  }
  if (flags.dryRun) {
    throw new PiPodError("--dry-run does not support --on yet", {
      hint: "resolve without --on to preview the config layers",
    });
  }
  if (flags.on === "self") {
    if (!client.isPodToken) {
      throw new PiPodError('--on self is only meaningful inside a pod', {
        hint: "from your machine, name the pod to share: pipod --on <pod>",
      });
    }
    return { host: "self" };
  }
  const host = await selectAccountPod(client, flags.on, "place a pod on");
  return { host: host.id };
}

export async function runAccountLaunch(opts: RunAccountLaunchOptions): Promise<number> {
  const { client, flags } = opts;
  const { prompt, piOverrides, extraArgs, tuiMode } = parseAccountLaunchPiArgs(opts.piArgs);
  if (extraArgs.length > 0) {
    throw new PiPodError(
      `only --model, --thinking, -e/--extension, --skill, --prompt-template, and --tui-mode can be set per-launch in account mode: ${extraArgs.join(" ")}`,
      { hint: "set other Pi options in config (`pi.args`); resource paths name files or directories inside the pod" },
    );
  }

  const hostCwd = opts.cwd ?? process.cwd();
  const cycles = createWorkstationCycleTracker();
  const placement = await resolvePlacementFlag(client, flags);
  let plan = await planAccountLaunch(
    client,
    { ...flags, home: flags.home ?? opts.home },
    hostCwd,
    piOverrides,
    { cycles },
  );
  const emittedWarnings = new Set<string>();
  const emitPlanWarnings = (): void => {
    for (const warning of plan.warnings) {
      if (emittedWarnings.has(warning)) continue;
      emittedWarnings.add(warning);
      warn(warning);
    }
  };
  emitPlanWarnings();
  announceSettingsChain(plan);
  announceWorkspaceSeed(plan);

  if (plan.projectRoot && plan.templateId) {
    const stale = await projectTemplateStaleness({ client, cwd: hostCwd, home: flags.home ?? opts.home });
    if (stale) warn(stale);
  }
  const userStale = await userLayerStaleness({ client, home: flags.home ?? opts.home });
  if (userStale) warn(userStale);

  let bootstrapWorkspaceSeed: AccountLaunchPlan["workspaceSeed"];
  if (
    plan.projectRoot && !plan.templateId && !flags.template &&
    !flags.forkFrom && !flags.dryRun
  ) {
    info(
      `resolve preview: provider ${plan.resolve.provider}; image ${plan.resolve.image}; ` +
        `egress ${plan.resolve.egress.mode}; template none`,
    );
    const created = await bootstrapProjectTemplate({ client, cwd: hostCwd, home: flags.home ?? opts.home });
    if (created) {
      bootstrapWorkspaceSeed = plan.workspaceSeed;
      info(`created and pinned template ${created.name}`);
    }
  }

  // A projectConfig resolve is only the bootstrap preview. Whether creation was declined or
  // skipped, the real launch must be planned from server-custodied org/user settings alone.
  if (!flags.dryRun && plan.bootstrapPreview) {
    plan = await planAccountLaunch(
      client,
      { ...flags, home: flags.home ?? opts.home },
      hostCwd,
      piOverrides,
      { bootstrapPreview: false, cycles },
    );
    if (plan.templateId && !plan.workspaceSeed && bootstrapWorkspaceSeed) {
      // The just-created template may have no authored init script. Preserve the preview's
      // one-time workspace transport without turning it into a template/project settings body.
      plan.workspaceSeed = bootstrapWorkspaceSeed;
    }
    emitPlanWarnings();
    announceSettingsChain(plan);
    announceWorkspaceSeed(plan);
  }

  if (flags.dryRun) {
    printAccountDryRun(client, plan);
    return 0;
  }

  if (flags.forkFrom) {
    warn("fork copies the conversation, not the workspace — commit and push before forking if the new pod needs those changes");
  }
  warnNoModelProvider(plan.resolve);
  const target = plan.resolve.template
    ? `${plan.resolve.template.name} template`
    : plan.projectName
      ? `project ${plan.projectName} (server defaults)`
      : "server defaults";
  const where = placement
    ? placement.host === "self"
      ? " co-located on this pod's machine"
      : ` co-located on ${displayRef(placement.host, "pod")}'s machine`
    : "";
  step("launch", `${target} via ${client.serverUrl} (account mode)${where}`);
  const launchStartedAt = Date.now();
  // A source-less clone/archive asks the server to hold Pi until the workdir is seeded, so the
  // first session already sees the project's AGENTS.md and .pi/. Forks and co-located pods
  // are never seeded; the legacy configured-project copy keeps its post-start timing.
  const armsSeedGate =
    plan.workspaceSeed !== undefined &&
    (plan.workspaceSeed.kind === "clone" || plan.workspaceSeed.kind === "archive") &&
    !flags.forkFrom &&
    !placement;
  const launchBody = {
    ...(plan.templateId ? { templateId: plan.templateId } : {}),
    // A fork continues another pod's conversation, which belongs to that pod's project, not
    // to wherever the command happens to run.
    ...(plan.projectName && !flags.forkFrom ? { project: { name: plan.projectName } } : {}),
    ...(piOverrides ? { piOverrides } : {}),
    ...(flags.forkFrom ? { forkFrom: flags.forkFrom } : {}),
    ...(placement ? { placement } : {}),
    ...(armsSeedGate ? { workspaceSeed: true } : {}),
  };
  // A co-located pod has no machine of its own to reuse; a fresh one on the host is as fast.
  // Fresh pods are the default — only an explicit --reuse reuses a stopped project pod.
  const wantReuse = !flags.forkFrom && !placement && flags.reuse === true;
  let cancellation: CancelledError | null = null;
  let freshPodId: string | null = null;
  // Last preparationPhase seen for the fresh pod. The interrupt cleanup re-reads the
  // pod, but this is the fallback when that read fails (server unreachable mid-blip).
  let lastPhase: ApiPod["preparationPhase"] | undefined;
  let piStarted = false;
  let cleanupPromise: Promise<void> | null = null;
  // Seeding streams an archive that may take minutes; Ctrl-C has to reach it mid-flight.
  const seedAbort = new AbortController();

  const deleteCancelledPod = (): Promise<void> => {
    if (!freshPodId) return Promise.resolve();
    cleanupPromise ??= (async () => {
      const podId = freshPodId!;
      // Re-read the pod before deleting: interrupting during seedWorkspace (or any
      // post-wait phase) means the pod is already live, and deleting it would destroy
      // work. Only a pod still queued in a bounded capacity wait is safe to delete;
      // anything else is left running with its id printed for `pipod attach` / `gc`.
      let phase = lastPhase;
      try {
        phase = (await client.getPod(podId)).preparationPhase;
        lastPhase = phase;
      } catch {
        // Fall back to the last observed phase when the re-read fails.
      }
      // End a bounded capacity wait first so the server finishes it as
      // `cancelled` instead of running it to `expired` (best-effort:
      // older servers 404 and the pod delete below still ends the wait).
      await client.cancelCapacityWait(podId).then(
        () => undefined,
        () => undefined,
      );
      if (phase === "waiting-for-capacity") {
        await client.deletePod(podId).then(
          () => info(`deleted canceled pod ${displayRef(podId, "pod")}`),
          (error: unknown) => {
            warn(
              `could not delete canceled pod ${displayRef(podId, "pod")}: ` +
                `${error instanceof Error ? error.message : String(error)} — delete it with \`pipod gc --delete\``,
            );
          },
        );
      } else {
        info(
          `interrupted — leaving pod ${displayRef(podId, "pod")} as is; ` +
            `reattach with \`pipod attach ${displayRef(podId, "pod")}\` or delete it with \`pipod gc --delete\``,
        );
      }
    })();
    return cleanupPromise;
  };
  const noteFreshPod = (pod: ApiPod): void => {
    freshPodId = pod.id;
    lastPhase = pod.preparationPhase;
    if (cancellation) void deleteCancelledPod();
  };
  const throwIfCancelled = (): void => {
    if (cancellation) throw cancellation;
  };
  const onInterrupt = (): void => {
    if (piStarted || cancellation) return;
    cancellation = new CancelledError("interrupted");
    seedAbort.abort();
    warn(
      freshPodId
        ? `interrupted — checking pod ${displayRef(freshPodId, "pod")} before exit`
        : "interrupted — checking whether the launch created a pod before exit",
    );
    void deleteCancelledPod();
  };
  process.on("SIGINT", onInterrupt);

  try {
    const workstation = { cycles, cancelled: () => cancellation !== null };
    let launched = wantReuse ? await tryAccountReuse(client, plan, launchBody, { workstation }) : null;
    let reused = launched !== null;
    throwIfCancelled();
    if (!launched) {
      launched = await launchRidingOutBlips(client, plan, launchBody, { cancelled: () => cancellation !== null, workstation });
      noteFreshPod(launched.pod);
      throwIfCancelled();
    }
    printLaunchReport(launched.report, launched.pod);
    let started = await watchProvisioning(client, launched.pod.id, { cancelled: () => cancellation !== null });
    lastPhase = started.preparationPhase;
    throwIfCancelled();
    if (started.resolvedConfig.reuseRefused) {
      // The candidate went back to stopped exactly as it was; this launch still owes a pod.
      info(`pod ${displayRef(launched.pod.id, "pod")} not reused — ${started.resolvedConfig.reuseRefused}; launching a fresh pod`);
      launched = await launchRidingOutBlips(client, plan, launchBody, { cancelled: () => cancellation !== null, workstation });
      noteFreshPod(launched.pod);
      reused = false;
      throwIfCancelled();
      printLaunchReport(launched.report, launched.pod);
      started = await watchProvisioning(client, launched.pod.id, { cancelled: () => cancellation !== null });
      lastPhase = started.preparationPhase;
      throwIfCancelled();
    }
    info(color.dim(podReadySummary(started, Date.now() - launchStartedAt)));

    // Only a pod this launch created owes a workspace; a reused one already has one, and
    // overwriting it would clobber work the previous session left behind. A co-located
    // child never owes one either: its "pod workspace" is the host's workdir, and seeding
    // into a shared filesystem would overwrite the host's own files.
    await seedWorkspace({
      client,
      pod: started,
      plan: plan.workspaceSeed,
      credential: plan.workspaceSeedCredential,
      reused,
      coLocated: placement !== undefined,
      // Only the server knows whether it honored the gate: an older one rejected the flag and
      // started Pi already, and a reused pod never armed one.
      gated: !reused && started.resolvedConfig.workspaceSeed?.status === "pending",
      signal: seedAbort.signal,
    });
    throwIfCancelled();

    const result = await runAccountSession({
      client,
      pod: started,
      config: plan.config,
      hostCwd: plan.projectRoot ?? hostCwd,
      startupPrompt: prompt,
      onPiStarted: () => {
        throwIfCancelled();
        piStarted = true;
        process.off("SIGINT", onInterrupt);
      },
      ...(tuiMode ? { tuiMode } : {}),
    });
    return result.exitCode;
  } catch (error) {
    if (!piStarted && (cancellation || error instanceof CancelledError)) {
      await deleteCancelledPod();
      throw cancellation ?? error;
    }
    // Quota/capacity refusals arrive as plain server errors; add the actionable hint here so
    // launch, reuse-refusal relaunch, wake-on-attach, and seed paths all present the same copy.
    throw withCapacityHint(error);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

function announceSettingsChain(plan: AccountLaunchPlan): void {
  info(`settings chain: ${formatSettingsChain(plan)}`);
}

/** One line naming the transport before the pod exists, so a surprise is caught before it bills. */
function announceWorkspaceSeed(plan: AccountLaunchPlan): void {
  const seed = plan.workspaceSeed;
  if (!seed) return;
  switch (seed.kind) {
    case "none":
      info(`workspace seed: none (${seed.reason})`);
      return;
    case "copy":
      info(`workspace transport: this directory will be copied into the pod (${seed.reason})`);
      return;
    case "clone":
      info(`workspace seed: the pod will ${describeWorkspaceSeed(seed)}`);
      break;
    case "archive":
      info(
        `workspace seed: ${seed.root} will be archived into the pod` +
          `${seed.includeGit ? " with .git history" : ""} (${seed.reason})`,
      );
      break;
  }
  if (seed.subdir !== "") {
    info(color.dim(`launched from ${seed.subdir}/ — the whole repository seeds the pod's workspace root`));
  }
}


export function formatSettingsChain(plan: AccountLaunchPlan): string {
  const order = plan.resolve.layerOrder;
  if (!order) {
    return `org defaults${plan.templateId ? ` → template (${plan.templateScope ?? "org"})` : ""}` +
      `${plan.bootstrapPreview ? " → project preview" : ""} → org policy`;
  }
  const rendered = order.map((layer, index) => {
    if (layer !== "template") return displaySettingsLayer(layer, plan);
    const userIndex = order.indexOf("user");
    const scope = plan.templateScope ?? (userIndex >= 0 && index > userIndex ? "user" : "org");
    return `template (${scope})`;
  });
  rendered.push("org policy");
  return rendered.join(" → ");
}

function displaySettingsLayer(layer: string, plan: AccountLaunchPlan): string {
  switch (layer) {
    case "org": return "org defaults";
    case "user": return "user defaults";
    case "template": return `template (${plan.templateScope ?? "org"})`;
    case "project": return plan.bootstrapPreview ? "project preview" : "project";
    case "policy":
    case "org-policy": return "org policy";
    default: return layer;
  }
}

function printAccountDryRun(client: AccountClient, plan: AccountLaunchPlan): void {
  info(`account mode dry-run via ${client.serverUrl} — nothing created`);
  if (plan.resolve.forkFrom) {
    const session = plan.resolve.forkFrom.sessionPath ? ` session ${plan.resolve.forkFrom.sessionPath}` : "";
    info(`fork from: ${plan.resolve.forkFrom.podId}${session}`);
    info("fork copies the conversation, not the workspace — commit and push before forking if the new pod needs those changes");
  }
  if (plan.projectName) info(`project: ${plan.projectName}`);
  info(`template: ${plan.resolve.template?.name ?? "none"}`);
  info(`settings chain: ${formatSettingsChain(plan)}`);
  if (plan.bootstrapPreview) info("project config: bootstrap preview only; it will not travel in a launch request");
  const r = plan.resolve;
  info(`provider: ${r.provider}`);
  info(
    `credential: ${r.credential.envVar} ${r.credential.available ? `available (${r.credential.source})` : "MISSING"}`,
  );
  info(`image: ${r.image}${r.imageStatus ? ` (${r.imageStatus})` : ""}`);
  info(`egress: ${r.egress.mode}`);
  info(`workdir: ${r.workdir}`);
  if (plan.workspaceSeed) {
    info(`workspace seed: ${describeWorkspaceSeed(plan.workspaceSeed)}`);
    if (plan.workspaceSeed.kind === "clone" && plan.workspaceSeed.access === "credential") {
      info(
        `  the remote is private: at launch, git credentials for ${plan.workspaceSeed.host} are read from ` +
          "the credential helper or GitHub CLI, verified, and forwarded only if you approve; otherwise an archive is sent",
      );
    }
    if ((plan.workspaceSeed.kind === "clone" || plan.workspaceSeed.kind === "archive") && plan.workspaceSeed.subdir !== "") {
      info(`  launched from ${plan.workspaceSeed.subdir}/ inside the seed root`);
    }
  }
  info(`pi command: ${buildPiArgv(plan.config.pi).join(" ")}`);
  const configProvenance = r.configProvenance ?? r.provenance;
  if (configProvenance && configProvenance.length > 0) {
    info("settings provenance (later layers win):");
    for (const p of configProvenance) {
      const contested = p.over.length > 0
        ? color.dim(`  (over ${p.over.map((layer) => displaySettingsLayer(layer, plan)).join(", ")})`)
        : "";
      info(`  ${p.path} ← ${displaySettingsLayer(p.winner, plan)}${contested}`);
    }
  }
  if (r.secretKeys.length > 0) {
    const scopes = r.secretScopes ?? {};
    const shadows = r.secretShadows ?? {};
    const labeled = r.secretKeys.map((k) => {
      const scope = scopes[k] ? `${k}(${scopes[k]})` : k;
      const lost = shadows[k];
      return lost?.length ? `${scope}[over ${lost.join(",")}]` : scope;
    });
    info(`secrets that would travel: ${labeled.join(", ")}`);
  }
  const initScopes = r.initSteps.map((s) => displaySettingsLayer(s.scope, plan));
  if (initScopes.length > 0) info(`init steps: ${initScopes.join(" → ")}`);
  if (r.piAuthProviders.length > 0) info(`pi auth providers: ${r.piAuthProviders.join(", ")}`);
  if (r.piSettings) {
    info(`Pi settings: ${r.piSettings.files.join(", ")} (${r.piSettings.packageCount} package(s))`);
  }
  for (const clamp of r.clamps) {
    warn(`org policy: ${clamp.path} ${JSON.stringify(clamp.from)} → ${JSON.stringify(clamp.to)} (${clamp.reason})`);
  }
  for (const warning of r.warnings) warn(warning);
  if (!r.credential.available) {
    warn(`launch would fail: no ${r.provider} credential — store org secret ${r.credential.envVar} or set it on the server`);
  }
}

/**
 * A pod signed in to no model provider has nothing to talk to, and pi's own advice there —
 * `/login` inside the pod — would keep the sign-in in that one pod. Say what works, up front.
 */
export function warnNoModelProvider(resolve: { piAuthProviders: string[] }): void {
  if (resolve.piAuthProviders.length > 0) return;
  warn("no model provider is connected, so pi in the pod has no model to use");
  info("  `pipod credentials connect` connects the ones your local pi uses; `pipod credentials` lists the rest");
}
