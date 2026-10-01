/**
 * src/client/session.ts — drive one pod's pi session over RPC (§5, §6).
 *
 * The client side of the wire: upload the shim, open the PTY channel it frames over,
 * handshake, then either hand pi's real InteractiveMode a RemoteAgentSessionRuntime (TTY) or
 * feed the same RemoteRpcClient to the headless line renderer (§5.5). Policy — what an
 * ending means for the pod — stays with the caller; this module returns the facts (who
 * ended it, and what they said on the way out).
 */
import { DEFAULT_CONFIG, type SessionNaming } from "../config.js";
import { PiPodError } from "../errors.js";
import { debug, warn } from "../log.js";
import type { PtySession, Sandbox } from "../providers/types.js";
import {
  PREVIOUS_SHIM_VERSION,
  SHIM_LOG_PATH,
  SHIM_PATH,
  SHIM_VERSION,
  buildAgentdScript,
} from "../shim/agentd.js";
import { POD_EXTENSION_VERSION } from "../shim/pi-pod-ext.js";
import { FRAME_PROTO_VERSION, type ShimHello } from "./frames.js";
import { runHeadless, tuiModeFromArgv } from "./headless.js";
import { wireSessionMirror, type SessionMirror } from "./mirror.js";
import { bundledPiVersion, comparePiVersions, describeVersionSkew } from "./piversion.js";
import { uploadPodExtension, withPodExtension } from "./pod-extension.js";
import { installPodTerminalTitle } from "./pod-title.js";
import { RemoteRpcClient, type RpcClientBase } from "./rpc.js";
import { HostBridge } from "./runtime/bridge.js";
import type { ChordConfig } from "./runtime/chords.js";
import { wireExtensionUi } from "./runtime/extension-ui.js";
import type { PodCommandHost } from "./runtime/pod-commands.js";
import { createRemoteRuntime, quitPi, type RemoteRuntime } from "./runtime/remote-runtime.js";
import { runRawShell } from "./shell.js";

export { withPodExtension } from "./pod-extension.js";

/** The facts of an ended session — classifySessionEnd's input shape, plus diagnostics. */
export interface SessionEndInput {
  piExited: boolean;
  /** The local user closed pi with Ctrl-C Ctrl-C, Ctrl-D, or /quit. */
  quitRequested: boolean;
  exitCode: number | null;
  detached: boolean;
  detachAction: "keep" | "archive" | null;
  hungUp: boolean;
  transportLost: boolean;
  /** Provider PTY session id, for LABEL_PTY. */
  sessionId: string;
  /** Tail of pi's stderr for crash reports (§12). */
  stderrTail: string;
}

export interface RpcSessionOptions {
  sandbox: Sandbox;
  /** The pi invocation (no shell wrapper — the shim spawns it with plain pipes, §4.2). */
  piArgv: string[];
  /** Pod-side working directory (the clone). */
  cwd: string;
  env: Record<string, string>;
  /** Host-side working directory — settings and file autocomplete (§5.2). */
  hostCwd: string;
  onActivity?: (() => void) | undefined;
  /** Sustained provider heartbeat lease while pi has an agent run or compaction in flight. */
  onWorkStateChange?: ((busy: boolean) => void) | undefined;
  podHost?: PodCommandHost | undefined;
  /** Where the shim records pi's `$?` for the transport-drop fallback (§4.2). */
  exitCodeFile: string;
  /** An already-open shim channel to rejoin instead of launching (§6.3). */
  session?: PtySession | undefined;
  /** Reports the PTY session id as soon as the channel exists, for LABEL_PTY. */
  onPtyOpened?: ((sessionId: string) => Promise<void> | void) | undefined;
  /**
   * Reports the session's name every time it changes, for LABEL_NAME (§5.4).
   *
   * The callback owns which pod it writes to: after a /pod switch the TUI is driving a
   * different sandbox than the one this session started on.
   */
  onSessionNamed?: ((name: string) => Promise<void> | void) | undefined;
  /** `pi.sessionNaming` — baked into the uploaded pod extension (§5.4). */
  sessionNaming?: SessionNaming | undefined;
  /** Positional startup prompt, submitted over RPC after the selected renderer is ready. */
  startupPrompt?: string | undefined;
  /** Enables /pod list and /pod switch (§6.4); absent means they refuse honestly. */
  switchHost?: SwitchHost | undefined;
  /** Chord keybindings for the /pod family (§7); absent means the defaults. */
  chords?: ChordConfig | undefined;
  helloTimeoutMs?: number;
  /** Resolved `pi.clientExtensions` paths, run by the launcher instead of the pod (§5.2). */
  clientExtensionPaths?: string[] | undefined;
  /** Test seams. */
  stdin?: NodeJS.ReadStream | undefined;
  stdout?: NodeJS.WriteStream | undefined;
  stderr?: NodeJS.WriteStream | undefined;
}

/** The client waits this long for the shim's hello before declaring the pod pre-RPC (§4.3). */
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

interface PiWorkTracker {
  /** Seed from get_state, forcing the current pod's heartbeat to receive the lease. */
  seed(isStreaming: boolean, isCompacting: boolean, force?: boolean): void;
  dispose(): void;
}

