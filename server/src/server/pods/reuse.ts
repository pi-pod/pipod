import { isDeepStrictEqual } from "node:util";
import { uploadShim } from "../../core/client/session.js";
import type { PiPodConfig } from "../../core/config.js";
import { launcherVersion } from "../../core/image.js";
import { EXIT_CODE_FILE } from "../../core/lifecycle.js";
import { creationMarkers, runtimeMarkers } from "../../core/labels.js";
import { SHIM_VERSION } from "../../core/shim/agentd.js";
import { describePolicy } from "../../core/egress.js";
import { PROVIDER_CREDENTIAL_VARS } from "../../core/providers/registry.js";
import type { Sandbox, SandboxProvider } from "../../core/providers/types.js";
import { shellQuote } from "../../core/providers/util.js";
import { egressPolicyFromDescription } from "./supervisor.js";
import { audit } from "../audit.js";
import { query, tx } from "../db/index.js";
import { acquireQuotaLocks, orgConcurrencyCapTx, assertQuotaRoomTx } from "./concurrency.js";
import { edition, ownedHosts } from "../edition.js";
import { badRequest, conflict } from "../httperrors.js";
import { assertLaunchAllowed, assertLaunchGateOpen } from "./launch-control.js";
import { truncate } from "../push/copy.js";
import { sanitizeFailureMessage } from "../safe-errors.js";
import type { LocalPiSettingsLayers, PlannedPiSettings } from "../settings/pi-settings.js";
import { runPodInitSteps } from "./initialization.js";
import { resolvePodEnv, savePodLaunchEnv } from "./launchenv.js";
import { START_TIMEOUT_MS, STOP_TIMEOUT_MS } from "./lifecycle.js";
import { materializeLaunchCredentialLease, resolveLaunchEgressPolicy } from "./provisioning.js";
import {
  planPodLaunch,
  type LaunchProject,
  type PiLaunchOverrides,
  type PodLaunchPlan,
} from "./planning.js";
import { platformCredentialsOf, withProviderCredential } from "./providercred.js";
import { getPod } from "./store.js";
import { hostForPod } from "./hostidentity.js";
import type { InitScope, PodLaunchResult, PodRow, PodServiceDeps, ResolvedConfigReport } from "./types.js";
import { assertLaunchContextSupported, type LaunchContext } from "./launch-context.js";

/** A warm disk is reusable only when every setting that cannot be reconciled is unchanged. */
export function assertReusableLaunchSettings(
  frozen: Pick<ResolvedConfigReport, "config">,
  planned: Pick<PodLaunchPlan, "config" | "piSettings">,
): void {
  if (!isDeepStrictEqual(planned.config.egress, frozen.config?.egress)) {
    throw conflict("this launch resolves to a different egress policy");
  }
  if (planned.piSettings !== null) {
    throw conflict("Pi settings cannot be reconciled with a warm pod");
  }
}

export function providerForPodReuse(
  requestedProvider: string | null | undefined,
  existingProvider: string,
): string {
  return requestedProvider ?? existingProvider;
}

export type ReuseEgressDecision =
  | { action: "proceed"; description: string; egressRestricted: boolean }
  | { action: "refuse"; reason: string };

/**
 * Reconcile the recomputed launch egress against the provider-enforced reality, BEFORE the
 * sandbox starts (pure, unit-tested).
 *
 * No provider implements `Sandbox.updateEgress`, so native enforcement is immutable after
 * create: a stopped sandbox still enforces exactly the policy it was created with. The only
 * verifiable claim is therefore equality with the frozen committed description — anything
 * else would publish a string the provider does not enforce. Drift (a forbidden derived
 * host, rotated provider endpoints) is unreconcilable stopped, and the gateway cannot heal
 * it either when the callback host is already allowed, so reuse refuses and the client
 * falls back to a fresh launch. A broken `""` row heals only when the intact stored config
 * explicitly derives open (the stopped sandbox necessarily still enforces open); a broken
 * allowlist row is unverifiable and fails closed. Nothing here infers open from emptiness.
 */
