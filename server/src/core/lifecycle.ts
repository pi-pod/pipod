/**
 * src/lifecycle.ts — phases 1–6 (§6), orchestrated purely against `SandboxProvider`.
 *
 * Phases 1–4 are cancellable with Ctrl-C; any cancellation or failure after CREATE runs the
 * same teardown path as a normal exit (§9), so a half-provisioned pod never lingers.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadedConfig, PiConfig, PiPodConfig } from "./config.js";
import { CancelledError, PiPodError, errorMessage } from "./errors.js";
import { buildHostsEntries, renderHostsFile } from "./egress.js";
import {
  POD_PI_AGENT_DIR,
  hostHome,
  hostPiAuthPath,
  installHostPackages,
  sanitizePiAuthContents,
  uploadHostConfig,
  withPackages,
} from "./hostconfig.js";
import { runInitScript } from "./initscript.js";
import {
  LABEL_HOST_USER,
  LABEL_ENV_RECIPE,
  LABEL_PTY,
  LABEL_PROJECT,
  LABEL_UI,
  LABEL_WORKDIR,
  MANAGED_BY_KEY,
  MANAGED_BY_VALUE,
  buildLabels,
  creationMarkers,
  hostUserLabel,
  ptySessionLabel,
  runtimeMarkers,
  sessionNameLabel,
} from "./labels.js";
import { rememberPodName } from "./podnames.js";
import { logicalPodState, rememberLogicalPodState } from "./podstate.js";
import { color, debug, hint as hintLine, info, phaseSummary, prefixedStreamer, resetPhaseTimings, step, timePhase, warn, withLiveness } from "./log.js";
import type { SessionPlan } from "./preflight.js";
import { effectivePlanEnv, rememberPodEnvSources, restorePodEnv } from "./podenv.js";
import { extractStartupPrompt } from "./client/headless.js";
import { buildPodStatusLines } from "./client/podinfo.js";
import { chordHintsFor, podCommandNotice } from "./client/runtime/pod-commands.js";
import { mirroredSessionDir } from "./client/mirror.js";
import { runRpcSession, type PodListEntry, type SwitchHost, type SwitchTarget } from "./client/session.js";
import { AuthSync } from "./authsync.js";
import { runTuiSession, tuiChordNotice } from "./client/tui.js";
import { runRawShell } from "./client/shell.js";
import { ensurePodStarted, exactPodWorkdir, sortByActivity } from "./pods.js";
import { Teardown, type ReclaimAction, type TeardownResult } from "./teardown.js";
import type { Sandbox, SandboxInfo, SandboxProvider } from "./providers/types.js";
import { shellQuote } from "./providers/util.js";

/** Upper bound for an attached session heartbeat; short provider windows use a faster third. */
export const ACTIVITY_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
export function activityHeartbeatIntervalMs(idleTimeoutMinutes: number): number {
  if (idleTimeoutMinutes <= 0) return ACTIVITY_HEARTBEAT_INTERVAL_MS;
  return Math.min(
    ACTIVITY_HEARTBEAT_INTERVAL_MS,
    Math.max(5_000, Math.floor((idleTimeoutMinutes * 60_000) / 3)),
  );
}

/** The pod must reach `started` within this long or CREATE has failed. */
const START_TIMEOUT_MS = 5 * 60 * 1000;

/** Grace period a provider stop gets before it is given up on. */
const STOP_TIMEOUT_SECONDS = 300;

export const EXIT_CODE_FILE = "/tmp/pi-pod-exit-code";

/**
 * Tell the provider an attached session is active, in one place so `pi-pod` and
 * `pi-pod attach` cannot drift apart (§8). Ordinary traffic is a one-shot pulse; explicit
 * work such as an agent run or compaction is a sustained lease, because its model request
 * may be silent for longer than the provider's idle window.
 *
 * Provider time remains authoritative. An idle TUI does not refresh anything, while a busy
 * session refreshes once per tick until pi reports that it settled. Calls are serialized so
 * a slow provider cannot accumulate overlapping refresh requests.
 */
export const KEEPALIVE_SCRIPT_PATH = "/tmp/pi-pod-keepalive.cjs";
export const KEEPALIVE_LOG_PATH = "/tmp/pi-pod-keepalive.log";
export const KEEPALIVE_READY_PATH = "/tmp/pi-pod-keepalive.ready";

export interface PodKeepaliveOptions {
  env: Record<string, string>;
  piCommand: string;
  idleTimeoutMinutes: number;
}

/**
 * Start the provider's in-pod keepalive watcher (§8).
 *
 * The client-side heartbeat below vouches for the session only while a client is attached;
 * this is the half that outlives the client. It runs *inside* the pod, watches for pi
 * actually working, and refreshes the provider's activity clock with the credential the pod
 * now carries (§7.3) — so a detached or disconnected pod lives exactly as long as its work,
 * and still reclaims itself on schedule once the work is done.
 *
 * Idempotent (the script exits when one is already running), so it is started on every
 * launch and every attach rather than tracked. Best-effort: a pod without it still works,
 * but a detached pod mid-task is stopped when the idle window expires — worth a warning,
 * not a failed session.
 */
export async function startPodKeepalive(
  sandbox: Sandbox,
  provider: SandboxProvider,
  options: PodKeepaliveOptions,
): Promise<boolean> {
  if (typeof provider.keepaliveScript !== "function") return false;
  try {
    const script = provider.keepaliveScript(sandbox.id, {
      piCommand: options.piCommand,
      idleTimeoutMinutes: options.idleTimeoutMinutes,
    });
    await sandbox.uploadFile(KEEPALIVE_SCRIPT_PATH, new TextEncoder().encode(script));
    const started = await sandbox.exec(
      [
        "bash",
        "-lc",
        `rm -f ${KEEPALIVE_READY_PATH}; ` +
          `setsid node ${KEEPALIVE_SCRIPT_PATH} >> ${KEEPALIVE_LOG_PATH} 2>&1 < /dev/null & watcher=$!; ` +
          `for _ in $(seq 1 50); do ` +
          `[ -s ${KEEPALIVE_READY_PATH} ] && exit 0; ` +
          `kill -0 "$watcher" 2>/dev/null || { wait "$watcher"; exit $?; }; ` +
          `sleep 0.1; done; exit 1`,
      ],
      { env: options.env, timeoutMs: 30_000 },
    );
    if (started.exitCode !== 0) {
      throw new Error(`watcher exited before readiness (exit ${started.exitCode})`);
    }
    return true;
  } catch (e) {
    warn(
      `could not start the in-pod keepalive: ${errorMessage(e)} — ` +
        "a detached pod will idle-stop even while pi is working",
    );
    return false;
  }
}

export interface SessionHeartbeat {
  stop(): void;
  noteActivity(): void;
  setBusy(busy: boolean): void;
}

