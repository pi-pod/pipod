/**
 * src/account/session.ts — the account-mode session driver (account-mode-spec §6.2).
 *
 * The same shape as src/client/session.ts's interactive path — pi's real InteractiveMode
 * over the remote runtime — with the transport swapped for {@link GatewayRpcClient} and the
 * pod-coupled pieces replaced by their server-side equivalents: recovery is internal to the
 * WebSocket client, `/pod shell` has no provider PTY to offer, and `/pod switch` re-targets
 * another server pod by re-attaching the same client.
 *
 * Ending policy is account policy (§6.2): detaching leaves the pod to the server's reaper;
 * an explicit leave-with-action or a quit maps onto server lifecycle commands.
 */
import { isKeyRelease, isKeyRepeat, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { PiPodConfig } from "../config.js";
import {
  isWakeableAsleepReason,
  isWorkstationAsleepReason,
  PiPodError,
  WAKEABLE_ASLEEP_REASONS,
} from "../errors.js";
import { info, warn } from "../log.js";
import { confirm } from "../prompt.js";
import { buildPodStatusLines } from "../client/podinfo.js";
import { shimCompatibilityWarning } from "../client/compat.js";
import { runHeadless, tuiModeFromArgv, type TuiMode } from "../client/headless.js";
import { installPodTerminalTitle } from "../client/pod-title.js";
import {
  attestedPackages,
  installAttestedPackages,
  trustAttestedPackages,
  unattestedPackageNotice,
  type AttestedPackage,
} from "../client/runtime/attested-extensions.js";
import { installPodCommandOverrides } from "../client/runtime/pod-command-overrides.js";
import { preparePromptImages } from "../client/runtime/local-images.js";
import {
  createDerivedPodConfig,
  defaultHostAgentDir,
  defaultPodCacheRoot,
  loadPodThemeLoader,
  type DerivedPodConfig,
} from "../client/runtime/pod-derived-config.js";
import { createPodConfigSync, podConfigSyncNotice, type PodConfigSync } from "./pod-config-sync.js";
import { createRemoteRuntime, type RemoteRuntime } from "../client/runtime/remote-runtime.js";
import type { UsageTotals } from "../client/runtime/state.js";
import type { RemoteAuthInteraction } from "../client/runtime/auth-bridge.js";
import type { HostUiContext } from "../client/runtime/bridge.js";
import type { PodCommandHost } from "../client/runtime/pod-commands.js";
import { type ApiPod, type AccountClient } from "./api.js";
import { runCredentialLogin } from "./credential-login.js";
import { GatewayRpcClient, type ConnectionState } from "./gateway-rpc.js";
import { ensureExactPi } from "./pi-readiness.js";
import { bindAsleepWake } from "./asleep-wake.js";
import { podStatusLabel } from "./pod-status.js";
import { displayRef, matchesRef } from "./ref.js";

export interface AccountSessionOptions {
  client: AccountClient;
  pod: ApiPod;
  /** Direct context for launches, which have already resolved it during preflight. */
  config?: PiPodConfig;
  hostCwd?: string;
  /** Attach can resolve local UI config while the gateway connection opens. */
  loadContext?: () => Promise<{ config: PiPodConfig; hostCwd: string }>;
  startupPrompt?: string | undefined;
  /** Per-invocation UI-only override; never mutates the shared pod session. */
  tuiMode?: TuiMode | undefined;
  /**
   * Extension command names that execute in the launcher's local extension host
   * instead of the pod (see RemoteRuntimeOptions.localCommands). Default: none —
   * the pod owns every slash command; use `/pod local <name>` for one-off runs.
   */
  localCommands?: string[] | undefined;
  /** Verified shim hello boundary: Pi is running, so launch cancellation must stop deleting. */
  onPiStarted?: (() => void) | undefined;
  stdin?: NodeJS.ReadStream | undefined;
  stdout?: NodeJS.WriteStream | undefined;
  stderr?: NodeJS.WriteStream | undefined;
}

export interface AccountSessionResult {
  exitCode: number;
  /** What the ending asked of the pod; the caller reports, the server executes. */
  podAction: "none" | "stopped" | "archived";
}

/** User-facing explanation for an unexpected account-session ending. */
export function accountSessionLossNotice(podId: string, serverReason: string | null): string[] {
  const podRef = displayRef(podId, "pod");
  if (serverReason === "idle_stop") {
    return [
      `pod ${podRef} was stopped after inactivity; its filesystem is preserved`,
      `resume with: pipod attach ${podRef}`,
    ];
  }
  if (serverReason === "restore_required" || serverReason === "archived") {
    return [`pod ${podRef} was archived — \`pipod attach ${podRef}\` restores it`];
  }
  return [
    ...(serverReason === null ? [] : [`session ended by the server: ${serverReason}`]),
    `connection lost — pod ${podRef} keeps running; \`pipod attach\` to reattach`,
  ];

}

function isArchivedAsleepReason(reason: string): boolean {
  return reason === "archived" || reason === "archive" || reason === "provider_archived" || reason === "restore_required";

}

/** One-shot toast on each visit to asleep. */
export function asleepCompletionNotice(reason: string): string | null {
  if (!isWakeableAsleepReason(reason)) return null;
  // The whole machine went down, not just this pod. Saying "stopped after going idle" would
  // be true of the pod and useless about the wait: starting a workstation took minutes every
  // time it was measured.
  if (isWorkstationAsleepReason(reason)) {
    return "your workstation stopped — transcript above is complete; press Enter to start it (several minutes; your files are retained)";
  }
  if (isArchivedAsleepReason(reason)) {
    return "pod was archived — press Enter to restore & reattach";
  }
  return "pod stopped after going idle — transcript above is complete; press Enter to wake";

}

/** Status-line copy for the account-mode connection indicator. */
export function connectionStatusText(state: ConnectionState, podRef?: string): string {
  const name = podRef ? `pod ${podRef}` : "pod";
  switch (state.kind) {
    case "connected":
      return `${name} connected`;
    case "reconnecting":
      return `connection lost — reconnecting (attempt ${state.attempt}; q, Esc, or Ctrl-C to quit)…`;
    case "asleep": {
      if (isWorkstationAsleepReason(state.reason)) {
        return "workstation stopped — press Enter to start it (several minutes), /quit to exit";
      }
      if (isWakeableAsleepReason(state.reason)) {
        const why = isArchivedAsleepReason(state.reason) ? "archived" : "idle";
        const wake = isArchivedAsleepReason(state.reason)
          ? "press Enter to restore & reattach"
          : "press Enter or type to wake";
        return `${name} stopped (${why}) — ${wake}, /quit to exit`;
      }
      return state.reason
        ? `${name} stopped (${state.reason}) — /quit to exit`
        : `${name} stopped — /quit to exit`;
    }
    case "lost":
      return "connection lost — still retrying (q, Esc, or Ctrl-C to quit)";
    case "ended":
      if (state.reason === "restore_required" || state.reason === "archived") {
        return podRef
          ? `${name} was archived — pipod attach ${podRef} restores it`
          : `${name} was archived — pipod attach restores it`;
      }
      return state.reason ? `session ended — ${state.reason}` : "session ended";
  }

}

export function connectionAllowsQuit(state: ConnectionState | null): boolean {
  return state?.kind === "reconnecting" || state?.kind === "lost";
}

/** Account-only escape hatch while Pi's ordinary input path has no usable transport. */
export function disconnectedQuitInput(
  data: string,
  disconnected: boolean,
  onQuit: () => void,
): { consume: true } | undefined {
  if (!disconnected || isKeyRelease(data) || isKeyRepeat(data)) return undefined;
  const quitKeys: KeyId[] = ["q", "escape", "ctrl+c"];
  if (!quitKeys.some((key) => matchesKey(data, key))) return undefined;
  onQuit();
  return { consume: true };
}

export function wireDisconnectedQuit(
  bridge: {
    ui: HostUiContext | null;
    setIntent(intent: { kind: "quit" }): boolean;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    requestShutdown(): void;
  },
  isDisconnected: () => boolean,
): () => void {
  return bridge.ui?.onTerminalInput?.((data) =>
    disconnectedQuitInput(data, isDisconnected(), () => {
      if (!bridge.setIntent({ kind: "quit" })) return;
      bridge.notify("leaving the disconnected session…", "info");
      bridge.requestShutdown();
    }),
  ) ?? (() => {});
}

/**
 * `/pod status`, account edition (§5.4): the same report local mode prints, sourced from the
 * pod row instead of the provider — the server owns the control plane here, and
 * `resolved_config` is the merge the pod actually ran under.
 *
 * Provider state is not exposed in account mode, so readiness comes from the API's
 * provider-agnostic `ready` flag and is spelled in the vocabulary the shared renderer
 * already understands.
 */
export function accountPodStatusLines(pod: ApiPod): string[] {
  const resolved = pod.resolvedConfig;
  const archiveAfterMinutes =
    resolved.archiveTransition?.kind === "same-as-stop"
      ? null
      : resolved.archiveAfterMinutes !== undefined
        ? resolved.archiveAfterMinutes
        : resolved.archiveAfterDays !== undefined
          ? resolved.archiveAfterDays * 24 * 60
          : null;
  return buildPodStatusLines({
    podId: pod.id,
    provider: pod.provider,
    state: pod.ready ? "started" : "starting",
    project: pod.project ?? pod.name,
    image: resolved.image ?? "(server default)",
    egress: resolved.egress.description,
    idleTimeoutMinutes: resolved.idleTimeoutMinutes ?? 0,
    archiveAfterMinutes,
    ...(resolved.archiveTransition ? { archiveTransition: resolved.archiveTransition } : {}),
    createdAtMs: Date.parse(pod.createdAt),
  });
}

export async function runAccountSession(opts: AccountSessionOptions): Promise<AccountSessionResult> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const interactive = stdin.isTTY === true && stdout.isTTY === true;

  return interactive ? runAccountInteractive(opts) : runAccountHeadless(opts);
}

