/**
 * src/client/runtime/stdin-fragment-guard.ts — an incomplete escape fragment is never typed.
 *
 * pi-tui's StdinBuffer splits stdin into whole key sequences; whatever it cannot complete after
 * a short wait is flushed as keyboard input (50 ms for a partial sequence, 10 ms for a lone
 * ESC). That timeout exists so a real Escape key press is not held forever, but it also turns a
 * *fragment* into text: a key release arriving in two pieces types its tail — "3", "u" — at the
 * cursor, and behind a multiplexer a split is routine (measured: tmux forwards a split
 * verbatim). The same window swallows keystrokes that land while an unterminated terminal reply
 * is buffered.
 *
 * At the moment of the flush the distinction is exact: the buffer is either a lone ESC (a key)
 * or an unterminated escape sequence (never a key). Dropping the latter would leave its tail to
 * be typed instead, so the fragment is held for exactly one more read: if the bytes that follow
 * complete a key, the key is delivered as if it had never been split; if they do not, the
 * fragment is discarded and those bytes are read on their own. Bounded by construction — a held
 * fragment never survives the next chunk, so a stray fragment cannot swallow typing. Upstream
 * pi-tui still flushes these fragments (1.4.0 only rescues recognizable terminal *replies*), so
 * a version bump cannot fix it for us.
 *
 * This patches a pinned dependency's class, not our own code: it is deliberately narrow (only
 * the timeout flush and the read that may complete it), feature-detected, applied once, and
 * coupled to pi-tui 1.0.2's StdinBuffer contract. Re-check it on a pi-tui bump (the pin is
 * enforced by `npm run lint`).
 */
import {
  decodeKittyPrintable,
  isKeyRelease,
  isKeyRepeat,
  parseKey,
  StdinBuffer,
} from "@earendil-works/pi-tui";
import { debug } from "../../log.js";

const LONE_ESCAPE = "\x1b";
/** Pasted runs arrive complete; never drop a chunk that carries one. */
const PASTE_START = "\x1b[200~";
/**
 * pi-tui's terminal reassembles these *above* the buffer: a split kitty-flags or DA1 reply is
 * held there for its own window and joined to the next bytes. Leaving them untouched keeps that
 * working — the fragment guard only owns what nothing else would interpret.
 */
const CSI_START = "\x1b[";
const NEGOTIATION_PREFIX = /^\x1b\[\?[\d;]*$/;
/** Set on the patched method so a second import (or a re-wire) cannot double-wrap it. */
const PATCHED = Symbol.for("pi-pod.stdin-fragment-guard");
/** Count of fragments dropped this process — reported only through debug logging. */
let dropped = 0;

/** The fragment a timed-out flush released, waiting for the read that may complete it. */
const held = new WeakMap<StdinBuffer, string>();

type Flush = (this: StdinBuffer) => string[];
type Process = (this: StdinBuffer, data: string | Uint8Array) => void;

/** True when `data` is one complete key, whatever the terminal encoded it as. */
function isKey(data: string): boolean {
  return (
    parseKey(data) !== undefined ||
    decodeKittyPrintable(data) !== undefined ||
    isKeyRelease(data) ||
    isKeyRepeat(data)
  );
}

/**
 * Install the guard once per process. Safe to call from every session start: the prototype is
 * shared by the TUI pi builds and by this launcher, so one patch covers both.
 */
export function guardStdinFragments(): void {
  const prototype = StdinBuffer.prototype as unknown as Record<PropertyKey, unknown> & {
    flush: Flush;
  };
  if (prototype[PATCHED] === true) return;

  const flush = prototype.flush;
  const process = prototype.process;
  if (typeof flush !== "function" || typeof process !== "function") return;
  prototype[PATCHED] = true;
  prototype.flush = function guardedFlush(this: StdinBuffer): string[] {
    return flush.call(this).filter((sequence) => {
      if (!sequence.startsWith(LONE_ESCAPE) || sequence === LONE_ESCAPE) return true;
      if (sequence.includes(PASTE_START)) return true;
      if (sequence === CSI_START || NEGOTIATION_PREFIX.test(sequence)) return true;
      // A complete sequence would have been emitted already; anything here that does not parse
      // is the unterminated remainder the timeout released.
      if (parseKey(sequence) !== undefined) return true;
      held.set(this, sequence);
      return false;
    });
  };

  prototype.process = function guardedProcess(this: StdinBuffer, data: string | Uint8Array): void {
    const fragment = held.get(this);
    if (fragment === undefined) {
      process.call(this, data);
      return;
    }
    held.delete(this);
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    const rejoined = fragment + text;
    if (isKey(rejoined)) {
      process.call(this, rejoined);
      return;
    }
    // The tail never came: drop the fragment, keep the user's bytes intact.
    dropped += 1;
    debug(`stdin fragment guard: dropped ${JSON.stringify(fragment)} (${dropped} this session)`);
    process.call(this, data);
  };
}