export function startSessionHeartbeat(sandbox: Sandbox, idleTimeoutMinutes: number): SessionHeartbeat {
  let sawActivity = false;
  let busy = false;
  let stopped = false;
  let refreshInFlight = false;
  let refreshQueued = false;

  const refresh = (): void => {
    if (stopped) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    void sandbox
      .refreshActivity()
      .catch((e) => debug(`activity heartbeat failed: ${errorMessage(e)}`))
      .finally(() => {
        refreshInFlight = false;
        if (stopped) {
          refreshQueued = false;
          return;
        }
        if (refreshQueued) {
          refreshQueued = false;
          refresh();
        }
      });
  };

  const timer = setInterval(() => {
    // Ordinary traffic refreshes immediately once per interval. Only a busy semantic lease
    // keeps renewing when the channel is otherwise silent.
    sawActivity = false;
    if (busy) refresh();
  }, activityHeartbeatIntervalMs(idleTimeoutMinutes));
  timer.unref?.();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    noteActivity: () => {
      if (stopped || sawActivity) return;
      sawActivity = true;
      // A one-minute window cannot wait for the next periodic tick after its first frame.
      refresh();
    },
    setBusy: (next) => {
      if (stopped || busy === next) return;
      busy = next;
      if (busy) refresh();
    },
  };
}

// ---------------------------------------------------------------------------
// Multi-pod session management — the host half (§6.4)
// ---------------------------------------------------------------------------

/**
 * The pod the TUI is currently driving. /pod switch replaces every field; the ending path
 * and the heartbeat read the current pod through this rather than the launch-time one.
 */
export interface ActivePod {
  sandbox: Sandbox;
  podId: string;
  workdir: string;
  project: string;
  /** Effective environment for every new process in the currently active pod. */
  env: Record<string, string>;
  heartbeat: SessionHeartbeat;
  teardown: Teardown;
}

/** A pod switched away from, remembered for the aggregated exit notice (§6.4). */
export interface KeptPod {
  podId: string;
  idleTimeoutMinutes: number;
  archiveAfterMinutes: number | null;
}

/**
 * Build the provider-control-plane half of /pod list and /pod switch (§6.4). Lifecycle acts
 * on `active` by reference: the ending path then applies to whichever pod the session ended
 * on, and every switched-away pod lands in `keptPods` for the exit notice.
 */
export function buildSwitchHost(args: {
  provider: SandboxProvider;
  config: PiPodConfig;
  active: ActivePod;
  keptPods: Map<string, KeptPod>;
  autoStop: boolean;
  /** Resolve current host values before a provider starts any process in a resumed pod. */
  restoreEnv?: (target: SandboxInfo) => Promise<Record<string, string>>;
  /** Renewed borrowed credentials follow the session across switches (§7.4). */
  authSync?: AuthSync | null;
  /** Test/embedding seam for machine-local logical metadata. */
  stateHome?: string | null;
}): SwitchHost {
  const { provider, config, active, keptPods } = args;

  const listMine = async () => {
    const user = hostUserLabel();
    const mine = (
      await provider.list({ [MANAGED_BY_KEY]: MANAGED_BY_VALUE, [LABEL_HOST_USER]: user })
    ).filter(
      (s) =>
        s.labels[MANAGED_BY_KEY] === MANAGED_BY_VALUE &&
        s.labels[LABEL_HOST_USER] === user &&
        s.state !== "gone" &&
        s.state !== "error" &&
        logicalPodState(provider.name, s.id, args.stateHome) === "active",
    );
    return sortByActivity(mine);
  };

  return {
    listPods: async (): Promise<PodListEntry[]> =>
      (await listMine()).map((pod) => {
        // Readiness is useful for cost-setting, but provider lifecycle vocabulary stays internal.
        const readiness = pod.state === "started" ? "ready" : "starts automatically";
        const project = pod.labels[LABEL_PROJECT] ?? "?";
        return { id: pod.id, label: `${pod.id}  ${project}  active — ${readiness}` };
      }),

    resolveTarget: async (id: string): Promise<SwitchTarget | null> => {
      const pods = await listMine();
      const info = pods.find((p) => p.id === id) ?? pods.find((p) => p.id.startsWith(id));
      if (!info) return null;
      // Validate the target before changing provider state: an invalid label must not resume a
      // stopped pod or start its keepalive only to return null afterwards.
      const workdir = exactPodWorkdir(info.labels[LABEL_WORKDIR], config.workdir);
      const sandbox = await provider.get(info.id, { workdir });
      if (!sandbox) return null;

      const needsRehydration = provider.capabilities.environmentPersistence === "rehydrate";
      if (needsRehydration && !args.restoreEnv) {
        throw new PiPodError(`provider ${provider.name} requires environment restoration before resume`);
      }
      const restoredEnv = needsRehydration ? await args.restoreEnv!(info) : {};
      await ensurePodStarted(sandbox, info, SWITCH_START_TIMEOUT_MS);
      if (needsRehydration) sandbox.rehydrateEnv(restoredEnv);
      const env = { ...restoredEnv, ...runtimeMarkers(sandbox.id) };
      const idleTimeoutMinutes = idleTimeoutFor(provider, config.idleTimeoutMinutes);
      await startPodKeepalive(sandbox, provider, {
        env,
        piCommand: config.pi.command,
        idleTimeoutMinutes,
      });

      // Cross-project pods are allowed — the workdir comes from the pod's own labels,
      // exactly as attach reads them (§6.4). The value-free host recipe supplies that pod's
      // original env sources rather than borrowing secrets from the current project.
      return {
        podId: sandbox.id,
        sandbox,
        workdir,
        project: info.labels[LABEL_PROJECT] ?? "?",
        env,
        piArgv: buildPiArgv(config.pi, ["--continue"]),
        sessionNaming: config.pi.sessionNaming,
        ptySessionId: info.labels[LABEL_PTY],
      };
    },

    onSwitched: async (previousPodId: string, target: SwitchTarget, ptySessionId: string): Promise<void> => {
      // Commit lifecycle identity as one synchronous step. The old heartbeat is stopped only
      // after the RPC/TUI transaction has accepted the target.
      active.heartbeat.stop();
      keptPods.set(previousPodId, {
        podId: previousPodId,
        idleTimeoutMinutes: idleTimeoutFor(provider, config.idleTimeoutMinutes),
        archiveAfterMinutes: effectiveArchiveAfterMinutes(provider, config.archiveAfterMinutes),
      });
      // Returning to a pod removes its old left-running disposition and deduplicates cycles.
      keptPods.delete(target.podId);
      // The credential the target pod holds was copied at *its* launch — possibly hours ago.
      // Join the sync so this session's renewals reach it too (§7.4).
      args.authSync?.track(target.sandbox);

      active.sandbox = target.sandbox;
      active.podId = target.podId;
      active.workdir = target.workdir;
      active.project = target.project;
      active.env = target.env;
      active.heartbeat = startSessionHeartbeat(
        target.sandbox,
        idleTimeoutFor(provider, config.idleTimeoutMinutes),
      );
      active.teardown = new Teardown({
        sandbox: target.sandbox,
        autoStop: args.autoStop,
        stopTimeoutSeconds: STOP_TIMEOUT_SECONDS,
        checkUnpushed: false,
      });
      await target.sandbox
        .setLabels(ptySessionLabel(ptySessionId))
        .catch((e) => debug(`could not record the pi session id: ${errorMessage(e)}`));
    },
  };
}

