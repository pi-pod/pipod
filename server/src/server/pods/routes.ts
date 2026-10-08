import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePermission, type AuthContext } from "../auth/plugin.js";
import { hasPermission } from "../auth/rbac.js";
import { audit } from "../audit.js";
import { query, tx } from "../db/index.js";
import { HttpError, badRequest, conflict, forbidden, gone, notFound } from "../httperrors.js";
import { BOAT_HOST_DEMAND_REASONS } from "../safe-errors.js";
import { LEASE_STALE_SECONDS, type GatewayService } from "../gateway/service.js";
import {
  finishLaunchOperation,
  getLaunchOperation,
  reserveLaunchOperation,
  type LaunchOperationClaim,
  type LaunchOperationRow,
} from "./launch-operations.js";
import { mintTicket } from "../gateway/tickets.js";
import { truncate } from "../push/copy.js";
import { PROVIDER_CREDENTIAL_VARS, supportedProviders } from "../../core/providers/registry.js";
import {
  ACCOUNT_THINKING_LEVELS,
  ensureProviderPodStarted,
  getPod,
  launchPod,
  listPods,
  reusePod,
  planPodLaunch,
  podLifecycleActionMessage,
  runPodLifecycleAction,
  runProviderPodCommand,
  withPodActivityLease,
  withPodSandbox,
  type PodRow,
  type PodServiceDeps,
} from "./service.js";
import { platformCredentialsOf, withProviderCredential } from "./providercred.js";
import { edition } from "../edition.js";
import { assertPodAccess } from "./access.js";
import {
  assertPodTokenReach,
  liveChildren,
  nestedPodsPolicy,
  parentDelegation,
  reparentChildren,
  subtreeDeepestFirst,
} from "./lineage.js";
import { launchHostChild, resolvePlacementHost } from "./host-launch.js";
import { PI_RESOURCE_OVERRIDE_FIELDS } from "./pi-resources.js";
import { startedHostChildIds } from "./lifecycle.js";
import { assertPodLifecycleAction } from "./create-attempts.js";
import { acquireLease } from "../model-credentials/lease.js";
import { MIN_VALIDITY_MS } from "../model-credentials/refresh.js";
import { uuidv7 } from "../ids.js";
import {
  conversationEventsQuery,
  conversationPageFromRows,
  formatConversationCursor,
  parseConversationCursor,
} from "./conversation.js";
import { purgePodSessionData } from "./session-data.js";
import {
  cancelCapacityWait,
  capacityWaitPhase,
  getCapacityWait,
  toWaitView,
  type CapacityWaitRow,
  type WaitStore,
} from "./capacity-wait.js";
import { parseLaunchFailureCode } from "./provision-failure.js";
import {
  SEND_MAX_BYTES,
  assertSafeReceivePath,
  assertSendEntriesWithinLimit,
  assertReceiveRateLimit,
  assertSendRateLimit,
  decodeCanonicalBase64,
  decodeReceiveManifest,
  posixDirname,
  posixJoin,
  receiveManifestSource,
  sendPlacerSource,
  symlinkEscapesWorkdir,
  type ReceiveEntry,
  type SendEntry,
} from "./files.js";
import { clientFacingConfig, readLayer, type ClientFacingConfig } from "../settings/merge.js";
import type { ResolvedConfigReport, WorkspaceSeedReport } from "./types.js";
import { recordPodTimings, recordWorkspaceSeed } from "./lifecycle.js";
import type { Sandbox } from "../../core/providers/types.js";
import {
  WorkspaceCloneBody,
  archiveAuditDetail,
  assertCloneHostAllowed,
  assertWorkspaceSeedRateLimit,
  cloneAuditDetail,
  decodeWorkspaceArchiveResult,
  decodeWorkspaceCloneResult,
  inspectWorkdir,
  parseCloneUrl,
  redactCredential,
  spoolArchiveToTempFile,
  workspaceArchiveExtractSource,
  workspaceArchiveLimits,
  workspaceCloneSource,
  workspaceNotEmptyError,
  workspaceSeedGateOpen,
  type WorkspaceCloneCredential,
} from "./workspace-seed.js";
export { SEND_MAX_BYTES, assertSafeRelPath, assertSendEntriesWithinLimit } from "./files.js";
/** Base64 inflates ~4/3; leave headroom for entry metadata around the encoded payload. */
const SEND_BODY_LIMIT_BYTES = 34 * 1024 * 1024;

/**
 * The frozen launch report as a client receives it: the stored one with its config projected
 * through {@link clientFacingConfig}, so `providers` never leaves the server.
 */
export function clientFacingReport(
  report: ResolvedConfigReport,
): Omit<ResolvedConfigReport, "config"> & { config: ClientFacingConfig } {
  return { ...report, config: clientFacingConfig(report.config) };
}

export type PodPreparationPhase =
  | "preparing-image"
  | "provisioning-sandbox"
  | "waiting-for-capacity"
  | "running-init"
  | "ready"
  | "failed";

export function podPreparationPhase(
  pod: Pick<PodRow, "state" | "provider_state" | "resolved_config">,
): PodPreparationPhase | null {
  if (pod.provider_state === "error") return "failed";
  if (pod.state !== "active") return null;
  if (pod.provider_state === "preparing_image") return "preparing-image";
  if ((pod.resolved_config.initSteps ?? []).some((step) => step.status === "running")) return "running-init";
  if (["provisioning", "starting"].includes(pod.provider_state)) return "provisioning-sandbox";
  if (pod.provider_state === "started") return "ready";
  return null;
}

export function podConnection(
  pod: PodRow,
  gateway: GatewayService | null,
): "connected" | "reconnecting" | "detached" | "asleep" {
  if (pod.state === "active" && ["stopped", "archived"].includes(pod.provider_state)) return "asleep";
  if (pod.state !== "active" || pod.provider_state !== "started") return "detached";
  if (gateway?.liveSession(pod.id)) return "connected";
  const heartbeatMs = pod.gateway_heartbeat_at ? Date.parse(pod.gateway_heartbeat_at) : NaN;
  if (pod.gateway_id && Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs < LEASE_STALE_SECONDS * 1000) {
    return "connected";
  }
  return "reconnecting";
}

function toApi(pod: PodRow, gateway: GatewayService | null = null) {
  const hostPodName = (pod as PodRow & { host_pod_name?: string | null }).host_pod_name ?? null;
  return {
    id: pod.id,
    templateId: pod.template_id,
    userId: pod.user_id,
    parentPodId: pod.parent_pod_id ?? null,
    hostPodId: pod.host_pod_id ?? null,
    hostPodName,
    // One display-oriented answer to "where does this pod live": the provider name for
    // machine-backed pods, `on <host>` for co-located ones. Clients print it verbatim.
    location: pod.host_pod_id ? `on ${hostPodName ?? "host"}` : pod.provider,
    lineageDepth: pod.lineage_depth,
    forkedFromPodId: pod.forked_from_pod_id ?? null,
    name: pod.name,
    project: pod.project ?? null,
    provider: pod.provider,
    state: pod.state,
    ready: pod.state === "active" && pod.provider_state === "started",
    connection: podConnection(pod, gateway),
    initializing:
      pod.state === "active" && ["preparing_image", "provisioning", "starting"].includes(pod.provider_state),
    preparationPhase: podPreparationPhase(pod),
    // The raw provider layer, so clients can tell an asleep pod (a stopped or archived
    // sandbox under an active pod) apart from one that is starting — and can label the
    // wake by its cost: a stopped sandbox restarts in seconds, an archived one in minutes.
    sandboxState: pod.provider_state,
    stateReason: pod.state_reason ?? null,
    // Typed launch-failure code when the failure recorder classified the
    // outcome (capacity_wait_expired / capacity_wait_orphaned); null for
    // every other failure, which stays exactly as before.
    stateReasonCode: parseLaunchFailureCode(pod.state_reason),
    lastActivityAt: pod.last_activity_at,
    createdAt: pod.created_at,
    resolvedConfig: {
      workdir: pod.resolved_config.workdir,
      clamps: pod.resolved_config.clamps,
      configProvenance: pod.resolved_config.configProvenance ?? [],
      layerOrder: pod.resolved_config.layerOrder ?? [],
      secretKeys: pod.resolved_config.secretKeys,
      secretScopes: pod.resolved_config.secretScopes ?? null,
      secretShadows: pod.resolved_config.secretShadows ?? null,
      initSteps: pod.resolved_config.initSteps ?? null,
      piAuthProviders: pod.resolved_config.piAuthProviders ?? null,
      piSettings: pod.resolved_config.piSettings ?? null,
      egress: pod.resolved_config.egress,
      timings: pod.resolved_config.timings ?? null,
      reused: pod.resolved_config.reused ?? false,
      reuseRefused: pod.resolved_config.reuseRefused ?? null,
      warnings: pod.resolved_config.warnings,
      idleTimeoutMinutes: pod.resolved_config.retention?.idleTimeoutMinutes ?? pod.resolved_config.config?.idleTimeoutMinutes,
      providerIdleTimeoutMinutes: pod.resolved_config.retention?.providerIdleTimeoutMinutes ?? null,
      idleTimeoutMinimumApplied: pod.resolved_config.retention?.providerIdleTimeoutMinimumApplied ?? false,
      archiveAfterMinutes:
        pod.resolved_config.retention?.effectiveArchiveAfterMinutes ??
        pod.resolved_config.config?.archiveAfterMinutes,
      archiveTransition: pod.resolved_config.retention?.archiveTransition,
      providerExpiryDocumented: pod.resolved_config.retention?.providerExpiryDocumented,
      // Deprecated v1 compatibility field; canonical clients use minutes. Retention is
      // minutes-only in the config type now, but rows stored before that can still hold days
      // and nothing else — so the fallback reads a key the type no longer names.
      archiveAfterDays:
        pod.resolved_config.config?.archiveAfterMinutes !== undefined
          ? pod.resolved_config.config.archiveAfterMinutes / (24 * 60)
          : (pod.resolved_config.config as { archiveAfterDays?: number } | undefined)?.archiveAfterDays,
      image: pod.resolved_config.config?.image,
      imagePreparation: pod.resolved_config.image ?? null,
      bake: pod.resolved_config.bake ?? null,
      workspaceSeed: pod.resolved_config.workspaceSeed ?? null,
    },
    // The frozen launch report is safe to expose once its provider blocks are projected out:
    // secret values and Pi file/package contents never enter it. Keep resolvedConfig above as
    // the compatibility projection.
    report: clientFacingReport(pod.resolved_config),
  };
}

