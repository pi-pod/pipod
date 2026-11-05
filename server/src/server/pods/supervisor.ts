import { daemonShimArgv } from "../../core/client/session.js";
import { allowsHost } from "../../core/egress.js";
import type { EgressPolicy, Sandbox } from "../../core/providers/types.js";
import { shellQuote } from "../../core/providers/util.js";
import { assertPiResourcesReadable, type PiResourceOverrides } from "./pi-resources.js";
import { DEFAULT_RUNTIME_PATHS, type PodRuntimePaths } from "./runtime-paths.js";
import { transportNetworkProbe, type TransportFailureKind } from "./transport-probe.js";
export { transportNetworkProbe } from "./transport-probe.js";
export type { TransportFailureKind } from "./transport-probe.js";

/** Long enough to outlive the daemon's bounded 10-second reconnect backoff. */
export const AGENTD_RECONNECT_GRACE_MS = 12_000;
const AGENTD_READY_ATTEMPTS = 150;
const AGENTD_READY_INTERVAL_SECONDS = 0.1;
const AGENTD_READY_TIMEOUT_SECONDS = AGENTD_READY_ATTEMPTS * AGENTD_READY_INTERVAL_SECONDS;
const AGENTD_LOG_TAIL_LINES = 8;
const AGENTD_LOG_TAIL_BYTES = 2_000;
/** One stat per requested path on a machine that is already running commands for this launch. */
const PI_RESOURCE_PROBE_TIMEOUT_MS = 30_000;
export const EGRESS_REAPPLY_COOLDOWN_MS = 10 * 60 * 1000;

export class AgentdTransportUnavailableError extends Error {
  readonly kind: TransportFailureKind;
  readonly probe: string;
  readonly cradle: "exec" | "pty-cradle";
  constructor(message: string, opts: { kind?: TransportFailureKind; probe?: string; cradle?: "exec" | "pty-cradle" } = {}) {
    super(message);
    this.name = "AgentdTransportUnavailableError";
    this.kind = opts.kind ?? "unknown";
    this.probe = opts.probe ?? "";
    this.cradle = opts.cradle ?? "exec";
  }
}

/**
 * Add the now-mandatory dial-out callback to a pre-WebSocket pod's frozen provider allowlist.
 * The persisted description is the launch-time effective policy, including derived hosts, so
 * replacing that exact policy plus one control-plane host neither loses nor broadens user egress.
 */
export async function ensureAgentdCallbackEgress(args: {
  sandbox: Sandbox;
  description: string;
  publicUrl: string | undefined;
}): Promise<string> {
  if (args.description === "open") return args.description;
  if (!args.publicUrl) {
    throw new AgentdTransportUnavailableError("server callback URL is unavailable for pod transport");
  }
  if (!args.description.startsWith("allowlist:")) {
    throw new AgentdTransportUnavailableError("pod has no recoverable provider egress policy");
  }
  const callbackHost = new URL(args.publicUrl).hostname.toLowerCase();
  const hosts = args.description
    .slice("allowlist:".length)
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (allowsHost(hosts, callbackHost)) return args.description;
  if (!args.sandbox.updateEgress) {
    throw new AgentdTransportUnavailableError(
      `pod network allowlist predates WebSocket transport and cannot be updated on this provider; missing ${callbackHost}`,
    );
  }
  const policy: EgressPolicy = { mode: "allowlist", hosts: [...hosts, callbackHost] };
  await args.sandbox.updateEgress(policy);
  return `allowlist:${policy.hosts.join(",")}`;
}

/**
 * Whether the pidfile still belongs to a live daemon supervisor.
 *
 * Connectivity is deliberately not inferred here: the gateway registry owns that truth.
 * A live-but-disconnected daemon gets a bounded reconnect wait there, never replacement
 * merely because the network is unavailable.
 * Stale pidfiles are removed only after argv proves the PID belongs to some other process.
 */
export async function agentdSupervisorRunning(
  sandbox: Sandbox,
  paths: PodRuntimePaths = DEFAULT_RUNTIME_PATHS,
): Promise<boolean> {
  const pid = shellQuote(paths.agentdPid);
  const ready = shellQuote(paths.agentdReady);
  const shim = shellQuote(paths.shim);
  const result = await sandbox.exec([
    "bash",
    "-lc",
    `[ -s ${pid} ] || exit 1; ` +
      `pid=$(cat ${pid}); kill -0 "$pid" 2>/dev/null || { rm -f ${pid} ${ready}; exit 1; }; ` +
      `argv=$(tr '\\0' '\\n' < "/proc/$pid/cmdline" 2>/dev/null) || exit 1; ` +
      `printf '%s\\n' "$argv" | grep -Fx -- ${shim} >/dev/null && ` +
      `printf '%s\\n' "$argv" | grep -Fx -- '--daemon' >/dev/null || ` +
      `{ rm -f ${pid} ${ready}; exit 1; }; ` +
      `if [ -s ${shellQuote(paths.exitCode)} ]; then ` +
      `kill "$pid" 2>/dev/null || true; rm -f ${pid} ${ready}; exit 1; fi`,
  ], { timeoutMs: 10_000 });
  return result.exitCode === 0;
}

