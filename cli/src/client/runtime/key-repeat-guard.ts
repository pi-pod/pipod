/**
 * src/client/runtime/key-repeat-guard.ts — one physical key press, one character.
 *
 * Holding a key makes the terminal repeat, and those repeats arrive as ordinary presses.
 * Ghostty's encoder sends every plain-text key — press *and* repeat — as bare UTF-8 and only
 * marks the release (src/input/key_encode.zig: releases are CSI-u, text is written as-is), so
 * `isKeyRepeat` never fires while typing and nothing downstream can tell a repeat from a
 * deliberate second press. In a laggy session that becomes "one press, several characters":
 * the prompt echoes behind the keystrokes, the key stays down past the compositor's repeat
 * delay (Hyprland: 250 ms, then 40/s), and every repeat inserts.
 *
 * The release is the signal that does survive. pi-tui asks for kitty event types, so a key
 * that is still down has not sent its release yet; a text press for a key with no release
 * since is a repeat, and a repeat must not insert. Navigation and deletion keep repeating —
 * this only covers characters that would be inserted, which is the half of key repeat a
 * prompt never needs and a laggy session turns into gibberish.
 *
 * Inert when the terminal reports no releases (legacy encoding): there is nothing to tell a
 * repeat from a press, and guessing would swallow real typing. pi-tui's protocol flag is the
 * activation signal — the terminal answered with event reporting — so the guard covers the
 * session's first held key too, not just ones typed after a release was observed.
 */
import {
  decodeKittyPrintable,
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
} from "@earendil-works/pi-tui";
import type { HostUiContext, TerminalInputHandler } from "./bridge.js";

/** pi-tui's bracketed-paste opener: pasted runs are text, never key repeat. */
const PASTE_START = "\x1b[200~";
const LONE_ESCAPE = "\x1b";
const CONTROL_DELETE = 0x7f;
/**
 * A kitty key event: `<codepoint>[:<shifted>[:<base>]];<modifier>[:<event>]u`. Releases are read
 * straight from the sequence rather than through `decodeKittyPrintable`, which drops the
 * modifier combinations (caps lock, super) a release still has to clear.
 */
const KITTY_KEY_EVENT = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;

/**
 * A key we still believe is down after this long lost its release (focus loss, suspend, a
 * terminal that changed encoding). The next press is a fresh one — better one repeated
 * character than a prompt that ignores a key for the rest of the session.
 */
const STALE_DOWN_MS = 1_500;
/** A keyboard cannot hold more distinct keys than this; bound the map when releases go missing. */
const MAX_DOWN_KEYS = 16;

interface RepeatState {
  /** Codepoint → the last instant we saw that key down. */
  down: Map<number, number>;
  /** Set once a release arrives: proof this terminal reports them, so suppression is safe. */
  releasesSeen: boolean;
}

/** The codepoint of a plain-text press, or undefined when the chunk is not one. */
function textPressCodepoint(data: string): number | undefined {
  // An escape sequence is not text. Exactly one codepoint: an IME commit or a pasted run
  // arrives as several and carries its own semantics — never filter those.
  if (data.length === 0 || data.includes(LONE_ESCAPE)) return undefined;
  const codepoints = [...data];
  if (codepoints.length !== 1) return undefined;
  const codepoint = codepoints[0]!.codePointAt(0)!;
  if (codepoint < 32 || codepoint === CONTROL_DELETE) return undefined;
  return codepoint;
}

/** Every codepoint a release can name: the key itself and, for shifted keys, its unshifted form. */
function releaseCodepoints(data: string): number[] {
  const match = KITTY_KEY_EVENT.exec(data);
  // Group 5 is the event type: 3 = release. Presses and repeats are not releases.
  if (!match || match[5] !== "3") return [];
  return [match[1], match[2]]
    .map((group) => (group === undefined || group === "" ? Number.NaN : Number(group)))
    .filter((codepoint) => Number.isFinite(codepoint) && codepoint >= 32);
}

/**
 * One terminal-input step ahead of the focused component. Returns `{ consume: true }` only for
 * a press the terminal repeated; every other chunk — including releases, which extension
 * surfaces may opt into — continues untouched.
 */
export function repeatGuardInput(
  state: RepeatState,
  data: string,
  now: number,
): { consume: true } | undefined {
  if (data.includes(PASTE_START)) return undefined;

  if (isKeyRelease(data)) {
    state.releasesSeen = true;
    for (const codepoint of releaseCodepoints(data)) state.down.delete(codepoint);
    return undefined;
  }

  // A terminal that marks repeats itself (kitty's "report all keys") saves the inference —
  // but only for inserted text. Backspace and arrows must keep repeating.
  if (isKeyRepeat(data)) {
    return decodeKittyPrintable(data) !== undefined ? { consume: true } : undefined;
  }

  const codepoint = textPressCodepoint(data);
  if (codepoint === undefined) return undefined;

  const seenAt = state.down.get(codepoint);
  if (seenAt !== undefined && now - seenAt <= STALE_DOWN_MS) {
    // Keep the hold alive: a long press must stay suppressed for as long as it lasts.
    state.down.set(codepoint, now);
    const releasesReported = state.releasesSeen || isKittyProtocolActive();
    return releasesReported ? { consume: true } : undefined;
  }

  state.down.set(codepoint, now);
  if (state.down.size > MAX_DOWN_KEYS) {
    for (const [key, at] of state.down) {
      if (now - at > STALE_DOWN_MS) state.down.delete(key);
    }
  }
  return undefined;
}

/**
 * Wire the guard into the bound TUI. Returns an unsubscribe; call it before re-wiring, since
 * `clearExtensionTerminalInputListeners()` drops the listener on every session rebind.
 */
export function wireKeyRepeatGuard(ui: HostUiContext | null | undefined): () => void {
  const subscribe: ((handler: TerminalInputHandler) => () => void) | undefined = ui?.onTerminalInput;
  if (!subscribe) return () => {};
  const state: RepeatState = { down: new Map(), releasesSeen: false };
  return subscribe((data) => repeatGuardInput(state, data, Date.now()));
}
