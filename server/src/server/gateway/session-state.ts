import type { RpcSessionState } from "@earendil-works/pi-coding-agent";
import { RemoteRpcClient, isRpcTransportError } from "../../core/client/rpc.js";
import {
  CHANNEL_LIVENESS_INTERVAL_MS,
  CHANNEL_LIVENESS_PROBE_TIMEOUT_MS,
  uploadShim,
} from "../../core/client/session.js";
import { buildPiArgv } from "../../core/lifecycle.js";
import { DEFAULT_RUNTIME_PATHS, type PodRuntimePaths } from "../pods/runtime-paths.js";
import type { PiConfig } from "../../core/config.js";
import type { Sandbox } from "../../core/providers/types.js";
import type { ServerEnv } from "../env.js";
import { conflict } from "../httperrors.js";
import type { PodRow } from "../pods/service.js";
import { MissingCredentialError } from "../pods/providercred.js";
import { createPodToken } from "../pods/podtoken.js";
import { piArgsHaveSessionSteering } from "../pods/fork-seed.js";
import { SessionActivityLease } from "./activity.js";
import { coalesceReadyProbe } from "./readiness.js";

export const HELLO_TIMEOUT_MS = 60 * 1000;
/** A client snapshot is diagnostic courtesy, never permission to wedge an attach forever. */
export const SESSION_STATE_TIMEOUT_MS = 10 * 1000;
/** Cold Pi may install project packages after the shim is already answering hello probes. */
export const SESSION_STARTUP_STATE_TIMEOUT_MS = 90 * 1000;

/**
 * A newly spawned Pi may still be installing project packages after the shim connects. A
 * resumed Pi has no such cold-start excuse: bound its state probe tightly enough to retire and
 * replace a semantically wedged process before the client's hello deadline.
 */
export function gatewaySessionReadyTimeoutMs(freshSpawn: boolean): number {
  return freshSpawn ? SESSION_STARTUP_STATE_TIMEOUT_MS : SESSION_STATE_TIMEOUT_MS;
}

/** Bound the durable replay barrier so a stuck database query cannot leak WebSocket attaches. */
export const SESSION_PERSIST_BARRIER_TIMEOUT_MS = 30 * 1000;
/** The socket replays a bounded tail; REST serves deeper history (spec §9.1). */
export const MAX_SOCKET_REPLAY = 500;
/** Pi blocks on one dialog at a time; more than a handful unanswered is already pathological. */
export const MAX_PENDING_INTERACTION_RESENDS = 16;

/** Tool executions whose newest in-flight output is cached per session. A turn fans out across
 * parallel calls, but not unboundedly; the oldest is dropped rather than growing the session. */
export const MAX_TOOL_EXECUTION_SNAPSHOTS = 64;
/** Lease heartbeat cadence, and the age past which another gateway may take a lease over. */
export const HEARTBEAT_MS = 15 * 1000;
export const LEASE_STALE_SECONDS = 60;
/**
 * A planned gateway replacement and a lost pod channel are both retryable transports.
 * Terminal pod lifecycle endings remain normal WebSocket closures.
 */
export function closeCodeForSessionEnd(reason: string): number {
  return sessionEndDisposition(reason).closeCode;
}

/** How a client should treat a closed gateway session. Transport loss reconnects; idle
 *  stop and archive leave the transcript in place; gone/delete are terminal. */
export type SessionEndKind = "retryable" | "asleep" | "exited" | "unavailable";

export function sessionEndDisposition(reason: string): {
  kind: SessionEndKind;
  recoverable: boolean;
  closeCode: number;
} {
  switch (reason) {
    case "gateway_shutdown":
    case "transport_lost":
    case "handshake_failed":
    case "persist_failed":
      return { kind: "retryable", recoverable: true, closeCode: 1012 };
    case "idle_stop":
    case "archived":
    case "archive":
    case "provider_stopped":
    case "provider_archived":
    case "host_stopped":
    case "host_archived":
      return { kind: "asleep", recoverable: true, closeCode: 4420 };
    case "pi_exit":
      return { kind: "exited", recoverable: true, closeCode: 4421 };
    default:
      return { kind: "unavailable", recoverable: false, closeCode: 1000 };
  }
}