export function decideReuseEgress(args: {
  frozenDescription: string;
  frozenMode: string;
  recomputedDescription: string;
  recomputedMode: "open" | "allowlist";
  configMode: "open" | "allowlist";
}): ReuseEgressDecision {
  const { frozenDescription, frozenMode, recomputedDescription, recomputedMode, configMode } = args;
  if (recomputedMode !== configMode) {
    return {
      action: "refuse",
      reason:
        `egress policy cannot be reconciled (resolved ${recomputedMode} does not match configured ${configMode}); ` +
        "launch a new pod instead of reusing this disk",
    };
  }
  if (egressPolicyFromDescription(frozenDescription) !== null) {
    if (frozenDescription === recomputedDescription && frozenMode === recomputedMode) {
      return {
        action: "proceed",
        description: recomputedDescription,
        egressRestricted: recomputedMode === "allowlist",
      };
    }
    return {
      action: "refuse",
      reason:
        `egress policy changed since launch (frozen ${frozenMode} no longer matches the resolved ${recomputedMode} launch policy); ` +
        "launch a new pod instead of reusing this disk",
    };
  }
  // Unrecoverable frozen description (the M5 `""` shape): heal only open-from-open, where the
  // stopped sandbox necessarily still enforces open. Never a blank-to-open fallback — the
  // description below is the authoritative recompute, admitted solely on this equality.
  if (frozenMode === "open" && configMode === "open" && recomputedMode === "open") {
    return { action: "proceed", description: recomputedDescription, egressRestricted: false };
  }
  return {
    action: "refuse",
    reason:
      "pod has no recoverable provider egress policy; " +
      "launch a new pod instead of reusing this disk",
  };
}

/**
 * Reuse a stopped pod for a new launch of the same project (§6.5): the same merge and
 * secret resolution as a fresh launch, but the sandbox comes back with its warm disk — the
 * idempotent init scripts re-run over existing node_modules instead of from nothing.
 *
 * The claim is synchronous and atomic; the refresh runs in the background like provisioning.
 * An ineligible pod answers 409 and the client falls back to a fresh launch.
 */
