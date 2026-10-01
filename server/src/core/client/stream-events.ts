import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

type MessageStart = Extract<AgentSessionEvent, { type: "message_start" }>;
type AssistantMessage = Extract<MessageStart["message"], { role: "assistant" }>;
type AssistantContent = AssistantMessage["content"][number];
type WireEvent = AgentSessionEvent | JsonAgentSessionEvent;

type DeltaEvent = {
  type?: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  contentSignature?: string;
  toolCall?: Extract<AssistantContent, { type: "toolCall" }>;
  partial?: AssistantMessage;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assistantMessage(value: unknown): AssistantMessage | null {
  if (!value || typeof value !== "object" || (value as { role?: unknown }).role !== "assistant") return null;
  const message = value as AssistantMessage;
  return Array.isArray(message.content) ? message : null;
}

/**
 * Pi 0.84's JSON/RPC protocol removes cumulative assistant snapshots from message_update.
 * Pi's in-process AgentSessionEvent consumers (including InteractiveMode) still require them,
 * so every remote transport normalizes its wire events through this reducer.
 */
export class CumulativeAgentEventReducer {
  private current: AssistantMessage | null = null;
  /** Tool-call starts no longer carry identity on the 0.84 wire; retain JSON until the end does. */
  private readonly pendingToolJson = new Map<number, string>();

  get streamingMessage(): AssistantMessage | null {
    return this.current ? clone(this.current) : null;
  }

  reset(): void {
    this.current = null;
    this.pendingToolJson.clear();
  }

  /** Seed a stream recovered from the pod shim or gateway's reconnect snapshot. */
  adopt(message: unknown): AgentSessionEvent | null {
    const assistant = assistantMessage(message);
    if (!assistant) return null;
    this.current = clone(assistant);
    this.pendingToolJson.clear();
    return { type: "message_update", message: clone(this.current) } as AgentSessionEvent;
  }

  normalize(event: WireEvent): AgentSessionEvent {
    const value = event as AgentSessionEvent & {
      message?: unknown;
      assistantMessageEvent?: DeltaEvent;
    };

    if (value.type === "agent_start") this.reset();

    if (value.type === "message_start") {
      const assistant = assistantMessage(value.message);
      if (assistant) {
        this.current = clone(assistant);
        this.pendingToolJson.clear();
      }
      return event as AgentSessionEvent;
    }

    if (value.type === "message_end") {
      const result = event as AgentSessionEvent;
      if (assistantMessage(value.message)) this.reset();
      return result;
    }

    if (value.type !== "message_update") return event as AgentSessionEvent;

    // Pi <=0.83 and pp's stable gateway protocol already carry a cumulative message.
    const cumulative = assistantMessage(value.message) ?? assistantMessage(value.assistantMessageEvent?.partial);
    if (cumulative) {
      this.current = clone(cumulative);
      return event as AgentSessionEvent;
    }

    if (!this.current || !value.assistantMessageEvent) return event as AgentSessionEvent;
    this.apply(value.assistantMessageEvent);
    const snapshot = clone(this.current);
    return {
      ...value,
      message: snapshot,
      assistantMessageEvent: { ...value.assistantMessageEvent, partial: snapshot },
    } as AgentSessionEvent;
  }

  private apply(event: DeltaEvent): void {
    if (!this.current || typeof event.contentIndex !== "number" || event.contentIndex < 0) return;
    const index = event.contentIndex;

    switch (event.type) {
      case "text_start":
        this.current.content[index] = { type: "text", text: "" };
        break;
      case "text_delta": {
        const block = this.current.content[index];
        if (block?.type === "text") block.text += event.delta ?? "";
        else this.current.content[index] = { type: "text", text: event.delta ?? "" };
        break;
      }
      case "text_end":
        this.current.content[index] = {
          type: "text",
          text: event.content ?? (this.current.content[index]?.type === "text" ? this.current.content[index].text : ""),
          ...(event.contentSignature ? { textSignature: event.contentSignature } : {}),
        };
        break;
      case "thinking_start":
        this.current.content[index] = { type: "thinking", thinking: "" };
        break;
      case "thinking_delta": {
        const block = this.current.content[index];
        if (block?.type === "thinking") block.thinking += event.delta ?? "";
        else this.current.content[index] = { type: "thinking", thinking: event.delta ?? "" };
        break;
      }
      case "thinking_end":
        this.current.content[index] = {
          type: "thinking",
          thinking:
            event.content ??
            (this.current.content[index]?.type === "thinking" ? this.current.content[index].thinking : ""),
          ...(event.contentSignature ? { thinkingSignature: event.contentSignature } : {}),
        };
        break;
      case "toolcall_start":
        this.pendingToolJson.set(index, "");
        break;
      case "toolcall_delta":
        this.pendingToolJson.set(index, (this.pendingToolJson.get(index) ?? "") + (event.delta ?? ""));
        break;
      case "toolcall_end":
        if (event.toolCall) this.current.content[index] = clone(event.toolCall);
        this.pendingToolJson.delete(index);
        break;
    }
  }
}