/** A switch target may be archived; cold storage restores are slow (§6.4). */
const SWITCH_START_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunSessionOptions {
  plan: SessionPlan;
  provider: SandboxProvider;
  /** Extra args passed through to the remote pi (§5). */
  piArgs: string[];
  /** `--keep`: do not stop the pod on exit. */
  keep: boolean;
  /** §6.5: reuse this project's newest stopped pod; unsafe candidates fall back to create. */
  reuse?: boolean;
  /** `--no-shell`: do not open a recovery shell when pi exits unexpectedly (§8). */
  noShell: boolean;
  /** UI mode (§5.7): true forces the remote TUI, false forces RPC; absent = TUI on a TTY. */
  remoteTui?: boolean;
  /** Test seam: attach to something other than the process's own terminal. */
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

const PROJECT_TRUST_ARGS = new Set(["--approve", "-a", "--no-approve", "-na"]);

/**
 * Build the remote pi command, trusting the cloned workspace unless config or the invocation
 * explicitly chooses otherwise. The pod is the isolation boundary, so making the user approve
 * project-local resources again inside it adds friction without adding a host trust boundary.
 *
 * The default comes before configured and per-run args, preserving their ordinary precedence.
 */
export function buildPiArgv(
  config: Pick<PiConfig, "command" | "args"> & Partial<Pick<PiConfig, "model" | "thinking">>,
  ...argGroups: string[][]
): string[] {
  // Dedicated defaults come after the escape-hatch args, while invocation groups remain last.
  // This gives all three surfaces a deterministic order: pi.args → settings → per-launch.
  const configuredSelection = [
    ...(config.model != null ? ["--model", config.model] : []),
    ...(config.thinking != null ? ["--thinking", config.thinking] : []),
  ];
  const args = [...config.args, ...configuredSelection, ...argGroups.flat()];
  const trustArgs = args.some((arg) => PROJECT_TRUST_ARGS.has(arg)) ? [] : ["--approve"];
  return [config.command, ...trustArgs, ...args];
}

/**
 * `--continue` for a fresh pi in a pod that has been here before (§8).
 *
 * A stopped pod loses its processes but not its disk, and pi's sessions live on that disk —
 * so the *conversation* survives every stop even though the process does not. pi treats
 * `--continue` with nothing to continue as an ordinary fresh start (verified against the
 * bundled pi: per-directory lookup, exit 0), which is what makes it safe to pass without
 * first divining whether a session exists. Withheld only when the caller is already steering
 * sessions themselves — a `--resume` or `--session` of their own must win uncontested.
 */
export function continueArgs(config: PiPodConfig, piArgs: string[]): string[] {
  const steering = ["--continue", "-c", "--resume", "-r", "--session", "--session-id", "--fork", "--no-session"];
  const given = [...config.pi.args, ...piArgs];
  const hasSessionChoice = steering.some((flag) =>
    given.some((arg) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`))),
  );
  return hasSessionChoice ? [] : ["--continue"];
}

/**
 * Whether an unexpected remote pi exit may land the user in a recovery shell in the clone
 * rather than ending the session immediately (§2, §6.2).
 *
 * Gated on a TTY as well as on `--no-shell`. A piped or scripted `pi-pod` has nobody to type
 * `exit`, so a shell prompt there is not a courtesy — it is a run that never tears down, on a
 * pod that keeps billing until the idle timer notices.
 */
export function shellOnExitFor(opts: {
  noShell: boolean;
  stdin?: NodeJS.ReadStream | undefined;
}): boolean {
  if (opts.noShell) return false;
  return (opts.stdin ?? process.stdin).isTTY === true;
}

/** The post-exit shell recovers unexpected pi exits; an explicit quit ends the session. */
export function shouldOpenPostExitShell(
  end: { piExited: boolean; quitRequested: boolean },
  shellOnExit: boolean,
): boolean {
  return end.piExited && !end.quitRequested && shellOnExit;
}

/** What the user asked to happen to the logical pod as they left. */
export type DetachAction = "keep" | "archive";

export interface SessionResult {
  exitCode: number;
  podId: string;
  /** The pod was shut down on the way out; its disk (and the clone) are still there. */
  stopped: boolean;
  /** The pod's disk was also moved to cold storage. Implies `stopped`. */
  archived: boolean;
  detached: boolean;
}

/** What the end of a session means for the pod. */
export interface SessionEnding {
  /** User archive is logical; stop is reachable only through automatic exit policy. */
  pod: "keep" | ReclaimAction;
  /**
   * Whether pi itself ended the session, as opposed to the client leaving. Only this case can
   * carry a meaningful failure: an unknown exit code means something went wrong when pi exited,
   * and means nothing at all when the user walked away.
   */
  piExited: boolean;
  reason: string;
}

/**
 * Decide what the end of an attached session means for the pod (§8).
 *
 * The distinction is who ended it, and what they said on the way out. pi exiting is the session
 * being *over*, and the pod has served its purpose. A closed terminal or a dropped transport is
 * only the *client* going away, and reclaiming the pod for that would throw away work the user
 * never said they were finished with — so those keep it running and let the idle timer decide.
 *
 * `/pod detach` leaves the logical pod active; `/pod archive` explicitly archives it. Neither
 * requests a provider stop or cold-storage transition.
 */
export function classifySessionEnd(result: {
  detached: boolean;
  detachAction?: DetachAction | null;
  hungUp: boolean;
  transportLost: boolean;
}): SessionEnding {
  if (result.detached) {
    // An absent action is the plain detach: every path that reports a detach without a
    // specific request behind it.
    switch (result.detachAction ?? "keep") {
      case "archive":
        return { pod: "archive", piExited: false, reason: "detached, and archived the logical pod" };
      default:
        return { pod: "keep", piExited: false, reason: "detached from the pi session" };
    }
  }
  if (result.hungUp) return { pod: "keep", piExited: false, reason: "terminal closed" };
  if (result.transportLost) {
    return { pod: "keep", piExited: false, reason: "connection to the pi session was lost" };
  }
  return { pod: "stop", piExited: true, reason: "pi exited" };
}

/** A transport failure is a launcher failure even when no remote pi status was available. */
export function sessionExitCode(
  result: { exitCode: number | null; transportLost: boolean },
  ending: Pick<SessionEnding, "piExited">,
): number {
  if (result.transportLost && (result.exitCode ?? 0) === 0) return 1;
  return result.exitCode ?? (ending.piExited ? 1 : 0);
}

/** Apply session disposition without allowing a client command to mutate provider state. */
export async function applySessionEnding(
  ending: SessionEnding,
  teardown: Teardown,
  archiveLogical?: () => void,
): Promise<TeardownResult> {
  if (ending.pod === "keep") return teardown.keep(ending.reason);
  if (ending.pod === "stop") return teardown.run();
  const kept = await teardown.keep(ending.reason);
  archiveLogical?.();
  return { ...kept, archived: true };
}

export async function runSession(opts: RunSessionOptions): Promise<SessionResult> {
  const { plan, provider } = opts;
  const config = plan.config;
  const createdAtMs = Date.now();

  // §5.7: the remote TUI is the default session UI on a terminal; RPC is the fallback for
  // non-TTY runs and the explicit choice behind --no-remote-tui. Settled before the pod
  // exists so an impossible ask fails without creating anything.
  const interactive = (opts.stdin ?? process.stdin).isTTY === true && (opts.stdout ?? process.stdout).isTTY === true;
  if (opts.remoteTui === true && !interactive) {
    throw new PiPodError("--remote-tui needs an interactive terminal", {
      hint: "non-TTY runs use the headless renderer over RPC — drop --remote-tui",
    });
  }
  const remoteTui = opts.remoteTui ?? interactive;

  const hostConfigForPod = plan.hostConfig;

  // --- phase 1: CREATE -----------------------------------------------------
  const labels = buildLabels({
    project: plan.project,
    createdAtMs,
    workdir: plan.workdir,
    extra: config.labels,
  });
  if (provider.capabilities.environmentPersistence === "rehydrate") {
    labels[LABEL_ENV_RECIPE] = "1";
  }
  if (remoteTui) labels[LABEL_UI] = "tui";

  const markers = creationMarkers({
    provider: provider.name,
    project: plan.project,
    image: config.image,
    createdAtMs,
    egress: plan.egress.description,
    term: process.env["TERM"],
    colorterm: process.env["COLORTERM"],
  });

  // Sizing is only sent when the provider applies it per pod. Where sizing belongs to
  // the image (a per-image provider), it was baked in at `pi-pod image build` and sending it
  // here is a hard API error, not a no-op (§3.2, resourceSizing).
  const perSandboxSizing = provider.capabilities.resourceSizing === "per-sandbox";
  if (!perSandboxSizing) {
    debug(
      `resources are a property of the image on ${provider.name}: ` +
        `${config.resources.cpu} cpu / ${config.resources.memoryGB} GB / ${config.resources.diskGB} GB ` +
        `apply to ${config.image} when it is built, not to this pod`,
    );
  }

  // Ctrl-C anywhere in phases 1–4 must land in the same teardown path (§9) — including
  // during CREATE itself, the slowest step, where the default handler would exit and leak
  // the half-made pod. A second Ctrl-C force-quits; the pod is then `pi-pod gc`'s to find.
  // Once the PTY is attached this handler is removed: there, Ctrl-C is bytes for pi (§8).
  let interrupted = false;
  let interruptPodId: string | null = null;
  const onInterrupt = () => {
    if (interrupted) {
      warn(
        interruptPodId
          ? `force quit — pod ${interruptPodId} may still be running; reclaim it with \`pi-pod gc ${interruptPodId}\``
          : "force quit — a pod may have been created; a later run or `pi-pod gc` will reclaim it",
      );
      process.exit(130);
    }
    interrupted = true;
    warn("interrupted — finishing the current step, then tearing down (Ctrl-C again to force quit)");
  };
  process.on("SIGINT", onInterrupt);

  const effectiveEnv = effectivePlanEnv(plan);
  resetPhaseTimings();
  const launchStartedAt = Date.now();
  // --- phase 1b: REUSE (§6.5) ----------------------------------------------
  // Opt-in: this project's newest stopped pod comes back with its warm disk — node_modules,
  // baked extensions — so the idempotent init scripts re-run over it in seconds. Anything
  // unsafe (different image, missing env recipe) leaves that pod exactly as it was and falls
  // back to a fresh create.
  let reusedPod: ClaimedPod | null = null;
  if (opts.reuse === true) {
    reusedPod = await timePhase("reuse", () =>
      claimReusablePod(provider, plan, config).catch((e) => {
        warn(`could not reuse a pod: ${errorMessage(e)} — creating a fresh one`);
        return null;
      }),
    );
  }

  let sandbox: Sandbox;
  if (reusedPod) {
    sandbox = reusedPod.sandbox;
    interruptPodId = sandbox.id;
  } else {
    step("create", `${provider.name} pod from ${color.bold(config.image)}…`);
    try {
      sandbox = await timePhase("create", () =>
        withLiveness("creating the pod", () =>
          provider.create({
            image: config.image,
            workdir: plan.workdir,
            ...(perSandboxSizing ? { resources: config.resources } : {}),
            // Precedence is resolved once by preflight's layer maps. Creation markers are reserved
            // and win; runtime markers join after the provider returns the pod id.
            env: { ...effectiveEnv, ...markers },
            labels,
            archiveAfterMinutes: effectiveArchiveAfterMinutes(provider, config.archiveAfterMinutes) ?? 0,
            idleTimeoutMinutes: idleTimeoutFor(provider, config.idleTimeoutMinutes),
            egress: plan.egress.policy,
          }),
        ),
      );
    } catch (e) {
      process.off("SIGINT", onInterrupt);
      throw e;
    }
    interruptPodId = sandbox.id;

    // The label above promises this recipe exists. If the host cannot write it, stop the new pod
    // even under --keep: leaving it running would create a pod that advertises resumability but
    // cannot safely regain its secrets or creation markers after the first stop.
    try {
      rememberPodEnvSources(provider, sandbox.id, plan, markers);
    } catch (e) {
      process.off("SIGINT", onInterrupt);
      await sandbox
        .stop(STOP_TIMEOUT_SECONDS * 1000)
        .catch((stopError) => warn(`could not stop pod ${sandbox.id} after recipe write failed: ${errorMessage(stopError)}`));
      throw e;
    }
  }

  const teardown = new Teardown({
    sandbox,
    // Client quit is not a lifecycle event: pods stop by idling or an explicit stop.
    autoStop: false,
    stopTimeoutSeconds: STOP_TIMEOUT_SECONDS,
    checkUnpushed: false,
  });

  // A reused pod keeps its original creation markers, restored from the host recipe; a fresh
  // one gets this launch's. Runtime markers are per-run either way.
  const sandboxEnv = reusedPod
    ? { ...reusedPod.env }
    : { ...effectiveEnv, ...markers, ...runtimeMarkers(sandbox.id) };
  let heartbeat: SessionHeartbeat | null = null;
  let attachStarted = false;
  // Renews the pod's borrowed OAuth access tokens while the session runs (§7.4); null when
  // the host's auth.json is not traveling.
  let authSync: AuthSync | null = null;
  // Set once phase 5 begins; after a /pod switch it names the *current* pod, whose teardown
  // (not the launch pod's) is the one the exit paths must run (§6.4).
  let activeRef: ActivePod | null = null;

  try {
    if (reusedPod) {
      info(`pod ${color.bold(sandbox.id)} reused — warm disk`);
    } else {
      info(`pod ${color.bold(sandbox.id)} created`);
      throwIfInterrupted(interrupted);
      await timePhase("start", () =>
        withLiveness("waiting for the pod to start", () => sandbox.waitUntilStarted(START_TIMEOUT_MS), {
          expectation: "usually under a minute",
        }),
      );
    }
    throwIfInterrupted(interrupted);

    // Vouch for the session while it runs, so the idle timer does not stop it mid-use (§8).
    heartbeat = startSessionHeartbeat(sandbox, idleTimeoutFor(provider, config.idleTimeoutMinutes));

    // --- phase 2: WORKSPACE PREP -------------------------------------------
    // Create the empty workdir and seed /etc/hosts under an allowlist. What goes *into* the
    // workspace is entirely the init scripts' business (§4.3); a reused pod already has both.
    const prepChain = reusedPod
      ? Promise.resolve()
      : timePhase("prep", () => prepareWorkspace(sandbox, plan, sandboxEnv));

    // --- phase 3b: optional auth + host config (§7.4, §7.5) ----------------
    // Both resolved at preflight, on the host, before this pod existed — including whether
    // the credential is even there. Nothing here re-decides.
    const authTask = timePhase("auth", async (): Promise<AuthSync | null> => {
      let sync: AuthSync | null = null;
      if (plan.copyPiAuth) {
        const pushed = await copyPiAuth(sandbox, plan.hostHomePath);
        // §7.4: the pod's copy holds no refresh tokens, so the host renews it — preflight
        // minted the first fresh tokens, this keeps them coming for as long as a session is
        // attached. Switched-to pods join the sync in buildSwitchHost (§6.4).
        sync = new AuthSync({
          home: plan.hostHomePath,
          hostModel:
            plan.hostConfig.model?.model != null
              ? { provider: plan.hostConfig.model.provider, model: plan.hostConfig.model.model }
              : null,
        });
        sync.track(sandbox, pushed);
        sync.start();
      }
      return sync;
    });

    const configTask = timePhase("pi config", async () => {
      if (hostConfigForPod.uploads.length === 0) return;
      step("pi config", `${hostConfigForPod.items.join(", ")} → ${POD_PI_AGENT_DIR}`);
      // Extensions first, settings second: pi installs whatever `settings.packages` names on
      // its first run, and an install that exits non-zero takes pi down with it — the session
      // ends before the user sees a prompt. Doing it here makes the failure a value we can
      // read, so the worst case is a pi without extensions rather than no pi at all.
      const hostConfig = await installCarriedPackages(sandbox, hostConfigForPod, config);
      await uploadHostConfig(sandbox, hostConfig);
    });

    const settled = await Promise.allSettled([prepChain, authTask, configTask]);
    if (settled[1].status === "fulfilled") authSync = settled[1].value;
    for (const outcome of settled) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    throwIfInterrupted(interrupted);

    // --- phase 4: BAKE (live) + INIT --------------------------------------
    // Custom pins and reused disks that do not carry the current composed script
    // run it live here — same contract as an image bake: no secrets, cwd /root.
    if (plan.bake?.mode === "live") {
      step("bake", "running bake script live");
      await timePhase("bake", () => runLiveBake(sandbox, plan, config));
      throwIfInterrupted(interrupted);
    }

    // --- phase 4b: INIT ---------------------------------------------------
    const initHostPath = path.join(plan.projectRoot, config.initScript);
    if (fs.existsSync(initHostPath)) step("init", `running ${config.initScript}`);
    await timePhase("init", () =>
      runInitScript({
        sandbox,
        hostPath: initHostPath,
        workdir: plan.workdir,
        timeoutSeconds: config.initTimeoutSeconds,
        onFailure: config.initOnFailure,
        env: sandboxEnv,
        egressRestricted: plan.egress.policy.mode === "allowlist",
      }),
    );
    throwIfInterrupted(interrupted);

    // The watcher goes in as late as possible — after init, when the pod is about to be
    // worth vouching for — and before attach, so a session that ends in a hang-up minutes
    // from now is already covered.
    await timePhase("keepalive", () =>
      startPodKeepalive(sandbox, provider, {
        env: sandboxEnv,
        piCommand: config.pi.command,
        idleTimeoutMinutes: idleTimeoutFor(provider, config.idleTimeoutMinutes),
      }),
    );
    throwIfInterrupted(interrupted);

    // --- phase 5: ATTACH (§5, §6.1) ----------------------------------------
    // Interactive runs get pi's full TUI on the pod PTY unless --no-remote-tui asked for
    // the RPC wire; non-TTY runs always drive `pi --mode rpc` through the headless renderer.
    process.off("SIGINT", onInterrupt);
    attachStarted = true;
    info(color.dim(phaseSummary("pod ready", Date.now() - launchStartedAt)));
    const startup = extractStartupPrompt(opts.piArgs);
    const piArgv = buildPiArgv(config.pi, startup.args);
    const shellOnExit = shellOnExitFor(opts);

    // The pod the TUI drives; /pod switch replaces every field (§6.4).
    const active: ActivePod = activeRef = {
      sandbox,
      podId: sandbox.id,
      workdir: plan.workdir,
      project: plan.project,
      env: sandboxEnv,
      heartbeat: heartbeat!,
      teardown,
    };
    const keptPods = new Map<string, KeptPod>();
    const switchHost = buildSwitchHost({
      provider,
      config,
      active,
      keptPods,
      autoStop: false,
      authSync,
      restoreEnv: (target) =>
        restorePodEnv(
          {
            config,
            configPath: plan.configPath,
            userConfigPath: null,
            projectRoot: plan.projectRoot,
            imagePinned: true,
            warnings: [],
          } satisfies LoadedConfig,
          provider,
          target,
        ),
    });

    // Pi owns the session name; both UI transports mirror it onto the active pod. Keeping the
    // callback above the mode split prevents raw TUI and RPC from drifting again.
    const onSessionNamed = async (name: string) => {
      rememberPodName(active.sandbox.id, name);
      await active.sandbox
        .setLabels(sessionNameLabel(name))
        .catch((e) => debug(`could not record the session name: ${errorMessage(e)}`));
    };

    // The remote TUI (§5.7): pi's own TUI on the pod PTY, byte passthrough. The positional
    // prompt stays in argv — pi's interactive mode takes it directly — and the post-exit
    // shell runs remotely inside the wrapper, where the workspace is.
    if (remoteTui) {
      step("attach", `starting ${color.bold(piArgv.concat(startup.prompt !== undefined ? [startup.prompt] : []).join(" "))} (remote TUI)`);
      info(tuiChordNotice(config.pi.chords));
      const end = await runTuiSession({
        sandbox,
        piArgv: piArgv.concat(startup.prompt !== undefined ? [startup.prompt] : []),
        cwd: plan.workdir,
        env: sandboxEnv,
        canReattach: provider.capabilities.ptyReattach,
        chords: config.pi.chords,
        sessionNaming: config.pi.sessionNaming,
        exitCodeFile: EXIT_CODE_FILE,
        shellOnExit,
        // The idle policy can stop the pod under this open terminal (§6.3): sleep in place,
        // and wake on the next keystroke — the disk kept the conversation, so the respawned
        // pi continues it rather than re-running the startup prompt.
        wake: {
          wakePod: async () => {
            await sandbox.start(SWITCH_START_TIMEOUT_MS);
            await startPodKeepalive(sandbox, provider, {
              env: sandboxEnv,
              piCommand: config.pi.command,
              idleTimeoutMinutes: idleTimeoutFor(provider, config.idleTimeoutMinutes),
            });
          },
          piArgv: buildPiArgv(config.pi, continueArgs(config, startup.args), startup.args),
        },
        onActivity: () => active.heartbeat.noteActivity(),
        onPtyOpened: async (id) => {
          await sandbox
            .setLabels(ptySessionLabel(id))
            .catch((e) => debug(`could not record the pi session id: ${errorMessage(e)}`));
        },
        onSessionNamed,
        ...(opts.stdin ? { stdin: opts.stdin } : {}),
        ...(opts.stdout ? { stdout: opts.stdout } : {}),
      });
      const ending = classifySessionEnd(end);
      const outcome = await applySessionEnding(ending, active.teardown, () =>
        rememberLogicalPodState(provider.name, active.podId, "archived"),
      );
      if (ending.pod === "keep" && !outcome.stopped) {
        reportKeptPod(active.podId, {
          idleTimeoutMinutes: idleTimeoutFor(provider, config.idleTimeoutMinutes),
          archiveAfterMinutes: effectiveArchiveAfterMinutes(provider, config.archiveAfterMinutes),
        });
      }
      return {
        exitCode: sessionExitCode(end, ending),
        podId: active.podId,
        stopped: outcome.stopped,
        archived: outcome.archived === true,
        detached: end.detached,
      };
    }

    step("attach", `starting ${color.bold(piArgv.join(" "))}`);
    if (interactive) info(podCommandNotice(chordHintsFor(config.pi.chords)));
    if (shellOnExit) info("if pi exits unexpectedly you will land in a recovery shell here");

    const end = await runRpcSession({
      sandbox,
      piArgv,
      cwd: plan.workdir,
      env: sandboxEnv,
      hostCwd: plan.projectRoot,
      exitCodeFile: EXIT_CODE_FILE,
      onActivity: () => active.heartbeat.noteActivity(),
      onWorkStateChange: (busy) => active.heartbeat.setBusy(busy),
      switchHost,
      chords: config.pi.chords,
      podHost: {
        status: async () =>
          buildPodStatusLines({
            podId: active.podId,
            provider: provider.name,
            state: await active.sandbox.state().catch(() => "unknown"),
            project: active.project,
            image: config.image,
            egress: plan.egress.description,
            idleTimeoutMinutes: idleTimeoutFor(provider, config.idleTimeoutMinutes),
            archiveAfterMinutes: effectiveArchiveAfterMinutes(provider, config.archiveAfterMinutes),
            createdAtMs,
          }),
      },
      // Recorded so a *later* `pi-pod attach` can rejoin this exact pi rather than starting
      // a second one beside it. Best-effort: a fresh pi in the same workspace is a worse
      // outcome than resuming, but not a broken one (§3.2).
      onPtyOpened: async (id) => {
        await sandbox
          .setLabels(ptySessionLabel(id))
          .catch((e) => debug(`could not record the pi session id: ${errorMessage(e)}`));
      },
      // Mirrored onto whichever pod the TUI is driving now — `active.sandbox`, not the one
      // captured at launch, since /pod switch moves it (§6.4).
      onSessionNamed,
      sessionNaming: config.pi.sessionNaming,
      startupPrompt: startup.prompt,
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      ...(opts.stdout ? { stdout: opts.stdout } : {}),
    });

    // A user who closes pi with Ctrl-C Ctrl-C, Ctrl-D, or /quit has ended the session and
    // expects the pod to stop. The optional shell is only a recovery path for an unexpected
    // remote pi exit, where the user did not ask to leave and may still need the workspace.
    // shellOnExitFor already gates on a stdin TTY — the one thing a trailing shell needs.
    if (shouldOpenPostExitShell(end, shellOnExit)) {
      info(`pi exited (${end.exitCode ?? "?"}). You are now in a shell in ${active.workdir}`);
      info(color.dim("type exit to end the session"));
      await runRawShell({ sandbox: active.sandbox, cwd: active.workdir, env: active.env }).catch((e) =>
        warn(`the post-exit shell failed: ${errorMessage(e)}`),
      );
    }

    // --- phase 6: TEARDOWN -------------------------------------------------
    // Applied to whichever pod the session *ended* on; pods switched away from were
    // already left as keep at switch time (§6.4).
    const ending = classifySessionEnd(end);
    const outcome = await applySessionEnding(ending, active.teardown, () =>
      rememberLogicalPodState(provider.name, active.podId, "archived"),
    );

    // The current pod is reported from its final disposition, never from switched-away history.
    keptPods.delete(active.podId);
    if (ending.pod === "keep" && !outcome.stopped) {
      // The *effective* window, not the configured one: on a provider that cannot auto-stop,
      // promising a 15-minute stop would be a bill the user never sees coming.
      reportKeptPod(active.podId, {
        idleTimeoutMinutes: idleTimeoutFor(provider, config.idleTimeoutMinutes),
        archiveAfterMinutes: effectiveArchiveAfterMinutes(provider, config.archiveAfterMinutes),
      });
    }
    reportSwitchedAwayPods(keptPods);
    reportMirroredSessions(active.podId);

    return {
      // Voluntary client endings have no remote status and succeed. A transport loss is an
      // unexpected launcher failure, even though it intentionally leaves a live pod untouched.
      exitCode: sessionExitCode(end, ending),
      podId: active.podId,
      stopped: outcome.stopped,
      archived: outcome.archived === true,
      detached: end.detached,
    };
  } catch (e) {
    // Any failure after CREATE runs the same teardown path (§6) — against the current pod.
    await (activeRef?.teardown ?? teardown).run().catch(() => {});
    throw e;
  } finally {
    (activeRef?.heartbeat ?? heartbeat)?.stop();
    authSync?.stop();
    if (!attachStarted) process.off("SIGINT", onInterrupt);
    // A teardown that already ran is a no-op; this covers the success path's early returns.
    await (activeRef?.teardown ?? teardown).run().catch(() => {});
  }
}

