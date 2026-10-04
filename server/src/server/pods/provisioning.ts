import { uploadShim } from "../../core/client/session.js";
import { clientForHost, currentHostUrl, hostById, requireHostAwake } from "./hostidentity.js";
import type { PiPodConfig } from "../../core/config.js";
import { PiPodError } from "../../core/errors.js";
import {
  launcherVersion,
  packageRoot,
  type ImageRecipe,
} from "../../core/image.js";
import {
  BASE_URL_KEYS,
  buildEffectivePolicy,
  buildHostsEntries,
  describePolicy,
  renderHostsFile,
  resolveForProvider,
  type EffectivePolicy,
  type ResolutionResult,
} from "../../core/egress.js";
import {
  EXIT_CODE_FILE,
  buildPiArgv,
  effectiveArchiveAfterMinutes,
  idleTimeoutFor,
} from "../../core/lifecycle.js";
import { buildLabels, creationMarkers, runtimeMarkers } from "../../core/labels.js";
import { loadProviderRegistry, PACKAGE_PROVIDERS, packagesInclude } from "../../core/piregistry.js";
import { PROVIDER_CREDENTIAL_VARS } from "../../core/providers/registry.js";
import type { Sandbox, SandboxProvider } from "../../core/providers/types.js";
import { shellQuote } from "../../core/providers/util.js";
import { SHIM_VERSION } from "../../core/shim/agentd.js";
import { audit } from "../audit.js";
import { query, tx } from "../db/index.js";
import {
  admitLaunchOperationTx,
  type LaunchOperationClaim,
} from "./launch-operations.js";
import { HttpError, badRequest, conflict, serviceUnavailable } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import { credentialProvidersFor, resolveRequiredCredentialProviders } from "../model-credentials/dependencies.js";
import { acquireLease } from "../model-credentials/lease.js";
import {
  materializeCredentialLease,
  persistPodCredentialContract,
} from "../model-credentials/materializer.js";
import { MIN_VALIDITY_MS } from "../model-credentials/refresh.js";
import type { CredentialLease, LeaseFailure } from "../model-credentials/types.js";
import { truncate } from "../push/copy.js";
import { FLEET_UNAVAILABLE_CODE, fleetUnavailableDetail, sanitizeFailureMessage } from "../safe-errors.js";
import { enqueuePush } from "../push/queue.js";
import { resolveInstalledPackages } from "../../core/hostconfig.js";
import {
  installPiSettings,
  installProjectPiSettings,
  type LocalPiSettingsLayers,
  type PlannedPiSettings,
} from "../settings/pi-settings.js";
import { DEFAULT_TEMPLATE_NAME } from "../templates/store.js";
import { acquireQuotaLocks, orgConcurrencyCapTx, assertConcurrencyRoom, assertQuotaRoomTx, countQuota } from "./concurrency.js";
import { edition, ownedHosts } from "../edition.js";
import { OWNED_BOAT_FRESH_DISK_RESERVATION_BYTES } from "./capacity.js";
import { createRetentionRecord } from "./retention-policy.js";
import { inheritForkLaunchIdentity, insertForkSeed, piArgsHaveSessionSteering, type ForkFrom } from "./fork-seed.js";
import { ensureHostedImage } from "./images.js";
import { persistReport, runPodInitSteps } from "./initialization.js";
import { savePodLaunchEnv } from "./launchenv.js";
import { sandboxHostByUrl, typedRefusalDetail } from "./sandboxfleet.js";
import { getSandboxHostBackend } from "./hostbackend/index.js";
import { buildCreateOwner } from "./owner-identity.js";
import { assertLaunchAllowed, assertLaunchGateOpen } from "./launch-control.js";
import {
  assertCreateAttemptOwner,
  assignCreateAttemptTx,
  finishCreateAttemptTx,
  heartbeatCreateAttempt,
  interruptCreateAttemptTx,
  markCreateAttemptDispatchingTx,
  markCreateAttemptFailedSafeTx,
  markCreateAttemptUnknownTx,
  prepareCreateAttemptTx,
  recordObservedSandboxTx,
  type PreparedCreateAttempt,
} from "./create-attempts.js";
import { isAdmissionDetailLike, resolveShape } from "./capacity.js";
import {
  platformSandboxClient,
  lookupOriginalOperation,
  platformToken,
} from "./operations.js";
import {
  cancelCapacityWait,
  capacityWaitConfig,
  capacityWaitDisplay,
  enqueueCapacityWait,
  expiredWaitTerminal,
  finishCapacityWait,
  finishWaitExpired,
  getCapacityWait,
  heartbeatCapacityWait,
  noteWaitAttemptHost,
  recordWaitAttempt,
  tryClaimAttempt,
  waitReprobeDelayMs,
  type CapacityWaitRow,
} from "./capacity-wait.js";
import { requestCpuAllocatorWake } from "../workers/cpu-allocator.js";
import { observeCapacityWait } from "../metrics.js";
import { startAgentdSupervisor } from "./supervisor.js";
import {
  MAX_LINEAGE_DEPTH,
  lockLineageRoot,
  nestedPodsPolicy,
  parentDelegation,
  planChildLineage,
  type LineagePlacement,
} from "./lineage.js";
import { fetchForkSeedFromPod, START_TIMEOUT_MS, STOP_TIMEOUT_MS } from "./lifecycle.js";
import { workspaceSeedGateOpen } from "./workspace-seed.js";
import {
  hostedImageInitialState,
  hostedProviderIdleTimeoutMinutes,
  launchModelProvider,
  piProviderEndpoints,
  planPodLaunch,
  withoutForbiddenEgressHosts,
  type LaunchProject,
  type PiLaunchOverrides,
} from "./planning.js";
import { createPodToken } from "./podtoken.js";
import { platformCredentialsOf, withProviderCredential } from "./providercred.js";
import { observePodLaunch } from "../metrics.js";
import {
  CAPACITY_WAIT_EXPIRED_CODE,
  capacityWaitTerminalDetail,
  describeLaunchFailure,
  recordProvisioningFailure,
  renderCapacityWaitTerminal,
} from "./provision-failure.js";
import { renderPodSkill, SKILL_REMOTE_DIR } from "./skill.js";
import { getPod } from "./store.js";
import { podExtensionSettings } from "./template-brief.js";
import type { InitScope, PodLaunchResult, PodRow, PodServiceDeps, ResolvedConfigReport } from "./types.js";
import { assertLaunchContextSupported, type LaunchContext } from "./launch-context.js";

/** Independent from gateway leases: the API process owns provisioning until a sandbox id exists. */
export const PROVISIONING_HEARTBEAT_MS = 15 * 1000;
/**
 * Keep the API process's background provisioning ownership durable. Gateway heartbeats cannot
 * do this for ordinary launches (which are deliberately unleased) or in split-role deployments.
 * Once a sandbox id is recorded, the provider reconciler can recover it and this heartbeat stops.
 */
export function startProvisioningHeartbeat(
  podId: string,
  deps: Pick<PodServiceDeps, "log">,
  attempt?:
    | Pick<PreparedCreateAttempt, "id" | "ownerToken" | "ownerInstanceId">
    | (() => Pick<PreparedCreateAttempt, "id" | "ownerToken" | "ownerInstanceId"> | null),
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
  const beat = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const currentAttempt = typeof attempt === "function" ? attempt() : attempt;
      if (currentAttempt) {
        const active = await heartbeatCreateAttempt({
          attemptId: currentAttempt.id,
          podId,
          ownerToken: currentAttempt.ownerToken,
          ownerInstanceId: currentAttempt.ownerInstanceId,
        });
        if (!active && (typeof attempt === "function" ? attempt()?.id : attempt?.id) === currentAttempt.id) stop();
        return;
      }
      const active = await query(
        `UPDATE pods SET provisioning_heartbeat_at = now()
         WHERE id = $1 AND state = 'active'
           AND provider_state IN ('preparing_image','provisioning')
           AND provider_sandbox_id IS NULL
         RETURNING id`,
        [podId],
      );
      if ((active.rowCount ?? 0) === 0) stop();
    } catch (e) {
      // Heartbeat failures are almost always DB blips, but the message still crosses the
      // log boundary sanitized — the helper is cheap and unconditional beats "usually safe".
      deps.log.warn(sanitizeFailureMessage(e, { prefix: `pod ${podId} provisioning heartbeat failed` }));
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void beat(), PROVISIONING_HEARTBEAT_MS);
  timer.unref();
  return stop;
}

function credentialRequiredBy(
  providerId: string,
  modelProvider: string,
  packages: readonly string[],
): string {
  if (modelProvider && credentialProvidersFor(modelProvider).includes(providerId)) {
    return modelProvider;
  }
  for (const entry of PACKAGE_PROVIDERS) {
    if (!entry.credentialProviders?.includes(providerId)) continue;
    if (!packagesInclude(packages, entry.package)) continue;
    return entry.providers[0] ?? entry.package;
  }
  return providerId;
}

function throwIfRequiredLeaseBlocked(
  required: readonly string[],
  lease: CredentialLease,
  failures: Record<string, LeaseFailure>,
  modelProvider: string,
  packages: readonly string[],
): void {
  for (const providerId of required) {
    const failure = failures[providerId];
    if (!failure) continue;
    if (failure.state === "reconnect_required") {
      const reason = failure.reason ? ` (${failure.reason})` : "";
      throw conflict("credential_reconnect_required", {
        code: "credential_reconnect_required",
        message: `Reconnect the ${providerId} account credential${reason}.`,
        provider: providerId,
        requiredBy: credentialRequiredBy(providerId, modelProvider, packages),
      });
    }
    if (failure.state === "temporarily_unavailable" && lease.providers[providerId] === undefined) {
      throw serviceUnavailable("credential_temporarily_unavailable", {
        code: "credential_temporarily_unavailable",
        message: `The ${providerId} account credential is temporarily unavailable.`,
        provider: providerId,
        retryable: true,
      });
    }
  }
}