/**
 * Retire a disconnected daemon without risking an unrelated process after PID reuse.
 * Marker cleanup is unconditional; signalling requires argv ownership of the generated shim.
 * Scan /proc rather than trusting one pidfile: startup failures in older releases could orphan
 * multiple reconnecting daemons after removing or overwriting that marker. A setsid-launched
 * daemon owns its process group, so retirement also kills every stopped/wedged Pi child.
 */
export async function stopAgentdSupervisor(
  sandbox: Sandbox,
  paths: PodRuntimePaths = DEFAULT_RUNTIME_PATHS,
): Promise<void> {
  const pidFile = shellQuote(paths.agentdPid);
  const readyFile = shellQuote(paths.agentdReady);
  const shim = shellQuote(paths.shim);
  await sandbox.exec([
    "bash",
    "-lc",
    `targets=""; ` +
      `for proc in /proc/[0-9]*; do ` +
      `pid=\${proc##*/}; [ "$pid" = "$$" ] && continue; ` +
      `argv=$(tr '\\0' '\\n' < "$proc/cmdline" 2>/dev/null || true); ` +
      `if printf '%s\\n' "$argv" | grep -Fx -- ${shim} >/dev/null && ` +
      `printf '%s\\n' "$argv" | grep -Fx -- '--daemon' >/dev/null; then ` +
      `target="$pid"; pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' '); ` +
      `[ "$pgid" = "$pid" ] && target="-$pid"; targets="$targets $pid:$target"; ` +
      `fi; done; ` +
      `for item in $targets; do target=\${item#*:}; kill -TERM -- "$target" 2>/dev/null || true; done; ` +
      `for _ in $(seq 1 20); do alive=0; ` +
      `for item in $targets; do pid=\${item%%:*}; kill -0 "$pid" 2>/dev/null && alive=1; done; ` +
      `[ "$alive" = 0 ] && break; sleep 0.1; done; ` +
      `for item in $targets; do target=\${item#*:}; kill -KILL -- "$target" 2>/dev/null || true; done; ` +
      `rm -f ${pidFile} ${readyFile}`,
  ], { timeoutMs: 10_000 });
}

async function supervisorReady(sandbox: Sandbox, paths: PodRuntimePaths): Promise<boolean> {
  const result = await sandbox.exec(["bash", "-lc", `[ -s ${shellQuote(paths.agentdReady)} ]`], { timeoutMs: 5_000 }).catch(() => null);
  return result?.exitCode === 0;
}

function readyWaitScript(paths: PodRuntimePaths): string {
  return (
    `for _ in $(seq 1 ${AGENTD_READY_ATTEMPTS}); do ` +
    `[ -s ${shellQuote(paths.agentdReady)} ] && exit 0; ` +
    `sleep ${AGENTD_READY_INTERVAL_SECONDS}; done; exit 75`
  );
}

/** The committed egress policy behind a stored description, or null when unrecoverable. */
export function egressPolicyFromDescription(description: string): EgressPolicy | null {
  if (description === "open") return { mode: "open" };
  if (!description.startsWith("allowlist:")) return null;
  const hosts = description
    .slice("allowlist:".length)
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return hosts.length ? { mode: "allowlist", hosts } : null;
}

/** A bounded lookup target from the pod's own allowlist — distinct from the callback host —
 * so the probe can tell "the callback host is selectively blocked" from "sandbox DNS is dead".
 * Open-egress pods have no allowlist to draw from, so a stable well-known host stands in:
 * with open egress any external lookup is permitted, and the discrimination is what matters. */
export const PROBE_CONTROL_HOST = "github.com";

export function probeControlHostFromDescription(
  description: string,
  callbackHost: string,
): string | undefined {
  const policy = egressPolicyFromDescription(description);
  if (!policy) return undefined;
  if (policy.mode === "open") {
    return PROBE_CONTROL_HOST === callbackHost ? undefined : PROBE_CONTROL_HOST;
  }
  for (const raw of policy.hosts) {
    const host = raw.startsWith("*.") ? raw.slice(2) : raw;
    if (host && host !== callbackHost) return host;
  }
  return undefined;
}