function throwIfInterrupted(interrupted: boolean): void {
  if (interrupted) throw new CancelledError("interrupted");
}

/**
 * What happens next to a pod we just decided to leave running.
 *
 * A background pod the user cannot find again, and cannot predict the cost of, is worse
 * than one that was reclaimed — so both the way back and what happens next are stated every time,
 * rather than left to the docs.
 */
/** Where the session mirror (§5.6) left this pod's transcript copy, if anything landed. */
export function reportMirroredSessions(podId: string): void {
  const dir = mirroredSessionDir(podId);
  if (dir) info(`session transcript copy: ${color.bold(dir)}`);
}

export function keptPodNotice(
  podId: string,
  config: { idleTimeoutMinutes: number; archiveAfterMinutes: number | null },
): string[] {
  const lines = [`reconnect with: pi-pod attach ${podId}`];
  if (config.idleTimeoutMinutes === 0) {
    lines.push(`idle auto-stop is off — run \`pi-pod gc\` to reclaim it when you are done`);
    return lines;
  }

  const stops = `provider auto-stop after ${config.idleTimeoutMinutes} min without activity (the disk survives)`;
  const archiveWindow =
    config.archiveAfterMinutes === null
      ? null
      : config.archiveAfterMinutes < 24 * 60
        ? `${config.archiveAfterMinutes} min`
        : `${config.archiveAfterMinutes / (24 * 60)} days`;
  lines.push(
    archiveWindow === null
      ? `${stops}; stop is already the provider's at-rest state, and no provider expiry is documented`
      : `${stops}; provider storage may compact after ${archiveWindow} — attach restores it`,
  );
  return lines;
}

