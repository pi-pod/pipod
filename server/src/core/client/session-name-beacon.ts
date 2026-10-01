/** Strip and decode the pod-side session-name beacon from remote-TUI PTY output. */
import { SESSION_NAME_BEACON_OSC_PREFIX } from "../shim/session-name-beacon.js";

const OSC_PREFIX = Buffer.from(SESSION_NAME_BEACON_OSC_PREFIX, "latin1");
const BEL = 0x07;
const ESC = 0x1b;

/** Pi currently caps generated names at 48 characters; leave room for user-supplied Unicode. */
const MAX_NAME_BYTES = 256;
/** Bound an unterminated candidate so arbitrary output cannot be buffered indefinitely. */
const MAX_OSC_BYTES = 512;

type TerminatorScan =
  | { kind: "found"; payloadEnd: number; next: number }
  | { kind: "incomplete" }
  | { kind: "foreign" };

function decodeName(encoded: string): string | null {
  if (encoded.length === 0 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_NAME_BYTES || bytes.toString("base64url") !== encoded) return null;
  try {
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * A streaming PTY-output filter. It handles beacons split across provider chunks, reports valid
 * names synchronously, and never exposes the private control sequence to the user's terminal.
 */
export class SessionNameBeaconFilter {
  private tail: Buffer = Buffer.alloc(0);

  constructor(private readonly onSessionNamed: (name: string) => void = () => {}) {}

  onOutput(chunk: Buffer): Buffer {
    const data = this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk;
    this.tail = Buffer.alloc(0);

    const parts: Buffer[] = [];
    let emitFrom = 0;
    let searchFrom = 0;
    for (;;) {
      const start = data.indexOf(OSC_PREFIX, searchFrom);
      if (start === -1) break;
      const scan = this.findTerminator(data, start + OSC_PREFIX.length);
      if (scan.kind === "foreign") {
        searchFrom = start + OSC_PREFIX.length;
        continue;
      }
      if (scan.kind === "incomplete") {
        if (data.length - start <= MAX_OSC_BYTES) {
          parts.push(data.subarray(emitFrom, start));
          this.tail = Buffer.from(data.subarray(start));
          return Buffer.concat(parts);
        }
        searchFrom = start + OSC_PREFIX.length;
        continue;
      }

      parts.push(data.subarray(emitFrom, start));
      const encoded = data.subarray(start + OSC_PREFIX.length, scan.payloadEnd).toString("latin1");
      const name = decodeName(encoded);
      if (name !== null) {
        try {
          this.onSessionNamed(name);
        } catch {
          // Label mirroring is best-effort and must not interrupt terminal output.
        }
      }
      emitFrom = scan.next;
      searchFrom = scan.next;
    }

    const held = this.prefixCandidate(data, emitFrom);
    if (held !== null) {
      parts.push(data.subarray(emitFrom, held));
      this.tail = Buffer.from(data.subarray(held));
      return Buffer.concat(parts);
    }

    if (emitFrom === 0 && parts.length === 0) return data;
    parts.push(data.subarray(emitFrom));
    return Buffer.concat(parts);
  }

  /** Forget a partial beacon after a PTY reconnect; the old channel cannot complete it. */
  reset(): void {
    this.tail = Buffer.alloc(0);
  }

  private findTerminator(data: Buffer, from: number): TerminatorScan {
    for (let i = from; i < data.length; i++) {
      const byte = data[i]!;
      if (byte === BEL) return { kind: "found", payloadEnd: i, next: i + 1 };
      if (byte === ESC) {
        if (i + 1 >= data.length) return { kind: "incomplete" };
        return data[i + 1] === 0x5c ? { kind: "found", payloadEnd: i, next: i + 2 } : { kind: "foreign" };
      }
      if (!((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f || byte === 0x2d)) {
        return { kind: "foreign" };
      }
    }
    return { kind: "incomplete" };
  }

  private prefixCandidate(data: Buffer, from: number): number | null {
    const window = Math.min(OSC_PREFIX.length - 1, data.length - from);
    for (let len = window; len > 0; len--) {
      const start = data.length - len;
      if (start >= from && data.subarray(start).equals(OSC_PREFIX.subarray(0, len))) return start;
    }
    return null;
  }
}
