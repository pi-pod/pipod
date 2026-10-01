/** Transport-neutral RPC client used by the account gateway. */
import type {
  AgentSessionEvent,
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ShimControlEvent, ShimHello } from "./protocol.js";
import { CumulativeAgentEventReducer } from "./stream-events.js";

/** pi ships its dependencies bundled, so these two types are structural stand-ins. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type RpcEventListener = (event: AgentSessionEvent) => void;
export type ControlListener = (event: ShimControlEvent) => void;
export type RpcLifecycleListener = (error: Error) => void;


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
   * the shim — most likely a pre-RPC pi pod session (§11).
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

  // --- lifecycle ------------------------------------------------------------

  /** Why a command cannot be sent: overridden when the pod is asleep rather than lost. */
  protected connectionClosedError(): Error {
    return new Error("connection to the pi session was lost");
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
      this.finishPending(id, { error: error instanceof Error ? error : new Error(String(error)) });
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

  async getLastAssistantText(): Promise<string | null> {
    const data = await this.send<{ text: string | null }>({ type: "get_last_assistant_text" });
    return data.text;
  }

  async setSessionName(name: string): Promise<void> {
    await this.send({ type: "set_session_name", name });
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
