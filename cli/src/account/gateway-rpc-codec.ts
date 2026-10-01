import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import type WebSocket from "ws";
import type { ShimHello } from "../client/protocol.js";
import { PiPodError, PodAsleepError } from "../errors.js";
import type { AccountClient } from "./api.js";
import type { WorkstationWaitOptions } from "./workstation.js";

/**
 * The gateway can spend five minutes waking a provider sandbox before it starts its own
 * 60-second shim handshake. Giving up first abandons that in-flight wake, and the next attach
 * only sees the gateway lease as `pod_unavailable`. Keep the client beyond the whole server
 * path so the user receives the provider's precise failure instead of a misleading hello
 * timeout. The final minute is scheduling and database headroom.
 */
export const GATEWAY_PROVIDER_START_BUDGET_MS = 5 * 60_000;
export const GATEWAY_HELLO_BUDGET_MS = 60_000;
export const CONNECT_TIMEOUT_MS = GATEWAY_PROVIDER_START_BUDGET_MS + GATEWAY_HELLO_BUDGET_MS + 60_000;
/** A cold pod is still installing pi, so say so rather than going silent for a minute. */
export const CONNECT_NOTICE_MS = 10_000;
export const PING_INTERVAL_MS = 15_000;
/** Two missed ping intervals, plus a little slack, before a silent socket is treated as dead. */
export const PONG_DEADLINE_MS = 40_000;
/** Old gateways ignore semantic capability requests; absence is established by this bound. */
export const SEMANTIC_REQUEST_TIMEOUT_MS = 10_000;
/** After the drop-recovery budget, keep probing this often instead of sitting permanently lost. */
export const KEEP_RETRYING_INTERVAL_MS = 15_000;
/** A 4409 means the pod's gateway lease is settling (or the pod's session is being replaced); brief retry. */
export const LEASE_RETRY_DELAY_MS = 2_000;
/** Attach retries across transient session replacements and gateway lease hand-offs. */
export const INITIAL_ATTACH_RETRY_BUDGET_MS = 30_000;
export const INITIAL_ATTACH_RETRY_DELAY_MS = 500;
export const INITIAL_ATTACH_RETRY_MAX_DELAY_MS = 2_000;
/** Long enough to outlive the server's 60-second stale gateway lease after an unclean restart. */
export const GATEWAY_RESTART_RECOVERY_MS = 120_000;
export const GATEWAY_RESTART_RETRY_DELAY_MS = 500;
/** How long a plain drop keeps retrying before the transport reports `lost`. */
export const DROP_RECOVERY_MS = 10 * 60_000;
/** Shared backoff cap for the unified recover loop (flapping links sit here instead of exiting). */
export const RECOVERY_RETRY_MAX_MS = 15_000;
/** First retry delay for a plain drop; gateway restart keeps GATEWAY_RESTART_RETRY_DELAY_MS. */
export const DROP_RETRY_DELAY_MS = 500;

/** Server close 4420, or a 1000 + one of these reasons on an older server. */
export const ASLEEP_CLOSE_CODE = 4420;
export const PI_EXIT_CLOSE_CODE = 4421;
export const ASLEEP_REASONS = new Set([
  "idle_stop",
  "archived",
  "archive",
  "provider_stopped",
  "provider_archived",
]);

export type ConnectionState =
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number; cause: "drop" | "gateway_restart" }
  | { kind: "asleep"; reason: string }
  | { kind: "lost"; reason: string | null }
  | { kind: "ended"; reason: string };

export type RecoverCause = "drop" | "gateway_restart";

export type AttachErrorClass = "retryable" | "fatal" | "asleep";

/**
 * Transient attach failures are anything the recover loop would retry: network errors,
 * 5xx ticket fetches, lease settling, a missing shim hello, or an abnormal pre-hello close.
 * Version skew and other fatal classifications never become retryable by waiting.
 */
export function isRetryableAttachError(error: Error): boolean {
  return classifyAttachError(error) === "retryable";
}

/** Both the new 1012 contract and the legacy reason identify a planned gateway replacement. */
export function isGatewayRestartClose(code: number, reason: string): boolean {
  return code === 1012 || reason === "gateway_shutdown";
}

export function isAsleepClose(code: number, reason: string): boolean {
  return code === ASLEEP_CLOSE_CODE || ASLEEP_REASONS.has(reason);
}

export function isPiExitClose(code: number, reason: string): boolean {
  return code === PI_EXIT_CLOSE_CODE || reason === "pi_exit";
}

/**
 * Classify an attach/ticket failure for the recover loop. Fatal errors abort immediately;
 * everything else (including unknown 4xxx close leftovers) stays retryable so an older or
 * newer server never strands the client on a single shot.
 */