/** Turn pi's semantic work events into one sustained provider-heartbeat lease (§8). */
function wirePiWorkTracker(rpc: RpcClientBase, report: ((busy: boolean) => void) | undefined): PiWorkTracker {
  let agentActive = false;
  let compactionActive = false;
  let busy = false;

  const sync = (force = false): void => {
    const next = agentActive || compactionActive;
    if (!force && next === busy) return;
    busy = next;
    report?.(busy);
  };

  const offEvent = rpc.onEvent((event) => {
    const type = (event as { type?: string }).type;
    if (type === "agent_start") agentActive = true;
    else if (type === "agent_settled") agentActive = false;
    else if (type === "compaction_start") compactionActive = true;
    else if (type === "compaction_end") compactionActive = false;
    else return;
    sync();
  });
  const offControl = rpc.onControl((event) => {
    if (event.event !== "pi_exit") return;
    agentActive = false;
    compactionActive = false;
    sync();
  });

  return {
    seed: (isStreaming, isCompacting, force = false) => {
      agentActive = isStreaming;
      compactionActive = isCompacting;
      sync(force);
    },
    dispose: () => {
      offEvent();
      offControl();
    },
  };
}

// ---------------------------------------------------------------------------
// Multi-pod session management (§6.4)
// ---------------------------------------------------------------------------

export interface PodListEntry {
  id: string;
  /** One picker line: id, repo@branch, state, and what selecting it costs. */
  label: string;
}

/** Everything the client needs to move the TUI onto another pod (§6.4). */
export interface SwitchTarget {
  podId: string;
  sandbox: Sandbox;
  workdir: string;
  project: string;
  env: Record<string, string>;
  /** Fresh-start argv for rung 2 (--continue included by the host). */
  piArgv: string[];
  /** Naming policy for a fresh rung-2 Pi process. */
  sessionNaming?: SessionNaming | undefined;
  /** Recorded PTY session id, when a live shim may be waiting (rung 1). */
  ptySessionId?: string | undefined;
}

/**
 * The provider-control-plane half of switching, supplied by the launcher: the client is a
 * session manager, but pods are still the host's to list, start and account for (§5.4).
 */
export interface SwitchHost {
  /** Same scope and lastActivityAt ordering as `pi-pod list` (§6.4). */
  listPods(): Promise<PodListEntry[]>;
  /** Resolve an id to a started pod, or null. Expected to start a stopped pod (§6.3 rung 2). */
  resolveTarget(id: string): Promise<SwitchTarget | null>;
  /** Atomically commit the target, then persist its PTY label. Must not reject. */
  onSwitched(previousPodId: string, target: SwitchTarget, ptySessionId: string): Promise<void>;
}

/** A verified target channel and the hello consumed during its isolated handshake. */
export interface VerifiedPodConnection {
  channel: PtySession;
  hello: ShimHello;
}

/**
 * Reach a pod's shim: rung 1 rejoins the recorded PTY session, rung 2 uploads the shim and
 * starts `pi --mode rpc --continue` fresh. The probe is retired after verification so its
 * irreversible provider callback remains subscribed but inert.
 */
export async function connectToPod(
  target: SwitchTarget,
  exitCodeFile: string,
  helloTimeoutMs: number,
): Promise<VerifiedPodConnection> {
  let channel: PtySession | null = null;
  let rejoined = false;

  if (target.ptySessionId && typeof target.sandbox.reconnectPty === "function") {
    channel = await target.sandbox
      .reconnectPty(target.ptySessionId, { cols: 80, rows: 24 })
      .catch(() => null);
    rejoined = channel !== null;
  }
  if (!channel) {
    await uploadShim(target.sandbox, exitCodeFile, target.sessionNaming);
    channel = await target.sandbox.openPty({
      argv: shimArgv(target.piArgv),
      cols: 80,
      rows: 24,
      cwd: target.workdir,
      env: target.env,
    });
  }

  const probe = new RemoteRpcClient({ channel });
  try {
    const hello = await probe.ensureHello(helloTimeoutMs, { discardCached: rejoined });
    verifyHello(hello, channel);
    probe.retireChannel();
    return { channel, hello };
  } catch (e) {
    probe.retireChannel();
    channel.close();
    throw e;
  }
}

export interface CurrentPodConnection {
  session: PtySession;
  sandbox: Sandbox;
  podId: string;
  workdir: string;
  env: Record<string, string>;
}

/**
 * Commit a verified switch as one RPC/cache/lifecycle transaction. The previous PTY remains
 * open until the target cache is complete, making every pre-lifecycle failure rollback-safe.
 */
export async function commitVerifiedPodSwitch(args: {
  current: CurrentPodConnection;
  rpc: RemoteRpcClient;
  connection: VerifiedPodConnection;
  target: SwitchTarget;
  host: SwitchHost;
  refresh: () => Promise<void>;
  installRecovery: (channel: PtySession, sandbox: Sandbox) => void;
  syncWorkState?: (() => void) | undefined;
  render?: (() => void) | undefined;
}): Promise<void> {
  const { current, rpc, connection, target } = args;
  const previous = { ...current };
  const previousHello = rpc.helloInfo;
  const { channel, hello } = connection;
  const render = () => {
    try { args.render?.(); } catch { /* rendering is cosmetic and never rolls back lifecycle */ }
  };

  current.session = channel;
  current.sandbox = target.sandbox;
  current.podId = target.podId;
  current.workdir = target.workdir;
  current.env = target.env;
  rpc.resetPodState();
  rpc.rebindChannel(channel, hello);
  args.installRecovery(channel, target.sandbox);

  try {
    await args.refresh();
    await args.host.onSwitched(previous.podId, target, channel.id);
    args.syncWorkState?.();
    try { previous.session.close(); } catch { /* the retired generation is already inert */ }
    render();
  } catch (error) {
    current.session = previous.session;
    current.sandbox = previous.sandbox;
    current.podId = previous.podId;
    current.workdir = previous.workdir;
    current.env = previous.env;
    rpc.resetPodState();
    rpc.rebindChannel(previous.session, previousHello ?? undefined);
    channel.close();
    await args.refresh().catch(() => {});
    args.syncWorkState?.();
    render();
    throw error;
  }
}


