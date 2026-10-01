/**
 * src/client/frames.ts — the wire framing between the launcher and the in-pod shim (§4.1).
 *
 * Newline-delimited frames over the provider PTY channel, in both directions. The first byte
 * selects the type; C/E payloads are base64 so no terminal driver, provider websocket relay,
 * or locale setting can corrupt an 8-bit JSON stream. S payloads are plain ASCII-safe JSON.
 *
 *   client → pod    C <base64(rpc-command-json)>\n    forwarded verbatim to pi stdin
 *   client → pod    S {"cmd":"shutdown"}\n            shim control
 *   pod → client    E <base64(rpc-event-json)>\n      verbatim line from pi stdout
 *   pod → client    S <json>\n                        shim control (hello, pi_exit, pi_stderr)
 *
 * Anything on the channel that is not a well-formed frame is ignored: the PTY may emit a
 * shell banner or stty residue before the shim starts, and a hostile terminal driver may
 * interleave its own bytes. Ignoring garbage on both sides is what makes the framing safe
 * over a channel that is a terminal rather than a pipe.
 */

/** Shim frame protocol revision. Checked in the hello handshake (§4.3). */
export const FRAME_PROTO_VERSION = 1;

export type Frame =
  /** An RPC command line for pi's stdin (client → pod). */
  | { kind: "command"; json: string }
  /** A verbatim line from pi's stdout: response, event, or extension-UI request (pod → client). */
  | { kind: "event"; json: string }
  /** Shim control traffic, either direction. */
  | { kind: "control"; json: string }
  /**
   * A well-framed E line whose payload is not JSON — pi (or a dependency) wrote plain text
   * to stdout. Locally that text would reach the terminal; here it must at least reach the
   * diagnostics, so it is surfaced instead of silently dropped (§12).
   */
  | { kind: "noise"; text: string }
  /**
   * A line that outgrew the decoder's buffer and was abandoned. When its head identified an
   * RPC response, that attribution rides along so the waiting request can fail immediately
   * with the real reason instead of an opaque timeout.
   */
  | { kind: "oversized_line"; bytes: number; response: { command: string | null; id: string | null } | null };

const LF = 0x0a;

/**
 * Longest line the decoder will buffer before declaring it garbage. A real frame is bounded
 * by pi's own line discipline; an unbounded buffer would let a broken channel eat memory.
 */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** How much of an abandoned line's head is decoded to attribute the RPC reply it carried. */
const OVERSIZED_HEAD_BYTES = 512;

export function encodeCommandFrame(json: string): Uint8Array {
  return encode("C", Buffer.from(json, "utf8").toString("base64"));
}

export function encodeEventFrame(json: string): Uint8Array {
  return encode("E", Buffer.from(json, "utf8").toString("base64"));
}

export function encodeControlFrame(json: string): Uint8Array {
  return encode("S", json);
}

function encode(type: string, payload: string): Uint8Array {
  return Buffer.from(`${type} ${payload}\n`, "latin1");
}

/**
 * Splits channel bytes into frames, tolerating partial chunks, merged chunks, and interleaved
 * garbage. Feed it whatever arrives; it returns every complete frame it can prove well-formed
 * and silently drops the rest.
 */
export class FrameDecoder {
  /** Leftover bytes after the last LF, oldest first. No chunk in here contains an LF. */
  private chunks: Buffer[] = [];
  private pendingLen = 0;
  malformedLines = 0;
  noiseLines = 0;
  /** Complete lines seen — the liveness signal for an attach stalled on one unterminated line. */
  decodedLines = 0;
  oversizedLines = 0;

  constructor(private readonly maxLineBytes = MAX_LINE_BYTES) {}

  get pendingBytes(): number {
    return this.pendingLen;
  }

  stats(): { malformedLines: number; noiseLines: number; pendingBytes: number; decodedLines: number } {
    return {
      malformedLines: this.malformedLines,
      noiseLines: this.noiseLines,
      pendingBytes: this.pendingLen,
      decodedLines: this.decodedLines,
    };
  }

