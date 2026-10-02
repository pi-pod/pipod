/**
 * Launch and provisioning for co-located pods (the "host" provider).
 *
 * A co-located child is a real pod in every server-visible way — row, token, gateway
 * session, lineage — whose "machine" is another pod's. That physics decides the config
 * rules here: machine-shaped settings (image, resources, egress, idle/archive clocks) are
 * inherited from the host, so a launch that names them explicitly is refused rather than
 * silently ignored; init is all-or-nothing by workdir freshness (a shared workdir already
 * ran its setup, a fresh one never did); and pi-level settings (model, thinking, env,
 * prompt) are honored per child.
 */
import { uploadShim } from "../../core/client/session.js";
import { hostForPod } from "./hostidentity.js";
import { edition } from "../edition.js";
import { buildPiArgv } from "../../core/lifecycle.js";
import { HOST_PROVIDER_NAME, formatHostSandboxId } from "../../core/providers/host.js";
import { SHIM_VERSION } from "../../core/shim/agentd.js";
import { launcherVersion } from "../../core/image.js";
import { acquireQuotaLocks } from "./concurrency.js";
import { assertLaunchAllowed } from "./launch-control.js";
import { markCreateAttemptDispatchingTx, prepareCreateAttemptTx, recordObservedSandboxTx, finishCreateAttemptTx, assertCreateAttemptOwner, type PreparedCreateAttempt } from "./create-attempts.js";
import { audit } from "../audit.js";
import { query, tx } from "../db/index.js";
import { observePodLaunch } from "../metrics.js";
import { badRequest, conflict } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import { truncate } from "../push/copy.js";
import { enqueuePush } from "../push/queue.js";
import { listCredentialMeta } from "../model-credentials/store.js";
import { assertProviderNotDenied, assertProviderPermitted, resolveSettings } from "../settings/merge.js";
import { planLocalPiSettings } from "../settings/pi-settings.js";
import { DEFAULT_TEMPLATE_NAME, getTemplate, type TemplateRow } from "../templates/store.js";
import { withHostMachineProvider } from "./hostmachine.js";
import { runPodInitSteps } from "./initialization.js";
import { composePodEnv, savePodLaunchEnv, type LaunchEnvLayers } from "./launchenv.js";
import { ensureProviderPodStarted } from "./lifecycle.js";
import {
  assertDelegatedTemplate,
  delegateCredentials,
  lockLineageRoot,
  nestedPodsPolicy,
  parentDelegation,
  planChildLineage,
  type LineagePlacement,
} from "./lineage.js";
import {
  applyPiLaunchOverrides,
  buildInitSteps,
  LEGACY_PROJECT_LAYERS_WARNING,
  planLaunchCredentials,
  type LaunchProject,
  type PiLaunchOverrides,
} from "./planning.js";
import { createPodToken } from "./podtoken.js";
import { normalizePiResources } from "./pi-resources.js";
import { startProvisioningHeartbeat } from "./provisioning.js";
import { describeLaunchFailure, recordProvisioningFailure } from "./provision-failure.js";
import { sanitizeFailureMessage } from "../safe-errors.js";
import { childRuntimePaths } from "./runtime-paths.js";
import { creationMarkers, runtimeMarkers } from "../../core/labels.js";
import { resolveSecrets } from "../secrets/store.js";
import { getPod } from "./store.js";
import { startAgentdSupervisor } from "./supervisor.js";
import type { InitScope, PodLaunchResult, PodRow, PodServiceDeps, ResolvedConfigReport } from "./types.js";

const HOST_INHERITED_KEYS = [
  "image",
  "resources",
  "egress",
  "idleTimeoutMinutes",
  "archiveAfterMinutes",
  "archiveAfterDays",
  "provider",
] as const;

function explicitInheritedKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return HOST_INHERITED_KEYS.filter((key) => (raw as Record<string, unknown>)[key] !== undefined);
}

/**
 * Follow a placement ref to the pod that physically owns a machine. Naming a co-located pod
 * is not an error — `--on self` from inside a co-located child must land on the real host.
 */