export function classifyAttachError(error: Error): AttachErrorClass {
  if (error instanceof PodAsleepError) return "asleep";
  if (isAsleepErrorMessage(error.message)) return "asleep";
  if (/provider_resource_exhausted|PTY slots are exhausted/i.test(error.message)) return "fatal";
  if (error instanceof PiPodError) {
    if (error.transient) return "retryable";
    if (error.status === 401 || error.status === 403) return "fatal";
    if (error.status === 404 || error.status === 410) return "fatal";
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return "fatal";
  }
  if (
    /pod_not_found|unauthorized|forbidden|session has expired|proto|version skew|speaks frame protocol|pod is archived|deleted|stalled on an oversized frame|this pi pod bundles pi|did not report its pi pin/i.test(
      error.message,
    )
  ) {
    return "fatal";
  }
  return "retryable";
}

/** Planned replacement retries transport/server failures, but never permanent pod/auth errors. */
export function isRetryableGatewayRestartError(error: Error): boolean {
  return classifyAttachError(error) === "retryable";
}

function isAsleepErrorMessage(message: string): boolean {
  return /idle_stop|provider_stopped|provider_archived|\basleep\b|\barchived\b/.test(message);
}

export function connectionStateKey(state: ConnectionState): string {
  switch (state.kind) {
    case "connected":
      return "connected";
    case "reconnecting":
      return `reconnecting:${state.cause}:${state.attempt}`;
    case "asleep":
      return `asleep:${state.reason}`;
    case "lost":
      return `lost:${state.reason ?? ""}`;
    case "ended":
      return `ended:${state.reason}`;
  }
}

/** Server-persisted kinds that are not agent events; everything else is pi's own stream. */
export const SYNTHETIC_EVENT_KINDS = new Set([
  "user_prompt",
  "session_started",
  "session_ended",
  "interaction_resolved",
  "control",
]);

export interface ServerHello {
  sessionId: string;
  podId: string;
  latestSeq: number;
  state: unknown;
  shim: ShimHello | null;
  /** Gateway's own pi pin. Absent on older servers; the CLI must not upgrade past this. */
  serverPiVersion?: string;
}

export interface GatewayRpcOptions {
  client: AccountClient;
  podId: string;
  /** The transport dropped and came back: re-sync runtime state. */
  onRecovered?: (() => void | Promise<void>) | undefined;
  /** Recovery is exhausted or the failure is non-retryable. */
  onLost?: (() => void) | undefined;
  /** The server deliberately ended the pod session for a terminal lifecycle reason. */
  onSessionEnded?: ((reason: string) => void) | undefined;
  /** Continuous connection state for the session driver to render. Deduped on kind+attempt. */
  onConnectionState?: ((state: ConnectionState) => void) | undefined;
  /** Test seams; production uses the bounded replacement recovery constants above. */
  gatewayRestartRecoveryMs?: number | undefined;
  gatewayRestartRetryDelayMs?: number | undefined;
  /** Test seam for the drop-recovery budget; production uses DROP_RECOVERY_MS. */
  dropRecoveryMs?: number | undefined;
  dropRetryDelayMs?: number | undefined;
  /** Test seams for initial attach; production uses INITIAL_ATTACH_* constants. */
  initialAttachRetryBudgetMs?: number | undefined;
  initialAttachRetryDelayMs?: number | undefined;
  initialAttachRetryMaxDelayMs?: number | undefined;
  /** Test seams for the ping watchdog; production uses PING_INTERVAL_MS / PONG_DEADLINE_MS. */
  pingIntervalMs?: number | undefined;
  pongDeadlineMs?: number | undefined;
  /** After the drop budget, how often keep-trying mode probes; production uses KEEP_RETRYING_INTERVAL_MS. */
  keepRetryingIntervalMs?: number | undefined;
  /** Test seam for semantic capability discovery; production waits ten seconds for old servers. */
  semanticRequestTimeoutMs?: number | undefined;
  /** Deterministic clock for retry tests. */
  now?: (() => number) | undefined;
  /** Test seam: inject a socket (or a factory) so tests can emit post-hello errors. */
  createWebSocket?: ((url: string) => WebSocket) | undefined;
  /**
   * Timing overrides for the workstation wait a post-hello 4420 starts; production uses the
   * server's own schedule (retryAfterMs clamped to [5s, 60s]). Tests inject a fast sleep.
   */
  workstationWait?: WorkstationWaitOptions | undefined;
}

export function isSupersededError(error: Error): boolean {
  return /superseded/.test(error.message);
}

export function isWakeTrigger(command: RpcCommand): boolean {
  const type = command.type;
  return type === "prompt" || type === "steer" || type === "follow_up";
}

export function asleepReasonFromError(error: Error): string {
  if (error instanceof PodAsleepError) return error.reason;
  for (const reason of ASLEEP_REASONS) {
    if (error.message.includes(reason)) return reason;
  }
  return "idle_stop";
}