/**
 * Per-instance runtime file overrides for pods that share a machine (the host provider).
 * Absent fields keep the historical /tmp constants.
 */
export interface ShimPathOverrides {
  shim?: string;
  shimLog?: string;
  agentdPid?: string;
  agentdReady?: string;
  turnMarker?: string;
  podExt?: string;
}

/** Upload the RPC transport shim and this process's one generated Pi extension. */
export async function uploadShim(
  sandbox: Sandbox,
  exitCodeFile: string,
  sessionNaming?: SessionNaming,
  paths?: ShimPathOverrides,
): Promise<void> {
  const script = buildAgentdScript({
    exitCodeFile,
    extensionVersion: POD_EXTENSION_VERSION,
    ...(paths?.shimLog !== undefined ? { logFile: paths.shimLog } : {}),
    ...(paths?.agentdPid !== undefined ? { pidFile: paths.agentdPid } : {}),
    ...(paths?.agentdReady !== undefined ? { readyFile: paths.agentdReady } : {}),
    ...(paths?.turnMarker !== undefined ? { turnMarkerPath: paths.turnMarker } : {}),
  });
  await sandbox.uploadFile(paths?.shim ?? SHIM_PATH, new TextEncoder().encode(script));
  await uploadPodExtension(
    sandbox,
    { mode: "rpc", ...(sessionNaming ? { sessionNaming } : {}) },
    paths?.podExt,
  );
}

/** The argv the PTY runs: the shim wrapping `pi --mode rpc -e <ext>` (§4.2, §6.1). */
export function shimArgv(piArgv: string[]): string[] {
  return ["node", SHIM_PATH, "--", ...withRpcMode(withPodExtension(piArgv))];
}

/** The detached supervisor argv; its data path is the pod's outbound WebSocket. */
export function daemonShimArgv(piArgv: string[], paths?: ShimPathOverrides): string[] {
  return [
    "node",
    paths?.shim ?? SHIM_PATH,
    "--daemon",
    "--",
    ...withRpcMode(withPodExtension(piArgv, paths?.podExt)),
  ];
}


/** Force pi's documented headless mode (§1); a caller-supplied --mode wins. */
export function withRpcMode(piArgv: string[]): string[] {
  if (piArgv.includes("--mode")) return [...piArgv];
  const [command, ...rest] = piArgv;
  return [command!, "--mode", "rpc", ...rest];
}

/** Match pi's CLI precedence: the last explicit --models value overrides enabledModels. */
export function modelPatternsFromArgv(piArgv: string[]): string[] | undefined {
  let patterns: string[] | undefined;
  for (let i = 1; i < piArgv.length; i++) {
    if (piArgv[i] !== "--models" || i + 1 >= piArgv.length) continue;
    patterns = piArgv[++i]!.split(",").map((pattern) => pattern.trim());
  }
  return patterns;
}

/**
 * The pod's own enabledModels patterns (§5.2). RPC 0.82.1 exposes no scoped-model list, so
 * without this read the scope seed would come from the host's settings — a different
 * machine's opinion. Best-effort: a pod without the file, or a provider hiccup, returns
 * undefined and the caller falls back to host settings, which is yesterday's behavior.
 */
