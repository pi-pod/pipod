/**
 * src/client/tui.ts — the remote-TUI passthrough (§5.7), the default session UI on a terminal.
 *
 * The RPC session runs pi headless in the pod and renders locally, which is what makes
 * /pod commands, the UI journal and the session mirror possible — and what limits
 * extension UI to the nine serializable methods. This mode is the other trade: pi's full
 * TUI runs *in* the pod on a real PTY, the host terminal goes raw, and every byte is
 * forwarded unmodified — so overlay- and pane-shaped extension surfaces (a /btw composer,
 * a subagent fleet view) work exactly as they do locally, at the cost of the launcher's
 * host-side features — which is why `--no-remote-tui` keeps the RPC session available. Ctrl-C is just `\x03` on the wire and reaches the remote pi
 * directly, which is why the launcher installs no SIGINT handler while attached.
 *
 * This is the pre-RPC byte path (src/pty.ts, removed in the §14 cutover), restored behind
 * an explicit flag: the chord detector, kitty CSI-u decoding, terminal restore and the
 * exit-code wrapper are the code that already survived live verification.
 */
import type { SessionNaming } from "../config.js";
import { PiPodError } from "../errors.js";
import { color, debug, warn } from "../log.js";
import type { PtySession, Sandbox } from "../providers/types.js";
import { uploadPodExtension, withPodExtension } from "./pod-extension.js";
import { LocalEchoEngine } from "./local-echo.js";
import { SessionNameBeaconFilter } from "./session-name-beacon.js";
import type { ChordConfig } from "./runtime/chords.js";
import type { SessionEndInput } from "./session.js";

/**
 * Window within which the two chord presses must occur (§8).
 *
 * This is a deadline for a *human* reaching for a second key, not a protocol timeout, and at
 * one second it was routinely missed: press the prefix, pause, press `d`, and the chord had
 * already expired — the launcher then forwarded both bytes, so a literal `d` appeared in pi
 * instead of the session detaching. Nothing announced the expiry, which made it read as the
 * keybinding simply not working.
 *
 * The window is not what keeps an accidental prefix from being swallowed: any non-matching
 * key releases the held prefix immediately, whatever the elapsed time. It only bounds how
 * long a prefix pressed *and then abandoned* is withheld from pi. Paying for that with a
 * chord that misses is the wrong trade, so the bound is generous.
 */
export const DETACH_CHORD_WINDOW_MS = 5000;

/**
 * Put the host terminal back the way pi-pod found it.
 *
 * Every mode here belongs to the *remote* pi, which turned it on by writing an escape sequence
 * that travelled through this process to the user's real terminal. When pi exits it turns each
 * one off again; when the user detaches, the connection drops mid-session and pi never gets
 * the chance — so the modes outlive the session and land on whatever the user does next.
 *
 * The kitty keyboard protocol is the one that makes this impossible to ignore. Left enabled,
 * the shell receives `ESC [ 100 ; 1 : 3 u` where it expected `d`, so ordinary typing arrives at
 * the prompt as visible garbage and the terminal looks broken until it is reset by hand.
 *
 * Every sequence below is a no-op when the mode was never enabled, which is what lets this run
 * unconditionally instead of tracking which of them pi actually asked for.
 */
export const TERMINAL_RESTORE =
  // Kitty keyboard. Pop the entry pi pushed — popping an empty stack is ignored — and then
  // zero the flags of whatever entry is current, which also covers an application that set
  // them in place rather than pushing, and any second entry we did not pop.
  "\x1b[<u\x1b[=0;1u" +
  // Mouse reporting: normal, button-event, any-event tracking, and SGR encoding.
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l" +
  // Bracketed paste, or the next paste into the shell arrives wrapped in `ESC [ 200 ~`.
  "\x1b[?2004l" +
  // Back to the main screen, so pi-pod's parting message and the shell prompt land in real
  // scrollback instead of on top of pi's last frame. Ignored if the main screen is current.
  "\x1b[?1049l" +
  // Cursor visible, no leftover colour.
  "\x1b[?25h\x1b[0m";

/**
 * How long to wait for the terminal to answer the drain query before giving up on it.
 *
 * Only reached on a terminal that does not implement DSR at all; a real one answers in about
 * the time it takes to read the bytes.
 */
const DRAIN_TIMEOUT_MS = 150;

/**
 * Swallow input the terminal produced *before* {@link TERMINAL_RESTORE} reached it.
 *
 * Restoring the modes is necessary but not sufficient. The chord ends on a key press, and under
 * the kitty protocol that key's *release* is reported as a second event — already generated, and
 * on its way here, before this process could write a single byte back. Hand the terminal to the
 * shell without eating it and the user's prompt opens with `00;1:3u` in it: the exact symptom
 * the restore was meant to prevent, from the one keystroke it could never have covered.
 *
 * DSR (`ESC [ 5 n`) is the marker. The terminal answers `ESC [ 0 n` at the point it processes
 * the query, so everything the keyboard produced beforehand already sits ahead of that answer in
 * the stream. Waiting for it drains exactly the backlog and nothing that comes after.
 */