/** The daemon's dial URL: server base URL plus the transport path, with the same
 * trailing-slash normalization the generated shim performs. */
export function agentdDialUrl(serverUrl: string | undefined): string | undefined {
  return serverUrl ? `${serverUrl.replace(/\/+$/, "")}/v1/pod-transport` : undefined;
}

async function transportStartupError(
  sandbox: Sandbox,
  paths: PodRuntimePaths,
  dialUrl: string | undefined,
  controlHost: string | undefined,
  cradle: "exec" | "pty-cradle" = "exec",
): Promise<AgentdTransportUnavailableError> {
  const [tail, probe] = await Promise.all([
    sandbox.exec([
      "bash",
      "-lc",
      `tail -n ${AGENTD_LOG_TAIL_LINES} ${shellQuote(paths.shimLog)} 2>/dev/null || true`,
    ], { timeoutMs: 5_000 }).catch(() => null),
    dialUrl
      ? transportNetworkProbe({ sandbox, dialUrl, controlHost })
      : null,
  ]);
  const detail = (tail?.output ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .trim()
    .slice(-AGENTD_LOG_TAIL_BYTES);
  const kind = probe?.kind ?? "unknown";
  const segments = [
    `pod transport supervisor stayed alive but did not connect within ${AGENTD_READY_TIMEOUT_SECONDS}s`,
    probe ? `network probe [${kind}]: ${probe.summary}` : "",
    detail,
  ].filter(Boolean);
  return new AgentdTransportUnavailableError(segments.join(" — "), { kind, probe: probe?.summary ?? "", cradle });
}

/** Start the WS supervisor and return only after it has opened its outbound transport.
 * If the provider kills detached exec, a PTY is used solely as a process cradle. */
export async function startAgentdSupervisor(args: {
  sandbox: Sandbox;
  piArgv: string[];
  cwd: string;
  env: Record<string, string>;
  paths?: PodRuntimePaths;
  probeControlHost?: string;
  /**
   * Pi resource paths this pod's launch required (`ResolvedConfigReport.piResources`). Every
   * path to Pi passes through here — first provisioning, a co-located child, a gateway cold
   * start after a stop — so checking them here is what makes the guarantee hold for the life
   * of the pod rather than for its first boot. Absent for the launches that requested none,
   * which then cost no round trip at all.
   */
  piResources?: PiResourceOverrides | null;
}): Promise<"exec" | "pty-cradle"> {
  const paths = args.paths ?? DEFAULT_RUNTIME_PATHS;
  // Before the supervisor, not after: a missing resource is a launch failure with a message,
  // never a pod that comes up healthy without the capability it was launched for. Bounded,
  // because a machine too sick to answer a stat must not hold a launch open indefinitely.
  await assertPiResourcesReadable(
    (argv) => args.sandbox.exec(argv, { timeoutMs: PI_RESOURCE_PROBE_TIMEOUT_MS }),
    args.piResources,
  );
  const argv = daemonShimArgv(args.piArgv, paths).map(shellQuote).join(" ");
  const script =
    `rm -f ${shellQuote(paths.agentdReady)} ${shellQuote(paths.exitCode)}; ` +
    `setsid ${argv} >> ${shellQuote(paths.shimLog)} 2>&1 < /dev/null & supervisor=$!; ` +
    `for _ in $(seq 1 ${AGENTD_READY_ATTEMPTS}); do ` +
    `[ -s ${shellQuote(paths.agentdReady)} ] && exit 0; ` +
    `kill -0 "$supervisor" 2>/dev/null || { wait "$supervisor"; exit $?; }; ` +
    `sleep ${AGENTD_READY_INTERVAL_SECONDS}; done; ` +
    `kill -0 "$supervisor" 2>/dev/null && exit 75; exit 1`;
  const started = await args.sandbox.exec(["bash", "-lc", script], {
    cwd: args.cwd,
    env: args.env,
    timeoutMs: 30_000,
  }).catch(() => null);
  if (started?.exitCode === 0) return "exec";
  if (started?.exitCode === 75) {
    const error = await transportStartupError(
      args.sandbox,
      paths,
      agentdDialUrl(args.env.PI_POD_SERVER_URL),
      args.probeControlHost,
    );
    // Diagnosis is bounded but takes time: adopt a connection that arrived meanwhile.
    if (await supervisorReady(args.sandbox, paths)) return "exec";
    // Connectivity is never evidence of process death. Preserve Pi for every failure kind.
    throw error;
  }
  // An interrupted provider exec does not prove the detached process died. Never create a
  // second cradle beside a live or unknown supervisor; the next attach can adopt it.
  const running = await agentdSupervisorRunning(args.sandbox, paths).catch(() => null);
  if (running === null) {
    throw new AgentdTransportUnavailableError("pod supervisor state could not be verified; it was left untouched — retry");
  }
  if (running) {
    const error = await transportStartupError(args.sandbox, paths, agentdDialUrl(args.env.PI_POD_SERVER_URL), args.probeControlHost);
    if (await supervisorReady(args.sandbox, paths)) return "exec";
    throw error;
  }

  const cradle = await args.sandbox.openPty({
    argv: daemonShimArgv(args.piArgv, paths),
    cols: 80,
    rows: 24,
    cwd: args.cwd,
    env: args.env,
  });
  cradle.onData(() => {});
  const ready = await args.sandbox.exec(["bash", "-lc", readyWaitScript(paths)], {
    timeoutMs: 30_000,
  }).catch(() => null);
  if (ready?.exitCode !== 0) {
    cradle.close();
    const error = await transportStartupError(
      args.sandbox,
      paths,
      agentdDialUrl(args.env.PI_POD_SERVER_URL),
      args.probeControlHost,
      "pty-cradle",
    );
    if (await supervisorReady(args.sandbox, paths)) return "pty-cradle";
    throw error;
  }
  setTimeout(() => cradle.close(), 1_000).unref?.();
  return "pty-cradle";
}

function withEgressContext(
  error: unknown,
  description: string,
): AgentdTransportUnavailableError | unknown {
  if (!(error instanceof AgentdTransportUnavailableError)) return error;
  return new AgentdTransportUnavailableError(
    `${error.message} — egress policy: ${description.slice(0, 400)}`,
    { kind: error.kind, probe: error.probe, cradle: error.cradle },
  );
}

/** Start the supervisor; when it cannot connect, re-apply the committed egress policy to the
 * provider once and retry. The stored description is the committed policy, but a long-lived
 * sandbox's actual enforcement may predate it or silently diverge — a running-sandbox network
 * update is the only way enforcement catches up when the description already claims coverage
 * (the ensureCallbackEgress fast path correctly skips the provider call in that case). */
export async function startAgentdSupervisorWithEgressHeal(args: {
  sandbox: Sandbox;
  piArgv: string[];
  cwd: string;
  env: Record<string, string>;
  paths?: PodRuntimePaths;
  probeControlHost?: string;
  piResources?: PiResourceOverrides | null;
  egressDescription: string | undefined;
  reapplyEgress?: boolean;
}): Promise<{ cradle: "exec" | "pty-cradle"; egressReapplied: boolean }> {
  const base = () => ({
    sandbox: args.sandbox,
    piArgv: args.piArgv,
    cwd: args.cwd,
    env: args.env,
    paths: args.paths,
    probeControlHost: args.probeControlHost,
    piResources: args.piResources,
  });
  try {
    return { cradle: await startAgentdSupervisor(base()), egressReapplied: false };
  } catch (error) {
    const description = args.egressDescription;
    if (!description) throw error;
    const policy = egressPolicyFromDescription(description);
    // Only a demonstrated TCP failure can justify changing provider enforcement. DNS,
    // reachable callbacks, TLS/HTTP and unavailable probes are not egress evidence.
    if (!(error instanceof AgentdTransportUnavailableError) || error.kind !== "tcp-connect" || args.reapplyEgress === false || !policy || !args.sandbox.updateEgress) {
      throw withEgressContext(error, description);
    }
    try {
      await args.sandbox.updateEgress(policy);
    } catch {
      // A failed provider re-apply changes nothing; surface the original probe-enriched error.
      throw withEgressContext(error, description);
    }
    try {
      // Heal networking, not processes: the same daemon owns Pi and retries its socket.
      const ready = await args.sandbox.exec(["bash", "-lc", readyWaitScript(args.paths ?? DEFAULT_RUNTIME_PATHS)], { timeoutMs: 20_000 });
      if (ready.exitCode === 0) return { cradle: error.cradle, egressReapplied: true };
      throw await transportStartupError(args.sandbox, args.paths ?? DEFAULT_RUNTIME_PATHS,
        agentdDialUrl(args.env.PI_POD_SERVER_URL), args.probeControlHost, error.cradle);
    } catch (retry) {
      throw withEgressContext(retry, description);
    }
  }
}
