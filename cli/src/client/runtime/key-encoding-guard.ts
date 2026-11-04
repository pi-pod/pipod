/**
 * src/client/runtime/key-encoding-guard.ts — one press, one character, whichever encodings the
 * terminal reports it in.
 *
 * A terminal with the kitty keyboard protocol enabled describes a press on two paths: the key
 * event as a `CSI-u` sequence, and the text the key produced as raw bytes. Normally it uses one
 * or the other per press, and nothing here fires. Some terminals emit *both* for the same press
 * — the case upstream pi fixed for one shape and order in 0.70.4 (#3780, "duplicate printable
 * characters from Kitty keyboard protocol CSI-u plus raw character input on layouts such as
 * Italian"). pi-tui guards against it in `StdinBuffer.emitDataSequence`, which remembers the
 * codepoint of the last CSI-u printable and drops a raw character that repeats it.
 *
 * That recogniser is `parseUnmodifiedKittyPrintableCodepoint`, and it accepts only the bare
 * forms — `ESC[<cp>u`, `ESC[<cp>:<shifted>u`, `ESC[<cp>::<base>u`. Every form carrying a
 * *modifier parameter* is refused, while `decodeKittyPrintable` accepts those (it masks Caps
 * Lock and Num Lock: `KITTY_PRINTABLE_ALLOWED_MODIFIERS = shift | 64 | 128`). So the dedupe
 * silently stops working the moment the terminal puts a lock bit or a layout alternate in that
 * parameter — a Num Lock that is on by default, or the AltGr characters of a non-US layout —
 * and both copies insert: one press, two characters.
 *
 * The guard is fail-open by construction. A duplicate that escapes costs one character; a
 * keystroke spent on a wrong suppression costs the user's intent, and the second is the only
 * failure here that is not instantly visible and recoverable. So it drops a raw character only
 * when all of these hold: a `CSI-u` printable for exactly that character arrived immediately
 * before it; it is the one drop that `CSI-u` is owed (a second matching character is a second
 * press); and it lands within {@link DUPLICATE_WINDOW_MS}, which the two encodings of a single
 * press always meet because the terminal writes them together. A release rearms nothing: it
 * clears the memory instead, so the release event that follows a press can never make the next
 * deliberate press of the same key disappear.
 *
 * Reads and repeats are left alone on purpose. `key-repeat-guard.ts` owns repeats, and a
 * terminal that reports repeats as CSI-u event-type 2 is only deduped against its own text.
 */

import { decodeKittyPrintable, isKeyRelease } from "@earendil-works/pi-tui";
import type { HostUiContext, TerminalInputHandler } from "./bridge.js";

const CONTROL_DELETE = 0x7f;
/**
 * How long the raw half of a dual-encoded press may trail its CSI-u half. Both halves are
 * written by the terminal as one keystroke, so they arrive within a read or two; the window
 * exists only to bound the damage of a terminal that mixes encodings per press — the one way a
 * deliberate press could sit close enough behind a CSI-u to be mistaken for its text.
 */
const DUPLICATE_WINDOW_MS = 50;

interface EncodingState {
  /** The printable a CSI-u just delivered, and when — still owed exactly one raw drop. */
  pending: { char: string; at: number } | undefined;
}

/** The single printable character this chunk carries as plain text, if it is that. */
function rawTextChar(data: string): string | undefined {
  // An escape sequence is not text: the CSI-u half of the pair arrives in this shape.
  if (data.length === 0 || data.includes("\x1b")) return undefined;
  if ([...data].length !== 1) return undefined;
  const codepoint = data.codePointAt(0)!;
  if (codepoint < 32 || codepoint === CONTROL_DELETE) return undefined;
  return data;
}

/**
 * One terminal-input step ahead of the focused component. Consumes only the second encoding of
 * a press the terminal already reported as a key event.
 */
export function encodingGuardInput(
  state: EncodingState,
  data: string,
  now: number,
): { consume: true } | undefined {
  // A release is not a press: it must never arm a drop, or the key's next press would vanish.
  if (isKeyRelease(data)) {
    state.pending = undefined;
    return undefined;
  }

  const char = rawTextChar(data);
  if (char !== undefined) {
    const pending = state.pending;
    state.pending = undefined;
    if (pending !== undefined && pending.char === char && now - pending.at <= DUPLICATE_WINDOW_MS) {
      return { consume: true };
    }
    return undefined;
  }

  // `decodeKittyPrintable` is the editor's own reading of a key event, including the modifier
  // combinations the stock dedupe refuses — which is exactly the gap this guard fills.
  const printable = decodeKittyPrintable(data);
  state.pending = printable === undefined ? undefined : { char: printable, at: now };
  return undefined;
}

/**
 * Wire the guard into the bound TUI. Returns an unsubscribe; call it before re-wiring, since
 * `clearExtensionTerminalInputListeners()` drops the listener on every session rebind.
 *
 * Registered ahead of the repeat guard: the repeat guard consumes CSI-u repeats, and this one
 * needs to see a repeat's key event to recognise the text copy that follows it.
 */
export function wireKeyEncodingGuard(ui: HostUiContext | null | undefined): () => void {
  const subscribe: ((handler: TerminalInputHandler) => () => void) | undefined = ui?.onTerminalInput;
  if (!subscribe) return () => {};
  const state: EncodingState = { pending: undefined };
  return subscribe((data) => encodingGuardInput(state, data, Date.now()));
}
