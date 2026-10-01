/** A single-column marker that distinguishes a pi pod tab from an ordinary Pi session. */
export const POD_TITLE_MARKER = "◉";

/** Preserve the title Pi (or an extension) chose while replacing its ordinary Pi marker. */
export function podTerminalTitle(title: string): string {
  return title.replaceAll("π", POD_TITLE_MARKER);
}

interface TerminalTitleMode {
  ui?: {
    terminal?: {
      setTitle?: (title: string) => void;
    };
  };
}

const patchedTerminals = new WeakSet<object>();

/**
 * Keep every local InteractiveMode retitle pod-branded, including renames and session switches.
 * The raw remote-TUI path is branded by the generated pod extension instead.
 */
export function installPodTerminalTitle(mode: TerminalTitleMode): void {
  const terminal = mode.ui?.terminal;
  if (!terminal || typeof terminal.setTitle !== "function" || patchedTerminals.has(terminal)) return;

  const setTitle = terminal.setTitle.bind(terminal);
  terminal.setTitle = (title) => setTitle(podTerminalTitle(title));
  patchedTerminals.add(terminal);
}
