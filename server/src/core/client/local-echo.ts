/**
 * src/client/local-echo.ts — speculative local echo for the remote TUI (§5.7).
 *
 * The remote TUI round-trips every keystroke to the pod before its echo appears, and on a
 * distant pod that lag is the mode's one ergonomic regression against RPC's local editor.
 * This engine is the launcher half of the fix (the pod half is src/shim/echo-beacon.ts):
 * when the pod-side beacon says a focused text field is waiting at the parked cursor, a
 * typed printable character is drawn immediately — underlined, mosh-style, to mark it
 * speculative — and reconciled against the real frames as they arrive.
 *
 * Reconciliation is the whole design. Every beacon carries `b`, the count of stdin bytes
 * the pod's pi has received; the launcher stamps each prediction with its own cumulative
 * sent-byte offset. A beacon with `b` at or past a prediction's stamp means the frame that
 * preceded the beacon already reflects that keystroke — the prediction is retired. The ones
 * still outstanding were just overdrawn by that frame (pi repainted the composer without
 * them), so they are redrawn at the freshly parked cursor, which is exactly where the first
 * unconfirmed character belongs. The two byte clocks can start misaligned (the beacon
 * installs late, terminal query responses are consumed before pi's input listeners); the
 * offset is re-derived on any beacon that arrives while the keyboard has been quiet, when
 * the pipeline is provably empty.
 *
 * Prediction is deliberately narrow: printable ASCII only, only while the beacon's last
 * frame parked a cursor in a plain insert state (`f=1`), never within two columns of the
 * right edge (an autowrap would move the real cursor to a row pi does not know it is on),
 * and paused after any unpredictable input (Enter, arrows, escape sequences, pastes) until
 * the pod confirms it has caught up. Every wrong guess a narrow gate prevents matters more
 * than a right guess it forgoes: a missed prediction costs one round-trip of latency, a
 * misprediction paints a lie.
 */

import { ECHO_BEACON_OSC_PREFIX } from "../shim/echo-beacon.js";

const OSC_PREFIX = Buffer.from(ECHO_BEACON_OSC_PREFIX, "latin1");
const BEL = 0x07;
const ESC = 0x1b;

/** An unterminated candidate longer than this is not a beacon; flush it as ordinary output. */
const MAX_OSC_BYTES = 64;

/** Keyboard quiet time after which a beacon's byte clock is trusted as an offset anchor. */
const IDLE_RESYNC_MS = 400;

/** Give up on a prediction the pod has not confirmed for this long (transport hiccup). */
const PREDICTION_TTL_MS = 5_000;

const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";

interface Prediction {
  char: number;
  /** Cumulative sent bytes after this char went out; confirmed when the beacon reaches it. */
  stamp: number;
  at: number;
}

interface Beacon {
  b: number;
  f: number;
  c: number;
}

/** Terminator scan outcome: where the payload ends, or why it does not. */
type TerminatorScan = { kind: "found"; payloadEnd: number; next: number } | { kind: "incomplete" } | { kind: "foreign" };

function isPrintableAscii(buf: Buffer): boolean {
  for (const byte of buf) {
    if (byte < 0x20 || byte > 0x7e) return false;
  }
  return buf.length > 0;
}

function parseBeacon(payload: string): Beacon | null {
  const match = /^b=(\d+);f=([01]);c=(\d+)$/.exec(payload);
  if (!match) return null;
  return { b: Number(match[1]), f: Number(match[2]), c: Number(match[3]) };
}

export class LocalEchoEngine {
  private pending: Prediction[] = [];
  private sentBytes = 0;
  private lastSendAt = 0;
  /** sentBytes minus the beacon's byte clock, established on an idle beacon; null = not yet synced. */
  private offset: number | null = null;
  private lastBeaconB = 0;
  /** Prediction gate from the last beacon: parked cursor in plain insert state. */
  private focused = false;
  /** The parked cursor's absolute screen column from the last beacon. */
  private col = 0;
  /** Sent-byte watermark the pod must confirm before prediction resumes (unpredictable input). */
  private pauseUntil = 0;
  /** Carry for a beacon OSC split across output chunks. */
  private tail: Buffer = Buffer.alloc(0);
  /** Whether any visible output arrived since the last beacon — i.e. a frame repainted. */
  private repainted = false;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Account for bytes forwarded to the remote stdin, and return the bytes to draw locally —
   * `null` when this input is not predicted.
   */
  onInput(forward: Buffer, columns: number): Buffer | null {
    this.sentBytes += forward.length;
    this.lastSendAt = this.now();

    if (!isPrintableAscii(forward)) {
      // Unknown effect (Enter, arrows, escape sequences, pastes): drop the speculation and
      // hold off until the pod confirms it has processed everything sent so far.
      this.pending = [];
      this.pauseUntil = this.sentBytes;
      return null;
    }

    if (this.offset === null || !this.focused) return null;
    if (this.progress() < this.pauseUntil) return null;
    // Never within reach of an autowrap: a wrapped local echo would move the real cursor to
    // a row pi's relative movements do not account for.
    if (this.col + this.pending.length + forward.length >= columns - 1) return null;

    const at = this.now();
    for (const byte of forward) {
      this.pending.push({ char: byte, stamp: this.sentBytes, at });
    }
    return Buffer.from(UNDERLINE_ON + forward.toString("latin1") + UNDERLINE_OFF, "latin1");
  }