function reportKeptPod(
  podId: string,
  config: { idleTimeoutMinutes: number; archiveAfterMinutes: number | null },
): void {
  for (const line of keptPodNotice(podId, config)) info(line);
}

/**
 * The aggregated exit notice for pods switched away from (§6.4): one block naming every pod
 * left running, its idle window, and how to come back.
 */
export function reportSwitchedAwayPods(keptPods: ReadonlyMap<string, KeptPod>): void {
  if (keptPods.size === 0) return;
  info(`also left running earlier this session: ${keptPods.size} pod(s)`);
  for (const kept of keptPods.values()) {
    for (const line of keptPodNotice(kept.podId, kept)) info(`  ${line}`);
  }
}

/**
 * The archive window the provider will actually honor, in minutes, or null when it cannot
 * archive at all or when stop is already the provider's at-rest state (no second timer).
 *
 * The mirror of `idleTimeoutFor`: a configured number that nothing enforces is worse than no
 * number, because it reads as a bound (§3.2). Used for what is *sent* as well as what is
 * *said*, so the pod's server-side settings and the sentence the user just read agree.
 */
export function effectiveArchiveAfterMinutes(
  provider: SandboxProvider,
  configuredMinutes: number,
): number | null {
  const { serverSideArchive, archiveTransition, archiveMaxDays } = provider.capabilities;
  if (!serverSideArchive) return null;
  const transition = archiveTransition ?? (
    archiveMaxDays === null
      ? { kind: "same-as-stop" as const, expiryDays: null }
      : { kind: "after-stop" as const, maxDelayDays: archiveMaxDays }
  );
  if (transition.kind === "same-as-stop") return null;
  const maxMinutes = transition.maxDelayDays * 24 * 60;
  return configuredMinutes === 0 || configuredMinutes > maxMinutes ? maxMinutes : configuredMinutes;
}