async function connectClient(
  opts: AccountSessionOptions,
  callbacks: {
    onRecovered?: () => void | Promise<void>;
    onLost?: () => void;
    onSessionEnded?: (reason: string) => void;
    onConnectionState?: (state: ConnectionState) => void;
  },
  readiness: { interactive: boolean; approve?: (question: string) => Promise<boolean> },
) : Promise<GatewayRpcClient> {
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
  };
  process.on("SIGINT", onInterrupt);
  let rpc: GatewayRpcClient;
  try {
    rpc = await GatewayRpcClient.connect({
      client: opts.client,
      podId: opts.pod.id,
      onRecovered: callbacks.onRecovered,
      onLost: callbacks.onLost,
      onSessionEnded: callbacks.onSessionEnded,
      onConnectionState: callbacks.onConnectionState,
      workstationWait: { cancelled: () => interrupted },
    });
  } finally {
    process.off("SIGINT", onInterrupt);
  }
  const hello = rpc.helloInfo;
  if (!hello) {
    rpc.close();
    throw new PiPodError("the server session carried no pod handshake", {
      hint: "the pod may still be starting — retry in a moment, or check `pipod list`",
    });
  }
  await ensureExactPi({
    client: opts.client,
    pod: opts.pod,
    rpc,
    interactive: readiness.interactive,
    ...(readiness.approve ? { approve: readiness.approve } : {}),
  });
  try {
    opts.onPiStarted?.();
  } catch (error) {
    rpc.close();
    throw error;
  }
  return rpc;
}