/** In-memory sessions whose pod row still names this host. Closed sessions stay out. */
export function sessionsHeldOnHost<T extends { closed: boolean; pod: { sandbox_host_id?: string | null } }>(
  sessions: Iterable<T>,
  hostId: string,
): T[] {
  return [...sessions].filter((session) => !session.closed && session.pod.sandbox_host_id === hostId);
}

/** Distinct live sandbox_host_id values for one batched host lookup. */
export function uniqueLiveHostIds(
  sessions: Iterable<{ closed: boolean; pod: { sandbox_host_id?: string | null } }>,
): string[] {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.closed) continue;
    const hostId = session.pod.sandbox_host_id;
    if (hostId) ids.add(hostId);
  }
  return [...ids];
}

export interface UnretainedPodRow {
  state: string;
  provider_state: string;
  gateway_id: string | null;
  last_stop_cause: string | null;

}

/** Close reason for a held session whose pod row no longer matches this gateway lease. */
export function closeReasonForUnretainedPod(
  row: UnretainedPodRow | undefined,
  thisGatewayId: string,
): string {
  if (!row) return "archived";
  if (row.state === "archived") return "archived";
  if (row.gateway_id && row.gateway_id !== thisGatewayId) return "transport_lost";
  if (row.provider_state === "stopping" || row.provider_state === "stopped") {
    return row.last_stop_cause === "idle_stop" ? "idle_stop" : "provider_stopped";
  }
  if (row.provider_state === "archiving" || row.provider_state === "archived") {
    return "provider_archived";
  }
  return row.last_stop_cause ?? "archived";

}

/** Pi exit is terminal even though RpcClient reports it through lifecycle invalidation first. */
export function sessionEndReasonForRpcInvalidation(
  exitCode: number | null | undefined,
): "pi_exit" | "transport_lost" {
  return exitCode !== undefined ? "pi_exit" : "transport_lost";
}
/**
 * Grace before a provisioning pod counts as abandoned. Comfortably above the heartbeat
 * interval so a live-but-slow launch is never mistaken for a dead one.
 */
export const ABANDONED_PROVISION_SECONDS = 180;
/** How quickly durable mobile work persisted by another role reaches the agent. */
export const RESOLUTION_POLL_MS = 2 * 1000;
export const QUEUED_PROMPT_POLL_MS = 2 * 1000;
export const QUEUED_PROMPT_MAX_ATTEMPTS = 5;
export const SWEEP_MS = 10 * 1000;
/** Attached clients must learn a known host sleep faster than a TCP timeout. */
export const HOST_SLEEP_SWEEP_MS = 2 * 1000;
export const PROVIDER_ACTIVITY_TIMEOUT_MS = 10 * 1000;

export type CommandActivityKind = "dispatch" | "explicit" | null;

export function commandActivityKind(command: Record<string, unknown>): CommandActivityKind {
  switch (command["type"]) {
    case "prompt":
    case "follow_up":
      return "dispatch";
    case "compact":
    case "bash":
      return "explicit";
    default:
      return null;
  }
}



/** Restore runtime-only files before starting a replacement Pi process. */
export async function prepareGatewayRuntime(
  sandbox: Sandbox,
  workdir: string,
  sessionNaming: PiConfig["sessionNaming"],
  paths: PodRuntimePaths = DEFAULT_RUNTIME_PATHS,
): Promise<void> {
  const [, workdirResult] = await Promise.all([
    uploadShim(sandbox, paths.exitCode, sessionNaming, paths),
    sandbox.exec(["mkdir", "-p", workdir]),
  ]);
  if (workdirResult.exitCode !== 0) {
    throw new Error(`could not restore gateway workdir ${workdir} (exit ${workdirResult.exitCode})`);
  }
}

/**
 * Shim journal cursor a replacement gateway should ask for.
 * A fresh Pi process starts a new journal at 0; only a reattached PTY may resume `last_pod_seq`.
 */
export function eventReplaySince(args: {
  resumed: boolean;
  lastPodSeq: unknown;
}): number {
  if (!args.resumed) return 0;
  const seq = typeof args.lastPodSeq === "string" ? Number(args.lastPodSeq) : args.lastPodSeq;
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 0) return 0;
  return Math.floor(seq);
}