/**
 * Persist the pod contract, acquire a sanitized lease, and write it before Pi starts.
 * Required reconnect/transient failures throw typed codes so the existing provision/reuse
 * path records them in state_reason. Empty leases are still materialized.
 */
export async function materializeLaunchCredentialLease(args: {
  kek: PodServiceDeps["kek"];
  sandbox: Sandbox;
  execEnv: Record<string, string>;
  podId: string;
  orgId: string;
  userId: string;
  credentialContract: readonly string[];
  config: PiPodConfig;
  piSettings: PlannedPiSettings | null;
}): Promise<void> {
  const contract = [...args.credentialContract];
  await persistPodCredentialContract(args.podId, contract);
  const modelProvider = launchModelProvider(args.config, args.piSettings) ?? "";
  const packages = args.piSettings?.plan.packages ?? [];
  const required = resolveRequiredCredentialProviders({ modelProvider, packages }).filter(
    (id) => id.length > 0,
  );
  const { lease, failures } = await acquireLease(
    args.kek,
    { orgId: args.orgId, userId: args.userId },
    contract,
    MIN_VALIDITY_MS,
  );
  throwIfRequiredLeaseBlocked(required, lease, failures, modelProvider, packages);
  await materializeCredentialLease(args.sandbox, lease, args.execEnv);
}

export interface HostedImageSelection {
  recipe: ImageRecipe;
  /** Already materialized in the provider cache/account. */
  present: boolean;
}

/**
 * Pick the best exact-enough recipe already visible to the provider before a pod row exists.
 * For mirror-backed providers `resolveImage` maps managed tags to the local mirrored-cache key;
 * authenticated remote existence remains deployment-owned because production's GHCR is private.
 */