// ---------------------------------------------------------------------------
// Interactive: pi's real InteractiveMode, gateway transport (§6.2)
// ---------------------------------------------------------------------------

function applyConnectionStatus(
  ui: HostUiContext | null | undefined,
  state: ConnectionState,
  podId: string,
) : void {
  ui?.setStatus?.("pod-connection", connectionStatusText(state, displayRef(podId, "pod")));
}

interface FooterSession {
  sessionManager: { getCwd(): string; getEntries?(): unknown[] };
}

interface AccountFooterInternals {
  session?: FooterSession;
  footer?: { setSession(session: FooterSession): void };
  footerDataProvider?: {
    setCwd(cwd: string): void;
    getGitBranch(): string | null;
  };
}

/**
 * The footer sums usage over the full session log, but the remote cache holds only the
 * active context branch. This entry carries the difference (pre-compaction messages,
 * abandoned branches) in the one shape the footer already adds to its totals — and it is
 * visible to the footer alone, so the transcript, tree, and fork picker never see it.
 */
function hiddenUsageEntry(hidden: UsageTotals): unknown {
  return {
    type: "branch_summary",
    id: "pi-pod:hidden-usage",
    parentId: null,
    timestamp: "",
    fromId: "",
    summary: "",
    usage: {
      input: hidden.input,
      output: hidden.output,
      cacheRead: hidden.cacheRead,
      cacheWrite: hidden.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: hidden.cost },
    },
  };
}

/** Keep Pi's built-in footer, but feed its location row from the remote pod only. */
export function bindAccountFooterContext(
  mode: AccountFooterInternals,
  initialWorkdir: string,
  hiddenUsage?: () => UsageTotals | null,
): { setWorkdir(workdir: string): void } {
  let workdir = initialWorkdir;
  const footer = mode.footer;
  const session = mode.session;
  if (!footer || !session) return { setWorkdir: (next) => { workdir = next; } };

  const wrapSession = (nextSession: FooterSession): FooterSession =>
    new Proxy(nextSession, {
      get(target, property, receiver) {
        if (property !== "sessionManager") return Reflect.get(target, property, receiver);
        return new Proxy(target.sessionManager, {
          get(manager, managerProperty, managerReceiver) {
            if (managerProperty === "getCwd") return () => workdir;
            if (managerProperty === "getEntries" && hiddenUsage) {
              const real = Reflect.get(manager, managerProperty, managerReceiver) as
                | (() => unknown[])
                | undefined;
              if (typeof real === "function") {
                return () => {
                  const entries = real.call(manager) ?? [];
                  const hidden = hiddenUsage();
                  return hidden ? [...entries, hiddenUsageEntry(hidden)] : entries;
                };
              }
            }
            return Reflect.get(manager, managerProperty, managerReceiver);
          },
        });
      },
    });
  const setSession = footer.setSession.bind(footer);
  footer.setSession = (nextSession) => setSession(wrapSession(nextSession));
  footer.setSession(session);

  const provider = mode.footerDataProvider;
  if (provider) {
    // An absolute non-workspace path prevents Pi's branch watcher from inspecting the host checkout.
    provider.setCwd("/proc/pi-pod-account-footer");
    provider.getGitBranch = () => null;
  }

  return {
    setWorkdir: (next) => { workdir = next; },
  };
}