export type RetentionReport = {
  idleTimeoutMinutes: number;
  archiveTransition: { kind: "same-as-stop"; expiryDays: null } | { kind: "after-stop"; maxDelayDays: number };
  effectiveArchiveAfterMinutes: number | null;
  providerExpiryDocumented: boolean;
};

export function retentionReport(
  provider: SandboxProvider,
  config: { idleTimeoutMinutes: number; archiveAfterMinutes: number },
): RetentionReport {
  const transition = provider.capabilities.archiveTransition ?? (
    provider.capabilities.archiveMaxDays === null
      ? { kind: "same-as-stop" as const, expiryDays: null }
      : { kind: "after-stop" as const, maxDelayDays: provider.capabilities.archiveMaxDays }
  );
  const effective = effectiveArchiveAfterMinutes(provider, config.archiveAfterMinutes);
  return {
    idleTimeoutMinutes: idleTimeoutFor(provider, config.idleTimeoutMinutes),
    archiveTransition: transition,
    effectiveArchiveAfterMinutes: effective,
    providerExpiryDocumented: transition.kind === "after-stop",
  };
}

/**
 * The idle window to ask the provider for, or 0 when it cannot honor one.
 *
 * Sending a window to a provider with no idle concept would be a capability lie by omission:
 * the config would read as bounded while nothing enforced it. Preflight reports the gap
 * (§3.2) and the pod falls back to the orphan window and `pi-pod gc`.
 */