export async function reusePod(
  deps: PodServiceDeps,
  args: {
    podId: string;
    orgId: string;
    userId: string;
    launchContext?: LaunchContext;
    templateId?: string | null;
    project?: LaunchProject | null;
    piSettingsRaw?: LocalPiSettingsLayers | null;
    legacyLaunchInputsPresent?: boolean;
    provider?: string | null;
    piOverrides?: PiLaunchOverrides | null;
  },
): Promise<PodLaunchResult> {
  assertLaunchContextSupported(args.launchContext);
  await assertLaunchAllowed(undefined, args.userId);
  const planStartedAt = Date.now();
  const pod = await getPod(args.orgId, args.podId);
  if (pod.user_id !== args.userId) throw conflict("only the pod's owner can reuse it");
  // Warm-disk reuse is still new work: a reached cap refuses it. The warm disk is
  // already counted in attested usage, so reuse reserves no new workspace storage.
  await edition().admitPodWork(deps.env, args.userId);
  const existingHost = await hostForPod(pod);
  const planningDeps = ownedHosts(deps.env) && existingHost?.owner_user_id == null
    ? { ...deps, env: { ...deps.env, SANDBOX_HOST_BACKEND: "static" as const } } : deps;
  if (pod.provider === "host") {
    // A co-located pod has no machine of its own to refresh; launching a fresh one on the
    // same host is just as fast, so reuse buys nothing and the eligibility rules below
    // (workdir refresh, provider restart) do not translate.
    throw conflict("co-located pods cannot be reused; launch a new pod on the same host");
  }
  // Preserve the existing sandbox's provider when the request omits one; a change to the
  // platform default must not silently turn reuse into a cross-provider launch.
  const plan = await planPodLaunch(planningDeps, {
    ...args,
    provider: providerForPodReuse(args.provider, pod.provider),
  });
  const { project, config, providerName, initSteps, piSettings, launchEnvLayers, credentialContract, report } = plan;
  (report.timings ??= {}).plan = Date.now() - planStartedAt;

  if (pod.user_id !== args.userId) throw conflict("only the pod's owner can reuse it");
  if (!pod.provider_sandbox_id) throw conflict("this pod has no sandbox to reuse");
  if (pod.provider !== providerName) throw conflict("this launch resolves to a different provider");
  if (pod.project !== (project?.name ?? null) || pod.template_id !== (plan.template?.id ?? null)) {
    throw conflict("this pod belongs to a different project or template");
  }
  assertReusableLaunchSettings(pod.resolved_config, plan);
  const previousImage = pod.resolved_config?.config?.image;
  // A pod that launched on a fallback tier before its full variant was built is still the
  // same runtime: whatever the image lacked (packages, bake layers) ran live at launch and
  // is on its warm disk.
  const compatibleImages = [config.image, ...plan.fallbackRecipes.map((r) => r.ref)];
  if (previousImage !== undefined && !compatibleImages.includes(previousImage)) {
    throw conflict("this launch resolves to a different image");
  }
  // The bake layers re-run (idempotent, like init) when the reused disk's image does not
  // carry the *current* composed script — which is also what catches a bake edit whose
  // digest still resolves to a compatible fallback image.
  const bakeLive =
    plan.bakeScript !== "" &&
    !(plan.imageRecipe.managed && previousImage === plan.imageRecipe.ref);
  if (report.bake) {
    report.bake.mode = bakeLive ? "live" : "baked";
    if (!bakeLive) report.bake.status = "ok";
  }
  if (previousImage !== undefined && previousImage !== config.image) {
    config.image = previousImage;
    report.image.ref = previousImage;
  }
  if (plan.credential === null) {
    throw badRequest(
      `no ${PROVIDER_CREDENTIAL_VARS[providerName] ?? "provider"} credential available for ${providerName}`,
    );
  }

  report.reused = true;
  // Atomic (§7.1): quota check + stopped → provisioning claim commit together under
  // canonical quota locks, so reuse (a wake with a warm disk) cannot overshoot 20 either.
  // Only a stopped pod can be claimed, so a live session or concurrent reuse loses.
  // Resolved outside the transaction: a plan lookup takes no locks and must not
  // borrow a second pool connection while one is held.
  const perUserCap = await edition().perUserPodCap(deps.env, pod.user_id);
  await tx(async (client) => {
    await acquireQuotaLocks(client, pod.org_id, pod.user_id);
    await assertLaunchAllowed(client, pod.user_id);
    await assertQuotaRoomTx(client, {
      orgId: pod.org_id,
      userId: pod.user_id,
      perUserCap,
      // Fresh inside the tx under the locks (P2): pre-tx policy reads are preflight only.
      orgCap: await orgConcurrencyCapTx(client, pod.org_id),
    });
    // Legacy rows may predate pod_retention: backfill the record (with this launch's
    // custody) so timers never fall back to the frozen report again. New rows already
    // have one from provisioning; the insert is a no-op for them.
    await client.query(
      `INSERT INTO pod_retention (pod_id, desired_archive_after_minutes, revision, status, credential_source)
       VALUES ($1, $2, 1, 'pending', $3)
       ON CONFLICT (pod_id) DO NOTHING`,
      [
        pod.id,
        config.archiveAfterMinutes,
        plan.credential?.source === "org-secret" ? "org-secret" : "platform",
      ],
    );
    const claimed = await client.query(
      `UPDATE pods SET provider_state = 'provisioning', provider_state_changed_at = now(),
         state_reason = NULL, resolved_config = $2, updated_at = now()
       WHERE id = $1 AND state = 'active' AND provider_state = 'stopped' RETURNING id`,
      [pod.id, JSON.stringify(report)],
    );
    if ((claimed.rowCount ?? 0) !== 1) throw conflict("pod is not stopped — nothing to reuse");
  });

  // The request's env layers replace the stored ones, so rotated secrets land in the pod.
  await savePodLaunchEnv({ kek: deps.kek, podId: pod.id, layers: launchEnvLayers });

  // The claim is the auditable moment: compute comes back and this launch's secrets land on
  // the warm disk. A fresh launch records pod.launch here; reuse takes no other audited path.
  await audit({
    orgId: pod.org_id,
    actorId: args.userId,
    action: "pod.reuse",
    targetType: "pod",
    targetId: pod.id,
    detail: { provider: providerName, secretKeys: report.secretKeys },
  });

  void provisionReuse(deps, {
    pod,
    providerName,
    providerConfig: config.providers[providerName] ?? {},
    config,
    initSteps,
    bakeScript: bakeLive ? plan.bakeScript : null,
    piSettings,
    piAuth: plan.piAuth,
    credentialContract,
    forbiddenEgressHosts: plan.policy.forbiddenEgressHosts ?? [],
    workdir: plan.workdir,
    report,
  }).catch(async (e) => {
    const message = sanitizeFailureMessage(e);
    deps.log.error(`pod ${pod.id} reuse failed: ${message}`);
    report.warnings.push(`reuse failed: ${message}`);
    await query(
      "UPDATE pods SET provider_state = 'error', provider_state_changed_at = now(), state_reason = $3, resolved_config = $2, updated_at = now() WHERE id = $1",
      [pod.id, JSON.stringify(report), truncate(`reuse failed: ${message}`, 500)],
    ).catch(() => {});
  });

  const fresh = await getPod(args.orgId, pod.id);
  return { pod: fresh, report: fresh.resolved_config };
}

