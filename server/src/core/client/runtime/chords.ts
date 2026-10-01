/**
 * src/client/runtime/chords.ts — `Ctrl-\` prefix chords for the /pod family (§5.4).
 *
 * Pure keystroke aliases: a chord calls `PodCommandRouter.handle("/pod <sub>")`, so it lands
 * in exactly the code path typing the command does. The listener runs in the *local* TUI's
 * input loop, ahead of the focused component, which is what makes a chord fire mid-stream,
 * mid-compaction, with a picker open, or against a wedged pod-side pi — nothing on the chord
 * path crosses the wire until the action itself does.
 *
 * The prefix is only ever *borrowed*: it is consumed on the way in and released verbatim,
 * ahead of the key that followed, the moment that key turns out not to be an ending.
 */
import { isKeyRelease, isKeyRepeat, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { HostBridge } from "./bridge.js";
import { chordHintsFor, podCommandHelp, type PodCommandRouter } from "./pod-commands.js";

export interface ChordConfig {
  enabled: boolean;
  /** pi-tui KeyId, e.g. `ctrl+\`. */
  prefix: string;
  /** Ending KeyId → /pod subcommand. */
  bindings: Record<string, string>;
}

/**
 * How long a lone prefix stays armed. The byte path held 5s because it had to release the
 * prefix to a *remote* pi afterwards; here an expired prefix is dropped (the local editor
 * does nothing with a bare 0x1C, and releasing late would mean injecting input outside a
 * handler return, which pi's API does not offer). The window now only bounds how long the
 * footer hint lingers, so it is shorter.
 */
export const CHORD_WINDOW_MS = 3_000;

/**
 * Wire the chord state machine into the bound TUI. Returns an unsubscribe; call it before
 * re-wiring, since `clearExtensionTerminalInputListeners()` drops the listener on every
 * session rebind and the module must not assume its subscription survived.
 */
export function wirePodChords(
  bridge: HostBridge,
  router: PodCommandRouter,
  config: ChordConfig,
): () => void {
  const hints = chordHintsFor(config);
  const ui = bridge.ui;
  if (!hints || !ui?.onTerminalInput) return () => {};

  const status = [
    hints.prefix,
    Object.entries(hints.endings)
      .map(([sub, key]) => `${key} ${sub}`)
      .concat("? help")
      .join(" · "),
  ].join(" — ");

  let pending: { raw: string; timer: ReturnType<typeof setTimeout> } | null = null;

  const clear = (): void => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
    ui.setStatus?.("pod-chord", undefined);
  };

  const handler = (data: string): { consume?: boolean; data?: string } | undefined => {
    // Key release and repeat events (kitty flag 2) are not presses: one lands between the two
    // chord keys and must neither arm, break, nor release a chord.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;

    if (!pending) {
      if (!matchesKey(data, config.prefix as KeyId)) return undefined;
      const timer = setTimeout(clear, CHORD_WINDOW_MS);
      timer.unref?.();
      pending = { raw: data, timer };
      ui.setStatus?.("pod-chord", status);
      return { consume: true };
    }

    const raw = pending.raw;
    for (const [key, sub] of Object.entries(config.bindings)) {
      if (!matchesKey(data, key as KeyId)) continue;
      clear();
      void router.handle(`/pod ${sub}`).catch((e: unknown) => {
        bridge.notify(`/pod ${sub} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      });
      return { consume: true };
    }
    if (matchesKey(data, "?")) {
      clear();
      bridge.notify(podCommandHelp(hints, router.available()));
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      clear();
      return { consume: true };
    }
    // A second prefix releases exactly one: a chord only ever borrows the prefix it consumed.
    if (matchesKey(data, config.prefix as KeyId)) {
      clear();
      return { data: raw };
    }
    // Anything else: the key goes on untouched and the borrowed prefix is dropped. Releasing
    // both would mean handing the editor one chunk, since a listener rewrites the chunk it was
    // given rather than injecting a second one — and the editor discards any chunk opening with
    // a control byte (`decodePrintableKey` first, then a `>= 32` test), which every modified
    // prefix does. So concatenating loses the key the user actually typed, to release a prefix
    // the editor would have ignored anyway (§5.1).
    clear();
    return undefined;
  };

  router.setChordHints(hints);
  const unsubscribe = ui.onTerminalInput(handler);
  return () => {
    clear();
    router.setChordHints(null);
    unsubscribe();
  };
}