export function idleTimeoutFor(provider: SandboxProvider, configured: number): number {
  if (provider.capabilities.idleAutoStop !== "configurable") return 0;
  const max = provider.capabilities.idleAutoStopMaxMinutes;
  if (max === undefined) return configured;
  return configured === 0 || configured > max ? max : configured;
}


// ---------------------------------------------------------------------------
// Phase 2 — workspace prep (§11.1)
// ---------------------------------------------------------------------------

/**
 * One-round-trip pod prep: create the (empty) workdir and, under IP-based egress
 * enforcement, seed `/etc/hosts` with the addresses the allowlist permits — the pod cannot
 * use DNS there (the nameserver is not in the allow set), so every hostname the init
 * scripts dial would otherwise fail to resolve. See `buildHostsEntries` for why this is
 * preferable to allowlisting a resolver.
 */
export const HOSTS_SEEDED_MARKER = "__PI_POD_HOSTS_SEEDED__";

export function podPrepScript(plan: SessionPlan): string {
  const lines: string[] = ["set -e"];
  if (plan.egress.policy.mode === "allowlist") {
    const entries = buildHostsEntries(plan.egress.resolved);
    if (entries.length > 0) {
      lines.push("cat >> /etc/hosts <<'PI_POD_HOSTS'");
      lines.push(renderHostsFile(entries).trimEnd());
      lines.push("PI_POD_HOSTS");
    }
  }
  // The marker separates a hosts-write failure (needs its own guidance) from a mkdir one.
  lines.push(`echo ${HOSTS_SEEDED_MARKER}`);
  lines.push(["mkdir", "-p", plan.workdir].map(shellQuote).join(" "));
  return lines.join("\n");
}

async function prepareWorkspace(
  sandbox: Sandbox,
  plan: SessionPlan,
  env: Record<string, string>,
): Promise<void> {
  if (plan.egress.policy.mode === "allowlist") {
    debug(`seeding /etc/hosts with ${buildHostsEntries(plan.egress.resolved).length} allowlisted host(s)`);
  }
  const res = await sandbox.exec(["bash", "-c", podPrepScript(plan)], { env, timeoutMs: 60_000 });
  if (res.exitCode === 0) return;
  if (plan.egress.policy.mode === "allowlist" && !(res.output ?? "").includes(HOSTS_SEEDED_MARKER)) {
    throw new PiPodError("could not write /etc/hosts in the pod", {
      hint:
        "the egress allowlist blocks DNS, so pi-pod maps allowed hostnames to their resolved\n" +
        'addresses instead. If the pod user cannot write /etc/hosts, use "egress": ' +
        '{ "mode": "open" } for this project.',
    });
  }
  throw new PiPodError(`failed to prepare the workspace in the pod (exit ${res.exitCode})`);
}

// ---------------------------------------------------------------------------
// Phase 1b — pod reuse (§6.5)
// ---------------------------------------------------------------------------

export interface ClaimedPod {
  sandbox: Sandbox;
  /** Restored creation env + runtime markers — exec-ready, like a fresh pod's sandboxEnv. */
  env: Record<string, string>;
}

const REUSE_START_TIMEOUT_MS = 5 * 60 * 1000;
/** Candidates tried before giving up. */
const REUSE_CANDIDATES = 2;

export function reuseRefreshScript(plan: SessionPlan): string {
  return [
    "set -e",
    ["mkdir", "-p", plan.workdir].map(shellQuote).join(" "),
    // Per-pod, not per-session: a stale exit code from the previous pi must not be read
    // as this session's status (same rule as attach). What is *in* the workspace is the
    // idempotent init scripts' business — they re-run over the warm disk next.
    `rm -f ${EXIT_CODE_FILE}`,
  ].join("\n");
}

/**
 * Find this project's newest stopped pod and make it session-ready: start it and restore
 * its env recipe. Returns null — leaving every candidate exactly as it was — whenever reuse
 * would be unsafe: a different image, or a pod whose env recipe this host cannot restore.
 */
