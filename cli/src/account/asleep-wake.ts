/**
 * Account-mode wake-on-intent: while the gateway connection is asleep, the next
 * real keystroke asks the transport to wake. InteractiveMode keeps its own stdin
 * listener — Node broadcasts `data` to every subscriber, so this does not steal
 * bytes. Detach/quit chords and Ctrl+C-family bytes are ignored so those exits
 * do not force a provider start.
 */
import { CHORD_WINDOW_MS } from "../client/runtime/chords.js";
import type { ConnectionState } from "./gateway-rpc.js";

/** Ctrl+\ — the default chord prefix (`ctrl+\\`). */
const DEFAULT_CHORD_PREFIX_BYTE = 0x1c;

export function isIgnoredAsleepWakeInput(
  chunk: string | Buffer,
  opts: { prefixByte?: number; chordPending?: boolean } = {},
): boolean {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "binary");
  if (buf.length === 0) return true;
  const first = buf[0]!;
  if (first === 0x03 || first === 0x04) return true;
  if (first === (opts.prefixByte ?? DEFAULT_CHORD_PREFIX_BYTE)) return true;
  if (opts.chordPending) return true;
  return false;
}

export function attachAsleepWakeListener(
  stdin: NodeJS.ReadableStream,
  wake: () => void,
  opts: { prefixByte?: number; windowMs?: number; now?: () => number } = {},
): () => void {
  const prefixByte = opts.prefixByte ?? DEFAULT_CHORD_PREFIX_BYTE;
  const windowMs = opts.windowMs ?? CHORD_WINDOW_MS;
  const now = opts.now ?? Date.now;
  let pendingUntil = 0;
  let woken = false;

  const onData = (chunk: string | Buffer) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "binary");
    const t = now();
    const first = buf.length > 0 ? buf[0]! : undefined;
    if (first === prefixByte) {
      pendingUntil = t + windowMs;
      return;
    }
    const chordPending = t < pendingUntil;
    if (chordPending) pendingUntil = 0;
    if (isIgnoredAsleepWakeInput(buf, { prefixByte, chordPending })) return;
    if (woken) return;
    woken = true;
    wake();
  };

  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
  };
}

export interface AsleepWakeBinding {
  onConnectionState(state: ConnectionState): void;
  dispose(): void;
}

/**
 * Attach a one-shot stdin wake listener for each visit to `asleep`, and drop it
 * as soon as the connection leaves that state.
 */
export function bindAsleepWake(opts: {
  stdin: NodeJS.ReadableStream;
  wake: () => void;
  /** When set, only these asleep reasons arm the listener. Omit to arm for every asleep. */
  wakeableReasons?: ReadonlySet<string>;
}): AsleepWakeBinding {
  let detach: (() => void) | null = null;

  const release = () => {
    detach?.();
    detach = null;
  };

  return {
    onConnectionState(state: ConnectionState) {
      if (state.kind !== "asleep") {
        release();
        return;
      }
      if (opts.wakeableReasons && !opts.wakeableReasons.has(state.reason)) {
        release();
        return;
      }
      if (detach) return;
      detach = attachAsleepWakeListener(opts.stdin, opts.wake);
    },
    dispose: release,
  };
}
