import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import type WebSocket from "ws";
import { RemoteRpcClient, type FrameChannel, type ImageContent } from "../../core/client/rpc.js";
import { bundledPiVersion } from "../../core/client/piversion.js";
import { verifyHello } from "../../core/client/session.js";
import {
  REMOTE_UI_MAX_SURFACES,
  REMOTE_UI_INPUT_PREFIX,
  remoteUiFrameFromExtensionRequest,
  remoteUiInputFromResponse,
  type RemoteUiSurfaceFrame,
} from "../../core/remote-ui-protocol.js";
import { creationMarkers, runtimeMarkers } from "../../core/labels.js";
import type { Sandbox } from "../../core/providers/types.js";
import { audit } from "../audit.js";
import { query } from "../db/index.js";
import type { ServerEnv } from "../env.js";
import { HttpError, conflict, serviceUnavailable } from "../httperrors.js";
import { sanitizeFailureMessage } from "../safe-errors.js";
import { credentialProvidersFor } from "../model-credentials/dependencies.js";
import { acquireLease } from "../model-credentials/lease.js";
import {
  materializeCredentialLease,
  persistPodCredentialContract,
  readPodCredentialContract,
} from "../model-credentials/materializer.js";
import { MIN_VALIDITY_MS } from "../model-credentials/refresh.js";
import { uuidv7 } from "../ids.js";
import type { KekProvider } from "../secrets/crypto.js";
import { resolvePodEnv } from "../pods/launchenv.js";
import { platformCredentialsOf, withProviderCredential } from "../pods/providercred.js";
import type { PlatformCredentialSnapshot } from "../pods/providercred.js";
import {
  ensureProviderPodStartedWithResult,
  materializePodCredentialLeaseBestEffort,
  recordPodTimings,
  withPodSandbox,
  type PodRow,
} from "../pods/service.js";
import {
  consumeForkSeed,
  loadUnconsumedForkSeed,
} from "../pods/fork-seed.js";
import { podRuntimePaths } from "../pods/runtime-paths.js";
import { getPod } from "../pods/store.js";
import { runCreateRecovery } from "../pods/create-recovery.js";
import { assertLaunchGateOpen, launchGateIsOpen } from "../pods/launch-control.js";
import { hostForPod, hostCanDial, personalBoatHostIsAsleep, requireHostAwake } from "../pods/hostidentity.js";
import { assertPersonalPodAccess, edition } from "../edition.js";
import { assertLaunchStateSupported } from "../pods/retired-launch-state.js";
import { workspaceSeedGateOpen } from "../pods/workspace-seed.js";
import { interactionSummary, turnEndSummary } from "../push/copy.js";
import { enqueuePush } from "../push/queue.js";
import {
  BUSY_ACTIVITY_REFRESH_MS,
  SessionActivityLease,
  WORK_LEASE_SECONDS,
  sessionNeedsChannelProbe,
  shouldRenewTrafficActivity,
  type WorkLeaseMode,
} from "./activity.js";
import {
  observeGatewayAttach,
  observeGatewaySessionEnd,
  observeJobRun,
  observePodLaunch,
  trackWorkerTick,
} from "../metrics.js";
import { formatAttachTelemetry } from "./telemetry.js";
import { bashSnapshotAccumulate } from "./readiness.js";
import {
  ABANDONED_PROVISION_SECONDS,
  ATTACH_SESSION_RETRY_ATTEMPTS,
  HELLO_TIMEOUT_MS,
  HEARTBEAT_MS,
  HOST_SLEEP_SWEEP_MS,
  LEASE_STALE_SECONDS,
  MAX_SOCKET_REPLAY,
  MAX_PENDING_INTERACTION_RESENDS,
  MAX_TOOL_EXECUTION_SNAPSHOTS,
  OVERSIZED_STALL_MIN_PENDING_BYTES,
  PI_STARTUP_CRASH_WITHDRAW_AFTER,
  PROVIDER_ACTIVITY_TIMEOUT_MS,
  QUEUED_PROMPT_MAX_ATTEMPTS,
  QUEUED_PROMPT_POLL_MS,
  RESOLUTION_POLL_MS,
  SESSION_PERSIST_BARRIER_TIMEOUT_MS,
  SESSION_STARTUP_STATE_TIMEOUT_MS,
  SWEEP_MS,
  SessionChangedDuringAttachError,
  classifyAttachReadinessFailure,
  classifyPiStartupCrash,
  closeReasonForUnretainedPod,
  commandActivityKind,
  ensureGatewaySessionReady,
  formatOversizedStall,
  formatPiStartupCrash,
  gatewayAttachError,
  gatewayPiArgv,
  gatewaySessionReadyTimeoutMs,
  podIdentityEnv,
  prepareGatewayRuntime,
  probeGatewayChannel,
  requestGatewaySessionState,
  retrySessionAttach,
  seedGatewaySessionActivity,
  sessionEndDisposition,
  sessionEndReasonForRpcInvalidation,
  sessionsHeldOnHost,
  uniqueLiveHostIds,
  eventReplaySince,
  withTimeout,
  type PiStartupCrash,
  type UnretainedPodRow,
} from "./session-state.js";
import type { ActiveSession } from "./active-session.js";
import {
  applyEventReplayGap,
  applyEventReplayEnd,
  createProvisionalAttachSink,
  deliverUserPrompt,
  describePromptImages,
  preparePromptIngress,
  promptValidationRpcResult,
  helloFirstAvailableSeq,
  persistThenAnnouncePodName,
  persistableControlPayload,
  persistablePayload,
  podNameFromSessionEvent,
  replayFromForSession,
  replayGapFor,
  shimEventCheckpointBacklog,
  toolCallIdFor,
  type ClientMessage,
  type PersistedEvent,
  type ServerMessage,
  type UserPromptPayload,
  type WsSink,
} from "./stream-fanout.js";
import {
  interactionKind,
  isInteractionEvent,
  unansweredInteractionFrames,
} from "./interactions.js";

/**
 * Reserve a model/catalog operation before its first await. WebSocket receives
 * are dispatched concurrently, so the queue must be advanced synchronously at
 * message admission rather than after host or credential checks.
 */
export function enqueueModelCatalogOperation<T>(
  session: Pick<ActiveSession, "modelCatalogQueue">,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = session.modelCatalogQueue;
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  session.modelCatalogQueue = previous.then(() => turn, () => turn);
  return (async () => {
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  })();
}

/** Recheck ownership after any await before touching a live session. */
export function isCurrentGatewaySession(
  session: Pick<ActiveSession, "closed">,
  current: object | null,
): boolean {
  return !session.closed && current === session;
}

/** Read and send one fresh semantic model snapshot. */
export async function sendModelCatalogSnapshot(args: {
  rpc: Pick<RemoteRpcClient, "getAvailableModels" | "getState" | "getAvailableThinkingLevels">;
  mirrorPiSessionFile: (sessionFile: unknown) => void;
  send: (frame: Extract<ServerMessage, { type: "models" }>) => void;
  requestId?: string;
  isCurrent?: () => boolean;
}): Promise<void> {
  const [models, state, thinkingLevels] = await Promise.all([
    args.rpc.getAvailableModels(),
    args.rpc.getState(),
    // Older compatible shims may not expose this RPC yet. Keep the model catalog
    // usable during a rolling deploy; clients simply hide thinking choices.
    args.rpc.getAvailableThinkingLevels().catch(() => []),
  ]);
  if (args.isCurrent && !args.isCurrent()) return;
  args.mirrorPiSessionFile(state.sessionFile);
  if (args.isCurrent && !args.isCurrent()) return;
  args.send({
    type: "models",
    ...(args.requestId ? { requestId: args.requestId } : {}),
    models,
    current: state.model ?? null,
    thinkingLevel: state.thinkingLevel,
    thinkingLevels,
  });
}

import { PodTransportRegistry, WsPodChannel } from "./pod-transport.js";
import {
  describeResolverRepair,
  repairStaleTailscaleResolver,
  runResumeHook,
  shouldRunResumeHook,
} from "../pods/resolver.js";
import {
  AGENTD_RECONNECT_GRACE_MS,
  agentdDialUrl,
  agentdSupervisorRunning,
  classifyTransportFailure,
  ensureAgentdCallbackEgress,
  EGRESS_REAPPLY_COOLDOWN_MS,
  probeControlHostFromDescription,
  startAgentdSupervisorWithEgressHeal,
  stopAgentdSupervisor,
  transportNetworkProbe,
} from "../pods/supervisor.js";
import {
  AUX_GATEWAY_CONCURRENCY_LIMIT,
  AUX_MIN_EXTENSION_VERSION,
  auxExtensionUnsupported,
  fireAuxCancel,
  invokeAuxComplete,
  isSessionExtensionEvent,
  podSessionExtensionService,
  validateAuxCompleteRequest,
  type AuxCompleteRequest,
} from "./session-extension-service.js";
import { handlePodCommandService } from "./session-services.js";

export {
  ABANDONED_PROVISION_SECONDS,
  ATTACH_SESSION_RETRY_ATTEMPTS,
  ATTACH_SESSION_RETRY_BUDGET_MS,
  HEARTBEAT_MS,
  LEASE_STALE_SECONDS,
  MAX_TOOL_EXECUTION_SNAPSHOTS,
  OVERSIZED_STALL_MIN_PENDING_BYTES,
  PI_STARTUP_CRASH_WINDOW_MS,
  PI_STARTUP_CRASH_WITHDRAW_AFTER,
  SESSION_PERSIST_BARRIER_TIMEOUT_MS,
  SESSION_STARTUP_STATE_TIMEOUT_MS,
  SESSION_STATE_TIMEOUT_MS,
  SessionChangedDuringAttachError,
  classifyAttachReadinessFailure,
  classifyPiStartupCrash,
  closeCodeForSessionEnd,
  closeReasonForUnretainedPod,
  commandActivityKind,
  ensureGatewaySessionReady,
  formatOversizedStall,
  formatPiStartupCrash,
  gatewayAttachError,
  gatewayPiArgv,
  gatewaySessionReadyTimeoutMs,
  prepareGatewayRuntime,
  probeGatewayChannel,
  requestGatewaySessionState,
  retrySessionAttach,
  seedGatewaySessionActivity,
  sessionEndDisposition,
  sessionEndReasonForRpcInvalidation,
  eventReplaySince,
} from "./session-state.js";
export type {
  AttachStall,
  CommandActivityKind,
  GatewayChannelProbeResult,
  PiStartupCrash,
  SessionEndKind,
  UnretainedPodRow,
} from "./session-state.js";
export {
  PI_STDERR_PERSIST_MAX_BYTES,
  PI_STDERR_PERSIST_MAX_ROWS,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_IMAGE_BASE64_CHARS,
  MAX_PROMPT_IMAGES_TOTAL_BASE64_CHARS,
  MAX_PROMPT_TEXT_CHARS,
  ALLOWED_PROMPT_IMAGE_MIMES,
  applyEventReplayGap,
  applyEventReplayEnd,
  createProvisionalAttachSink,
  deliverUserPrompt,
  describePromptImages,
  normalizePromptText,
  preparePromptIngress,
  promptValidationRpcResult,
  validatePromptImages,
  eventReplayGapFromControl,
  helloFirstAvailableSeq,
  persistThenAnnouncePodName,
  persistableControlPayload,
  persistablePayload,
  podNameFromSessionEvent,
  replayFromForSession,
  replayGapFor,
  retryPodNameUpdate,
  shimEventCheckpointBacklog,
  toolCallIdFor,
  truncatePiStderrData,
} from "./stream-fanout.js";
export type {
  ClientMessage,
  PersistedEvent,
  PromptImageDescriptor,
  ServerMessage,
  UserPromptPayload,
  WsSink,
} from "./stream-fanout.js";
export {
  interactionKind,
  isInteractionEvent,
  unansweredInteractionFrames,
} from "./interactions.js";
export { SESSION_STEERING_ARGS, piArgsHaveSessionSteering } from "../pods/fork-seed.js";

/**
 * Widen a pod's server-maintained credential contract before Pi changes model. Existing
 * contracts stay on the fast path; a newly required terminal grant blocks the switch with the
 * frozen typed error. Missing rows remain allowed because the model may authenticate from env.
 */
export async function extendPodCredentialContractForModel(args: {
  kek: KekProvider;
  pod: Pick<PodRow, "id" | "org_id">;
  sandbox: Sandbox;
  modelProvider: string;
}): Promise<string[]> {
  const found = await query<Pick<PodRow, "id" | "org_id" | "user_id" | "credential_providers">>(
    `SELECT id, org_id, user_id, credential_providers
       FROM pods WHERE id = $1 AND org_id = $2`,
    [args.pod.id, args.pod.org_id],
  );
  const pod = found.rows[0];
  if (!pod) throw new HttpError(404, "pod not found");

  const current = await readPodCredentialContract(pod);
  const dependencies = [...credentialProvidersFor(args.modelProvider)];
  const added = dependencies.filter((providerId) => !current.includes(providerId));
  if (added.length === 0) return current;

  const next = [...new Set([...current, ...dependencies])].sort();
  await persistPodCredentialContract(pod.id, next);
  try {
    const { lease, failures } = await acquireLease(
      args.kek,
      { orgId: pod.org_id, userId: pod.user_id },
      next,
      MIN_VALIDITY_MS,
    );
    for (const providerId of added) {
      if (failures[providerId]?.state !== "reconnect_required") continue;
      throw new HttpError(409, "credential_reconnect_required", {
        code: "credential_reconnect_required",
        message: `Reconnect the ${providerId} account credential before switching models.`,
        provider: providerId,
        requiredBy: args.modelProvider,
      });
    }
    if (Object.keys(lease.providers).length > 0) {
      await materializeCredentialLease(args.sandbox, lease);
    }
    return next;
  } catch (error) {
    // A failed switch did not authorize the wider contract. Restore the previous set so a
    // retry cannot take the already-present fast path and bypass the readiness gate.
    await persistPodCredentialContract(pod.id, current).catch(() => {});
    throw error;
  }
}

/** What became of a resolution attempt; the REST route maps these onto status codes. */
export type ResolveOutcome =
  | { status: "delivered"; podId: string }
  | { status: "pending_delivery"; podId: string }
  | { status: "already_resolved"; podId: string }
  | { status: "undeliverable"; podId: string }
  | { status: "not_found" };

interface InteractionRow {
  id: string;
  pod_id: string;
  payload: Record<string, unknown>;
  resolution: unknown;
  resolved_by: string | null;
  delivered_at: string | null;
  ended_at: string | null;
}

/**
 * Resolve an interaction. Works with or without an in-process gateway (split roles): the
 * answer is persisted first, delivery is claimed atomically, and `delivered_at` — the only
 * marker that consumes the approval — is set exclusively by the gateway that actually
 * forwarded it to the agent. Never claims success when no live session can receive it.
 */
export async function resolveInteraction(
  gateway: GatewayService | null,
  args: { interactionId: string; response: unknown; resolvedBy: string | null },
): Promise<ResolveOutcome> {
  const rows = await query<InteractionRow>(
    `SELECT pi.id, s.pod_id, pi.payload, pi.resolution, pi.resolved_by, pi.delivered_at, s.ended_at
     FROM pending_interactions pi JOIN sessions s ON s.id = pi.session_id
     WHERE pi.id = $1`,
    [args.interactionId],
  );
  const row = rows.rows[0];
  if (!row) return { status: "not_found" };
  if (row.delivered_at) return { status: "already_resolved", podId: row.pod_id };

  const session = gateway?.liveSession(row.pod_id) ?? null;
  if (!session && row.ended_at) return { status: "undeliverable", podId: row.pod_id };

  if (!session) {
    // Not held here. Only promise delivery while a live-heartbeat gateway holds the pod —
    // its resolution poll forwards within RESOLUTION_POLL_MS.
    const lease = await query<{ live: boolean }>(
      `SELECT (gateway_id IS NOT NULL AND gateway_heartbeat_at > now() - make_interval(secs => $2)) AS live
       FROM pods WHERE id = $1`,
      [row.pod_id, LEASE_STALE_SECONDS],
    );
    if (!lease.rows[0]?.live) return { status: "undeliverable", podId: row.pod_id };
    await recordResolution(args);
    return { status: "pending_delivery", podId: row.pod_id };
  }

  await recordResolution(args);
  const delivered = await gateway!.deliverResolution(session, {
    id: row.id,
    payload: row.payload,
    resolution: args.response,
    resolvedBy: args.resolvedBy,
  });
  return delivered
    ? { status: "delivered", podId: row.pod_id }
    : { status: "already_resolved", podId: row.pod_id };
}