export async function claimReusablePod(
  provider: SandboxProvider,
  plan: SessionPlan,
  config: PiPodConfig,
  opts: { stateHome?: string | null } = {},
): Promise<ClaimedPod | null> {
  const user = hostUserLabel();
  const wanted: Record<string, string> = {
    [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
    [LABEL_HOST_USER]: user,
    [LABEL_PROJECT]: plan.project,
  };
  const candidates = sortByActivity(
    (await provider.list(wanted)).filter(
      (s) =>
        Object.entries(wanted).every(([k, v]) => s.labels[k] === v) &&
        s.labels[LABEL_WORKDIR] === plan.workdir &&
        // Stopped only: a started pod may be hosting someone's live session, and an archived
        // one restores too slowly to beat a fresh create.
        s.state === "stopped" &&
        logicalPodState(provider.name, s.id, opts.stateHome) === "active",
    ),
  );
  if (candidates.length === 0) {
    debug("no stopped pod to reuse for this project — creating a fresh one");
    return null;
  }
  for (const info of candidates.slice(0, REUSE_CANDIDATES)) {
    const claimed = await tryClaimPod(provider, info, plan, config);
    if (claimed) return claimed;
  }
  return null;
}

async function tryClaimPod(
  provider: SandboxProvider,
  pod: SandboxInfo,
  plan: SessionPlan,
  config: PiPodConfig,
): Promise<ClaimedPod | null> {
  const sandbox = await provider.get(pod.id, { workdir: plan.workdir });
  if (!sandbox) return null;

  const needsRehydration = provider.capabilities.environmentPersistence === "rehydrate";
  let restoredEnv: Record<string, string> = {};
  if (needsRehydration) {
    try {
      restoredEnv = await restorePodEnv(
        {
          config,
          configPath: plan.configPath,
          userConfigPath: null,
          projectRoot: plan.projectRoot,
          imagePinned: true,
          warnings: [],
        } satisfies LoadedConfig,
        provider,
        pod,
      );
    } catch (e) {
      debug(`pod ${pod.id}: cannot restore its env (${errorMessage(e)}) — not reusing it`);
      return null;
    }
    const image = restoredEnv["PI_POD_IMAGE"];
    if (image !== undefined && image !== config.image) {
      debug(`pod ${pod.id} was built from ${image}, this launch wants ${config.image} — not reusing it`);
      return null;
    }
  }

  step("reuse", `starting stopped pod ${color.bold(pod.id)} (${plan.project})`);
  await ensurePodStarted(sandbox, pod, REUSE_START_TIMEOUT_MS, provider);
  if (needsRehydration) sandbox.rehydrateEnv(restoredEnv);
  const env = { ...restoredEnv, ...runtimeMarkers(sandbox.id) };

  const refresh = await sandbox.exec(["bash", "-c", reuseRefreshScript(plan)], {
    env,
    timeoutMs: 10 * 60 * 1000,
  });
  if (refresh.exitCode !== 0) {
    info(`pod ${pod.id} left as it was — it could not be refreshed (exit ${refresh.exitCode})`);
    // Put it back the way it was found; its disk (and whatever made it unsafe) survives.
    await sandbox
      .stop(STOP_TIMEOUT_SECONDS * 1000)
      .catch((e) => debug(`could not re-stop pod ${pod.id}: ${errorMessage(e)}`));
    return null;
  }
  return { sandbox, env };
}

const BAKE_SCRIPT_REMOTE_PATH = "/tmp/pi-pod-bake.sh";

async function runLiveBake(sandbox: Sandbox, plan: SessionPlan, config: PiPodConfig): Promise<void> {
  const script = plan.bake?.script;
  if (!script) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-bake-"));
  const hostPath = path.join(dir, "bake.sh");
  fs.writeFileSync(hostPath, script, { mode: 0o700 });
  try {
    await runInitScript({
      sandbox,
      hostPath,
      workdir: "/root",
      timeoutSeconds: config.initTimeoutSeconds,
      onFailure: config.initOnFailure === "continue" ? "continue" : "abort",
      env: {},
      egressRestricted: plan.egress.policy.mode === "allowlist",
      remotePath: BAKE_SCRIPT_REMOTE_PATH,
      logPrefix: "[bake]",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// §7.5 — carried extensions
// ---------------------------------------------------------------------------

/**
 * Install the extensions the host settings name, and hand back the config to actually upload.
 *
 * The only interesting case is failure. A pi extension can pull in a native module, and that
 * install reaches well past the registry — a prebuilt binary from GitHub's release-asset host,
 * or Node headers from nodejs.org for a node-gyp fallback. Under an allowlist those are exactly
 * the kind of dependency nobody predicts, and npm reports them as a timeout and an `EAI_AGAIN`
 * rather than as a block. Both hosts are in the derived allow set now (§11.1), but "the set of
 * hosts an arbitrary npm package needs" is not knowable in advance, so this cannot be the last
 * line of defence.
 */
async function installCarriedPackages(
  sandbox: Sandbox,
  hostConfig: SessionPlan["hostConfig"],
  config: PiPodConfig,
): Promise<SessionPlan["hostConfig"]> {
  if (hostConfig.packages.length === 0) return hostConfig;

  const stream = prefixedStreamer("[pi ext]");
  const result = await installHostPackages(sandbox, hostConfig.packages, {
    timeoutMs: config.initTimeoutSeconds * 1000,
    onOutput: stream,
  });

  if (!result.failed) {
    info(`installed ${hostConfig.packages.length} pi extension package(s)`);
    return hostConfig;
  }

  warn(`could not install the pi extensions from your host settings: ${hostConfig.packages.join(", ")}`);
  warn("starting pi without them — the session works, your extensions are missing");
  hintLine(
    config.egress.mode === "allowlist"
      ? 'if a package needs a host the allowlist does not have, add it to egress.allow in .pi-pod/config.json'
      : "see the npm output above for the failing package",
  );
  hintLine('or set "pi": { "hostConfig": { "packages": false } } to stop carrying them');

  return withPackages(hostConfig, result.installed);
}

// ---------------------------------------------------------------------------
// §7.4 — optional pi auth upload
// ---------------------------------------------------------------------------

/**
 * Reached only when preflight resolved `plan.copyPiAuth` — which means permission was not
 * withdrawn *and* the file was there. Absence is decided on the host, where it can be
 * reported next to everything else rather than half a pod later.
 *
 * Returns the exact contents written (the divergence baseline for the auth sync), or null
 * when nothing was uploaded.
 */
async function copyPiAuth(sandbox: Sandbox, hostHomePath: string | null): Promise<string | null> {
  // The home preflight resolved, not whatever $HOME says now: those can differ, and the
  // failure when they do is a pod that came up unauthenticated with nothing reporting it.
  const home = hostHome(hostHomePath ?? undefined);
  if (!home) return null;

  const authPath = hostPiAuthPath(home);
  // Re-checked rather than assumed: preflight ran earlier, and a file can go away between
  // the check and the read. Skipping quietly beats crashing a provisioned pod over it.
  if (!fs.existsSync(authPath)) {
    debug(`${authPath} disappeared after preflight — skipping the auth upload`);
    return null;
  }

  const contents = fs.readFileSync(authPath);
  // §7.4: refresh tokens never leave the host — they rotate on use, and two environments
  // holding the same one revoke each other (the host and every prior pod lost xAI and
  // Anthropic grants to exactly that race). The pod borrows access tokens; the host renews
  // them (preflight's refresh before this copy, then the auth sync while a session runs).
  const sanitized = sanitizePiAuthContents(contents.toString("utf8"));
  await sandbox.exec(["mkdir", "-p", POD_PI_AGENT_DIR], { timeoutMs: 60_000 });
  await sandbox.uploadFile(`${POD_PI_AGENT_DIR}/auth.json`, Buffer.from(sanitized), 0o600);
  return sanitized;
}