export async function selectHostedImageCandidate(args: {
  provider: SandboxProvider;
  recipe: ImageRecipe;
  fallbackRecipes: readonly ImageRecipe[];
  imagePresent: boolean;
}): Promise<HostedImageSelection> {
  if (args.imagePresent) return { recipe: args.recipe, present: true };
  if (args.recipe.managed) {
    for (const candidate of args.fallbackRecipes) {
      if (await args.provider.resolveImage(candidate.ref)) {
        return { recipe: candidate, present: true };
      }
    }
  }
  return { recipe: args.recipe, present: false };
}
export async function launchPod(
  deps: PodServiceDeps,
  args: {
    orgId: string;
    userId: string;
    launchContext?: LaunchContext;
    /** False only for organization-scoped jobs, which launch without the owner's bundle. */
    includeUserBundle?: boolean;
    templateId?: string | null;
    project?: LaunchProject | null;
    piSettingsRaw?: LocalPiSettingsLayers | null;
    legacyLaunchInputsPresent?: boolean;
    provider?: string | null;
    piOverrides?: PiLaunchOverrides | null;
    /** Set when a pod token asked for this launch: the child records it as its parent. */
    parentPodId?: string | null;
    /** Preassign a scheduled launch to the gateway executing it, preventing another gateway
     * from winning the lease before the job prompt is delivered. */
    gatewayId?: string | null;
    /** Fork the current session of this source pod into the new one. */
    forkFrom?: ForkFrom | null;
    /**
     * The client intends to seed the workdir (clone or archive) right after provisioning.
     * Pi is held back until the seed completes, is skipped, or the gate times out, so the
     * first session sees the seeded AGENTS.md and .pi/ rather than an empty directory.
     */
    workspaceSeed?: boolean;
    /** Client launch identity; admission commits atomically with the pod row. */
    launchOperation?: LaunchOperationClaim;
  },
): Promise<PodLaunchResult> {
  assertLaunchContextSupported(args.launchContext);
  await assertLaunchAllowed(undefined, args.userId);
  const planStartedAt = Date.now();
  let launchTemplateId = args.templateId ?? null;
  let launchProject = args.project ?? null;
  let forkSource: PodRow | null = null;
  if (args.forkFrom) {
    forkSource = await getPod(args.orgId, args.forkFrom.podId);
    const inherited = inheritForkLaunchIdentity({
      templateId: launchTemplateId,
      project: launchProject,
      source: forkSource,
      emptyProject: (name) => ({ name, config: {}, env: {}, initScript: "", bakeScript: "" }),
    });
    launchTemplateId = inherited.templateId;
    launchProject = inherited.project;
  }
  const delegation = args.parentPodId
    ? await parentDelegation({ query }, { orgId: args.orgId, parentPodId: args.parentPodId })
    : null;
  const plan = await planPodLaunch(deps, { ...args, launchContext: args.launchContext,
    templateId: launchTemplateId, project: launchProject, delegation });
  if (forkSource && piArgsHaveSessionSteering(plan.config.pi.args)) {
    throw badRequest(
      "cannot fork into a pod whose Pi config already chooses a session (--resume, --continue, --fork, --session, or --no-session)",
    );
  }
  const {
    template, project, config, imageRecipe, clamps, policy, providerName, podName, workdir,
    podEnv, launchEnvLayers, initSteps, piAuth, piSettings, credentialContract, report,
  } = plan;


  // Fail before the pod row exists: in account mode the provider key is server-custodied,
  // so a missing one used to surface only as an async "provisioning failed" on a pod that
  // could never start. The same check runs in planPodLaunch for the resolve endpoint.
  if (!plan.credential) {
    throw badRequest(
      `no ${providerName} credential`,
      `store an org secret named ${PROVIDER_CREDENTIAL_VARS[providerName]} or set it in the server environment`,
    );
  }
  // Captured outside the insert closure (narrowing does not persist into it): immutable
  // launch fact for the retention record's custody scoping.
  const launchCustody = plan.credential.source === "org-secret" ? "org-secret" as const : "platform" as const;
  (report.timings ??= {}).plan = Date.now() - planStartedAt;

  // The concurrency count and provider image lookup are independent. The provider call is
  // often the slower one, so overlap the database round-trip with it. This preflight is a
  // fast fail only — the authoritative check runs atomically with the insert below (§7.1),
  // because two simultaneous launches would both pass a preflight count and overshoot 20.
  const dedicatedBoat = ownedHosts(deps.env)
    && providerName === "sandbox"
    && plan.sandboxHostId == null;
  const preflightStartedAt = Date.now();
  const [imageSelection, preflightQuota] = await Promise.all([
    dedicatedBoat
      ? Promise.resolve({ recipe: imageRecipe, present: false })
      : withProviderCredential({
          sandboxHostId: plan.sandboxHostId,
          ownerUserId: args.userId,
          kek: deps.kek,
          platformEnv: platformCredentialsOf(deps),
          orgId: args.orgId,
          provider: providerName,
          providerConfig: config.providers[providerName] ?? {},
          fn: async (provider) =>
            selectHostedImageCandidate({
              provider,
              recipe: imageRecipe,
              fallbackRecipes: plan.fallbackRecipes,
              imagePresent: Boolean(await provider.resolveImage(imageRecipe.ref)),
            }),
        }),
    countQuota(args.orgId, args.userId),
  ]);
  report.timings.preflight = Date.now() - preflightStartedAt;
  // New pod work: a reached cap refuses it even while the owner's host runs, and the new
  // workspace reserves a full per-pod disk shape on top of attested usage. Owned hosts admit
  // sparse images: charge the qualified fresh-image reservation, not the filesystem ceiling,
  // or a 60 GiB workspace is refused while almost empty.
  const storageReservation = ownedHosts(deps.env)
    ? OWNED_BOAT_FRESH_DISK_RESERVATION_BYTES
    : config.resources.diskGB * 1024 ** 3;
  await edition().admitPodWork(deps.env, args.userId, storageReservation);
  // Preflight uses the global user budget (all orgs) plus the org aggregate. A pass here
  // guarantees nothing; the tx below re-counts under advisory locks and is final.
  const perUserCap = await edition().perUserPodCap(deps.env, args.userId);
  assertConcurrencyRoom({
    awakeForUser: preflightQuota.globalUser,
    awakeForOrg: preflightQuota.org,
    perUserCap,
    orgCap: policy.maxConcurrentPods,
  });

  // Lineage caps bound one tree's share of the awake pods for pod-launched pods. Checking here
  // refuses a runaway supervisor before any provisioning happens; the same check runs again
  // under the insert's lineage lock, which is what makes two simultaneous child launches safe.
  const nested = nestedPodsPolicy(policy);
  if (args.parentPodId) {
    await planChildLineage({ query }, { orgId: args.orgId, parentPodId: args.parentPodId, policy: nested });
  }

  // A missing packaged image can launch on the best locally cached sibling. For sandbox this
  // is the mirrored base tag; runtime package install and live bake cover the stripped layers.
  // A provider that can prepare the full variant — by building it, or by pulling that exact tag
  // from its mirror — warms it behind the launch; a mirror that does not carry the derived tag
  // just logs the miss and leaves the next launch on the same fallback.
  const effectiveRecipe = imageSelection.recipe;
  const effectivePresent = imageSelection.present;
  const shouldWarmDerivedImage =
    effectiveRecipe.ref !== imageRecipe.ref && plan.imageBuildable && imageRecipe.managed;
  if (effectiveRecipe.ref !== imageRecipe.ref) {
    config.image = effectiveRecipe.ref;
    report.image.ref = effectiveRecipe.ref;
    report.image.provenance = effectiveRecipe.provenance;
    report.image.assetDigest = effectiveRecipe.assetDigest;
  }

  // The bake layers run live in the pod when the image booting this launch does not carry
  // them: a fallback tier, or a custom pin pi pod does not rebuild. Same script, same
  // constraints (no secrets, cwd outside the workspace) — only the caching differs.
  const bakeLive =
    plan.bakeScript !== "" &&
    !(effectiveRecipe.managed && effectiveRecipe.bakeScript === plan.bakeScript);
  if (report.bake) {
    report.bake.mode = bakeLive ? "live" : "baked";
    if (!bakeLive) report.bake.status = "ok";
  }

  const initialProviderState = hostedImageInitialState(
    effectiveRecipe,
    effectivePresent,
    providerName,
    plan.imageBuildable,
  );
  report.image.status = effectivePresent ? "ready" : "preparing";

  if (args.workspaceSeed) {
    if (args.forkFrom) throw badRequest("a forked pod inherits its workspace and cannot be seeded");
    report.workspaceSeed = { status: "pending", requestedAt: new Date().toISOString() };
  }

  let forkSeed: { sourcePodId: string; sourcePath: string; content: Buffer } | null = null;
  if (forkSource && args.forkFrom) {
    const read = await fetchForkSeedFromPod(deps, forkSource, args.forkFrom.sessionPath, args.userId);
    forkSeed = { sourcePodId: forkSource.id, ...read };
  }

  if (!deps.env.PUBLIC_URL) {
    throw new Error("PUBLIC_URL is required so pods can dial the gateway");
  }

  const podId = uuidv7();
  const initialHost = plan.sandboxHostId ? await hostById(plan.sandboxHostId) : null;
  if (plan.sandboxHostId && !initialHost) throw conflict("launch host registration is missing");
  let createAttempt: PreparedCreateAttempt | null = null;

  // The quota reservation, the child's placement, and the row write happen in one
  // transaction in canonical lock order (org quota, user quota, lineage root): the final
  // count/check/reservation is atomic with launch acceptance (§7.1). Provider I/O stays
  // outside — preflight above overlapped it, and provisioning below runs after commit.
  await tx(async (client) => {
    await acquireQuotaLocks(client, args.orgId, args.userId);
    await assertQuotaRoomTx(client, {
      orgId: args.orgId,
      userId: args.userId,
      perUserCap,
      // Re-read inside the tx under the locks: a concurrent policy tightening between
      // planning and this commit must not be admitted under (P2 freshness).
      orgCap: await orgConcurrencyCapTx(client, args.orgId),
    });
    let placement: LineagePlacement | null = null;
    if (args.parentPodId) {
      await lockLineageRoot(client, { orgId: args.orgId, parentPodId: args.parentPodId });
      placement = await planChildLineage(client, {
        orgId: args.orgId,
        parentPodId: args.parentPodId,
        policy: nested,
      });
    }
    await client.query(
      `INSERT INTO pods (id, org_id, template_id, user_id, name, provider, state, provider_state, resolved_config, project, gateway_id, gateway_heartbeat_at, provisioning_heartbeat_at, parent_pod_id, lineage_root_id, lineage_depth, forked_from_pod_id, transport, sandbox_host_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, CASE WHEN $10::text IS NULL THEN NULL ELSE now() END, now(), $11, COALESCE($12::uuid, $1::uuid), $13, $14, $15, $16)`,
      [
        podId,
        args.orgId,
        template?.id ?? null,
        args.userId,
        podName,
        providerName,
        initialProviderState,
        JSON.stringify(report),
        project?.name ?? null,
        args.gatewayId ?? null,
        placement?.parentPodId ?? null,
        placement?.lineageRootId ?? null,
        placement?.lineageDepth ?? 0,
        forkSeed?.sourcePodId ?? null,
        "ws",
        plan.sandboxHostId,
      ],
    );
    if (providerName === "sandbox") {
      createAttempt = await prepareCreateAttemptTx(client, {
        podId,
        orgId: args.orgId,
        userId: args.userId,
        provider: "sandbox",
        hostId: plan.sandboxHostId ?? null,
        hostGeneration: initialHost?.generation ?? null,
        runtimeBootId: initialHost?.runtime_boot_id ?? null,
        hostUrl: typeof config.providers.sandbox?.url === "string" ? config.providers.sandbox.url : null,
      });
    }
    // Effective retention record in the same transaction as the pod insert (§3.2):
    // legacy rows without a record fall back to the launch report; new rows never do.
    // Immutable launch fact: which custody funded the pod. The reconciler scopes the
    // deployment maximum from this instead of decrypting org secrets per row.
    await createRetentionRecord(client, {
      podId,
      desiredMinutes: config.archiveAfterMinutes,
      credentialSource: launchCustody,
    });
    if (forkSeed) {
      await insertForkSeed(client, {
        podId,
        sourcePodId: forkSeed.sourcePodId,
        sourcePath: forkSeed.sourcePath,
        content: forkSeed.content,
      });
    }
    if (args.launchOperation) {
      await admitLaunchOperationTx(client, args.launchOperation, podId);
    }
  });
  if (providerName === "sandbox" && !createAttempt) {
    throw new Error("sandbox launch has no durable create-attempt record");
  }
  // The create-attempt lease starts at admission. Dedicated-boat startup can wait
  // minutes before provision() installs its own heartbeat. Renew the lease across
  // that gap so recovery does not abort a launch that still has an owner.
  const stopPreparingHeartbeat = createAttempt
    ? startProvisioningHeartbeat(podId, deps, createAttempt)
    : () => {};
  try {
  if (dedicatedBoat) await edition().ensureDedicatedPodHost(deps, args.userId, podId);
  if (shouldWarmDerivedImage) {
    warmDerivedImage(deps, {
      sandboxHostId: plan.sandboxHostId,
      ownerUserId: args.userId,
      orgId: args.orgId,
      providerName,
      providerConfig: config.providers[providerName] ?? {},
      recipe: imageRecipe,
      resources: config.resources,
    });
  }
  observePodLaunch(providerName, "accepted");
  try {
    await deps.onPodCreated?.(podId);
  } catch (e) {
    // Warnings travel to the client in resolved_config and to state_reason via the failure
    // recorder, so the provider-facing message is sanitized at construction, not at render.
    const message = sanitizeFailureMessage(e, { prefix: "launch registration failed" });
    report.warnings.push(message);
    await recordProvisioningFailure({
      podId,
      orgId: args.orgId,
      userId: args.userId,
      report,
      message,
    }).catch(() => null);
    throw e;
  }
  // Persist resume custody, mint identity, and record the audit entry concurrently. None of
  // these independent writes needs to delay another, but all finish before provisioning can
  // expose a stoppable sandbox.
  const [podToken] = await Promise.all([
    createPodToken({ podId, orgId: args.orgId, userId: args.userId }),
    savePodLaunchEnv({ kek: deps.kek, podId, layers: launchEnvLayers }),
    audit({
      orgId: args.orgId,
      actorId: args.userId,
      action: "pod.launch",
      targetType: "pod",
      targetId: podId,
      detail: {
        template: template?.id ?? (project ? `project:${project.name}` : DEFAULT_TEMPLATE_NAME),
        provider: providerName,
        secretKeys: report.secretKeys,
        clamps,
        ...(args.parentPodId ? { fromPod: args.parentPodId } : {}),
        ...(forkSeed ? { forkedFromPodId: forkSeed.sourcePodId, sourcePath: forkSeed.sourcePath } : {}),
      },
    }),
    ...(forkSeed
      ? [
          audit({
            orgId: args.orgId,
            actorId: args.userId,
            action: "pod.fork",
            targetType: "pod",
            targetId: podId,
            detail: { sourcePodId: forkSeed.sourcePodId, sourcePath: forkSeed.sourcePath },
          }),
        ]
      : []),
  ]).catch(async (e) => {
    const message = sanitizeFailureMessage(e, { prefix: "launch custody setup failed" });
    report.warnings.push(message);
    await recordProvisioningFailure({
      podId,
      orgId: args.orgId,
      userId: args.userId,
      report,
      message,
    }).catch(() => null);
    throw e;
  });

  // Provisioning continues in the background: a phone should not hold an HTTP request open
  // for a provision + init that can take minutes. Clients watch GET /pods/:id.
  // The background task owns the pre-provision heartbeat once it is scheduled.
  void ((async () => {
    try {
    let recipeForProvision = effectiveRecipe;
    let presentForProvision = effectivePresent;
    let providerConfigForProvision = config.providers[providerName] ?? {};
    if (dedicatedBoat) {
      const deadline = Date.now() + 30 * 60_000;
      let ready = await hostById((await query<{ sandbox_host_id: string | null }>(
        "SELECT sandbox_host_id FROM pods WHERE id=$1", [podId])).rows[0]?.sandbox_host_id ?? "");
      while (!ready || ready.boat_state !== "running") {
        if (Date.now() > deadline) throw serviceUnavailable("this pod's boat did not become ready", {
          kind: "admission", reason: "host_starting", resource: "transitions", unit: "count", retryable: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        ready = await hostById(ready?.id ?? "");
        if (!ready) {
          ready = await hostById((await query<{ sandbox_host_id: string | null }>(
            "SELECT sandbox_host_id FROM pods WHERE id=$1", [podId])).rows[0]?.sandbox_host_id ?? "");
        }
      }
      requireHostAwake(ready);
      providerConfigForProvision = { ...providerConfigForProvision, url: currentHostUrl(ready) };
      config.providers[providerName] = providerConfigForProvision;
      const selection = await withProviderCredential({
        sandboxHostId: ready.id,
        ownerUserId: args.userId,
        kek: deps.kek,
        platformEnv: platformCredentialsOf(deps),
        orgId: args.orgId,
        provider: providerName,
        providerConfig: providerConfigForProvision,
        fn: async (provider) => selectHostedImageCandidate({
          provider,
          recipe: imageRecipe,
          fallbackRecipes: plan.fallbackRecipes,
          imagePresent: Boolean(await provider.resolveImage(imageRecipe.ref)),
        }),
      });
      recipeForProvision = selection.recipe;
      presentForProvision = selection.present;
      if (selection.recipe.ref !== config.image) {
        config.image = selection.recipe.ref;
        report.image.ref = selection.recipe.ref;
        report.image.provenance = selection.recipe.provenance;
        report.image.assetDigest = selection.recipe.assetDigest;
      }
      await query("UPDATE pods SET resolved_config=$2, updated_at=now() WHERE id=$1", [podId, JSON.stringify(report)]);
    }
    // provision() installs its heartbeat synchronously, before its first await.
    const provisioning = provision(deps, {
    podId,
    orgId: args.orgId,
    userId: args.userId,
    podName,
    providerName,
    providerConfig: providerConfigForProvision,
    config,
    imageRecipe: recipeForProvision,
    imageKnownPresent: presentForProvision,
    report,
    initSteps,
    bakeScript: bakeLive ? plan.bakeScript : null,
    piAuth,
    piSettings,
    credentialContract,
    forbiddenEgressHosts: policy.forbiddenEgressHosts ?? [],
    deferSupervisor: Boolean(forkSeed) || Boolean(args.workspaceSeed),
    hostPlacedByPlan: plan.hostPlacedByPlan ?? false,
    createAttempt: createAttempt ?? undefined,
    env: {
      ...podEnv,
      PI_POD_SERVER_URL: deps.env.PUBLIC_URL ?? "",
      PI_POD_SERVER_TOKEN: podToken,
      PI_POD_SERVER_POD_ID: podId,
    },
    });
    stopPreparingHeartbeat();
    await provisioning;
    } finally {
      stopPreparingHeartbeat();
    }
  })().catch(async (e) => {
    // Background launch errors never pass through the Fastify error handler, so this is
    // the 500 boundary for provisioning: one sanitized string for the log, the warnings
    // row the client polls, state_reason, and the push body below. The waiter's typed
    // final-deadline throw is recognized here and keeps its code; so does a host
    // admission refusal, whose validated numbers say what to change. Everything else
    // is genericized exactly as before.
    const terminal = capacityWaitTerminalDetail(e);
    const { message, code } = terminal
      ? { message: renderCapacityWaitTerminal(terminal), code: terminal.code as string | null }
      : describeLaunchFailure(e);
    deps.log.error(`pod ${podId} provisioning failed: ${message}`);
    report.warnings.push(`provisioning failed: ${message}`);
    if (report.image.status === "preparing") report.image.status = "failed";
    const failedState = await recordProvisioningFailure({
      podId,
      orgId: args.orgId,
      userId: args.userId,
      report,
      message,
      code,
    }).catch(() => null);
    // If abandonment or a user lifecycle action won the state transition, preserve its reason
    // and notification. In particular, never resurrect or double-report an abandoned launch.
    if (!failedState || failedState === "recovery_required") return;
    // A launch that dies while the user is away is exactly when a push matters most.
    await enqueuePush(args.userId, {
      title: report.notificationsRedacted ? "pod launch failed" : `pod launch failed: ${podName}`,
      body: report.notificationsRedacted ? "" : truncate(message),
      data: { pod_id: podId, org_id: args.orgId, kind: "pod_error" },
    }).catch(() => {});
  }));
  } catch (error) {
    stopPreparingHeartbeat();
    throw error;
  }

  const pod = await getPod(args.orgId, podId);
  return { pod, report: pod.resolved_config };
}
/**
 * Prepare the packaged image variant behind a launch that fell back to the base image, so the
 * next launch with the same package set boots with everything already installed. Build-capable
 * providers build it; mirror-backed ones try to pull it. The image_builds lease dedupes
 * concurrent preparers; failure only costs the fast path.
 */
function warmDerivedImage(
  deps: PodServiceDeps,
  args: {
    sandboxHostId: string | null;
    ownerUserId: string;
    orgId: string;
    providerName: string;
    providerConfig: Record<string, unknown>;
    recipe: Extract<ImageRecipe, { managed: true }>;
    resources: PiPodConfig["resources"];
  },
): void {
  deps.log.info(
    `preparing derived image ${args.recipe.ref} in the background ` +
      `(${args.recipe.packages.length} pi package(s)${args.recipe.bakeScript ? ", bake script" : ""})`,
  );
  void assertLaunchGateOpen().then(() => withProviderCredential({
    sandboxHostId: args.sandboxHostId,
    ownerUserId: args.ownerUserId,
    kek: deps.kek,
    platformEnv: platformCredentialsOf(deps),
    orgId: args.orgId,
    provider: args.providerName,
    providerConfig: args.providerConfig,
    fn: (provider, credentialScope) =>
      ensureHostedImage({
        credentialScope,
        provider,
        recipe: args.recipe,
        resources: args.resources,
        assetRoot: packageRoot(),
      }),
  }))
    .then(() => deps.log.info(`derived image ${args.recipe.ref} is ready`))
    .catch((e) =>
      deps.log.warn(
        sanitizeFailureMessage(e, { prefix: `derived image ${args.recipe.ref} build failed` }),
      ),
    );
}

/**
 * A create failed in a way another host may legitimately be tried for (§6.5):
 * a confirmed pre-allocation refusal (507 capacity, 400 unsupported_shape on a
 * mixed fleet) or a confirmed safe terminal operation status. Carries the
 * refusal for the wait/error path when the fleet is walked. Anything else —
 * ambiguous transport, quarantined operations, key conflicts — never becomes
 * one of these: those throw their typed error straight through.
 */
class FailoverNeeded extends Error {
  constructor(
    readonly refusal: FleetRefusal | null,
  ) {
    super("failover to another sandbox host");
    this.name = "FailoverNeeded";
  }
}

/**
 * A normalized placement/create refusal: the error to report, whether a
 * bounded wait may converge it, and the validated detail to record on the
 * wait row (validated numbers/enums only — safe for client surfaces).
 */
export interface FleetRefusal {
  error: unknown;
  retryable: boolean;
  detail?: Record<string, unknown>;
}

/** Normalize any placement/create refusal to a wait/display record. */
export function toRefusal(error: unknown): FleetRefusal {
  // Placement-thrown errors carry server-constructed admission details
  // (validated by construction): honor their retryability directly. This
  // is what makes fleet-full placement wait-eligible while shape, floor,
  // legacy, malformed, and mismatch refusals fail fast.
  if (error instanceof HttpError && isAdmissionDetailLike(error.detail)) {
    const placementDetail = error.detail;
    // Shape and floor-accounting refusals need request or operator changes,
    // never a 60s queue: force non-retryable regardless of the flag.
    if (
      placementDetail.reason === "unsupported_shape" ||
      placementDetail.reason === "unsupported_admission"
    ) {
      return { error, retryable: false, detail: placementDetail };
    }
    return { error, retryable: placementDetail.retryable, detail: placementDetail };
  }
  const detail = typedRefusalDetail(error);
  const reason = detail?.["reason"] as string | undefined;
  if (reason === "unsupported_shape" || reason === "unsupported_admission") {
    return { error, retryable: false, detail };
  }
  if (detail?.["kind"] === "admission") {
    return { error, retryable: (detail["retryable"] as boolean) !== false, detail };
  }
  if (error instanceof PiPodError && error.status === 507) {
    // Legacy host refusal without typed detail: fail over (existing behavior),
    // and wait — pressure, not shape, is what 507 has always meant.
    return { error, retryable: true, detail };
  }
  return { error, retryable: false, detail };
}

/**
 * What a mid-wait re-probe records for its refusal (2026-09-08: a mid-wait
 * `fleet_unavailable` from `placeFresh` recorded the enqueue reason with a
 * null detail, clobbering the previously recorded admission numbers — the
 * expiry terminal then blamed pressure the fleet never reported).
 *
 * A mid-wait fleet outage is evidence, not absence of it: record the
 * validated `fleet_unavailable` refusal (reason + detail) so an expiry that
 * lands while the fleet is unreachable says so. Any other refusal without
 * typed detail keeps the row's last recording instead of clobbering it.
 * Pure (unit-tested); the wait loop writes the returned record.
 */
export function midWaitAttemptRecord(args: {
  enqueueReason: string;
  row: { reason: string | null; detail: Record<string, unknown> | null };
  placeError: unknown;
}): { reason: string | null; detail: Record<string, unknown> | null } {
  const fleet = fleetUnavailableDetail(args.placeError);
  if (fleet !== null) {
    return {
      reason: FLEET_UNAVAILABLE_CODE,
      detail: { kind: "fleet", ...fleet },
    };
  }
  const refusal = toRefusal(args.placeError);
  if (refusal.detail !== undefined) {
    return {
      reason:
        (refusal.detail["reason"] as string | undefined) ?? args.row.reason ?? args.enqueueReason,
      detail: refusal.detail,
    };
  }
  return { reason: args.row.reason ?? args.enqueueReason, detail: args.row.detail };
}

/**
 * Fold a failed re-placement after a host refusal into the wait/throw
 * decision (W12, §6.6).
 *
 * A re-placement that fails WITHOUT typed admission detail — the
 * walk-exhausted "every active sandbox host refused" once the only host
 * is excluded, an unreachable fleet, the single-mode fallback — is an
 * artifact of having no host left to ask, not new evidence. It must never
 * override a held retryable host refusal: on 2026-09-07 exactly this
 * override turned a wait-eligible 507 `fairness_degraded` into an
 * immediate untyped 503 with no wait row. The held refusal stays the
 * wait's reason, and the wait's full-fleet re-probes converge it once the
 * allocator issues the bootstrap grant.
 *
 * Typed re-placement refusals (shape, floor, legacy, mismatch — fail-fast
 * evidence the wait cannot change) still throw immediately, as does an
 * untyped failure with nothing wait-eligible held.
 */
export function resolveWalkExhaustion(
  held: FleetRefusal | null,
  placeError: unknown,
): { action: "wait"; refusal: FleetRefusal } | { action: "throw"; error: unknown } {
  const fresh = toRefusal(placeError);
  if (fresh.retryable) return { action: "wait", refusal: fresh };
  const freshEvidence = placeError instanceof HttpError && isAdmissionDetailLike(placeError.detail);
  if (held?.retryable && !freshEvidence) return { action: "wait", refusal: held };
  return { action: "throw", error: fresh.error };
}

async function provision(
  deps: PodServiceDeps,
  args: {
    podId: string;
    orgId: string;
    userId: string;
    podName: string;
    providerName: string;
    providerConfig: Record<string, unknown>;
    config: PiPodConfig;
    imageRecipe: ImageRecipe;
    /** The launch preflight just observed this image; do not repeat that provider call. */
    imageKnownPresent: boolean;
    report: ResolvedConfigReport;
    initSteps: Array<{ scope: InitScope; script: string }>;
    /** Composed bake script to run live before init, or null when baked in (or absent). */
    bakeScript: string | null;
    /** Stored account credential provider ids (§7), or null. Never logged. */
    piAuth: { providers: string[] } | null;
    /** Validated request-local or template-owned Pi settings to install. Never logged. */
    piSettings: PlannedPiSettings | null;
    /** Server-maintained set of account credential providers this pod may lease. */
    credentialContract: string[];
    /** Org-denied hosts remain denied when Pi auth/settings derive provider endpoints. */
    forbiddenEgressHosts: string[];
    /** Fork seed staging belongs to attach, so provisioning must not race-start Pi. */
    deferSupervisor: boolean;
    /**
     * True when the sandbox URL was fleet-placed at plan time (not explicit).
     * With the capacity wait enabled, provisioning re-places authoritatively.
     */
    hostPlacedByPlan: boolean;
    /** Durable, owner-fenced provider-create intent committed with the pod row. */
    createAttempt?: PreparedCreateAttempt;
    /** Full pod env: secrets, default services, and the pod identity (§8.5). Never logged. */
    env: Record<string, string>;
  },
): Promise<void> {
  const { config, report } = args;
  const isSandboxLaunch = args.providerName === "sandbox";
  if (isSandboxLaunch && !args.createAttempt) {
    throw new Error("sandbox provisioning is missing its durable create-attempt record");
  }
  let createAttempt = args.createAttempt;
  const createOwner = isSandboxLaunch ? buildCreateOwner({ userId: args.userId }) : undefined;
  let stopProvisioningHeartbeat = startProvisioningHeartbeat(
    args.podId,
    deps,
    () => createAttempt ?? null,
  );
  const waitCfg = capacityWaitConfig(deps.env);
  const waitEnabled = isSandboxLaunch && waitCfg.enabled;
  // Platform token once, from the boot snapshot: every host call below
  // (operation lookup/cancel) must survive BYO credential overlays.
  const bootToken = platformToken(deps.env);
  // Queryable facade over the shared pool for wait-queue writes outside tx.
  const dbq = { query: (text: string, params?: unknown[]) => query(text, params ?? []) };
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  /** Observe the original attempt by its durable key. This path is GET-only. */
  const resolveCreateOutcome = async (
    provider: SandboxProvider,
    providerConfig: Record<string, unknown>,
    attemptedHostId: string | null,
    createError: unknown,
  ): Promise<Sandbox> => {
    const attempt = createAttempt;
    if (!createOwner || !attempt?.operationKey) throw createError;
    const statusCode = createError instanceof PiPodError ? createError.status : undefined;
    const causeCode = (createError as { cause?: { code?: unknown } })?.cause?.code;
    const detail = typedRefusalDetail(createError);
    const unsupported =
      statusCode === 400 &&
      ((detail?.["reason"] as string | undefined) === "unsupported_shape" || causeCode === "unsupported_shape");
    const markSafe = async (reasonCode: string): Promise<void> =>
      tx((client) => markCreateAttemptFailedSafeTx(client, {
        attemptId: attempt.id,
        ownerToken: attempt.ownerToken,
        ownerInstanceId: attempt.ownerInstanceId,
        orgId: args.orgId,
        userId: args.userId,
        reasonCode,
      }));
    const markUnknown = async (): Promise<void> => {
      await tx((client) => markCreateAttemptUnknownTx(client, {
        attemptId: attempt.id,
        ownerToken: attempt.ownerToken,
        ownerInstanceId: attempt.ownerInstanceId,
        orgId: args.orgId,
        userId: args.userId,
        reasonCode: "original_outcome_unknown",
        observedAt: true,
        clearOwner: true,
      }));
      await audit({
        orgId: args.orgId,
        actorId: args.userId,
        action: "pod.create_unresolved",
        targetType: "pod",
        targetId: args.podId,
        detail: { reason: "original_outcome_unknown" },
      }).catch(() => {});
    };
    if (unsupported) {
      // This host response is an explicit pre-allocation shape refusal; it is
      // safe to use a fresh key on another host, never the old key again.
      await markSafe("unsupported_shape");
      throw new FailoverNeeded({
        error: createError,
        retryable: false,
        ...(detail === undefined ? {} : { detail }),
      });
    }

    const url = providerConfig["url"];
    const deadline = Date.now() + 90_000;
    for (;;) {
      let lookup: Awaited<ReturnType<typeof lookupOriginalOperation>> = {
        status: null,
        fetchError: { code: "transport" },
      };
      try {
        const observedHost = attemptedHostId ? await hostById(attemptedHostId) : null;
        if (attemptedHostId && !observedHost) throw serviceUnavailable("original host registration unavailable");
        if (observedHost) requireHostAwake(observedHost);
        const client = attemptedHostId
          ? await clientForHost(attemptedHostId, deps.kek, bootToken)
          : typeof url === "string" ? platformSandboxClient(url, bootToken) : null;
        if (!client) throw serviceUnavailable("original host authentication unavailable");
        lookup = await lookupOriginalOperation(client, attempt.operationKey);
        if (observedHost) {
          const current = await hostById(observedHost.id);
          if (!current || String(current.generation) !== String(observedHost.generation)) {
            throw serviceUnavailable("original host transport changed during lookup");
          }
          requireHostAwake(current);
        }
      } catch {
        lookup = { status: null, fetchError: { code: "transport" } };
      }

      const status = lookup.status;
      if (status?.status === "pending" && Date.now() < deadline) {
        await sleep(2_000);
        continue;
      }
      if (status?.status === "succeeded") {
        const id = status.sandboxId;
        const info = status.result;
        const identityMatches = Boolean(
          id && info?.id === id &&
          info.labels["pi-pod-server/pod"] === args.podId &&
          info.labels["pi-pod-server/org"] === args.orgId &&
          info.owner?.userKey === createOwner.userKey,
        );
        if (identityMatches && id) {
          const observed = await provider.get(id, { workdir: config.workdir }).catch(() => null);
          if (observed) return observed;
        }
        await markUnknown();
        throw serviceUnavailable("the original sandbox create is unresolved; no replacement was attempted", {
          code: "launch_recovery_required",
        });
      }
      const safeTerminal = Boolean(
        status && (status.status === "failed" || status.status === "cancelled") &&
        status.crossHostRetrySafe && status.resolution !== "quarantined" &&
        status.error?.code !== "interrupted",
      );
      if (safeTerminal) {
        await markSafe(status?.error?.code === "unsupported_shape" ? "unsupported_shape" : "provider_preallocation_refusal");
        const refusal = statusCode === 507 || unsupported
          ? {
              error: createError,
              retryable: !unsupported && (detail?.["retryable"] as boolean) !== false,
              ...(detail === undefined ? {} : { detail }),
            }
          : { error: createError, retryable: false };
        throw new FailoverNeeded(refusal);
      }
      await markUnknown();
      throw serviceUnavailable(
        status?.status === "pending"
          ? "the original sandbox create is still pending; its owner remains held"
          : "the original sandbox create could not be resolved; its owner remains held",
        { code: "launch_recovery_required" },
      );
    }
  };
  try {
    // Everything below runs on a provider that already holds its credential, so an image
    // build or a slow sandbox boot here costs this launch alone.
    const bootOn = async (providerConfig: Record<string, unknown>, attemptedHostId: string | null) => await withProviderCredential({
      sandboxHostId: attemptedHostId,
      ownerUserId: args.userId,
      kek: deps.kek,
      platformEnv: platformCredentialsOf(deps),
      orgId: args.orgId,
      provider: args.providerName,
      providerConfig,
      fn: async (provider, credentialScope) => {
        if (!args.imageKnownPresent && !(await provider.resolveImage(config.image))) {
          if (!args.imageRecipe.managed) {
            throw new Error(`missing custom image ${args.imageRecipe.ref} passed launch preflight`);
          }
          if (isSandboxLaunch && createAttempt) {
            await assertLaunchAllowed(undefined, args.userId, createAttempt.id);
            await assertCreateAttemptOwner({
              attemptId: createAttempt.id,
              ownerToken: createAttempt.ownerToken,
              ownerInstanceId: createAttempt.ownerInstanceId,
              allowedPhases: ["prepared"],
            });
          }
          deps.log.info(`pod ${args.podId} preparing managed image ${args.imageRecipe.ref}`);
          report.image.status = "preparing";
          const preparing = await query(
            `UPDATE pods SET provider_state = 'preparing_image', provider_state_changed_at = now(),
               state_reason = NULL, resolved_config = $2, updated_at = now()
             WHERE id = $1 AND state = 'active'
               AND provider_state IN ('preparing_image','provisioning')
               AND provider_sandbox_id IS NULL
             RETURNING id`,
            [args.podId, JSON.stringify(report)],
          );
          if ((preparing.rowCount ?? 0) !== 1) {
            throw new Error("pod stopped accepting provisioning updates while preparing its image");
          }
          await ensureHostedImage({
            credentialScope,
            provider,
            recipe: args.imageRecipe,
            resources: config.resources,
            assetRoot: packageRoot(),
          });
        }
        // A prewarmer or another launch may have published between preflight and this resolution.
        // Always make the durable report/state agree once availability has been established.
        report.image.status = "ready";
        const provisioning = await query(
          `UPDATE pods SET provider_state = 'provisioning', provider_state_changed_at = now(),
             state_reason = NULL, resolved_config = $2, updated_at = now()
           WHERE id = $1 AND state = 'active'
             AND provider_state IN ('preparing_image','provisioning')
             AND provider_sandbox_id IS NULL
           RETURNING id`,
          [args.podId, JSON.stringify(report)],
        );
        if ((provisioning.rowCount ?? 0) !== 1) {
          throw new Error("pod stopped accepting provisioning updates before sandbox creation");
        }

        const { resolution } = await resolveLaunchEgressPolicy({
          config,
          env: args.env,
          provider,
          providerConfig,
          credentialContract: args.credentialContract,
          piAuth: args.piAuth,
          piSettings: args.piSettings,
          forbiddenEgressHosts: args.forbiddenEgressHosts,
        });
        report.egress.description = describePolicy(resolution.policy);
        report.warnings.push(...resolution.warnings);

        const createdAtMs = Date.now();
        const markers = creationMarkers({
          provider: provider.name,
          project: args.podName,
          image: config.image,
          createdAtMs,
          egress: report.egress.description,
        });
        const labels = buildLabels({
          project: args.podName,
          createdAtMs,
          workdir: report.workdir,
          extra: { ...config.labels, "pi-pod-server/pod": args.podId, "pi-pod-server/org": args.orgId },
        });

        const timings: Record<string, number> = (report.timings ??= {});
        const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
          if (isSandboxLaunch && createAttempt) {
            await assertCreateAttemptOwner({
              attemptId: createAttempt.id,
              ownerToken: createAttempt.ownerToken,
              ownerInstanceId: createAttempt.ownerInstanceId,
            });
          }
          const startedAt = Date.now();
          try {
            return await work();
          } finally {
            timings[name] = Date.now() - startedAt;
          }
        };

        // The durable dispatch transition commits before the only POST for this
        // host attempt. Recovery never reconstructs this request body.
        const dispatchAttempt = createAttempt;
        if (isSandboxLaunch) {
          if (!dispatchAttempt?.operationKey || !createOwner) {
            throw new Error("sandbox create attempt has no persisted provider identity");
          }
          await tx((client) => markCreateAttemptDispatchingTx(client, {
            attemptId: dispatchAttempt.id,
            ownerToken: dispatchAttempt.ownerToken,
            orgId: args.orgId,
            userId: args.userId,
            ownerInstanceId: dispatchAttempt.ownerInstanceId,
          }));
        }
        const retainedHost = attemptedHostId ? await hostById(attemptedHostId) : null;
        const archiveMinutes = retainedHost?.owner_user_id != null ? 0 :
          effectiveArchiveAfterMinutes(provider, config.archiveAfterMinutes) ?? 0;
        let sandbox: Sandbox;
        try {
          sandbox = await phase("create", () =>
            provider.create({
              image: config.image,
              workdir: config.workdir,
              ...(provider.capabilities.resourceSizing === "per-sandbox" ? { resources: config.resources } : {}),
              env: { ...args.env, ...markers },
              labels,
              archiveAfterMinutes: archiveMinutes,
              idleTimeoutMinutes: idleTimeoutFor(
                provider,
                hostedProviderIdleTimeoutMinutes(config.idleTimeoutMinutes),
              ),
              egress: resolution.policy,
              ...(createOwner && dispatchAttempt?.operationKey
                ? { owner: createOwner, operationKey: dispatchAttempt.operationKey }
                : {}),
            }),
          );
        } catch (createError) {
          sandbox = await resolveCreateOutcome(provider, providerConfig, attemptedHostId, createError);
        }

        if (isSandboxLaunch && dispatchAttempt) {
          const ownerCanContinue = await tx(async (client) => {
            const observed = await recordObservedSandboxTx(client, {
              attemptId: dispatchAttempt.id,
              sandboxId: sandbox.id,
            });
            if (!observed) return false;
            const owner = await client.query<{ id: string }>(
              `SELECT id FROM pod_create_attempts
                WHERE id=$1 AND phase='sandbox_known' AND owner_token=$2
                  AND owner_instance_id=$3 AND owner_lease_until > now()`,
              [dispatchAttempt.id, dispatchAttempt.ownerToken, dispatchAttempt.ownerInstanceId],
            );
            if (!owner.rows[0]) return false;
            const pod = await client.query(
              `UPDATE pods SET provider_sandbox_id=$2, provider_state='starting',
                   provider_state_changed_at=now(), updated_at=now()
                WHERE id=$1 AND state='active'
                  AND provider_state IN ('preparing_image','provisioning')
                  AND provider_sandbox_id IS NULL
                  AND sandbox_host_id IS NOT DISTINCT FROM $3::text
                RETURNING id`,
              [args.podId, sandbox.id, attemptedHostId],
            );
            return (pod.rowCount ?? 0) === 1;
          });
          if (!ownerCanContinue) {
            throw serviceUnavailable("the provider created a sandbox, but launch ownership changed; recovery is required", {
              code: "launch_recovery_required",
            });
          }
        } else {
          const recorded = await query(
            `UPDATE pods SET provider_sandbox_id = $2, provider_state = 'starting',
               provider_state_changed_at = now(), updated_at = now()
             WHERE id = $1 AND state = 'active'
               AND provider_state IN ('preparing_image','provisioning')
               AND provider_sandbox_id IS NULL AND sandbox_host_id IS NOT DISTINCT FROM $3::text
             RETURNING id`,
            [args.podId, sandbox.id, attemptedHostId],
          );
          if ((recorded.rowCount ?? 0) !== 1) {
            throw new Error("pod stopped accepting provisioning updates while recording its sandbox");
          }
        }
        await phase("start", () => sandbox.waitUntilStarted(START_TIMEOUT_MS));
        return {
          sandbox,
          providerName: provider.name,
          egressEnforcement: provider.capabilities.egressEnforcement,
          resolution,
          markers,
          timings,
          phase,
        };
      },
    });

    // Fleet attempts (§§6.4–6.6): request-aware placement, typed failover, and
    // (when enabled) a durable bounded wait. Invariants:
    // - one walk of the fleet per pressure wave (refused hosts are excluded);
    // - queued, not-yet-attempted waits hold the user quota slot but no host
    //   reservation; an attempt's host state is released (or confirmed refused)
    //   before another host is chosen;
    // - ambiguous creates retain their assignment while the original host is
    //   queried by operation key — expiry/cancel never authorises a blind
    //   cross-host retry (the op is cancelled by key instead).
    const hostBackend = args.providerName === "sandbox" ? getSandboxHostBackend(deps.env, { userId: args.userId, kek: deps.kek, podId: args.podId }) : null;
    let providerConfig = args.providerConfig;
    const refusedHosts = new Set<string>();
    const attemptedHosts: Array<{ url: string; hostId: string | null }> = [];
    let lastRefusal: { error: unknown; retryable: boolean; detail?: Record<string, unknown> } | null =
      null;
    let authoritativePlaced = false;
    let waitAdmitted = false;

    const currentHostId = async (): Promise<string | null> =>
      (await getPod(args.orgId, args.podId)).sandbox_host_id ??
      (await sandboxHostByUrl(providerConfig["url"]))?.id ?? null;

    const switchToHost = async (host: { id: string; url: string | null }): Promise<void> => {
      if (!host.url) throw serviceUnavailable("host endpoint is not ready", { reason: "host_starting", retryable: true });
      const hostIdentity = await hostById(host.id);
      if (!hostIdentity) throw serviceUnavailable("selected host registration is unavailable");
      providerConfig = { ...providerConfig, url: host.url };
      config.providers[args.providerName] = providerConfig;
      const previousAttempt = createAttempt;
      if (!previousAttempt) throw new Error("sandbox host assignment has no attempt journal");
      createAttempt = await tx(async (client) => {
        await acquireQuotaLocks(client, args.orgId, args.userId);
        const current = await client.query<{ sandbox_host_id: string | null }>(
          `SELECT sandbox_host_id FROM pods WHERE id=$1 AND org_id=$2 FOR UPDATE`,
          [args.podId, args.orgId],
        );
        const currentHost = current.rows[0]?.sandbox_host_id ?? null;
        const assigned = await client.query(
          `UPDATE pods SET sandbox_host_id=$2, resolved_config=$3, updated_at=now()
            WHERE id=$1 AND sandbox_host_id IS NOT DISTINCT FROM $4::text
              AND state='active' AND provider_state IN ('preparing_image','provisioning')
              AND provider_sandbox_id IS NULL RETURNING id`,
          [args.podId, host.id, JSON.stringify(report), currentHost],
        );
        if ((assigned.rowCount ?? 0) !== 1) throw conflict("pod host assignment changed during placement");
        return assignCreateAttemptTx(client, {
          previous: previousAttempt,
          podId: args.podId,
          orgId: args.orgId,
          userId: args.userId,
          provider: "sandbox",
          hostId: host.id,
          hostGeneration: hostIdentity.generation,
          runtimeBootId: hostIdentity.runtime_boot_id ?? null,
          hostUrl: host.url,
        });
      });
      if (previousAttempt?.id !== createAttempt?.id) {
        stopProvisioningHeartbeat();
        stopProvisioningHeartbeat = startProvisioningHeartbeat(args.podId, deps, () => createAttempt ?? null);
      }
    };

    /** Fresh request-aware placement excluding walked hosts (null = single-mode fallback). */
    const placeFresh = async (exclude: ReadonlySet<string>) =>
      await hostBackend!.placeHostForRequest({
        kek: deps.kek,
        shape: resolveShape(config.resources),
        exclude,
        // Per-tenant degraded check needs the requesting owner (never labels)
        // plus the boot-snapshot token (never ambient mid-overlay).
        ...(createOwner === undefined ? {} : { ownerKey: createOwner.userKey }),
        platformToken: bootToken,
      });

    /**
     * Bounded fair wait (§6.6): enqueue once (per-user capped), then heartbeat,
     * backoff with jitter, and re-probe until a host fits or the deadline hits.
     * Returns the placed host. Throws the typed final-deadline failure (expired),
     * a cancellation, or an abort when the pod row moved on.
     */
    const waitForCapacityAndPlace = async (): Promise<{ id: string; url: string | null }> => {
      const detail = lastRefusal?.detail;
      const reasonText =
        (detail?.["reason"] as string | undefined) ?? "fleet_capacity";
      // The host may name its re-probe interval (fairness_degraded carries
      // an allocator-tick-scale retryAfterMs): honor it instead of the
      // generic backoff. Wire values arrive sanitizer-bounded (≤300s);
      // clamp again here because server-constructed details bypass it.
      const rawHint = detail?.["retryAfterMs"];
      const retryAfterMs =
        typeof rawHint === "number" && Number.isFinite(rawHint) && rawHint > 0
          ? Math.min(rawHint, 300_000)
          : undefined;
      if (!createAttempt?.operationKey) throw lastRefusal?.error;
      // Quota-bound, not waiter-capped: the pod already holds its atomic
      // user slot, and the 20-slot quota bounds total waiters per user.
      let row: CapacityWaitRow = await enqueueCapacityWait(dbq, {
        podId: args.podId,
        orgId: args.orgId,
        userId: args.userId,
        operationKey: createAttempt.operationKey,
        lastHostId: attemptedHosts.at(-1)?.hostId ?? null,
        reason: reasonText,
        detail: detail ?? null,
        waitSeconds: waitCfg.waitSeconds,
      });
      observeCapacityWait("enqueued");
      deps.log.warn(
        `pod ${args.podId} waiting for fleet capacity (reason ${reasonText}, deadline ${waitCfg.waitSeconds}s)`,
      );
      if (reasonText === "fairness_degraded") {
        // The allocator sizes bootstrap demand from this very row, but its
        // tick is up to CPU_ALLOCATOR_INTERVAL_MS away while the create
        // already failed: wake it now so the bootstrap grant lands before
        // the first re-probe. Best-effort in-process; the interval tick
        // remains the fallback (and the only path on split-role
        // deployments without a local scheduler).
        requestCpuAllocatorWake(`fairness-wait:${args.podId}`);
      }
      for (;;) {
        const deadlineInMs = Date.parse(row.deadline_at) - Date.now();
        if (deadlineInMs <= 0) {
          // Guarded exactly like the wake loop: a lost race means a
          // synchronous cancel (or the sweep) already recorded and counted
          // the terminal outcome — end as cancelled, never observe expired
          // or throw the expired terminal over it.
          const expired = await finishWaitExpired(dbq, args.podId);
          if (!expired) {
            throw conflict("pod launch cancelled while waiting for capacity");
          }
          // Typed terminal: the provisioning 500 boundary recognizes this
          // shape (503 + allowlisted code + validated numbers) and records
          // a `capacity_wait_expired` failure instead of genericizing it.
          // The terminal names the LAST recorded refusal, not the
          // enqueue-time reason (2026-09-07: expiry reported
          // fairness_degraded while the last five attempts refused
          // disk_capacity). Zero attempts keeps the enqueue reason — no
          // re-probe ever recorded.
          const terminalRefusal = expiredWaitTerminal({
            enqueueReason: reasonText,
            enqueueDetail: detail ?? null,
            row: expired,
          });
          const display = capacityWaitDisplay(terminalRefusal);
          deps.log.warn(
            `pod ${args.podId} capacity wait expired after ${expired.attempts} attempt(s) ` +
              `(first ${reasonText}, last ${display.reason ?? "fleet_capacity"}); reporting last refusal`,
          );
          throw serviceUnavailable("the fleet is still at capacity; retry shortly", {
            code: CAPACITY_WAIT_EXPIRED_CODE,
            reason: display.reason ?? "fleet_capacity",
            ...(display.required !== undefined ? { required: display.required } : {}),
            ...(display.available !== undefined ? { available: display.available } : {}),
            ...(display.unit !== undefined ? { unit: display.unit } : {}),
            waitedSeconds: waitCfg.waitSeconds,
          });
        }
        // Heartbeat doubles as the cancel check: null means cancelled/expired.
        const beat = await heartbeatCapacityWait(dbq, args.podId, { lastHostId: attemptedHosts.at(-1)?.hostId ?? null });
        if (!beat) {
          // The row is already terminal when a synchronous cancel (pod
          // DELETE, explicit wait cancel) or the sweep won the race — that
          // path already counted the outcome, so only a still-waiting row
          // with cancel_requested is finished (and counted) here.
          const current = await getCapacityWait(dbq, args.podId);
          if (current && current.status === "waiting") {
            await cancelCapacityWait(dbq, args.podId);
          }
          throw conflict("pod launch cancelled while waiting for capacity");
        }
        // The pod row moved on (deleted, or another path recorded a sandbox)?
        // Stop waiting quietly — lifecycle owns the row now.
        const podState = await query(
          `SELECT state, provider_state, provider_sandbox_id FROM pods WHERE id = $1`,
          [args.podId],
        );
        const podRow = podState.rows[0] as
          | { state: string; provider_state: string; provider_sandbox_id: string | null }
          | undefined;
        if (
          !podRow ||
          podRow.state !== "active" ||
          podRow.provider_sandbox_id !== null ||
          !(podRow.provider_state === "preparing_image" || podRow.provider_state === "provisioning")
        ) {
          // The pod row moved on (deleted, archived, or another path recorded
          // a sandbox): finish the durable wait only; never mutate a host here.
          await cancelCapacityWait(dbq, args.podId);
          throw conflict("pod stopped waiting for capacity");
        }
        await sleep(
          waitReprobeDelayMs({
            attempts: row.attempts,
            baseMs: waitCfg.retryBaseMs,
            retryAfterMs,
            deadlineInMs,
          }),
        );
        // Round-robin turn: another user's waiter with fewer attempts goes
        // first. Sitting out a round only costs one backoff; the deadline
        // still bounds the total wait.
        const turn = await tryClaimAttempt(dbq, args.podId);
        if (!turn) {
          row = (await getCapacityWait(dbq, args.podId)) ?? row;
          continue;
        }
        try {
          const placed = await placeFresh(new Set());
          if (placed) {
            const next =
              (await recordWaitAttempt(dbq, args.podId, { reason: reasonText, detail: detail ?? null })) ??
              row;
            row = next;
            waitAdmitted = true;
            return placed.host;
          }
          // Single-mode empty fleet while waiting: keep waiting; the operator
          // may register a host before the deadline.
        } catch (placeError) {
          // Truthful recording (see midWaitAttemptRecord): a mid-wait fleet
          // outage records `fleet_unavailable` with its detail, and any
          // other detail-less refusal keeps the last recording — never the
          // enqueue reason with a null detail over admission numbers.
          row = (await recordWaitAttempt(dbq, args.podId, midWaitAttemptRecord({ enqueueReason: reasonText, row, placeError }))) ?? row;
        }
        row = (await getCapacityWait(dbq, args.podId)) ?? row;
      }
    };

    let boot: Awaited<ReturnType<typeof bootOn>>;
    for (;;) {
      try {
        // With the wait enabled, the plan-time choice was provisional: place
        // authoritatively (fresh probe) before the first attempt. Placement
        // pressure here folds into the same bounded wait as attempt refusals.
        if (waitEnabled && args.hostPlacedByPlan && !authoritativePlaced) {
          authoritativePlaced = true;
          try {
            const placed = await placeFresh(new Set());
            if (placed && placed.host.url !== providerConfig["url"]) {
              deps.log.info(`pod ${args.podId} authoritatively placed on ${placed.host.id}`);
              await switchToHost(placed.host);
            }
          } catch (error) {
            lastRefusal = toRefusal(error);
            if (!lastRefusal.retryable) throw lastRefusal.error;
            await switchToHost(await waitForCapacityAndPlace());
            refusedHosts.clear();
          }
        }
        const attemptedHostId = await currentHostId();
        if (createOwner !== undefined && typeof providerConfig["url"] === "string") {
          attemptedHosts.push({
            hostId: attemptedHostId,
            url: providerConfig["url"] as string,
          });
          await noteWaitAttemptHost(dbq, args.podId, providerConfig["url"] as string, attemptedHostId);
        }
        boot = await bootOn(providerConfig,attemptedHostId);
        break;
      } catch (error) {
        if (!(error instanceof FailoverNeeded)) throw error;
        const hostId = await currentHostId();
        if (hostId) refusedHosts.add(hostId);
        if (error.refusal) lastRefusal = error.refusal;
        // Walk the rest of the fleet once (no cycling): a host that refused
        // with admission control is not asked again for this pressure wave.
        let placed = null;
        try {
          placed = await placeFresh(refusedHosts);
        } catch (placeError) {
          // A fleet-wide shape refusal is final (nothing will change in 60s):
          // fail fast instead of waiting or reporting a stale host refusal —
          // unless the re-placement carried no typed evidence of its own
          // (walk exhausted on a short fleet): then the held retryable host
          // refusal (e.g. fairness_degraded) stays wait-eligible below.
          const outcome = resolveWalkExhaustion(lastRefusal, placeError);
          if (outcome.action === "throw") throw outcome.error;
          lastRefusal = outcome.refusal;
        }
        if (placed) {
          deps.log.warn(
            `pod ${args.podId} was refused by its sandbox host; retrying on ${placed.host.id}`,
          );
          await switchToHost(placed.host);
          continue;
        }
        // Fleet walked: bounded wait for retryable pressure, else the refusal stands.
        if (waitEnabled && lastRefusal?.retryable) {
          await switchToHost(await waitForCapacityAndPlace());
          refusedHosts.clear();
          continue;
        }
        throw lastRefusal?.error ?? error;
      }
    }
    if (waitAdmitted) {
      // Exactly-once: a concurrent sweep expiry wins over a late admit — a
      // lost race counts the outcome the row actually holds, not both.
      const admitted = await finishCapacityWait(dbq, args.podId, "admitted").catch(() => null);
      if (admitted) observeCapacityWait("admitted");
    }

    const { sandbox, providerName, egressEnforcement, resolution, markers, timings, phase } = boot;
    const execEnv = { ...markers, ...runtimeMarkers(sandbox.id) };
    try {
      // Hosts seeding and the workdir ride one script — each exec is a provider round trip.
      await phase("prep", async () => {
        const prepLines = ["set -e"];
        // A sandbox that receives `names` writes them into a read-only /etc/hosts itself; one
        // that predates them leaves DNS open. The append only helps providers that do neither.
        if (resolution.resolved.length > 0 && egressEnforcement === "cidr") {
          prepLines.push("{ cat >> /etc/hosts <<'PI_POD_HOSTS'");
          prepLines.push(renderHostsFile(buildHostsEntries(resolution.resolved)).trimEnd());
          prepLines.push("PI_POD_HOSTS");
          prepLines.push("} 2>/dev/null || true");
        }
        prepLines.push(`mkdir -p ${shellQuote(config.workdir)}`);
        const prep = await sandbox.exec(["bash", "-c", prepLines.join("\n")], { env: execEnv, timeoutMs: 30_000 });
        if (prep.exitCode !== 0) throw new Error(`failed to prepare the pod workspace (exit ${prep.exitCode})`);
      });

      // Once the workdir exists, the account material, skill, and package overlay touch
      // independent paths. Overlap them instead of serializing provider commands.

      const installSettings = async (): Promise<void> => {
        if (!args.piSettings) return;
        report.piSettings!.status = "installing";
        await persistReport(args.podId, report);
        const installed = await phase("packages", () => installPiSettings(sandbox, args.piSettings!.plan));
        const resolvedPackages = await resolveInstalledPackages(sandbox, installed.plan.packages).catch(
          () => [],
        );
        report.piSettings = {
          ...report.piSettings!,
          status: installed.status,
          installedPackageCount: installed.installedPackageCount,
          failedPackageCount: installed.failedPackageCount,
          ...(resolvedPackages.length > 0 ? { resolvedPackages } : {}),
        };
        if (installed.status === "degraded") {
          report.warnings.push(
            `Pi package preinstall failed for ${installed.failedPackageCount} package(s); ` +
              "continuing with those entries removed from the local settings overlay",
          );
        }
        await persistReport(args.podId, report);
      };

      const installProvisionShim = async (): Promise<void> => {
        await uploadShim(sandbox, EXIT_CODE_FILE, podExtensionSettings(report));
        report.shim = {
          version: SHIM_VERSION,
          launcher: launcherVersion(),
          sessionNaming: config.pi.sessionNaming ?? "auto",
        };
      };

      await phase("materialize", () =>
        Promise.all([
          installPodSkill(sandbox, execEnv),
          installProvisionShim(),
          materializeLaunchCredentialLease({
            kek: deps.kek,
            sandbox,
            execEnv,
            podId: args.podId,
            orgId: args.orgId,
            userId: args.userId,
            credentialContract: args.credentialContract,
            config,
            piSettings: args.piSettings,
          }),
          installSettings(),
        ]),
      );

      if (isSandboxLaunch && createAttempt) {
        await assertCreateAttemptOwner({
          attemptId: createAttempt.id,
          ownerToken: createAttempt.ownerToken,
          ownerInstanceId: createAttempt.ownerInstanceId,
        });
      }
      await runPodInitSteps({
        podId: args.podId,
        sandbox,
        initSteps: args.initSteps,
        bakeScript: args.bakeScript,
        config,
        report,
        execEnv,
        sandboxEnv: args.env,
        egressRestricted: resolution.policy.mode === "allowlist",
        timings,
      });

      if (args.piSettings?.projectUploads.length) {
        await phase("project-pi", () => installProjectPiSettings(sandbox, args.piSettings!.projectUploads));
      }

      if (!args.deferSupervisor) {
        await phase("supervisor", async () => {
          const cradle = await startAgentdSupervisor({
            sandbox,
            piArgv: buildPiArgv(config.pi),
            cwd: config.workdir,
            env: { ...args.env, ...execEnv },
            // After init and the settings overlay, because those are what put a requested
            // resource on this disk in the first place; before Pi, because a pod missing one
            // is a failed launch rather than a quietly diminished agent.
            piResources: report.piResources,
          });
          if (cradle === "pty-cradle") {
            deps.log.warn(`pod ${args.podId} uses a PTY only as its supervisor process cradle`);
          }
        });
      }

      // Hosted provider credentials remain server-only. The gateway owns semantic busy
      // renewal for both provider and database clocks; no provider-key watcher runs in-pod.

      const started = await tx(async (client) => {
        if (isSandboxLaunch && createAttempt) {
          const finished = await finishCreateAttemptTx(client, {
            attemptId: createAttempt.id,
            ownerToken: createAttempt.ownerToken,
            ownerInstanceId: createAttempt.ownerInstanceId,
            sandboxId: sandbox.id,
          });
          if (!finished) return false;
        }
        const result = await client.query(
          `UPDATE pods SET provider_state = 'started', provider_state_changed_at = now(), state_reason = NULL,
             resolved_config = $2, last_activity_at = now(), updated_at = now()
           WHERE id = $1 AND state = 'active' AND provider_state = 'starting'
             AND provider_sandbox_id = $3
           RETURNING id`,
          [args.podId, JSON.stringify(report), sandbox.id],
        );
        if ((result.rowCount ?? 0) !== 1) {
          throw new Error("pod stopped accepting provisioning updates before becoming ready");
        }
        return true;
      });
      if (!started) {
        throw new Error("launch owner changed before the pod became ready");
      }
      observePodLaunch(providerName, "started");
      deps.log.info(`pod ${args.podId} started (${providerName} ${sandbox.id})`);
      // A seed-gated launch starts Pi from the seed route (or the gateway sweep once the gate
      // times out); an eager attach here would boot Pi into the still-empty workdir.
      if (workspaceSeedGateOpen(report, Date.now(), (deps.env.WORKSPACE_SEED_GATE_TIMEOUT_SECONDS ?? 600) * 1000)) {
        deps.onPodStarted?.(args.podId);
      }
    } catch (e) {
      // A resource with a recorded provider id is retained for recovery or an
      // explicit user lifecycle action; automatic launch cleanup can destroy data.
      throw e;
    }
  } finally {
    stopProvisioningHeartbeat();
  }
}
async function installPodSkill(sandbox: Sandbox, env: Record<string, string>): Promise<void> {
  const content = new TextEncoder().encode(renderPodSkill());
  await sandbox.uploadFile("/tmp/pi-pod-skill.md", content);
  const res = await sandbox.exec(
    ["bash", "-c", `mkdir -p ~/${SKILL_REMOTE_DIR} && mv /tmp/pi-pod-skill.md ~/${SKILL_REMOTE_DIR}/SKILL.md`],
    { env, timeoutMs: 30_000 },
  );
  if (res.exitCode !== 0) throw new Error("failed to install the pi pod skill in the pod");
}

function pick(env: Record<string, string>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) if (env[key]) out[key] = env[key]!;
  return out;
}