async function provisionReuse(
  deps: PodServiceDeps,
  args: {
    pod: PodRow;
    providerName: string;
    providerConfig: Record<string, unknown>;
    config: PiPodConfig;
    initSteps: Array<{ scope: InitScope; script: string }>;
    bakeScript: string | null;
    piSettings: PlannedPiSettings | null;
    piAuth: { providers: string[] } | null;
    credentialContract: string[];
    forbiddenEgressHosts: string[];
    workdir: string;
    report: ResolvedConfigReport;
  },
): Promise<void> {
  const { pod, config, report } = args;
  await assertLaunchAllowed(undefined, pod.user_id);
  const timings: Record<string, number> = (report.timings ??= {});
  const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      timings[name] = Date.now() - startedAt;
    }
  };

  // Lock only for get (captures the API key). Nothing below starts the sandbox until the
  // egress decision says the recomputed policy is what the provider still enforces.
  // The provider snapshot carries only static capabilities for the shared egress
  // resolver — no credential use escapes the lock window.
  let egressProvider: Pick<SandboxProvider, "name" | "capabilities" | "keepaliveApiHost"> | null =
    null;
  // The atomic claim above wrote the plan's placeholder description (`""`). Restore the
  // committed value when it is recoverable, so a failure below never bricks a good row.
  const restoreFrozenEgressDescription = (): void => {
    const frozen = pod.resolved_config?.egress;
    if (
      typeof frozen?.description === "string" &&
      egressPolicyFromDescription(frozen.description) !== null
    ) {
      report.egress.description = frozen.description;
    }
  };
  // Everything before the egress decision runs inside one restore guard: a transient host
  // wake, handle lookup, env read, or resolve failure must put the committed value back
  // before the outer catch persists the error row — otherwise one blip bricks a good
  // allowlist row into `""` (which only the open heal could recover). Post-start failures
  // never reach this guard with a placeholder: the decision already set a verified string.
  let sandbox: Sandbox;
  let providerName: string;
  let podEnv: Record<string, string>;
  let resolution: Awaited<ReturnType<typeof resolveLaunchEgressPolicy>>["resolution"];
  try {
    // ensurePodHostReady may wake the user's own box (infrastructure the claim already
    // covers); the sandbox itself — user code, exec, init — never runs before the decision.
    await edition().ensurePodHostReady(deps, pod);
    const acquired = await withProviderCredential({
      pod,
      kek: deps.kek,
      platformEnv: platformCredentialsOf(deps),
      orgId: pod.org_id,
      provider: args.providerName,
      providerConfig: args.providerConfig,
      fn: async (provider) => {
        egressProvider = {
          name: provider.name,
          capabilities: provider.capabilities,
          keepaliveApiHost: provider.keepaliveApiHost,
        };
        const sandbox = await provider.get(pod.provider_sandbox_id!, { workdir: args.workdir });
        if (!sandbox) throw new Error("the pod's sandbox no longer exists at the provider");
        return { sandbox, providerName: provider.name };
      },
    });
    sandbox = acquired.sandbox;
    providerName = acquired.providerName;

    // A restarted sandbox loses its creation env on rehydrating providers, so every exec below
    // carries the full resolved environment. This read is database-only: no sandbox I/O yet.
    podEnv = await resolvePodEnv({
      kek: deps.kek,
      podId: pod.id,
      orgId: pod.org_id,
      userId: pod.user_id,
      includeUserLayer: report.layerOrder?.includes("user") ?? true,
      templateId: pod.template_id,
    });
    // Recompute the authoritative egress policy exactly as fresh provisioning does (§6, §13).
    // Unknown/invalid policy throws fail-closed here: the sandbox never starts, nothing runs.
    ({ resolution } = await phase("egress", () =>
      resolveLaunchEgressPolicy({
        config,
        env: podEnv,
        provider: egressProvider!,
        providerConfig: args.providerConfig,
        credentialContract: args.credentialContract,
        piAuth: args.piAuth,
        piSettings: args.piSettings,
        forbiddenEgressHosts: args.forbiddenEgressHosts,
      }),
    ));
  } catch (e) {
    restoreFrozenEgressDescription();
    throw e;
  }
  // Verify-before-start: the description we are about to persist must be what the stopped
  // sandbox actually enforces. No provider offers a stopped-safe policy update, and the
  // gateway only heals a missing callback host — a forbidden derived host or a rotated
  // endpoint it already allows is invisible there — so drift refuses here, before start/exec.
  const frozenEgress = pod.resolved_config?.egress;
  const decision = decideReuseEgress({
    frozenDescription: typeof frozenEgress?.description === "string" ? frozenEgress.description : "",
    frozenMode: typeof frozenEgress?.mode === "string" ? frozenEgress.mode : "",
    recomputedDescription: describePolicy(resolution.policy),
    recomputedMode: resolution.policy.mode,
    configMode: config.egress.mode,
  });
  if (decision.action === "refuse") {
    restoreFrozenEgressDescription();
    report.reuseRefused = decision.reason;
    report.reused = false;
    deps.log.info(`pod ${pod.id} not reused — ${decision.reason}`);
    await query(
      `UPDATE pods SET provider_state = 'stopped', provider_state_changed_at = now(), state_reason = NULL,
         resolved_config = $2, updated_at = now() WHERE id = $1`,
      [pod.id, JSON.stringify(report)],
    );
    return;
  }
  report.egress.description = decision.description;
  report.warnings.push(...resolution.warnings);
  const egressRestricted = decision.egressRestricted;
  await assertLaunchGateOpen();
  await phase("start", () => sandbox.start(START_TIMEOUT_MS));
  const execEnv = {
    ...podEnv,
    ...creationMarkers({
      provider: pod.provider,
      project: pod.name,
      image: config.image,
      createdAtMs: Date.parse(pod.created_at),
      egress: report.egress.description,
    }),
    ...runtimeMarkers(sandbox.id),
  };
  sandbox.rehydrateEnv(execEnv);

  // Per-pod, not per-session: a stale exit code from the previous pi must not be read
  // as this session's status. What is *in* the workspace is the idempotent init
  // scripts' business — they re-run over the warm disk next.
  const refreshScript = ["set -e", `mkdir -p ${shellQuote(args.workdir)}`, `rm -f ${EXIT_CODE_FILE}`].join("\n");
  const refresh = await phase("reuse", () =>
    sandbox.exec(["bash", "-c", refreshScript], { env: execEnv, timeoutMs: 10 * 60 * 1000 }),
  );
  if (refresh.exitCode !== 0) {
    const reason = `it could not be refreshed (exit ${refresh.exitCode})`;
    report.reuseRefused = reason;
    report.reused = false;
    deps.log.info(`pod ${pod.id} not reused — ${reason}`);
    await sandbox.stop(STOP_TIMEOUT_MS).catch(() => {});
    await query(
      `UPDATE pods SET provider_state = 'stopped', provider_state_changed_at = now(), state_reason = NULL,
         resolved_config = $2, updated_at = now() WHERE id = $1`,
      [pod.id, JSON.stringify(report)],
    );
    return;
  }

  try {
    // Fresh borrowed credentials for the new session; the disk copy aged while stopped.
    await phase("auth", () =>
      materializeLaunchCredentialLease({
        kek: deps.kek,
        sandbox,
        execEnv,
        podId: pod.id,
        orgId: pod.org_id,
        userId: pod.user_id,
        credentialContract: args.credentialContract,
        config,
        piSettings: args.piSettings,
      }),
    );
    // Warm shim was already uploaded during the original provision; a reuse restores
    // it if the prolonged stopped interval lost any file (the disk is retained).
    await phase("shim", async () => {
      await uploadShim(sandbox, EXIT_CODE_FILE, config.pi.sessionNaming);
      report.shim = {
        version: SHIM_VERSION,
        launcher: launcherVersion(),
        sessionNaming: config.pi.sessionNaming ?? "auto",
      };
    });

    await runPodInitSteps({
      podId: pod.id,
      sandbox,
      initSteps: args.initSteps,
      bakeScript: args.bakeScript,
      config,
      report,
      execEnv,
      egressRestricted,
      timings,
    });

    await query(
      `UPDATE pods SET provider_state = 'started', provider_state_changed_at = now(), state_reason = NULL,
         resolved_config = $2, last_activity_at = now(), updated_at = now()
       WHERE id = $1`,
      [pod.id, JSON.stringify(report)],
    );
    deps.log.info(`pod ${pod.id} reused (${providerName} ${sandbox.id})`);
    deps.onPodStarted?.(pod.id);
  } catch (e) {
    await sandbox.stop(STOP_TIMEOUT_MS).catch(() => {});
    throw e;
  }
}