function drainPendingInput(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Promise<void> {
  if (stdin.isTTY !== true) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    // Only the tail can hold a reply split across chunks, and the reply is four bytes.
    let tail = "";

    const stop = () => {
      if (timer) clearTimeout(timer);
      stdin.off("data", onData);
      resolve();
    };

    const onData = (chunk: Buffer) => {
      tail = (tail + chunk.toString("latin1")).slice(-8);
      if (/\x1b\[[0-9]*n/.test(tail)) stop();
    };

    stdin.on("data", onData);
    timer = setTimeout(stop, DRAIN_TIMEOUT_MS);
    stdout.write("\x1b[5n");
  });
}

/** The sandbox states a passthrough can sleep through and wake from (§6.3). */
export type WakeableState = "stopped" | "archived";

export interface TuiWakeOptions {
  /**
   * Bring the sandbox back up and restart its in-pod services. Runs only on user intent —
   * a keystroke — never on the drop itself, so an idle-stopped pod stays stopped until the
   * user actually returns. Throws when the pod cannot come back.
   */
  wakePod: (state: WakeableState) => Promise<void>;
  /** The full wrapper argv for the respawned pi, steering it back into the prior conversation. */
  argv: string[];
}

export interface TuiPassthroughOptions {
  sandbox: Sandbox;
  /** The command to run inside the PTY. Ignored when `session` is supplied. */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** Provider capability `ptyReattach`: whether one in-place reconnect is worth trying. */
  canReattach: boolean;
  /**
   * `pi.chords` (§7). Only the detach-family endings (detach/stop/archive) can act here —
   * list, switch, status and shell need the RPC session — so the rest are left as ordinary
   * input. `enabled: false` unbinds everything and the prefix reaches pi untouched.
   */
  chords?: ChordConfig | undefined;
  /** Where the exit-code wrapper writes `$?` when !capabilities.ptyExitCode (§3.2). */
  exitCodeFile?: string;
  /**
   * An already-open session to drive instead of starting a new one — how `pi-pod attach`
   * rejoins the pi a previous launcher left running (§8).
   */
  session?: PtySession;
  /**
   * Called on every byte of session traffic, in either direction. The lifecycle uses it to
   * keep the provider's idle clock from expiring under a user who is present (§8) — and,
   * just as importantly, to stop keeping it alive the moment they are not.
   */
  onActivity?: () => void;
  /** Reports the PTY session id as soon as the channel exists, for LABEL_PTY (§8). */
  onPtyOpened?: ((sessionId: string) => Promise<void> | void) | undefined;
  /** Reports Pi session names carried by the pod-side metadata beacon. */
  onSessionNamed?: ((name: string) => Promise<void> | void) | undefined;
  /** `pi.localEcho` (§5.7): speculative local echo, driven by the pod-side beacon. */
  localEcho?: boolean | undefined;
  /**
   * Present when a stopped or archived pod can be woken in place (§6.3). Without it, a PTY
   * drop on a non-started pod ends the session as transport lost.
   */
  wake?: TuiWakeOptions | undefined;
  /** Test seam. */
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

export interface TuiPassthroughResult {
  /** Remote pi's exit code, or null when it could not be determined. */
  exitCode: number | null;
  /** True when the user left via a detach chord rather than pi exiting. */
  detached: boolean;
  /**
   * Which chord they left with — i.e. what they asked to happen to the pod (§8). `null` when
   * they did not leave by chord at all, in which case nothing here was requested and the
   * caller's own policy decides.
   */
  detachAction: DetachAction | null;
  /** True when the transport dropped and could not be recovered. */
  transportLost: boolean;
  /**
   * True when the host terminal went away (SIGHUP) or the launcher was asked to stop
   * (SIGTERM). Distinguished from `detached` because the user did not choose it — but the
   * pod is treated identically: left running (§8).
   */
  hungUp: boolean;
  /** Provider session id, so callers can record where to reconnect. */
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Detach chords
// ---------------------------------------------------------------------------

/**
 * What the user asked to happen to the pod as they left (§8).
 *
 * All three chords do the same thing to the *client*: drop the transport and hand the terminal
 * back. They differ in what they leave behind. `keep` is the original chord — walk away, the pod
 * Detach leaves the logical pod active; archive marks it archived without mutating provider state.
 */
export type DetachAction = "keep" | "archive";

/** A chord and what completing it means. */
export interface DetachChord {
  action: DetachAction;
  /** The byte each press produces, from {@link parseDetachSequence}. */
  sequence: number[];
}

/**
 * Parse a chord spec like `"C-] C-]"` into the byte each press produces.
 * `C-<char>` is the control code; a bare character is its own byte.
 */
export function parseDetachSequence(spec: string, setting = "pi.detachSequence"): number[] {
  const tokens = spec.trim().split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) throw new PiPodError(`invalid ${setting}: "${spec}"`);