  /**
   * Filter one chunk of remote output: strip beacon OSCs, retire confirmed predictions, and
   * splice redraws of the still-outstanding ones directly after the frame that overdrew them.
   */
  onOutput(chunk: Buffer): Buffer {
    const data = this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk;
    this.tail = Buffer.alloc(0);

    const parts: Buffer[] = [];
    let emitFrom = 0; // everything before this index is already accounted for
    let searchFrom = 0;
    for (;;) {
      const start = data.indexOf(OSC_PREFIX, searchFrom);
      if (start === -1) break;
      const scan = this.findTerminator(data, start + OSC_PREFIX.length);
      if (scan.kind === "foreign") {
        // Looked like a beacon, is not one: leave the bytes alone and keep scanning after.
        searchFrom = start + OSC_PREFIX.length;
        continue;
      }
      if (scan.kind === "incomplete") {
        if (data.length - start <= MAX_OSC_BYTES) {
          // Might still complete in the next chunk: emit up to it and carry the candidate.
          parts.push(data.subarray(emitFrom, start));
          this.tail = Buffer.from(data.subarray(start));
          return Buffer.concat(parts);
        }
        // Too long to be a beacon; stop treating it as one.
        searchFrom = start + OSC_PREFIX.length;
        continue;
      }
      if (start > emitFrom) {
        parts.push(data.subarray(emitFrom, start));
        this.repainted = true;
      }
      const payload = data.subarray(start + OSC_PREFIX.length, scan.payloadEnd).toString("latin1");
      const beacon = parseBeacon(payload);
      if (beacon !== null) {
        const redraw = this.onBeacon(beacon);
        if (redraw !== null) parts.push(redraw);
      }
      emitFrom = scan.next;
      searchFrom = scan.next;
    }

    // Hold back a bare chunk tail that could still grow into the OSC introducer.
    const held = this.prefixCandidate(data, emitFrom);
    if (held !== null) {
      if (held > emitFrom) this.repainted = true;
      parts.push(data.subarray(emitFrom, held));
      this.tail = Buffer.from(data.subarray(held));
      return Buffer.concat(parts);
    }

    if (data.length > emitFrom) this.repainted = true;
    if (emitFrom === 0 && parts.length === 0) return data;
    parts.push(data.subarray(emitFrom));
    return Buffer.concat(parts);
  }

  /** Forget all speculation (reattach, resize): the next idle beacon re-arms prediction. */
  reset(): void {
    this.pending = [];
    this.offset = null;
    this.focused = false;
    this.pauseUntil = this.sentBytes;
    this.tail = Buffer.alloc(0);
  }

  /** Test/introspection seam. */
  pendingCount(): number {
    return this.pending.length;
  }

  /** The beacon's byte clock translated into sent-byte units. */
  private progress(): number {
    return this.offset === null ? 0 : this.lastBeaconB + this.offset;
  }

  private onBeacon(beacon: Beacon): Buffer | null {
    this.lastBeaconB = beacon.b;
    if (this.now() - this.lastSendAt > IDLE_RESYNC_MS) {
      // Keyboard quiet: nothing is in flight, so the two byte clocks describe the same
      // moment and their difference is the true offset.
      this.offset = this.sentBytes - beacon.b;
    }
    this.focused = beacon.f === 1;
    this.col = beacon.c;

    if (this.offset === null || !this.focused) {
      this.pending = [];
      return null;
    }

    const progress = this.progress();
    const ttlFloor = this.now() - PREDICTION_TTL_MS;
    this.pending = this.pending.filter((p) => p.stamp > progress && p.at > ttlFloor);
    const repainted = this.repainted;
    this.repainted = false;
    if (this.pending.length === 0) return null;
    // A keepalive beacon with no output in front of it repainted nothing: the speculative
    // characters are still on screen, and redrawing them here would duplicate them.
    if (!repainted) return null;

    // The frame that preceded this beacon repainted the composer without the outstanding
    // predictions and parked the cursor where the first of them belongs — redraw them there.
    const chars = Buffer.from(this.pending.map((p) => p.char)).toString("latin1");
    return Buffer.from(UNDERLINE_ON + chars + UNDERLINE_OFF, "latin1");
  }

  /** Scan for the OSC terminator (BEL or ST) at/after `from`. */
  private findTerminator(data: Buffer, from: number): TerminatorScan {
    for (let i = from; i < data.length; i++) {
      const byte = data[i]!;
      if (byte === BEL) return { kind: "found", payloadEnd: i, next: i + 1 };
      if (byte === ESC) {
        if (i + 1 >= data.length) return { kind: "incomplete" };
        return data[i + 1] === 0x5c ? { kind: "found", payloadEnd: i, next: i + 2 } : { kind: "foreign" };
      }
      // Beacon payloads are strictly `b=…;f=…;c=…`; anything outside that alphabet is not ours.
      if (!((byte >= 0x30 && byte <= 0x39) || byte === 0x3b || byte === 0x3d || byte === 0x62 || byte === 0x63 || byte === 0x66)) {
        return { kind: "foreign" };
      }
    }
    return { kind: "incomplete" };
  }

  /**
   * The index where a trailing prefix of the OSC introducer begins, or null when the chunk
   * ends cleanly. Withholding only these few bytes keeps split beacons parseable without
   * ever delaying real output noticeably.
   */
  private prefixCandidate(data: Buffer, from: number): number | null {
    const window = Math.min(OSC_PREFIX.length - 1, data.length - from);
    for (let len = window; len > 0; len--) {
      const start = data.length - len;
      if (start < from) continue;
      if (data.subarray(start).equals(OSC_PREFIX.subarray(0, len))) return start;
    }
    return null;
  }
}
