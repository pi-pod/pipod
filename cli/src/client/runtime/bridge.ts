/**
 * src/client/runtime/bridge.ts — shared state between InteractiveMode's callbacks, the /pod
 * command router, and the session driver (§5.2, §5.4, §6.2).
 *
 * InteractiveMode hands the runtime two things the pi pod host needs to reach later: the
 * extension-UI context (via `session.bindExtensions`) and a shutdown requester. The bridge
 * holds them, plus the one fact every ending path must agree on — what the user asked to
 * happen to the pod on the way out.
 */

export type PodLeaveAction = "keep" | "archive";

/**
 * How the session is ending, decided by whichever path got there first (§6.2).
 *
 *   quit    — the user quit pi (double Ctrl+C, /quit): shutdown frame ⇒ pi_exit ⇒ teardown policy
 *   leave   — /pod detach|archive: pi keeps running; archive changes logical state only
 *   hangup        — SIGHUP/SIGTERM: the client went away; the pod is kept
 *   transportLost — the channel dropped and could not be recovered; the pod is kept
 */
export type EndingIntent =
  | { kind: "quit" }
  | { kind: "leave"; action: PodLeaveAction }
  | { kind: "hangup" }
  | { kind: "transportLost" };

/**
 * A raw terminal-input listener, as pi's TUI defines it: it runs ahead of the focused
 * component, and may consume the keystroke or rewrite the data passed downstream (§3).
 */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/**
 * The slice of pi's ExtensionUIContext the runtime keeps a handle on — captured from
 * `bindExtensions`, used by the extension-UI mapping (§5.3), /pod notices and the chords.
 */
export interface HostUiContext {
  select?(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
  confirm?(title: string, message: string, opts?: unknown): Promise<boolean>;
  input?(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
  editor?(title: string, prefill?: string): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
  setWidget?(
    key: string,
    content: string[] | ((tui: unknown, theme: unknown) => unknown) | undefined,
    options?: unknown,
  ): void;
  setFooter?(factory: ((tui: unknown, theme: unknown, footerData: unknown) => unknown) | undefined): void;
  setHeader?(factory: ((tui: unknown, theme: unknown) => unknown) | undefined): void;
  custom?<T>(
    factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown,
    options?: unknown,
  ): Promise<T>;
  setWorkingMessage?(message?: string): void;
  setWorkingVisible?(visible: boolean): void;
  setWorkingIndicator?(options?: unknown): void;
  setHiddenThinkingLabel?(label?: string): void;
  setToolsExpanded?(expanded: boolean): void;
  setEditorComponent?(factory: ((tui: unknown, theme: unknown, keybindings: unknown) => unknown) | undefined): void;
  setTitle?(title: string): void;
  setEditorText?(text: string): void;
  onTerminalInput?(handler: TerminalInputHandler): () => void;
  /**
   * Wrap the autocomplete provider InteractiveMode built. Pod sessions use this to resolve
   * `@` against the pod's workspace instead of the host's disk (§5.2). Registrations are
   * dropped whenever pi clears its extension UI, so this is re-run on every UI bind.
   */
  addAutocompleteProvider?(factory: (base: never) => unknown): void;
}

export class HostBridge {
  /** Set exactly once, by the first ending path to fire; later writers lose. */
  private endingIntent: EndingIntent | null = null;

  private uiContext: HostUiContext | null = null;
  private uiWaiters: Array<() => void> = [];
  private shutdownHandler: (() => void) | null = null;
  private uiBoundHandler: (() => void) | null = null;
  private readonly uiBoundListeners = new Set<(ui: HostUiContext) => void>();

  get intent(): EndingIntent | null {
    return this.endingIntent;
  }

  /** Record how the session is ending. First writer wins; returns whether it stuck. */
  setIntent(intent: EndingIntent): boolean {
    if (this.endingIntent) return false;
    this.endingIntent = intent;
    return true;
  }

  /** Signals outrank dispose's implicit quit, but never overwrite an explicit pod leave. */
  setHangupIntent(): boolean {
    if (this.endingIntent && this.endingIntent.kind !== "quit") return false;
    this.endingIntent = { kind: "hangup" };
    return true;
  }

  /**
   * Runs on every {@link bindUi}. InteractiveMode drops every listener registered through
   * `onTerminalInput` on session rebind and shutdown, so whatever this wires must expect to
   * be wired again from scratch.
   */
  setOnUiBound(handler: (() => void) | null): void {
    this.uiBoundHandler = handler;
  }

  /** Re-run that hook against the current context, for paths that clear listeners in place. */
  rewireUi(): void {
    this.uiBoundHandler?.();
  }

  /** Captured from `session.bindExtensions` — pi's own dialog/notify/widget surface (§5.3). */
  bindUi(uiContext: HostUiContext, shutdownHandler: (() => void) | null): void {
    this.uiContext = uiContext;
    this.shutdownHandler = shutdownHandler;
    // Chord listeners first: they must exist before a replayed dialog can render over them.
    this.rewireUi();
    for (const listener of this.uiBoundListeners) listener(uiContext);
    const waiters = this.uiWaiters;
    this.uiWaiters = [];
    for (const waiter of waiters) waiter();
    // An ending that arrived before the TUI could register (pi crashing during boot) must
    // still shut the session down — replay it now that someone can act on it.
    if (this.endingIntent && shutdownHandler) shutdownHandler();
  }

  /** Run `cb` once a UI context is bound — immediately when one already is. */
  onUiBound(cb: () => void): void {
    if (this.uiContext) cb();
    else this.uiWaiters.push(cb);
  }

  /** Subscribe to every UI bind, including session replacement; immediately receives a live bind. */
  onEveryUiBound(cb: (ui: HostUiContext) => void): () => void {
    this.uiBoundListeners.add(cb);
    if (this.uiContext) cb(this.uiContext);
    return () => this.uiBoundListeners.delete(cb);
  }

  get ui(): HostUiContext | null {
    return this.uiContext;
  }

  notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    this.uiContext?.notify?.(message, type);
  }

  /**
   * Leave the session via a /pod command (§5.4): record the action, then ask InteractiveMode
   * to shut down cleanly — it restores the terminal and awaits `runtimeHost.dispose()`,
   * where the recorded intent tells dispose to leave pi running.
   */
  requestLeave(action: PodLeaveAction): void {
    this.setIntent({ kind: "leave", action });
    this.requestShutdown();
  }

  requestShutdown(): void {
    this.shutdownHandler?.();
  }

  get canShutdown(): boolean {
    return this.shutdownHandler !== null;
  }
}