async function recordResolution(args: {
  interactionId: string;
  response: unknown;
  resolvedBy: string | null;
}): Promise<void> {
  await query(
    `UPDATE pending_interactions SET resolution = $2, resolved_at = now(), resolved_by = $3
     WHERE id = $1 AND delivered_at IS NULL`,
    [args.interactionId, JSON.stringify(args.response ?? null), args.resolvedBy],
  );
}

/** Sweep retry spacing for pods whose transport keeps failing. Every sweep attempt runs a
 * full supervisor replacement — provider execs plus a Pi respawn inside the sandbox — so a
 * permanently wedged pod must not churn itself (and the provider) every ten seconds forever.
 * Backoff doubles per consecutive failure, caps at half an hour, and resets the moment an
 * attempt succeeds. */
export const SWEEP_BACKOFF_INITIAL_MS = 60_000;
export const SWEEP_BACKOFF_MAX_MS = 30 * 60_000;

export function sweepBackoffDelayMs(failures: number): number {
  const bounded = Math.max(1, failures);
  return Math.min(SWEEP_BACKOFF_MAX_MS, SWEEP_BACKOFF_INITIAL_MS * 2 ** (bounded - 1));
}

/**
 * How long a transport-failed client attach waits for the daemon's reconnect before giving
 * up on the live session. One daemon backoff window (its reconnect delay caps at 10s), so a
 * gateway restart or edge blip resolves inside a single attach instead of failing it. Expiry
 * ends the session WITHOUT retiring the supervisor — the daemon keeps retrying its dial-out
 * and the next attach adopts it.
 */
export const TRANSPORT_RECONNECT_WAIT_MS = 12_000;
const TRANSPORT_RECONNECT_POLL_MS = 250;

export interface QueuedPromptRow {
  id: string;
  text: string;
  attempts: number;
}

/** Durable admission boundary, injectable so drain interleavings use the production path. */
export interface QueuedPromptStore {
  claimNext(podId: string): Promise<QueuedPromptRow | null>;
  markDelivered(id: string, attempts: number): Promise<boolean>;
  markPreDispatchFailure(
    id: string, attempts: number, message: string
  ): Promise<"pending" | "failed" | null>;
  markUnknown(id: string, attempts: number, message: string): Promise<boolean>;
  markRejected(id: string, attempts: number, message: string): Promise<boolean>;
  markStaleDeliveriesUnknown(podId?: string): Promise<Array<{ id: string; pod_id: string }>>;
}

/** Only these pinned Pi preflight refusals are safe to resubmit automatically. */
export function classifyPiPromptRejection(error: string): "retry" | "terminal" {
  return error.startsWith("Agent is already processing.")
    || error.startsWith("Cannot submit a prompt while compaction is in progress.")
    ? "retry" : "terminal";
}

const postgresQueuedPromptStore: QueuedPromptStore = {
  async claimNext(podId) {
    const result = await query<QueuedPromptRow>(
      `WITH candidate AS (
         SELECT id FROM queued_prompts
         WHERE pod_id = $1 AND status = 'pending'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE queued_prompts q
          SET status = 'delivering', attempts = attempts + 1, claimed_at = now(),
              last_error = NULL, updated_at = now()
         FROM candidate
        WHERE q.id = candidate.id
       RETURNING q.id, q.text, q.attempts`,
      [podId],
    );
    return result.rows[0] ?? null;
  },
  async markDelivered(id, attempts) {
    const result = await query(
      `UPDATE queued_prompts SET status = 'delivered', delivered_at = now(),
         claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND attempts = $2 AND status IN ('delivering', 'unknown')`,
      [id, attempts],
    );
    return (result.rowCount ?? 0) === 1;
  },
  async markPreDispatchFailure(id, attempts, message) {
    const status = attempts >= QUEUED_PROMPT_MAX_ATTEMPTS ? 'failed' : 'pending';
    const result = await query<{ status: 'pending' | 'failed' }>(
      `UPDATE queued_prompts
          SET status = $3, last_error = $4, claimed_at = NULL, updated_at = now()
        WHERE id = $1 AND attempts = $2 AND status = 'delivering'
       RETURNING status`,
      [id, attempts, status, message.slice(0, 2000)],
    );
    return result.rows[0]?.status ?? null;
  },
  async markUnknown(id, attempts, message) {
    const result = await query(
      `UPDATE queued_prompts SET status = 'unknown', last_error = $3,
         claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND attempts = $2 AND status = 'delivering'`,
      [id, attempts, message.slice(0, 2000)],
    );
    return (result.rowCount ?? 0) === 1;
  },
  async markRejected(id, attempts, message) {
    const result = await query(
      `UPDATE queued_prompts SET status = 'failed', last_error = $3,
         claimed_at = NULL, updated_at = now()
       WHERE id = $1 AND attempts = $2 AND status = 'delivering'`,
      [id, attempts, message.slice(0, 2000)],
    );
    return (result.rowCount ?? 0) === 1;
  },
  async markStaleDeliveriesUnknown(podId) {
    const result = await query<{ id: string; pod_id: string }>(
      `UPDATE queued_prompts SET status = 'unknown',
         last_error = 'delivery acknowledgement was not observed',
         claimed_at = NULL, updated_at = now()
       WHERE status = 'delivering'
         AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
         AND ($1::uuid IS NULL OR pod_id = $1)
       RETURNING id, pod_id`,
      [podId ?? null],
    );
    return result.rows;
  },
};

export interface DisconnectedSupervisorRecovery {
  podId: string;
  log: { warn: (message: string) => void };
  /** Live supervisor check; null when the provider exec itself failed (unknown, not dead). */
  isRunning: () => Promise<boolean | null>;
  /** Bounded wait for the daemon dial-out; null on timeout. */
  waitForReconnect: () => Promise<FrameChannel | null>;
  /** Retire a dead/stale supervisor and drop stale registry state. */
  replace: () => Promise<void>;
}

/**
 * Reconnect-grace outcome for a supervisor with no channel. A live supervisor keeps its
 * tools: the daemon retries its dial-out for as long as it lives, so grace expiry fails
 * retryably for the next sweep/attach to adopt. Only an explicitly dead supervisor is
 * replaced. Unknown (a provider exec outage, not evidence of death) fails safe with
 * neither a stop nor a spawn — both risk a second Pi beside a live one.
 */
export async function recoverDisconnectedSupervisor(
  deps: DisconnectedSupervisorRecovery,
): Promise<{ channel: FrameChannel | null; resumed: boolean }> {
  const channel = await deps.waitForReconnect();
  if (channel) return { channel, resumed: true };
  const stillRunning = await deps.isRunning();
  if (stillRunning !== false) {
    deps.log.warn(
      stillRunning === true
        ? `pod ${deps.podId} supervisor is alive but its transport stayed down; leaving it to reconnect`
        : `pod ${deps.podId} supervisor state is unknown; leaving it alone`,
    );
    throw conflict(
      stillRunning === true
        ? "pod supervisor is alive but disconnected — retry once its transport reconnects"
        : "pod supervisor state could not be verified — retry",
    );
  }
  deps.log.warn(`pod ${deps.podId} supervisor stayed disconnected; replacing it`);
  await deps.replace();
  return { channel: null, resumed: false };
}

/**
 * The session gateway (spec §9): terminates the pod-side frame protocol — WsPodChannel →
 * FrameDecoder → RemoteRpcClient — persists every durable event with a monotonic
 * per-session seq BEFORE fan-out, and re-exposes the session as a JSON WebSocket.
 * Streaming `message_update` snapshots are the exception: RpcClientBase reconstructs Pi
 * 0.84 deltas into whole partial messages, so only the newest matters and none becomes a row.
 */
