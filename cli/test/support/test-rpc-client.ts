import type {
  AgentSessionEvent,
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { ShimControlEvent } from "../../src/client/protocol.js";
import { RpcClientBase } from "../../src/client/rpc.js";

/** In-memory, transport-neutral RPC seam for host runtime tests. */
export class TestRpcClient extends RpcClientBase {
  readonly commands: Array<RpcCommand & { id: string }> = [];
  readonly extensionUiResponses: RpcExtensionUIResponse[] = [];
  readonly controlCommands: Array<{ cmd: "hello" | "shutdown" }> = [];
  private readonly outboundCommands: Array<(RpcCommand & { id: string }) | RpcExtensionUIResponse> = [];
  private readonly queuedResponses: Array<{ type: string; data?: unknown; outcome: { success: false; error: string } | { success?: true } }> = [];
  shutdownCalls = 0;
  helloRequests = 0;

  protected askForHello(): void {
    this.helloRequests += 1;
    this.controlCommands.push({ cmd: "hello" });
  }

  protected transmitCommand(command: RpcCommand & { id: string }): void {
    this.commands.push(command);
    this.outboundCommands.push(command);
    const queuedIndex = this.queuedResponses.findIndex((item) => item.type === command.type);
    if (queuedIndex >= 0) {
      const queued = this.queuedResponses.splice(queuedIndex, 1)[0]!;
      queueMicrotask(() => this.respondById(command.id, command.type, queued.data, queued.outcome));
    }
  }

  shutdown(): void {
    this.shutdownCalls += 1;
    this.controlCommands.push({ cmd: "shutdown" });
  }

  respondExtensionUi(response: RpcExtensionUIResponse): void {
    this.extensionUiResponses.push(response);
    this.outboundCommands.push(response);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error("connection to the pi session was closed"));
  }

  commandsOf(type: string): Array<Record<string, unknown>> {
    return this.outboundCommands.filter((command) => command.type === type) as Array<Record<string, unknown>>;
  }

  sentJson(kind: "command" | "control"): unknown[] {
    return kind === "command" ? [...this.outboundCommands] : [...this.controlCommands];
  }

  respond(
    type: string,
    data?: unknown,
    outcome: { success: false; error: string } | { success?: true } = {},
  ): void {
    const command = [...this.commands].reverse().find((candidate) => candidate.type === type && this.pending.has(candidate.id));
    if (!command) {
      this.queuedResponses.push({ type, data, outcome });
      return;
    }
    this.respondById(command.id, type, data, outcome);
  }

  respondById(
    id: string,
    type: string,
    data?: unknown,
    outcome: { success: false; error: string } | { success?: true } = {},
  ): void {
    const response = (outcome.success === false
      ? { type: "response", id, command: type, success: false, error: outcome.error }
      : { type: "response", id, command: type, success: true, data }) as unknown as RpcResponse & { id: string };
    this.handleResponse(response);
  }

  injectEvent(event: unknown): void {
    if ((event as { type?: string }).type === "response") {
      this.handleResponse(event as RpcResponse & { id?: string });
      return;
    }
    this.emitEvent(event as AgentSessionEvent | JsonAgentSessionEvent);
  }

  injectControl(event: ShimControlEvent): void {
    this.handleControlEvent(event);
  }

  invalidate(error = new Error("connection to the pi session was lost")): void {
    this.closed = true;
    this.rejectPending(error);
    this.emitLifecycleInvalidation(error);
  }
}