/** Build argv for a gateway-started Pi process.
 *
 * This path only runs when the supervisor is gone, so it always resumes disk-backed
 * history. `--continue` with nothing to continue is a fresh start (same as classic
 * `continueArgs`). A recorded session file is pinned with `--session`: `--continue`
 * otherwise takes whichever file in the workspace was written last, and subagent
 * sessions race the orchestrator for that spot. A fork path is the first-session
 * seed and suppresses both. The shim journal cursor (`last_pod_seq`) is not a
 * resume signal — a failed attach zeros it, and that must not open a blank session.
 */
export function gatewayPiArgv(
  config: Pick<PiConfig, "command" | "args"> & Partial<Pick<PiConfig, "model" | "thinking">>,
  opts: { forkPath?: string; sessionFile?: string } = {},
): string[] {
  const hasSessionChoice = piArgsHaveSessionSteering(config.args);
  const extra = opts.forkPath
    ? ["--fork", opts.forkPath]
    : !hasSessionChoice
      ? opts.sessionFile
        ? ["--session", opts.sessionFile]
        : ["--continue"]
      : [];
  return buildPiArgv(config, extra);
}

/**
 * The pod identity env (spec §8.5), reissued for a shim the gateway is starting itself.
 *
 * Provisioning injects these once, and a filesystem-only stop discards them along with
 * everything else in the environment. The token cannot simply be reread — pod tokens are
 * stored hashed — so a fresh shim gets a fresh one. The old token stays valid: a pod that
 * still has a process holding it has done nothing wrong, and every token for the pod is
 * revoked together when it is deleted.
 */