function withoutOutput<T extends { outputTail?: string }>(step: T): Omit<T, "outputTail"> {
  const { outputTail: _output, ...rest } = step;
  return rest;
}

/**
 * A pod as an org member who neither owns nor manages it sees it: its state, not what its
 * scripts printed, which can be anything the owner's code wrote (a failed init's first line
 * stays as the reason).
 */
function peerView(api: ReturnType<typeof toApi>): ReturnType<typeof toApi> {
  const { resolvedConfig, report } = api;
  return {
    ...api,
    stateReason: api.stateReason?.split("\n")[0] ?? null,
    resolvedConfig: {
      ...resolvedConfig,
      initSteps: resolvedConfig.initSteps?.map(withoutOutput) ?? null,
      bake: resolvedConfig.bake ? withoutOutput(resolvedConfig.bake) : resolvedConfig.bake,
    },
    report: {
      ...report,
      ...(report.initSteps ? { initSteps: report.initSteps.map(withoutOutput) } : {}),
      ...(report.bake ? { bake: withoutOutput(report.bake) } : {}),
    },
  };
}

function viewFor(api: ReturnType<typeof toApi>, auth: AuthContext): ReturnType<typeof toApi> {
  return api.userId === auth.userId || hasPermission(auth.permissions, "pods:manage_any") ? api : peerView(api);
}

function launchAdmissionRefusal(error: unknown): { retryable: boolean; code: string } | null {
  if (!(error instanceof HttpError) || error.statusCode !== 503) return null;
  if (!error.detail || typeof error.detail !== "object" || Array.isArray(error.detail)) return null;
  const detail = error.detail as Record<string, unknown>;
  if (detail["kind"] !== "admission"
      || detail["resource"] !== "transitions"
      || detail["unit"] !== "count"
      || typeof detail["retryable"] !== "boolean") return null;
  const rawCode = detail["reason"] ?? detail["code"];
  const code = typeof rawCode === "string"
    && BOAT_HOST_DEMAND_REASONS.includes(rawCode as typeof BOAT_HOST_DEMAND_REASONS[number])
    ? rawCode : "";
  if (!code) return null;
  return { retryable: detail["retryable"], code };
}

async function admittedLaunch(
  operation: LaunchOperationRow,
  gateway: GatewayService | null,
) {
  if (!operation.pod_id) return null;
  let pod: PodRow;
  try {
    pod = await getPod(operation.org_id, operation.pod_id);
  } catch (error) {
    // An admitted pod can be hard-deleted between the operation read and the
    // pod lookup. This is not a missing launch operation.
    if (error instanceof HttpError && error.statusCode === 404) return null;
    throw error;
  }
  // Normal deletion retains the row for audit/history but removes its runtime.
  // A replay must not reopen a pod that no longer exists for the user.
  if (pod.provider_state === "gone") return null;
  return { pod: toApi(pod, gateway), report: clientFacingReport(pod.resolved_config) };
}

async function admittedLaunchResponse(
  operation: LaunchOperationRow,
  gateway: GatewayService | null,
) {
  const launch = await admittedLaunch(operation, gateway);
  if (!launch) throw gone("this launch was admitted, but its pod is no longer available");
  return launch;
}

export async function launchOperationStatusView(
  operation: LaunchOperationRow,
  gateway: GatewayService | null,
): Promise<Record<string, unknown>> {
  const launch = operation.state === "admitted" ? await admittedLaunch(operation, gateway) : null;
  return {
    operationId: operation.operation_id,
    state: operation.state,
    ...(launch ? { launch } : {}),
    ...(operation.state === "admitted" && !launch ? { podDeleted: true } : {}),
    ...(operation.error_status ? { errorStatus: operation.error_status } : {}),
    ...(operation.error_code ? { errorCode: operation.error_code } : {}),
  };
}

function goneClientUpgrade() {
  return gone("client_upgrade_required", {
    code: "client_upgrade_required",
    message: "This client is too old to manage model credentials. Update pi pod.",
  });
}

async function retiredPiAuthRoute(): Promise<never> {
  throw goneClientUpgrade();
}

/**
 * A pod token acts under its owner's account, so every ownership check a route already makes
 * passes for it. This is the narrowing that makes it less privileged than its owner: the pods
 * it launched, and nothing else in the org.
 */
async function assertPodTokenScope(
  pod: PodRow,
  auth: AuthContext,
  action: string,
  opts: { allowSelf?: boolean } = {},
): Promise<void> {
  if (!auth.podId) return;
  await assertPodTokenReach(
    { query },
    { orgId: auth.orgId, callerPodId: auth.podId, podId: pod.id, action, ...opts },
  );
}


/**
 * The Pi selection one launch may make: model, thinking level, and the resource files the pod
 * loads. Strict on purpose — an unrecognized key is a client asking for something this server
 * does not do, and answering 400 is how a newer client learns that before it launches.
 */
export const PiLaunchOverridesSchema = z
  .object({
    model: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim() === value && !value.startsWith("-"), {
        message: "model must not have surrounding whitespace or start with '-'",
      })
      .optional(),
    thinking: z.enum(ACCOUNT_THINKING_LEVELS).optional(),
    ...PI_RESOURCE_OVERRIDE_FIELDS,
  })
  .strict();

/**
 * Whether a launch request carries inputs the server no longer applies. A bare project name is
 * identity — what a project's pod listing and reuse go by — not one of the retired settings.
 */
function retiredLaunchInputs(body: {
  project?: Record<string, unknown> | undefined;
  piSettings?: unknown;
  hostConfig?: unknown;
  hostEnv?: unknown;
}): boolean {
  const { name: _name, ...projectSettings } = body.project ?? {};
  return (
    Object.keys(projectSettings).length > 0 ||
    body.piSettings !== undefined ||
    body.hostConfig !== undefined ||
    body.hostEnv !== undefined
  );
}

/** Account launches expose exactly the provider adapters vendored into the server. */
export const PodProviderSchema = z.enum(supportedProviders() as [string, ...string[]]);

export const ForkFromSchema = z
  .object({
    podId: z.string().uuid(),
    sessionPath: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => /^[A-Za-z0-9._@/-]+$/.test(value) && !value.split("/").some((s) => s === "" || s === "." || s === ".."), {
        message: "sessionPath must be a relative session path with safe path segments",
      })
      .optional(),
  })
  .strict();

export const ResolveQuerySchema = z.object({
  check_image: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
});

export const LaunchBody = z
  .object({
    /** Selects an optional server-resident template bundle. */
    templateId: z.string().uuid().nullish(),
    provider: PodProviderSchema.nullish(),
    /**
     * Co-located placement: run this pod as processes on an existing pod's machine.
     * "self" is only meaningful for a pod token. Mutually exclusive with `provider`.
     */
    placement: z
      .object({ host: z.union([z.literal("self"), z.string().uuid()]) })
      .strict()
      .optional(),
    piOverrides: PiLaunchOverridesSchema.optional(),
    /** Retired machine inputs accepted and ignored for legacy-client compatibility. */
    hostConfig: z.unknown().optional(),
    hostEnv: z.unknown().optional(),
    /** Retired Pi files are deliberately not validated because they are never applied. */
    piSettings: z.unknown().optional(),
    /** Legacy project identity; all settings-shaped children are accepted and ignored. */
    project: z
      .object({
        name: z.string().min(1).max(512),
        config: z.unknown().optional(),
        env: z.unknown().optional(),
        initScript: z.unknown().optional(),
        bakeScript: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    forkFrom: ForkFromSchema.optional(),
    /**
     * The client will seed the workdir through `/pods/:id/workspace/{clone,archive}` right after
     * provisioning. Pi is held until that seed completes, is skipped, or the gate times out.
     */
    workspaceSeed: z.boolean().optional(),
  })
  .strict();

const LaunchRequestBody = LaunchBody.extend({ operationId: z.string().uuid().optional() }).strict();

/** In-process guard: one seed per pod at a time; a second caller gets 409, not a queue. */
const activeWorkspaceSeeds = new Set<string>();

/** Anything thrown while a credential is in scope goes out with the credential scrubbed. */
function redactThrown(error: unknown, credential: WorkspaceCloneCredential | null | undefined): unknown {
  if (!credential) return error;
  if (error instanceof HttpError) {
    const detail =
      typeof error.detail === "string" ? redactCredential(error.detail, credential) : error.detail;
    return new HttpError(error.statusCode, redactCredential(error.message, credential), detail);
  }
  if (error instanceof Error) {
    const scrubbed = new Error(redactCredential(error.message, credential));
    scrubbed.name = error.name;
    return scrubbed;
  }
  return new Error(redactCredential(String(error), credential));
}

/** A script that died without its JSON trailer (traceback, OOM kill): report its output tail instead. */
function isMalformedSeedOutput(error: unknown): boolean {
  return error instanceof HttpError && error.statusCode === 400 && /invalid (clone|archive) result/.test(error.message);
}

function seedFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message, 512);
}