export async function resolvePlacementHost(orgId: string, podId: string): Promise<PodRow> {
  const named = await getPod(orgId, podId);
  const host = named.provider === HOST_PROVIDER_NAME && named.host_pod_id
    ? await getPod(orgId, named.host_pod_id)
    : named;
  if (host.provider === HOST_PROVIDER_NAME) {
    throw conflict("the named pod's host is itself co-located; its machine cannot be resolved");
  }
  if (host.state !== "active") {
    throw conflict("restore the host pod before placing pods on it");
  }
  if (host.provider_state === "gone" || host.provider_state === "error" || !host.provider_sandbox_id) {
    throw conflict("the host pod has no usable machine to place pods on");
  }
  return host;
}

export async function launchHostChild(
  deps: PodServiceDeps,
  args: {
    orgId: string;
    userId: string;
    hostPod: PodRow;
    templateId?: string | null;
    /** Legacy project identity is retained for attribution; all contained settings are ignored. */
    project?: LaunchProject | null;
    legacyLaunchInputsPresent?: boolean;
    piOverrides?: PiLaunchOverrides | null;
    /** Set when a pod token asked for this launch: the child records it as its parent. */
    parentPodId?: string | null;
  },
): Promise<PodLaunchResult> {
  await assertLaunchAllowed(undefined, args.userId);
  const host = args.hostPod;
  const identityHost = await hostForPod(host);
  // A dedicated boat is still the owner's machine: co-locating onto it is the same
  // explicit choice as on a static host, and adds no boat and no boat time.
  if (identityHost?.owner_user_id != null && identityHost.owner_user_id !== args.userId) {
    throw conflict("--on cannot place pods on another user's personal host, even within the same organization");
  }
  // A co-located child is new work inside the host: a reached cap refuses it. It shares
  // the host workdir and reserves no new workspace storage.
  await edition().admitPodWork(deps.env, args.userId);
  await edition().ensurePodHostReady(deps, host);
  const project = args.project ?? null;
  let template: TemplateRow | null = null;
  if (args.templateId) {
    template = await getTemplate(args.orgId, args.templateId, args.userId);
  }

  const delegation = args.parentPodId
    ? await parentDelegation({ query }, { orgId: args.orgId, parentPodId: args.parentPodId })
    : null;
  if (template) assertDelegatedTemplate(template, delegation);
  const includeUserLayer = delegation?.includeUserBundle ?? true;
  const [secrets, credentialMetas, resolved] = await Promise.all([
    resolveSecrets({
      kek: deps.kek,
      orgId: args.orgId,
      userId: args.userId,
      includeUserLayer,
      templateId: template?.id ?? null,
    }),
    listCredentialMeta({ orgId: args.orgId, userId: args.userId }),
    resolveSettings({
      orgId: args.orgId,
      userId: args.userId,
      includeUserLayer,
      templateConfigRaw: template?.config ?? null,
      templatePiFilesRaw: template?.pi_settings ?? null,
      templateScope: template ? (template.owner_user_id === null ? "org" : "user") : null,
      templateSelected: template !== null,
    }),
  ]);
  const { config, clamps, policy } = resolved;
  assertProviderPermitted(policy, HOST_PROVIDER_NAME);
  assertProviderNotDenied(resolved.deniedProviderOrigins, HOST_PROVIDER_NAME);
  // Resource paths land in config.pi.args on purpose: every later Pi start for this pod
  // rebuilds argv from the stored config, so a restart keeps loading the same extensions.
  applyPiLaunchOverrides(config, args.piOverrides);
  const piResources = normalizePiResources(args.piOverrides);
  const piSettings = planLocalPiSettings(
    Object.keys(resolved.piFiles).length > 0 ? { user: resolved.piFiles } : null,
    {
      packages: config.pi.hostConfig.packages,
      userSettings: config.pi.hostConfig.settings,
      workdir: config.workdir,
    },
  );
  const planned = planLaunchCredentials({
    metas: credentialMetas,
    config,
    piSettings,
  });
  const { piAuth, credentialContract } = delegation ? delegateCredentials(planned, delegation) : planned;

  // Machine-shaped ambient bundle config cannot be honored on someone else's machine.
  // Legacy request project config is already ignored, like every other launch path.
  const inheritedWarnings: string[] = [];
  if (args.legacyLaunchInputsPresent) {
    inheritedWarnings.push(LEGACY_PROJECT_LAYERS_WARNING);
  }
  const templateConflicts = explicitInheritedKeys(template?.config ?? null);
  if (templateConflicts.length > 0) {
    inheritedWarnings.push(
      `template config sets ${templateConflicts.join(", ")}, which co-located pods inherit from their host — ignored for this launch`,
    );
  }
  if (Object.keys(resolved.piFiles).length > 0) {
    // Pi settings bundles write under ~/.pi, which co-located pods share with their host;
    // installing a divergent bundle would mutate the host's own configuration.
    inheritedWarnings.push(
      "the resolved Pi files bundle is not installed for a co-located pod (shared ~/.pi); model/thinking still apply per pod",
    );
  }

  // Workdir: inherited from the host unless a layer *explicitly* configured one. The
  // explicitness test is provenance, never value comparison — a defaulted value must not
  // read as an ownership claim over a directory the child did not create (delete would
  // then remove it). ownsWorkdir is therefore only ever true for a deliberate, different
  // path, and the adapter re-checks against the host workdir at delete time.
  const hostWorkdir = host.resolved_config.workdir;
  const workdirExplicit = resolved.provenance.some((entry) => entry.path === "workdir");
  const workdir = workdirExplicit ? config.workdir : hostWorkdir;
  config.workdir = workdir;
  const ownsWorkdir = workdirExplicit && workdir !== hostWorkdir;
  // All-or-nothing by freshness: a shared workdir already ran its setup chain on this
  // filesystem; a fresh one never saw it.
  const initSteps = ownsWorkdir
    ? buildInitSteps({
        org: resolved.initScripts.org,
        user: resolved.initScripts.user,
        template: template?.init_script ?? null,
        templateScope: template?.owner_user_id === null ? "org" : "user",
      })
    : [];
  if (!ownsWorkdir && (
    template?.init_script?.trim() ||
    resolved.initScripts.user.trim() ||
    resolved.initScripts.org.trim()
  )) {
    inheritedWarnings.push(
      "init scripts are skipped for a co-located pod sharing its host's workdir — the host already ran setup on this filesystem",
    );
  }

  config.provider = HOST_PROVIDER_NAME;
  config.image = host.resolved_config.config.image;
  // The host's clocks govern the machine; the server-side reaper and archive sweep key off
  // these resolved values, so zeroing them is what exempts children from both.
  config.idleTimeoutMinutes = 0;
  config.archiveAfterMinutes = 0;

  const launchEnvLayers: LaunchEnvLayers = { project: {} };
  const podEnv = composePodEnv(secrets.env, launchEnvLayers);
  const secretScopes: Record<string, string> = { ...secrets.origins };
  for (const key of Object.keys(launchEnvLayers.project)) {
    if (key in podEnv) secretScopes[key] = "project";
  }

  const podName = project?.name ?? template?.name ?? "New pod";
  const hostImage = host.resolved_config.image;
  const report: ResolvedConfigReport = {
    config,
    image: {
      ref: hostImage?.ref ?? config.image,
      managed: hostImage?.managed ?? false,
      provenance: hostImage?.provenance ?? "config",
      assetDigest: hostImage?.assetDigest ?? "",
      status: "ready",
    },
    clamps,
    configProvenance: resolved.provenance,
    layerOrder: resolved.layerOrder,
    secretKeys: Object.keys(podEnv).sort(),
    secretScopes,
    initSteps: initSteps.map((s) => ({ scope: s.scope, status: "pending" })),
    ...(piAuth ? { piAuthProviders: piAuth.providers } : {}),
    // The pod runs in its host's sandbox, behind that sandbox's network policy: record the
    // policy itself, which attach reads back ("open" or "allowlist:…"), not a label for it.
    egress: {
      description: host.resolved_config.egress?.description ?? "open",
      mode: host.resolved_config.egress?.mode ?? "open",
    },
    workdir,
    warnings: [...resolved.warnings, ...inheritedWarnings],
    // Recorded so every later start — including one the gateway performs itself after a stop —
    // can check the paths this launch required before Pi runs.
    ...(piResources ? { piResources } : {}),
    notificationsRedacted: policy.notifications?.redacted ?? false,
    retention: {
      idleTimeoutMinutes: 0,
      archiveTransition: { kind: "same-as-stop", expiryDays: null },
      effectiveArchiveAfterMinutes: null,
      providerExpiryDocumented: false,
    },
  };

  const podId = uuidv7();
  const expectedSandboxId = formatHostSandboxId(host.id, podId);
  let createAttempt: PreparedCreateAttempt | null = null;
  await tx(async (client) => {
    await acquireQuotaLocks(client, args.orgId, args.userId);
    await assertLaunchAllowed(client, args.userId);
    let placement: LineagePlacement | null = null;
    if (args.parentPodId) {
      await lockLineageRoot(client, { orgId: args.orgId, parentPodId: args.parentPodId });
      placement = await planChildLineage(
        client,
        { orgId: args.orgId, parentPodId: args.parentPodId, policy: nestedPodsPolicy(policy) },
        { colocated: true },
      );
    }
    await client.query(
      `INSERT INTO pods (id, org_id, template_id, user_id, name, provider, state, provider_state,
         resolved_config, project, provisioning_heartbeat_at, parent_pod_id, lineage_root_id,
         lineage_depth, host_pod_id, transport, credential_providers)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', 'provisioning', $7, $8, now(), $9,
         COALESCE($10::uuid, $1::uuid), $11, $12, 'ws', $13)`,
      [
        podId,
        args.orgId,
        template?.id ?? null,
        args.userId,
        podName,
        HOST_PROVIDER_NAME,
        JSON.stringify(report),
        project?.name ?? null,
        placement?.parentPodId ?? null,
        placement?.lineageRootId ?? null,
        placement?.lineageDepth ?? 0,
        host.id,
        credentialContract,
      ],
    );
    createAttempt = await prepareCreateAttemptTx(client, {
      podId,
      orgId: args.orgId,
      userId: args.userId,
      provider: "host",
      hostId: identityHost?.id ?? null,
      hostPodId: host.id,
      hostGeneration: identityHost?.generation ?? null,
      runtimeBootId: identityHost?.runtime_boot_id ?? null,
      hostUrl: typeof host.resolved_config.config.providers?.sandbox?.url === "string"
        ? host.resolved_config.config.providers.sandbox.url
        : null,
      expectedSandboxId,
    });
  });
  if (!createAttempt) throw new Error("co-located launch has no durable create-attempt record");
  observePodLaunch(HOST_PROVIDER_NAME, "accepted");
  try {
    await deps.onPodCreated?.(podId);
  } catch (e) {
    const message = sanitizeFailureMessage(e, { prefix: "launch registration failed" });
    report.warnings.push(message);
    await recordProvisioningFailure({ podId, orgId: args.orgId, userId: args.userId, report, message }).catch(() => null);
    throw e;
  }

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
        provider: HOST_PROVIDER_NAME,
        host: host.id,
        secretKeys: report.secretKeys,
        clamps,
        ...(args.parentPodId ? { fromPod: args.parentPodId } : {}),
      },
    }),
  ]).catch(async (e) => {
    const message = sanitizeFailureMessage(e, { prefix: "launch custody setup failed" });
    report.warnings.push(message);
    await recordProvisioningFailure({ podId, orgId: args.orgId, userId: args.userId, report, message }).catch(() => null);
    throw e;
  });

  void provisionHostChild(deps, {
    podId,
    orgId: args.orgId,
    hostPodId: host.id,
    userId: args.userId,
    createAttempt,
    hostWorkdir,
    podName,
    report,
    initSteps,
    ownsWorkdir,
    workdir,
    env: {
      ...podEnv,
      PI_POD_SERVER_URL: deps.env.PUBLIC_URL ?? "",
      PI_POD_SERVER_TOKEN: podToken,
      PI_POD_SERVER_POD_ID: podId,
    },
  }).catch(async (e) => {
    // Same 500 boundary as the sandbox launch path: a co-located child that the
    // host refused on admission keeps the validated numbers behind the refusal,
    // and every other throw stays on the generic sanitized message.
    const { message, code } = describeLaunchFailure(e);
    deps.log.error(`pod ${podId} provisioning failed: ${message}`);
    report.warnings.push(`provisioning failed: ${message}`);
    const failedState = await recordProvisioningFailure({
      podId,
      orgId: args.orgId,
      userId: args.userId,
      report,
      message,
      code,
    }).catch(() => null);
    if (!failedState || failedState === "recovery_required") return;
    await enqueuePush(args.userId, {
      title: report.notificationsRedacted ? "pod launch failed" : `pod launch failed: ${podName}`,
      body: report.notificationsRedacted ? "" : truncate(message),
      data: { pod_id: podId, org_id: args.orgId, kind: "pod_error" },
    }).catch(() => {});
  });

  const pod = await getPod(args.orgId, podId);
  return { pod, report: pod.resolved_config };
}