/**
 * Authoritative launch-time egress resolution shared by fresh provisioning and warm-disk
 * reuse (M5: reuse froze `report.egress.description` as `""` because only fresh resolved it).
 *
 * The effective policy is derived from the same inputs in both paths — the merged
 * `config.egress` contract plus server builtins, materialized-sign-in and settings-bundle
 * provider endpoints, and org `forbiddenEgressHosts` denials — then mapped onto what the
 * provider can enforce. Callers persist `describePolicy(resolution.policy)` as the canonical
 * representation; nothing here infers `"open"` from an unknown/empty state (open is returned
 * only when `config.egress.mode` is `"open"`, via `buildEffectivePolicy`). Restricted policies
 * stay restricted: allowlist inputs can only yield allowlist (or throw fail-closed), never open.
 */
export async function resolveLaunchEgressPolicy(args: {
  config: Pick<PiPodConfig, "egress">;
  env: Record<string, string>;
  provider: Pick<SandboxProvider, "name" | "capabilities" | "keepaliveApiHost">;
  providerConfig: Record<string, unknown>;
  credentialContract: readonly string[];
  piAuth: { providers: string[] } | null;
  piSettings: PlannedPiSettings | null;
  forbiddenEgressHosts: string[];
}): Promise<{ effective: EffectivePolicy; resolution: ResolutionResult }> {
  // Egress: the template contract plus server builtins; policy already narrowed it (§6, §13).
  // Both the materialized sign-in and selected settings bundle contribute provider endpoints.
  // The registry is augmented by carried packages before endpoint lookup in either launch mode.
  const authProviders = [
    ...new Set([...args.credentialContract, ...(args.piAuth?.providers ?? [])]),
  ];
  const hasPiProviders = Boolean(authProviders.length || args.piSettings?.plan.providers.length);
  const providerEndpoints = hasPiProviders
    ? piProviderEndpoints(await loadProviderRegistry(), {
        authProviders,
        settingsProviders: args.piSettings?.plan.providers,
        packages: args.piSettings?.plan.packages,
        forbiddenEgressHosts: args.forbiddenEgressHosts,
      })
    : [];
  const effective = withoutForbiddenEgressHosts(
    buildEffectivePolicy(args.config.egress, {
      envKeys: Object.keys(args.env),
      baseUrlValues: pick(args.env, BASE_URL_KEYS),
      podProviderApi: args.provider.keepaliveApiHost
        ? { name: args.provider.name, host: args.provider.keepaliveApiHost }
        : providerApiHost(args.provider.name, args.providerConfig),
      ...(providerEndpoints.length > 0 ? { providerEndpoints } : {}),
    }),
    args.forbiddenEgressHosts,
  );
  if (effective.mode === "allowlist" && effective.entries.length === 0) {
    throw badRequest("organization policy forbids every resolved egress host");
  }
  const resolution = await resolveForProvider(effective, args.provider.capabilities.egressEnforcement, {
    addressFamily: args.provider.capabilities.egressAddressFamily,
    maxEntries: args.provider.capabilities.egressMaxEntries ?? null,
  });
  return { effective, resolution };
}

function providerApiHost(
  name: string,
  providerConfig: Record<string, unknown>,
): { name: string; host: string } | null {
  if (name === "sandbox") {
    const url =
      (providerConfig["url"] as string | undefined) ?? process.env["PI_POD_SANDBOX_URL"];
    try {
      return url ? { name, host: new URL(url).hostname } : null;
    } catch {
      return null;
    }
  }
  return null;
}