  return tokens.map((token) => {
    const ctrl = /^(?:C|Ctrl|\^)-?(.)$/i.exec(token);
    if (ctrl) {
      const ch = ctrl[1]!.toUpperCase();
      const code = ch.charCodeAt(0);
      // Ctrl-@ .. Ctrl-_ maps to 0x00..0x1f.
      if (code >= 0x40 && code <= 0x5f) return code - 0x40;
      if (ch === "?") return 0x7f;
      throw new PiPodError(`invalid ${setting} token "${token}": not a control character`);
    }
    if (token.length === 1) return token.charCodeAt(0);
    throw new PiPodError(`invalid ${setting} token "${token}"`, {
      hint: 'use control-key tokens like "C-] C-]"',
    });
  });
}

/**
 * How long an unterminated escape sequence may be held before it is treated as literal input.
 *
 * A lone `Esc` keypress is indistinguishable from the start of a sequence until the next byte
 * arrives, and pi binds Escape to interrupt — holding it until the user happens to type again
 * would be a worse bug than the one this decoder fixes. Terminals emit sequences in a single
 * write, so this only has to cover a chunk boundary, not a human pause.
 */
export const ESCAPE_FLUSH_MS = 50;

/** A single key as it arrived, in whichever encoding the terminal chose. */
export interface KeyEvent {
  /** Exact bytes received, so forwarding stays byte-for-byte faithful. */
  bytes: number[];
  /**
   * The legacy C0/ASCII byte this key denotes, or null when it has none. Matching happens
   * here, which is what lets one chord spec match both encodings.
   */
  legacy: number | null;
  /** kitty event type: 1 press, 2 repeat, 3 release. Legacy input is always a press. */
  event: 1 | 2 | 3;
}

/**
 * `CSI <code> ; <mods> u` → the legacy byte it stands for.
 *
 * Under the kitty keyboard protocol a terminal reports `Ctrl-\` as `ESC [ 92 ; 5 u` rather
 * than `0x1c`, so a detector watching for control bytes never sees the chord at all.
 */
export function decodeCsiU(bytes: number[]): KeyEvent | null {
  const text = String.fromCharCode(...bytes);
  const m = /^\x1b\[([0-9;:]*)u$/.exec(text);
  if (!m) return null;

  const fields = m[1]!.split(";");
  const codepoint = Number.parseInt(fields[0]?.split(":")[0] ?? "", 10);
  if (!Number.isFinite(codepoint)) return null;

  const modField = fields[1]?.split(":") ?? [];
  const mods = (Number.parseInt(modField[0] ?? "1", 10) || 1) - 1;
  const rawEvent = Number.parseInt(modField[1] ?? "1", 10) || 1;
  const event = (rawEvent === 2 || rawEvent === 3 ? rawEvent : 1) as 1 | 2 | 3;

  const ctrl = (mods & 4) !== 0;
  const otherMods = (mods & ~4) !== 0;

  let legacy: number | null = null;
  if (ctrl && !otherMods) {
    // Ctrl-@ .. Ctrl-_ collapse onto 0x00..0x1f; letters fold to their uppercase form.
    const upper = codepoint >= 0x61 && codepoint <= 0x7a ? codepoint - 32 : codepoint;
    if (upper >= 0x40 && upper <= 0x5f) legacy = upper - 0x40;
    else if (codepoint === 0x3f) legacy = 0x7f;
  } else if (mods === 0 && codepoint < 0x80) {
    legacy = codepoint;
  }

  return { bytes, legacy, event };
}

/**
 * Splits raw terminal input into key events, so the chord can be matched on what a key *is*
 * rather than on how this terminal happened to encode it.
 *
 * Sequences it does not understand are emitted opaquely and forwarded untouched — the goal is
 * to recognize the chord, never to normalize the stream pi receives.
 */
export class KeyDecoder {
  private pending: number[] = [];

  push(chunk: Uint8Array): KeyEvent[] {
    const events: KeyEvent[] = [];
    const literal = (b: number) => events.push({ bytes: [b], legacy: b, event: 1 });
    const opaque = (bytes: number[]) => events.push({ bytes, legacy: null, event: 1 });

    for (const byte of chunk) {
      if (this.pending.length === 0) {
        if (byte === 0x1b) this.pending.push(byte);
        else literal(byte);
        continue;
      }

      if (this.pending.length === 1) {
        // ESC [ … (CSI) and ESC O … (SS3) are the two forms worth following; anything else
        // is a bare Escape, released immediately so pi's interrupt keeps working.
        if (byte === 0x5b || byte === 0x4f) {
          this.pending.push(byte);
        } else {
          literal(0x1b);
          this.pending = [];
          if (byte === 0x1b) this.pending.push(byte);
          else literal(byte);
        }
        continue;
      }

      if (this.pending[1] === 0x4f) {
        // SS3 is exactly one more byte.
        this.pending.push(byte);
        opaque(this.pending);
        this.pending = [];
        continue;
      }

      // CSI: parameter and intermediate bytes accumulate; 0x40–0x7e terminates.
      this.pending.push(byte);
      if (byte >= 0x40 && byte <= 0x7e) {
        const seq = this.pending;
        this.pending = [];
        events.push(decodeCsiU(seq) ?? { bytes: seq, legacy: null, event: 1 });
      }
    }

    return events;
  }

  /** True while bytes are held mid-sequence; the caller arms a short timer on this. */
  get partial(): boolean {
    return this.pending.length > 0;
  }

  /** Give up on an unterminated sequence and hand the bytes back verbatim. */
  flush(): number[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

/**
 * Recognizes the chords in a byte stream. A partial match is buffered rather than forwarded,
 * and flushed verbatim if the sequence breaks or the window expires — so a lone `Ctrl-]`
 * still reaches the remote application intact.
 *
 * Several chords are tracked at once, and they are expected to share a prefix: `C-\ d`, `C-\ c`
 * and `C-\ a` are one held prefix and three endings, not three independent bindings. That is why
 * matching is a *set* of surviving candidates rather than a position in one sequence — after the
 * prefix, the pressed key decides which chord (if any) is still live, and everything held is
 * released the moment none of them is.
 */
export class DetachDetector {
  private readonly chords: readonly DetachChord[];
  private readonly windowMs: number;
  private readonly decoder = new KeyDecoder();
  /** Chords still consistent with the keys pressed so far. */
  private candidates: readonly DetachChord[];
  private progress = 0;
  private buffered: number[] = [];
  private firstPressAt = 0;
  private now: () => number;

  /**
   * @param chords One chord per action. A bare byte array is shorthand for a single `keep`
   *               chord, which is all most callers (and every test of the matching itself) want.
   */
  constructor(
    chords: number[] | readonly DetachChord[],
    opts: { windowMs?: number; now?: () => number } = {},
  ) {
    this.chords = normalizeChords(chords);
    this.candidates = this.chords;
    this.windowMs = opts.windowMs ?? DETACH_CHORD_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * @returns `forward` — bytes that should reach the remote PTY, `detach` — whether a chord was
   *          just completed, and `action` — which one, or null when none was.
   */
  push(chunk: Uint8Array): { forward: Uint8Array; detach: boolean; action: DetachAction | null } {
    const forward: number[] = [];
    let action: DetachAction | null = null;

    for (const ev of this.decoder.push(chunk)) {
      if (action !== null) {
        // Everything after a completed chord is discarded: the session is over.
        break;
      }

      // A stalled partial match expires rather than silently swallowing keystrokes.
      if (this.progress > 0 && this.now() - this.firstPressAt > this.windowMs) {
        forward.push(...this.buffered);
        this.reset();
      }

      // Releases and repeats are not presses, and under the kitty protocol a release of the
      // prefix arrives *between* the two chord keys — counting it as a keystroke would break
      // every chord before the second key was ever typed. Buffer it mid-chord so a later
      // flush still replays the stream in order.
      if (ev.event !== 1) {
        if (this.progress > 0) this.buffered.push(...ev.bytes);
        else forward.push(...ev.bytes);
        continue;
      }

      const matched = this.step(ev);
      if (matched === "held") continue;
      if (matched !== null) {
        action = matched;
        continue;
      }

      // Sequence broken: release what we held, then let this key start a chord of its own.
      if (this.progress > 0) {
        forward.push(...this.buffered);
        this.reset();
        const restarted = this.step(ev);
        if (restarted === "held") continue;
        if (restarted !== null) {
          action = restarted;
          continue;
        }
      }
      forward.push(...ev.bytes);
    }

    return { forward: Uint8Array.from(forward), detach: action !== null, action };
  }

  /**
   * Extend the live match with one keypress.
   *
   * @returns the completed action, `"held"` when the key kept a chord alive without finishing
   *          it, or null when it matched nothing — the caller then releases the buffer.
   */
  private step(ev: KeyEvent): DetachAction | "held" | null {
    if (ev.legacy === null) return null;

    const next = this.candidates.filter((c) => c.sequence[this.progress] === ev.legacy);
    if (next.length === 0) return null;

    if (this.progress === 0) this.firstPressAt = this.now();
    this.buffered.push(...ev.bytes);
    this.progress += 1;
    this.candidates = next;

    // Config rejects a chord that is a prefix of another, so at most one can complete here.
    const completed = next.find((c) => c.sequence.length === this.progress);
    if (!completed) return "held";

    this.reset();
    return completed.action;
  }

  /** True while bytes sit mid-escape-sequence, awaiting the rest of the encoding. */
  get partialEscape(): boolean {
    return this.decoder.partial;
  }

  /** Release an unterminated escape sequence verbatim (short-timer path). */
  flushEscape(): Uint8Array {
    return Uint8Array.from(this.decoder.flush());
  }

  /**
   * True while a prefix is being held pending the rest of the chord.
   *
   * `push()` alone cannot decide that a chord was abandoned — it only ever runs when another
   * byte arrives, so a user who presses the prefix and then stops typing would have it held
   * indefinitely. The caller watches this to arm a timer instead.
   */
  get pending(): boolean {
    return this.progress > 0;
  }

  /**
   * Bytes currently held back (flushed when the stream ends).
   *
   * Includes anything stuck mid-escape-sequence, and in that order: the chord buffer was
   * received first, so replaying it first is what keeps the stream faithful.
   */
  flush(): Uint8Array {
    const out = Uint8Array.from([...this.buffered, ...this.decoder.flush()]);
    this.reset();
    return out;
  }

  private reset(): void {
    this.progress = 0;
    this.buffered = [];
    this.firstPressAt = 0;
    this.candidates = this.chords;
  }
}

function normalizeChords(chords: number[] | readonly DetachChord[]): readonly DetachChord[] {
  const list: readonly DetachChord[] =
    chords.length > 0 && typeof chords[0] === "number"
      ? [{ action: "keep", sequence: chords as number[] }]
      : (chords as readonly DetachChord[]);

  // An empty list is a detector that never matches — how `pi.chords.enabled: false` opts a
  // passthrough session out of chords entirely without a second code path.
  if (list.some((c) => c.sequence.length === 0)) {
    throw new PiPodError("a detach chord must have at least one key");
  }
  return list;
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

export async function runTuiPassthrough(opts: TuiPassthroughOptions): Promise<TuiPassthroughResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  const detector = new DetachDetector(chordsFromConfig(opts.chords));

  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;

  let session =
    opts.session ??
    (await opts.sandbox.openPty({
      argv: opts.argv,
      cols,
      rows,
      cwd: opts.cwd,
      env: opts.env,
    }));
  if (!opts.session) await opts.onPtyOpened?.(session.id);

  let settled = false;
  let detached = false;
  let detachAction: DetachAction | null = null;
  let transportLost = false;
  let hungUp = false;
  let reconnectUsed = false;
  let resolveDone: (result: { exitCode: number | null }) => void;
  const done = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    resolveDone({ exitCode });
  };

  // --- terminal wiring ------------------------------------------------------
  const wasRaw = stdin.isRaw === true;
  const canRaw = typeof stdin.setRawMode === "function" && stdin.isTTY === true;
  if (canRaw) stdin.setRawMode(true);
  stdin.resume();

  /**
   * Release a chord prefix the user started and then abandoned.
   *
   * Without this, "a lone prefix still reaches pi intact" is only true if you go on to press
   * something else — press it and stop, and pi never sees it at all. That turns the chord's
   * central promise ("pi keeps the key, we only borrow it") into a lie for exactly the case
   * where it matters: pressing the key on its own.
   */
  // Every output chunk passes through the metadata filter: unlike speculative echo, session-name
  // mirroring is part of every remote-TUI session. The private beacon never reaches the terminal.
  const names = new SessionNameBeaconFilter((name) => {
    if (!opts.onSessionNamed) return;
    void Promise.resolve(opts.onSessionNamed(name)).catch((e) =>
      debug(`could not record the session name: ${e instanceof Error ? e.message : String(e)}`),
    );
  });
  const echo = opts.localEcho === true ? new LocalEchoEngine() : null;

  const forwardToSession = (bytes: Uint8Array) => {
    if (asleep !== null) {
      // A dead PTY cannot hear it; the keystroke's meaning here is "wake the pod" (§6.3).
      wakeNow();
      return;
    }
    session.write(bytes);
    if (echo !== null) {
      const drawn = echo.onInput(Buffer.from(bytes), stdout.columns ?? cols);
      if (drawn !== null && drawn.length > 0) stdout.write(drawn);
    }
  };

  let chordTimer: NodeJS.Timeout | null = null;

  const clearChordTimer = () => {
    if (chordTimer) clearTimeout(chordTimer);
    chordTimer = null;
  };

  const armChordTimer = () => {
    clearChordTimer();
    if (!detector.pending) return;
    chordTimer = setTimeout(() => {
      chordTimer = null;
      const held = detector.flush();
      if (held.length > 0) forwardToSession(held);
    }, DETACH_CHORD_WINDOW_MS + 20);
    chordTimer.unref?.();
  };

  /**
   * Release an escape sequence that never terminated — in practice a bare `Esc` keypress,
   * which is only distinguishable from the start of a sequence by what does not follow it.
   * Far shorter than the chord timer: pi treats Escape as interrupt, so this is latency the
   * user feels directly.
   */
  let escapeTimer: NodeJS.Timeout | null = null;

  const clearEscapeTimer = () => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = null;
  };

  const armEscapeTimer = () => {
    clearEscapeTimer();
    if (!detector.partialEscape) return;
    escapeTimer = setTimeout(() => {
      escapeTimer = null;
      const held = detector.flushEscape();
      if (held.length > 0) forwardToSession(held);
    }, ESCAPE_FLUSH_MS);
    escapeTimer.unref?.();
  };

  // --- asleep / wake-on-intent (§6.3) --------------------------------------
  // The pod idle-stopped (or was archived) under an open terminal. The session is not over:
  // the disk kept pi's session files, so the conversation can continue in place. Waking is
  // strictly intent-driven — the next keystroke wakes it, reconnect probes never do —
  // because waking on anything less would defeat the idle policy the stop came from.
  let asleep: WakeableState | null = null;
  let waking = false;

  const enterSleep = (state: WakeableState) => {
    asleep = state;
    echo?.reset();
    names.reset();
    const what =
      state === "archived"
        ? "was archived while this terminal sat open"
        : "idle-stopped while this terminal sat open";
    const how =
      state === "archived"
        ? "its disk went to cold storage, so waking can take a few minutes"
        : "waking usually takes under a minute";
    stdout.write(
      `\r\n${color.yellow(`pod is asleep — it ${what}`)}\r\n` +
        `${color.dim(`press any key to wake it and continue the conversation (${how}); your detach chord leaves it asleep`)}\r\n`,
    );
  };

  const wakeNow = () => {
    if (waking || settled || asleep === null || !opts.wake) return;
    const from = asleep;
    waking = true;
    stdout.write(`\r\n${color.dim(from === "archived" ? "waking the pod from cold storage…" : "waking the pod…")}\r\n`);
    void (async () => {
      try {
        await opts.wake!.wakePod(from);
        if (settled) return;
        const fresh = await opts.sandbox.openPty({
          argv: opts.wake!.argv,
          cols: stdout.columns ?? cols,
          rows: stdout.rows ?? rows,
          cwd: opts.cwd,
          env: opts.env,
        });
        if (settled) {
          fresh.close();
          return;
        }
        session = fresh;
        asleep = null;
        echo?.reset();
        names.reset();
        wireSession(session);
        onResize();
        await opts.onPtyOpened?.(session.id);
      } catch (e) {
        if (settled) return;
        warn(`could not wake the pod: ${e instanceof Error ? e.message : String(e)}`);
        transportLost = true;
        finish(null);
      } finally {
        waking = false;
      }
    })();
  };

  const onStdin = (chunk: Buffer) => {
    opts.onActivity?.();
    const { forward, action } = detector.push(chunk);
    if (forward.length > 0) forwardToSession(forward);
    if (action !== null) {
      detached = true;
      detachAction = action;
      clearChordTimer();
      clearEscapeTimer();
      // Disconnect only, whatever the chord asked for. The remote pi keeps running and the
      // pod is untouched; what happens to it next is the caller's decision (§8), which is
      // where the unpushed-work report and the stop/archive call live.
      session.close();
      finish(null);
      return;
    }
    armChordTimer();
    armEscapeTimer();
  };

  const onResize = () => {
    // Column geometry changed under the outstanding predictions; forget them.
    echo?.reset();
    session.resize(stdout.columns ?? cols, stdout.rows ?? rows);
  };

  /**
   * The host terminal closed, or something asked the launcher to stop. Both mean "the client
   * went away", which under §8 must never take the pod with it: drop the transport and
   * report it, leaving the remote pi and the pod exactly as they were.
   *
   * Installing these at all is the point — Node's default action for SIGHUP is to terminate
   * the process outright, which would skip the reporting below and leave the user with no
   * record of the pod they can reconnect to.
   */
  const onHangUp = () => {
    if (settled) return;
    hungUp = true;
    session.close();
    finish(null);
  };

  const wireSession = (s: PtySession) => {
    s.onData((data) => {
      opts.onActivity?.();
      const bytes = names.onOutput(Buffer.from(data));
      stdout.write(echo === null ? bytes : echo.onOutput(bytes));
    });
    s.onExit((code) => {
      void handleSessionEnd(code);
    });
  };

  /**
   * A PTY that ends without a reported exit code is ambiguous: on a provider that cannot
   * report status it is the normal ending, and on any provider it can mean the transport
   * went away. The exit-code wrapper is what tells them apart — if it managed to write
   * `$?`, pi really did exit, and reconnecting would be reattaching to nothing (§8, §3.2).
   */
  const handleSessionEnd = async (code: number | null) => {
    if (settled || detached || hungUp) return;

    if (code !== null) {
      finish(code);
      return;
    }

    if (opts.exitCodeFile) {
      const wrapped = await readWrapperExitCode(opts.sandbox, opts.exitCodeFile);
      if (wrapped !== null) {
        finish(wrapped);
        return;
      }
    }

    // What the drop means depends on where the pod is now (§8, §6.3): a started pod gets one
    // in-place reattach; a stopped or archived pod sleeps here and wakes on the next
    // keystroke; anything else means the session is over.
    let state: string;
    try {
      state = await opts.sandbox.state();
    } catch {
      state = "gone";
    }

    if ((state === "stopped" || state === "archived") && opts.wake) {
      enterSleep(state);
      return;
    }

    if (state !== "started" || !opts.canReattach || reconnectUsed || typeof session.reattach !== "function") {
      debug(`pod state is "${state}" after PTY drop — treating as session end`);
      transportLost = true;
      finish(null);
      return;
    }

    reconnectUsed = true;

    warn("PTY transport dropped — reconnecting once…");
    try {
      await session.reattach!();
      echo?.reset();
      names.reset();
      wireSession(session);
      onResize();
      debug("reattached to the running PTY session");
    } catch (e) {
      warn(`reattach failed: ${e instanceof Error ? e.message : String(e)}`);
      // The reattach may have lost to a stop already in progress; a wakeable state still
      // gets the sleep rung rather than a dead terminal.
      let after: string;
      try {
        after = await opts.sandbox.state();
      } catch {
        after = "gone";
      }
      if ((after === "stopped" || after === "archived") && opts.wake) {
        enterSleep(after);
        return;
      }
      transportLost = true;
      finish(null);
    }
  };

  wireSession(session);
  stdin.on("data", onStdin);
  process.on("SIGWINCH", onResize);
  process.on("SIGHUP", onHangUp);
  process.on("SIGTERM", onHangUp);
  onResize();

  let result: { exitCode: number | null };
  try {
    result = await done;
  } finally {
    stdin.off("data", onStdin);
    clearChordTimer();
    clearEscapeTimer();
    process.off("SIGWINCH", onResize);
    process.off("SIGHUP", onHangUp);
    process.off("SIGTERM", onHangUp);
    if (!detached && !hungUp) session.close();

    // Both of these run while the terminal is still in raw mode, and that ordering is the whole
    // point: drop to cooked mode first and the tty driver echoes the backlog to the screen and
    // hands it straight to the shell before anything here can intervene.
    stdout.write(TERMINAL_RESTORE);
    await drainPendingInput(stdin, stdout);

    if (canRaw && !wasRaw) stdin.setRawMode(false);
    stdin.pause();
  }

  let exitCode = result.exitCode;

  // Exit-code wrapper fallback (§3.2, §8). Skipped when the client left rather than pi: the
  // wrapper has not written anything, and reading it would only confirm that.
  if (exitCode === null && opts.exitCodeFile && !detached && !hungUp) {
    exitCode = await readWrapperExitCode(opts.sandbox, opts.exitCodeFile);
  }

  return { exitCode, detached, detachAction, transportLost, hungUp, sessionId: session.id };
}

/**
 * A pi-tui KeyId (`ctrl+\\`, `C-\\`, `d`) as the single legacy byte it denotes, or null for
 * anything this byte path cannot match (multi-character names, chorded modifiers).
 */
export function keyIdByte(keyId: string): number | null {
  const ctrl = /^(?:C-|Ctrl-|\^|ctrl\+)(.)$/i.exec(keyId.trim());
  if (ctrl) {
    const ch = ctrl[1]!.toUpperCase();
    const code = ch.charCodeAt(0);
    if (code >= 0x40 && code <= 0x5f) return code - 0x40;
    if (ch === "?") return 0x7f;
    return null;
  }
  return keyId.length === 1 ? keyId.charCodeAt(0) : null;
}

/**
 * The `pi.chords` config as byte chords. The same prefix and endings the RPC session's
 * chord layer uses (§7), so a user's muscle memory survives the mode switch — but only the
 * leave endings are bound; provider stop is intentionally not user-addressable.
 * can act on. An unrecognizable prefix or ending simply leaves that chord unbound.
 */
export function chordsFromConfig(config: ChordConfig | undefined): DetachChord[] {
  const chords = config ?? {
    enabled: true,
    prefix: "ctrl+\\",
    bindings: { d: "detach", a: "archive" },
  };
  if (!chords.enabled) return [];
  const prefix = keyIdByte(chords.prefix);
  if (prefix === null) return [];
  const out: DetachChord[] = [];
  for (const [key, sub] of Object.entries(chords.bindings)) {
    const action: DetachAction | null = sub === "detach" ? "keep" : sub === "archive" ? "archive" : null;
    if (action === null) continue;
    const ending = keyIdByte(key);
    if (ending === null) continue;
    out.push({ action, sequence: [prefix, ending] });
  }
  return out;
}

export interface SessionCommandOptions {
  /** The pi invocation, unquoted — quoting is this function's job. */
  piArgv: string[];
  /**
   * Where the wrapper records pi's `$?`, for providers that cannot report PTY exit status
   * (§3.2). Omitted when the PTY's own status is trustworthy.
   */
  exitCodeFile?: string | undefined;
  /**
   * Hand the user an interactive shell in the clone when pi exits, naming this chord as the
   * way out that leaves the pod running. Omitted means pi exiting ends the session
   * immediately, which is what a non-interactive run wants.
   */
  shellOnExit?: string | undefined;
}

/**
 * Build the argv the PTY runs: pi, plus whatever has to outlive it.
 *
 * Two things may need to happen after pi returns, and both require a shell wrapped around it.
 * One is recording `$?` where the launcher can read it, for providers that cannot report PTY
 * exit status. The other is the trailing shell (§8): pi exiting is the end of *pi*, not
 * necessarily the end of the work, and dropping straight back to the host leaves a user who
 * has uncommitted changes in the clone with nowhere to push them from. Landing in a shell in
 * the same directory turns that into a normal thing to fix.
 *
 * `exec` is deliberately not used for either. The wrapper has to outlive pi to write the file,
 * and it has to outlive the *shell* so that the status the PTY reports is still pi's — a shell
 * the user closed with `exit` would otherwise overwrite it with its own.
 *
 * With neither asked for there is nothing to wrap, and pi is run directly.
 */
export function buildSessionCommand(opts: SessionCommandOptions): string[] {
  if (opts.exitCodeFile === undefined && opts.shellOnExit === undefined) return [...opts.piArgv];

  const script = [`${opts.piArgv.map(quoteForShell).join(" ")}`, "code=$?"];

  if (opts.exitCodeFile !== undefined) {
    script.push(`printf '%s' "$code" > ${quoteForShell(opts.exitCodeFile)}`);
  }

  if (opts.shellOnExit !== undefined) {
    // Printed remotely, so it cannot go through src/log.ts — the dim SGR is written by hand.
    // `$PWD` rather than a baked-in path: the shell starts wherever pi was, and saying so is
    // the fastest way for a user to tell a resumed clone from a fresh one.
    script.push(
      `printf '\\n\\033[2m-- pi exited (%s). You are now in a shell in %s\\033[0m\\n' "$code" "$PWD"`,
      `printf '\\033[2m   type exit to end the session; press %s to leave the pod running\\033[0m\\n\\n' ` +
        quoteForShell(opts.shellOnExit),
      `"\${SHELL:-/bin/bash}" -l`,
    );
  }

  script.push("exit $code");
  return ["bash", "-lc", script.join("\n")];
}

/** The configured detach chord as a printable hint, or null when chords are off/unmatchable. */
export function detachChordHint(config?: ChordConfig): string | null {
  if (!config) return "Ctrl-\\ d";
  if (!config.enabled || keyIdByte(config.prefix) === null) return null;
  const entry = Object.entries(config.bindings).find(([, sub]) => sub === "detach");
  if (!entry || keyIdByte(entry[0]) === null) return null;
  return `${config.prefix} ${entry[0]}`;
}

/** The attach-time notice for a passthrough session: the leave chords, and what is traded. */
export function tuiChordNotice(config?: ChordConfig): string {
  const chords = config ?? { enabled: true, prefix: "ctrl+\\", bindings: { d: "detach", a: "archive" } };
  const bound = chords.enabled
    ? Object.entries(chords.bindings)
        .filter(([key, sub]) => ["detach", "archive"].includes(sub) && keyIdByte(key) !== null)
        .map(([key, sub]) => `${chords.prefix} ${key} ${sub}s`)
        .join(" · ")
    : "";
  const chordPart = bound.length > 0 ? `${bound} — ` : "";
  return `${chordPart}pi renders in the pod; /pod commands and switch need an RPC session (--no-remote-tui)`;
}

export interface TuiSessionOptions {
  sandbox: Sandbox;
  /** The pi invocation — full TUI, no --mode rpc; the generated extension is added here. */
  piArgv: string[];
  cwd: string;
  env: Record<string, string>;
  canReattach: boolean;
  chords?: ChordConfig | undefined;
  /** Where the wrapper records pi's `$?` (§3.2). */
  exitCodeFile: string;
  /** Embed the remote post-exit shell in the wrapper (`pi.shellOnExit`, §8). */
  shellOnExit: boolean;
  /** `pi.localEcho` (§5.7): include the echo beacon module and predict keystrokes locally. */
  localEcho?: boolean | undefined;
  /** `pi.sessionNaming` — baked into the uploaded extension. */
  sessionNaming?: SessionNaming | undefined;
  /** An already-open PTY to rejoin instead of starting pi (§8); argv is ignored then. */
  session?: PtySession | undefined;
  /**
   * Waking a stopped or archived pod in place (§6.3): `wakePod` brings the sandbox back and
   * restarts its in-pod services; the passthrough then respawns pi with `piArgv`, which must
   * steer pi back into the prior conversation (`--continue` unless the user chose a session).
   */
  wake?: { wakePod: (state: WakeableState) => Promise<void>; piArgv: string[] } | undefined;
  onActivity?: (() => void) | undefined;
  onPtyOpened?: ((sessionId: string) => Promise<void> | void) | undefined;
  onSessionNamed?: ((name: string) => Promise<void> | void) | undefined;
  stdin?: NodeJS.ReadStream | undefined;
  stdout?: NodeJS.WriteStream | undefined;
}

/**
 * Run one passthrough session and report it in the RPC session's ending shape, so the
 * lifecycle's classify/teardown/report path serves both modes unchanged (§5.7).
 *
 * pi exiting under a raw PTY is always the user's own doing — Ctrl-C Ctrl-C, Ctrl-D and
 * /quit all reach pi directly — so `quitRequested` mirrors `piExited`: the post-exit shell
 * is the *wrapper's* job here (it runs in the pod, where the clone is), never the local one.
 */
export async function runTuiSession(opts: TuiSessionOptions): Promise<SessionEndInput> {
  const localEcho = opts.localEcho === true;

  // A fresh raw-TUI Pi receives the same generated extension path as RPC mode, composed with
  // the TUI work/name markers and, when enabled, the local-echo beacon. A rejoin keeps its copy.
  let piArgv = opts.piArgv;
  if (!opts.session) {
    await uploadPodExtension(opts.sandbox, {
      mode: "tui",
      localEcho,
      ...(opts.sessionNaming ? { sessionNaming: opts.sessionNaming } : {}),
    });
    piArgv = withPodExtension(piArgv);
  }

  const hint = detachChordHint(opts.chords);
  const argv = buildSessionCommand({
    piArgv,
    exitCodeFile: opts.exitCodeFile,
    ...(opts.shellOnExit && hint !== null ? { shellOnExit: hint } : {}),
  });
  const wake = opts.wake;
  const wakeOption: TuiWakeOptions | undefined = wake
    ? {
        wakePod: async (state: WakeableState) => {
          await wake.wakePod(state);
          // The respawn must not read an earlier run's status off the kept disk (§3.2), and
          // the pod-side extension may predate this launcher — refresh both while the pod is up.
          await opts.sandbox.exec(["rm", "-f", opts.exitCodeFile], { timeoutMs: 30_000 }).catch(() => {});
          await uploadPodExtension(opts.sandbox, {
            mode: "tui",
            localEcho,
            ...(opts.sessionNaming ? { sessionNaming: opts.sessionNaming } : {}),
          });
        },
        argv: buildSessionCommand({
          piArgv: withPodExtension(wake.piArgv),
          exitCodeFile: opts.exitCodeFile,
          ...(opts.shellOnExit && hint !== null ? { shellOnExit: hint } : {}),
        }),
      }
    : undefined;
  const result = await runTuiPassthrough({
    sandbox: opts.sandbox,
    argv,
    cwd: opts.cwd,
    env: opts.env,
    canReattach: opts.canReattach,
    chords: opts.chords,
    exitCodeFile: opts.exitCodeFile,
    ...(wakeOption ? { wake: wakeOption } : {}),
    localEcho,
    session: opts.session,
    onActivity: opts.onActivity,
    onPtyOpened: opts.onPtyOpened,
    onSessionNamed: opts.onSessionNamed,
    stdin: opts.stdin,
    stdout: opts.stdout,
  });
  const over = !result.detached && !result.hungUp && !result.transportLost;
  return {
    piExited: over,
    quitRequested: over,
    exitCode: result.exitCode,
    detached: result.detached,
    detachAction: result.detachAction,
    hungUp: result.hungUp,
    transportLost: result.transportLost,
    sessionId: result.sessionId,
    stderrTail: "",
  };
}


/** Single-quote an argv entry for embedding in the wrapper script. */
export function quoteForShell(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function readWrapperExitCode(sandbox: Sandbox, file: string): Promise<number | null> {
  try {
    const res = await sandbox.exec(["cat", file]);
    if (res.exitCode !== 0) return null;
    const parsed = Number((res.output ?? "").trim());
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