async function runAccountInteractive(opts: AccountSessionOptions): Promise<AccountSessionResult> {
  let runtimeRef: RemoteRuntime | null = null;
  let modeUi: { stop(): void; start(): void; requestRender?(force?: boolean): void } | null = null;
  let rpc: GatewayRpcClient | undefined;
  let readinessPod = opts.pod;
  const approvePiUpdate = async (question: string): Promise<boolean> => {
    const ui = runtimeRef?.bridge.ui;
    if (ui?.confirm) return ui.confirm("Update Pi in pod", question);
    return confirm(question, { nonInteractiveDefault: false });
  };
  const asleepWake = bindAsleepWake({
    stdin: opts.stdin ?? process.stdin,
    wake: () => {
      void rpc?.wake().catch(() => {});
    },
    wakeableReasons: WAKEABLE_ASLEEP_REASONS,
  });

  let lastAsleepKey: string | null = null;
  let pendingAsleepNotice: string | null = null;
  const noteAsleep = (state: ConnectionState): void => {
    asleepWake.onConnectionState(state);
    if (state.kind !== "asleep") {
      lastAsleepKey = null;
      return;
    }
    runtimeRef?.cache.forceIdle();
    modeUi?.requestRender?.(true);
    if (lastAsleepKey === state.reason) return;
    lastAsleepKey = state.reason;
    const notice = asleepCompletionNotice(state.reason);
    if (!notice) return;
    if (!runtimeRef) {
      pendingAsleepNotice = notice;
      return;
    }
    const notify = () => runtimeRef?.bridge.notify(notice, "info");
    if (runtimeRef.bridge.ui) notify();
    else runtimeRef.bridge.onUiBound(notify);
  };

  let serverEndReason: string | null = null;
  let pendingConnectionState: ConnectionState | null = null;
  let latestConnectionState: ConnectionState | null = null;
  const rpcPromise = connectClient(opts, {
    onRecovered: async () => {
      if (!rpc) throw new PiPodError("the recovered session has no transport");
      await ensureExactPi({
        client: opts.client,
        pod: readinessPod,
        rpc,
        interactive: true,
        approve: approvePiUpdate,
      });
      // Outcome-valued and serialized; a sync failure must not read as a failed recovery.
      if (podSync) {
        const outcome = await podSync.sync("reconnect");
        if (outcome.kind === "applied" && outcome.changed) {
          runtimeRef?.bridge.notify("pod settings changed while disconnected — refreshed", "info");
        }
        if (outcome.kind === "applied" && outcome.drift) {
          runtimeRef?.bridge.notify(
            "pod config changed on disk after pi started — the agent's process may run older config until it restarts",
            "warning",
          );
        }
      }
      await runtimeRef?.recoverAfterReconnect();
      modeUi?.requestRender?.(true);
      runtimeRef?.bridge.notify("connection dropped — reconnected to the pi session", "info");
    },
    onLost: () => {
      // Stay in the TUI so the account-side lost-state keys can end the unusable session.
    },
    onSessionEnded: (reason) => {
      // Preserve the semantic reason until the TUI has shut down, when terminal output is stable.
      serverEndReason = reason;
      // Paint the reason on the last frame, then tear down as today.
      const state: ConnectionState = { kind: "ended", reason };
      if (runtimeRef) applyConnectionStatus(runtimeRef.bridge.ui, state, rpc?.podId ?? opts.pod.id);
      else pendingConnectionState = state;
      runtimeRef?.bridge.setIntent({ kind: "transportLost" });
      runtimeRef?.bridge.requestShutdown();
    },
    onConnectionState: (state) => {
      latestConnectionState = state;
      noteAsleep(state);
      if (runtimeRef) {
        const paint = () => applyConnectionStatus(runtimeRef?.bridge.ui, state, rpc?.podId ?? opts.pod.id);
        if (runtimeRef.bridge.ui) paint();
        else runtimeRef.bridge.onUiBound(paint);
        if (state.kind === "lost") {
          runtimeRef.bridge.notify(
            state.reason ? `could not reconnect: ${state.reason}` : "connection lost",
            "error",
          );
          // Stay alive: do not set transportLost or request shutdown.
        }
      } else {
        pendingConnectionState = state;
      }
    },
  }, { interactive: true, approve: approvePiUpdate });
  const contextPromise = opts.loadContext
    ? opts.loadContext()
    : Promise.resolve({ config: opts.config!, hostCwd: opts.hostCwd! });
  let context: { config: PiPodConfig; hostCwd: string };
  try {
    [rpc, context] = await Promise.all([rpcPromise, contextPromise]);
  } catch (error) {
    asleepWake.dispose();
    void rpcPromise.then((connected) => connected.close(), () => {});
    throw error;
  }
  if (!rpc) throw new Error("account session connected without a transport");

  let ending: {
    kind: "quit" | "leave" | "hangup" | "transportLost";
    action: "keep" | "archive" | null;
    exitCode: number | null;
  } | null = null;
  let resolveEnding!: () => void;
  const endingPromise = new Promise<void>((resolve) => {
    resolveEnding = resolve;
  });

  // --- pod-derived TUI config (data channel): sync before the runtime binds settings ------
  let derived: DerivedPodConfig | null = null;
  let podSync: PodConfigSync | null = null;
  let attachOutcome: import("./pod-config-sync.js").PodConfigSyncOutcome | null = null;
  let attachSyncNotice: { message: string; type: "info" | "warning" } | null = null;
  let themesDir: string | null = null;
  let podThemeLoader: Awaited<ReturnType<typeof loadPodThemeLoader>> = null;
  const cacheRoot = defaultPodCacheRoot();
  if (cacheRoot) {
    let candidate: DerivedPodConfig | null = null;
    try {
      candidate = createDerivedPodConfig({ cacheRoot, hostAgentDir: defaultHostAgentDir() });
      const sync = createPodConfigSync({
        rpc,
        derived: candidate,
        cacheRoot,
        serverHost: new URL(opts.client.serverUrl).host,
      });
      const outcome = await sync.sync("attach");
      attachOutcome = outcome;
      attachSyncNotice = podConfigSyncNotice(outcome);
      if (outcome.kind === "applied") {
        derived = candidate;
        podSync = sync;
        themesDir = candidate.themesDir;
        podThemeLoader = await loadPodThemeLoader();
      } else {
        // Fall back to today's exact behavior: host settings, host project merge included.
        candidate.dispose();
      }
    } catch (error) {
      candidate?.dispose();
      derived = null;
      podSync = null;
      attachSyncNotice = {
        message: `pod settings sync failed: ${error instanceof Error ? error.message : String(error)}; using host settings`,
        type: "warning",
      };
    }
  }

  // --- pod-derived TUI config (code channel): server-attested extension rendering ----------
  // Specs come only from the launch-resolved set the server recorded; the packages are
  // downloaded from the registry by this client. Pod-disk state can never join this set.
  let attestedSpecs: AttestedPackage[] = [];
  let attestedPaths: string[] = [];
  const attestedNotices: Array<{ message: string; type: "info" | "warning" }> = [];
  if (derived && cacheRoot) {
    const attested = attestedPackages(opts.pod.resolvedConfig.piSettings);
    attestedSpecs = attested.specs;
    for (const refusal of attested.refused) {
      attestedNotices.push({ message: `pod extension not run locally: ${refusal}`, type: "warning" });
    }
    const { trusted, declined } = await trustAttestedPackages(attested.specs, {
      cacheRoot,
      ask: (question) => confirm(question, { nonInteractiveDefault: false }),
    });
    if (declined.length > 0) {
      attestedNotices.push({
        message: `pod extensions not run locally (not trusted on this machine): ${declined.map((spec) => `${spec.name}@${spec.version}`).join(", ")}`,
        type: "info",
      });
    }
    if (trusted.length > 0) {
      try {
        const installed = await installAttestedPackages(trusted, { cacheRoot });
        attestedPaths = installed.paths;
        for (const warning of installed.warnings) attestedNotices.push({ message: warning, type: "warning" });
      } catch (error) {
        attestedNotices.push({
          message: `pod extension install failed: ${error instanceof Error ? error.message : String(error)} — rendering stays generic`,
          type: "warning",
        });
      }
    }
    if (attachOutcome?.kind === "applied") {
      const warning = unattestedPackageNotice(attachOutcome.extensions, attested.specs);
      if (warning) attestedNotices.push({ message: warning, type: "warning" });
    }
  }
  let localRenderingActive = attestedPaths.length > 0;

  const podHost: PodCommandHost = {
    // Read fresh rather than reporting the pod as it was at attach: readiness and the idle
    // policy are exactly what someone runs /pod status to check, and `rpc.podId` follows a
    // switch.
    status: async () => accountPodStatusLines(await opts.client.getPod(rpc.podId)),
    list: async () => switchPod(undefined),
    switchPod: async (id?: string) => switchPod(id),
    sync: async () => {
      if (!podSync || !runtimeRef) {
        runtimeRef?.bridge.notify(
          "pod-derived settings are not active in this session — reattach once the pod runs a current shim",
          "warning",
        );
        return;
      }
      const outcome = await podSync.sync("manual");
      if (outcome.kind === "applied") {
        runtimeRef.bridge.notify(
          `pod settings synced (${outcome.digest.slice(0, 8)}${outcome.changed ? "" : ", unchanged"}` +
            `${outcome.drift ? "; pi may run older config until it restarts" : ""})`,
          "info",
        );
      } else {
        const notice = podConfigSyncNotice(outcome);
        if (notice) runtimeRef.bridge.notify(notice.message, notice.type);
      }
    },
  };

  const accountAuthSupported = async (providerId: string, authType?: "oauth" | "api_key"): Promise<boolean> => {
    const provider = (await opts.client.modelCredentials()).providers.find((candidate) => candidate.id === providerId);
    if (!provider?.brokerSupported) return false;
    if (authType === "oauth") return provider.oauth !== null;
    if (authType === "api_key") return provider.apiKey;
    return provider.oauth !== null || provider.apiKey;
  };

  const runtime: RemoteRuntime = createRemoteRuntime({
    rpc,
    cwd: context.hostCwd,
    ...(derived ? { agentDir: derived.agentDir, settingsCwd: derived.settingsCwd } : {}),
    ...(themesDir && podThemeLoader
      ? {
          getLocalThemes: () => podThemeLoader!.load(themesDir!),
        }
      : {}),
    getAvailableThinkingLevels: async () => (await rpc.getModels()).thinkingLevels,
    // Auxiliary completions: the pod's authenticated registry executes them turn-externally.
    auxComplete: (request, opts) => rpc.auxComplete(request, opts),
    // Local command ownership is explicit: empty by default (the pod owns every slash
    // command); `/pod local <name>` always works without any setting.
    ...(opts.localCommands?.length ? { localCommands: opts.localCommands } : {}),
    // `@` completion: the pod's workspace is the only one whose paths the agent can act on.
    listPodFiles: async (query) => {
      const frame = await rpc.getFiles(query);
      return { entries: frame.entries, complete: frame.complete };
    },
    ...(!opts.client.isPodToken ? {
      accountAuthSupported,
      accountLogin: (providerId: string, authType: "oauth" | "api_key", interaction: RemoteAuthInteraction) => runCredentialLogin({
        client: opts.client,
        providerId,
        authType,
        podId: rpc.podId,
        interaction,
      }),
      accountLogout: (providerId: string) => opts.client.deleteModelCredential(providerId),
    } : {}),
    podHost,
    ...(attestedPaths.length > 0 ? { attestedExtensionPaths: attestedPaths } : {}),
    waitForRemoteExitOnQuit: () => latestConnectionState?.kind !== "lost",
    onPodCommandSubmit: () => {
      modeEditor?.setText("");
      modeUi?.requestRender?.();
    },
    onEnding: async (runtimeEnding) => {
      if (ending) return;
      ending = {
        kind: runtimeEnding.intent.kind,
        action: runtimeEnding.intent.kind === "leave" ? runtimeEnding.intent.action : null,
        exitCode: runtimeEnding.exitCode,
      };
      // The transport is ours alone; closing it detaches this client and nothing else.
      rpc.close();
      derived?.dispose();
      resolveEnding();
    },
  });
  runtimeRef = runtime;
  podSync?.setOnAfterApply(() => runtime.reloadSettings());
  if (attachSyncNotice) {
    const notice = attachSyncNotice;
    runtime.bridge.onUiBound(() => runtime.bridge.notify(notice.message, notice.type));
  }
  if (pendingConnectionState) {
    const buffered = pendingConnectionState;
    noteAsleep(buffered);
    runtime.bridge.onUiBound(() => applyConnectionStatus(runtime.bridge.ui, buffered, rpc.podId));
    pendingConnectionState = null;
  }
  if (pendingAsleepNotice) {
    const notice = pendingAsleepNotice;
    pendingAsleepNotice = null;
    runtime.bridge.onUiBound(() => runtime.bridge.notify(notice, "info"));
  }
  for (const notice of attestedNotices) {
    runtime.bridge.onUiBound(() => runtime.bridge.notify(notice.message, notice.type));
  }
  const initialCompatibilityWarning = shimCompatibilityWarning(rpc.helloInfo?.shimVersion ?? "");
  if (initialCompatibilityWarning) {
    runtime.bridge.onUiBound(() => runtime.bridge.notify(initialCompatibilityWarning, "warning"));
  }
  let modeEditor: { setText(text: string): void } | null = null;

  rpc.onControl((event) => {
    if (event.event === "pi_exit") {
      runtime.bridge.setIntent({ kind: "quit" });
      runtime.bridge.requestShutdown();
    } else if (event.event === "event_replay_gap") {
      runtime.bridge.notify("some output was skipped", "warning");
    }
  });
  const onHangUp = () => runtime.bridge.setHangupIntent();

  let footerContext: { setWorkdir(workdir: string): void } | null = null;

  // --- /pod switch, server-side (§6.2) --------------------------------------
  let switching = false;
  const switchPod = async (id: string | undefined): Promise<void> => {
    if (switching) return;
    switching = true;
    try {
      const { pods } = await opts.client.listPods({ mine: true, limit: 50 });
      const candidates = pods.filter((p) => p.state === "active");
      let target: ApiPod | undefined;
      if (id !== undefined) {
        target = candidates.find((pod) => pod.id.toLowerCase() === id.toLowerCase());
        const named = target ? [] : candidates.filter((pod) => pod.name === id);
        const referenced = target || named.length > 0 ? [] : candidates.filter((pod) => matchesRef(pod.id, id));
        const matches = target ? [target] : named.length > 0 ? named : referenced;
        if (matches.length > 1) {
          const refs = matches.map((pod) => displayRef(pod.id, "pod"));
          const counts = new Map<string, number>();
          for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
          const choices = matches.map((pod, index) => {
            const ref = refs[index]!;
            return `  ${counts.get(ref)! > 1 ? pod.id : ref}  ${pod.name}  (${pod.state})`;
          });
          runtime.bridge.notify(
            `"${id}" matches ${matches.length} pods — use a longer ref:\n${choices.join("\n")}`,
            "warning",
          );
          return;
        }
        target = matches[0];
        if (!target) {
          runtime.bridge.notify(`no pod matches "${id}"`, "warning");
          return;
        }
      } else {
        if (candidates.length === 0) {
          runtime.bridge.notify("no pods to switch to", "info");
          return;
        }
        const refs = candidates.map((pod) => displayRef(pod.id, "pod"));
        const counts = new Map<string, number>();
        for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
        const labels = candidates.map((p, index) => {
          const ref = refs[index]!;
          const label = `${counts.get(ref)! > 1 ? p.id : ref}  ${p.name}  ${podStatusLabel(p)}`;
          return p.id === rpc.podId ? `${label} (current)` : label;
        });
        const choice = await runtime.bridge.ui?.select?.("Switch to pod", labels);
        if (choice === undefined) return;
        target = candidates[labels.indexOf(choice)];
        if (!target) return;
      }
      if (target.id === rpc.podId) {
        runtime.bridge.notify("already attached to that pod", "info");
        return;
      }
      runtime.bridge.notify(`switching to pod ${displayRef(target.id, "pod")}…`, "info");
      try {
        await rpc.switchTo(target.id);
        readinessPod = target;
        await ensureExactPi({
          client: opts.client,
          pod: target,
          rpc,
          interactive: true,
          approve: approvePiUpdate,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        runtime.bridge.notify(
          /staying on/.test(message) ? message : `${message} — reattach with \`pipod attach\``,
          "error",
        );
        if (rpc.podId === target.id) {
          rpc.close();
          runtime.bridge.setIntent({ kind: "transportLost" });
          runtime.bridge.requestShutdown();
        }
        return;
      }
      // Notices staged until after the reseed: refreshAfterReplacement rebuilds the
      // transcript and erases anything notified before it.
      const postSwitchNotices: Array<{ message: string; type: "info" | "warning" }> = [];
      if (podSync) {
        // Sync the target before the TUI reseeds; on any non-applied outcome the pipeline
        // has already fallen back to host-only settings — never pod A's against pod B.
        const outcome = await podSync.sync("switch");
        const notice = podConfigSyncNotice(outcome);
        if (notice) postSwitchNotices.push(notice);
        if (localRenderingActive) {
          // Loaded code cannot be unloaded; a differing attested set stops being consulted.
          const targetAttested = attestedPackages(target.resolvedConfig.piSettings).specs;
          const sameSet =
            targetAttested.length === attestedSpecs.length &&
            targetAttested.every((spec) =>
              attestedSpecs.some((a) => a.name === spec.name && a.version === spec.version),
            );
          if (!sameSet) {
            localRenderingActive = false;
            await runtime.disableLocalExtensions();
            postSwitchNotices.push({
              message: "the new pod's extension set differs — pod extension rendering is off until you reattach",
              type: "info",
            });
          }
        }
        if (outcome.kind === "applied" && localRenderingActive) {
          const message = unattestedPackageNotice(outcome.extensions, attestedSpecs);
          if (message) postSwitchNotices.push({ message, type: "warning" });
        }
      }
      footerContext?.setWorkdir(target.resolvedConfig.workdir ?? "remote pod workdir");
      await runtime.refreshAfterReplacement();
      modeUi?.requestRender?.(true);
      if (postSwitchNotices.length > 0) {
        // Notified on a short delay: anything sent while the reseed is still repainting
        // lands in a surface the rebind throws away (the pre-switch "switching to" notice
        // has always been lost this way).
        setTimeout(() => {
          for (const notice of postSwitchNotices) runtime.bridge.notify(notice.message, notice.type);
          modeUi?.requestRender?.(true);
        }, 750);
      }
      const compatibilityWarning = shimCompatibilityWarning(rpc.helloInfo?.shimVersion ?? "");
      if (compatibilityWarning) runtime.bridge.notify(compatibilityWarning, "warning");
      runtime.bridge.notify(`switched to pod ${displayRef(target.id, "pod")} (${target.project ?? target.name})`, "info");
    } catch (e) {
      runtime.bridge.notify(`switch failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      switching = false;
    }
  };

  let unwireChords: () => void = () => {};
  let unwireDisconnectedQuit: () => void = () => {};
  let mode: InstanceType<typeof import("@earendil-works/pi-coding-agent").InteractiveMode>;
  // Seeding and building the TUI is the one stretch with a live socket and nothing to close
  // it: no UI has bound, so no ending can fire, and an unreported failure here would leave
  // the process alive on an open gateway connection long after the error was printed.
  try {
    await runtime.init();

    const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
    const { wirePodChords } = await import("../client/runtime/chords.js");

    const chords = context.config.pi.chords;
    runtime.bridge.setOnUiBound(() => {
      unwireChords();
      unwireDisconnectedQuit();
      unwireChords = wirePodChords(runtime.bridge, runtime.router, chords);
      unwireDisconnectedQuit = wireDisconnectedQuit(
        runtime.bridge,
        () => connectionAllowsQuit(latestConnectionState),
      );
    });

    const tuiMode = opts.tuiMode ?? tuiModeFromArgv(context.config.pi.args);
    // This pi is the one pi pod bundles, pinned to the server's: "run pi update" cannot apply.
    // `pipod update` is the upgrade path.
    process.env["PI_SKIP_VERSION_CHECK"] ??= "1";
    mode = new InteractiveMode(runtime.runtimeHost as never, {
      ...(opts.startupPrompt !== undefined ? { initialMessage: opts.startupPrompt } : {}),
      ...(tuiMode ? { tuiMode } : {}),
    });
    installPodTerminalTitle(mode as never);
    installPodCommandOverrides(
      mode,
      runtime,
      rpc,
      () => readinessPod.resolvedConfig.workdir ?? context.config.workdir,
    );
    const modeInternals = mode as unknown as AccountFooterInternals & {
      ui?: { stop(): void; start(): void; requestRender?(force?: boolean): void };
      editor?: { setText(text: string): void };
    };
    footerContext = bindAccountFooterContext(
      modeInternals,
      opts.pod.resolvedConfig.workdir ?? context.config.workdir,
      () => runtime.cache.hiddenUsage,
    );
    modeUi = modeInternals.ui ?? null;
    runtime.cache.onRefreshed = () => modeUi?.requestRender?.();
    modeEditor = modeInternals.editor ?? null;
    await runtime.healStreamingRenderer();
  } catch (error) {
    asleepWake.dispose();
    runtime.bridge.setOnUiBound(null);
    unwireChords();
    unwireDisconnectedQuit();
    rpc.close();
    derived?.dispose();
    throw error;
  }

  // Same exit interception as the local path: InteractiveMode ends in process.exit(0), but
  // the launcher still has server lifecycle calls to make and an exit code to report.
  const realExit = process.exit.bind(process) as (code?: number) => never;
  const patchedExit = ((code?: number) => {
    if (ending) return undefined as never;
    return realExit(code);
  }) as typeof process.exit;
  process.exit = patchedExit;

  try {
    const modeRun = mode.run();
    process.prependListener("SIGHUP", onHangUp);
    process.prependListener("SIGTERM", onHangUp);
    void modeRun.catch((e: unknown) => {
      warn(`the TUI failed: ${e instanceof Error ? e.message : String(e)}`);
      runtime.bridge.setIntent({ kind: "transportLost" });
      runtime.bridge.requestShutdown();
    });
    await endingPromise;
  } finally {
    asleepWake.dispose();
    if (!ending) process.exit = realExit;
    runtime.bridge.setOnUiBound(null);
    unwireChords();
    unwireDisconnectedQuit();
    process.off("SIGHUP", onHangUp);
    process.off("SIGTERM", onHangUp);
  }

  const result = await applyEnding(opts, context.config, ending!, serverEndReason, rpc.podId);
  // InteractiveMode counts on the process.exit(0) this launcher swallows to collect the
  // TUI handles its shutdown leaks (the custom-themes FSWatcher, raw stdin), so the event
  // loop never drains on its own — flush the goodbye lines and exit explicitly.
  if (process.stdout.writableLength > 0) {
    await new Promise((resolve) => process.stdout.once("drain", resolve));
  }
  if (process.stderr.writableLength > 0) {
    await new Promise((resolve) => process.stderr.once("drain", resolve));
  }
  return realExit(result.exitCode);
}

async function applyEnding(
  opts: AccountSessionOptions,
  config: PiPodConfig,
  ending: { kind: string; action: "keep" | "archive" | null; exitCode: number | null },
  serverEndReason: string | null,
  activePodId: string,
): Promise<AccountSessionResult> {
  const podRef = displayRef(activePodId, "pod");
  switch (ending.kind) {
    case "leave": {
      if (ending.action === "archive") {
        const archived = await opts.client.podCommand(activePodId, "archive");
        info(
          archived.message ??
            `pod ${podRef} hidden from active lists; provider compute and durable archival follow the configured idle/retention policy`,
        );
        info(`restore to active lists with: pipod restore ${podRef}`);
        return { exitCode: 0, podAction: "archived" };
      }
      info(`detached — pod ${podRef} keeps running (\`pipod attach\` to return; the server reaps idle pods)`);
      return { exitCode: 0, podAction: "none" };
    }
    case "quit":
      return applyAccountQuitPolicy({ activePodId, exitCode: ending.exitCode ?? 0 });
    case "hangup":
      return { exitCode: 0, podAction: "none" };
    default:
      for (const line of accountSessionLossNotice(activePodId, serverEndReason)) info(line);
      return { exitCode: 1, podAction: "none" };
  }
}

/**
 * Quit is a detach, never a lifecycle event: the pod keeps processing and the server's idle
 * policy (or an explicit `pipod stop`) reclaims it. What used to be `autoStopOnExit` /
 * `--keep` is retired — a host running co-located workers must never die because one client
 * closed its terminal.
 */
export function applyAccountQuitPolicy(opts: {
  activePodId: string;
  exitCode: number;
}): AccountSessionResult {
  const podRef = displayRef(opts.activePodId, "pod");
  info(`session ended — pod ${podRef} keeps running (the server reaps idle pods; \`pipod stop ${podRef}\` stops it now)`);
  info(`return with: pipod attach ${podRef}`);
  return { exitCode: opts.exitCode, podAction: "none" };
}

// ---------------------------------------------------------------------------
// Headless: `pipod send` and piped launches (§7)
// ---------------------------------------------------------------------------

async function runAccountHeadless(opts: AccountSessionOptions): Promise<AccountSessionResult> {
  let lost = false;
  let hangup = false;
  let serverEndReason: string | null = null;
  let resolveGone!: () => void;
  const gone = new Promise<null>((resolve) => {
    resolveGone = () => resolve(null);
  });
  // A settle event can land while the gateway is being replaced. Reconcile Pi's current
  // state after reconnect so a completed one-shot cannot wait forever for the missed event.
  let resolveRecoveredIdle!: () => void;
  const recoveredIdle = new Promise<null>((resolve) => {
    resolveRecoveredIdle = () => resolve(null);
  });
  let rpc!: GatewayRpcClient;
  rpc = await connectClient(opts, {
    onRecovered: async () => {
      await ensureExactPi({ client: opts.client, pod: opts.pod, rpc, interactive: false });
      const state = await rpc.getState();
      if (!state.isStreaming && !state.isCompacting) resolveRecoveredIdle();
    },
    onLost: () => {
      lost = true;
      resolveGone();
    },
    onSessionEnded: (reason) => {
      // Idle-stop / archive is not a terminal loss: a send is an explicit user action, so
      // the transport wakes rather than exiting. Only unavailable endings abort the one-shot.
      if (reason === "pi_exit") {
        serverEndReason = reason;
        resolveGone();
        return;
      }
      serverEndReason = reason;
      resolveGone();
    },
    onConnectionState: (state) => {
      if (state.kind === "asleep") void rpc.wake().catch(() => {});
    },
  }, { interactive: false });

  const onHangUp = () => {
    hangup = true;
    rpc.close();
    resolveGone();
  };
  process.on("SIGHUP", onHangUp);
  process.on("SIGTERM", onHangUp);
  try {
    if (opts.startupPrompt === undefined) {
      // Nothing to send and nothing to render: connecting proved the pod answers.
      info("connected; nothing to send (pass a prompt) — detaching");
      return { exitCode: 0, podAction: "none" };
    }
    const loaded = opts.config && opts.hostCwd ? undefined : await opts.loadContext?.();
    const config = opts.config ?? loaded?.config;
    if (!config) throw new Error("account session has no resolved config");
    // One-shot prompts name host files the pod cannot see; attach them inline like the
    // TUI path does. Omission warnings go to stderr — there is no TUI to notify.
    const hostCwd = opts.hostCwd ?? loaded?.hostCwd ?? process.cwd();
    const prepared = await preparePromptImages(opts.startupPrompt, {
      cwd: hostCwd,
      notify: (message) => (opts.stderr ?? process.stderr).write(`${message}\n`),
    });
    const completion = await Promise.race([
      runHeadless({
        rpc,
        prompt: prepared.text,
        images: prepared.images,
        stdout: opts.stdout ?? process.stdout,
        stderr: opts.stderr ?? process.stderr,
      }).then(
        (exitCode) => ({ kind: "exit", exitCode } as const),
        (error: unknown) => ({ kind: "error", error } as const),
      ),
      gone.then(() => ({ kind: "gone" } as const)),
      recoveredIdle.then(() => ({ kind: "recoveredIdle" } as const)),
    ]);
    if (serverEndReason !== null) {
      for (const line of accountSessionLossNotice(rpc.podId, serverEndReason)) info(line);
    }
    if (lost || serverEndReason !== null) return { exitCode: 1, podAction: "none" };
    if (completion.kind === "error") throw completion.error;
    if (hangup || completion.kind === "gone") return { exitCode: 0, podAction: "none" };
    return applyAccountQuitPolicy({
      activePodId: rpc.podId,
      exitCode: completion.kind === "exit" ? (completion.exitCode ?? 0) : 0,
    });
  } finally {
    process.off("SIGHUP", onHangUp);
    process.off("SIGTERM", onHangUp);
    rpc.close();
  }
}

export async function waitForPodReady(
  client: AccountClient,
  podId: string,
  timeoutMs: number,
): Promise<ApiPod> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const polledAt = Date.now();
    const pod = await client.getPod(podId, { waitMs: 20_000 });
    if (pod.ready) return pod;
    if (pod.stateReason) {
      throw new PiPodError(`pod ${displayRef(podId, "pod")} failed: ${pod.stateReason}`);
    }
    if (Date.now() > deadline) {
      throw new PiPodError(`pod ${displayRef(podId, "pod")} did not become ready in time`);
    }
    // Older servers ignore the long poll and answer at once; only they need pacing.
    const elapsed = Date.now() - polledAt;
    if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
  }
}
