import type WebSocket from "ws";
import type { FrameChannel } from "../../core/client/rpc.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const POD_TRANSPORT_BUFFER_LIMIT = 8 * 1024 * 1024;

/** The shim's `S {"event":"ping"}` liveness frame; fields may grow, the event name is the contract. */
export function isShimPingFrame(text: string): boolean {
  if (!text.startsWith("S ") || !text.includes('"ping"')) return false;
  try {
    const parsed = JSON.parse(text.slice(2)) as { event?: unknown };
    return parsed?.event === "ping";
  } catch {
    return false;
  }
}

/**
 * Message-oriented adapter for the pod dial-out socket. The v1 frame protocol remains
 * line-oriented, but the newline is carrier framing now: exactly one C/E/S line rides each
 * WebSocket message and RemoteRpcClient continues to receive the byte stream it expects.
 */
export class WsPodChannel implements FrameChannel {
  private listener: ((data: Uint8Array) => void) | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private closed = false;

  constructor(
    readonly socket: WebSocket,
    readonly podId: string,
  ) {
    socket.on("message", (raw, isBinary) => {
      if (this.closed) return;
      try {
        const text = isBinary
          ? decoder.decode(raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer))
          : raw.toString();
        if (text.includes("\n") || text.includes("\r") || !/^[CES] /.test(text)) {
          socket.close(4400, "malformed_frame");
          return;
        }
        // Answer shim liveness pings at the transport layer, so the shim can detect a
        // half-open socket even while no gateway session is reading this channel. Old shims
        // ignore the unknown control command.
        if (isShimPingFrame(text) && socket.readyState === socket.OPEN) {
          socket.send('S {"cmd":"pong"}');
        }
        const bytes = encoder.encode(`${text}\n`);
        if (this.listener) this.listener(bytes);
        else {
          this.pendingBytes += bytes.byteLength;
          if (this.pendingBytes > POD_TRANSPORT_BUFFER_LIMIT) {
            socket.close(1013, "overloaded");
            return;
          }
          this.pending.push(bytes);
        }
      } catch {
        socket.close(4400, "malformed_frame");
      }
    });
    socket.once("close", () => {
      this.closed = true;
      this.pending.length = 0;
      this.pendingBytes = 0;
    });
    socket.once("error", () => {
      this.closed = true;
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN;
  }

  write(data: Uint8Array): void {
    if (!this.isOpen) throw new Error("pod transport is not connected");
    let text = decoder.decode(data);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (text.includes("\n") || text.includes("\r") || !/^[CES] /.test(text)) {
      throw new Error("pod transport writes must contain exactly one frame line");
    }
    if (this.socket.bufferedAmount > POD_TRANSPORT_BUFFER_LIMIT) {
      this.socket.close(1013, "overloaded");
      throw new Error("pod transport send buffer is overloaded");
    }
    this.socket.send(text);
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.listener = cb;
    for (const data of this.pending.splice(0)) cb(data);
    this.pendingBytes = 0;
  }

  close(code = 1000, reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.pendingBytes = 0;
    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }
}

interface Waiter {
  resolve: (channel: WsPodChannel) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Single-writer registry plus the attach path's bounded wait primitive. */
export class PodTransportRegistry {
  readonly channels = new Map<string, WsPodChannel>();
  private waiters = new Map<string, Set<Waiter>>();

  bind(channel: WsPodChannel): WsPodChannel | null {
    const previous = this.channels.get(channel.podId) ?? null;
    this.channels.set(channel.podId, channel);
    if (previous && previous !== channel) previous.close(4408, "superseded");
    channel.socket.once("close", () => {
      if (this.channels.get(channel.podId) === channel) this.channels.delete(channel.podId);
    });
    const waiters = this.waiters.get(channel.podId);
    if (waiters) {
      this.waiters.delete(channel.podId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(channel);
      }
    }
    return previous;
  }

  connected(podId: string): WsPodChannel | null {
    const channel = this.channels.get(podId);
    return channel?.isOpen ? channel : null;
  }

  waitFor(podId: string, timeoutMs: number): Promise<WsPodChannel> {
    const existing = this.connected(podId);
    if (existing) return Promise.resolve(existing);
    return new Promise<WsPodChannel>((resolve, reject) => {
      const waiter = {} as Waiter;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        const podWaiters = this.waiters.get(podId);
        podWaiters?.delete(waiter);
        if (podWaiters?.size === 0) this.waiters.delete(podId);
        reject(new Error(`pod transport did not connect within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      let podWaiters = this.waiters.get(podId);
      if (!podWaiters) this.waiters.set(podId, (podWaiters = new Set()));
      podWaiters.add(waiter);
    });
  }

  close(podId: string, reason = "closed"): void {
    this.channels.get(podId)?.close(1012, reason);
    this.channels.delete(podId);
  }

  shutdown(): void {
    for (const channel of this.channels.values()) channel.close(1012, "gateway_shutdown");
    this.channels.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("gateway is shutting down"));
      }
    }
    this.waiters.clear();
  }
}