export async function podIdentityEnv(env: ServerEnv, pod: PodRow): Promise<Record<string, string>> {
  return {
    PI_POD_SERVER_URL: env.PUBLIC_URL ?? "",
    PI_POD_SERVER_TOKEN: await createPodToken({ podId: pod.id, orgId: pod.org_id, userId: pod.user_id }),
    PI_POD_SERVER_POD_ID: pod.id,
  };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pi dying this soon after its spawn, with a non-zero code, is a startup crash. */
export const PI_STARTUP_CRASH_WINDOW_MS = 30 * 1000;
/** Consecutive startup crashes on one pod before its managed image is withdrawn for rebuild. */
export const PI_STARTUP_CRASH_WITHDRAW_AFTER = 3;
/** Bound what the attach error carries; the full tail stays in the session's control events. */
const PI_STARTUP_CRASH_STDERR_LINES = 8;

export interface PiStartupCrash {
  exitCode: number;
  stderrTail: string;
}

/**
 * A non-zero pi exit moments after a fresh spawn is deterministic — the runtime is broken,
 * and respawning reproduces it — unlike a replacement mid-attach, which is worth retrying.
 * A clean exit, a transport loss, a crash long after startup (project package installs can
 * postpone real work by minutes), or the death of a readopted PTY whose pi predates this
 * session all keep their existing semantics.
 */
export function classifyPiStartupCrash(args: {
  reason: string;
  freshSpawn: boolean;
  exitCode: number | null | undefined;
  sessionAgeMs: number;
  stderrTail: string;
}): PiStartupCrash | null {
  if (!args.freshSpawn) return null;
  if (args.reason !== "pi_exit") return null;
  if (typeof args.exitCode !== "number" || args.exitCode === 0) return null;
  if (args.sessionAgeMs > PI_STARTUP_CRASH_WINDOW_MS) return null;
  return { exitCode: args.exitCode, stderrTail: args.stderrTail };
}

/** What the client sees instead of a retry loop when pi cannot even start. */
export function formatPiStartupCrash(crash: PiStartupCrash): string {
  const tail = crash.stderrTail.trim().split("\n").slice(-PI_STARTUP_CRASH_STDERR_LINES).join("\n").trim();
  return (
    `pi crashed while starting in the pod (exit ${crash.exitCode})` +
    (tail ? `. pi's stderr:\n${tail}` : "") +
    "\nretrying attach respawns the same crash — the pod's runtime is broken, not the connection"
  );
}

/**
 * Pending bytes at or above this, with no line completing during the attach, mean the PTY is
 * feeding one unterminated frame — in practice an oversized journaled event replayed by an old
 * shim. At sustained PTY throughput of roughly 170 KB/s a >10 MB line cannot complete inside
 * any readiness window, so the stall reproduces on every attach and retrying is futile.
 */
export const OVERSIZED_STALL_MIN_PENDING_BYTES = 4 * 1024 * 1024;

export interface AttachStall {
  pendingBytes: number;
  decodedLines: number;
}

/** What the client sees instead of a retry loop when the stream cannot make progress. */
export function formatOversizedStall(stall: AttachStall): string {
  return (
    `pod session stream is stalled on an oversized frame (${stall.pendingBytes} bytes buffered, ` +
    `${stall.decodedLines} frames decoded during attach); retrying will not help — ` +
    "stop and restart the pod (pi-pod stop <id>, then attach)"
  );
}

/**
 * A session replacement before hello is invisible to the client and safe to retry — unless it is
 * deterministic. Both a startup crash and an oversized-frame stall reproduce on every attempt,
 * so both ride the same error type with evidence attached and never retry.
 */
export class SessionChangedDuringAttachError extends Error {
  /** Set when the replacement was pi crashing at startup: deterministic, so never retried. */
  readonly crash: PiStartupCrash | null;
  /** Set when the channel stalled on one unterminated frame: deterministic, so never retried. */
  readonly stall: AttachStall | null;
  constructor(crash: PiStartupCrash | null = null, stall: AttachStall | null = null) {
    super("pod session channel changed while the client was attaching");
    this.name = "SessionChangedDuringAttachError";
    this.crash = crash;
    this.stall = stall;
  }
}

export const ATTACH_SESSION_RETRY_ATTEMPTS = 3;
export const ATTACH_SESSION_RETRY_BUDGET_MS = 120 * 1000;

/** Retry only pre-hello session replacements; every other attach error keeps its semantics. */
export async function retrySessionAttach<T>(args: {
  attempt: () => Promise<T>;
  signal?: AbortSignal | undefined;
  maxAttempts?: number | undefined;
  budgetMs?: number | undefined;
  now?: (() => number) | undefined;
  onRetry?: ((attempt: number) => void) | undefined;
}): Promise<T> {
  const maxAttempts = Math.max(1, args.maxAttempts ?? ATTACH_SESSION_RETRY_ATTEMPTS);
  const budgetMs = Math.max(0, args.budgetMs ?? ATTACH_SESSION_RETRY_BUDGET_MS);
  const now = args.now ?? Date.now;
  const startedAt = now();

  for (let attempt = 1; ; attempt += 1) {
    if (args.signal?.aborted) {
      throw args.signal.reason instanceof Error ? args.signal.reason : new Error("client disconnected during attach");
    }
    try {
      return await args.attempt();
    } catch (error) {
      if (!(error instanceof SessionChangedDuringAttachError)) throw error;
      if (error.crash || error.stall) throw error;
      if (attempt >= maxAttempts || now() - startedAt >= budgetMs) throw error;
      args.onRetry?.(attempt);
    }
  }
}

/**
 * Buffer live events and suppress session closes until hello commits this sink to the client.
 * Before that boundary no bytes have been sent, so a replacement session can retry invisibly.
 */

export type GatewayChannelProbeResult = "recent" | "alive" | "ended" | "lost";

export async function probeGatewayChannel(args: {
  rpc: Pick<RemoteRpcClient, "lastReceivedAt" | "ping" | "exitCode">;
  hasEnded: () => boolean;
  staleAfterMs?: number;
  probeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<GatewayChannelProbeResult> {
  if (args.hasEnded() || args.rpc.exitCode !== undefined) return "ended";
  const staleAfterMs = args.staleAfterMs ?? CHANNEL_LIVENESS_INTERVAL_MS;
  if (Date.now() - args.rpc.lastReceivedAt < staleAfterMs) return "recent";

  const receivedBefore = args.rpc.lastReceivedAt;
  args.rpc.ping();
  const probeTimeoutMs = args.probeTimeoutMs ?? CHANNEL_LIVENESS_PROBE_TIMEOUT_MS;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  let waitedMs = 0;
  while (waitedMs < probeTimeoutMs) {
    const sliceMs = Math.min(250, probeTimeoutMs - waitedMs);
    await sleep(sliceMs);
    waitedMs += sliceMs;
    if (args.hasEnded() || args.rpc.exitCode !== undefined) return "ended";
    if (args.rpc.lastReceivedAt !== receivedBefore) return "alive";
  }
  return "lost";
}

/** Abort the correlated request as well as the caller's wait when Pi stops answering. */
export async function requestGatewaySessionState(
  rpc: Pick<RemoteRpcClient, "request">,
  timeoutMs = SESSION_STATE_TIMEOUT_MS,
): Promise<RpcSessionState> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Pi did not answer get_state within ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );
  try {
    const response = await rpc.request({ type: "get_state" }, { signal: controller.signal });
    if (!response.success) throw new Error(response.error);
    return (response as { data: RpcSessionState }).data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attach-readiness failures come from two different worlds. Pi not answering on a live
 * transport means the supervisor may genuinely be wedged — retirement is the recovery.
 * The transport failing under the probe (a refused write, a reconnect rebind, a dead
 * channel) says nothing about Pi and must never retire its supervisor. Classification is
 * structural — tagged errors plus transport generation/liveness — never error-string
 * matching, so a reworded message cannot silently reintroduce the kill.
 */
export function classifyAttachReadinessFailure(args: {
  error: unknown;
  rpc: Pick<RemoteRpcClient, "transportGeneration" | "transportUsable">;
  generationBefore: number;
}): "transport" | "pi" {
  if (isRpcTransportError(args.error)) return "transport";
  if (args.rpc.transportGeneration !== args.generationBefore) {
    // A reconnect landed mid-probe and discarded its answer — even an untagged rejection
    // (an abort racing the rebind) belongs to the transport, not to Pi.
    return "transport";
  }
  if (!args.rpc.transportUsable) return "transport";
  return "pi";
}

/** One in-flight get_state per session; later attaches probe again after the prior result settles. */
export function ensureGatewaySessionReady(
  session: { readyProbe: Promise<unknown> | null; rpc: Pick<RemoteRpcClient, "request"> },
  timeoutMs = SESSION_STARTUP_STATE_TIMEOUT_MS,
): Promise<unknown> {
  return coalesceReadyProbe(session, () => requestGatewaySessionState(session.rpc, timeoutMs));
}

/**
 * Best-effort semantic lease seed for a newly established pod channel.
 *
 * The shim's hello proves that Pi was spawned, not that Pi's RPC input loop is ready: cold
 * project package installation happens between those points. Keep this request bounded, but
 * never make that initialization delay fail an otherwise healthy gateway attach. The captured
 * revision prevents a late snapshot from overwriting work events observed in the meantime.
 */
export async function seedGatewaySessionActivity(args: {
  rpc: Pick<RemoteRpcClient, "request">;
  activity: Pick<SessionActivityLease, "snapshotRevision" | "seed">;
  warn: (message: string) => void;
  podId: string;
  timeoutMs?: number;
  onState?: (state: RpcSessionState) => void;
}): Promise<void> {
  try {
    const snapshotRevision = args.activity.snapshotRevision();
    const state = await requestGatewaySessionState(
      args.rpc,
      args.timeoutMs ?? SESSION_STARTUP_STATE_TIMEOUT_MS,
    );
    args.onState?.(state);
    await args.activity.seed(state, snapshotRevision);
  } catch (e) {
    // This helper is intentionally safe to fire-and-forget; diagnostics cannot revive its error.
    try {
      args.warn(
        `initial session snapshot unavailable for pod ${args.podId}; continuing: ${
          e instanceof Error ? e.message : e
        }`,
      );
    } catch {
      // Logging is best-effort too.
    }
  }
}

/** Existing-pod attach is a state conflict, not malformed input. */
export function gatewayAttachError(error: unknown): unknown {
  if (error instanceof MissingCredentialError) return conflict(error.message, error.detail);
  return error;
}