export async function readPodModelPatterns(sandbox: Sandbox): Promise<string[] | undefined> {
  try {
    const result = await sandbox.exec(
      ["sh", "-c", 'cat "$HOME/.pi/agent/settings.json" 2>/dev/null'],
      { timeoutMs: 5000 },
    );
    const text = result.output?.trim();
    if (result.exitCode !== 0 || !text?.startsWith("{")) return undefined;
    const parsed = JSON.parse(text) as { enabledModels?: unknown };
    const patterns = parsed.enabledModels;
    return Array.isArray(patterns) && patterns.length > 0 && patterns.every((p) => typeof p === "string")
      ? (patterns as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Track the highest journal podSeq this client has received, so a reconnect can ask the
 * shim for exactly the fire-and-forget extension-UI frames the transport gap dropped
 * (§5.3). `replayAll` is the fresh-attach/pod-switch form: nothing was seen, ask from 0.
 */
export function wireUiReplay(rpc: RemoteRpcClient): { replayMissed(): void; replayAll(): void } {
  let maxSeq = 0;
  rpc.onEvent((event) => {
    const msg = event as { type?: string; podSeq?: number };
    if (msg.type !== "extension_ui_request") return;
    if (typeof msg.podSeq === "number" && msg.podSeq > maxSeq) maxSeq = msg.podSeq;
  });
  return {
    replayMissed: () => rpc.requestUiReplay(maxSeq),
    replayAll: () => {
      maxSeq = 0;
      rpc.requestUiReplay(0);
    },
  };
}

export async function runRpcSession(opts: RpcSessionOptions): Promise<SessionEndInput> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  let session: PtySession;
  if (opts.session) {
    session = opts.session;
  } else {
    await uploadShim(opts.sandbox, opts.exitCodeFile, opts.sessionNaming);
    session = await opts.sandbox.openPty({
      argv: shimArgv(opts.piArgv),
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: opts.env,
    });
  }
  await opts.onPtyOpened?.(session.id);

  const rpc = new RemoteRpcClient({
    channel: session,
    ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
  });
  const work = wirePiWorkTracker(rpc, opts.onWorkStateChange);
  const uiReplay = wireUiReplay(rpc);
  const mirror = wireSessionMirror({ rpc, podId: opts.sandbox.id });

  // The name is pi's to decide and the pod's to remember; the host only mirrors it onto a
  // label so `pi-pod list` and `pi-pod attach <name>` can see it (§9). One listener covers
  // the interactive and headless renderers, and survives a /pod switch rebinding the channel.
  if (opts.onSessionNamed) {
    const report = opts.onSessionNamed;
    rpc.onEvent((event) => {
      if ((event as { type?: string }).type !== "session_info_changed") return;
      const name = (event as { name?: string }).name;
      if (name === undefined) return;
      void Promise.resolve(report(name)).catch((e) => debug(`could not record the session name: ${String(e)}`));
    });
  }

  // --- handshake (§4.3) -----------------------------------------------------
  // A rejoined channel missed the startup hello, so ask the live shim for one; a fresh
  // launch just waits for it.
  const helloTimeout = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  let hello;
  try {
    hello = await rpc.ensureHello(helloTimeout, { discardCached: opts.session !== undefined });
  } catch {
    session.close();
    throw new PiPodError("the pod did not answer the pi-pod handshake", {
      hint:
        "this pod is probably running a session from an older pi-pod (raw-TUI, pre-RPC).\n" +
        `exit that Pi session or wait for automatic idle retention, then attach again.\n` +
        `shim log, if any: ${SHIM_LOG_PATH} in the pod`
    });
  }
  verifyHello(hello, session);
  debug(
    `shim hello: proto ${hello.proto}, pi ${hello.piVersion}, shim ${hello.shimVersion}, ` +
      `extension ${hello.extensionVersion ?? "unversioned"}`,
  );

  // Opt in to the session mirror (§5.6) as soon as the channel is proven, declaring what
  // this machine already holds so a reattach streams only the gap.
  mirror.sync();

  const interactive = stdin.isTTY === true && stdout.isTTY === true;
  try {
    return await (interactive
      ? runInteractive(opts, session, rpc, helloTimeout, work, uiReplay, mirror, opts.session !== undefined)
      : runHeadlessSession(opts, session, rpc, stdout, work, mirror));
  } finally {
    mirror.dispose();
    work.dispose();
    opts.onWorkStateChange?.(false);
  }
}

// ---------------------------------------------------------------------------
// Interactive: pi's real InteractiveMode over the remote runtime (§5.2)
// ---------------------------------------------------------------------------

async function runInteractive(
  opts: RpcSessionOptions,
  initialSession: PtySession,
  rpc: RemoteRpcClient,
  helloTimeout: number,
  work: PiWorkTracker,
  uiReplay: ReturnType<typeof wireUiReplay>,
  mirror: SessionMirror,
  reattached: boolean,
): Promise<SessionEndInput> {
  // Everything per-pod lives in this holder: /pod switch (§6.4) replaces it wholesale, and
  // every closure below reads the current pod through it rather than capturing one.
  const current = {
    session: initialSession,
    sandbox: opts.sandbox,
    podId: opts.sandbox.id,
    workdir: opts.cwd,
    env: opts.env,
  };

  // /pod shell suspends the TUI, runs a raw passthrough, and resumes (§5.4). The TUI
  // instance exists only after the runtime does, so the hook is late-bound.
  let modeUi: { stop(): void; start(): void; requestRender?(force?: boolean): void } | null = null;
  let modeEditor: { setText(text: string): void } | null = null;
  let notifyUi: (message: string, type?: "info" | "warning" | "error") => void = () => {};

  const podHost: PodCommandHost = {
    ...(opts.podHost ?? {}),
    shell: async () => {
      if (!modeUi) {
        notifyUi("/pod shell is not available yet", "warning");
        return;
      }
      // Release the TUI's grip on the terminal, then clear the last frame locally. The
      // remote openPty also clears, but that output races the onData subscription and is
      // often lost — without a host-side clear the frozen TUI stays on screen over the shell.
      modeUi.stop();
      try {
        (opts.stdout ?? process.stdout).write("\x1b[2J\x1b[H");
        await runRawShell({
          sandbox: current.sandbox,
          cwd: current.workdir,
          env: current.env,
          ...(opts.stdin ? { stdin: opts.stdin } : {}),
          ...(opts.stdout ? { stdout: opts.stdout } : {}),
        });
      } finally {
        modeUi.start();
        modeUi.requestRender?.(true);
      }
    },
    ...(opts.switchHost
      ? {
          list: async () => switchPod(undefined),
          switchPod: async (id?: string) => switchPod(id),
        }
      : {}),
  };

  let resolveEnding!: (ending: SessionEndInput) => void;
  const endingPromise = new Promise<SessionEndInput>((resolve) => {
    resolveEnding = resolve;
  });
  let ending: SessionEndInput | null = null;
  let switchTransaction: Promise<void> | null = null;

  const runtime: RemoteRuntime = createRemoteRuntime({
    rpc,
    cwd: opts.hostCwd,
    modelPatterns: modelPatternsFromArgv(opts.piArgv),
    getPodModelPatterns: () => readPodModelPatterns(current.sandbox),
    podHost,
    clientExtensionPaths: opts.clientExtensionPaths,
    onPodCommandSubmit: () => {
      modeEditor?.setText("");
      modeUi?.requestRender?.();
    },
    onEnding: async (runtimeEnding) => {
      if (ending) return;
      if (switchTransaction) await switchTransaction.catch(() => {});
      if (runtimeEnding.intent.kind !== "quit") current.session.close();
      ending = {
        piExited: runtimeEnding.intent.kind === "quit",
        quitRequested: runtimeEnding.quitRequested,
        exitCode: runtimeEnding.exitCode,
        detached: runtimeEnding.intent.kind === "leave",
        detachAction: runtimeEnding.intent.kind === "leave" ? runtimeEnding.intent.action : null,
        hungUp: runtimeEnding.intent.kind === "hangup",
        transportLost: runtimeEnding.intent.kind === "transportLost",
        sessionId: current.session.id,
        stderrTail: runtimeEnding.stderrTail,
      };
      resolveEnding(ending);
    },
  });

  const { bridge } = runtime;
  let connectionStatus = "pod connected";
  const setConnectionStatus = (text: string) => {
    connectionStatus = text;
    bridge.ui?.setStatus?.("pod-connection", text);
  };
  bridge.onEveryUiBound((ui) => ui.setStatus?.("pod-connection", connectionStatus));
  notifyUi = (message, type) => bridge.notify(message, type);
  const initialCompatibilityWarnings = [
    shimCompatibilityWarning(rpc.helloInfo?.shimVersion ?? ""),
    extensionCompatibilityWarning(rpc.helloInfo?.extensionVersion),
  ].filter((message): message is string => message !== null);
  if (initialCompatibilityWarnings.length > 0) {
    bridge.onUiBound(() => {
      for (const message of initialCompatibilityWarnings) bridge.notify(message, "warning");
    });
  }

  // The client going away must never take the pod with it (§6.2). This listener is moved
  // ahead of InteractiveMode's prependListeners immediately after mode.run() registers them.
  const onHangUp = () => bridge.setHangupIntent();

  // pi exiting on its own (crash, one-shot done) ends the session through the same funnel.
  rpc.onControl((event) => {
    if (event.event === "pi_exit") {
      bridge.setIntent({ kind: "quit" });
      bridge.requestShutdown();
    }
  });

  const wireRecovery = (channel: PtySession, sandbox: Sandbox): void => {
    wireChannelRecovery({
      session: channel,
      rpc,
      sandbox,
      helloTimeout,
      // A channel that was switched away from is nobody's problem any more.
      hasEnded: () => bridge.intent !== null || current.session !== channel,
      onReconnecting: () => setConnectionStatus("connection lost — reconnecting…"),
      onRecovered: async () => {
        setConnectionStatus("pod connected");
        await runtime.recoverAfterReconnect();
        work.seed(runtime.cache.state.isStreaming, runtime.cache.state.isCompacting, true);
        // Fire-and-forget UI emitted into the gap never reached this client; ask the shim's
        // journal for everything after the last podSeq that did (§5.3). The mirror re-declares
        // its sizes the same way, so session bytes written into the gap stream now (§5.6).
        uiReplay.replayMissed();
        mirror.sync();
        modeUi?.requestRender?.(true);
        bridge.notify("connection dropped — reconnected to the pi session", "info");
      },
      onLost: () => {
        setConnectionStatus("connection lost — /quit to exit, or wait for retry");
        bridge.setIntent({ kind: "transportLost" });
        bridge.requestShutdown();
      },
    });
  };
  wireRecovery(current.session, current.sandbox);

  // --- /pod switch & the picker (§6.4) --------------------------------------
  let switching = false;
  const switchPod = async (id: string | undefined): Promise<void> => {
    const host = opts.switchHost!;
    if (switching) return;
    switching = true;
    try {
      let targetId = id;
      if (targetId === undefined) {
        const entries = await host.listPods();
        if (entries.length === 0) {
          bridge.notify("no pods to switch to", "info");
          return;
        }
        const labels = entries.map((e) => (e.id === current.podId ? `${e.label} (current)` : e.label));
        const choice = await bridge.ui?.select?.("Switch to pod", labels);
        if (choice === undefined) return;
        targetId = entries[labels.indexOf(choice)]?.id;
        if (targetId === undefined) return;
      }
      if (targetId === current.podId) {
        bridge.notify("already attached to that pod", "info");
        return;
      }

      const target = await host.resolveTarget(targetId);
      if (!target) {
        bridge.notify(`no pod matches "${targetId}"`, "warning");
        return;
      }

      // Reach the target before touching the current channel: a failed switch never
      // strands both sessions (§12) — the user stays where they were.
      bridge.notify(`switching to pod ${target.podId}…`, "info");
      let connection: VerifiedPodConnection;
      try {
        connection = await connectToPod(target, opts.exitCodeFile, helloTimeout);
      } catch (e) {
        bridge.notify(
          `switch failed: ${e instanceof Error ? e.message : String(e)} — staying on ${current.podId}`,
          "error",
        );
        return;
      }

      if (bridge.intent) {
        connection.channel.close();
        return;
      }
      const previousPodId = current.podId;
      const transaction = commitVerifiedPodSwitch({
        current,
        rpc,
        connection,
        target,
        host,
        refresh: () => runtime.refreshAfterReplacement(),
        installRecovery: wireRecovery,
        syncWorkState: () => work.seed(runtime.cache.state.isStreaming, runtime.cache.state.isCompacting, true),
        render: () => modeUi?.requestRender?.(true),
      });
      switchTransaction = transaction;
      try {
        await transaction;
        // A different pod means a different journal: reset and take its current UI state,
        // and point the mirror at the new pod's shadow directory.
        uiReplay.replayAll();
        mirror.rebind(target.podId);
        const compatibilityWarnings = [
          shimCompatibilityWarning(connection.hello.shimVersion),
          extensionCompatibilityWarning(connection.hello.extensionVersion),
        ];
        for (const warning of compatibilityWarnings) {
          if (warning) bridge.notify(warning, "warning");
        }
        bridge.notify(`switched to pod ${target.podId} (${target.project})`, "info");
      } catch (e) {
        bridge.notify(
          `switch failed: ${e instanceof Error ? e.message : String(e)} — staying on ${previousPodId}`,
          "error",
        );
      } finally {
        if (switchTransaction === transaction) switchTransaction = null;
      }
    } finally {
      switching = false;
    }
  };

  await runtime.init();
  work.seed(runtime.cache.state.isStreaming, runtime.cache.state.isCompacting, true);
  // A rejoined pi has been emitting UI into a client-less gap since the last detach; the
  // extension-UI queue holds these until the TUI binds, so nothing lands on a dead surface.
  if (reattached) uiReplay.replayAll();

  // Imported lazily: the TUI drags in pi's whole component tree, which no non-interactive
  // code path should pay for.
  const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
  const { wirePodChords } = await import("./runtime/chords.js");

  // InteractiveMode drops every extension terminal-input listener on session rebind and on
  // shutdown, and /pod switch rebinds — so the chords are rewired from scratch each time the
  // TUI hands over a fresh UI context, dropping the previous subscription first.
  const chords = opts.chords ?? DEFAULT_CONFIG.pi.chords;
  let unwireChords: () => void = () => {};
  bridge.setOnUiBound(() => {
    unwireChords();
    unwireChords = wirePodChords(bridge, runtime.router, chords);
  });

  // InteractiveMode owns initial-message delivery: its run() waits for init and session
  // subscription before prompting, so fast responses cannot race the local renderer.
  const tuiMode = tuiModeFromArgv(opts.piArgv);
  const mode = new InteractiveMode(runtime.runtimeHost as never, {
    ...(opts.startupPrompt !== undefined ? { initialMessage: opts.startupPrompt } : {}),
    ...(tuiMode ? { tuiMode } : {}),
  });
  installPodTerminalTitle(mode as never);
  // Internals-shaped access, same posture as the runtime surface itself (§15): the TUI
  // handle borrows the terminal, while the editor handle clears accepted local commands.
  const modeInternals = mode as unknown as {
    ui?: { stop(): void; start(): void; requestRender?(force?: boolean): void };
    editor?: { setText(text: string): void };
  };
  modeUi = modeInternals.ui ?? null;
  modeEditor = modeInternals.editor ?? null;
  await runtime.healStreamingRenderer();

  // InteractiveMode ends every session in `process.exit(0)` after awaiting dispose. The
  // launcher still has teardown to run and an exit code of its own to report, so while the
  // TUI runs, exit is intercepted: once the ending is delivered, the exit is swallowed and
  // control returns to the caller. Crash paths (ending never delivered) pass through.
  const realExit = process.exit.bind(process) as (code?: number) => never;
  const patchedExit = ((code?: number) => {
    if (ending) return undefined as never;
    return realExit(code);
  }) as typeof process.exit;
  process.exit = patchedExit;

  try {
    const modeRun = mode.run();
    // InteractiveMode registers its signal handlers synchronously before its first await.
    // Re-prepend ours now so hangup intent exists before runtimeHost.dispose() is entered.
    process.prependListener("SIGHUP", onHangUp);
    process.prependListener("SIGTERM", onHangUp);
    void modeRun.catch((e: unknown) => {
      warn(`the TUI failed: ${e instanceof Error ? e.message : String(e)}`);
      bridge.setIntent({ kind: "transportLost" });
      bridge.requestShutdown();
    });
    return await endingPromise;
  } finally {
    // The patch STAYS once an ending was delivered: InteractiveMode's own trailing
    // process.exit(0) races the launcher's teardown on the microtask queue, and losing that
    // race must not kill the process mid-stop. The CLI finishes via process.exitCode and a
    // drained event loop, so nothing legitimate calls process.exit after this point.
    if (!ending) process.exit = realExit;
    bridge.setOnUiBound(null);
    unwireChords();
    process.off("SIGHUP", onHangUp);
    process.off("SIGTERM", onHangUp);
  }
}

// ---------------------------------------------------------------------------
// Non-TTY: the headless line renderer (§5.5)
// ---------------------------------------------------------------------------

async function runHeadlessSession(
  opts: RpcSessionOptions,
  session: PtySession,
  rpc: RemoteRpcClient,
  stdout: NodeJS.WritableStream,
  work: PiWorkTracker,
  mirror: SessionMirror,
): Promise<SessionEndInput> {
  // No TUI: dialogs auto-cancel through the same wiring the interactive path uses (§5.3).
  const bridge = new HostBridge();
  wireExtensionUi(rpc, bridge);

  let hungUp = false;
  let transportLost = false;
  // Loss and hangup must resolve any in-flight wait: nothing below may block on a channel
  // that is already gone.
  let resolveGone!: () => void;
  const gone = new Promise<null>((resolve) => {
    resolveGone = () => resolve(null);
  });
  // A settle event can fall inside the transport gap. Recovery reconciles get_state and
  // releases a one-shot whose remote run already finished instead of waiting forever.
  let resolveRecoveredIdle!: () => void;
  const recoveredIdle = new Promise<null>((resolve) => {
    resolveRecoveredIdle = () => resolve(null);
  });
  const onHangUp = () => {
    hungUp = true;
    resolveGone();
    session.close();
  };
  process.on("SIGHUP", onHangUp);
  process.on("SIGTERM", onHangUp);

  wireChannelRecovery({
    session,
    rpc,
    sandbox: opts.sandbox,
    helloTimeout: opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
    hasEnded: () => hungUp || transportLost,
    onRecovered: async () => {
      mirror.sync();
      const state = await rpc.getState();
      work.seed(state.isStreaming, state.isCompacting, true);
      if (!state.isStreaming && !state.isCompacting) resolveRecoveredIdle();
    },
    onLost: () => {
      transportLost = true;
      resolveGone();
    },
  });

  try {
    let exitCode: number | null;
    // A headless invocation is itself a request to run once and close; it never opens an
    // interactive recovery shell, even if stdin alone happens to be a TTY.
    const quitRequested = true;
    if (opts.startupPrompt !== undefined) {
      exitCode = await Promise.race([
        runHeadless({ rpc, prompt: opts.startupPrompt, stdout, stderr: opts.stderr ?? process.stderr }),
        gone,
        recoveredIdle,
      ]);
      // The run settled with pi still up: the one-shot is done, so quit it (§5.5).
      if (exitCode === null && rpc.exitCode === undefined && !hungUp && !transportLost) {
        exitCode = await Promise.race([quitPi(rpc), gone]);
      }
    } else {
      // Nothing to send: the session is whatever pi does on its own (e.g. a scripted run
      // that only wants provisioning). Quit pi if it is still up and report its code.
      exitCode = await Promise.race([quitPi(rpc), gone]);
    }

    if (hungUp || transportLost) {
      return {
        piExited: false,
        quitRequested: false,
        exitCode: null,
        detached: false,
        detachAction: null,
        hungUp,
        transportLost,
        sessionId: session.id,
        stderrTail: rpc.getStderr(),
      };
    }

    return {
      piExited: true,
      quitRequested,
      exitCode,
      detached: false,
      detachAction: null,
      hungUp: false,
      transportLost: false,
      sessionId: session.id,
      stderrTail: rpc.getStderr(),
    };
  } finally {
    process.off("SIGHUP", onHangUp);
    process.off("SIGTERM", onHangUp);
    rpc.close();
  }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/**
 * How many successful in-place recoveries a session may spend inside one window before a
 * further drop is treated as a flapping transport rather than a recoverable blip. A long
 * session accumulating occasional drops (idle websocket resets, provider restarts) recovers
 * every time; only a tight drop→recover→drop loop gives up.
 */
export const RECOVERY_FLAP_LIMIT = 3;
export const RECOVERY_FLAP_WINDOW_MS = 60_000;

/**
 * How long the channel may stay silent before the client actively asks the shim for proof
 * of life. Provider transports can die *half-open* — no close frame ever reaches the SDK,
 * so `session.onExit` never fires — and the longest silent windows (a compaction's single
 * multi-minute model call, an idle prompt) are exactly when middleboxes reap idle
 * connections. Without a probe, that failure mode is a silent wedge: no events arrive,
 * writes are discarded, and nothing ever reports the loss.
 */
export const CHANNEL_LIVENESS_INTERVAL_MS = 30_000;
/** How long after a liveness ping the channel may stay silent before it is treated as dropped. */
export const CHANNEL_LIVENESS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Channel end without pi_exit is a transport problem, not a session ending (§6.2). Rung 1
 * of the attach walk-back, inline (§6.3): reattach, re-handshake, gap-fill, continue — once
 * per drop, for as many drops as the session survives (bounded by the flap guard above).
 * Anything less is reported lost — and the pod is kept.
 *
 * Detection is two-sided: the provider's exit callback for transports that die loudly, and
 * an active liveness probe for those that die silently. A quiet interval ends with a hello
 * ping; any inbound bytes before the probe deadline prove the channel, and a deadline with
 * nothing received is treated exactly like a reported channel end.
 */
export function wireChannelRecovery(args: {
  session: PtySession;
  rpc: RemoteRpcClient;
  sandbox: Sandbox;
  helloTimeout: number;
  hasEnded: () => boolean;
  onRecovered: () => Promise<void>;
  onLost: () => void;
  /** Display-only: the ladder is attempting a reattach. */
  onReconnecting?: (() => void) | undefined;
  /** Test seams; production uses the exported constants. */
  livenessIntervalMs?: number;
  livenessProbeTimeoutMs?: number;
}): void {
  const { session, rpc, sandbox } = args;
  const livenessIntervalMs = args.livenessIntervalMs ?? CHANNEL_LIVENESS_INTERVAL_MS;
  const livenessProbeTimeoutMs = args.livenessProbeTimeoutMs ?? CHANNEL_LIVENESS_PROBE_TIMEOUT_MS;
  let recovering = false;
  let probing = false;
  let recoveredAt: number[] = [];

  const onChannelEnd = async (): Promise<void> => {
    if (rpc.exitCode !== undefined || args.hasEnded() || recovering) return;
    recovering = true;
    args.onReconnecting?.();
    try {
      const now = Date.now();
      recoveredAt = recoveredAt.filter((at) => now - at < RECOVERY_FLAP_WINDOW_MS);
      if (recoveredAt.length < RECOVERY_FLAP_LIMIT && typeof session.reattach === "function") {
        // A pod that is *stopped*, not just unreachable, means the session is over (§6.2).
        const state = await sandbox.state().catch(() => "gone");
        if (args.hasEnded()) return;
        if (state === "started") {
          try {
            await session.reattach();
            // Authority may have moved while provider calls were in flight (notably /pod switch).
            if (args.hasEnded()) return;
            rpc.rebindChannel(session);
            const again = await rpc.ensureHello(args.helloTimeout, { discardCached: true });
            if (args.hasEnded()) return;
            if (again.piRunning) {
              recoveredAt.push(Date.now());
              await args.onRecovered();
              return;
            }
          } catch (e) {
            debug(`reconnect failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }

      if (rpc.exitCode !== undefined || args.hasEnded()) return;
      stopLiveness();
      rpc.handleChannelClosed();
      args.onLost();
    } finally {
      recovering = false;
    }
  };
  session.onExit(() => void onChannelEnd());

  // --- active liveness (§6.3) ----------------------------------------------
  const probeLiveness = async (): Promise<void> => {
    if (rpc.exitCode !== undefined || args.hasEnded()) {
      stopLiveness();
      return;
    }
    if (recovering || probing) return;
    // Anything received recently proves the channel without spending a ping.
    if (Date.now() - rpc.lastReceivedAt < livenessIntervalMs) return;
    probing = true;
    try {
      const receivedBefore = rpc.lastReceivedAt;
      rpc.ping();
      const deadline = Date.now() + livenessProbeTimeoutMs;
      while (Date.now() < deadline) {
        await delay(Math.min(250, livenessProbeTimeoutMs));
        // Any inbound bytes at all — the hello answer or ordinary traffic — are proof of life.
        if (rpc.lastReceivedAt !== receivedBefore) return;
        if (recovering || rpc.exitCode !== undefined || args.hasEnded()) return;
      }
      debug("channel silent past the liveness deadline — treating the transport as dropped");
      await onChannelEnd();
    } finally {
      probing = false;
    }
  };
  const livenessTimer = setInterval(() => void probeLiveness(), livenessIntervalMs);
  livenessTimer.unref?.();
  const stopLiveness = (): void => clearInterval(livenessTimer);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** User-facing fallback notice shared by stderr and the interactive TUI. */
export function shimCompatibilityWarning(shimVersion: string): string | null {
  if (shimVersion !== PREVIOUS_SHIM_VERSION) return null;
  return (
    `the pod runs previous shim ${shimVersion}; this pi-pod uses shim ${SHIM_VERSION} — ` +
    "continuing in compatibility mode, but newer shim features are unavailable until Pi restarts"
  );
}

/** User-facing notice when a live Pi predates this launcher's generated extension. */
export function extensionCompatibilityWarning(extensionVersion: number | undefined): string | null {
  if (extensionVersion === POD_EXTENSION_VERSION) return null;
  const podVersion = extensionVersion === undefined ? "an unversioned extension" : `extension ${extensionVersion}`;
  return (
    `the pod runs ${podVersion}; this pi-pod uses extension ${POD_EXTENSION_VERSION} — ` +
    "continuing, but launcher and extension behavior may differ until Pi restarts"
  );
}

/**
 * The handshake's verification half (§4.3): protocol and unsupported shim skew are hard errors
 * whose fix is named. The immediately preceding shim and older pi releases continue with visible
 * compatibility warnings; a shim whose pi is not running has nothing to attach to.
 */
export function verifyHello(hello: ShimHello, session: Pick<PtySession, "close">): void {
  if (hello.proto !== FRAME_PROTO_VERSION) {
    session.close();
    throw new PiPodError(
      `the pod shim speaks frame protocol ${hello.proto}; this pi-pod speaks ${FRAME_PROTO_VERSION}`,
      { hint: "exit the existing Pi session or wait for automatic idle retention, then attach again" },
    );
  }
  if (hello.shimVersion !== SHIM_VERSION && hello.shimVersion !== PREVIOUS_SHIM_VERSION) {
    session.close();
    throw new PiPodError(
      `pod shim version skew: pod has ${hello.shimVersion}; this pi-pod supports ${PREVIOUS_SHIM_VERSION} or ${SHIM_VERSION}`,
      { hint: "exit the existing Pi session or wait for automatic idle retention, then attach again" },
    );
  }
  if (!hello.piRunning) {
    session.close();
    throw new PiPodError("the pod shim could not start pi", {
      hint: `check the shim log in the pod: ${SHIM_LOG_PATH}`,
    });
  }

  const bundled = bundledPiVersion();
  if (hello.piVersion === "unknown") {
    // pi is demonstrably running (it answered the shim's spawn); only --version failed.
    warn("the pod could not report its pi version — version-skew protection is off this session");
  } else if (hello.piVersion !== bundled) {
    const comparison = comparePiVersions(hello.piVersion, bundled);
    if (comparison === null || comparison > 0) {
      session.close();
      throw new PiPodError(
        `pi version skew: the pod runs ${hello.piVersion} but this pi-pod bundles ${bundled}`,
        { hint: describeVersionSkew(hello.piVersion, bundled) },
      );
    }
    if (comparison < 0) {
      warn(
        `the pod runs older pi ${hello.piVersion}; this pi-pod bundles pi ${bundled} — ` +
          `continuing, but some features may be unavailable. Rebuild with \`pi-pod image build\` to update it`,
      );
    }
  }

  const extensionWarning = extensionCompatibilityWarning(hello.extensionVersion);
  if (extensionWarning) warn(extensionWarning);

  const compatibilityWarning = shimCompatibilityWarning(hello.shimVersion);
  if (compatibilityWarning) warn(compatibilityWarning);
}