export class GatewayService {
  private sessions = new Map<string, ActiveSession>();
  private readonly queuedPromptStore: QueuedPromptStore;
  readonly podTransportRegistry = new PodTransportRegistry();
  /** Live dial-out carriers, exposed for status/tests without exposing registry mutation. */
  get podTransports(): ReadonlyMap<string, WsPodChannel> {
    return this.podTransportRegistry.channels;
  }
  private attaching = new Map<string, Promise<ActiveSession>>();
  /** Consecutive pi startup crashes per pod; any other session ending resets the streak. */
  private startupCrashStreaks = new Map<string, number>();
  private ending = new Map<string, Promise<void>>();
  /** One queue drain per pod; route nudges and the poll can race without double-claiming. */
  private promptDrains = new Map<string, Promise<void>>();
  private timers: NodeJS.Timeout[] = [];
  private draining = false;
  private rejectedTransportCleanups = new Set<string>();
  private egressReapplies = new Map<string, number>();
  private sweepBackoffs = new Map<string, { failures: number; nextAt: number }>();
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private deps: {
      env: ServerEnv;
      kek: KekProvider;
      /** Boot snapshot of the platform provider credentials (see providercred). */
      platformCredentials?: PlatformCredentialSnapshot;
      log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
      queuedPromptStore?: QueuedPromptStore;
      /** Explicit test seam; production defaults to the durable DB gate. */
      launchAdmissionCheck?: () => Promise<void>;
    },
  ) {
    this.queuedPromptStore = deps.queuedPromptStore ?? postgresQueuedPromptStore;
  }

  /**
   * Background loops every gateway needs regardless of role wiring: claiming unleased or
   * stale-leased pods, proving this instance is alive, and forwarding resolutions that an
   * api-only role persisted.
   */
  start(): void {
    const schedule = (
      name: string,
      everyMs: number,
      job: () => Promise<void>,
      runWhileHeld = false,
    ) => {
      let running = false;
      const tick = () => {
        if (running) return;
        running = true;
        void (async () => {
          if (!runWhileHeld && !(await launchGateIsOpen())) return;
          await trackWorkerTick(`gateway-${name}`, job);
        })()
          .catch((e) => this.deps.log.warn(`gateway ${name}: ${e instanceof Error ? e.message : e}`))
          .finally(() => {
            running = false;
          });
      };
      this.timers.push(setInterval(tick, everyMs));
      tick();
    };
    schedule("sweep", SWEEP_MS, () => this.sweep());
    schedule("channel-liveness", SWEEP_MS, () => this.probeSessionChannels());
    schedule("abandoned-provisioning", SWEEP_MS, () => this.failAbandonedProvisioning(), true);
    schedule("lease-heartbeat", HEARTBEAT_MS, () => this.heartbeatLeases());
    schedule("resolution-delivery", RESOLUTION_POLL_MS, () => this.deliverPendingResolutions());
    schedule("prompt-delivery", QUEUED_PROMPT_POLL_MS, () => this.deliverQueuedPrompts());
    schedule("busy-activity", BUSY_ACTIVITY_REFRESH_MS, () => this.refreshBusySessions());
    schedule("host-sleep", HOST_SLEEP_SWEEP_MS, () => this.closeSessionsOnStoppedHosts());
  }

  /** Control-plane host sleep: close attached clients with 4420 when this host is known stopped. */
  async closeHost(hostId: string, reason: string): Promise<void> {
    const held = sessionsHeldOnHost(this.sessions.values(), hostId);
    await Promise.all(held.map((session) => this.endSession(session, reason)));
  }

  private async closeSessionsOnStoppedHosts(): Promise<void> {
    const sessions = [...this.sessions.values()].filter((session) => !session.closed);
    const hostIds = uniqueLiveHostIds(sessions);
    if (hostIds.length === 0) return;
    const hosts = await query<{ id: string; owner_user_id: string | null; boat_id: string | null; boat_state: string | null }>(
      `SELECT id, owner_user_id, boat_id, boat_state FROM sandbox_hosts WHERE id = ANY($1::text[])`,
      [hostIds],
    );
    const asleep = new Set(hosts.rows.filter((host) => personalBoatHostIsAsleep(host)).map((host) => host.id));
    await Promise.all(
      sessions
        .filter((session) => session.pod.sandbox_host_id != null && asleep.has(session.pod.sandbox_host_id))
        .map((session) => this.endSession(session, "host_stopped")),
    );
  }

  /** Claim the pod lease and hold the live channel; idempotent per pod. */
  async ensureSession(orgId: string, podId: string, options: { resumeHost?: boolean } = {}): Promise<ActiveSession> {
    if (this.draining) throw conflict("gateway is shutting down — retry on its replacement");
    await (this.deps.launchAdmissionCheck ?? assertLaunchGateOpen)();
    if (this.draining) throw conflict("gateway is shutting down — retry on its replacement");
    const ending = this.ending.get(podId);
    if (ending) await ending;
    if (this.draining) throw conflict("gateway is shutting down — retry on its replacement");
    const existing = this.sessions.get(podId);
    if (existing && !existing.closed) {
      // New attaches pass demand admission in ensureProviderPodStarted. An
      // already-held channel must also check current physical availability.
      if (options.resumeHost === false) {
        const host = await hostForPod(existing.pod);
        if (host) requireHostAwake(host);
      } else {
        await this.admitSessionHost(existing);
      }
      if (existing.closed || this.sessions.get(podId) !== existing) return this.ensureSession(orgId, podId, options);
      void this.deliverQueuedPromptsForSession(existing);
      return existing;
    }
    const inflight = this.attaching.get(podId);
    if (inflight) return inflight;
    const attachProvider = { value: "other" };
    const promise = this.attach(orgId, podId, attachProvider, options)
      .catch((error: unknown) => {
        observeGatewayAttach(attachProvider.value, "error");
        throw gatewayAttachError(error);
      })
      .finally(() => this.attaching.delete(podId));
    this.attaching.set(podId, promise);
    return promise;
  }

  liveSession(podId: string): ActiveSession | null {
    const session = this.sessions.get(podId);
    return session && !session.closed ? session : null;
  }

  heldSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.closed) count += 1;
    }
    return count;
  }

  attachesInFlight(): number {
    return this.attaching.size;
  }

  /** Authenticate has already bound this socket to podId. Claim the lease, enforce the
   * single-writer rule, and hot-rebind a live RPC session when this is a reconnect. */
  async acceptPodTransport(podId: string, socket: WebSocket): Promise<WsPodChannel> {
    if (this.draining) throw conflict("gateway is shutting down — retry on its replacement");
    const claimed = await query<{ state: string; provider_state: string; transport: string }>(
      `UPDATE pods SET gateway_id = $2, gateway_heartbeat_at = now(), updated_at = now()
       WHERE id = $1 AND state = 'active' AND transport = 'ws'
         AND provider_state IN ('starting', 'started')
         AND (gateway_id IS NULL OR gateway_id = $2 OR gateway_heartbeat_at IS NULL
           OR gateway_heartbeat_at < now() - make_interval(secs => $3))
       RETURNING state, provider_state, transport`,
      [podId, this.deps.env.GATEWAY_ID, LEASE_STALE_SECONDS],
    );
    if ((claimed.rowCount ?? 0) === 0) {
      const found = await query<{ state: string; transport: string; gateway_id: string | null }>(
        "SELECT state, transport, gateway_id FROM pods WHERE id = $1",
        [podId],
      );
      const row = found.rows[0];
      if (!row) throw new HttpError(404, "pod not found");
      if (row.state === "archived") throw conflict("archived pods cannot connect a transport");
      if (row.transport !== "ws") throw conflict("pod is configured for PTY transport");
      throw conflict("pod transport lease is held by another gateway");
    }

    const channel = new WsPodChannel(socket, podId);
    this.podTransportRegistry.bind(channel);
    this.deps.log.info(`pod transport accepted for ${podId}`);
    const session = this.liveSession(podId);
    if (session) {
      session.transportRebinding = true;
      try {
        session.channel = channel;
        session.rpc.rebindChannel(channel);
      } finally {
        session.transportRebinding = false;
      }
      void this.finishPodTransportRebind(session, channel);
    }
    return channel;
  }

  private async finishPodTransportRebind(session: ActiveSession, channel: WsPodChannel): Promise<void> {
    try {
      const hello = await session.rpc.ensureHello(HELLO_TIMEOUT_MS, { discardCached: true });
      if (session.channel !== channel || session.closed) return;
      verifyHello(hello, channel);
      session.rpc.requestEventReplay(session.lastDecodedShimSeq);
      session.rpc.requestUiReplay(0);
      await session.rpc.refreshStreamingSnapshot();
    } catch (error) {
      if (session.channel === channel && !session.closed) {
        this.deps.log.warn(
          sanitizeFailureMessage(error, { prefix: `pod ${session.pod.id} transport rebind failed` }),
        );
        void this.endSession(session, "transport_lost");
      }
    }
  }

  private async attach(
    orgId: string,
    podId: string,
    providerOut?: { value: string },
    options: { resumeHost?: boolean } = {},
  ): Promise<ActiveSession> {
    const attachStartedAt = Date.now();
    const timings: Record<string, number> = {};
    const ensured = await ensureProviderPodStartedWithResult(
      { env: this.deps.env, kek: this.deps.kek, log: this.deps.log },
      { org_id: orgId, id: podId },
      null,
      options,
    );
    const pod = ensured.pod;
    if (providerOut) providerOut.value = pod.provider;
    // A seed-gated launch: Pi must not boot into a workdir the client is still filling. The
    // seed route re-triggers this attach when it finishes; the sweep retries after the gate
    // times out on its own.
    if (
      !workspaceSeedGateOpen(
        pod.resolved_config,
        Date.now(),
        (this.deps.env.WORKSPACE_SEED_GATE_TIMEOUT_SECONDS ?? 600) * 1000,
      )
    ) {
      throw conflict("workspace seeding is in progress; retry once the workspace is seeded");
    }
    const prepareStartedAt = Date.now();

    // Lease acquisition and environment reconstruction are independent. On a hot pod this
    // removes the complete secret-resolution chain from the lease's critical path.
    const [lease, podEnv] = await Promise.all([
      query(
        `UPDATE pods SET gateway_id = $2, gateway_heartbeat_at = now(), updated_at = now()
         WHERE id = $1 AND state = 'active' AND provider_state = 'started'
           AND (gateway_id IS NULL OR gateway_id = $2
           OR gateway_heartbeat_at IS NULL OR gateway_heartbeat_at < now() - make_interval(secs => $3))
         RETURNING id`,
        [podId, this.deps.env.GATEWAY_ID, LEASE_STALE_SECONDS],
      ),
      resolvePodEnv({
        kek: this.deps.kek,
        podId: pod.id,
        orgId: pod.org_id,
        userId: pod.user_id,
        includeUserLayer: pod.resolved_config.layerOrder?.includes("user") ?? true,
        templateId: pod.template_id,
      }),
    ]);
    if ((lease.rowCount ?? 0) === 0) {
      throw conflict("pod is archived, unavailable, or attached to another gateway — retry after checking its state");
    }
    timings["attach_prepare"] = Date.now() - prepareStartedAt;

    const report = pod.resolved_config;
    const transportStartedAt = Date.now();

    let sandbox: Sandbox;
    let channel: FrameChannel;
    let resumed: boolean;
    let forkApplied = false;
    try {
      ({ sandbox, channel, resumed, forkApplied } = await withPodSandbox({ env: this.deps.env, kek: this.deps.kek, log: this.deps.log }, pod, async (sandbox) => {
        const markers = {
          ...creationMarkers({
            provider: pod.provider,
            project: pod.name,
            image: report.config.image,
            createdAtMs: Date.parse(pod.created_at),
            egress: report.egress.description,
          }),
          ...runtimeMarkers(sandbox.id),
        };

        const paths = podRuntimePaths(pod);
        const egressDescription = await ensureAgentdCallbackEgress({
          sandbox,
          description: report.egress.description,
          publicUrl: this.deps.env.PUBLIC_URL,
        });
        if (egressDescription !== report.egress.description) {
          report.egress.description = egressDescription;
          this.deps.log.info(`pod ${pod.id} provider egress updated for WebSocket callback`);
          await query(
            `UPDATE pods SET resolved_config = jsonb_set(resolved_config, '{egress,description}', to_jsonb($2::text), true),
                    updated_at = now()
             WHERE id = $1`,
            [pod.id, egressDescription],
          ).catch((e) => this.deps.log.warn(
            `could not persist WebSocket egress migration for ${pod.id}: ${e instanceof Error ? e.message : e}`,
          ));
        }
        // A connected transport proves the pod dials out: hot attach pays zero extra
        // execs. Otherwise a filesystem-only provider pause may have killed daemons but
        // kept their resolver config (stale Tailscale MagicDNS with no tailscaled
        // listening), so repair that before any transport check — every resumed
        // snapshot is covered with or without the resume hook.
        let channel: FrameChannel | null = this.podTransportRegistry.connected(pod.id);
        let resumed = channel !== null;
        let forkApplied = false;
        let supervisorRunning = channel !== null;
        let probeControlHostForReplace: string | undefined;
        if (!channel) {
          const resolverRepair = await repairStaleTailscaleResolver(sandbox);
          if (resolverRepair.action === "repaired-from-backup" || resolverRepair.action === "repaired-strip") {
            this.deps.log.info(`pod ${pod.id} ${describeResolverRepair(resolverRepair)}`);
          } else if (resolverRepair.action === "needs-attention") {
            this.deps.log.warn(`pod ${pod.id} ${describeResolverRepair(resolverRepair)}`);
          }
          const callbackHostForProbe = this.deps.env.PUBLIC_URL
            ? new URL(this.deps.env.PUBLIC_URL).hostname.toLowerCase()
            : undefined;
          probeControlHostForReplace = callbackHostForProbe
            ? probeControlHostFromDescription(report.egress.description, callbackHostForProbe)
            : undefined;
        }
        const dialUrlForProbe = agentdDialUrl(this.deps.env.PUBLIC_URL);
        // null = the provider exec itself failed: unknown, not dead. Unknown must never
        // read as dead — spawning or killing beside a possibly-live supervisor risks a
        // second Pi process next to the first.
        const supervisorState: boolean | null = channel
          ? true
          : await agentdSupervisorRunning(sandbox, paths).then((running) => running, () => null);

        // A live daemon may be between bounded reconnect attempts after an edge/gateway drop.
        // Give it one complete backoff window (see recoverDisconnectedSupervisor for the
        // grace-expiry policy); without a channel and without knowledge, fail retryably.
        // Only an explicitly dead supervisor is replaced — live and unknown keep their Pi.
        if (!channel && supervisorState === null) {
          throw conflict("pod supervisor state could not be verified — retry");
        }
        if (!channel && supervisorState) {
          try {
            ({ channel, resumed } = await recoverDisconnectedSupervisor({
              podId: pod.id,
              log: this.deps.log,
              isRunning: () => agentdSupervisorRunning(sandbox, paths).then((running) => running, () => null),
              waitForReconnect: () =>
                this.podTransportRegistry.waitFor(pod.id, AGENTD_RECONNECT_GRACE_MS).then((reconnected) => reconnected, () => null),
              replace: async () => {
                await stopAgentdSupervisor(sandbox, paths);
                this.podTransportRegistry.close(pod.id, "supervisor_replaced");
              },
            }));
          } catch (recoveryError) {
            // Non-destructive diagnosis only: the recovery decision stands, but when the
            // supervisor stays down a bounded probe names the cause (stale Tailscale
            // resolver vs egress vs transport) for the operator. Never stops, spawns,
            // or restarts anything — the sandbox is never restarted for DNS.
            if (recoveryError instanceof HttpError && recoveryError.statusCode === 409 && dialUrlForProbe) {
              const diagnosis = await transportNetworkProbe({
                sandbox,
                dialUrl: dialUrlForProbe,
                controlHost: probeControlHostForReplace,
              }).catch(() => "");
              if (diagnosis) {
                this.deps.log.warn(
                  `pod ${pod.id} transport diagnosis [${classifyTransportFailure(diagnosis)}]: ${diagnosis}`,
                );
              }
            }
            throw recoveryError;
          }
        }
        supervisorRunning = channel !== null;

        if (!channel) {
          // Starting Pi here means rebuilding this pod's launch from its record. A record
          // written by a retired protocol cannot be rebuilt, and says so (§ retired-launch-state).
          assertLaunchStateSupported(report, pod.id);
          await materializePodCredentialLeaseBestEffort(
            { kek: this.deps.kek, log: this.deps.log },
            pod,
            sandbox,
            podEnv,
          );
          const seed = await loadUnconsumedForkSeed(pod.id);
          const forkPath = seed ? paths.forkSeed : undefined;
          const [, identityEnv] = await Promise.all([
            prepareGatewayRuntime(sandbox, report.workdir, report.config.pi.sessionNaming, paths),
            podIdentityEnv(this.deps.env, pod),
            seed
              ? sandbox.uploadFile(paths.forkSeed, seed.content, 0o600)
              : Promise.resolve(),
          ]);
          const piArgv = gatewayPiArgv(report.config.pi, {
            forkPath,
            sessionFile: pod.pi_session_file ?? undefined,
          });
          // The resume hook restores in-memory-only process setup, so it runs only for a
          // cold runtime (no live supervisor): never on hot attach, never repeatedly over a
          // live Pi. Full init never reruns here; a missing hook is a clean noop.
          if (shouldRunResumeHook({ channelConnected: false, supervisorRunning })) {
            const resumeHook = await runResumeHook(sandbox, { env: markers });
            if (resumeHook.action === "failed") {
              this.deps.log.warn(
                `pod ${pod.id} resume hook failed (exit ${resumeHook.exitCode}); continuing without it`,
              );
            } else if (resumeHook.action === "skipped-missing") {
              // Observable on genuine resume: a cold runtime without the hook means
              // optional process restore (tailscaled, dummy device) did not run.
              this.deps.log.info(`pod ${pod.id} resume hook absent; skipping optional process restore`);
            }
          }
          // Same hosts the pre-replace probe above used: one derivation, two consumers.
          const probeControlHost = probeControlHostForReplace;
          // One egress re-apply attempt per cooldown window: the stored description is the
          // committed policy, but a long-lived sandbox's actual enforcement can predate it.
          const reapplyRecently =
            Date.now() - (this.egressReapplies.get(pod.id) ?? 0) < EGRESS_REAPPLY_COOLDOWN_MS;
          let started: Awaited<ReturnType<typeof startAgentdSupervisorWithEgressHeal>>;
          try {
            started = await startAgentdSupervisorWithEgressHeal({
              sandbox,
              piArgv,
              cwd: report.workdir,
              env: { ...podEnv, ...identityEnv, ...markers },
              paths,
              probeControlHost,
              // The same check the launch made, on the same record: a resource that was
              // deleted while the pod was stopped must not come back as a pod that starts
              // without it.
              piResources: report.piResources,
              egressDescription: report.egress.description,
              reapplyEgress: !reapplyRecently,
            });
          } catch (error) {
            this.egressReapplies.set(pod.id, Date.now());
            throw error;
          }
          const { cradle, egressReapplied } = started;
          if (egressReapplied) {
            this.deps.log.info(`pod ${pod.id} provider egress re-applied after transport failure`);
          }
          if (cradle === "pty-cradle") {
            this.deps.log.warn(`pod ${pod.id} provider killed detached exec; using a PTY process cradle`);
          }
          forkApplied = Boolean(seed);
          channel = await this.podTransportRegistry.waitFor(pod.id, HELLO_TIMEOUT_MS);
        }
        return { sandbox, channel, resumed, forkApplied };
      }, options.resumeHost === false ? { recoverStaleProviderState: false } : {}));
    } catch (e) {
      await this.releaseLease(pod.id);
      throw e;
    }
    timings["attach_transport"] = Date.now() - transportStartedAt;

    // Journal cursor only. A replacement Pi starts at seq 0; this must not decide whether
    // the next spawn resumes the session file (see gatewayPiArgv).
    if (!resumed) {
      await query("UPDATE pods SET last_pod_seq = 0, updated_at = now() WHERE id = $1", [pod.id]).catch((e) =>
        this.deps.log.warn(`could not reset last_pod_seq for ${pod.id}: ${e instanceof Error ? e.message : e}`),
      );
    }

    const sessionId = uuidv7();
    const [, scheduledRun] = await Promise.all([
      query("INSERT INTO sessions (id, pod_id, user_id) VALUES ($1, $2, $3)", [
        sessionId,
        pod.id,
        pod.user_id,
      ]),
      query<{ id: string }>(
        `SELECT id FROM job_runs
         WHERE pod_id = $1 AND status = 'running' AND prompted_at IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
        [pod.id],
      ),
    ]);
    const session: ActiveSession = {
      sessionId,
      pod,
      sandbox,
      channel,
      rpc: null as unknown as RemoteRpcClient,
      transportRebinding: false,
      seq: 0,
      clients: new Set(),
      remoteUiSurfaces: new Map(),
      remoteUiControls: new Map(),
      remoteUiOwners: new Map(),
      streamingUpdate: null,
      toolExecutionUpdates: new Map(),
      persistQueue: Promise.resolve(),
      modelCatalogQueue: Promise.resolve(),
      nameMirrorQueue: Promise.resolve(),
      activity: null as unknown as SessionActivityLease,
      scheduledRunId: scheduledRun.rows[0]?.id ?? null,
      startedAt: Date.now(),
      freshSpawn: !resumed,
      startupCrash: null,
      closed: false,
      persistFailed: false,
      stderrPersisted: 0,
      stderrDropped: 0,
      lastDecodedShimSeq: 0,
      readyProbe: null,
      piSessionFile: pod.pi_session_file,
      bashSnapshots: new Map(),
      auxInFlight: new Map(),
    };
    session.activity = new SessionActivityLease((mode) => this.refreshSessionActivity(session, mode));

    const rpc = new RemoteRpcClient({
      channel,
      onActivity: () => this.noteActivity(session),
    });
    session.rpc = rpc;

    rpc.onEvent((event) => this.handleEvent(session, event));
    let recordedHello = false;
    rpc.onControl((control) => {
      if (control.event === "background_work") {
        const count =
          typeof control.count === "number"
            ? control.count
            : control.active === true
              ? 1
              : 0;
        void session.activity
          .setBackgroundAgents(count)
          .catch((e) => this.deps.log.warn(`background work lease failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`));
        return;
      }
      // Keep the handshake hello for diagnostics, but suppress every later liveness answer
      // so a 30-second machine heartbeat does not become transcript noise.
      if (control.event === "hello") {
        const backlog = shimEventCheckpointBacklog({
          shimVersion: control.shimVersion,
          eventSeq: control.eventSeq,
          decodedSeq: session.lastDecodedShimSeq,
        });
        if (backlog !== null && backlog > 0) {
          this.deps.log.warn(
            `pod ${session.pod.id} shim event backlog ${backlog} (shim seq ${control.eventSeq}, decoded ${session.lastDecodedShimSeq})`,
          );
        }
        if (recordedHello) return;
        recordedHello = true;
      }
      if (control.event === "event_replay_gap") {
        applyEventReplayGap(control, session, {
          log: this.deps.log,
          refreshStreamingSnapshot: () => rpc.refreshStreamingSnapshot(),
        });
        this.rememberDecodedShimSeq(session);
      }
      if (control.event === "event_replay_end") {
        applyEventReplayEnd(control, session);
        this.rememberDecodedShimSeq(session);
      }
      const stored = persistableControlPayload(control, session);
      if (stored !== null) {
        void this.persist(session, "control", stored as Record<string, unknown>);
      }
      // Live control fan-out (account-mode-spec §6.1): a full-fidelity client needs pi's
      // exit and stderr as they happen; replay serves them as kind "control" events.
      this.fanOut(session, { type: "control", payload: control });
    });
    rpc.onLifecycleInvalidated(() => {
      // rebindChannel intentionally invalidates old in-flight requests after the new carrier
      // is installed; it is not a session ending. Real Pi exits and explicit closes still flow
      // through the ordinary end path.
      if (session.transportRebinding) return;
      // RpcClient invalidates before notifying control listeners, so inspect its recorded
      // exit code here rather than misclassifying a clean pi_exit as retryable transport loss.
      void this.endSession(session, sessionEndReasonForRpcInvalidation(rpc.exitCode));
    });

    const helloStartedAt = Date.now();
    try {
      const hello = await rpc.ensureHello(HELLO_TIMEOUT_MS);
      verifyHello(hello, channel);
      // A replacement gateway may have missed message_start and arbitrary deltas. Shim v7
      // observed the entire turn and restores one cumulative snapshot before clients attach.
      await rpc.refreshStreamingSnapshot();
      rpc.requestUiReplay(0);
      // Resume the pod-scoped journal cursor so a deploy/restart only asks for events the
      // previous gateway did not persist. A fresh Pi process starts at 0.
      const since = eventReplaySince({
        resumed,
        lastPodSeq: Number(hello.shimVersion) >= 9 ? pod.last_pod_seq : 0,
      });
      session.lastDecodedShimSeq = since;
      if (Number(hello.shimVersion) >= 9) rpc.requestEventReplay(since);
    } catch (e) {
      session.activity.stop();
      channel.close();
      await this.releaseLease(pod.id);
      await query("UPDATE sessions SET ended_at = now(), end_reason = 'handshake_failed' WHERE id = $1", [
        sessionId,
      ]);
      throw e;
    }
    timings["attach_hello"] = Date.now() - helloStartedAt;
    timings["attach_total"] = Date.now() - attachStartedAt;
    void recordPodTimings(pod.id, timings);
    this.deps.log.info(
      `pod ${pod.id} session attached in ${timings["attach_total"]}ms ` +
        `(prepare ${timings["attach_prepare"]}ms, transport ${timings["attach_transport"]}ms ${resumed ? "rebind" : "spawn"}, ` +
        `hello ${timings["attach_hello"]}ms${ensured.restarted ? ", after sandbox resume" : ""})`,
    );

    if (this.draining) {
      session.activity.stop();
      channel.close();
      await session.activity.drain();
      await this.releaseLease(pod.id);
      await query("UPDATE sessions SET ended_at = now(), end_reason = 'gateway_shutdown' WHERE id = $1", [sessionId]);
      throw conflict("gateway is shutting down — retry on its replacement");
    }

    // Publish only while the database still says this lease is usable. There is no await
    // between this CAS and the in-memory registration, so an archive either makes this fail or
    // sees the registered session in closePod().
    const publishable = await query(
      `UPDATE pods SET gateway_heartbeat_at = now(), updated_at = now()
       WHERE id = $1 AND state = 'active' AND provider_state = 'started' AND gateway_id = $2
       RETURNING id`,
      [pod.id, this.deps.env.GATEWAY_ID],
    );
    if ((publishable.rowCount ?? 0) === 0) {
      channel.close();
      await this.releaseLease(pod.id);
      await query("UPDATE sessions SET ended_at = now(), end_reason = 'state_changed' WHERE id = $1", [sessionId]);
      throw conflict("pod was archived or became unavailable while its session was opening");
    }

    this.sessions.set(pod.id, session);
    // A replacement gateway may join in the middle of a silent model call. Seed the semantic
    // lease from Pi's authoritative snapshot instead of waiting for another start event. This
    // runs behind publication because a cold Pi can spend tens of seconds installing project
    // packages after its shim has already said hello; startup latency must not fail the attach.
    // Early publication is safe: channel liveness pings the responsive shim, not Pi's RPC loop.
    session.readyProbe = ensureGatewaySessionReady(
      session,
      gatewaySessionReadyTimeoutMs(session.freshSpawn),
    );
    void seedGatewaySessionActivity({
      rpc,
      activity: session.activity,
      warn: (message) => this.deps.log.warn(message),
      podId: pod.id,
      onState: (state) => this.mirrorPiSessionFile(session, state.sessionFile),
    });
    this.deps.log.info(
      `gateway attached pod ${pod.id} (${resumed ? "resumed" : "fresh"} shim session, session ${sessionId})`,
    );
    await this.persist(session, "session_started", { resumed });
    if (forkApplied) await consumeForkSeed(pod.id);
    // A mobile prompt can predate the sandbox itself. Do not make a phone reconnect (or even
    // remain open) before handing those durable rows to the newly ready Pi session.
    await this.deliverQueuedPromptsForSession(session);
    await this.reconcileJobRuns(session, resumed);
    observeGatewayAttach(pod.provider, "ok", (Date.now() - attachStartedAt) / 1000);
    return session;
  }

  private async deliverQueuedPrompts(): Promise<void> {
    await this.demandQueuedPrompts();
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => !session.closed)
        .map((session) => this.deliverQueuedPromptsForSession(session)),
    );
  }

  /** Pending prompts are durable explicit user demand, including split API /
   * gateway deployments. Ordinary recovery sweep remains strictly passive. */
  async demandQueuedPrompts(): Promise<void> {
    await this.markStaleQueuedPromptsUnknown();
    const pending = await query<{ pod_id: string; org_id: string; user_id: string }>(`WITH due AS (
      SELECT p.id,q.user_id FROM pods p JOIN LATERAL (
        SELECT user_id FROM queued_prompts WHERE pod_id=p.id AND status='pending'
        ORDER BY created_at LIMIT 1) q ON true
      WHERE p.state='active' AND p.provider_state IN ('started','stopped','archived')
        AND (p.queued_prompt_demand_after IS NULL OR p.queued_prompt_demand_after<=now())
      ORDER BY p.queued_prompt_demand_after NULLS FIRST,p.id
      FOR UPDATE OF p SKIP LOCKED LIMIT 16)
      UPDATE pods p SET queued_prompt_demand_after=now()+interval '10 seconds'
      FROM due WHERE p.id=due.id RETURNING p.id AS pod_id,p.org_id,due.user_id`);
    const visited = new Set<string>();
    await Promise.all(pending.rows.map(async row => {
      if (visited.has(row.pod_id) || this.sessions.has(row.pod_id)) return;
      visited.add(row.pod_id);
      try {
        const pod = await getPod(row.org_id,row.pod_id);
        await assertPersonalPodAccess(pod,row.user_id);
        await this.ensureSession(row.org_id,row.pod_id);
      } catch (error) {
        // Durable rows stay pending during host boot/lease contention. No retry
        // means a new prompt; the existing fenced drain owns eventual delivery.
        if (!(error instanceof HttpError && [409,503].includes(error.statusCode))) {
          this.deps.log.warn(`queued prompt demand deferred for ${row.pod_id}`);
        }
      }
    }));
  }

  private deliverQueuedPromptsForSession(session: ActiveSession): Promise<void> {
    const existing = this.promptDrains.get(session.pod.id);
    if (existing) return existing;
    const drain = this.drainQueuedPrompts(session)
      .catch((error: unknown) => {
        // A transient database failure must not kill a fire-and-forget attach or
        // turn an already-published session into a failed attach. The next poll retries.
        this.deps.log.warn(sanitizeFailureMessage(error, {
          prefix: `queued prompt drain for pod ${session.pod.id} deferred`,
        }));
      })
      .finally(() => {
        if (this.promptDrains.get(session.pod.id) === drain) this.promptDrains.delete(session.pod.id);
      });
    this.promptDrains.set(session.pod.id, drain);
    return drain;
  }

  private async markStaleQueuedPromptsUnknown(podId?: string): Promise<void> {
    const stale = await this.queuedPromptStore.markStaleDeliveriesUnknown(podId);
    for (const row of stale) {
      const session = this.sessions.get(row.pod_id);
      if (!session || session.closed) continue;
      this.notifyQueuedPromptStatus(session, row.id, "unknown");
    }
  }

  private notifyQueuedPromptStatus(
    session: ActiveSession,
    queuedPromptId: string,
    status: Extract<ServerMessage, { type: "queued_prompt_status" }>['status'],
  ): void {
    this.fanOut(session, { type: "queued_prompt_status", queuedPromptId, status });
  }

  private async drainQueuedPrompts(session: ActiveSession): Promise<void> {
    await this.markStaleQueuedPromptsUnknown(session.pod.id);
    while (!session.closed && this.sessions.get(session.pod.id) === session) {
      // Pi rejects prompts mid-turn/compaction. Do not burn a claim or write a
      // transcript event while known busy; a later poll will retry this row.
      if (session.activity.blocksPrompt()) return;
      const prompt = await this.queuedPromptStore.claimNext(session.pod.id);
      if (!prompt) return;

      let promptDispatchStarted = false;
      try {
        await session.activity.grantDispatchLease();
        if (!isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)) {
          const status = await this.queuedPromptStore.markPreDispatchFailure(
            prompt.id, prompt.attempts, "session changed before prompt dispatch"
          );
          if (status) this.notifyQueuedPromptStatus(session, prompt.id, status);
          return;
        }
        const payload = { text: prompt.text, queuedPromptId: prompt.id };
        const { seq, ts } = await this.persist(session, "user_prompt", payload);
        this.fanOut(session, { type: "event", seq, kind: "user_prompt", payload, ts });
        if (!isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)) {
          const status = await this.queuedPromptStore.markPreDispatchFailure(
            prompt.id, prompt.attempts, "session changed before prompt dispatch"
          );
          if (status) this.notifyQueuedPromptStatus(session, prompt.id, status);
          return;
        }
        // request() transmits synchronously. A rejected promise is an unknown
        // transport outcome; a resolved success:false is Pi's preflight refusal.
        const dispatch = session.rpc.request({ type: "prompt", message: prompt.text });
        promptDispatchStarted = true;
        const response = await dispatch;
        if (!response.success) {
          // Pi has not started this agent turn. Only known busy errors are safe
          // to retry; input hooks may still observe each attempt (at most five).
          // Unknown/reworded errors fail terminally rather than retry side effects.
          if (classifyPiPromptRejection(response.error) === "retry") {
            const status = await this.queuedPromptStore.markPreDispatchFailure(
              prompt.id, prompt.attempts, "Pi is busy; retry after it settles",
            );
            if (status) this.notifyQueuedPromptStatus(session, prompt.id, status);
          } else if (await this.queuedPromptStore.markRejected(
            prompt.id, prompt.attempts, "Pi rejected prompt before agent execution",
          )) {
            this.notifyQueuedPromptStatus(session, prompt.id, "failed");
          }
          return;
        }
        if (await this.queuedPromptStore.markDelivered(prompt.id, prompt.attempts)) {
          this.notifyQueuedPromptStatus(session, prompt.id, "delivered");
        }
        // Pi can become streaming before agent_start reaches this gateway. A
        // second prompt waits for a later poll instead of being sent into that gap.
        return;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (promptDispatchStarted) {
          if (await this.queuedPromptStore.markUnknown(prompt.id, prompt.attempts, message).catch(() => false)) {
            this.notifyQueuedPromptStatus(session, prompt.id, "unknown");
          }
        } else {
          const status = await this.queuedPromptStore.markPreDispatchFailure(
            prompt.id, prompt.attempts, message
          ).catch(() => null);
          if (status) this.notifyQueuedPromptStatus(session, prompt.id, status);
        }
        this.deps.log.warn(
          `queued prompt ${prompt.id} for pod ${session.pod.id} was not confirmed: ${message}`,
        );
        // Avoid retrying a failed or ambiguous channel in a tight loop. Only
        // proven pre-dispatch failures remain eligible for a later admission.
        return;
      }
    }
  }

  /** Persistence-first (spec §9.1): durable with a monotonic seq BEFORE fan-out.
   *  A rejected INSERT is retried once; a second failure ends the session so later events
   *  cannot consume seqs around a permanent hole. */
  private persist(session: ActiveSession, kind: string, payload: unknown): Promise<PersistedEvent> {
    const result = session.persistQueue.then(async () => {
      if (session.persistFailed) {
        throw new Error(`event persist refused for session ${session.sessionId}: persist channel failed`);
      }
      const seq = ++session.seq;
      const stored = persistablePayload(kind, payload);
      let inserted: PersistedEvent;
      try {
        inserted = await this.insertSessionEvent(session.sessionId, seq, kind, stored);
      } catch (first) {
        try {
          inserted = await this.insertSessionEvent(session.sessionId, seq, kind, stored);
        } catch (second) {
          session.persistFailed = true;
          this.deps.log.error(
            `event persist failed for session ${session.sessionId} after retry: ${second}`,
          );
          if (!session.closed) void this.endSession(session, "persist_failed");
          throw second;
        }
      }
      this.rememberDecodedShimSeq(session);
      return inserted;
    });
    session.persistQueue = result.then(
      () => undefined,
      (e) => {
        this.deps.log.error(
          sanitizeFailureMessage(e, { prefix: `event persist failed for session ${session.sessionId}` }),
        );
      },
    );
    return result;
  }

  /** Test seam: the INSERT itself, so a stub can fail without a live database. */
  private async insertSessionEvent(
    sessionId: string,
    seq: number,
    kind: string,
    payload: unknown,
  ): Promise<PersistedEvent> {
    const inserted = await query<{ created_at: string | Date }>(
      "INSERT INTO session_events (session_id, seq, kind, payload) VALUES ($1, $2, $3, $4) RETURNING created_at",
      [sessionId, seq, kind, JSON.stringify(payload ?? {})],
    );
    return { seq, ts: new Date(inserted.rows[0]!.created_at).toISOString() };
  }

  /** Durable pod-scoped journal cursor for the next replacement gateway. */
  private async writeLastPodSeq(podId: string, seq: number): Promise<void> {
    if (!Number.isFinite(seq) || seq < 0) return;
    await query(
      `UPDATE pods SET last_pod_seq = GREATEST(COALESCE(last_pod_seq, 0), $2) WHERE id = $1`,
      [podId, seq],
    );
  }

  private rememberDecodedShimSeq(session: ActiveSession): void {
    void this.writeLastPodSeq(session.pod.id, session.lastDecodedShimSeq).catch((e) =>
      this.deps.log.warn(`last_pod_seq write failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`),
    );
  }

  /** Fan out with no durable row, serialized behind the persist queue so clients still see
   * these in emission order relative to their durable neighbors (message_start/message_end). */
  private fanOutEphemeral(session: ActiveSession, kind: string, payload: unknown): void {
    session.persistQueue = session.persistQueue.then(() => {
      this.fanOut(session, { type: "ephemeral", kind, payload });
    });
  }

  private handleEvent(session: ActiveSession, event: AgentSessionEvent): void {
    session.lastDecodedShimSeq += 1;
    const kind = (event as { type?: string }).type ?? "event";
    void session.activity
      .applyEvent(kind)
      .catch((e) => this.deps.log.warn(`activity lease failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`));

    // Session service replies are correlated server↔pod control traffic. Consume them before
    // generic extension UI fan-out so snippets/catalog chunks never appear as notifications.
    if (isSessionExtensionEvent(event)) return;

    const remoteUi = remoteUiFrameFromExtensionRequest(event as never);
    if (remoteUi) {
      // A component can repaint on every key or timer tick. Persisting those frames would turn
      // terminal animation into transcript rows and push notifications; cache only the latest
      // render and the one input request Pi is currently awaiting.
      if (remoteUi.kind === "control") {
        // Retain only the newest value for each control, so reconnect restores current loader
        // state without persisting animation/control traffic as transcript history.
        session.remoteUiControls.set(remoteUi.action, event);
        this.fanOut(session, { type: "ephemeral", kind, payload: event });
        return;
      }
      const frame = remoteUi as RemoteUiSurfaceFrame;
      if (frame.kind === "close") {
        session.remoteUiSurfaces.delete(frame.surfaceId);
        session.remoteUiOwners.delete(frame.surfaceId);
      } else {
        if (!session.remoteUiSurfaces.has(frame.surfaceId) && session.remoteUiSurfaces.size >= REMOTE_UI_MAX_SURFACES) {
          const oldest = session.remoteUiSurfaces.keys().next().value as string | undefined;
          if (oldest) {
            session.remoteUiSurfaces.delete(oldest);
            session.remoteUiOwners.delete(oldest);
          }
        }
        const cached = session.remoteUiSurfaces.get(frame.surfaceId) ?? {};
        if ((event as { method?: string }).method === "input") cached.input = event;
        else cached.frame = event;
        session.remoteUiSurfaces.set(frame.surfaceId, cached);
      }
      this.fanOut(session, { type: "ephemeral", kind, payload: event });
      return;
    }

    if (kind === "bash_execution_update") {
      const bashId = typeof (event as { id?: unknown }).id === "string" ? (event as { id: string }).id : null;
      const delta = typeof (event as { delta?: unknown }).delta === "string" ? (event as { delta: string }).delta : "";
      if (bashId) {
        if (!session.bashSnapshots.has(bashId) && session.bashSnapshots.size >= MAX_TOOL_EXECUTION_SNAPSHOTS) {
          const oldest = session.bashSnapshots.keys().next().value as string | undefined;
          if (oldest) session.bashSnapshots.delete(oldest);
        }
        session.bashSnapshots.set(bashId, bashSnapshotAccumulate(session.bashSnapshots.get(bashId), delta));
      }
      this.fanOut(session, { type: "ephemeral", kind, payload: event });
      void this.persist(session, kind, persistablePayload(kind, event)).catch((err) =>
        this.deps.log.warn(`bash persist failed for ${session.pod.id}: ${err instanceof Error ? err.message : err}`),
      );
      return;
    }
    if (kind === "bash_execution_end") {
      const bashId = typeof (event as { id?: unknown }).id === "string" ? (event as { id: string }).id : null;
      if (bashId) session.bashSnapshots.delete(bashId);
    }
    if (kind === "message_update") {
      // RpcClientBase reduces Pi 0.84's wire deltas into a whole partial message. Keep that
      // stable pp gateway contract: live/mobile clients replace one bubble, attaching clients
      // get the cached newest after durable replay, and message_end supersedes it.
      session.streamingUpdate = event;
      this.fanOutEphemeral(session, kind, event);
      return;
    }
    if (kind === "tool_execution_update") {
      // Same shape as message_update: an incremental delta the client renders by replacing the
      // whole tool bubble keyed on toolCallId, superseded seconds later by tool_execution_end.
      // Persisting these wrote ~248 rows per execution — 2.7M rows and 6.1 GB in six days, which
      // filled the database volume and took every write on the cluster down with it. Cache the
      // newest per call and fan out; the durable start/end pair still carries the transcript.
      const callId = toolCallIdFor(event);
      if (callId !== null) {
        if (
          !session.toolExecutionUpdates.has(callId) &&
          session.toolExecutionUpdates.size >= MAX_TOOL_EXECUTION_SNAPSHOTS
        ) {
          const oldest = session.toolExecutionUpdates.keys().next().value as string | undefined;
          if (oldest) session.toolExecutionUpdates.delete(oldest);
        }
        session.toolExecutionUpdates.set(callId, event);
      }
      this.fanOutEphemeral(session, kind, event);
      return;
    }
    if (kind === "tool_execution_end") {
      const callId = toolCallIdFor(event);
      if (callId !== null) session.toolExecutionUpdates.delete(callId);
    }
    if (kind === "message_end" || kind === "agent_end" || kind === "agent_settled") {
      session.streamingUpdate = null;
    }
    if (kind === "agent_end" || kind === "agent_settled") {
      // A tool killed mid-flight never sends tool_execution_end. Once the agent settles nothing
      // is running, so drop the snapshots rather than replaying them onto a later attach.
      session.toolExecutionUpdates.clear();
    }

    void (async () => {
      const { seq, ts } = await this.persist(session, kind, persistablePayload(kind, event));
      this.fanOut(session, { type: "event", seq, kind, payload: event, ts });
      // pi owns the session name. Mirror /name and auto-name changes into the durable pod row
      // without delaying interaction persistence or notifications on this event path.
      this.mirrorSessionName(session, kind, event);

      const redacted = session.pod.resolved_config.notificationsRedacted;
      if (isInteractionEvent(kind, event) && !(await this.interactionAlreadyRecorded(session.pod.id, event))) {
        const interactionId = uuidv7();
        await query(
          `INSERT INTO pending_interactions (id, session_id, seq, kind, payload)
           VALUES ($1, $2, $3, $4, $5)`,
          [interactionId, session.sessionId, seq, interactionKind(kind, event), JSON.stringify(event)],
        );
        this.fanOut(session, {
          type: "interaction",
          interactionId,
          seq,
          kind: interactionKind(kind, event),
          payload: event,
          ts,
        });
        if (session.clients.size === 0) {
          await enqueuePush(session.pod.user_id, {
            title: redacted ? "pi needs input" : `${session.pod.name}: approval needed`,
            body: redacted ? "" : interactionSummary(interactionKind(kind, event), event),
            interruptionLevel: "time-sensitive",
            data: {
              pod_id: session.pod.id,
              org_id: session.pod.org_id,
              session_id: session.sessionId,
              seq,
              interaction_id: interactionId,
              kind: "interaction_pending",
            },
          });
        }
      }

      if (kind === "agent_settled") {
        // `agent_end` is not terminal: retries and automatic compaction may follow. A
        // scheduled run succeeds only at the shim's authoritative settled boundary.
        const scheduledRunId = session.scheduledRunId;
        const completed = scheduledRunId
          ? await query<{ id: string; job_id: string }>(
              `UPDATE job_runs SET status = 'completed', finished_at = now()
               WHERE id = $1 AND pod_id = $2 AND status = 'running' RETURNING id, job_id`,
              [scheduledRunId, session.pod.id],
            )
          : null;
        session.scheduledRunId = null;
        observeJobRun("completed", completed?.rows.length ?? 0);
        for (const run of completed?.rows ?? []) {
          await audit({
            orgId: session.pod.org_id,
            actorId: session.pod.user_id,
            action: "job.run",
            targetType: "job",
            targetId: run.job_id,
            detail: { runId: run.id, podId: session.pod.id, sessionId: session.sessionId },
          }).catch((e) => this.deps.log.warn(`job ${run.job_id} audit failed: ${e}`));
        }

        if (session.clients.size === 0) {
          await enqueuePush(session.pod.user_id, {
            title: redacted ? "pi finished a task" : `pi finished: ${session.pod.name}`,
            body: redacted ? "" : turnEndSummary(event, session.pod.name),
            data: {
              pod_id: session.pod.id, org_id: session.pod.org_id,
              session_id: session.sessionId, seq, kind: "turn_completed",
            },
          });
        }
      }
    })().catch((e) => {
      this.deps.log.error(
        `event handler failed for session ${session.sessionId}: ${e instanceof Error ? e.message : e}`,
      );
    });
  }

  /** Tell live session clients the durable pod row changed. No-op without a session. */
  announcePodUpdated(podId: string, name: string): void {
    const session = this.sessions.get(podId);
    if (!session || session.closed) return;
    session.pod.name = name;
    this.fanOut(session, { type: "pod_updated", id: podId, name });
  }

  /** Durably note which session file pi has open, so a later restart pins it with `--session`. */
  private mirrorPiSessionFile(session: ActiveSession, sessionFile: unknown): void {
    if (typeof sessionFile !== "string" || sessionFile === "" || sessionFile === session.piSessionFile) return;
    session.piSessionFile = sessionFile;
    session.pod.pi_session_file = sessionFile;
    void query(
      `UPDATE pods SET pi_session_file = $2, updated_at = now()
       WHERE id = $1 AND gateway_id = $3`,
      [session.pod.id, sessionFile, this.deps.env.GATEWAY_ID],
    ).catch((e) =>
      this.deps.log.warn(`pi session file mirror failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`),
    );
  }

  /** Watch forwarded commands for session movement; a state snapshot rides through for free. */
  private observePiSessionSteering(
    session: ActiveSession,
    command: Record<string, unknown>,
    response: unknown,
  ): void {
    if (typeof response !== "object" || response === null) return;
    if ((response as { success?: unknown }).success !== true) return;
    switch (command["type"]) {
      case "get_state": {
        const data = (response as { data?: { sessionFile?: unknown } }).data;
        this.mirrorPiSessionFile(session, data?.sessionFile);
        return;
      }
      case "switch_session":
      case "new_session":
        void requestGatewaySessionState(session.rpc)
          .then((state) => this.mirrorPiSessionFile(session, state.sessionFile))
          .catch(() => {});
        return;
    }
  }

  private mirrorSessionName(session: ActiveSession, kind: string, event: unknown): void {
    const name = podNameFromSessionEvent(kind, event);
    if (name === null) return;

    // Notifications read this copy; the socket event waits on the durable write below.
    session.pod.name = name;
    session.nameMirrorQueue = session.nameMirrorQueue
      .then(async () => {
        const updated = await persistThenAnnouncePodName({
          persist: async () => {
            const result = await query(
              `UPDATE pods SET name = $2, updated_at = now()
               WHERE id = $1 AND gateway_id = $3`,
              [session.pod.id, name, this.deps.env.GATEWAY_ID],
            );
            return (result.rowCount ?? 0) > 0;
          },
          announce: () => this.announcePodUpdated(session.pod.id, name),
        });
        if (!updated) {
          this.deps.log.warn(`pod name mirror skipped for ${session.pod.id}: gateway lease was lost`);
        }
      })
      .catch((e) => {
        // Event delivery must survive a best-effort metadata mirror failure.
        this.deps.log.warn(`pod name mirror failed for ${session.pod.id}: ${e}`);
      });
  }

  private fanOut(session: ActiveSession, message: ServerMessage): void {
    for (const client of session.clients) {
      try {
        client.send(message);
      } catch {
        session.clients.delete(client);
      }
    }
  }

  private noteActivity(session: ActiveSession): void {
    if (!shouldRenewTrafficActivity({
      carrier: "provider_pty",
      clientCount: session.clients.size,
      workActive: session.activity.hasWork(),
    })) return;
    void session.activity
      .noteTraffic()
      .catch((e) => this.deps.log.warn(`activity refresh failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`));
  }

  private async refreshSessionActivity(session: ActiveSession, mode: WorkLeaseMode): Promise<void> {
    if (session.closed) return;
    // Renewals include background heartbeats and attach-time snapshot seeding.
    // They must fence stop, but never undo it by submitting new resume intent.
    // User attach/command admission has already requested resume separately.
    const host = await hostForPod(session.pod);
    if (host) requireHostAwake(host);
    if (host?.owner_user_id != null && !await edition().admitOwnedHostActivity(host.id, session.pod.user_id)) {
      throw serviceUnavailable("the pod's host is stopping or starting", {
        reason: "host_starting", retryable: true, hostId: host.id,
        statusHref: `/v1/workstations/${encodeURIComponent(host.id)}`, retryAfterMs: 10_000,
      });
    }
    if (session.closed) return;
    const [providerResult, databaseResult] = await Promise.allSettled([
      withTimeout(
        session.sandbox.refreshActivity(),
        PROVIDER_ACTIVITY_TIMEOUT_MS,
        `provider activity refresh timed out for pod ${session.pod.id}`,
      ),
      query<{ id: string }>(
        `UPDATE pods SET last_activity_at = now(),
           work_lease_until = CASE
             WHEN $3 = 'extend' THEN now() + make_interval(secs => $4)
             WHEN $3 = 'clear' THEN NULL
             ELSE work_lease_until END,
           updated_at = now()
         WHERE id = $1 AND gateway_id = $2 AND state = 'active' AND provider_state = 'started'
         RETURNING id`,
        [session.pod.id, this.deps.env.GATEWAY_ID, mode, WORK_LEASE_SECONDS],
      ),
    ]);
    if (databaseResult.status === "rejected") throw databaseResult.reason;
    if ((databaseResult.value.rowCount ?? 0) === 0) {
      throw conflict("pod became unavailable while activity was being renewed");
    }
    if (providerResult.status === "rejected") throw providerResult.reason;
  }

  private async refreshBusySessions(): Promise<void> {
    const sessions = [...this.sessions.values()].filter((session) => !session.closed);
    await Promise.all(
      sessions.map(async (session) => {
        // A timer is not a new user request. Stop renewing cached transports
        // after whole-host sleep rather than undoing an explicit/TTL stop.
        const host = await hostForPod(session.pod);
        if (host && !hostCanDial(host)) {
          await this.endSession(session, "host_stopped");
          return;
        }
        await session.activity
          .heartbeat()
          .catch((e) => this.deps.log.warn(`busy activity refresh failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`));
      }),
    );
  }

  /** A server-initiated prompt (jobs): persisted and fanned out like any client's, so every
   * surface that attaches later sees the transcript begin with it. */
  async promptPod(
    orgId: string,
    podId: string,
    args: { jobRunId: string; text: string; model?: { provider: string; id: string } | null },
  ): Promise<void> {
    const session = await this.ensureSession(orgId, podId);
    const dispatchable = await query(
      `SELECT id FROM job_runs WHERE id = $1 AND pod_id = $2 AND status = 'running'`,
      [args.jobRunId, podId],
    );
    if ((dispatchable.rowCount ?? 0) === 0) throw conflict("scheduled job run is no longer active");
    await session.activity.grantDispatchLease();
    if (args.model) await session.rpc.setModel(args.model.provider, args.model.id);
    const claimedDispatch = await query(
      `UPDATE job_runs SET prompted_at = now()
       WHERE id = $1 AND pod_id = $2 AND status = 'running' RETURNING id`,
      [args.jobRunId, podId],
    );
    if ((claimedDispatch.rowCount ?? 0) === 0) {
      throw conflict("scheduled job run ended before prompt dispatch");
    }
    try {
      await deliverUserPrompt({
        text: args.text,
        persist: (payload) => this.persist(session, "user_prompt", payload),
        fanOut: (seq, ts, payload) => {
          this.fanOut(session, { type: "event", seq, kind: "user_prompt", payload, ts });
        },
        // Set the correlation marker in the same synchronous callback that writes the prompt
        // command, leaving no await window for an unrelated turn to claim this run.
        prompt: () => {
          session.scheduledRunId = args.jobRunId;
          return session.rpc.prompt(args.text);
        },
      });
    } catch (e) {
      if (session.scheduledRunId === args.jobRunId) session.scheduledRunId = null;
      throw e;
    }
  }

  /**
   * Detect a read-side half-open provider stream while a client is attached or semantic work is
   * active. An idle detached session is deliberately re-probed on the next attach: otherwise the
   * liveness write itself is PTY input and prevents provider-enforced idle-stop forever.
   */
  private async probeSessionChannels(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(
      sessions.map(async (session) => {
        if (!sessionNeedsChannelProbe(session.clients.size, session.activity.hasWork())) return;
        const host = await hostForPod(session.pod);
        if (host && !hostCanDial(host)) {
          await this.endSession(session, "host_stopped");
          return;
        }
        const outcome = await probeGatewayChannel({
          rpc: session.rpc,
          hasEnded: () => session.closed || this.sessions.get(session.pod.id) !== session,
        });
        if (outcome !== "lost" || session.closed || this.sessions.get(session.pod.id) !== session) return;
        this.deps.log.warn(`pod channel stopped answering liveness probes: ${session.pod.id}`);
        await this.endSession(session, "transport_lost");
      }),
    );
  }

  async attachClient(args: {
    orgId: string;
    podId: string;
    fromSeq: number | null;
    fromSessionId: string | null;
    sink: WsSink;
    signal?: AbortSignal | undefined;
  }): Promise<{ detach: () => void; handle: (message: ClientMessage) => Promise<void> }> {
    // Job custody and initial session acquisition stay parallel on the hot path. A replacement
    // before hello is retried against the newly current session without exposing a 409.
    const [pendingJob, initialSession] = await Promise.all([
      query(
        `SELECT 1 FROM job_runs
         WHERE pod_id = $1 AND status = 'running' LIMIT 1`,
        [args.podId],
      ),
      this.ensureSession(args.orgId, args.podId),
    ]);
    if ((pendingJob.rowCount ?? 0) > 0) {
      throw conflict("scheduled job is still delivering its initial prompt — retry in a moment");
    }

    let prefetchedSession: ActiveSession | null = initialSession;
    try {
      return await retrySessionAttach({
        signal: args.signal,
        attempt: async () => {
          const session = prefetchedSession ?? await this.ensureSession(args.orgId, args.podId);
          prefetchedSession = null;
          return this.attachClientToSession(args, session);
        },
        onRetry: (attempt) => {
          this.deps.log.warn(
            `pod session changed during client attach; retrying ${args.podId} (${attempt}/${ATTACH_SESSION_RETRY_ATTEMPTS})`,
          );
        },
      });
    } catch (error) {
      if (error instanceof SessionChangedDuringAttachError) {
        // Deterministic crash: surface pi's own evidence as a terminal error instead of the
        // channel-replacement symptom, which the client would uselessly retry.
        if (error.crash) throw new HttpError(502, formatPiStartupCrash(error.crash));
        // Deterministic stall: same posture — name the failure honestly and tell the user the
        // one action that clears it, instead of letting every layer retry a futile attach.
        if (error.stall) throw new HttpError(502, formatOversizedStall(error.stall));
        throw conflict("pod session channel changed while the client was attaching — retry");
      }
      throw error;
    }
  }

  /**
   * Semantic aux completion admission + supervision. The slot is reserved synchronously —
   * no await sits between the cap/duplicate checks and the map insert — so concurrent
   * receives cannot both pass admission and then both insert (cap overflow or a duplicate
   * caller id clobbering the first op). The activity lease is acquired inside the
   * try/finally, so a lease-acquisition throw still runs the identity-checked cleanup and
   * never squats the id or leaks the cap. Replies go only to the owning, still-attached
   * sink — never fanned out — and every map delete is identity-checked so a late first
   * result can never delete a later entry.
   */
  private async handleAuxComplete(
    session: ActiveSession,
    auxRequest: AuxCompleteRequest,
    sink: WsSink,
  ): Promise<void> {
    const extensionVersion = session.rpc.helloInfo?.extensionVersion;
    if (!(typeof extensionVersion === "number" && extensionVersion >= AUX_MIN_EXTENSION_VERSION)) {
      sink.send({ type: "aux_complete_result", ...auxExtensionUnsupported(auxRequest.id) });
      return;
    }
    if (session.auxInFlight.size >= AUX_GATEWAY_CONCURRENCY_LIMIT) {
      sink.send({
        type: "aux_complete_result",
        id: auxRequest.id,
        ok: false,
        code: "busy",
        error: "too many concurrent aux completions",
      });
      return;
    }
    if (session.auxInFlight.has(auxRequest.id)) {
      sink.send({
        type: "aux_complete_result",
        id: auxRequest.id,
        ok: false,
        code: "invalid_request",
        error: "aux completion id is already in flight",
      });
      return;
    }
    const entry = { controller: new AbortController(), sink, wireId: randomUUID() };
    session.auxInFlight.set(auxRequest.id, entry);
    let releaseAuxLease: (() => Promise<void>) | null = null;
    try {
      releaseAuxLease = await session.activity.beginExplicitWork();
    } catch (e) {
      if (session.auxInFlight.get(auxRequest.id) === entry) session.auxInFlight.delete(auxRequest.id);
      sink.send({
        type: "aux_complete_result",
        id: auxRequest.id,
        ok: false,
        code: "completion_failed",
        error: e instanceof Error ? e.message.slice(0, 1024) : "aux completion failed",
      });
      return;
    }
    try {
      const result = await invokeAuxComplete(session.rpc, auxRequest, {
        signal: entry.controller.signal,
        wireId: entry.wireId,
      });
      if (session.auxInFlight.get(auxRequest.id) === entry && session.clients.has(entry.sink)) {
        entry.sink.send({ type: "aux_complete_result", ...result });
      }
    } catch (e) {
      if (session.auxInFlight.get(auxRequest.id) === entry && session.clients.has(entry.sink)) {
        const cancelled = entry.controller.signal.aborted;
        entry.sink.send({
          type: "aux_complete_result",
          id: auxRequest.id,
          ok: false,
          code: cancelled ? "cancelled" : "completion_failed",
          error: e instanceof Error ? e.message.slice(0, 1024) : "aux completion failed",
        });
      }
    } finally {
      if (session.auxInFlight.get(auxRequest.id) === entry) session.auxInFlight.delete(auxRequest.id);
      if (releaseAuxLease) {
        await releaseAuxLease().catch((e) =>
          this.deps.log.warn(`aux activity release failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`),
        );
      }
    }
  }

  /**
   * Cancel an in-flight aux op. Only the owning sink may cancel, and the pod is told by
   * server-generated wire id — never the caller-supplied id. Unknown ids and non-owner
   * cancels are silent no-ops: no error channel, no pod traffic for unknown ids.
   */
  private handleAuxCancel(session: ActiveSession, callerId: string, sink: WsSink): void {
    const entry = session.auxInFlight.get(callerId);
    if (!entry || entry.sink !== sink) return;
    entry.controller.abort();
    try {
      fireAuxCancel(session.rpc, entry.wireId);
    } catch {
      // Best-effort: the pod-side abort is a courtesy, never a socket error.
    }
  }

  /** Abort (and drop replies for) every aux op owned by a detached sink. */
  private abortAuxOwnedBy(session: ActiveSession, sink: WsSink): void {
    for (const [id, entry] of session.auxInFlight) {
      if (entry.sink !== sink) continue;
      entry.controller.abort();
      try {
        fireAuxCancel(session.rpc, entry.wireId);
      } catch {
        // Best-effort pod-side abort.
      }
      if (session.auxInFlight.get(id) === entry) session.auxInFlight.delete(id);
    }
  }

  /** Abort every in-flight aux op; late pod replies correlate to nothing and are dropped. */
  private abortAuxForSession(session: ActiveSession): void {
    for (const [, entry] of session.auxInFlight) {
      entry.controller.abort();
      try {
        fireAuxCancel(session.rpc, entry.wireId);
      } catch {
        // Best-effort pod-side abort.
      }
    }
    session.auxInFlight.clear();
  }

  private async attachClientToSession(
    args: {
      orgId: string;
      podId: string;
      fromSeq: number | null;
      fromSessionId: string | null;
      sink: WsSink;
      signal?: AbortSignal | undefined;
    },
    session: ActiveSession,
  ): Promise<{ detach: () => void; handle: (message: ClientMessage) => Promise<void> }> {
    await this.admitSessionHost(session);

    // Establish an ordered replay-to-live handoff. Once the persistence queue is caught up,
    // capture its watermark and register a buffering sink before doing any more async work.
    // Events above the watermark are buffered, while the durable prefix is replayed first.
    try {
      await withTimeout(
        session.persistQueue,
        SESSION_PERSIST_BARRIER_TIMEOUT_MS,
        `session event persistence did not settle for pod ${session.pod.id}`,
      );
    } catch (e) {
      throw conflict(
        `pod session replay is temporarily unavailable — retry (${e instanceof Error ? e.message : e})`,
      );
    }
    if (session.closed || this.sessions.get(session.pod.id) !== session) {
      throw new SessionChangedDuringAttachError(session.startupCrash);
    }
    const replayThrough = session.seq;
    const provisional = createProvisionalAttachSink(args.sink);
    const clientSink = provisional.sink;
    session.clients.add(clientSink);

    try {
      await this.refreshAttachedLease(session.pod.id);
      let state: unknown;
      const decoderBefore = session.rpc.decoderStats();
      // The transport this probe travels on: a reconnect that lands mid-probe discards its
      // answer, and that rejection must not read as Pi unresponsiveness.
      const generationBefore = session.rpc.transportGeneration;
      try {
        state = await ensureGatewaySessionReady(session);
      } catch (e) {
        // A client abort detaches only that client: the shared session (and its jobs) is
        // never ended or retired for it, and no further probe traffic goes out.
        if (args.signal?.aborted) throw new SessionChangedDuringAttachError(session.startupCrash);
        // An oversized frame — an old shim replaying a multi-megabyte journaled event — shows up
        // as pendingBytes piling up while not one line completes during this attach. Name it,
        // and mark the replacement non-retryable: every attempt re-buffers the same line.
        const decoderAfter = session.rpc.decoderStats();
        const stalled =
          decoderAfter.pendingBytes >= OVERSIZED_STALL_MIN_PENDING_BYTES &&
          decoderAfter.decodedLines === decoderBefore.decodedLines;
        this.deps.log.warn(
          formatAttachTelemetry("pi_rpc_ready_failed", {
            podId: session.pod.id,
            sessionId: session.sessionId,
            provider: session.pod.provider,
            timeoutPhase: "pi_rpc_ready",
            pendingRpcCount: session.rpc.pendingCount,
            decoderMalformed: decoderAfter.malformedLines,
            decoderNoise: decoderAfter.noiseLines,
            decoderPendingBytes: decoderAfter.pendingBytes,
          }) + `: ${e instanceof Error ? e.message : e}`,
        );
        const current = !session.closed && this.sessions.get(session.pod.id) === session;
        if (current && !stalled && classifyAttachReadinessFailure({ error: e, rpc: session.rpc, generationBefore }) === "transport") {
          await this.sustainAttachAcrossTransportFailure(session, args.signal);
        }
        if (current) {
          if (stalled) {
            void this.endSession(session, "transport_lost");
          } else {
            // Same transport throughout and it still carries traffic — but confirm it is
            // genuinely alive first. A half-open socket also times out get_state, yet killing
            // the supervisor behind it would destroy live tools for a network failure. The
            // confirmation is always a fresh round trip: recent traffic proves nothing about
            // whether the shim still answers, so only an actual hello reply retires.
            const generationBeforeLiveness = session.rpc.transportGeneration;
            const liveness = await probeGatewayChannel({
              rpc: session.rpc,
              hasEnded: () => session.closed || this.sessions.get(session.pod.id) !== session,
              staleAfterMs: 0,
              // Referenced (no unref): this confirmation gates a destructive decision, so
              // the attach holds its own wait instead of borrowing the event loop.
              sleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
            });
            if (!session.closed && this.sessions.get(session.pod.id) === session) {
              if (session.rpc.transportGeneration !== generationBeforeLiveness) {
                // A reconnect landed during confirmation and its hello may be what answered:
                // that liveness belongs to the new transport, not proof against Pi. The
                // probe failure is transport-classed and retried without retirement.
                await this.sustainAttachAcrossTransportFailure(session, args.signal);
              } else if (liveness === "alive") {
                this.deps.log.warn(`pod ${session.pod.id} Pi RPC stayed unresponsive; replacing its supervisor`);
                await this.endSession(session, "transport_lost", { retireSupervisor: true });
              } else if (liveness === "lost") {
                this.deps.log.warn(
                  `pod ${session.pod.id} Pi RPC stayed unresponsive and its transport is down; ending the session without retiring its supervisor`,
                );
                await this.endSession(session, "transport_lost");
              }
              // "ended": the session went away during confirmation; just ask for a retry.
            }
          }
        }
        throw new SessionChangedDuringAttachError(
          session.startupCrash,
          stalled ? { pendingBytes: decoderAfter.pendingBytes, decodedLines: decoderAfter.decodedLines } : null,
        );
      }

      let replayFrom = 0;
      let replayRows: Array<{ seq: string; kind: string; payload: unknown; created_at: string | Date }> = [];
      if (args.fromSeq !== null) {
        replayFrom = replayFromForSession({
          fromSeq: args.fromSeq,
          fromSessionId: args.fromSessionId,
          currentSessionId: session.sessionId,
          latestSeq: replayThrough,
        });
        const rows = await query<{ seq: string; kind: string; payload: unknown; created_at: string | Date }>(
          `SELECT seq, kind, payload, created_at FROM (
             SELECT seq, kind, payload, created_at FROM session_events
             WHERE session_id = $1 AND seq > $2 AND seq <= $3
             ORDER BY seq DESC LIMIT $4
           ) replay_tail ORDER BY seq`,
          [session.sessionId, replayFrom, replayThrough, MAX_SOCKET_REPLAY],
        );
        replayRows = rows.rows;
      }
      const firstReplayedSeq = replayRows.length > 0 ? Number(replayRows[0]!.seq) : null;
      const unanswered = await unansweredInteractionFrames(session.sessionId);
      const truncation = await query<{ events_truncated_below_seq: string | null }>(
        "SELECT events_truncated_below_seq FROM sessions WHERE id = $1",
        [session.sessionId],
      );
      const truncatedBelowSeq = truncation.rows[0]?.events_truncated_below_seq != null
        ? Number(truncation.rows[0].events_truncated_below_seq)
        : null;
      const firstAvailableSeq = helloFirstAvailableSeq({ replayFrom, truncatedBelowSeq });
      if (
        session.closed ||
        this.sessions.get(session.pod.id) !== session ||
        provisional.wasClosedBeforeCommit()
      ) {
        throw new SessionChangedDuringAttachError(session.startupCrash);
      }

      // This is the commit boundary: before hello no caller-visible bytes or closes escaped,
      // so every session replacement above was safe to retry against a fresh ActiveSession.
      provisional.commit();
      args.sink.send({
        type: "hello",
        sessionId: session.sessionId,
        podId: session.pod.id,
        latestSeq: replayThrough,
        firstReplayedSeq,
        ...(firstAvailableSeq !== undefined ? { firstAvailableSeq } : {}),
        state,
        shim: session.rpc.helloInfo,
        serverPiVersion: bundledPiVersion(),
      });
      // An honest transcript never silently jumps: name the seq range the bounded replay
      // skipped so clients can render a gap marker (REST backfills it).
      const gap = replayGapFor({ replayFrom, firstReplayedSeq });
      if (gap) args.sink.send({ type: "replay_gap", ...gap });
      for (const row of replayRows) {
        args.sink.send({
          type: "event",
          seq: Number(row.seq),
          kind: row.kind,
          payload: row.payload,
          ts: new Date(row.created_at).toISOString(),
        });
      }
      // Ephemeral surface state is a snapshot after durable replay. A late client receives the
      // newest frame first and then the outstanding input request it may claim.
      for (const control of session.remoteUiControls.values()) {
        args.sink.send({ type: "ephemeral", kind: "extension_ui_request", payload: control });
      }
      for (const cached of session.remoteUiSurfaces.values()) {
        // These are snapshots of work already sent on this session, not new
        // editor submit actions. Mark both cached halves so clients can recover
        // unknown cold submissions without executing them a second time.
        if (cached.frame) args.sink.send({
          type: "ephemeral", kind: "extension_ui_request",
          payload: { ...cached.frame, gatewayReplay: true },
        });
        if (cached.input) args.sink.send({
          type: "ephemeral", kind: "extension_ui_request",
          payload: { ...cached.input, gatewayReplay: true },
        });
      }
      // Every attaching client, whatever it asked to replay: an approval nobody answered blocks
      // the turn, and the answer may come from any surface the user is holding.
      for (const frame of unanswered) args.sink.send(frame);
      // A mid-stream attach still renders the in-flight reply: the newest snapshot stands in
      // for every message_update the durable replay no longer carries.
      if (session.streamingUpdate) {
        args.sink.send({ type: "ephemeral", kind: "message_update", payload: session.streamingUpdate });
      }
      // Same contract for running tools: the durable tool_execution_start replayed above opens
      // the bubble, and this newest snapshot fills in the output it has produced so far.
      for (const update of session.toolExecutionUpdates.values()) {
        args.sink.send({ type: "ephemeral", kind: "tool_execution_update", payload: update });
      }
      for (const [id, output] of session.bashSnapshots) {
        args.sink.send({
          type: "ephemeral",
          kind: "bash_execution_update",
          payload: { type: "bash_execution_update", id, delta: output },
        });
      }
      provisional.finishReplay();
    } catch (error) {
      session.clients.delete(clientSink);
      await this.refreshAttachedLease(session.pod.id).catch(() => {});
      throw error;
    }

    const handle = async (message: ClientMessage, bypassCatalogQueue = false): Promise<void> => {
      const participatesInCatalogOrdering =
        message.type === "get_models" ||
        (message.type === "set" && (message.model !== undefined || message.thinkingLevel !== undefined));
      if (participatesInCatalogOrdering && !bypassCatalogQueue) {
        // Reserve the turn before host admission or any other await. A later
        // get_models must not overtake a setter that is still applying.
        await enqueueModelCatalogOperation(session, () => handle(message, true));
        return;
      }

      // A queued operation may reach the front after the session was replaced.
      // Do not start provider work for a stale session or send its result.
      if (!isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)) return;
      // Pings are gateway-only. Every runtime-facing user command must fence
      // host sleep, including reads that do not acquire a semantic work lease.
      if (message.type !== "ping") await this.admitSessionHost(session);
      // Host admission can await a replacement or a workstation transition.
      // Revalidate ownership before touching credentials, Pi, or the sink.
      if (!isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)) return;
      switch (message.type) {
        case "prompt": {
          // Validate before taking the dispatch lease: a rejected turn must cost no
          // work-lease write and no busy mark on the session.
          const { text, images } = preparePromptIngress({ text: message.text, images: message.images });
          await session.activity.grantDispatchLease();
          await deliverUserPrompt({
            text,
            images,
            persist: (payload) => this.persist(session, "user_prompt", payload),
            fanOut: (seq, ts, payload) => {
              // AgentSessionEvent also emits a user message; clients ignore that duplicate.
              this.fanOut(session, { type: "event", seq, kind: "user_prompt", payload, ts });
            },
            prompt: () => session.rpc.prompt(text, images),
          });
          break;
        }
        case "interrupt":
          await session.rpc.abort();
          break;
        case "resolve": {
          const outcome = await resolveInteraction(this, {
            interactionId: message.interactionId,
            response: message.response,
            resolvedBy: null,
          });
          if (outcome.status === "not_found") throw new Error("interaction not found");
          if (outcome.status === "undeliverable") {
            throw new Error("the interaction's session has ended; it can no longer be answered");
          }
          break;
        }
        case "set":
          if (message.model) {
            try {
              session.pod.credential_providers = await extendPodCredentialContractForModel({
                kek: this.deps.kek,
                pod: session.pod,
                sandbox: session.sandbox,
                modelProvider: message.model.provider,
              });
              if (!isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)) return;
            } catch (error) {
              if (error instanceof HttpError && error.message === "credential_reconnect_required") {
                const detail = error.detail as { provider?: unknown; message?: unknown } | undefined;
                args.sink.send({
                  type: "error",
                  code: "credential_reconnect_required",
                  message:
                    typeof detail?.message === "string"
                      ? detail.message
                      : `Reconnect the ${String(detail?.provider ?? message.model.provider)} account credential.`,
                });
                break;
              }
              throw error;
            }
            await session.rpc.setModel(message.model.provider, message.model.id);
          }
          if (message.thinkingLevel) await session.rpc.setThinkingLevel(message.thinkingLevel);
          if (message.command) {
            const releaseActivity = await this.protectCommandActivity(session, message.command);
            try {
              const response = await session.rpc.request(message.command as never);
              this.observePiSessionSteering(session, message.command as Record<string, unknown>, response);
            } finally {
              await releaseActivity().catch((e) =>
                this.deps.log.warn(`command activity release failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`),
              );
            }
          }
          if (message.model !== undefined || message.thinkingLevel !== undefined) {
            if (isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)
              && session.clients.has(clientSink)) {
              await sendModelCatalogSnapshot({
                rpc: session.rpc,
                mirrorPiSessionFile: (sessionFile) => {
                  if (isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)) {
                    this.mirrorPiSessionFile(session, sessionFile);
                  }
                },
                requestId: message.requestId,
                isCurrent: () => isCurrentGatewaySession(
                  session, this.sessions.get(session.pod.id) ?? null,
                ),
                send: (frame) => {
                  if (isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)
                    && session.clients.has(clientSink)) {
                    args.sink.send(frame);
                  }
                },
              });
            }
          }
          break;
        case "get_models":
          if (isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)
            && session.clients.has(clientSink)) {
            await sendModelCatalogSnapshot({
              rpc: session.rpc,
              mirrorPiSessionFile: (sessionFile) => {
                if (isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)) {
                  this.mirrorPiSessionFile(session, sessionFile);
                }
              },
              isCurrent: () => isCurrentGatewaySession(
                session, this.sessions.get(session.pod.id) ?? null,
              ),
              send: (frame) => {
                if (isCurrentGatewaySession(session, this.sessions.get(session.pod.id) ?? null)
                  && session.clients.has(clientSink)) {
                  args.sink.send(frame);
                }
              },
            });
          }
          break;
        case "get_sessions":
        case "search_sessions":
        case "reload_resources":
        case "get_files":
        case "get_tui_manifest":
          // Like get_models, these are semantic frames rather than classic RPC passthroughs.
          // Older extensions, operation failures, and timeouts degrade to unsupported frames.
          await handlePodCommandService(message, {
            rpc: session.rpc,
            workdir: session.pod.resolved_config.workdir,
            send: (frame) => args.sink.send(frame),
            service: podSessionExtensionService,
          });
          break;
        case "aux_complete": {
          // Semantic pod-side completion: validated here, run inside pod-side pi over the
          // prompt tunnel, answered only to the asking sink. Never fanned out, never a
          // transcript entry, never the turn-global session.rpc.abort() path.
          const validated = validateAuxCompleteRequest(message);
          if ("result" in validated) {
            args.sink.send({ type: "aux_complete_result", ...validated.result });
            break;
          }
          const auxRequest = validated.request;
          await this.handleAuxComplete(session, auxRequest, clientSink);
          break;
        }
        case "aux_cancel": {
          this.handleAuxCancel(session, message.id, clientSink);
          break;
        }
        case "rpc": {
          // Full-fidelity passthrough (account-mode-spec §6.1). The gateway's RemoteRpcClient
          // stays the single frame writer; the client's unique-prefixed id rides through so
          // id-correlated event streams still line up. Failures come back on the same id —
          // the socket-level error channel cannot correlate.
          const command = { ...message.command, id: message.id } as Record<string, unknown>;
          const clientRequestId =
            typeof command["client_request_id"] === "string" ? command["client_request_id"] : null;
          if (clientRequestId) {
            const prior = await this.lookupClientRequest(session.sessionId, clientRequestId);
            if (prior) {
              args.sink.send({ type: "rpc_result", id: message.id, response: prior });
              break;
            }
          }
          // Prompt-family commands ride the raw passthrough for full-fidelity clients:
          // enforce the same safe image/text bounds as the first-class prompt frame.
          // Unrelated rpc calls pass through untouched.
          if (
            command["type"] === "prompt" ||
            command["type"] === "steer" ||
            command["type"] === "follow_up"
          ) {
            try {
              const ingress = preparePromptIngress({ text: command["message"], images: command["images"] });
              command["message"] = ingress.text;
            } catch (e) {
              args.sink.send(promptValidationRpcResult(message.id, command["type"], e));
              break;
            }
          }
          const releaseActivity = await this.protectCommandActivity(session, command);
          if (command["type"] === "prompt" && typeof command["message"] === "string") {
            // Persist the prompt like any other client's, so every surface sees it (§6.1).
            // Descriptors only — never raw base64 in the durable row.
            const rpcImages = command["images"] as ImageContent[] | undefined;
            const payload: UserPromptPayload = { text: command["message"] as string };
            const descriptors = describePromptImages(rpcImages);
            if (descriptors) payload.images = descriptors;
            const { seq, ts } = await this.persist(session, "user_prompt", payload);
            this.fanOut(session, { type: "event", seq, kind: "user_prompt", payload, ts });
          }
          try {
            const response = await session.rpc.request(command as never);
            if (clientRequestId) await this.rememberClientRequest(session.sessionId, clientRequestId, response);
            this.observePiSessionSteering(session, command, response);
            args.sink.send({ type: "rpc_result", id: message.id, response });
          } catch (e) {
            args.sink.send({
              type: "rpc_result",
              id: message.id,
              response: {
                type: "response",
                id: message.id,
                command: typeof command["type"] === "string" ? command["type"] : "unknown",
                success: false,
                error: e instanceof Error ? e.message : "command failed",
              },
            });
          } finally {
            await releaseActivity().catch((e) =>
              this.deps.log.warn(`command activity release failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`),
            );
          }
          break;
        }
        case "ui_response": {
          const remoteInput = remoteUiInputFromResponse(message.response);
          if (remoteInput) {
            if (!session.remoteUiSurfaces.has(remoteInput.surfaceId)) {
              args.sink.send({
                type: "error",
                code: "invalid_remote_ui",
                message: "remote extension UI surface is not active",
              });
              break;
            }
            const owner = session.remoteUiOwners.get(remoteInput.surfaceId);
            if (owner && owner !== clientSink) {
              args.sink.send({
                type: "error",
                code: "remote_ui_owned",
                message: "this extension surface is controlled by another attached client",
              });
              break;
            }
            if (remoteInput.kind === "close") session.remoteUiOwners.delete(remoteInput.surfaceId);
            else session.remoteUiOwners.set(remoteInput.surfaceId, clientSink);
          } else {
            const value = (message.response as { value?: unknown }).value;
            if (typeof value === "string" && value.startsWith(REMOTE_UI_INPUT_PREFIX)) {
              args.sink.send({
                type: "error",
                code: "invalid_remote_ui",
                message: "invalid remote extension UI input",
              });
              break;
            }
            await this.consumeInteractionForUiResponse(session, message.response);
          }
          session.rpc.respondExtensionUi(message.response as unknown as RpcExtensionUIResponse);
          break;
        }
        case "ping":
          this.noteActivity(session);
          args.sink.send({ type: "pong" });
          break;
      }
    };

    return {
      detach: () => {
        // The phone detaching is the normal case, not an event (spec §8).
        session.clients.delete(clientSink);
        void this.refreshAttachedLease(session.pod.id).catch((e) =>
          this.deps.log.warn(`attached lease release failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`),
        );
        for (const [surfaceId, owner] of session.remoteUiOwners) {
          if (owner === clientSink) session.remoteUiOwners.delete(surfaceId);
        }
        // Abort aux ops owned by the detached sink; their sinks are gone so replies drop.
        this.abortAuxOwnedBy(session, clientSink);
      },
      handle,
    };
  }

  /**
   * The probe never reached Pi, or a reconnect discarded its answer: Pi may be perfectly
   * healthy, so its supervisor is never retired for this. Holds the (still unsent) attach
   * while the reconnect lands so the caller's retry re-probes the same live session; if
   * nothing reconnects, ends the session WITHOUT retiring — the supervisor and its tools
   * survive for the next attach to adopt. Always throws the retryable attach error. A
   * client abort ends nothing: detaching one client must not interrupt the shared session.
   */
  private async sustainAttachAcrossTransportFailure(session: ActiveSession, signal?: AbortSignal): Promise<never> {
    this.deps.log.warn(
      `pod ${session.pod.id} attach probe hit a transport failure, not an unresponsive Pi; waiting for reconnect`,
    );
    const reconnected = await this.waitForSessionTransport(session, signal);
    if (!signal?.aborted && !session.closed && this.sessions.get(session.pod.id) === session && !reconnected) {
      await this.endSession(session, "transport_lost");
    }
    throw new SessionChangedDuringAttachError(session.startupCrash);
  }

  /**
   * Hold a transport-failed attach while the daemon's reconnect lands. Returns true when a
   * (re)connected transport is ready for a re-probe, false on timeout, abort, or session
   * replacement. Never ends or retires anything itself — the caller decides. A reconnect
   * always moves the transport generation, so a same-generation usable transport means the
   * failure was a transient transmit blip and the re-probe can go out immediately.
   */
  private async waitForSessionTransport(session: ActiveSession, signal?: AbortSignal): Promise<boolean> {
    const startGeneration = session.rpc.transportGeneration;
    const usableAtEntry = session.rpc.transportUsable;
    const deadline = Date.now() + TRANSPORT_RECONNECT_WAIT_MS;
    for (;;) {
      if (signal?.aborted || session.closed || this.sessions.get(session.pod.id) !== session) return false;
      const generation = session.rpc.transportGeneration;
      if (session.rpc.transportUsable && (usableAtEntry || generation !== startGeneration)) return true;
      if (Date.now() >= deadline) return false;
      // Deliberately referenced (no unref): an attach held here must keep its own wait alive.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, TRANSPORT_RECONNECT_POLL_MS);
      });
    }
  }

  private async protectCommandActivity(
    session: ActiveSession,
    command: Record<string, unknown>,
  ): Promise<() => Promise<void>> {
    const kind = commandActivityKind(command);
    if (kind === "dispatch") {
      await session.activity.grantDispatchLease();
      return async () => {};
    }
    if (kind === "explicit") return session.activity.beginExplicitWork();
    return async () => {};
  }

  /**
   * A full-fidelity client answered an extension-UI dialog directly (account-mode-spec §6.1):
   * consume the matching pending interaction so other surfaces stop showing it. No matching
   * row is normal — non-blocking UI methods never created one.
   */
  private async consumeInteractionForUiResponse(
    session: ActiveSession,
    response: Record<string, unknown>,
  ): Promise<void> {
    const uiRequestId = response["id"];
    if (typeof uiRequestId !== "string") return;
    const claimed = await query<{ id: string }>(
      `UPDATE pending_interactions SET resolution = $3, resolved_at = now(), delivered_at = now()
       WHERE session_id = $1 AND delivered_at IS NULL AND payload->>'id' = $2 RETURNING id`,
      [session.sessionId, uiRequestId, JSON.stringify(response)],
    );
    const row = claimed.rows[0];
    if (!row) return;
    const { seq, ts } = await this.persist(session, "interaction_resolved", {
      interactionId: row.id,
      resolvedBy: null,
    });
    this.fanOut(session, {
      type: "event",
      seq,
      kind: "interaction_resolved",
      payload: { interactionId: row.id, resolvedBy: null },
      ts,
    });
  }

  /**
   * Forward a recorded resolution to the live session. The atomic delivered_at claim is
   * what consumes the approval: exactly one deliverer wins, and a failed send un-claims so
   * the resolution stays retryable.
   */
  async deliverResolution(
    session: ActiveSession,
    args: { id: string; payload: Record<string, unknown>; resolution: unknown; resolvedBy: string | null },
  ): Promise<boolean> {
    const claim = await query(
      "UPDATE pending_interactions SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL RETURNING id",
      [args.id],
    );
    if ((claim.rowCount ?? 0) === 0) return false;
    try {
      const requestId = (args.payload as { id?: string }).id;
      session.rpc.respondExtensionUi({
        ...(typeof args.resolution === "object" && args.resolution !== null
          ? args.resolution
          : { value: args.resolution }),
        id: requestId,
      } as unknown as RpcExtensionUIResponse);
    } catch (e) {
      await query("UPDATE pending_interactions SET delivered_at = NULL WHERE id = $1", [args.id]).catch(
        () => {},
      );
      throw e;
    }
    const { seq, ts } = await this.persist(session, "interaction_resolved", {
      interactionId: args.id,
      resolvedBy: args.resolvedBy,
    });
    this.fanOut(session, {
      type: "event",
      seq,
      kind: "interaction_resolved",
      payload: { interactionId: args.id, resolvedBy: args.resolvedBy },
      ts,
    });
    return true;
  }

  /** Forward resolutions persisted by other roles (split deployments) to held sessions. */
  private async deliverPendingResolutions(): Promise<void> {
    if (this.sessions.size === 0) return;
    const rows = await query<InteractionRow>(
      `SELECT pi.id, s.pod_id, pi.payload, pi.resolution, pi.resolved_by, pi.delivered_at, s.ended_at
       FROM pending_interactions pi JOIN sessions s ON s.id = pi.session_id
       WHERE pi.resolved_at IS NOT NULL AND pi.delivered_at IS NULL AND s.pod_id = ANY($1)`,
      [[...this.sessions.keys()]],
    );
    for (const row of rows.rows) {
      const session = this.liveSession(row.pod_id);
      if (!session) continue;
      await this.deliverResolution(session, {
        id: row.id,
        payload: row.payload,
        resolution: row.resolution,
        resolvedBy: row.resolved_by,
      }).catch((e) => {
        this.deps.log.warn(`resolution delivery failed for ${row.id}: ${e instanceof Error ? e.message : e}`);
      });
    }
  }

  private async admitSessionHost(session: ActiveSession): Promise<void> {
    await edition().ensurePodHostReady(this.deps, session.pod);
  }

  private attachedLeaseQueue: Promise<void> = Promise.resolve();

  /** Serialize snapshots so a delayed detach cannot clear a newer attach lease. */
  private refreshAttachedLease(podId: string): Promise<void> {
    const run = (this.attachedLeaseQueue ?? Promise.resolve()).then(async () => {
      const session = this.liveSession(podId);
      const attached = !!session && session.clients.size > 0;
      await query(
        `UPDATE pods SET gateway_attached_until = CASE WHEN $3 THEN
           now() + make_interval(secs => $4) ELSE NULL END
         WHERE id = $1 AND gateway_id = $2`,
        [podId, this.deps.env.GATEWAY_ID, attached, LEASE_STALE_SECONDS],
      );
    });
    this.attachedLeaseQueue = run.catch(() => {});
    return run;
  }

  private async heartbeatLeases(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.refreshAttachedLease(id)));
    // Scheduled pods are leased before provider provisioning starts. Keep that reservation
    // alive until the pod reaches started and becomes an attached session, otherwise another
    // gateway can steal a slow launch after LEASE_STALE_SECONDS.
    await query(
      `UPDATE pods SET gateway_heartbeat_at = now()
       WHERE gateway_id = $1 AND state = 'active' AND provider_state IN ('preparing_image','provisioning','starting')`,
      [this.deps.env.GATEWAY_ID],
    );
    const heldIds = new Set([...this.sessions.keys(), ...this.podTransports.keys()]);
    if (heldIds.size > 0) {
      const ids = [...heldIds];
      const active = await query<{ id: string }>(
        `UPDATE pods SET gateway_heartbeat_at = now()
         WHERE id = ANY($1) AND gateway_id = $2 AND state = 'active' AND provider_state = 'started'
         RETURNING id`,
        [ids, this.deps.env.GATEWAY_ID],
      );
      const retained = new Set(active.rows.map((row) => row.id));
      const missing = ids.filter((id) => !retained.has(id));
      if (missing.length === 0) return;
      const rows = await query<UnretainedPodRow & { id: string }>(
        `SELECT id, state, provider_state, gateway_id, last_stop_cause FROM pods WHERE id = ANY($1)`,
        [missing],
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      for (const id of missing) {
        this.podTransportRegistry.close(id, "lease_lost");
        if (this.sessions.has(id)) {
          await this.closePod(id, closeReasonForUnretainedPod(byId.get(id), this.deps.env.GATEWAY_ID));
        }
      }
    }
  }

  async endSession(
    session: ActiveSession,
    reason: string,
    options: { retireSupervisor?: boolean } = {},
  ): Promise<void> {
    const inProgress = this.ending.get(session.pod.id);
    if (inProgress) return inProgress;
    if (session.closed) return;
    session.closed = true;
    // Abort ALL in-flight aux ops before teardown/rebind; late pod replies for the old
    // session/generation correlate to nothing (server-owned wire ids) and are dropped.
    this.abortAuxForSession(session);
    session.activity.stop();
    // Classified synchronously with the close so a client attach that observes `closed` in
    // this same tick already sees why — the crash rides its SessionChangedDuringAttachError.
    session.startupCrash = classifyPiStartupCrash({
      reason,
      freshSpawn: session.freshSpawn,
      exitCode: session.rpc.exitCode,
      sessionAgeMs: Date.now() - session.startedAt,
      stderrTail: session.rpc.getStderr(),
    });
    // Ownership for a destructive retirement is decided here, synchronously with the close:
    // teardown persists and flushes across awaits, and a reconnect landing in that window
    // must never cost the newly recovered supervisor its life. finishEndSession re-checks
    // this identity before anything destructive.
    const retireOwnership =
      options.retireSupervisor === true
        ? { generation: session.rpc.transportGeneration, channel: session.channel }
        : null;

    const ending = this.finishEndSession(session, reason, retireOwnership);
    this.ending.set(session.pod.id, ending);
    try {
      await ending;
    } finally {
      if (this.ending.get(session.pod.id) === ending) this.ending.delete(session.pod.id);
    }
  }

  private async finishEndSession(
    session: ActiveSession,
    reason: string,
    retireOwnership: { generation: number; channel: FrameChannel } | null,
  ): Promise<void> {
    this.sessions.delete(session.pod.id);
    // A transport disappearing during whole-host sleep is not a lost pod. Do
    // not wake from teardown; consult registry evidence only and preserve 4420.
    if (reason === "transport_lost" || reason === "channel_closed") {
      const host = await hostForPod(session.pod).catch(() => null);
      if (host && personalBoatHostIsAsleep(host)) {
        reason = "host_stopped";
        retireOwnership = null;
      }
    }
    const disposition = sessionEndDisposition(reason);
    observeGatewaySessionEnd(disposition.kind);
    // Put the close on the wire before durable persist. Host-stop delivery is a
    // client frame; waiting on session_events first is how a TCP timeout wins.
    this.fanOut(session, {
      type: "session_ended",
      reason,
      kind: disposition.kind,
      recoverable: disposition.recoverable,
    });
    this.fanOut(session, { type: "pod_state", state: "detached", reason });
    const closeCode = disposition.closeCode;
    for (const client of session.clients) client.close(closeCode, reason);
    session.clients.clear();
    if (session.stderrDropped > 0) {
      await this.persist(session, "control", {
        event: "pi_stderr",
        truncated: true,
        dropped: session.stderrDropped,
      }).catch(() => {});
    }
    await this.persist(session, "session_ended", {
      reason,
      kind: disposition.kind,
      recoverable: disposition.recoverable,
    }).catch(() => {});
    await query("UPDATE sessions SET ended_at = now(), end_reason = $2 WHERE id = $1", [
      session.sessionId,
      reason,
    ]).catch(() => {});
    await this.refreshAttachedLease(session.pod.id).catch(() => {});
    await this.writeLastPodSeq(session.pod.id, session.lastDecodedShimSeq).catch((e) =>
      this.deps.log.warn(`last_pod_seq flush failed for ${session.pod.id}: ${e instanceof Error ? e.message : e}`),
    );
    // Once the session is closed, acceptPodTransport binds reconnects in the registry
    // without rebinding this old RPC. Check both identities: a newly registered channel
    // must survive even when this session's generation never moved during teardown.
    const registeredChannel = this.podTransportRegistry.channels.get(session.pod.id);
    const transportRecovered =
      retireOwnership !== null &&
      (session.rpc.transportGeneration !== retireOwnership.generation ||
        session.channel !== retireOwnership.channel ||
        (registeredChannel !== undefined && registeredChannel !== retireOwnership.channel));
    if (transportRecovered) {
      session.rpc.retireChannel();
    } else {
      session.rpc.close();
    }
    if (retireOwnership && !transportRecovered) {
      this.podTransportRegistry.close(session.pod.id, "pi_unresponsive");
      await stopAgentdSupervisor(session.sandbox, podRuntimePaths(session.pod)).catch((e) =>
        this.deps.log.warn(
          `could not retire unresponsive supervisor for ${session.pod.id}: ${e instanceof Error ? e.message : e}`,
        ),
      );
    }
    // Let already-observed renames use this lease before relinquishing it.
    await session.nameMirrorQueue;
    await session.activity.drain();
    if (reason === "pi_exit") {
      await query(
        `UPDATE pods SET work_lease_until = NULL, updated_at = now()
         WHERE id = $1 AND gateway_id = $2 AND provider_state = 'started'`,
        [session.pod.id, this.deps.env.GATEWAY_ID],
      ).catch(() => {});
    }
    if (reason === "transport_lost") {
      await query(
        `UPDATE job_runs SET status = 'interrupted', error = $2, interrupted_at = now()
         WHERE pod_id = $1 AND status = 'running'`,
        [session.pod.id, `session interrupted: ${reason}`],
      ).catch((e) => this.deps.log.warn(`cannot interrupt job run for pod ${session.pod.id}: ${e}`));
    } else if (reason !== "gateway_shutdown") {
      const failed = await query(
        `UPDATE job_runs SET status = 'failed', error = $2, finished_at = now()
         WHERE pod_id = $1 AND status IN ('running', 'interrupted')`,
        [session.pod.id, `session ended before agent settled: ${reason}`],
      ).catch((e) => {
        this.deps.log.warn(`cannot fail unsettled job run for pod ${session.pod.id}: ${e}`);
        return null;
      });
      observeJobRun("failed", failed?.rowCount ?? 0);
    }
    await this.releaseLease(session.pod.id);
    if (session.startupCrash) {
      const streak = (this.startupCrashStreaks.get(session.pod.id) ?? 0) + 1;
      this.startupCrashStreaks.set(session.pod.id, streak);
      if (streak >= PI_STARTUP_CRASH_WITHDRAW_AFTER) {
        this.startupCrashStreaks.delete(session.pod.id);
        await this.withdrawCrashLoopedImage(session, session.startupCrash);
      }
    } else {
      this.startupCrashStreaks.delete(session.pod.id);
    }
    if (reason === "pi_exit" || reason === "transport_lost") {
      const redacted = session.pod.resolved_config.notificationsRedacted;
      // A normal exit is closure, not an error: separate kinds so the client can sort them.
      await enqueuePush(session.pod.user_id, {
        title:
          reason === "pi_exit"
            ? redacted
              ? "session ended"
              : `session ended: ${session.pod.name}`
            : redacted
              ? "pod connection lost"
              : `connection lost: ${session.pod.name}`,
        body:
          reason === "pi_exit"
            ? "pi exited; the pod and your work are still there"
            : "the live channel to the pod dropped — reattach to pick the session back up",
        data: {
          pod_id: session.pod.id, org_id: session.pod.org_id,
          session_id: session.sessionId,
          kind: reason === "pi_exit" ? "session_ended" : "pod_error",
        },
      }).catch(() => {});
    }
    this.deps.log.info(`gateway released pod ${session.pod.id} (${reason})`);
  }

  /**
   * Self-heal a broken managed image: a pod whose pi dies at spawn repeatedly proves its
   * image broken at runtime — something the build's verify step could not see — so the
   * template is withdrawn and the next launch rebuilds it. Custom pins are user-owned and
   * never withdrawn; providers without `unpublishImage` (registry-backed) opt out silently.
   * The crashing pod itself keeps its disk: only new launches take the rebuilt image.
   */
  private async withdrawCrashLoopedImage(session: ActiveSession, crash: PiStartupCrash): Promise<void> {
    const pod = session.pod;
    const image = pod.resolved_config.image;
    if (!image?.managed) return;
    try {
      const withdrawn = await withProviderCredential({
        pod,
        kek: this.deps.kek,
        platformEnv: platformCredentialsOf(this.deps),
        orgId: pod.org_id,
        provider: pod.provider,
        providerConfig: pod.resolved_config.config.providers[pod.provider] ?? {},
        fn: async (provider) => (provider.unpublishImage ? provider.unpublishImage(image.ref) : false),
      });
      if (!withdrawn) return;
      this.deps.log.warn(
        `pod ${pod.id}: pi crashed at startup ${PI_STARTUP_CRASH_WITHDRAW_AFTER} times in a row ` +
          `(exit ${crash.exitCode}); withdrew managed image ${image.ref} — the next launch rebuilds it`,
      );
      await query(`UPDATE pods SET state_reason = $2, updated_at = now() WHERE id = $1`, [
        pod.id,
        `pi crashes at startup (exit ${crash.exitCode}); this pod's image was withdrawn for rebuild — launch a new pod`,
      ]).catch(() => {});
    } catch (e) {
      this.deps.log.warn(
        `could not withdraw crash-looped image ${image.ref} for pod ${pod.id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Close the client/session channel without mutating the provider sandbox. */
  async closePod(podId: string, reason: string): Promise<void> {
    const session = this.sessions.get(podId);
    if (session) {
      await this.endSession(session, reason);
    } else {
      await this.ending.get(podId);
    }
  }

  /** Observe durable create attempts without replaying or mutating provider resources. */
  async failAbandonedProvisioning(): Promise<void> {
    await runCreateRecovery({
      env: this.deps.env,
      kek: this.deps.kek,
      log: this.deps.log,
    });
  }

  /** One-shot supervisor retirement for a pod whose transport was permanently rejected.
   * Daemons generated before close code 4410 cannot exit themselves; this removes the
   * reconnect loop at its source instead of letting the rejection repeat forever. */
  async cleanupRejectedTransport(podId: string): Promise<void> {
    if (this.draining) return;
    if (this.rejectedTransportCleanups.has(podId)) return;
    this.rejectedTransportCleanups.add(podId);
    try {
      const found = await query<PodRow>("SELECT * FROM pods WHERE id = $1", [podId]);
      const pod = found.rows[0];
      if (!pod?.provider_sandbox_id) return;
      // A rejected pod must never be restarted by provider-state recovery; only its
      // resident supervisor is retired.
      await withPodSandbox(
        { env: this.deps.env, kek: this.deps.kek, log: this.deps.log },
        pod,
        (sandbox) => stopAgentdSupervisor(sandbox, podRuntimePaths(pod)),
        { recoverStaleProviderState: false },
      );
      this.deps.log.info(`retired pod transport supervisor after permanent rejection of ${podId}`);
    } catch (e) {
      this.deps.log.warn(
        `could not retire rejected pod transport supervisor ${podId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Claim started pods that are unleased — or whose gateway stopped heartbeating. */
  async sweep(): Promise<void> {
    await this.reapInterruptedJobRuns();
    for (const [podId, state] of this.sweepBackoffs) {
      if (state.nextAt <= Date.now()) this.sweepBackoffs.delete(podId);
    }
    const rows = await query<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM pods WHERE state = 'active' AND provider_state = 'started'
         AND (gateway_id IS NULL OR gateway_heartbeat_at IS NULL
           OR gateway_heartbeat_at < now() - make_interval(secs => $1))
       LIMIT 10`,
      [LEASE_STALE_SECONDS],
    );
    for (const row of rows.rows) {
      const backoff = this.sweepBackoffs.get(row.id);
      if (backoff && backoff.nextAt > Date.now()) continue;
      try {
        // Lease recovery is not user demand. A sleeping physical host retains
        // started pod rows and must not be woken by this periodic sweep.
        const host = await hostForPod(await getPod(row.org_id, row.id));
        if (host && !hostCanDial(host)) continue;
        await this.ensureSession(row.org_id, row.id, { resumeHost: false });
        this.sweepBackoffs.delete(row.id);
      } catch (e) {
        const message = e instanceof Error ? e.message : e;
        const failures = (backoff?.failures ?? 0) + 1;
        const delayMs = sweepBackoffDelayMs(failures);
        this.sweepBackoffs.set(row.id, { failures, nextAt: Date.now() + delayMs });
        this.deps.log.warn(
          `sweep: cannot attach pod ${row.id} (failure ${failures}, next attempt in ${Math.round(delayMs / 1000)}s): ${message}`,
        );
      }
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    // Set synchronously before any teardown await so reconnects cannot land back on this process.
    this.draining = true;
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    // An attach that began before draining owns provider/lease cleanup. Let it reach its
    // draining check before taking the final session snapshot.
    await Promise.allSettled([...this.attaching.values()]);
    await Promise.all(
      [...this.sessions.values()].map((session) => this.endSession(session, "gateway_shutdown")),
    );
    this.podTransportRegistry.shutdown();
  }

  private async releaseLease(podId: string): Promise<void> {
    await query(
      `UPDATE pods SET gateway_id = NULL, gateway_heartbeat_at = NULL, updated_at = now()
       WHERE id = $1 AND gateway_id = $2`,
      [podId, this.deps.env.GATEWAY_ID],
    ).catch(() => {});
  }

  private async reconcileJobRuns(session: ActiveSession, resumed: boolean): Promise<void> {
    if (resumed) {
      await query(
        `UPDATE job_runs SET status = 'running', error = NULL, interrupted_at = NULL
         WHERE pod_id = $1 AND status = 'interrupted'`,
        [session.pod.id],
      ).catch((e) => this.deps.log.warn(`cannot resume interrupted job run for pod ${session.pod.id}: ${e}`));
      return;
    }
    const failed = await query(
      `UPDATE job_runs SET status = 'failed', error = $2, finished_at = now()
       WHERE pod_id = $1 AND status = 'interrupted'`,
      [session.pod.id, "session process was replaced before the agent settled"],
    ).catch((e) => {
      this.deps.log.warn(`cannot fail interrupted job run for pod ${session.pod.id}: ${e}`);
      return null;
    });
    observeJobRun("failed", failed?.rowCount ?? 0);
  }

  private async reapInterruptedJobRuns(): Promise<void> {
    const failed = await query(
      `UPDATE job_runs SET status = 'failed', error = 'interrupted too long without a rejoined session', finished_at = now()
       WHERE status = 'interrupted' AND interrupted_at < now() - make_interval(secs => $1)`,
      [10 * 60],
    ).catch((e) => {
      this.deps.log.warn(`cannot reap interrupted job runs: ${e}`);
      return null;
    });
    observeJobRun("failed", failed?.rowCount ?? 0);
  }

  private async interactionAlreadyRecorded(podId: string, event: unknown): Promise<boolean> {
    const podSeq = (event as { podSeq?: unknown }).podSeq;
    if (typeof podSeq !== "number") return false;
    const existing = await query(
      `SELECT 1 FROM pending_interactions pi
         JOIN sessions s ON s.id = pi.session_id
        WHERE s.pod_id = $1 AND (pi.payload->>'podSeq')::int = $2
        LIMIT 1`,
      [podId, podSeq],
    );
    return (existing.rowCount ?? 0) > 0;
  }

  private async lookupClientRequest(sessionId: string, clientRequestId: string): Promise<unknown | null> {
    const rows = await query<{ result: unknown }>(
      `SELECT result FROM client_requests WHERE session_id = $1 AND client_request_id = $2`,
      [sessionId, clientRequestId],
    );
    return rows.rows[0]?.result ?? null;
  }

  private async rememberClientRequest(sessionId: string, clientRequestId: string, result: unknown): Promise<void> {
    await query(
      `INSERT INTO client_requests (session_id, client_request_id, result) VALUES ($1, $2, $3)
       ON CONFLICT (session_id, client_request_id) DO NOTHING`,
      [sessionId, clientRequestId, JSON.stringify(result ?? {})],
    ).catch((e) => this.deps.log.warn(`cannot persist client_request_id ${clientRequestId}: ${e}`));
  }
}