  push(chunk: Uint8Array): Frame[] {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    const frames: Frame[] = [];
    let start = 0;
    // Buffered chunks are LF-free by construction, so only the new bytes need searching —
    // this is what keeps a multi-MB line linear instead of re-concatenating per chunk.
    for (;;) {
      const nl = buf.indexOf(LF, start);
      if (nl === -1) break;
      const tail = buf.subarray(start, nl);
      const line = this.chunks.length === 0 ? tail : Buffer.concat([...this.chunks, tail]);
      this.chunks.length = 0;
      this.pendingLen = 0;
      start = nl + 1;
      const frame = decodeLine(line);
      this.decodedLines += 1;
      if (frame) {
        if (frame.kind === "noise") this.noiseLines += 1;
        frames.push(frame);
      } else {
        this.malformedLines += 1;
      }
    }
    if (start < buf.length) {
      // Copied so a caller reusing its read buffer cannot mutate the pending bytes.
      this.chunks.push(Buffer.from(buf.subarray(start)));
      this.pendingLen += buf.length - start;
    }

    // A "line" that never terminates is not a frame; give up on it rather than buffer forever —
    // but say so, attributed when the head shows which RPC reply is being abandoned.
    if (this.pendingLen > this.maxLineBytes) {
      const head = Buffer.concat(this.chunks, Math.min(this.pendingLen, OVERSIZED_HEAD_BYTES + 2));
      frames.push({
        kind: "oversized_line",
        bytes: this.pendingLen,
        response: parseOversizedResponseHead(head),
      });
      this.oversizedLines += 1;
      this.chunks.length = 0;
      this.pendingLen = 0;
    }

    return frames;
  }
}

/**
 * Identify the RPC response inside an abandoned line's head. pi writes the response envelope
 * (id, type, command) ahead of the payload, so the first decoded bytes carry the attribution.
 */
function parseOversizedResponseHead(head: Buffer): { command: string | null; id: string | null } | null {
  if (head.length < 3 || head[0] !== 0x45 /* E */ || head[1] !== 0x20) return null;
  const window = Math.min(head.length - 2, OVERSIZED_HEAD_BYTES);
  const b64 = head.subarray(2, 2 + window - (window % 4)).toString("latin1");
  if (!/^[A-Za-z0-9+/]+$/.test(b64)) return null;
  const json = Buffer.from(b64, "base64").toString("utf8");
  if (!json.includes('"type":"response"')) return null;
  return {
    id: /"id":"([^"\\]*)"/.exec(json)?.[1] ?? null,
    command: /"command":"([^"\\]*)"/.exec(json)?.[1] ?? null,
  };
}
function decodeLine(line: Buffer): Frame | null {
  // Terminal drivers may add a CR before our LF; strip exactly one.
  if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
  if (line.length < 3 || line[1] !== 0x20) return null;

  const type = line[0];
  const payload = line.subarray(2);

  if (type === 0x53 /* S */) {
    const json = payload.toString("utf8");
    return isJsonObject(json) ? { kind: "control", json } : null;
  }

  if (type === 0x43 /* C */ || type === 0x45 /* E */) {
    const b64 = payload.toString("latin1");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
    const json = Buffer.from(b64, "base64").toString("utf8");
    if (!isJsonObject(json)) {
      // The shim frames every pi stdout line; a non-JSON one is real output, not channel
      // garbage. Commands stay strict — one arriving client-side is noise by definition.
      return type === 0x45 && json.length > 0 ? { kind: "noise", text: json } : null;
    }
    return { kind: type === 0x43 ? "command" : "event", json };
  }

  return null;
}