async function provisionHostChild(
  deps: PodServiceDeps,
  args: {
    podId: string;
    orgId: string;
    hostPodId: string;
    userId: string;
    createAttempt: PreparedCreateAttempt;
    hostWorkdir: string;
    podName: string;
    report: ResolvedConfigReport;
    initSteps: Array<{ scope: InitScope; script: string }>;
    ownsWorkdir: boolean;
    workdir: string;
    /** Full child env: secrets and identity (§7). Never logged. */
    env: Record<string, string>;
  },
): Promise<void> {
  const { report } = args;
  const config = report.config;
  const stopProvisioningHeartbeat = startProvisioningHeartbeat(args.podId, deps, args.createAttempt);
  try {
    // Placement may name a sleeping host: attach semantics, wake it first.
    const host = await ensureProviderPodStarted(deps, { org_id: args.orgId, id: args.hostPodId }, null);

    const timings: Record<string, number> = (report.timings ??= {});
    const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      await assertCreateAttemptOwner({
        attemptId: args.createAttempt.id,
        ownerToken: args.createAttempt.ownerToken,
        ownerInstanceId: args.createAttempt.ownerInstanceId,
      });
      const startedAt = Date.now();
      try {
        return await work();
      } finally {
        timings[name] = Date.now() - startedAt;
      }
    };

    await withHostMachineProvider(deps, host, async (provider) => {
      const markers = {
        ...creationMarkers({
          provider: HOST_PROVIDER_NAME,
          project: args.podName,
          image: config.image,
          createdAtMs: Date.now(),
          egress: report.egress.description,
        }),
        ...runtimeMarkers(formatHostSandboxId(host.id, args.podId)),
      };
      await tx((client) => markCreateAttemptDispatchingTx(client, {
        attemptId: args.createAttempt.id,
        ownerToken: args.createAttempt.ownerToken,
        orgId: args.orgId,
        userId: args.userId,
        ownerInstanceId: args.createAttempt.ownerInstanceId,
      }));
      const sandbox = await phase("create", () =>
        provider.create({
          image: config.image,
          workdir: args.workdir,
          env: { ...args.env, ...markers },
          labels: { "pi-pod-server/pod": args.podId, "pi-pod-server/org": args.orgId },
          archiveAfterMinutes: 0,
          idleTimeoutMinutes: 0,
          egress: { mode: "open" },
          placement: { hostId: host.id, ownsWorkdir: args.ownsWorkdir, hostWorkdir: args.hostWorkdir },
        }),
      );

      if (sandbox.id !== args.createAttempt.expectedSandboxId) {
        throw conflict("co-located provider returned an unexpected sandbox identity", {
          code: "launch_recovery_required",
        });
      }
      const ownerCanContinue = await tx(async (client) => {
        const observed = await recordObservedSandboxTx(client, {
          attemptId: args.createAttempt.id,
          sandboxId: sandbox.id,
        });
        if (!observed) return false;
        const owner = await client.query<{ id: string }>(
          `SELECT id FROM pod_create_attempts
            WHERE id=$1 AND phase='sandbox_known' AND owner_token=$2
              AND owner_instance_id=$3 AND owner_lease_until>now()`,
          [args.createAttempt.id, args.createAttempt.ownerToken, args.createAttempt.ownerInstanceId],
        );
        if (!owner.rows[0]) return false;
        const recorded = await client.query(
          `UPDATE pods SET provider_sandbox_id=$2, provider_state='starting',
               provider_state_changed_at=now(), updated_at=now()
            WHERE id=$1 AND state='active' AND provider_state='provisioning'
              AND provider_sandbox_id IS NULL RETURNING id`,
          [args.podId, sandbox.id],
        );
        return (recorded.rowCount ?? 0) === 1;
      });
      if (!ownerCanContinue) {
        throw conflict("co-located sandbox identity was recorded but launch ownership changed", {
          code: "launch_recovery_required",
        });
      }

      const paths = childRuntimePaths(args.podId);
      const execEnv = markers;
      await phase("materialize", () =>
        uploadShim(sandbox, paths.exitCode, config.pi.sessionNaming, paths),
      );
      report.shim = {
        version: SHIM_VERSION,
        launcher: launcherVersion(),
        sessionNaming: config.pi.sessionNaming ?? "auto",
      };

      if (args.initSteps.length > 0) {
        await assertCreateAttemptOwner({
          attemptId: args.createAttempt.id,
          ownerToken: args.createAttempt.ownerToken,
          ownerInstanceId: args.createAttempt.ownerInstanceId,
        });
        await runPodInitSteps({
          podId: args.podId,
          sandbox,
          initSteps: args.initSteps,
          bakeScript: null,
          config,
          report,
          execEnv,
          sandboxEnv: args.env,
          egressRestricted: false,
          timings,
        });
      }

      await phase("supervisor", async () => {
        const cradle = await startAgentdSupervisor({
          sandbox,
          piArgv: buildPiArgv(config.pi),
          cwd: args.workdir,
          env: { ...args.env, ...execEnv },
          paths,
          // Checked here, on the host's filesystem, before Pi: the paths a co-located worker
          // was launched with are files its supervisor put there, and a missing one means a
          // worker that starts without the capability it exists for.
          piResources: report.piResources,
        });
        if (cradle === "pty-cradle") {
          deps.log.warn(`pod ${args.podId} uses a PTY only as its supervisor process cradle`);
        }
      });

      const started = await tx(async (client) => {
        const finished = await finishCreateAttemptTx(client, {
          attemptId: args.createAttempt.id,
          ownerToken: args.createAttempt.ownerToken,
          ownerInstanceId: args.createAttempt.ownerInstanceId,
          sandboxId: sandbox.id,
        });
        if (!finished) return false;
        const result = await client.query(
          `UPDATE pods SET provider_state = 'started', provider_state_changed_at = now(), state_reason = NULL,
             resolved_config = $2, last_activity_at = now(), updated_at = now()
           WHERE id = $1 AND state = 'active' AND provider_state = 'starting'
             AND provider_sandbox_id = $3
           RETURNING id`,
          [args.podId, JSON.stringify(report), sandbox.id],
        );
        if ((result.rowCount ?? 0) !== 1) throw new Error("pod stopped accepting provisioning updates before becoming ready");
        return true;
      });
      if (!started) {
        throw new Error("co-located launch owner changed before the pod became ready");
      }
      observePodLaunch(HOST_PROVIDER_NAME, "started");
      deps.log.info(`pod ${args.podId} started (co-located on ${host.id})`);
      deps.onPodStarted?.(args.podId);
    });
  } finally {
    stopProvisioningHeartbeat();
  }
}
