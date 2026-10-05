/**
 * src/account/gateway-rpc.ts — GatewayRpcClient (account-mode-spec §6).
 *
 * The account-mode transport for pi's RPC surface: instead of terminating pod frames
 * itself, the CLI multiplexes through the gateway's single RPC connection over the same
 * JSON WebSocket iOS uses, extended with a generic `rpc`/`rpc_result` passthrough. Full TUI
 * fidelity comes from three facts: commands keep this client's unique-prefixed ids (so
 * id-correlated event streams line up), every agent event is fanned out verbatim, and shim
 * control events (pi exit, stderr) are forwarded live.
 *
 * Reconnects are internal: an abnormal socket drop re-mints a ticket and re-attaches
 * through one backoff loop, then reports through `onRecovered` so the runtime can re-sync
 * state. Connection *state* is reported separately via `onConnectionState` so the session
 * driver can render it; the transport itself never writes to the screen.
 */
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { RpcCommand, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { RECOVERY_FLAP_LIMIT, RECOVERY_FLAP_WINDOW_MS, verifyHelloEnvelope } from "../client/compat.js";
import { bundledPiVersion } from "../client/piversion.js";
import type { ShimControlEvent, ShimHello } from "../client/protocol.js";
import { RpcClientBase, type RpcRequestOptions, type ThinkingLevel } from "../client/rpc.js";
import { isRestoreRequiredError, PiPodError, PodAsleepError } from "../errors.js";
import { debug, step } from "../log.js";
import {
  ASLEEP_REASONS,
  asleepReasonFromError,
  classifyAttachError,
  connectionStateKey,
  CONNECT_NOTICE_MS,
  CONNECT_TIMEOUT_MS,
  DROP_RECOVERY_MS,
  DROP_RETRY_DELAY_MS,
  GATEWAY_RESTART_RECOVERY_MS,
  GATEWAY_RESTART_RETRY_DELAY_MS,
  INITIAL_ATTACH_RETRY_BUDGET_MS,
  INITIAL_ATTACH_RETRY_DELAY_MS,
  INITIAL_ATTACH_RETRY_MAX_DELAY_MS,
  isAsleepClose,
  isGatewayRestartClose,
  isPiExitClose,
  isSupersededError,
  isWakeTrigger,
  KEEP_RETRYING_INTERVAL_MS,
  LEASE_RETRY_DELAY_MS,
  PING_INTERVAL_MS,
  PONG_DEADLINE_MS,
  RECOVERY_RETRY_MAX_MS,
  SEMANTIC_REQUEST_TIMEOUT_MS,
  SYNTHETIC_EVENT_KINDS,
  type ConnectionState,
  type GatewayRpcOptions,
  type RecoverCause,
  type ServerHello,
} from "./gateway-rpc-codec.js";
import { displayRef } from "./ref.js";
import { createSessionWebSocket } from "./session-websocket.js";
import {
  isWorkstationCloseReason,
  withWorkstationWait,
  workstationCloseError,
  workstationDemandOf,
  workstationErrorFromSessionMessage,
} from "./workstation.js";

export {
  ASLEEP_CLOSE_CODE,
  ASLEEP_REASONS,
  classifyAttachError,
  CONNECT_TIMEOUT_MS,
  DROP_RECOVERY_MS,
  GATEWAY_HELLO_BUDGET_MS,
  GATEWAY_PROVIDER_START_BUDGET_MS,
  GATEWAY_RESTART_RECOVERY_MS,
  GATEWAY_RESTART_RETRY_DELAY_MS,
  INITIAL_ATTACH_RETRY_BUDGET_MS,
  INITIAL_ATTACH_RETRY_DELAY_MS,
  INITIAL_ATTACH_RETRY_MAX_DELAY_MS,
  isAsleepClose,
  isGatewayRestartClose,
  isPiExitClose,
  isRetryableAttachError,
  isRetryableGatewayRestartError,
  KEEP_RETRYING_INTERVAL_MS,
  PING_INTERVAL_MS,
  PI_EXIT_CLOSE_CODE,
  PONG_DEADLINE_MS,
  RECOVERY_RETRY_MAX_MS,
} from "./gateway-rpc-codec.js";
export type { AttachErrorClass, ConnectionState, GatewayRpcOptions, RecoverCause } from "./gateway-rpc-codec.js";

/** A compatibility probe must not hold startup for the classic RPC query's full minute. */
export const GATEWAY_MODELS_TIMEOUT_MS = 5_000;

export interface GatewayModelsSnapshot {
  models: unknown[];
  current: unknown;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingLevel[];
}

export interface SessionCatalogEntry {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSessionId?: string;
  name?: string;
  modified?: number;
  messageCount?: number;
  firstMessage?: string;
  /** Pod-side session file path; a legacy switch handle, not durable identity. */
  path?: string;
}

export interface SessionSearchHit {
  sessionId: string;
  score?: number;
  top?: { entryId?: string; snippet?: string; timestamp: number };
}

export interface SessionsFrame {
  sessions: SessionCatalogEntry[];
  workdir: string;
  complete: boolean;
  unsupported?: true;
}

export interface SessionHitsFrame {
  hits: SessionSearchHit[];
  unsupported?: true;
}

export interface ResourcesReloadedFrame {
  ok: boolean;
  unsupported?: true;
}

/** Mirrors the pod's own result cap; a longer list is a peer not honouring the v1 contract. */
export const FILE_LIST_MAX_ENTRIES = 50;
/** Long enough for any real path, short enough that one cannot flood the editor. */
export const FILE_LIST_MAX_PATH_LENGTH = 1024;
/** Matches the pod's query cap, so an over-long query is refused before it reaches the wire. */
export const FILE_LIST_MAX_QUERY_LENGTH = 512;

export interface FileListEntry {
  path: string;
  dir: boolean;
}

export interface FilesFrame {
  entries: FileListEntry[];
  complete: boolean;
  unsupported?: true;
}

/** The pod's local-TUI config manifest, still untrusted: pod-manifest.ts validates it. */
export interface TuiManifestFrame {
  digest?: string;
  unchanged?: true;
  manifest?: Record<string, unknown>;
  unsupported?: true;
}

/** One auxiliary completion: a turn-external model call executed pod-side with real auth. */
export interface AuxCompleteWireRequest {
  provider: string;
  model: string;
  systemPrompt?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  thinkingLevel?: ThinkingLevel;
  maxTokens?: number;
  /** Caller deadline; the gateway answers by it (ok or timeout error). */
  timeoutMs?: number;
}

export interface AuxCompleteWireResult {
  text: string;
  stopReason: string;
  usage: unknown;
}

/** Hard ceiling: the gateway answers by min(timeoutMs, AUX_GATEWAY_TIMEOUT_CAP_MS). */
export const AUX_GATEWAY_TIMEOUT_CAP_MS = 120_000;
/**
 * Client-side backstop past the caller's own deadline. The gateway always answers first
 * (its timer fires at timeoutMs), so this only covers a broken gateway — small enough
 * that an old server without aux support fails in ~timeoutMs, not minutes.
 */
export const AUX_CLIENT_SLACK_MS = 2_000;

type SemanticReplyType = "sessions" | "session_hits" | "resources_reloaded" | "files" | "tui_manifest";

interface PendingSemanticReply {
  timer: NodeJS.Timeout;
  accept(value: unknown): void;
}

interface PendingAux {
  resolve(value: AuxCompleteWireResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function clearPendingAux(map: Map<string, PendingAux>, id: string): PendingAux | undefined {
  const pending = map.get(id);
  if (!pending) return undefined;
  map.delete(id);
  clearTimeout(pending.timer);
  if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  return pending;
}

export class GatewayRpcClient extends RpcClientBase {
  private currentPodId: string;
  private ws: WebSocket | null = null;
  private readonly connectingSockets = new Set<WebSocket>();
  private serverHello: ServerHello | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;
  private keepRetrying = false;
  private keepRetryKick: (() => void) | null = null;
  private lastSeq = 0;
  private lastSessionId: string | null = null;
  private readonly seenSeqs = new Set<number>();
  private replayHold: Promise<void> = Promise.resolve();
  private lastMutation: { requestId: string; command: Record<string, unknown>; sessionId: string } | null = null;
  private userClosed = false;
  private recovering = false;
  private waking = false;
  private queuedRecovery: {
    code: number;
    reason: string;
    cause: RecoverCause;
    generation: number;
    podId: string;
  } | null = null;
  private connectionGeneration = 0;
  private recoveredAt: number[] = [];
  private connectionState: ConnectionState | null = null;
  private asleepReason: string | null = null;
  /** False between adopting a skewed hello and readiness replacing it; ordinary RPC is gated. */
  private piVersionReady = false;
  private readonly idPrefix = `cli-${randomBytes(4).toString("hex")}-`;
  private modelsRequest: {
    promise: Promise<GatewayModelsSnapshot>;
    resolve: (snapshot: GatewayModelsSnapshot) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private readonly pendingSemantic = new Map<SemanticReplyType, PendingSemanticReply>();
  /** Auxiliary completions multiplex by caller id — unlike single-slot semantic queries. */
  private readonly pendingAux = new Map<string, PendingAux>();

  private constructor(private readonly opts: GatewayRpcOptions) {
    super();
    this.currentPodId = opts.podId;
  }

  /** Session id on the server, for transcripts and diagnostics. */
  get sessionId(): string | null {
    return this.serverHello?.sessionId ?? null;
  }

  get podId(): string {
    return this.currentPodId;
  }

  /** Pi this gateway will treat as current. Null when the server omitted it (older gateways). */
  get serverPiVersion(): string | null {
    const value = this.serverHello?.serverPiVersion;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  get currentConnectionState(): ConnectionState | null {
    return this.connectionState;
  }

  /**
   * Re-target this client at another server pod (account-mode-spec §6.2): the runtime keeps
   * its rpc reference, only the socket underneath changes. A transient failure on the target
   * reattaches to the previous pod so the TUI is never left detached.
   */
  async switchTo(podId: string): Promise<void> {
    const previousPodId = this.currentPodId;
    this.connectionGeneration += 1;
    this.asleepReason = null;
    this.keepRetrying = false;
    for (const socket of this.connectingSockets) {
      try {
        socket.close(1000, "switch");
      } catch {
        // Still opening or already gone.
      }
    }
    const previous = this.ws;
    this.ws = null; // The close handler ignores sockets it no longer owns.
    try {
      previous?.close(1000, "switch");
    } catch {
      // Already gone.
    }
    this.rejectPending(new Error("connection to the pi session was replaced"));
    this.rejectModelsRequest(new Error("connection to the pi session was replaced"));
    this.rejectAuxRequests(new Error("connection to the pi session was replaced"));
    this.emitLifecycleInvalidation(new Error("connection to the pi session was replaced"));
    this.resetHandshakeState(podId);
    try {
      await this.attachWithBudget({
        generation: this.connectionGeneration,
        podId,
        budgetMs: this.initialAttachBudget(),
        initialDelayMs: this.initialAttachDelay(),
        maxDelayMs: this.initialAttachMaxDelay(),
      });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (isSupersededError(error) || this.userClosed) throw error;
      await this.reattachAfterFailedSwitch(previousPodId, error);
    }
    const hello = this.helloInfo;
    if (!hello) throw new PiPodError("the server session carried no pod handshake");
    this.emitConnectionState({ kind: "connected" });
  }


  static async connect(opts: GatewayRpcOptions): Promise<GatewayRpcClient> {
    const client = new GatewayRpcClient(opts);
    await client.attachWithBudget({
      generation: client.connectionGeneration,
      podId: client.currentPodId,
      budgetMs: client.initialAttachBudget(),
      initialDelayMs: client.initialAttachDelay(),
      maxDelayMs: client.initialAttachMaxDelay(),
      // Cold launch can spend minutes waking a provider; later attempts and reattach cap to remaining budget.
      longFirstHello: true,
    });
    client.emitConnectionState({ kind: "connected" });
    client.startPingWatchdog();
    return client;
  }

  /** Stop and reattach this instance, invalidating the old socket before the lifecycle change. */
  async restartAfterStop(stop: () => Promise<void>): Promise<ShimHello> {
    const podId = this.currentPodId;
    this.connectionGeneration += 1;
    this.asleepReason = null;
    this.keepRetrying = false;
    for (const socket of this.connectingSockets) {
      try {
        socket.close(1000, "pi update");
      } catch {
        // Still opening or already gone.
      }
    }
    const previous = this.ws;
    this.ws = null;
    try {
      previous?.close(1000, "pi update");
    } catch {
      // Already gone.
    }
    this.rejectPending(new Error("the pi session is restarting after an update"));
    this.rejectModelsRequest(new Error("the pi session is restarting after an update"));
    this.rejectAuxRequests(new Error("the pi session is restarting after an update"));
    this.emitLifecycleInvalidation(new Error("the pi session is restarting after an update"));
    this.resetHandshakeState(podId);
    await stop();
    await this.attachWithBudget({
      generation: this.connectionGeneration,
      podId,
      budgetMs: this.initialAttachBudget(),
      initialDelayMs: this.initialAttachDelay(),
      maxDelayMs: this.initialAttachMaxDelay(),
      longFirstHello: true,
    });
    const hello = this.helloInfo;
    if (!hello) throw new PiPodError("the restarted session carried no pod handshake");
    this.emitConnectionState({ kind: "connected" });
    return hello;
  }


  /**
   * Ids must be unique across every client sharing the pi session — the gateway forwards
   * them verbatim (account-mode-spec §6.1), so a bare counter would collide with the
   * gateway's own or another CLI's.
   */
  protected override requestIdPrefix(): string {
    return this.idPrefix;
  }

  protected askForHello(): void {
    // The server pushes the shim hello inside its own hello message; nothing to ask.
  }

  /** Quitting pi from one surface would kill the session for every other; detach instead. */
  shutdown(): void {
    debug("gateway-rpc: shutdown() ignored — account-mode sessions detach; lifecycle is server-owned");
  }

  respondExtensionUi(response: RpcExtensionUIResponse): void {
    this.wsSend({ type: "ui_response", response });
  }

  /** Query the gateway's semantic model surface; old servers time out without blocking forever. */
  getModels(timeoutMs = GATEWAY_MODELS_TIMEOUT_MS): Promise<GatewayModelsSnapshot> {
    if (this.modelsRequest) return this.modelsRequest.promise;

    let resolve!: (snapshot: GatewayModelsSnapshot) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<GatewayModelsSnapshot>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const timer = setTimeout(
      () => this.rejectModelsRequest(new Error("timed out waiting for the gateway model catalog")),
      timeoutMs,
    );
    this.modelsRequest = { promise, resolve, reject, timer };
    try {
      this.wsSend({ type: "get_models" });
    } catch (error) {
      this.rejectModelsRequest(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  /** List pod-side sessions. A timeout or unsupported marker is an absent capability. */
  getSessions(): Promise<SessionsFrame> {
    const absent: SessionsFrame = { sessions: [], workdir: "", complete: false, unsupported: true };
    return this.semanticRequest("sessions", { type: "get_sessions" }, absent);
  }

  /** Search remains pod-side so transcript text never crosses the catalog boundary. */
  searchSessions(text: string, limit?: number): Promise<SessionHitsFrame> {
    const absent: SessionHitsFrame = { hits: [], unsupported: true };
    return this.semanticRequest(
      "session_hits",
      { type: "search_sessions", text, ...(limit !== undefined ? { limit } : {}) },
      absent,
    );
  }

  /**
   * Complete an `@` path against the pod's workspace. Superseding rather than coalescing:
   * each keystroke asks a different question, so an in-flight answer to the previous prefix
   * is not an answer to this one. Never rejects — an absent capability, a slow pod and a
   * malformed reply all mean "no suggestions", which is what the caller renders.
   */
  getFiles(query: string): Promise<FilesFrame> {
    const absent: FilesFrame = { entries: [], complete: false, unsupported: true };
    if (query.length > FILE_LIST_MAX_QUERY_LENGTH) return Promise.resolve(absent);
    return this.semanticRequest("files", { type: "get_files", query }, absent, { supersede: true });
  }

  /** Ask the pod runtime to re-resolve extensions, skills, prompts, themes, and context files. */
  reloadResources(): Promise<ResourcesReloadedFrame> {
    const absent: ResourcesReloadedFrame = { ok: false, unsupported: true };
    return this.semanticRequest("resources_reloaded", { type: "reload_resources" }, absent);
  }

  /**
   * Fetch the pod's local-TUI config manifest (shim v13). Callers gate on the shim version
   * before asking, so an old deployment never burns the semantic timeout here.
   */
  getTuiManifest(knownDigest?: string): Promise<TuiManifestFrame> {
    const absent: TuiManifestFrame = { unsupported: true };
    return this.semanticRequest(
      "tui_manifest",
      { type: "get_tui_manifest", ...(knownDigest !== undefined ? { knownDigest } : {}) },
      absent,
    );
  }

  /**
   * Run one turn-external completion pod-side (semantic gateway message `aux_complete`).
   * The pod's authenticated registry executes it: no transcript entries, no model change,
   * no Tripwire on the main turn. Each call has its own id, deadline and AbortSignal —
   * aborting sends `aux_cancel` and fails only this call. An old gateway that never
   * answers surfaces as a timeout with an actionable message, never a hang.
   */
  auxComplete(request: AuxCompleteWireRequest, opts: { signal?: AbortSignal } = {}): Promise<AuxCompleteWireResult> {
    const id = randomUUID();
    if (opts.signal?.aborted) {
      return Promise.reject(this.auxAbortError(id, opts.signal.reason));
    }
    const timeoutMs = Math.min(request.timeoutMs ?? 60_000, AUX_GATEWAY_TIMEOUT_CAP_MS);
    return new Promise<AuxCompleteWireResult>((resolve, reject) => {
      const fail = (error: Error): void => {
        const pending = clearPendingAux(this.pendingAux, id);
        if (!pending) return;
        reject(error);
      };
      const onAbort = (): void => {
        try {
          this.wsSend({ type: "aux_cancel", id });
        } catch {
          // The transport is already gone; the gateway cleans up session-side instead.
        }
        fail(this.auxAbortError(id, opts.signal?.reason));
      };
      const timer = setTimeout(() => {
        try {
          this.wsSend({ type: "aux_cancel", id });
        } catch {
          // Best effort: the gateway's own deadline answers anyway.
        }
        fail(
          new PiPodError(
            `auxiliary completion timed out after ${Math.round((timeoutMs + AUX_CLIENT_SLACK_MS) / 1000)}s` +
              ` — the server may predate aux support (update the server) or the pod may be unreachable`,
            { code: "aux_timeout" },
          ),
        );
      }, timeoutMs + AUX_CLIENT_SLACK_MS);
      timer.unref?.();
      this.pendingAux.set(id, {
        resolve,
        reject,
        timer,
        ...(opts.signal ? { signal: opts.signal, onAbort } : {}),
      });
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.wsSend({
          type: "aux_complete",
          id,
          provider: request.provider,
          model: request.model,
          ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
          messages: request.messages,
          ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
          timeoutMs,
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private auxAbortError(id: string, reason: unknown): Error {
    void id;
    if (reason instanceof Error) return reason;
    const error = new Error(typeof reason === "string" ? reason : "auxiliary completion was aborted");
    error.name = "AbortError";
    return error;
  }

  private acceptAuxResult(message: Record<string, unknown>): void {
    const id = message["id"];
    if (typeof id !== "string") return;
    const pending = clearPendingAux(this.pendingAux, id);
    if (!pending) return;
    if (message["ok"] === true) {
      const text = message["text"];
      if (typeof text !== "string") {
        pending.reject(new PiPodError("auxiliary completion reply was malformed", { code: "aux_malformed" }));
        return;
      }
      pending.resolve({
        text,
        stopReason: typeof message["stopReason"] === "string" ? (message["stopReason"] as string) : "stop",
        usage: message["usage"] ?? null,
      });
      return;
    }
    const code = typeof message["code"] === "string" ? (message["code"] as string) : "aux_failed";
    const detail = typeof message["error"] === "string" ? (message["error"] as string) : "auxiliary completion failed";
    pending.reject(new PiPodError(detail, { code }));
  }

  private rejectAuxRequests(error: Error): void {
    if (this.pendingAux.size === 0) return;
    const ids = [...this.pendingAux.keys()];
    for (const id of ids) clearPendingAux(this.pendingAux, id)?.reject(error);
  }

  protected transmitCommand(command: RpcCommand & { id: string }): void {
    const outgoing = this.tagMutation(command);
    this.wsSend({ type: "rpc", id: String(outgoing["id"]), command: outgoing });
  }

  private tagMutation(command: RpcCommand & { id: string }): Record<string, unknown> {
    if (!isWakeTrigger(command)) return command as unknown as Record<string, unknown>;
    const requestId = randomUUID();
    const tagged = { ...command, client_request_id: requestId } as unknown as Record<string, unknown>;
    this.lastMutation = {
      requestId,
      command: tagged,
      sessionId: this.serverHello?.sessionId ?? this.lastSessionId ?? "",
    };
    return tagged;
  }

  /** Readiness's two pre-runtime commands bypass the skew gate; no other caller can. */
  async readinessGetState(): Promise<import("@earendil-works/pi-coding-agent").RpcSessionState> {
    const response = await super.request({ type: "get_state" });
    if (!response.success) throw new Error(response.error);
    return (response as { data: import("@earendil-works/pi-coding-agent").RpcSessionState }).data;
  }

  async readinessBash(command: string): Promise<unknown> {
    const response = await super.request({ type: "bash", command, excludeFromContext: true });
    if (!response.success) throw new Error(response.error);
    const data = (response as { data?: { exitCode?: unknown; output?: unknown } }).data;
    if (typeof data?.exitCode !== "number" || data.exitCode !== 0) {
      const output = typeof data?.output === "string" ? data.output.trim().split("\n").at(-1) : undefined;
      throw new Error(`pi update command failed${output ? `: ${output}` : ""}`);
    }
    return data;
  }

  /** A prompt (or steer/follow-up) is an explicit user action: wake a sleeping pod and replay. */
  override async request(command: RpcCommand, options?: RpcRequestOptions) {
    if (this.shouldWakeFor(command)) await this.wake();
    if (!this.piVersionReady) {
      throw new PiPodError("pi version skew: the adopted pod handshake has not passed readiness");
    }
    if (this.shouldKickLostReconnect(command)) {
      this.kickReconnect();
      await this.waitUntilConnected();
    }
    try {
      return await super.request(command, options);
    } catch (error) {
      if (this.shouldWakeFor(command) || (isWakeTrigger(command) && error instanceof PodAsleepError && !this.userClosed)) {
        await this.wake();
        return super.request(command, options);
      }
      throw error;
    }
  }

  private shouldKickLostReconnect(command: RpcCommand): boolean {
    return isWakeTrigger(command) && !this.userClosed && this.connectionState?.kind === "lost";
  }

  /** An explicit user action while lost skips the keep-trying sleep. */
  kickReconnect(): void {
    this.keepRetryKick?.();
  }


  private shouldWakeFor(command: RpcCommand): boolean {
    return isWakeTrigger(command) && !this.userClosed && this.asleepReason !== null;
  }

  protected override connectionClosedError(): Error {
    if (this.asleepReason !== null) return new PodAsleepError(this.asleepReason);
    return super.connectionClosedError();
  }

  /**
   * Reattach after a 4420 (or equivalent) sleep. The server wakes the sandbox on attach,
   * so this is the same path as a reconnect — just user-initiated, with wake-sized patience.
   */
  override async wake(): Promise<void> {
    if (this.userClosed) throw new PiPodError("connection to the pi session was closed");
    if (!this.closed && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.waking) {
      await this.waitUntilConnected();
      return;
    }
    this.waking = true;
    const generation = this.connectionGeneration;
    const podId = this.currentPodId;
    try {
      this.emitConnectionState({ kind: "reconnecting", attempt: 1, cause: "drop" });
      await this.attachWithBudget({
        generation,
        podId,
        // Archived sandboxes can take minutes; a stopped pod is usually seconds.
        budgetMs: this.opts.dropRecoveryMs ?? DROP_RECOVERY_MS,
        initialDelayMs: this.opts.dropRetryDelayMs ?? DROP_RETRY_DELAY_MS,
        maxDelayMs: RECOVERY_RETRY_MAX_MS,
      });
      if (!this.hasRecoveryAuthority(generation, podId)) {
        throw new Error("connection attempt was superseded");
      }
      this.asleepReason = null;
      this.emitConnectionState({ kind: "connected" });
      await this.opts.onRecovered?.();
    } catch (e) {
      let error = e instanceof Error ? e : new Error(String(e));
      if (isRestoreRequiredError(error)) {
        try {
          await this.opts.client.podCommand(podId, "restore");
        } catch (restoreErr) {
          this.emitConnectionState({ kind: "ended", reason: "restore_required" });
          this.opts.onSessionEnded?.("restore_required");
          throw restoreErr instanceof Error ? restoreErr : error;
        }
        try {
          await this.attachWithBudget({
            generation,
            podId,
            budgetMs: this.opts.dropRecoveryMs ?? DROP_RECOVERY_MS,
            initialDelayMs: this.opts.dropRetryDelayMs ?? DROP_RETRY_DELAY_MS,
            maxDelayMs: RECOVERY_RETRY_MAX_MS,
          });
          if (!this.hasRecoveryAuthority(generation, podId)) {
            throw new Error("connection attempt was superseded");
          }
          this.asleepReason = null;
          this.emitConnectionState({ kind: "connected" });
          await this.opts.onRecovered?.();
          return;
        } catch (retryErr) {
          error = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          if (isRestoreRequiredError(error)) {
            this.emitConnectionState({ kind: "ended", reason: "restore_required" });
            this.opts.onSessionEnded?.("restore_required");
            throw error;
          }
        }
      }
      const kind = classifyAttachError(error);
      if (kind === "asleep" || this.asleepReason !== null) {
        const reason = this.asleepReason ?? asleepReasonFromError(error);
        this.enterAsleep(reason);
        throw new PodAsleepError(reason);
      }
      const reason = error.message;
      this.emitConnectionState({ kind: "lost", reason });
      this.opts.onLost?.();
      throw error;
    } finally {
      this.waking = false;
    }
  }

  close(): void {
    this.userClosed = true;
    this.keepRetrying = false;
    this.keepRetryKick?.();
    this.keepRetryKick = null;
    this.connectionGeneration += 1;
    this.asleepReason = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const socket of this.connectingSockets) {
      try {
        socket.close(1000, "detach");
      } catch {
        // Still opening or already gone.
      }
    }
    try {
      this.ws?.close(1000, "detach");
    } catch {
      // Already gone.
    }
    if (!this.closed) {
      this.closed = true;
      const error = new Error("connection to the pi session was closed");
      this.rejectPending(error);
      this.rejectModelsRequest(error);
      this.rejectAuxRequests(error);
    }
  }

  // --- socket lifecycle -----------------------------------------------------

  /** Test seam: the live socket, so tests can inject post-hello faults. */
  get underlyingSocket(): WebSocket | null {
    return this.ws;
  }

  private initialAttachBudget(): number {
    return this.opts.initialAttachRetryBudgetMs ?? INITIAL_ATTACH_RETRY_BUDGET_MS;
  }
  private initialAttachDelay(): number {
    return this.opts.initialAttachRetryDelayMs ?? INITIAL_ATTACH_RETRY_DELAY_MS;
  }
  private initialAttachMaxDelay(): number {
    return this.opts.initialAttachRetryMaxDelayMs ?? INITIAL_ATTACH_RETRY_MAX_DELAY_MS;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private noteActivity(): void {
    this.lastActivityAt = this.now();
  }

  private startPingWatchdog(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const intervalMs = this.opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => this.pingWatchdogTick(), intervalMs);
    this.pingTimer.unref?.();
  }

  private pingWatchdogTick(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const deadlineMs = this.opts.pongDeadlineMs ?? PONG_DEADLINE_MS;
    if (this.now() - this.lastActivityAt > deadlineMs) {
      debug("gateway-rpc: pong deadline exceeded; terminating half-open socket");
      try {
        ws.terminate();
      } catch {
        // The close handler owns recovery.
      }
      return;
    }
    try {
      this.wsSend({ type: "ping" });
    } catch {
      // The close handler owns reconnection.
    }
  }

  private resetHandshakeState(podId: string): void {
    this.currentPodId = podId;
    this.hello = null;
    this.piExitCode = undefined;
    this.stderrTailBuf = "";
    this.serverHello = null;
    this.closed = true;
    this.piVersionReady = false;
    this.lastSeq = 0;
    this.lastSessionId = null;
    this.seenSeqs.clear();
    this.lastMutation = null;
  }

  private async reattachAfterFailedSwitch(previousPodId: string, switchError: Error): Promise<void> {
    this.resetHandshakeState(previousPodId);
    this.connectionGeneration += 1;
    try {
      await this.attachWithBudget({
        generation: this.connectionGeneration,
        podId: previousPodId,
        budgetMs: this.initialAttachBudget(),
        initialDelayMs: this.initialAttachDelay(),
        maxDelayMs: this.initialAttachMaxDelay(),
      });
    } catch (fallback) {
      const fallbackError = fallback instanceof Error ? fallback : new Error(String(fallback));
      if (isSupersededError(fallbackError) || this.userClosed) throw fallbackError;
      throw new PiPodError(
        `switch failed: ${switchError.message} — also could not return to ${displayRef(previousPodId, "pod")}: ${fallbackError.message}`,
        { hint: "reattach with `pipod attach`" },
      );
    }
    this.emitConnectionState({ kind: "connected" });
    throw new PiPodError(`switch failed, staying on ${displayRef(previousPodId, "pod")}`, {
      hint: switchError.message,
    });
  }

  private async attachWithBudget(args: {
    generation: number;
    podId: string;
    budgetMs: number;
    initialDelayMs: number;
    maxDelayMs: number;
    /** First attempt of a fresh launch may wait the full provider+hello path. */
    longFirstHello?: boolean;
  }): Promise<void> {
    const startedAt = this.now();
    // Attempt cap is a frozen-clock safety rail; wall time is the primary budget.
    const maxAttempts = Math.max(
      1,
      Math.floor(args.budgetMs / Math.max(1, args.initialDelayMs)) + 2,
    );
    let delayMs = args.initialDelayMs;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const remainingMs = Math.max(0, args.budgetMs - (this.now() - startedAt));
      const helloTimeoutMs =
        attempt === 1 && args.longFirstHello
          ? CONNECT_TIMEOUT_MS
          : Math.min(CONNECT_TIMEOUT_MS, Math.max(1, remainingMs || 1));
      try {
        await this.attachOnce(args.generation, args.podId, helloTimeoutMs);
        return;
      } catch (e) {
        const lastError = e instanceof Error ? e : new Error(String(e));
        // The user's whole machine being down is not what this budget is for. It exists to
        // ride out a gateway lease settling in seconds; a workstation start measured 243 to
        // 708 seconds in production. Hand it to the shared wait, which stays until the server
        // admits the attach, the user cancels, or the attachment is superseded.
        const demand = workstationDemandOf(lastError);
        if (demand) {
          await withWorkstationWait(
            this.opts.client,
            () => this.attachOnce(args.generation, args.podId, CONNECT_TIMEOUT_MS),
            {
              ...this.opts.workstationWait,
              from: demand,
              cancelled: this.workstationCancelled(args.generation, args.podId),
            },
          );
          // Minutes may have passed inside the wait; only the generation that asked may return.
          if (args.generation !== this.connectionGeneration || args.podId !== this.currentPodId || this.userClosed) {
            throw new Error("connection attempt was superseded");
          }
          return;
        }
        if (isSupersededError(lastError) || classifyAttachError(lastError) !== "retryable") throw lastError;
        if (args.generation !== this.connectionGeneration || args.podId !== this.currentPodId || this.userClosed) {
          throw new Error("connection attempt was superseded");
        }
        if (attempt >= maxAttempts || this.now() - startedAt >= args.budgetMs) throw lastError;
        const waitMs = Math.max(0, args.budgetMs - (this.now() - startedAt));
        await new Promise((r) => setTimeout(r, Math.min(delayMs, waitMs)));
        if (args.generation !== this.connectionGeneration || args.podId !== this.currentPodId || this.userClosed) {
          throw new Error("connection attempt was superseded");
        }
        if (this.now() - startedAt >= args.budgetMs) throw lastError;
        delayMs = Math.min(delayMs * 2, args.maxDelayMs);
      }
    }
  }

  private async attach(
    generation = this.connectionGeneration,
    podId = this.currentPodId,
    retryDelayMs = LEASE_RETRY_DELAY_MS,
    helloTimeoutMs = CONNECT_TIMEOUT_MS,
  ): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.attachOnce(generation, podId, helloTimeoutMs);
        return;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (isSupersededError(lastError) || classifyAttachError(lastError) !== "retryable") break;
        if (generation !== this.connectionGeneration || podId !== this.currentPodId || this.userClosed) {
          lastError = new Error("connection attempt was superseded");
          break;
        }
        await new Promise((r) => setTimeout(r, retryDelayMs));
        if (generation !== this.connectionGeneration || podId !== this.currentPodId || this.userClosed) {
          lastError = new Error("connection attempt was superseded");
          break;
        }
      }
    }
    throw lastError ?? new Error("could not attach to the pod session");
  }

  private attachOnce(generation: number, podId: string, helloTimeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      void (async () => {
        const { ticket } = await this.opts.client.wsTicket(podId);
        if (this.userClosed || generation !== this.connectionGeneration || podId !== this.currentPodId) {
          throw new Error("connection attempt was superseded");
        }
        const url = this.opts.client.sessionWsUrl(podId, {
          ticket,
          ...(this.lastSessionId
            ? { fromSeq: this.lastSeq, fromSession: this.lastSessionId }
            : {}),
        });
        const create = this.opts.createWebSocket ?? createSessionWebSocket;
        const ws = create(url);
        this.connectingSockets.add(ws);
        let settled = false;
        const timers: NodeJS.Timeout[] = [];
        const done = () => {
          for (const t of timers) clearTimeout(t);
          timers.length = 0;
          this.connectingSockets.delete(ws);
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          done();
          try {
            ws.close();
          } catch {
            // Never opened.
          }
          reject(error);
        };
        timers.push(
          setTimeout(
            () =>
              fail(
                new PiPodError("timed out waiting for the session hello", {
                  hint: "the pod may still be starting pi — `pipod attach` retries without relaunching",
                }),
              ),
            helloTimeoutMs,
          ),
          setTimeout(() => {
            if (!settled) step("attach", "waiting for the pi session in the pod to come up");
          }, Math.min(CONNECT_NOTICE_MS, helloTimeoutMs)),
        );

        ws.on("message", (raw) => {
          this.noteActivity();
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(String(raw)) as Record<string, unknown>;
          } catch {
            return;
          }
          if (!settled) {
            if (message["type"] === "hello") {
              if (this.userClosed || generation !== this.connectionGeneration || podId !== this.currentPodId) {
                fail(new Error("connection attempt was superseded"));
                return;
              }
              const serverHello = message as unknown as ServerHello;
              if (serverHello.shim) {
                try {
                  verifyHelloEnvelope(serverHello.shim, { close: () => ws.close() });
                } catch (error) {
                  fail(error instanceof Error ? error : new Error(String(error)));
                  return;
                }
              }
              settled = true;
              done();
              this.adopt(ws, serverHello);
              resolve();
            } else if (message["type"] === "error") {
              const workstation = workstationErrorFromSessionMessage(message);
              if (workstation) {
                fail(workstation);
                return;
              }
              const code = typeof message["code"] === "string" ? message["code"] : undefined;
              const text =
                typeof message["message"] === "string" && message["message"]
                  ? message["message"]
                  : "the session refused to start";
              fail(
                new PiPodError(code ? `${code}: ${text}` : text, {
                  ...(code ? { code } : {}),
                  ...(typeof message["status"] === "number" ? { status: message["status"] } : {}),
                  ...(message["detail"] !== undefined ? { detail: message["detail"] } : {}),
                }),
              );
            }
            return;
          }
          void this.dispatchSettledMessage(message);
        });
        ws.on("error", (e) => {
          const error = e instanceof Error ? e : new Error(String(e));
          if (!settled) {
            fail(error);
            return;
          }
          debug(`gateway-rpc: socket error after hello: ${error.message}`);
          try {
            ws.terminate();
          } catch {
            // The close handler owns recovery.
          }
        });
        ws.on("close", (code, reason) => {
          if (!settled) {
            const why = reason.toString();
            // 4420 is also the ordinary "this pod went to sleep" code, so the reason is what
            // separates an idle pod (seconds, woken by a keystroke) from a whole personal
            // workstation that is not up (minutes, and no keystroke makes it faster).
            if (isWorkstationCloseReason(why)) {
              fail(workstationCloseError(why));
              return;
            }
            fail(new Error(`the session socket closed before hello (${code} ${why})`));
            return;
          }
          if (this.ws === ws) this.handleSocketClosed(code, reason.toString());
        });
      })().catch((e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
    });
  }

  private adopt(ws: WebSocket, hello: ServerHello): void {
    const previous = this.ws;
    this.ws = ws;
    if (this.lastSessionId && this.lastSessionId !== hello.sessionId) {
      this.seenSeqs.clear();
      this.lastSeq = 0;
    }
    this.serverHello = hello;
    this.lastSessionId = hello.sessionId;
    this.closed = false;
    this.asleepReason = null;
    this.keepRetrying = false;
    this.noteActivity();
    if (hello.shim) {
      this.acceptHello(hello.shim);
      this.piVersionReady = hello.shim.piVersion === bundledPiVersion();
    } else {
      this.piVersionReady = false;
    }
    if (previous && previous !== ws) {
      try {
        previous.close(1000, "replaced");
      } catch {
        // Already gone.
      }
    }
    if (this.piVersionReady) void this.resubmitLastMutation();
  }


  private async dispatchSettledMessage(message: Record<string, unknown>): Promise<void> {
    if (message["type"] === "replay_gap") {
      this.replayHold = this.backfillReplayGap(message);
      await this.replayHold;
      return;
    }
    await this.replayHold;
    this.handleMessage(message);
  }

  private async backfillReplayGap(message: Record<string, unknown>): Promise<void> {
    const fromSeq = Number(message["fromSeq"]);
    const toSeq = Number(message["toSeq"]);
    const sessionId = this.lastSessionId;
    if (!sessionId || !Number.isFinite(fromSeq) || !Number.isFinite(toSeq) || toSeq < fromSeq) {
      debug(`gateway-rpc: replay_gap ${String(message["fromSeq"])}..${String(message["toSeq"])}; some events were skipped`);
      return;
    }
    try {
      let after = fromSeq - 1;
      while (after < toSeq) {
        const page = await this.opts.client.sessionEvents(sessionId, { afterSeq: after, limit: 500 });
        if (page.events.length === 0) break;
        for (const event of page.events) {
          if (event.seq < fromSeq || event.seq > toSeq) continue;
          this.handleMessage({
            type: "event",
            seq: event.seq,
            kind: event.kind,
            payload: event.payload,
            ts: event.createdAt,
          });
          after = event.seq;
        }
        if (page.events.length < 500) break;
      }
    } catch (e) {
      debug(
        `gateway-rpc: replay_gap ${fromSeq}..${toSeq} backfill failed (${e instanceof Error ? e.message : e}); falling back to state re-seed`,
      );
    }
  }

  private async resubmitLastMutation(): Promise<void> {
    const pending = this.lastMutation;
    if (!pending || this.userClosed || this.closed) return;
    if (!this.lastSessionId || pending.sessionId !== this.lastSessionId) return;
    try {
      this.wsSend({ type: "rpc", id: (pending.command as { id: string }).id, command: pending.command });
    } catch {
      // Recover loop will try again if the socket drops.
    }
  }

  private noteDurableSeq(seq: unknown): boolean {
    if (typeof seq !== "number" || !Number.isFinite(seq)) return true;
    if (this.seenSeqs.has(seq)) return false;
    this.seenSeqs.add(seq);
    this.lastSeq = Math.max(this.lastSeq, seq);
    if (this.seenSeqs.size > 2000) {
      for (const old of this.seenSeqs) {
        if (old < this.lastSeq - 1500) this.seenSeqs.delete(old);
      }
    }
    return true;
  }

  private handleMessage(message: Record<string, unknown>): void {
    // A skewed hello is usable only for the two readiness RPC responses. Do not let its
    // events mutate classic, advance replay cursors, or resubmit user work before replacement.
    if (
      !this.piVersionReady &&
      (message["type"] === "event" || message["type"] === "ephemeral" || message["type"] === "control")
    ) {
      return;
    }
    switch (message["type"]) {
      case "event": {
        if (!this.noteDurableSeq(message["seq"])) break;
        const kind = String(message["kind"] ?? "");
        if (kind === "control") {
          this.handleControlEvent(message["payload"] as ShimControlEvent);
        } else if (!SYNTHETIC_EVENT_KINDS.has(kind)) {
          this.emitEvent(message["payload"] as never);
        }
        break;
      }
      case "ephemeral":
        this.emitEvent(message["payload"] as never);
        break;
      case "control":
        this.handleControlEvent(message["payload"] as ShimControlEvent);
        break;
      case "rpc_result":
        this.lastMutation = null;
        this.handleResponse(message["response"] as never);
        break;
      case "pod_state":
        debug(`gateway-rpc: pod_state ${String(message["state"])} (${String(message["reason"] ?? "")})`);
        break;
      case "pod_updated":
        debug(`gateway-rpc: pod_updated ${String(message["id"])} ${String(message["name"] ?? "")}`);
        break;
      case "models":
        this.resolveModelsRequest({
          models: Array.isArray(message["models"]) ? message["models"] : [],
          current: message["current"] ?? null,
          thinkingLevel: isThinkingLevel(message["thinkingLevel"]) ? message["thinkingLevel"] : "off",
          thinkingLevels: Array.isArray(message["thinkingLevels"])
            ? message["thinkingLevels"].filter(isThinkingLevel)
            : [],
        });
        break;
      case "sessions": {
        const frame = decodeSessionsFrame(message);
        if (frame) this.acceptSemantic("sessions", frame);
        break;
      }
      case "session_hits": {
        const frame = decodeSessionHitsFrame(message);
        if (frame) this.acceptSemantic("session_hits", frame);
        break;
      }
      case "resources_reloaded": {
        const frame = decodeResourcesReloadedFrame(message);
        if (frame) this.acceptSemantic("resources_reloaded", frame);
        break;
      }
      case "files": {
        const frame = decodeFilesFrame(message);
        if (frame) this.acceptSemantic("files", frame);
        break;
      }
      case "tui_manifest": {
        const frame = decodeTuiManifestFrame(message);
        if (frame) this.acceptSemantic("tui_manifest", frame);
        break;
      }
      case "aux_complete_result":
        this.acceptAuxResult(message);
        break;
      case "dialog_closed":
      case "replay_gap":
      case "pong":
        break;
      case "error":
        debug(`gateway-rpc: server error ${String(message["code"])}: ${String(message["message"])}`);
        break;
    }
  }

  private handleSocketClosed(code: number, reason: string): void {
    if (this.userClosed || this.piExitCode !== undefined) return;

    if (isAsleepClose(code, reason)) {
      // A 4420 with a host reason is the whole workstation being down (minutes), not an idle
      // pod (seconds): it recovers on its own through the shared wait, with the keystroke path
      // kept as a backup rather than the only recovery.
      if (isWorkstationCloseReason(reason)) {
        void this.recoverWorkstation(reason);
        return;
      }
      this.enterAsleep(reason || "idle_stop");
      return;
    }

    if (isPiExitClose(code, reason)) {
      if (this.piExitCode === undefined) this.handleControlEvent({ event: "pi_exit", code: null });
      this.enterEnded(reason || "pi_exit");
      return;
    }

    // A planned gateway replacement is orderly at the WebSocket layer but transient at the
    // application layer. New servers use 1012; the exact reason keeps old servers compatible.
    if (isGatewayRestartClose(code, reason)) {
      void this.recover(code, reason, "gateway_restart");
      return;
    }

    // Other 1000 closes are terminal lifecycle actions: delete/gone.
    if (code === 1000) {
      this.enterEnded(reason || "the server ended the session");
      return;
    }

    // Unknown 4xxx codes degrade to the retryable path (older/newer server compatibility).
    void this.recover(code, reason, "drop");
  }

  private enterAsleep(reason: string): void {
    this.asleepReason = reason;
    this.closed = true;
    const error = new PodAsleepError(reason);
    this.rejectPending(error);
    this.rejectModelsRequest(error);
    this.rejectAuxRequests(error);
    this.emitLifecycleInvalidation(error);
    this.emitConnectionState({ kind: "asleep", reason });
  }

  /**
   * Recover from a post-hello 4420 with a host reason without waiting for a keystroke. The
   * session keeps its honest asleep copy — a keystroke still wakes through the normal path
   * and joins this wait via `waking` — but the client also re-attaches on the workstation
   * schedule on its own. Only the server admitting the attach ends the wait.
   */
  private async recoverWorkstation(reason: string): Promise<void> {
    const generation = this.connectionGeneration;
    const podId = this.currentPodId;
    if (!this.hasRecoveryAuthority(generation, podId) || this.waking) return;
    this.waking = true;
    try {
      this.enterAsleep(reason);
      await withWorkstationWait(
        this.opts.client,
        () => this.attachOnce(generation, podId, CONNECT_TIMEOUT_MS),
        {
          ...this.opts.workstationWait,
          from: workstationCloseError(reason).demand,
          cancelled: this.workstationCancelled(generation, podId),
        },
      );
      // Minutes may have passed inside the wait; adopt already cleared the asleep state on a
      // successful attach, so only finish recovery when nothing superseded it underneath.
      if (!this.hasRecoveryAuthority(generation, podId)) return;
      this.asleepReason = null;
      this.emitConnectionState({ kind: "connected" });
      await this.opts.onRecovered?.();
    } catch (error) {
      // The wait's own budget or a terminal reason ends it; the asleep copy stays, so a later
      // keystroke is still a recovery rather than a dead end.
      debug(`gateway-rpc: workstation wait ended without attaching: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.waking = false;
    }
  }

  private enterEnded(reason: string): void {
    this.closed = true;
    this.asleepReason = null;
    const why = reason || "the server ended the session";
    this.rejectPending(new Error(why));
    this.rejectModelsRequest(new Error(why));
    this.rejectAuxRequests(new Error(why));
    this.emitLifecycleInvalidation(new Error(why));
    this.emitConnectionState({ kind: "ended", reason: why });
    this.opts.onSessionEnded?.(why);
  }

  private async recover(
    code: number,
    reason: string,
    cause: RecoverCause,
    generation = this.connectionGeneration,
    podId = this.currentPodId,
  ): Promise<void> {
    if (this.recovering) {
      this.queuedRecovery = {
        code, reason, cause, generation: this.connectionGeneration, podId: this.currentPodId,
      };
      return;
    }
    if (!this.hasRecoveryAuthority(generation, podId)) return;
    this.recovering = true;
    this.closed = true;
    this.asleepReason = null;
    const disconnectedError = new Error(
      cause === "gateway_restart"
        ? "the gateway restarted; an in-flight RPC outcome may be unknown"
        : "connection to the pi session was lost",
    );
    this.rejectPending(disconnectedError);
    this.rejectModelsRequest(disconnectedError);
    this.rejectAuxRequests(disconnectedError);
    try {
      const recovered = await this.recoverLoop(cause, generation, podId);
      if (recovered || !this.hasRecoveryAuthority(generation, podId) || this.queuedRecovery) return;
      this.emitLifecycleInvalidation(new Error("connection to the pi session was lost"));
      this.emitConnectionState({ kind: "lost", reason: reason || null });
      this.opts.onLost?.();
    } finally {
      this.recovering = false;
      const queued = this.queuedRecovery;
      this.queuedRecovery = null;
      if (queued && this.hasRecoveryAuthority(queued.generation, queued.podId)) {
        void this.recover(
          queued.code, queued.reason, queued.cause, queued.generation, queued.podId,
        );
      }
    }
  }

  private async recoverLoop(cause: RecoverCause, generation: number, podId: string): Promise<boolean> {
    const budgetMs =
      cause === "gateway_restart"
        ? (this.opts.gatewayRestartRecoveryMs ?? GATEWAY_RESTART_RECOVERY_MS)
        : (this.opts.dropRecoveryMs ?? DROP_RECOVERY_MS);
    const deadline = this.now() + budgetMs;
    let retryDelayMs =
      cause === "gateway_restart"
        ? (this.opts.gatewayRestartRetryDelayMs ?? GATEWAY_RESTART_RETRY_DELAY_MS)
        : (this.opts.dropRetryDelayMs ?? DROP_RETRY_DELAY_MS);
    let attempt = 0;
    debug(`gateway-rpc: ${cause} (${budgetMs}ms budget); reconnecting`);
    const initialDelay =
      cause === "gateway_restart"
        ? (this.opts.gatewayRestartRetryDelayMs ?? GATEWAY_RESTART_RETRY_DELAY_MS)
        : (this.opts.dropRetryDelayMs ?? DROP_RETRY_DELAY_MS);
    const maxAttempts = Math.max(1, Math.floor(budgetMs / Math.max(1, initialDelay)) + 2);
    let announcedKeepTrying = false;

    while (this.hasRecoveryAuthority(generation, podId)) {
      attempt += 1;
      if (!announcedKeepTrying) {
        this.emitConnectionState({ kind: "reconnecting", attempt, cause });
      }
      const remainingMs = Math.max(1, deadline - this.now());
      const helloTimeoutMs = announcedKeepTrying
        ? Math.min(CONNECT_TIMEOUT_MS, this.opts.keepRetryingIntervalMs ?? KEEP_RETRYING_INTERVAL_MS)
        : Math.min(CONNECT_TIMEOUT_MS, remainingMs);
      try {
        await this.attach(generation, podId, retryDelayMs, helloTimeoutMs);
        if (!this.hasRecoveryAuthority(generation, podId)) return false;
        this.noteSuccessfulRecovery();
        this.keepRetrying = false;
        this.emitConnectionState({ kind: "connected" });
        await this.opts.onRecovered?.();
        return this.hasRecoveryAuthority(generation, podId);
      } catch (e) {
        if (!this.hasRecoveryAuthority(generation, podId)) return false;
        const error = e instanceof Error ? e : new Error(String(e));
        const kind = classifyAttachError(error);
        if (kind === "asleep") {
          this.enterAsleep(asleepReasonFromError(error));
          return true;
        }
        if (kind === "fatal") {
          debug(`gateway-rpc: recovery aborted: ${error.message}`);
          return false;
        }
        if (!announcedKeepTrying && (attempt >= maxAttempts || this.now() >= deadline)) {
          debug(`gateway-rpc: recovery budget exhausted: ${error.message}; keep trying`);
          this.keepRetrying = true;
          this.emitConnectionState({ kind: "lost", reason: error.message });
          this.opts.onLost?.();
          announcedKeepTrying = true;
        } else if (!announcedKeepTrying) {
          debug(`gateway-rpc: not ready: ${error.message}`);
        }
        const delay = announcedKeepTrying
          ? (this.opts.keepRetryingIntervalMs ?? KEEP_RETRYING_INTERVAL_MS)
          : this.flapping()
            ? RECOVERY_RETRY_MAX_MS
            : retryDelayMs;
        const waitCap = announcedKeepTrying ? delay : Math.max(0, deadline - this.now());
        await this.waitForRetry(Math.min(delay, waitCap || delay));
        if (!announcedKeepTrying) retryDelayMs = Math.min(retryDelayMs * 2, RECOVERY_RETRY_MAX_MS);
      }
    }
    return false;
  }

  private waitForRetry(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.keepRetryKick = null;
        resolve();
      }, ms);
      this.keepRetryKick = () => {
        clearTimeout(timer);
        this.keepRetryKick = null;
        resolve();
      };
    });
  }


  private noteSuccessfulRecovery(): void {
    const now = this.now();
    this.recoveredAt = this.recoveredAt.filter((at) => now - at < RECOVERY_FLAP_WINDOW_MS);
    this.recoveredAt.push(now);
  }

  /** Tight drop/recover cycles sit at the slow end of the backoff instead of exiting. */
  private flapping(): boolean {
    const now = this.now();
    this.recoveredAt = this.recoveredAt.filter((at) => now - at < RECOVERY_FLAP_WINDOW_MS);
    return this.recoveredAt.length >= RECOVERY_FLAP_LIMIT;
  }

  private hasRecoveryAuthority(generation: number, podId: string): boolean {
    return (
      !this.userClosed &&
      this.piExitCode === undefined &&
      generation === this.connectionGeneration &&
      podId === this.currentPodId
    );
  }

  /** Ends a workstation wait that no longer belongs to the live attachment. */
  private workstationCancelled(generation: number, podId: string): () => boolean {
    return () =>
      this.opts.workstationWait?.cancelled?.() === true || !this.hasRecoveryAuthority(generation, podId);
  }

  private emitConnectionState(state: ConnectionState): void {
    const key = connectionStateKey(state);
    if (this.connectionState && connectionStateKey(this.connectionState) === key) return;
    this.connectionState = state;
    this.opts.onConnectionState?.(state);
  }

  private async waitUntilConnected(): Promise<void> {
    const deadline = this.now() + (this.opts.dropRecoveryMs ?? DROP_RECOVERY_MS);
    while (this.now() < deadline) {
      if (!this.closed && this.ws?.readyState === WebSocket.OPEN) return;
      if (this.userClosed) throw new Error("connection to the pi session was closed");
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new PiPodError("timed out waiting for the pod to wake");
  }

  private resolveModelsRequest(snapshot: GatewayModelsSnapshot): void {
    const request = this.modelsRequest;
    if (!request) return;
    this.modelsRequest = null;
    clearTimeout(request.timer);
    request.resolve(snapshot);
  }

  private rejectModelsRequest(error: Error): void {
    const request = this.modelsRequest;
    if (!request) return;
    this.modelsRequest = null;
    clearTimeout(request.timer);
    request.reject(error);
  }

  private semanticRequest<T>(
    replyType: SemanticReplyType,
    request: Record<string, unknown>,
    absent: T,
    options: { supersede?: boolean } = {},
  ): Promise<T> {
    const active = this.pendingSemantic.get(replyType);
    if (active && options.supersede) {
      // The reply channel carries no request id, so only one question of a type can be in
      // flight. Retire the older one rather than answering it with this one's reply. Its
      // own accept clears the timer and vacates the slot, so nothing is removed here.
      active.accept(absent);
    } else if (active) {
      return new Promise<T>((resolve) => {
        const previousAccept = active.accept;
        active.accept = (value) => {
          previousAccept(value);
          resolve(value as T);
        };
      });
    }
    return new Promise<T>((resolve) => {
      const finish = (value: T) => {
        const pending = this.pendingSemantic.get(replyType);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingSemantic.delete(replyType);
        resolve(value);
      };
      const timer = setTimeout(
        () => finish(absent),
        this.opts.semanticRequestTimeoutMs ?? SEMANTIC_REQUEST_TIMEOUT_MS,
      );
      this.pendingSemantic.set(replyType, { timer, accept: (value) => finish(value as T) });
      try {
        this.wsSend(request);
      } catch {
        finish(absent);
      }
    });
  }

  private acceptSemantic(replyType: SemanticReplyType, value: unknown): void {
    this.pendingSemantic.get(replyType)?.accept(value);
  }

  private wsSend(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw this.connectionClosedError();
    }
    this.ws.send(JSON.stringify(message));
  }
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" ||
    value === "high" || value === "xhigh" || value === "max";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function decodeCatalogEntry(value: unknown): SessionCatalogEntry | null {
  if (!isRecord(value) || typeof value["id"] !== "string") return null;
  if (typeof value["createdAt"] !== "number" || !Number.isFinite(value["createdAt"])) return null;
  if (
    !optionalString(value["cwd"]) ||
    !optionalString(value["parentSessionId"]) ||
    !optionalString(value["name"]) ||
    !optionalFiniteNumber(value["modified"]) ||
    !optionalFiniteNumber(value["messageCount"]) ||
    !optionalString(value["firstMessage"]) ||
    !optionalString(value["path"])
  ) return null;
  return value as unknown as SessionCatalogEntry;
}

export function decodeSessionsFrame(message: unknown): SessionsFrame | null {
  if (!isRecord(message) || message["type"] !== "sessions" || !Array.isArray(message["sessions"])) return null;
  if (typeof message["workdir"] !== "string" || typeof message["complete"] !== "boolean") return null;
  if (message["unsupported"] !== undefined && message["unsupported"] !== true) return null;
  const sessions: SessionCatalogEntry[] = [];
  for (const value of message["sessions"]) {
    const entry = decodeCatalogEntry(value);
    if (!entry) return null;
    sessions.push(entry);
  }
  return {
    sessions,
    workdir: message["workdir"],
    complete: message["complete"],
    ...(message["unsupported"] === true ? { unsupported: true as const } : {}),
  };
}

function decodeSearchHit(value: unknown): SessionSearchHit | null {
  if (!isRecord(value) || typeof value["sessionId"] !== "string" || !optionalFiniteNumber(value["score"])) return null;
  const top = value["top"];
  if (top !== undefined) {
    if (!isRecord(top) || !optionalString(top["entryId"]) || !optionalString(top["snippet"])) return null;
    if (typeof top["timestamp"] !== "number" || !Number.isFinite(top["timestamp"])) return null;
  }
  return value as unknown as SessionSearchHit;
}

export function decodeSessionHitsFrame(message: unknown): SessionHitsFrame | null {
  if (!isRecord(message) || message["type"] !== "session_hits" || !Array.isArray(message["hits"])) return null;
  if (message["unsupported"] !== undefined && message["unsupported"] !== true) return null;
  const hits: SessionSearchHit[] = [];
  for (const value of message["hits"]) {
    const hit = decodeSearchHit(value);
    if (!hit) return null;
    hits.push(hit);
  }
  return { hits, ...(message["unsupported"] === true ? { unsupported: true as const } : {}) };
}

export function decodeResourcesReloadedFrame(message: unknown): ResourcesReloadedFrame | null {
  if (!isRecord(message) || message["type"] !== "resources_reloaded" || typeof message["ok"] !== "boolean") return null;
  if (message["unsupported"] !== undefined && message["unsupported"] !== true) return null;
  return {
    ok: message["ok"],
    ...(message["unsupported"] === true ? { unsupported: true as const } : {}),
  };
}

export function decodeFilesFrame(message: unknown): FilesFrame | null {
  if (!isRecord(message) || message["type"] !== "files") return null;
  if (message["unsupported"] !== undefined && message["unsupported"] !== true) return null;
  if (typeof message["complete"] !== "boolean") return null;
  const rawEntries = message["entries"];
  if (!Array.isArray(rawEntries)) return null;
  const entries: FileListEntry[] = [];
  for (const candidate of rawEntries.slice(0, FILE_LIST_MAX_ENTRIES)) {
    if (!isRecord(candidate)) continue;
    const filePath = candidate["path"];
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    if (filePath.length > FILE_LIST_MAX_PATH_LENGTH) continue;
    // A path is pasted straight into the editor; a control character would rewrite the line.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(filePath)) continue;
    entries.push({ path: filePath, dir: candidate["dir"] === true });
  }
  return {
    entries,
    complete: message["complete"],
    ...(message["unsupported"] === true ? { unsupported: true as const } : {}),
  };
}

export function decodeTuiManifestFrame(message: unknown): TuiManifestFrame | null {
  if (!isRecord(message) || message["type"] !== "tui_manifest") return null;
  if (message["unsupported"] !== undefined && message["unsupported"] !== true) return null;
  if (message["unchanged"] !== undefined && message["unchanged"] !== true) return null;
  if (!optionalString(message["digest"])) return null;
  const manifest = message["manifest"];
  if (manifest !== undefined && !isRecord(manifest)) return null;
  return {
    ...(message["digest"] !== undefined ? { digest: message["digest"] } : {}),
    ...(message["unchanged"] === true ? { unchanged: true as const } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
    ...(message["unsupported"] === true ? { unsupported: true as const } : {}),
  };
}
