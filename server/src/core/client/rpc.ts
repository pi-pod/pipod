/**
 * src/client/rpc.ts — RemoteRpcClient (§5.1).
 *
 * pi exports an RpcClient, but it spawns a local subprocess; this one speaks the same
 * documented JSONL protocol over a provider PTY channel carrying frames (§4.1). Deliberately
 * the same public surface as pi's — `request()`, `onEvent()`, typed helpers — so pi's own
 * types (`RpcCommand`, `RpcResponse`, `AgentSessionEvent`) are imported, not re-declared.
 *
 * The transport-agnostic half lives in {@link RpcClientBase}: everything the runtime layer
 * consumes — request/response correlation, the hello handshake, control events, the typed
 * helper surface — with the byte-level frame channel abstracted behind three methods. The
 * account-mode gateway client (account-mode-spec §6.2) implements the same base over a
 * server WebSocket, so pi's real InteractiveMode runs identically over either transport.
 */
import type {
  AgentSessionEvent,
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
  SessionEntry,
  SessionStats,
  SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import {
  FrameDecoder,
  type ShimControlEvent,
  type ShimHello,
  type ShimTuiManifest,
  encodeCommandFrame,
  encodeControlFrame,
  parseShimControl,
} from "./frames.js";
import { CumulativeAgentEventReducer } from "./stream-events.js";

/** pi ships its dependencies bundled, so these two types are structural stand-ins. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * What the client needs from the transport: a reliable-ordered byte pipe. A provider
 * `PtySession` satisfies this structurally; tests use an in-memory pair.
 */
export interface FrameChannel {
  write(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  close(): void;
}

export type RpcEventListener = (event: AgentSessionEvent) => void;
export type ControlListener = (event: ShimControlEvent) => void;
export type RpcLifecycleListener = (error: Error) => void;

export interface RemoteRpcClientOptions {
  channel: FrameChannel;
  /**
   * Tapped on every frame in either direction — the heartbeat and keepalive integration
   * point, identical to the byte taps it replaces (§5.1).
   */
  onActivity?: () => void;
  /** Test seam; production abandons unterminated lines at the decoder's 64 MiB cap. */
  maxLineBytes?: number;
}

export interface RpcRequestOptions {
  signal?: AbortSignal;
  /**
   * Fail the request rather than wait forever. Defaults to {@link QUERY_TIMEOUT_MS} for the
   * read-only `get_*` commands and to no deadline for everything else — a prompt runs for as
   * long as the agent takes, and a client that timed one out would be lying about the turn.
   */
  timeoutMs?: number | undefined;
}

interface PendingRpcRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** How much of pi's stderr the client keeps for crash reports (§12). */
const STDERR_TAIL_BYTES = 64 * 1024;

/**
 * How long a read-only query may go unanswered before the client calls it lost.
 *
 * Every `get_*` is a question about state the pod already holds, so the only thing between
 * asking and answering is transport. Generous enough for a multi-megabyte transcript over a
 * slow link, and short enough that a reply which will never arrive surfaces as an error the
 * session can report instead of a caller parked on a promise for the life of the process.
 */
export const QUERY_TIMEOUT_MS = 60_000;

/** Read-only by construction: pi answers from state it already has (§6.1). */
function isQueryCommand(command: RpcCommand): boolean {
  return typeof command.type === "string" && command.type.startsWith("get_");
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "RPC request was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * A request left without a usable answer because the transport failed underneath it: the
 * channel refused the write, died, or a reconnect discarded the pending reply. This says
 * nothing about whether Pi ran the command — a discarded reply may still have executed —
 * so it must never read as proof of non-execution, and non-idempotent commands must not
 * be auto-replayed on the back of it. Raised at the point of knowledge so gateway policy
 * can classify readiness failures structurally instead of matching error strings.
 */
export class RpcTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RpcTransportError";
  }
}

/** Whether an RPC failure is the transport failing under the request rather than Pi. */
export function isRpcTransportError(error: unknown): error is RpcTransportError {
  return error instanceof RpcTransportError;
}

/**
 * Everything a pi RPC client is, minus the transport. Subclasses supply three things: how a
 * command travels ({@link transmitCommand}), how to nudge the far side for a hello
 * ({@link askForHello}), and what closing means. Inbound traffic re-enters through
 * {@link handleControlEvent}, {@link handleResponse} and {@link emitEvent}.
 */
export abstract class RpcClientBase {
  protected readonly eventListeners = new Set<RpcEventListener>();
  protected readonly controlListeners = new Set<ControlListener>();
  protected readonly lifecycleListeners = new Set<RpcLifecycleListener>();
  protected readonly pending = new Map<string, PendingRpcRequest>();
  /** Recently completed ids stay retired so duplicate/late responses never fan out as events. */
  protected readonly retiredRequestIds = new Set<string>();
  /** Converts Pi's delta-only JSON/RPC stream back to the in-process cumulative event shape. */
  protected readonly eventReducer = new CumulativeAgentEventReducer();
  private requestId = 0;
  protected hello: ShimHello | null = null;
  protected helloWaiters: Array<(h: ShimHello) => void> = [];
  protected stderrTailBuf = "";
  protected piExitCode: number | null | undefined;
  protected closed = false;

  // --- handshake (§4.3) -----------------------------------------------------

  /**
   * Resolve once the shim's hello frame arrives, or reject after the bound. The caller
   * verifies proto and pi version; no hello means the pod is running something other than
   * the shim — most likely a pre-RPC pi-pod session (§11).
   */
  waitForHello(timeoutMs: number): Promise<ShimHello> {
    if (this.hello) return Promise.resolve(this.hello);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiters = this.helloWaiters.filter((w) => w !== onHello);
        reject(new Error(`no hello from the pod shim within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const onHello = (h: ShimHello) => {
        clearTimeout(timer);
        resolve(h);
      };
      this.helloWaiters.push(onHello);
    });
  }

  /** The last hello seen, if any — a reattach re-emits one (§6.3). */
  get helloInfo(): ShimHello | null {
    return this.hello;
  }

  /**
   * Obtain a hello by asking for one, repeatedly, until the bound expires (§4.3).
   *
   * Waiting passively is not enough on a real provider: the shim emits its startup hello the
   * moment it boots, which can be before the provider has wired the client's output stream —
   * the frame is simply dropped by the relay. The shim answers `S {"cmd":"hello"}` at any
   * time, so an active ask-and-retry loop converges as soon as both directions are live.
   */
  async ensureHello(timeoutMs: number, opts: { discardCached?: boolean } = {}): Promise<ShimHello> {
    if (opts.discardCached) this.hello = null;
    if (this.hello) return this.hello;

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`no hello from the pod shim within ${Math.round(timeoutMs / 1000)}s`);
      }
      this.askForHello();
      try {
        return await this.waitForHello(Math.min(1000, remaining));
      } catch {
        // Ask again: either side of the channel may not have been live yet.
      }
    }
  }

  /** Nudge the far side to (re-)emit its hello; a transport that pushes one unprompted no-ops. */
  protected abstract askForHello(): void;

  protected acceptHello(hello: ShimHello): void {
    this.hello = hello;
    const waiters = this.helloWaiters;
    this.helloWaiters = [];
    for (const waiter of waiters) waiter(hello);
  }

  // --- inbound --------------------------------------------------------------

  /** A shim control event arrived, whatever carried it: bookkeeping first, listeners after. */
  protected handleControlEvent(event: ShimControlEvent): void {
    if (event.event === "hello") {
      this.acceptHello(event);
    } else if (event.event === "pi_stderr") {
      this.stderrTailBuf = (this.stderrTailBuf + Buffer.from(event.data, "base64").toString("utf8")).slice(
        -STDERR_TAIL_BYTES,
      );
    } else if (event.event === "pi_exit") {
      this.piExitCode = event.code;
      this.closed = true;
      const error = new Error(`pi exited${event.code === null ? "" : ` with code ${event.code}`}`);
      this.rejectPending(error);
      this.emitLifecycleInvalidation(error);
    }

    for (const l of this.controlListeners) l(event);
  }

  /** A correlated response arrived. Unknown/duplicate/retired ids are consumed silently. */
  protected handleResponse(response: RpcResponse & { id?: string }): void {
    if (response.id !== undefined) this.finishPending(response.id, { response });
  }

  protected emitEvent(event: AgentSessionEvent | JsonAgentSessionEvent): void {
    const normalized = this.eventReducer.normalize(event);
    for (const l of this.eventListeners) l(normalized);
  }

  /** Fan out a cumulative snapshot recovered after a transport or renderer gap. */
  protected emitRecoveredStreamSnapshot(message: unknown): boolean {
    const event = this.eventReducer.adopt(message);
    if (!event) return false;
    for (const listener of this.eventListeners) listener(event);
    return true;
  }

  /** Gateway transports already receive a cumulative reconnect snapshot from the server. */
  async refreshStreamingSnapshot(): Promise<boolean> {
    const message = this.eventReducer.streamingMessage;
    return message ? this.emitRecoveredStreamSnapshot(message) : false;
  }

  /** Ask shim v13+ for the pod's local-TUI config manifest; null when the transport cannot. */
  requestTuiManifest(_knownDigest?: string, _timeoutMs?: number): Promise<ShimTuiManifest | null> {
    return Promise.resolve(null);
  }

  // --- lifecycle ------------------------------------------------------------

  /** Why a command cannot be sent: overridden when the pod is asleep rather than lost. */
  protected connectionClosedError(): Error {
    return new RpcTransportError("connection to the pi session was lost");
  }

  /**
   * Reattach after the pod went to sleep (account-mode 4420). Local transports no-op;
   * {@link GatewayRpcClient} wakes the sandbox by attaching again.
   */
  wake(): Promise<void> {
    return Promise.resolve();
  }


  protected rejectPending(error: Error): void {
    for (const id of [...this.pending.keys()]) this.finishPending(id, { error });
  }

  protected emitLifecycleInvalidation(error: Error): void {
    for (const listener of this.lifecycleListeners) listener(error);
  }

  private retireRequestId(id: string): void {
    this.retiredRequestIds.add(id);
    if (this.retiredRequestIds.size > 1024) {
      const oldest = this.retiredRequestIds.values().next().value as string | undefined;
      if (oldest !== undefined) this.retiredRequestIds.delete(oldest);
    }
  }

  protected finishPending(id: string, outcome: { response: RpcResponse } | { error: Error }): boolean {
    const waiter = this.pending.get(id);
    if (!waiter) return false;
    this.pending.delete(id);
    waiter.cleanup();
    this.retireRequestId(id);
    if ("response" in outcome) waiter.resolve(outcome.response);
    else waiter.reject(outcome.error);
    return true;
  }

  abstract close(): void;

  // --- subscriptions ---------------------------------------------------------

  onEvent(listener: RpcEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onControl(listener: ControlListener): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  /** Notify lifecycle-bound brokers when the current RPC session can no longer answer. */
  onLifecycleInvalidated(listener: RpcLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  /** Tail of pi's stderr, for crash reports (§12). */
  getStderr(): string {
    return this.stderrTailBuf;
  }

  /** pi's exit code once a pi_exit control frame has arrived; undefined before that. */
  get exitCode(): number | null | undefined {
    return this.piExitCode;
  }

  // --- outbound --------------------------------------------------------------

  /** Ask the shim to SIGTERM pi — how the client expresses "quit pi" (§6.2). */
  abstract shutdown(): void;

  /** Answer an extension-UI dialog (§5.3). */
  abstract respondExtensionUi(response: RpcExtensionUIResponse): void;

  /** Deliver a command that already carries its correlation id. */
  protected abstract transmitCommand(command: RpcCommand & { id: string }): void;

  /** A fresh correlation id — callers pass it in a command to tie streamed events to it. */
  newRequestId(): string {
    return `${this.requestIdPrefix()}${++this.requestId}`;
  }

  /** Override to keep ids globally unique when several clients share one pi session (§6.1). */
  protected requestIdPrefix(): string {
    return "pp-";
  }

  /** Send a command and await its correlated response (which may be `success: false`). */
  request(command: RpcCommand, options: RpcRequestOptions = {}): Promise<RpcResponse> {
    if (this.closed) return Promise.reject(this.connectionClosedError());
    const id = command.id ?? this.newRequestId();
    if (this.pending.has(id) || this.retiredRequestIds.has(id)) {
      return Promise.reject(new Error(`RPC request id is already in use or retired: ${id}`));
    }
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));

    const timeoutMs = options.timeoutMs ?? (isQueryCommand(command) ? QUERY_TIMEOUT_MS : undefined);
    const promise = new Promise<RpcResponse>((resolve, reject) => {
      const onAbort = () => {
        this.finishPending(id, { error: abortError(options.signal?.reason) });
      };
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.finishPending(id, {
            error: new Error(
              `the pod did not answer ${command.type} within ${Math.round(timeoutMs / 1000)}s`,
            ),
          });
        }, timeoutMs);
        timer.unref?.();
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        options.signal?.removeEventListener("abort", onAbort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });

    if (!this.pending.has(id)) return promise;
    try {
      this.transmitCommand({ ...command, id });
    } catch (error) {
      // A refusing channel is transport failure, not Pi silence — tag it at the source.
      const cause = error instanceof Error ? error : new Error(String(error));
      this.finishPending(id, {
        error: new RpcTransportError(`cannot send ${command.type}: ${cause.message}`, { cause }),
      });
    }
    return promise;
  }

  /** `request()`, unwrapped: throws on `success: false`, returns `data` otherwise. */
  protected async send<T = unknown>(command: RpcCommand, options?: RpcRequestOptions): Promise<T> {
    const response = await this.request(command, options);
    if (!response.success) throw new Error(response.error);
    return (response as { data?: T }).data as T;
  }

  // --- typed helpers, mirroring pi's RpcClient -------------------------------

  async prompt(message: string, images?: ImageContent[], options?: RpcRequestOptions): Promise<void> {
    await this.send({ type: "prompt", message, ...(images ? { images: images as never } : {}) }, options);
  }

  async steer(message: string, images?: ImageContent[]): Promise<void> {
    await this.send({ type: "steer", message, ...(images ? { images: images as never } : {}) });
  }

  async followUp(message: string, images?: ImageContent[]): Promise<void> {
    await this.send({ type: "follow_up", message, ...(images ? { images: images as never } : {}) });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.send({ type: "new_session", ...(parentSession ? { parentSession } : {}) });
  }

  getState(): Promise<RpcSessionState> {
    return this.send({ type: "get_state" });
  }

  setModel(provider: string, modelId: string): Promise<unknown> {
    return this.send({ type: "set_model", provider, modelId });
  }

  cycleModel(): Promise<{ model: unknown; thinkingLevel: ThinkingLevel; isScoped: boolean } | null> {
    return this.send({ type: "cycle_model" });
  }

  async getAvailableModels(): Promise<unknown[]> {
    const data = await this.send<{ models: unknown[] }>({ type: "get_available_models" });
    return data.models;
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.send({ type: "set_thinking_level", level });
  }

  cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
    return this.send({ type: "cycle_thinking_level" });
  }

  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    const data = await this.send<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" });
    return data.levels;
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.send({ type: "set_steering_mode", mode });
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    await this.send({ type: "set_follow_up_mode", mode });
  }

  compact(customInstructions?: string): Promise<unknown> {
    return this.send({ type: "compact", ...(customInstructions ? { customInstructions } : {}) });
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.send({ type: "set_auto_compaction", enabled });
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.send({ type: "set_auto_retry", enabled });
  }

  async abortRetry(): Promise<void> {
    await this.send({ type: "abort_retry" });
  }

  bash(command: string, opts?: { excludeFromContext?: boolean }): Promise<unknown> {
    return this.send({
      type: "bash",
      command,
      ...(opts?.excludeFromContext !== undefined ? { excludeFromContext: opts.excludeFromContext } : {}),
    });
  }

  async abortBash(): Promise<void> {
    await this.send({ type: "abort_bash" });
  }

  getSessionStats(): Promise<SessionStats> {
    return this.send({ type: "get_session_stats" });
  }

  exportHtml(outputPath?: string): Promise<{ path: string }> {
    return this.send({ type: "export_html", ...(outputPath ? { outputPath } : {}) });
  }

  switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return this.send({ type: "switch_session", sessionPath });
  }

  fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    return this.send({ type: "fork", entryId });
  }

  clone(): Promise<{ cancelled: boolean }> {
    return this.send({ type: "clone" });
  }

  async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
    const data = await this.send<{ messages: Array<{ entryId: string; text: string }> }>({
      type: "get_fork_messages",
    });
    return data.messages;
  }

  getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
    return this.send({ type: "get_entries", ...(since ? { since } : {}) });
  }

  /** Wire parity only: the response nests one level per entry, so pi fails to serialize it on a
   *  long session. RemoteStateCache derives the tree from get_entries instead. */
  getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
    return this.send({ type: "get_tree" });
  }

  async getLastAssistantText(): Promise<string | null> {
    const data = await this.send<{ text: string | null }>({ type: "get_last_assistant_text" });
    return data.text;
  }

  async setSessionName(name: string): Promise<void> {
    await this.send({ type: "set_session_name", name });
  }

  async getMessages(): Promise<unknown[]> {
    const data = await this.send<{ messages: unknown[] }>({ type: "get_messages" });
    return data.messages;
  }

  async getCommands(): Promise<unknown[]> {
    const data = await this.send<{ commands: unknown[] }>({ type: "get_commands" });
    return data.commands;
  }

  /** Resolves on the next `agent_settled` event — pi's "everything drained" point. */
  waitForIdle(timeoutMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const unsubscribe = this.onEvent((event) => {
        if ((event as { type?: string }).type === "agent_settled") {
          if (timer) clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`agent did not settle within ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }
}

export class RemoteRpcClient extends RpcClientBase {
  private channel: FrameChannel;
  private readonly onActivity: (() => void) | undefined;
  private readonly maxLineBytes: number | undefined;
  private decoder: FrameDecoder;
  /** When the channel last delivered any bytes — the liveness probe's proof of life (§6.3). */
  private lastReceivedAtMs = Date.now();
  /** Monotonically identifies the only channel whose callbacks may mutate this client. */
  private channelGeneration = 0;
  private readonly streamSnapshotWaiters = new Set<{
    resolve: (message: Record<string, unknown> | null) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly tuiManifestWaiters = new Set<{
    resolve: (manifest: ShimTuiManifest | null) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(opts: RemoteRpcClientOptions) {
    super();
    this.channel = opts.channel;
    this.onActivity = opts.onActivity;
    this.maxLineBytes = opts.maxLineBytes;
    this.decoder = new FrameDecoder(this.maxLineBytes);
    this.bindChannel(opts.channel);
  }

  protected askForHello(): void {
    this.writeFrame(encodeControlFrame(JSON.stringify({ cmd: "hello" })));
  }

  /**
   * Ask the live shim to re-emit hello — the reattach/reconnect handshake (§6.3). Discards
   * any cached hello first, so the answer reflects the shim's current truth (piRunning may
   * have changed while no client was watching).
   */
  requestHello(timeoutMs: number): Promise<ShimHello> {
    this.hello = null;
    this.askForHello();
    return this.waitForHello(timeoutMs);
  }

  /** Ask shim v7+ for the cumulative partial it retained while this client was detached. */
  override refreshStreamingSnapshot(): Promise<boolean> {
    const shimVersion = Number.parseInt(this.helloInfo?.shimVersion ?? "", 10);
    if (!Number.isFinite(shimVersion) || shimVersion < 7 || this.closed) return Promise.resolve(false);

    return new Promise<Record<string, unknown> | null>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.streamSnapshotWaiters.delete(waiter);
          resolve(null);
        }, 2_000),
      };
      this.streamSnapshotWaiters.add(waiter);
      try {
        this.channel.write(encodeControlFrame(JSON.stringify({ cmd: "stream_snapshot" })));
      } catch {
        clearTimeout(waiter.timer);
        this.streamSnapshotWaiters.delete(waiter);
        resolve(null);
      }
    }).then((message) => (message ? this.emitRecoveredStreamSnapshot(message) : false));
  }

  /** Ask the live shim for the pod's local-TUI config manifest (shim v13). */
  override requestTuiManifest(knownDigest?: string, timeoutMs = 5_000): Promise<ShimTuiManifest | null> {
    const shimVersion = Number.parseInt(this.helloInfo?.shimVersion ?? "", 10);
    if (!Number.isFinite(shimVersion) || shimVersion < 13 || this.closed) return Promise.resolve(null);

    return new Promise<ShimTuiManifest | null>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          this.tuiManifestWaiters.delete(waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.tuiManifestWaiters.add(waiter);
      try {
        this.channel.write(
          encodeControlFrame(
            JSON.stringify({ cmd: "tui_manifest", ...(knownDigest ? { knownDigest } : {}) }),
          ),
        );
      } catch {
        clearTimeout(waiter.timer);
        this.tuiManifestWaiters.delete(waiter);
        resolve(null);
      }
    });
  }

  // --- transport ------------------------------------------------------------

  /**
   * Swap the underlying channel after a reconnect or pod switch. Binding a new generation
   * retires every callback and request owned by the previous one before target traffic is read.
   */
  rebindChannel(channel: FrameChannel, hello?: ShimHello): void {
    const error = new RpcTransportError("connection to the pi session was replaced");
    this.rejectPending(error);
    this.bindChannel(channel);
    // Notify after the new channel is bound so best-effort broker recovery cannot enqueue work
    // on the retired transport between rejection and replacement.
    this.emitLifecycleInvalidation(error);
    if (hello) this.acceptHello(hello);
  }

  /** Make the current channel's callbacks inert without closing the provider PTY. */
  retireChannel(): void {
    this.channelGeneration++;
    this.closed = true;
    const error = new RpcTransportError("connection to the pi session was replaced");
    this.rejectPending(error);
    this.emitLifecycleInvalidation(error);
  }

  /**
   * Monotonically identifies the bound channel. Every bind, rebind, and retire moves it,
   * so a caller can tell whether the transport changed underneath an in-flight request —
   * the reconnect race a boolean flag cannot see (it resets before the rejection lands).
   */
  get transportGeneration(): number {
    return this.channelGeneration;
  }

  /**
   * Whether a new request can still travel on the bound channel: false after an explicit
   * close/retire/pi-exit, or while the channel itself reports closed. A half-open socket
   * still reads open — only a live round trip proves those, so callers confirm liveness
   * before any destructive recovery.
   */
  get transportUsable(): boolean {
    if (this.closed) return false;
    const isOpen = (this.channel as Partial<{ isOpen: boolean }>).isOpen;
    return typeof isOpen !== "boolean" || isOpen;
  }

  private bindChannel(channel: FrameChannel): void {
    const generation = ++this.channelGeneration;
    this.channel = channel;
    this.decoder = new FrameDecoder(this.maxLineBytes);
    this.closed = false;
    this.lastReceivedAtMs = Date.now();
    channel.onData((data) => this.handleChannelData(data, generation));
  }

  /**
   * Forget everything that belonged to the previous pod — hello, pi's exit, its stderr —
   * so a channel rebound to a different pod (§6.4) starts from that pod's truth.
   */
  resetPodState(): void {
    this.hello = null;
    this.piExitCode = undefined;
    this.stderrTailBuf = "";
    this.eventReducer.reset();
  }

  /** The transport dropped: fail everything waiting on it. Event listeners stay subscribed. */
  handleChannelClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new RpcTransportError("connection to the pi session was lost");
    this.rejectPending(error);
    this.emitLifecycleInvalidation(error);
  }

  close(): void {
    try {
      this.channel.close();
    } finally {
      this.handleChannelClosed();
    }
  }

  private handleChannelData(data: Uint8Array, generation: number): void {
    if (generation !== this.channelGeneration || this.closed) return;
    this.lastReceivedAtMs = Date.now();
    const frames = this.decoder.push(data);
    // Hello answers are how the liveness probe pings the shim; machine chatter must not
    // vouch for a human's presence, so hello-only chunks bypass the activity tap the idle
    // heartbeat reads. Everything else — events, responses, even channel noise — counts.
    const helloOnly =
      frames.length > 0 &&
      frames.every((frame) => frame.kind === "control" && parseShimControl(frame.json)?.event === "hello");
    if (!helloOnly) this.onActivity?.();
    for (const frame of frames) {
      if (frame.kind === "event") this.handlePiLine(frame.json);
      else if (frame.kind === "control") this.handleControlJson(frame.json);
      else if (frame.kind === "noise") this.handleNoise(frame.text);
      else if (frame.kind === "oversized_line") this.handleOversizedLine(frame);
      // "command" frames only travel client → pod; one arriving here is channel noise.
    }
  }

  /**
   * pi wrote a non-JSON line to stdout. Locally it would have hit the terminal; here the
   * closest surviving surface is the stderr tail, where --verbose and crash reports look.
   */
  private handleNoise(text: string): void {
    this.stderrTailBuf = (this.stderrTailBuf + `[pi stdout] ${text}\n`).slice(-STDERR_TAIL_BYTES);
  }

  /**
   * The decoder abandoned a line that outgrew its buffer. When the head named an RPC reply,
   * fail that request now with the real reason — a dropped response is otherwise a silent
   * 60s timeout no reconnect can recover (the 2026-08 attach outages).
   */
  private handleOversizedLine(frame: { bytes: number; response: { command: string | null; id: string | null } | null }): void {
    const command = frame.response?.command ?? "an RPC command";
    const description = `the pod's reply to ${command} outgrew the frame limit (${frame.bytes} bytes buffered) and was dropped`;
    this.handleNoise(`[frame] ${description}`);
    const id = frame.response?.id;
    if (id !== undefined && id !== null) this.finishPending(id, { error: new Error(description) });
  }

  private handleControlJson(json: string): void {
    const event = parseShimControl(json);
    if (!event) return;
    if (event.event === "stream_snapshot") {
      const waiters = [...this.streamSnapshotWaiters];
      this.streamSnapshotWaiters.clear();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(event.message);
      }
      return;
    }
    if (event.event === "tui_manifest") {
      // Answers the direct request only; a manifest blob must not ride the control fanout.
      const waiters = [...this.tuiManifestWaiters];
      this.tuiManifestWaiters.clear();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
      return;
    }
    this.handleControlEvent(event);
  }

  private handlePiLine(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    const msg = parsed as { type?: string; id?: string };

    if (msg.type === "response") {
      // Responses belong only to direct RPC callers. Unknown, duplicate, retired, and malformed
      // correlation ids are consumed instead of leaking into the agent event stream.
      this.handleResponse(msg as RpcResponse & { id?: string });
      return;
    }

    // Agent events and extension-UI requests fan out to subscribers; direct RPC responses never do.
    // The runtime layer maps the surviving event stream (§5.2, §5.3).
    this.emitEvent(msg as JsonAgentSessionEvent);
  }

  // --- outbound --------------------------------------------------------------

  shutdown(): void {
    this.writeFrame(encodeControlFrame(JSON.stringify({ cmd: "shutdown" })));
  }

  /** Millisecond timestamp of the last bytes the channel delivered. */
  get lastReceivedAt(): number {
    return this.lastReceivedAtMs;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  decoderStats(): { malformedLines: number; noiseLines: number; pendingBytes: number; decodedLines: number } {
    return this.decoder.stats();
  }

  /**
   * Ask the shim to answer with a hello — active proof the channel is alive in both
   * directions (§6.3). Deliberately not routed through writeFrame: liveness chatter must
   * not count as user activity, or the ping itself would keep an idle pod alive forever.
   */
  ping(): void {
    if (this.closed) return;
    try {
      this.channel.write(encodeControlFrame(JSON.stringify({ cmd: "hello" })));
    } catch {
      // A refusing transport is what the probe deadline exists to catch.
    }
  }

  /**
   * Ask the shim to re-emit journaled fire-and-forget extension-UI frames with a podSeq
   * after `since` (§5.3) — how a returning client recovers what a detached stretch dropped.
   * Deliberately not routed through writeFrame: replay chatter is machine traffic and must
   * not count as user activity, the same posture as ping().
   */
  requestUiReplay(since: number): void {
    if (this.closed) return;
    try {
      this.channel.write(encodeControlFrame(JSON.stringify({ cmd: "ui_replay", since })));
    } catch {
      // Best-effort: a refusing transport already has channel recovery in flight.
    }
  }

  /** Ask the shim to replay journaled agent events after `since` (shim v9). */
  requestEventReplay(since: number): void {
    if (this.closed) return;
    try {
      this.channel.write(encodeControlFrame(JSON.stringify({ cmd: "event_replay", since })));
    } catch {
      // Best-effort: a refusing transport already has channel recovery in flight.
    }
  }

  /**
   * Declare the local shadow copy's per-file sizes and ask the shim to stream session-file
   * bytes from there (§5.6). Machine traffic, same posture as ping(): not user activity.
   */
  requestMirrorSync(files: Record<string, number>): void {
    if (this.closed) return;
    try {
      this.channel.write(encodeControlFrame(JSON.stringify({ cmd: "mirror_sync", files })));
    } catch {
      // Best-effort: a refusing transport already has channel recovery in flight.
    }
  }

  /** Answer an extension-UI dialog (§5.3). Travels as an ordinary line on pi's stdin. */
  respondExtensionUi(response: RpcExtensionUIResponse): void {
    this.writeFrame(encodeCommandFrame(JSON.stringify(response)));
  }

  protected transmitCommand(command: RpcCommand & { id: string }): void {
    this.writeFrame(encodeCommandFrame(JSON.stringify(command)));
  }

  private writeFrame(frame: Uint8Array): void {
    this.onActivity?.();
    this.channel.write(frame);
  }
}