/** Well-formed enough to forward: parses as a JSON object. */
function isJsonObject(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shim control payloads (§4.1, §4.2)
// ---------------------------------------------------------------------------

/** First frame the shim emits once pi is spawned (§4.3). */
export interface ShimHello {
  event: "hello";
  proto: number;
  piVersion: string;
  shimVersion: string;
  /** Absent on shims created before extension version reporting. */
  extensionVersion?: number;
  piRunning: boolean;
  /** Highest journaled agent-event seq (shim v10+). Absent on older hellos. */
  eventSeq?: number;

}

export interface ShimPiExit {
  event: "pi_exit";
  /** null when pi was killed by a signal without an exit status. */
  code: number | null;

}

export interface ShimPiStderr {
  event: "pi_stderr";
  /** base64 chunk of pi's stderr. */
  data: string;

}

/**
 * One appended span of a pod-side session file (§5.6). `offset` 0 means "start this file
 * over" — the resend path for a truncated or rewritten transcript.
 */
export interface ShimMirrorData {
  event: "mirror_data";
  /** Path relative to the pod's ~/.pi/agent/sessions; the client sanitizes before writing. */
  path: string;
  offset: number;
  /** base64 chunk. */
  data: string;

}

/** Current cumulative assistant message, requested only while recovering a renderer. */
export interface ShimStreamSnapshot {
  event: "stream_snapshot";
  message: Record<string, unknown> | null;

}

/** Shim-visible background work after the main turn settled (in-process subagents). */
export interface ShimBackgroundWork {
  event: "background_work";
  active: boolean;
  count: number;

}

/** Unrecoverable hole in the agent-event journal (shim v10 mid-stream, or handshake replay). */
export interface ShimEventReplayGap {
  event: "event_replay_gap";
  fromSeq: number;
  toSeq: number;

}

/** End of a handshake event_replay burst. */
export interface ShimEventReplayEnd {
  event: "event_replay_end";
  lastSeq: number;

}

/**
 * Shim v13's answer to `S {"cmd":"tui_manifest"}`: a disk-fidelity snapshot of the pod's
 * pi config for the launcher's local TUI. `manifest` is deliberately loose here — it is
 * agent-writable data, and the launcher validates it against its own typed schema.
 */
export interface ShimTuiManifest {
  event: "tui_manifest";
  v: number;
  digest: string;
  unchanged?: true;
  manifest?: Record<string, unknown>;
  error?: string;
}

export type ShimControlEvent =
  | ShimHello
  | ShimPiExit
  | ShimPiStderr
  | ShimMirrorData
  | ShimStreamSnapshot
  | ShimBackgroundWork
  | ShimEventReplayGap
  | ShimEventReplayEnd
  | ShimTuiManifest;

/** Client → shim: SIGTERM pi so it exits and reports through the normal pi_exit path (§6.2). */
export interface ShimShutdown {
  cmd: "shutdown";

}

export function parseShimControl(json: string): ShimControlEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  switch (obj["event"]) {
    case "hello":
      if (typeof obj["proto"] !== "number") return null;
      return {
        event: "hello",
        proto: obj["proto"],
        piVersion: String(obj["piVersion"] ?? "unknown"),
        shimVersion: String(obj["shimVersion"] ?? "unknown"),
        ...(typeof obj["extensionVersion"] === "number" &&
          Number.isInteger(obj["extensionVersion"]) &&
          (obj["extensionVersion"] as number) >= 0
          ? { extensionVersion: obj["extensionVersion"] as number }
          : {}),
        piRunning: obj["piRunning"] !== false,
        ...(typeof obj["eventSeq"] === "number" &&
          Number.isInteger(obj["eventSeq"]) &&
          (obj["eventSeq"] as number) >= 0
          ? { eventSeq: obj["eventSeq"] as number }
          : {}),
      };
    case "pi_exit":
      return { event: "pi_exit", code: typeof obj["code"] === "number" ? obj["code"] : null };
    case "pi_stderr":
      return typeof obj["data"] === "string" ? { event: "pi_stderr", data: obj["data"] } : null;
    case "mirror_data":
      return typeof obj["path"] === "string" && typeof obj["offset"] === "number" && typeof obj["data"] === "string"
        ? { event: "mirror_data", path: obj["path"], offset: obj["offset"], data: obj["data"] }
        : null;
    case "stream_snapshot": {
      const message = obj["message"];
      if (message === null || message === undefined) return { event: "stream_snapshot", message: null };
      return typeof message === "object" && !Array.isArray(message)
        ? { event: "stream_snapshot", message: message as Record<string, unknown> }
        : null;
    }
    case "background_work": {
      const count = typeof obj["count"] === "number" ? obj["count"] : obj["active"] === true ? 1 : 0;
      return { event: "background_work", active: count > 0, count };
    }
    case "event_replay_gap": {
      const fromSeq = obj["fromSeq"];
      const toSeq = obj["toSeq"];
      return typeof fromSeq === "number" && typeof toSeq === "number"
        ? { event: "event_replay_gap", fromSeq, toSeq }
        : null;
    }
    case "event_replay_end":
      return typeof obj["lastSeq"] === "number"
        ? { event: "event_replay_end", lastSeq: obj["lastSeq"] }
        : null;
    case "tui_manifest": {
      if (typeof obj["v"] !== "number" || typeof obj["digest"] !== "string") return null;
      const manifest = obj["manifest"];
      return {
        event: "tui_manifest",
        v: obj["v"],
        digest: obj["digest"],
        ...(obj["unchanged"] === true ? { unchanged: true as const } : {}),
        ...(manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
          ? { manifest: manifest as Record<string, unknown> }
          : {}),
        ...(typeof obj["error"] === "string" ? { error: obj["error"] } : {}),
      };
    }
    default:
      return null;
  }

}