export function registerPodRoutes(
  app: FastifyInstance,
  deps: PodServiceDeps,
  gateway: GatewayService | null,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Pod tokens may launch (nested pods): the server keeps custody of the provider credential
  // and records the calling pod as the child's parent, so the tree bounds quota and audit.
  r.post(
    "/pods",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      // Keep the legacy body allowance during the ignore-with-warning compatibility window.
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        // Known retired fields remain explicit so version-skew clients are accepted; unknown
        // body shapes still fail instead of silently launching a billable default pod.
        body: LaunchRequestBody,
      },
    },
    async (req, reply) => {
      if (!req.auth.podId) requirePermission(req.auth, "pods:launch");
      if (req.body.operationId) {
        // The first idempotent contract covers the native empty/template launch
        // path only. Other launch shapes keep their established unkeyed flow.
        const unsupported = Object.keys(req.body).filter(
          (key) => key !== "operationId" && key !== "templateId",
        );
        if (req.auth.podId || unsupported.length > 0) {
          throw badRequest("idempotent launch currently supports template selection only");
        }
        // PostgreSQL normalizes uuid columns to lowercase. Do it before the
        // frozen-input comparison so an uppercase retry stays the same launch.
        const operationId = req.body.operationId.toLowerCase();
        const templateId = req.body.templateId?.toLowerCase() ?? null;
        const reservation = await reserveLaunchOperation({
          orgId: req.auth.orgId,
          userId: req.auth.userId,
          operationId,
          templateId,
        });
        if (reservation.kind === "existing") {
          const operation = reservation.operation;
          if (operation.state === "admitted") {
            return reply.code(200).send(await admittedLaunchResponse(operation, gateway));
          }
          if (operation.state === "rejected") {
            throw new HttpError(
              operation.error_status ?? 409,
              "launch operation was rejected; start a new launch to try again",
              { operationId: operation.operation_id, code: operation.error_code ?? "launch_rejected" },
            );
          }
          return reply.code(202).send(await launchOperationStatusView(operation, gateway));
        }
        const claim: LaunchOperationClaim = reservation.claim;
        try {
          const { pod, report } = await launchPod(deps, {
            orgId: req.auth.orgId,
            userId: req.auth.userId,
            templateId,
            launchOperation: claim,
          });
          return reply.code(201).send({ pod: toApi(pod, gateway), report: clientFacingReport(report) });
        } catch (error) {
          const current = await getLaunchOperation({
            orgId: req.auth.orgId, userId: req.auth.userId, operationId: claim.operationId,
          }).catch(() => null);
          if (current?.state === "admitted") {
            return reply.code(200).send(await admittedLaunchResponse(current, gateway));
          }
          const admissionRefusal = launchAdmissionRefusal(error);
          if (admissionRefusal?.retryable) {
            await finishLaunchOperation(claim, {
              state: "waiting", status: 503, code: admissionRefusal.code,
            }).catch(() => {});
          } else if (admissionRefusal
              || (error instanceof HttpError && error.statusCode >= 400 && error.statusCode < 500)) {
            await finishLaunchOperation(claim, {
              state: "rejected", status: error instanceof HttpError ? error.statusCode : 409,
              code: admissionRefusal?.code ?? "launch_rejected",
            }).catch(() => {});
          } else {
            await finishLaunchOperation(claim, { state: "unknown", code: "launch_outcome_unknown" }).catch(() => {});
          }
          throw error;
        }
      }
      if (req.body.forkFrom) {
        const source = await getPod(req.auth.orgId, req.body.forkFrom.podId);
        await assertPodAccess(source, req.auth);
        await assertPodTokenScope(source, req.auth, "fork");
      }
      if (req.body.placement) {
        if (req.body.provider) {
          throw badRequest("placement chooses the host provider; do not also name a provider");
        }
        if (req.body.forkFrom) {
          throw badRequest("forking into a co-located pod is not supported yet");
        }
        if (req.body.workspaceSeed) {
          throw badRequest("co-located pods share their host's machine and are not seeded");
        }
        const hostRef = req.body.placement.host;
        if (hostRef === "self" && !req.auth.podId) {
          throw badRequest('placement.host "self" is only meaningful for a pod token');
        }
        const namedId = hostRef === "self" ? req.auth.podId! : hostRef;
        const named = await getPod(req.auth.orgId, namedId);
        await assertPodAccess(named, req.auth);
        await assertPodTokenScope(named, req.auth, "place a pod on", { allowSelf: true });
        const host = await resolvePlacementHost(req.auth.orgId, named.id);
        if (host.id !== named.id) {
          // Flattening is physics, not a new authorization: `--on self` from a co-located
          // child names itself (in scope) and must land on the ancestor machine. Re-applying
          // descendant scope to the host would forbid the ratified nest. Ownership still
          // has to match — the machine belongs to the same user.
          await assertPodAccess(host, req.auth);
        }
        const { pod, report } = await launchHostChild(deps, {
          orgId: req.auth.orgId,
          userId: req.auth.userId,
          hostPod: host,
          parentPodId: req.auth.podId ?? null,
          templateId: req.body.templateId ?? null,
          project: req.body.project
            ? { name: req.body.project.name, config: {}, env: {}, initScript: "", bakeScript: "" }
            : null,
          legacyLaunchInputsPresent: retiredLaunchInputs(req.body),
          piOverrides: req.body.piOverrides ?? null,
        });
        return reply.code(201).send({ pod: toApi(pod, gateway), report: clientFacingReport(report) });
      }
      const { pod, report } = await launchPod(deps, {
        orgId: req.auth.orgId,
        userId: req.auth.userId,
        // Never from the body: a pod's parentage is its authenticated identity.
        parentPodId: req.auth.podId ?? null,
        templateId: req.body.templateId ?? null,
        project: req.body.project
          ? { name: req.body.project.name, config: {}, env: {}, initScript: "", bakeScript: "" }
          : null,
        legacyLaunchInputsPresent: retiredLaunchInputs(req.body),
        provider: req.body.provider ?? null,
        piOverrides: req.body.piOverrides ?? null,
        forkFrom: req.body.forkFrom ?? null,
        workspaceSeed: req.body.workspaceSeed ?? false,
      });
      return reply.code(201).send({ pod: toApi(pod, gateway), report: clientFacingReport(report) });
    },
  );

  r.get(
    "/launch-operations/:operationId",
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ operationId: z.string().uuid() }) },
    },
    async (req, reply) => {
      let operation: LaunchOperationRow;
      const operationId = req.params.operationId.toLowerCase();
      try {
        operation = await getLaunchOperation({
          orgId: req.auth.orgId,
          userId: req.auth.userId,
          operationId,
        });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 404) {
          return reply.send({ operationId, state: "not_found" });
        }
        throw error;
      }
      return reply.send(await launchOperationStatusView(operation, gateway));
    },
  );

  // Durable fire-and-forget delivery for mobile. This route deliberately works before the
  // sandbox exists: the gateway claims the row once Pi is ready, so closing the app cannot
  // strand the user's first message on the phone.
  r.post(
    "/pods/:id/prompts",
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          text: z.string().min(1).max(64 * 1024),
          id: z.string().uuid().optional(),
          /** "provider/id" to run this prompt on, when pi in the pod offers it. */
          model: z.string().regex(/^[^/\s]+\/\S+$/).max(512).optional(),
        }).strict(),
      },
    },
    async (req, reply) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      const text = req.body.text.trim();
      if (!text) throw badRequest("prompt must contain non-whitespace text");
      const id = req.body.id?.toLowerCase() ?? uuidv7();
      // Same-ID retries return the original durable admission while its row is
      // retained. Never overwrite status or text: the UUID is an idempotency
      // key, not a mutable queue row.
      const inserted = await query<{ created_at: string | Date; status: string }>(
        `INSERT INTO queued_prompts (id, pod_id, user_id, text, model)
         SELECT $1, $2, $3, $4, $5
         WHERE EXISTS (
           SELECT 1 FROM pods
           WHERE id = $2 AND state = 'active'
             AND provider_state NOT IN ('error', 'gone')
         )
         ON CONFLICT (id) DO NOTHING
         RETURNING created_at, status`,
        [id, pod.id, req.auth.userId, text, req.body.model ?? null],
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await query<{
          pod_id: string; user_id: string; text: string; created_at: string | Date; status: string;
        }>(
          `SELECT pod_id, user_id, text, created_at, status
           FROM queued_prompts WHERE id = $1`,
          [id],
        );
        const previous = existing.rows[0];
        if (!previous) {
          if (pod.state !== "active" || pod.provider_state === "error" || pod.provider_state === "gone") {
            throw conflict("this pod cannot accept a queued prompt in its current state");
          }
          throw conflict("queued prompt id could not be admitted");
        }
        if (previous.pod_id !== pod.id || previous.user_id !== req.auth.userId
            || previous.text !== text) {
          throw conflict("queued prompt id conflicts with another request");
        }
        row = { created_at: previous.created_at, status: previous.status };
      } else {
        await audit({
          orgId: req.auth.orgId,
          actorId: req.auth.userId,
          action: "pod.prompt.queue",
          targetType: "pod",
          targetId: pod.id,
          detail: { queuedPromptId: id },
        });
      }

      // In an all-in-one deployment this makes a ready pod effectively immediate. Split API
      // roles rely on the owning gateway's short delivery poll, using the same durable row.
      if (gateway && pod.provider_state === "started") {
        void gateway.ensureSession(req.auth.orgId, pod.id).catch(() => {});
      }
      return reply.code(202).send({
        id,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
      });
    },
  );

  r.get(
    "/pods/:id/prompts/:promptId",
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid(), promptId: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      const found = await query<{
        id: string; status: string; created_at: string | Date;
      }>(
        `SELECT id, status, created_at FROM queued_prompts
         WHERE id = $1 AND pod_id = $2 AND user_id = $3`,
        [req.params.promptId, pod.id, req.auth.userId],
      );
      const row = found.rows[0];
      if (!row) throw notFound("queued prompt not found");
      return reply.send({
        id: row.id,
        status: row.status,
        createdAt: new Date(row.created_at).toISOString(),
      });
    },
  );

  // Reuse a stopped pod for a fresh launch of the same project (§6.5). Ineligible pods
  // answer 409 and a refused refresh returns the pod to stopped with reuseRefused in its
  // report — either way the client falls back to a plain POST /pods.
  r.post(
    "/pods/:id/reuse",
    {
      preHandler: [app.authenticate],
      bodyLimit: 2 * 1024 * 1024,
      schema: { params: z.object({ id: z.string().uuid() }), body: LaunchBody },
    },
    async (req, reply) => {
      requirePermission(req.auth, "pods:launch");
      if (req.body.forkFrom) {
        throw badRequest("forking cannot be combined with pod reuse");
      }
      const { pod, report } = await reusePod(deps, {
        podId: req.params.id,
        orgId: req.auth.orgId,
        userId: req.auth.userId,
        templateId: req.body.templateId ?? null,
        project: req.body.project
          ? { name: req.body.project.name, config: {}, env: {}, initScript: "", bakeScript: "" }
          : null,
        legacyLaunchInputsPresent: retiredLaunchInputs(req.body),
        provider: req.body.provider ?? null,
        piOverrides: req.body.piOverrides ?? null,
      });
      return reply.code(200).send({ pod: toApi(pod, gateway), report: clientFacingReport(report) });
    },
  );

  // Dry-run twin of POST /pods: same merge, clamps, and credential check, no pod row.
  // Clients call this so `pi-pod --dry-run` and doctor report the server's answer,
  // not a local approximation that can drift from what launch will actually do.
  r.post(
    "/pods/resolve",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        // Query rather than body keeps new clients compatible with older strict-body servers.
        querystring: ResolveQuerySchema,
        body: z
          .object({
            templateId: z.string().uuid().optional(),
            provider: PodProviderSchema.optional(),
            piOverrides: PiLaunchOverridesSchema.optional(),
            /** Project resolve inputs layer over a template; retired host inputs are ignored. */
            projectConfig: z.record(z.unknown()).optional(),
            hostConfig: z.unknown().optional(),
            hostEnv: z.unknown().optional(),
            projectEnv: z.unknown().optional(),
            projectBakeScript: z.unknown().optional(),
            piSettings: z.unknown().optional(),
            forkFrom: ForkFromSchema.optional(),
          })
          .strict(),
      },
    },
    async (req) => {
      if (!req.auth.podId) requirePermission(req.auth, "pods:launch");
      if (req.body.forkFrom) {
        const source = await getPod(req.auth.orgId, req.body.forkFrom.podId);
        await assertPodAccess(source, req.auth);
        await assertPodTokenScope(source, req.auth, "fork");
      }
      const plan = await planPodLaunch(deps, {
        orgId: req.auth.orgId,
        userId: req.auth.userId,
        delegation: req.auth.podId
          ? await parentDelegation({ query }, { orgId: req.auth.orgId, parentPodId: req.auth.podId })
          : null,
        templateId: req.body.templateId ?? null,
        projectConfigRaw: req.body.projectConfig ?? null,
        legacyLaunchInputsPresent:
          req.body.hostConfig !== undefined ||
          req.body.hostEnv !== undefined ||
          req.body.projectEnv !== undefined ||
          req.body.projectBakeScript !== undefined ||
          req.body.piSettings !== undefined,
        provider: req.body.provider ?? null,
        piOverrides: req.body.piOverrides ?? null,
      });
      const envVar = PROVIDER_CREDENTIAL_VARS[plan.providerName] ?? `credential for ${plan.providerName}`;
      let imageStatus: "ready" | "missing-buildable" | "missing-custom" | "unavailable" = "unavailable";
      if (plan.credential && req.query.check_image) {
        const exists = await withProviderCredential({
          sandboxHostId: plan.sandboxHostId,
          ownerUserId: req.auth.userId,
          kek: deps.kek,
          platformEnv: platformCredentialsOf(deps),
          orgId: req.auth.orgId,
          provider: plan.providerName,
          providerConfig: plan.config.providers[plan.providerName] ?? {},
          fn: async (provider) => Boolean(await provider.resolveImage(plan.imageRecipe.ref)),
        });
        imageStatus = exists
          ? "ready"
          : plan.imageRecipe.managed && plan.imageBuildable
            ? "missing-buildable"
            : plan.imageRecipe.managed
              ? "unavailable"
              : "missing-custom";
      }
      return {
        provider: plan.providerName,
        template: plan.template ? { id: plan.template.id, name: plan.template.name } : null,
        config: clientFacingConfig(plan.config),
        // Echoed whole, exactly as validated: a client verifies its own selection here — arrays
        // included, in order — so a server that would silently drop part of it is caught by a
        // dry run instead of by a pod that comes up without the resources it asked for.
        piOverrides: req.body.piOverrides ?? null,
        clamps: plan.clamps,
        warnings: plan.report.warnings,
        idleTimeoutMinutes: plan.report.retention?.idleTimeoutMinutes ?? plan.config.idleTimeoutMinutes,
        providerIdleTimeoutMinutes: plan.report.retention?.providerIdleTimeoutMinutes ?? null,
        idleTimeoutMinimumApplied: plan.report.retention?.providerIdleTimeoutMinimumApplied ?? false,
        credential: {
          envVar,
          available: plan.credential !== null,
          source: plan.credential?.source ?? null,
        },
        secretKeys: plan.report.secretKeys,
        secretScopes: plan.report.secretScopes ?? null,
        secretShadows: plan.report.secretShadows ?? null,
        initSteps: (plan.report.initSteps ?? []).map((s) => ({ scope: s.scope })),
        bake: plan.report.bake ? { digest: plan.report.bake.digest } : null,
        piAuthProviders: plan.report.piAuthProviders ?? [],
        piSettings: plan.report.piSettings ?? null,
        workdir: plan.workdir,
        image: plan.config.image,
        imageStatus,
        imageManaged: plan.imageRecipe.managed,
        imageProvenance: plan.imageRecipe.provenance,
        imageResources: plan.imageRecipe.effectiveResources ?? null,
        egress: { mode: plan.config.egress.mode },
        // What the agent will be told about the template; null when it has no instructions.
        agentInstructions: plan.report.agentInstructions ?? null,
        settingsContract: "server-bundles-v1",
        configProvenance: plan.report.configProvenance,
        layerOrder: plan.report.layerOrder,
        /** Compatibility alias for clients predating the frozen report field. */
        provenance: plan.report.configProvenance,
        forkFrom: req.body.forkFrom
          ? { podId: req.body.forkFrom.podId, sessionPath: req.body.forkFrom.sessionPath ?? null }
          : null,
      };
    },
  );

  r.get(
    "/pods",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        querystring: z.object({
          state: z.enum(["active", "archived"]).optional(),
          mine: z.coerce.boolean().default(false),
          /** Pod tokens only: this pod and its descendants. Enforced for them either way. */
          lineage: z.literal("self").optional(),
          /** Scope to one project's pods (account-mode-spec §7): the CLI's project-scoped `ls`. */
          project: z.string().max(512).optional(),
          /** Pods launched from one template — an org's "who is using this environment?". */
          templateId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          /** Cursor: pods less recently active than this timestamp (see lastActivityAt/createdAt). */
          before: z.string().datetime({ offset: true }).optional(),
          /**
           * Include provider_state 'gone' rows (default false). Failed
           * launches that never acquired compute converge to
           * archived+gone: gc and diagnostics opt in to see them; normal
           * listings keep omitting them exactly as before.
           */
          includeGone: z.coerce.boolean().default(false),
        }),
      },
    },
    async (req) => {
      if (req.query.lineage && !req.auth.podId) {
        throw badRequest("lineage=self is meaningful only for a pod token — a user session has no self pod");
      }
      const rows = await listPods({
        orgId: req.auth.orgId,
        state: req.query.state ?? null,
        userId: req.query.mine ? req.auth.userId : null,
        before: req.query.before ?? null,
        limit: req.query.limit,
        project: req.query.project ?? null,
        templateId: req.query.templateId ?? null,
        lineageRootPodId: req.auth.podId ?? null,
        includeGone: req.query.includeGone,
      });
      return { pods: rows.map((row) => viewFor(toApi(row, gateway), req.auth)) };
    },
  );

  // `wait` long-polls: the response returns as soon as the pod is ready, failed, or anything
  // about it changed — or after `wait` ms. A 1s poll loop costs half a second of pure launch
  // latency on average at the tail; holding the request instead makes readiness near-instant.
  r.get(
    "/pods/:id",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          wait: z.coerce.number().int().min(0).max(25_000).default(0),
        }),
      },
    },
    async (req) => {
      const waitStore: WaitStore = {
        query: (text: string, params?: unknown[]) => query(text, params ?? []),
      };
      let pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodTokenScope(pod, req.auth, "inspect", { allowSelf: true });
      // Bounded capacity wait state (§6.6, capacity-contract.md): waiting vs
      // final-deadline failure, attempts, and cancel — null when never queued.
      let waitRow = await getCapacityWait(waitStore, pod.id).catch(() => null);
      if (req.query.wait > 0) {
        // Any wait-state change (attempts, reason, terminal outcome) wakes
        // the long poll, not just pod-row changes — launch progress against
        // the wait deadline would otherwise arrive a full poll late.
        const signature = podChangeSignature(pod, waitRow);
        const deadline = Date.now() + req.query.wait;
        const settled = (p: typeof pod): boolean =>
          (p.state === "active" && p.provider_state === "started") || p.state_reason != null;
        while (Date.now() < deadline && !settled(pod) && podChangeSignature(pod, waitRow) === signature) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          pod = await getPod(req.auth.orgId, req.params.id);
          waitRow = await getCapacityWait(waitStore, pod.id).catch(() => null);
        }
      }
      const api = viewFor(toApi(pod, gateway), req.auth);
      // A live wait promotes the launch phase: clients render
      // `waiting-for-capacity` with the wait view's validated
      // reason/required/available/unit/deadlineAt instead of the generic
      // `provisioning-sandbox`.
      const waitingPhase = capacityWaitPhase(pod, waitRow);
      return {
        ...api,
        ...(waitingPhase ? { preparationPhase: waitingPhase } : {}),
        capacityWait: waitRow ? toWaitView(waitRow, Date.now()) : null,
      };
    },
  );

  // Bounded capacity wait inspection + cancel (§6.6). Cancel is cooperative:
  // the waiter sees cancel_requested on its next heartbeat (≤10s) and ends
  // the wait. Create waits additionally cancel their host operation by key;
  // WAKE waits never touch the host — ending the wait ends the waiting only
  // (workspace, archive, and active jobs untouched; see capacity-wait kind).
  r.get(
    "/pods/:id/capacity-wait",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      await assertPodTokenScope(pod, req.auth, "inspect", { allowSelf: true });
      const waitStore: WaitStore = {
        query: (text: string, params?: unknown[]) => query(text, params ?? []),
      };
      const waitRow = await getCapacityWait(waitStore, pod.id);
      if (!waitRow) return reply.code(404).send({ error: "no capacity wait for this pod" });
      return toWaitView(waitRow, Date.now());
    },
  );

  r.delete(
    "/pods/:id/capacity-wait",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      await assertPodTokenScope(pod, req.auth, "delete");
      const waitStore: WaitStore = {
        query: (text: string, params?: unknown[]) => query(text, params ?? []),
      };
      // Synchronous: the wait finishes as `cancelled` (metric `cancelled`)
      // in this request — not at the waiter's next heartbeat. The waiter
      // loop (if still alive) sees the terminal row and runs host cleanup
      // by key without double-counting the outcome.
      const finished = await cancelCapacityWait(waitStore, pod.id);
      if (!finished) {
        const waitRow = await getCapacityWait(waitStore, pod.id);
        if (!waitRow) return reply.code(404).send({ error: "no capacity wait for this pod" });
        return { ...toWaitView(waitRow, Date.now()), cancelRequested: true };
      }
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "pod.capacity_wait_cancel",
        targetType: "pod",
        targetId: pod.id,
        detail: {},
      }).catch(() => {});
      const waitRow = await getCapacityWait(waitStore, pod.id);
      return { cancelled: true, capacityWait: waitRow ? toWaitView(waitRow, Date.now()) : null };
    },
  );

  function podChangeSignature(pod: PodRow, waitRow: CapacityWaitRow | null = null): string {
    return JSON.stringify([
      pod.state,
      pod.provider_state,
      pod.state_reason,
      pod.resolved_config,
      // Wait-queue progress (attempts, reason/detail refreshes, terminal
      // outcome, cancel) must wake a launch long-poll the same way a row
      // change does. Host-internal fields (operation key, host URL) stay out.
      waitRow
        ? [
            waitRow.status,
            waitRow.attempts,
            waitRow.reason,
            waitRow.detail,
            waitRow.deadline_at,
            waitRow.cancel_requested,
          ]
        : null,
    ]);
  }

  // Pods poll this by revision instead of /pi-auth/fresh. The provider set is the
  // server-maintained contract; the lease is always the pod owner's, sanitized.
  // Pod tokens are welcome: this is their renewal window.
  r.get(
    "/pods/:id/model-credential-lease",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          revision: z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      // Usable credentials: a pod leases its own, never a descendant's.
      if (req.auth.podId && req.auth.podId !== pod.id) throw forbidden("pods lease only their own model credentials");
      const providerIds = pod.credential_providers ?? [];
      const { lease } = await acquireLease(
        deps.kek,
        { orgId: pod.org_id, userId: pod.user_id },
        providerIds,
        MIN_VALIDITY_MS,
      );
      if (req.query.revision === lease.revision) {
        return reply.code(304).send();
      }
      return {
        revision: lease.revision,
        providers: lease.providers,
      };
    },
  );

  r.patch(
    "/pods/:id",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ name: z.string().min(1).max(200) }).strict(),
      },
    },
    async (req) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      await assertPodTokenScope(pod, req.auth, "rename");
      await query("UPDATE pods SET name = $2, updated_at = now() WHERE id = $1", [pod.id, req.body.name]);
      gateway?.announcePodUpdated(pod.id, req.body.name);
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "pod.rename",
        targetType: "pod",
        targetId: pod.id,
        detail: {
          name: req.body.name,
          ...(req.auth.podId ? { fromPod: req.auth.podId } : {}),
        },
      });
      return { id: pod.id, name: req.body.name };
    },
  );

  // The explicit stop: releases compute now while preserving the active pod row and disk.
  // Archive stops a running pod too; client quit is never a stop.
  r.post(
    "/pods/:id/stop",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      await assertPodTokenScope(pod, req.auth, "stop");
      if (pod.state !== "active") throw conflict("restore the pod before stopping its sandbox");
      if (pod.provider_state === "stopped" || pod.provider_state === "archived") {
        return { id: pod.id, state: pod.provider_state };
      }
      if (pod.provider_state !== "started") throw conflict("pod is temporarily unavailable; retry shortly");
      const state = await stopStartedPod(pod, req.auth.userId);
      return { id: pod.id, state };
    },
  );

  async function stopStartedPod(pod: PodRow, actorId: string) {
    await gateway?.closePod(pod.id, "explicit_stop");
    if (gateway) {
      // Stopping a host takes its machine down; co-located children's sessions end as
      // asleep, not as a transport loss their clients would immediately retry.
      for (const childId of await startedHostChildIds(pod.id).catch(() => [])) {
        await gateway.closePod(childId, "host_stopped").catch(() => {});
      }
    }
    return runProviderPodCommand(deps, pod, "stop", actorId);
  }

  for (const action of ["archive", "restore"] as const) {
    r.post(
      `/pods/:id/${action}`,
      {
        preHandler: [app.authenticate],
        config: { allowPodToken: true },
        schema: { params: z.object({ id: z.string().uuid() }) },
      },
      async (req) => {
        let pod = await getPod(req.auth.orgId, req.params.id);
        await assertPodAccess(pod, req.auth);
        await assertPodTokenScope(pod, req.auth, action);
        await assertPodLifecycleAction({
          podId: pod.id,
          providerState: pod.provider_state,
          providerSandboxId: pod.provider_sandbox_id,
          action,
        });
        // A pod put away stops holding the host's memory and CPU. Hidden but still running, it
        // kept launches from fitting with nothing in `list` to say why.
        if (action === "archive" && pod.state === "active" && pod.provider_state === "started") {
          await stopStartedPod(pod, req.auth.userId);
          pod = await getPod(req.auth.orgId, pod.id);
        }
        if (action === "archive") {
          // Archiving a launch stuck in a bounded capacity wait ends the
          // wait as `cancelled` now; the waiter loop would otherwise run it
          // to `expired` against a row lifecycle no longer owns.
          const waitStore: WaitStore = {
            query: (text: string, params?: unknown[]) => query(text, params ?? []),
          };
          await cancelCapacityWait(waitStore, pod.id).catch(() => null);
        }
        const { state, cascaded } = await runPodLifecycleAction(pod, action, req.auth.userId);
        if (action === "archive") {
          await gateway?.closePod(pod.id, action);
          for (const childId of cascaded) {
            await gateway?.closePod(childId, action).catch(() => {});
          }
        }
        return { id: pod.id, state, cascaded, message: podLifecycleActionMessage(action) };
      },
    );
  }

  // Deleting a parent is never implicitly a delete of what it launched: live children refuse
  // the request and name themselves, and `?cascade=true` takes the subtree down deepest-first
  // so no pod outlives the sandbox its work depended on.
  r.delete(
    "/pods/:id",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          cascade: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
        }),
      },
    },
    async (req) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      await assertPodTokenScope(pod, req.auth, "delete");
      await assertPodLifecycleAction({
        podId: pod.id,
        providerState: pod.provider_state,
        providerSandboxId: pod.provider_sandbox_id,
        action: "delete",
      });

      const cascaded: string[] = [];
      if (req.query.cascade) {
        const descendants = await subtreeDeepestFirst(
          { query },
          { orgId: req.auth.orgId, podId: pod.id, includeSelf: false },
        );
        const subtree = await Promise.all(descendants.map((row) => getPod(req.auth.orgId, row.id)));
        for (const child of subtree) await assertPodAccess(child, req.auth);
        for (const child of subtree) {
          await assertPodLifecycleAction({
            podId: child.id,
            providerState: child.provider_state,
            providerSandboxId: child.provider_sandbox_id,
            action: "delete",
          });
        }
        for (const child of subtree) {
          if (child.provider_state === "gone") {
            await purgePodSessionData(child.id);
            continue;
          }
          await gateway?.closePod(child.id, "delete");
          await runProviderPodCommand(deps, child, "delete", req.auth.userId);
          await purgePodSessionData(child.id);
          cascaded.push(child.id);
        }
      } else {
        const children = await liveChildren({ query }, { orgId: req.auth.orgId, podId: pod.id });
        if (children.length > 0) {
          throw conflict(
            `pod ${pod.id} has ${children.length} live child pod(s); pass ?cascade=true to delete them too`,
            children.map((child) => ({ id: child.id, name: child.name, state: child.state })),
          );
        }
      }
      // A launch stuck in a bounded capacity wait ends here as `cancelled`
      // (metric `cancelled`), not at its deadline. The wait transition is
      // local-only; ambiguous provider attempts are never cancelled by key.
      const waitStore: WaitStore = {
        query: (text: string, params?: unknown[]) => query(text, params ?? []),
      };
      await cancelCapacityWait(waitStore, pod.id).catch(() => null);
      await gateway?.closePod(pod.id, "delete");
      await runProviderPodCommand(deps, pod, "delete", req.auth.userId);
      await purgePodSessionData(pod.id);
      // A deleted host destroyed its children's substrate: any still-stopped co-located rows
      // are gone now, not merely asleep. Their history remains readable until deleted.
      await query(
        `UPDATE pods SET provider_state = 'gone', provider_state_changed_at = now(),
           state_reason = 'the host machine was deleted', reaped_at = now(), updated_at = now()
         WHERE host_pod_id = $1 AND provider_state <> 'gone'
           AND NOT EXISTS (SELECT 1 FROM pod_create_attempts AS a WHERE a.pod_id=pods.id
             AND a.phase IN ('prepared','dispatching','unknown','sandbox_known',
                             'initialization_interrupted','legacy_unresolved','delete_pending'))`,
        [pod.id],
      );
      // Whatever remains below a deleted pod belongs to its parent now, so the tree a client
      // renders never hangs a pod off one that is gone.
      if (!req.query.cascade) {
        await tx((client) =>
          reparentChildren(client, {
            orgId: req.auth.orgId,
            podId: pod.id,
            grandparentPodId: pod.parent_pod_id,
          }),
        );
      }
      return { id: pod.id, state: "gone", deleted: true, cascaded };
    },
  );

  // `pi-pod send`, account edition: user JWT or a pod token sending to a strict descendant.
  r.post(
    "/pods/:id/files",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      bodyLimit: SEND_BODY_LIMIT_BYTES,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            entries: z
              .array(
                z
                  .object({
                    relPath: z.string().min(1).max(1024),
                    kind: z.enum(["file", "dir", "symlink"]),
                    contents: z.string().optional(),
                    mode: z.number().int().min(0).max(0o777).optional(),
                    target: z.string().max(4096).optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(10_000),
          })
          .strict(),
      },
    },
    async (req) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      if (req.auth.podId) {
        const policyRow = await readLayer("org_policy", req.auth.orgId, req.auth.orgId);
        const nested = nestedPodsPolicy(policyRow.config ?? {});
        if (!nested.allowFileSend) {
          throw forbidden("org policy nestedPods.allowFileSend is false");
        }
        await assertPodTokenScope(pod, req.auth, "send files to");
      }
      const entries = req.body.entries as SendEntry[];
      if (req.auth.podId && entries.some((entry) => entry.kind === "symlink")) {
        throw badRequest("pod tokens may not send symlinks");
      }
      for (const entry of entries) {
        if (entry.kind === "symlink") {
          if (!entry.target) throw badRequest(`symlink ${entry.relPath} names no target`);
          if (symlinkEscapesWorkdir(entry.relPath, entry.target)) {
            throw badRequest(`symlink ${entry.relPath} escapes the workdir`);
          }
        }
      }
      const bytes = assertSendEntriesWithinLimit(entries);
      assertSendRateLimit(req.auth.podId ?? req.auth.userId, bytes);

      await edition().ensurePodHostReady(deps, pod);
      const started = await ensureProviderPodStarted(deps, pod, req.auth.userId);
      const workdir = started.resolved_config.workdir;
      const staging = `/tmp/pi-pod-send-${uuidv7()}`;
      const placerPath = `${staging}/.placer.py`;
      const manifestPath = `${staging}/.manifest.json`;
      await withPodActivityLease(deps, started, () =>
        withPodSandbox(deps, started, async (sandbox) => {
          await sandbox.exec(["mkdir", "-p", staging], { timeoutMs: 60_000 });
          for (const entry of entries.filter((item) => item.kind === "file")) {
            const dest = posixJoin(staging, entry.relPath);
            await sandbox.exec(["mkdir", "-p", posixDirname(dest)], { timeoutMs: 60_000 });
            await sandbox.uploadFile(
              dest,
              decodeCanonicalBase64(entry.contents ?? "", entry.relPath),
              entry.mode ?? 0o644,
            );
          }
          const userSymlinks = req.auth.podId ? [] : entries.filter((item) => item.kind === "symlink");
          await sandbox.uploadFile(placerPath, Buffer.from(sendPlacerSource(), "utf8"), 0o700);
          await sandbox.uploadFile(
            manifestPath,
            Buffer.from(JSON.stringify(entries.filter((item) => item.kind !== "symlink")), "utf8"),
            0o600,
          );
          const placed = await sandbox.exec(["python3", placerPath, workdir, staging, manifestPath], {
            timeoutMs: 60_000,
          });
          if (placed.exitCode !== 0) {
            throw badRequest(placed.output?.trim() || "send placement failed");
          }
          for (const entry of userSymlinks) {
            const dest = posixJoin(workdir, entry.relPath);
            await sandbox.exec(["mkdir", "-p", posixDirname(dest)], { timeoutMs: 60_000 });
            await sandbox.exec(["ln", "-sfn", entry.target!, dest], { timeoutMs: 60_000 });
          }
          await sandbox.exec(["rm", "-rf", staging], { timeoutMs: 60_000 });
        }),
      );
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "pod.send",
        targetType: "pod",
        targetId: started.id,
        detail: {
          entries: entries.length,
          bytes,
          ...(req.auth.podId ? { fromPod: req.auth.podId } : {}),
        },
      });
      return { id: started.id, received: entries.length };
    },
  );

  // Inverse of `pi-pod send`: collect one workdir-relative tree and return bounded binary-safe
  // entries. A pod token already has terminal read access to descendants; this route keeps the
  // same strict subtree boundary while making that existing data flow usable for automation.
  r.get(
    "/pods/:id/files",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ path: z.string().min(1).max(1024) }).strict(),
      },
    },
    async (req) => {
      const requested = req.query.path;
      assertSafeReceivePath(requested);
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      if (req.auth.podId) {
        const policyRow = await readLayer("org_policy", req.auth.orgId, req.auth.orgId);
        const nested = nestedPodsPolicy(policyRow.config ?? {});
        if (!nested.allowFileReceive) {
          throw forbidden("org policy nestedPods.allowFileReceive is false");
        }
        await assertPodTokenScope(pod, req.auth, "receive files from");
      }
      await edition().ensurePodHostReady(deps, pod);
      const started = await ensureProviderPodStarted(deps, pod, req.auth.userId);
      const workdir = started.resolved_config.workdir;
      const result = await withPodActivityLease(deps, started, () =>
        withPodSandbox(deps, started, async (sandbox) => {
          const staging = `/tmp/pi-pod-receive-${uuidv7()}`;
          try {
            const manifestResult = await sandbox.exec(
              ["python3", "-c", receiveManifestSource(), workdir, requested, staging],
              { timeoutMs: 60_000 },
            );
            if (manifestResult.exitCode !== 0) {
              throw badRequest(manifestResult.output?.trim() || "receive inspection failed");
            }
            const manifest = decodeReceiveManifest(manifestResult.output ?? "");
            assertReceiveRateLimit(req.auth.podId ?? req.auth.userId, manifest.bytes);
            const entries: ReceiveEntry[] = [];
            for (const entry of manifest.entries) {
              if (entry.kind !== "file") {
                entries.push(entry);
                continue;
              }
              const source = entry.relPath === ""
                ? `${staging}/root`
                : posixJoin(staging, "tree", entry.relPath);
              const contents = await sandbox.downloadFile(source);
              const digest = createHash("sha256").update(contents).digest("hex");
              if (contents.byteLength !== entry.size || digest !== entry.sha256) {
                throw badRequest(`file changed while it was being received: ${entry.relPath || requested}`);
              }
              const { sha256: _snapshotDigest, ...publicEntry } = entry;
              entries.push({ ...publicEntry, contents: Buffer.from(contents).toString("base64") });
            }
            return { entries, bytes: manifest.bytes };
          } finally {
            await sandbox.exec(["rm", "-rf", staging], { timeoutMs: 60_000 });
          }
        }),
      );
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "pod.receive",
        targetType: "pod",
        targetId: started.id,
        detail: {
          entries: result.entries.length,
          bytes: result.bytes,
          path: requested,
          ...(req.auth.podId ? { fromPod: req.auth.podId } : {}),
        },
      });
      return { id: started.id, source: requested, entries: result.entries };
    },
  );

  // ---------------------------------------------------------------------------------------
  // Workspace seeding. `/files` stays for `pi-pod send`; these two routes fill an *empty*
  // workdir once, right after launch: a git clone the pod performs itself, or a streamed
  // tarball the server spools, uploads, and extracts under strict member validation. Both
  // refuse a populated workdir (409 workspace_not_empty) rather than merging into it.
  // ---------------------------------------------------------------------------------------
  const seedLimits = workspaceArchiveLimits(deps.env);
  const seedTimeoutMs = (deps.env.WORKSPACE_SEED_TIMEOUT_SECONDS ?? 600) * 1000;
  const seedGateTimeoutMs = (deps.env.WORKSPACE_SEED_GATE_TIMEOUT_SECONDS ?? 600) * 1000;

  // The archive body is a raw stream: the route bounds it itself while spooling to disk, so
  // Fastify's buffered body limit never applies (and never buffers 256 MiB in memory).
  app.addContentTypeParser(
    ["application/x-tar+gzip", "application/gzip"],
    (_req, payload, done) => done(null, payload),
  );

  /** Same authorization order as `/files`: ownership, then org policy, then token reach. */
  async function authorizeWorkspaceSeed(req: { auth: AuthContext; params: { id: string } }): Promise<PodRow> {
    const pod = await getPod(req.auth.orgId, req.params.id);
    await assertPodAccess(pod, req.auth);
    if (req.auth.podId) {
      const policyRow = await readLayer("org_policy", req.auth.orgId, req.auth.orgId);
      const nested = nestedPodsPolicy(policyRow.config ?? {});
      if (!nested.allowFileSend) {
        throw forbidden("org policy nestedPods.allowFileSend is false");
      }
      await assertPodTokenScope(pod, req.auth, "seed the workspace of");
    }
    return pod;
  }

  async function assertWorkdirEmpty(sandbox: Sandbox, workdir: string): Promise<void> {
    const state = await inspectWorkdir(sandbox, workdir);
    if (!state.empty) throw workspaceNotEmptyError(state.entries);
  }

  /**
   * Runs one seed under the pod's activity lease: marks the report `seeding`, does the work,
   * records the outcome and timing, audits safe metadata, and — for a seed-gated launch —
   * starts Pi now that the workdir is what the first session should see. A failed attempt on a
   * gated pod leaves the gate armed (status stays `pending`, with the reason) so the client
   * can fall back from clone to archive without Pi booting into an empty directory in between.
   */
  async function runWorkspaceSeed<T extends { entries: number }>(args: {
    auth: AuthContext;
    pod: PodRow;
    kind: "clone" | "archive";
    describe: Partial<WorkspaceSeedReport>;
    credential?: WorkspaceCloneCredential | null;
    work: (sandbox: Sandbox, started: PodRow) => Promise<T>;
    auditDetail: (result: T, durationMs: number) => Record<string, unknown>;
  }): Promise<{ started: PodRow; result: T; durationMs: number; piStarting: boolean }> {
    if (activeWorkspaceSeeds.has(args.pod.id)) {
      throw conflict("another workspace seed is already running for this pod");
    }
    activeWorkspaceSeeds.add(args.pod.id);
    try {
      await edition().ensurePodHostReady(deps, args.pod);
      const started = await ensureProviderPodStarted(deps, args.pod, args.auth.userId);
      const previous = started.resolved_config.workspaceSeed;
      const gated = previous?.status === "pending";
      const startedAt = new Date();
      const base: WorkspaceSeedReport = {
        requestedAt: previous?.requestedAt ?? startedAt.toISOString(),
        kind: args.kind,
        ...args.describe,
        startedAt: startedAt.toISOString(),
        status: "seeding",
      };
      await recordWorkspaceSeed(started.id, base);
      let result: T;
      try {
        result = await withPodActivityLease(deps, started, () =>
          withPodSandbox(deps, started, async (sandbox) => {
            await assertWorkdirEmpty(sandbox, started.resolved_config.workdir);
            return args.work(sandbox, started);
          }),
        );
      } catch (raw) {
        const error = redactThrown(raw, args.credential);
        const durationMs = Date.now() - startedAt.getTime();
        await recordWorkspaceSeed(started.id, {
          ...base,
          status: gated ? "pending" : "failed",
          finishedAt: new Date().toISOString(),
          durationMs,
          reason: seedFailureReason(error),
        });
        throw error;
      }
      const durationMs = Date.now() - startedAt.getTime();
      await recordWorkspaceSeed(started.id, {
        ...base,
        status: "seeded",
        finishedAt: new Date().toISOString(),
        durationMs,
        entries: result.entries,
        // An archive seed already recorded its compressed size up front; the extractor's byte
        // count is the uncompressed total and belongs in the audit row, not here.
        ...(base.bytes === undefined && "bytes" in result && typeof (result as { bytes?: unknown }).bytes === "number"
          ? { bytes: (result as { bytes: number }).bytes }
          : {}),
        ...("commit" in result && typeof (result as { commit?: unknown }).commit === "string"
          ? { commit: (result as { commit: string }).commit }
          : {}),
      });
      await recordPodTimings(started.id, { workspaceSeed: durationMs });
      await audit({
        orgId: args.auth.orgId,
        actorId: args.auth.userId,
        action: "pod.workspace_seed",
        targetType: "pod",
        targetId: started.id,
        detail: { kind: args.kind, ...args.auditDetail(result, durationMs) },
      });
      if (gated) deps.onPodStarted?.(started.id);
      return { started, result, durationMs, piStarting: gated };
    } finally {
      activeWorkspaceSeeds.delete(args.pod.id);
    }
  }

  // Clone inside the pod. The credential travels only as process environment for the one git
  // invocation; it never enters argv, the URL, .git/config, the report, the audit row, or a
  // log line — every error path passes through redactThrown.
  r.post(
    "/pods/:id/workspace/clone",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      bodyLimit: 64 * 1024,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: WorkspaceCloneBody,
      },
    },
    async (req) => {
      const pod = await authorizeWorkspaceSeed(req);
      const credential = req.body.credential ?? null;
      const { host, url } = parseCloneUrl(req.body.url);
      assertCloneHostAllowed(pod.resolved_config, host);
      assertWorkspaceSeedRateLimit(req.auth.podId ?? req.auth.userId, 0);
      const { branch, commit } = req.body;

      const seeded = await runWorkspaceSeed({
        auth: req.auth,
        pod,
        kind: "clone",
        describe: { host, branch, commit, credentialed: credential !== null },
        credential,
        work: async (sandbox, started) => {
          const scratch = `/tmp/pi-pod-seed-${uuidv7()}`;
          const scriptPath = `${scratch}/clone.py`;
          const cloneTmp = `${scratch}/work`;
          try {
            await sandbox.uploadFile(scriptPath, Buffer.from(workspaceCloneSource(), "utf8"), 0o700);
            const cloned = await sandbox.exec(
              ["python3", scriptPath, started.resolved_config.workdir, cloneTmp, url, branch, commit],
              {
                env: {
                  GIT_TERMINAL_PROMPT: "0",
                  ...(credential
                    ? { PI_POD_GIT_USERNAME: credential.username, PI_POD_GIT_PASSWORD: credential.password }
                    : {}),
                },
                timeoutMs: seedTimeoutMs,
              },
            );
            const output = redactCredential(cloned.output ?? "", credential);
            try {
              return decodeWorkspaceCloneResult(output);
            } catch (error) {
              if (cloned.exitCode !== 0 && isMalformedSeedOutput(error)) {
                throw badRequest(`workspace clone failed: ${truncate(output, 512) || `exit ${cloned.exitCode}`}`);
              }
              throw error;
            }
          } finally {
            await sandbox.exec(["rm", "-rf", scratch], { timeoutMs: 60_000 }).catch(() => {});
          }
        },
        auditDetail: (result, durationMs) =>
          cloneAuditDetail({
            host,
            branch,
            commit: result.commit,
            credentialed: credential !== null,
            entries: result.entries,
            durationMs,
            fromPod: req.auth.podId ?? null,
          }),
      });
      return {
        id: seeded.started.id,
        kind: "clone" as const,
        status: "seeded" as const,
        commit: seeded.result.commit,
        entries: seeded.result.entries,
        durationMs: seeded.durationMs,
        piStarting: seeded.piStarting,
      };
    },
  );

  // Streamed tarball. Spooled to a server temp file under the compressed cap, uploaded through
  // the provider's streaming path, then validated member-by-member inside the pod before any
  // byte lands in the workdir. Every temp file on both sides is removed on every outcome.
  r.put(
    "/pods/:id/workspace/archive",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (contentType !== "application/x-tar+gzip" && contentType !== "application/gzip") {
        throw badRequest("workspace archives must be sent as application/x-tar+gzip");
      }
      const declaredHeader = req.headers["content-length"];
      const declaredLength = declaredHeader === undefined ? NaN : Number(declaredHeader);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
        throw new HttpError(411, "Content-Length is required for workspace archives");
      }
      const pod = await authorizeWorkspaceSeed(req);
      assertWorkspaceSeedRateLimit(req.auth.podId ?? req.auth.userId, declaredLength);

      const spooled = await spoolArchiveToTempFile(req.body as NodeJS.ReadableStream, {
        maxCompressedBytes: seedLimits.maxCompressedBytes,
        declaredLength,
      });
      try {
        const allowSymlinks = !req.auth.podId;
        const seeded = await runWorkspaceSeed({
          auth: req.auth,
          pod,
          kind: "archive",
          describe: { bytes: spooled.bytes },
          work: async (sandbox, started) => {
            const scratch = `/tmp/pi-pod-seed-${uuidv7()}`;
            const archivePath = `${scratch}/archive.tgz`;
            const scriptPath = `${scratch}/extract.py`;
            const staging = `${scratch}/staging`;
            try {
              await sandbox.exec(["mkdir", "-p", "-m", "700", scratch], { timeoutMs: 60_000 });
              await sandbox.uploadLocalFile(spooled.path, archivePath, { mode: 0o600 });
              await sandbox.uploadFile(scriptPath, Buffer.from(workspaceArchiveExtractSource(), "utf8"), 0o700);
              const extracted = await sandbox.exec(
                [
                  "python3",
                  scriptPath,
                  started.resolved_config.workdir,
                  archivePath,
                  staging,
                  String(seedLimits.maxUncompressedBytes),
                  String(seedLimits.maxEntries),
                  allowSymlinks ? "1" : "0",
                ],
                { timeoutMs: seedTimeoutMs },
              );
              const output = extracted.output ?? "";
              try {
                return decodeWorkspaceArchiveResult(output);
              } catch (error) {
                if (extracted.exitCode !== 0 && isMalformedSeedOutput(error)) {
                  throw badRequest(`workspace archive extraction failed: ${truncate(output, 512) || `exit ${extracted.exitCode}`}`);
                }
                throw error;
              }
            } finally {
              await sandbox.exec(["rm", "-rf", scratch], { timeoutMs: 60_000 }).catch(() => {});
            }
          },
          auditDetail: (result, durationMs) =>
            archiveAuditDetail({
              bytes: spooled.bytes,
              entries: result.entries,
              uncompressedBytes: result.bytes,
              durationMs,
              fromPod: req.auth.podId ?? null,
            }),
        });
        return {
          id: seeded.started.id,
          kind: "archive" as const,
          status: "seeded" as const,
          bytes: spooled.bytes,
          uncompressedBytes: seeded.result.bytes,
          entries: seeded.result.entries,
          durationMs: seeded.durationMs,
          piStarting: seeded.piStarting,
        };
      } finally {
        await spooled.cleanup();
      }
    },
  );

  // The client decided not to seed after all (nothing to send, archive too large, user
  // cancelled). Opens the gate immediately instead of making the pod wait out the timeout.
  r.post(
    "/pods/:id/workspace/skip",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ reason: z.string().max(512).optional() }).strict().optional(),
      },
    },
    async (req) => {
      const pod = await authorizeWorkspaceSeed(req);
      const previous = pod.resolved_config.workspaceSeed;
      const gated = previous?.status === "pending" || previous?.status === "seeding";
      if (previous?.status === "seeding" && activeWorkspaceSeeds.has(pod.id)) {
        throw conflict("a workspace seed is still running for this pod");
      }
      if (!gated) {
        return { id: pod.id, status: previous?.status ?? "skipped", piStarting: false };
      }
      const now = new Date().toISOString();
      await recordWorkspaceSeed(pod.id, {
        requestedAt: previous.requestedAt,
        ...(previous.kind ? { kind: previous.kind } : {}),
        status: "skipped",
        finishedAt: now,
        reason: truncate(req.body?.reason ?? "client skipped workspace seeding", 512),
      });
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "pod.workspace_seed",
        targetType: "pod",
        targetId: pod.id,
        detail: { kind: "skip", ...(req.auth.podId ? { fromPod: req.auth.podId } : {}) },
      });
      const opensGate = !workspaceSeedGateOpen(pod.resolved_config, Date.now(), seedGateTimeoutMs);
      if (opensGate && pod.state === "active" && pod.provider_state === "started") {
        deps.onPodStarted?.(pod.id);
      }
      return { id: pod.id, status: "skipped" as const, piStarting: opensGate };
    },
  );

  // Permanent tombstones for whole-file credential custody. Keep each route and its previous
  // authentication policy so old clients receive an actionable upgrade error without any
  // credential read, decrypt, refresh, sandbox access, or write.
  r.post("/pods/:id/save-pi-auth", { preHandler: [app.authenticate] }, retiredPiAuthRoute);
  r.put("/pi-auth", { preHandler: [app.authenticate] }, retiredPiAuthRoute);
  r.get("/pi-auth", { preHandler: [app.authenticate] }, retiredPiAuthRoute);
  r.get("/pi-auth/content", { preHandler: [app.authenticate] }, retiredPiAuthRoute);
  r.get(
    "/pi-auth/fresh",
    { preHandler: [app.authenticate], config: { allowPodToken: true } },
    retiredPiAuthRoute,
  );
  r.delete("/pi-auth", { preHandler: [app.authenticate] }, retiredPiAuthRoute);

  // A supervisor pod drives a worker's session through this ticket, so it opts in to pod
  // tokens — for descendants only, never for the pod holding the token.
  r.post(
    "/pods/:id/ws-ticket",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const pod = await getPod(req.auth.orgId, req.params.id);
      await assertPodAccess(pod, req.auth);
      await assertPodTokenScope(pod, req.auth, "open a session on");
      if (pod.state !== "active") throw conflict("restore the pod before opening a session");
      const ticket = await mintTicket(req.auth.userId, pod.id);
      return reply.code(201).send(ticket);
    },
  );


  r.get(
    "/pods/:id/sessions",
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
          before: z.string().datetime({ offset: true }).optional(),
        }),
      },
    },
    async (req) => {
      await assertPodAccess(await getPod(req.auth.orgId, req.params.id), req.auth);
      const rows = await query<{
        id: string;
        user_id: string;
        started_at: string | Date;
        ended_at: string | Date | null;
        end_reason: string | null;
        events_truncated_below_seq: string | number | null;
      }>(
        `SELECT id, user_id, started_at, ended_at, end_reason, events_truncated_below_seq FROM sessions
         WHERE pod_id = $1 AND ($2::timestamptz IS NULL OR started_at < $2)
         ORDER BY started_at DESC LIMIT $3`,
        [req.params.id, req.query.before ?? null, req.query.limit],
      );
      return { sessions: rows.rows.map(sessionListItem) };
    },
  );

  // One chronological transcript for a pod, across gateway sessions. Clients should not
  // have to list sessions and merge their event logs themselves.
  r.get(
    "/pods/:id/conversation/events",
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          before: z.string().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(200),
        }),
      },
    },
    async (req) => {
      await assertPodAccess(await getPod(req.auth.orgId, req.params.id), req.auth);
      let before;
      try {
        before = parseConversationCursor(req.query.before);
      } catch (e) {
        throw badRequest(e instanceof Error ? e.message : "invalid conversation cursor");
      }
      const { text, params } = conversationEventsQuery({
        podId: req.params.id,
        before,
        limit: req.query.limit,
      });
      const rows = await query<{
        session_id: string;
        seq: string;
        kind: string;
        payload: unknown;
        created_at: string | Date;
      }>(text, params);
      const page = conversationPageFromRows(rows.rows, req.query.limit);
      return {
        events: page.events,
        nextBefore: page.nextBefore ? formatConversationCursor(page.nextBefore) : null,
      };
    },
  );

  r.get(
    "/sessions/:id/events",
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          after_seq: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(1000).default(200),
        }),
      },
    },
    async (req) => {
      const owner = await query<{ org_id: string; pod_id: string; events_truncated_below_seq: string | null }>(
        `SELECT p.org_id, s.pod_id, s.events_truncated_below_seq
           FROM sessions s JOIN pods p ON p.id = s.pod_id WHERE s.id = $1`,
        [req.params.id],
      );
      if (owner.rows[0]?.org_id !== req.auth.orgId) throw forbidden("session is not in your org");
      await assertPodAccess(await getPod(req.auth.orgId, owner.rows[0].pod_id), req.auth);
      const rows = await query<{ seq: string; kind: string; payload: unknown; created_at: string }>(
        `SELECT seq, kind, payload, created_at FROM session_events
         WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
        [req.params.id, req.query.after_seq, req.query.limit],
      );
      const truncatedBelowSeq = owner.rows[0]?.events_truncated_below_seq != null
        ? Number(owner.rows[0].events_truncated_below_seq)
        : null;
      return {
        truncatedBelowSeq,
        events: rows.rows.map((row) => ({
          seq: Number(row.seq),
          kind: row.kind,
          payload: row.payload,
          createdAt: row.created_at,
        })),
      };
    },
  );
}

export function sessionListItem(row: {
  id: string;
  user_id: string;
  started_at: string | Date;
  ended_at: string | Date | null;
  end_reason: string | null;
  events_truncated_below_seq: string | number | null;
}): {
  id: string;
  user_id: string;
  started_at: string | Date;
  ended_at: string | Date | null;
  end_reason: string | null;
  truncated: boolean;
} {
  return {
    id: row.id,
    user_id: row.user_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    end_reason: row.end_reason,
    truncated: row.events_truncated_below_seq != null,
  };
}

