import { daemonShimArgv } from "../../core/client/session.js";
import { allowsHost } from "../../core/egress.js";
import type { EgressPolicy, Sandbox } from "../../core/providers/types.js";
import { shellQuote } from "../../core/providers/util.js";
import { assertPiResourcesReadable, type PiResourceOverrides } from "./pi-resources.js";
import { DEFAULT_RUNTIME_PATHS, type PodRuntimePaths } from "./runtime-paths.js";

/** Long enough to outlive the daemon's bounded 10-second reconnect backoff. */
export const AGENTD_RECONNECT_GRACE_MS = 12_000;
const AGENTD_READY_ATTEMPTS = 150;
const AGENTD_READY_INTERVAL_SECONDS = 0.1;
const AGENTD_READY_TIMEOUT_SECONDS = AGENTD_READY_ATTEMPTS * AGENTD_READY_INTERVAL_SECONDS;
const AGENTD_LOG_TAIL_LINES = 8;
const AGENTD_LOG_TAIL_BYTES = 2_000;
const PROBE_OUTPUT_BYTES = 600;
const PROBE_GETENT_TIMEOUT_SECONDS = 3;
const PROBE_DIAL_TIMEOUT_SECONDS = 12;
const PROBE_EXEC_TIMEOUT_MS = 20_000;
/** One stat per requested path on a machine that is already running commands for this launch. */
const PI_RESOURCE_PROBE_TIMEOUT_MS = 30_000;
export const EGRESS_REAPPLY_COOLDOWN_MS = 10 * 60 * 1000;

/** Where a transport failure appears to come from, from the in-sandbox probe. */
export type TransportFailureKind =
  | "dns-stale-tailscale"
  | "dns-dead"
  | "dns-selective"
  | "tcp-connect"
  | "tls-http"
  | "unknown";

export class AgentdTransportUnavailableError extends Error {
  readonly kind: TransportFailureKind;
  readonly probe: string;
  constructor(message: string, opts: { kind?: TransportFailureKind; probe?: string } = {}) {
    super(message);
    this.name = "AgentdTransportUnavailableError";
    this.kind = opts.kind ?? "unknown";
    this.probe = opts.probe ?? "";
  }
}

/**
 * Classify a transport failure from its probe output. DNS kinds mean the pod's
 * own resolution is broken (possibly the stale-Tailscale-resolver outage); they
 * must never trigger a sandbox restart or a live-supervisor replacement — the
 * supervisor may recover on its own once DNS does. Everything else keeps the
 * existing replace-and-retry behavior.
 */
export function classifyTransportFailure(probe: string): TransportFailureKind {
  // No positive evidence, no DNS verdict: an unavailable or truncated probe must not
  // disable the egress heal or preserve a supervisor on a guess. DNS kinds require a
  // `dns:` line reporting failure (or an explicit python resolve error).
  if (!probe || !probe.trim()) return "unknown";
  const lines = probe.split("\n").map((line) => line.trim());
  const find = (prefix: string): string | undefined =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
  const resolv = find("resolv:") ?? "";
  const tailscaled = find("tailscaled:") ?? "";
  const dns = find("dns:") ?? "";
  const dnsControl = find("dns-control:") ?? "";
  const dnsFailed =
    (dns !== "" && /timed out|did not resolve/i.test(dns)) || /py-resolve-error/i.test(probe);
  const controlFailed = dnsControl === undefined || dnsControl === "" || /timed out|did not resolve/i.test(dnsControl);
  const hasTailscaleResolv =
    resolv.includes("100.100.100.100") || resolv.includes("fd7a:115c:a1e0");
  if (dnsFailed) {
    if (hasTailscaleResolv && tailscaled === "gone") return "dns-stale-tailscale";
    if (dnsControl !== undefined && dnsControl !== "" && !controlFailed) return "dns-selective";
    return "dns-dead";
  }
  if (/tcp-by-ip-error/i.test(probe)) return "tcp-connect";
  if (/tls-error|http-by-ip-error/i.test(probe)) return "tls-http";
  return "unknown";
}

/**
 * Whether a disconnected supervisor should be replaced for this failure kind.
 * DNS outages preserve the live supervisor (and its Pi): replacing it destroys
 * recoverable work without fixing resolution, and the sweep backoff spaces
 * retries until DNS recovers.
 */
export function shouldReplaceDisconnectedSupervisor(kind: TransportFailureKind): boolean {
  return kind !== "dns-stale-tailscale" && kind !== "dns-dead" && kind !== "dns-selective";
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

/** One bounded in-sandbox network probe: sandbox clock, DNS for the callback host (with a
 * distinct allowlist control host when available), and a staged dial — TCP connect by resolved
 * IP, a TLS-free HTTP request by IP, then the real HTTPS dial the daemon makes. Transport
 * startup failures include it so a disconnected pod self-reports why it cannot reach the
 * gateway — egress, DNS, TCP/TLS, or clock skew — instead of a bare timeout. */
export async function transportNetworkProbe(args: {
  sandbox: Sandbox;
  dialUrl: string;
  controlHost?: string;
}): Promise<string> {
  const dialHost = new URL(args.dialUrl).hostname;
  const controlHost = args.controlHost;
  const python = [
    "import socket, sys, urllib.request, urllib.error",
    `host, port = ${JSON.stringify(dialHost)}, 443`,
    "try:",
    "    ip = socket.getaddrinfo(host, port)[0][4][0]",
    "    print('py-resolve:', ip)",
    "except Exception as e:",
    "    print('py-resolve-error:', type(e).__name__); sys.exit(0)",
    "try:",
    "    s = socket.create_connection((ip, port), 5); s.close()",
    "    print('tcp-by-ip: ok')",
    "except Exception as e:",
    "    print('tcp-by-ip-error:', type(e).__name__, str(e)[:80])",
    "try:",
    "    req = urllib.request.Request(f'http://{ip}/v1/pod-transport', headers={'Host': host})",
    "    r = urllib.request.urlopen(req, timeout=5)",
    "    print('http-by-ip:', r.status)",
    "except urllib.error.HTTPError as e:",
    "    print('http-by-ip:', e.code)",
    "except Exception as e:",
    "    print('http-by-ip-error:', type(e).__name__, str(e)[:80])",
    "try:",
    `    r = urllib.request.urlopen(${JSON.stringify(args.dialUrl)}, timeout=5)`,
    "    print('tls:', r.status)",
    "except urllib.error.HTTPError as e:",
    "    print('tls:', e.code)",
    "except Exception as e:",
    "    print('tls-error:', type(e).__name__, str(e)[:80])",
  ].join("\n");
  // Every piece is individually bounded (getent 3s, python 12s under `timeout`, unbuffered so
  // partial step output survives a kill) so the probe always completes inside the exec
  // deadline; a wedged resolver or stalled handshake yields its own labeled line instead of
  // a deadline_exceeded that hides which step hung. `varName` must be a valid bash identifier.
  //
  // PIPESTATUS discipline: `${PIPESTATUS[0]}` is only meaningful immediately after a
  // top-level pipeline. Inside `out=$(cmd | head -1)` it reports the assignment (head's
  // status), silently swallowing timeout's 124 — so the pipe stays outside the substitution
  // and `$?` reads timeout/getent directly.
  const dnsLookup = (varName: string, label: string, host: string) =>
    `${varName}out=$(timeout ${PROBE_GETENT_TIMEOUT_SECONDS} getent hosts ${shellQuote(host)} 2>/dev/null); ` +
    `${varName}rc=$?; ` +
    `${varName}out=$(printf '%s\\n' "$${varName}out" | head -1); ` +
    `if [ "$${varName}rc" = 124 ]; then echo "${label}: lookup timed out"; ` +
    `elif [ -z "$${varName}out" ]; then echo "${label}: ${host} did not resolve"; ` +
    `else echo "${label}: $${varName}out"; fi; `;
  // Resolver ownership (whose nameservers are these?) and daemon availability ride along
  // so a stale Tailscale resolver is recognizable without a second round trip. The 124
  // branch is a timed-out dial, not a missing python: only 127 means python3 is absent.
  const script =
    `echo "utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"; ` +
    `echo "resolv: $(grep -E '^\\s*nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}' | tr '\\n' ' ')"; ` +
    `if (pgrep -x tailscaled >/dev/null 2>&1 || ps -eo comm= 2>/dev/null | grep -qx tailscaled); then echo "tailscaled: live"; else echo "tailscaled: gone"; fi; ` +
    dnsLookup("dns", "dns", dialHost) +
    (controlHost ? dnsLookup("dnsc", "dns-control", controlHost) : "") +
    `timeout ${PROBE_DIAL_TIMEOUT_SECONDS} python3 -u -c ${shellQuote(python)} 2>&1; ` +
    `pyrc=$?; ` +
    `if [ "$pyrc" = 124 ]; then echo "dial: probe timed out after ${PROBE_DIAL_TIMEOUT_SECONDS}s"; ` +
    `elif [ "$pyrc" = 127 ]; then echo "dial: python3 probe unavailable ($pyrc)"; ` +
    `elif [ "$pyrc" -ne 0 ]; then echo "dial: probe failed ($pyrc)"; fi`;
  const result = await args.sandbox.exec(["bash", "-lc", script], {
    timeoutMs: PROBE_EXEC_TIMEOUT_MS,
  }).catch(
    (e) => ({ exitCode: 1, output: `probe unavailable: ${e instanceof Error ? e.message : String(e)}` }),
  );
  return (result.output ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .trim()
    .slice(-PROBE_OUTPUT_BYTES);
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
): Promise<AgentdTransportUnavailableError> {
  const [tail, probe] = await Promise.all([
    sandbox.exec([
      "bash",
      "-lc",
      `tail -n ${AGENTD_LOG_TAIL_LINES} ${shellQuote(paths.shimLog)} 2>/dev/null || true`,
    ], { timeoutMs: 5_000 }).catch(() => null),
    dialUrl
      ? transportNetworkProbe({ sandbox, dialUrl, controlHost }).catch(() => "probe unavailable")
      : "",
  ]);
  const detail = (tail?.output ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .trim()
    .slice(-AGENTD_LOG_TAIL_BYTES);
  const kind = probe ? classifyTransportFailure(probe) : "unknown";
  const segments = [
    `pod transport supervisor stayed alive but did not connect within ${AGENTD_READY_TIMEOUT_SECONDS}s`,
    probe ? `network probe [${kind}]: ${probe}` : "",
    detail,
  ].filter(Boolean);
  return new AgentdTransportUnavailableError(segments.join(" — "), { kind, probe: probe ?? "" });
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
    // A DNS-classified startup failure keeps the fresh supervisor: killing it would
    // destroy the initial Pi even though only pod DNS is dead, and the sweep backoff
    // retries attach (which re-probes) once resolution recovers.
    if (shouldReplaceDisconnectedSupervisor(error.kind)) {
      await stopAgentdSupervisor(args.sandbox, paths);
    }
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
    );
    if (shouldReplaceDisconnectedSupervisor(error.kind)) {
      await stopAgentdSupervisor(args.sandbox, paths);
    }
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
    { kind: error.kind, probe: error.probe },
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
    // A DNS-classified failure is the pod's own resolution, not provider enforcement:
    // re-applying egress cannot fix it, so skip the provider mutation and report directly.
    if (error instanceof AgentdTransportUnavailableError && !shouldReplaceDisconnectedSupervisor(error.kind)) {
      throw withEgressContext(error, description);
    }
    if (!(error instanceof AgentdTransportUnavailableError) || args.reapplyEgress === false || !policy || !args.sandbox.updateEgress) {
      throw withEgressContext(error, description);
    }
    try {
      await args.sandbox.updateEgress(policy);
    } catch {
      // A failed provider re-apply changes nothing; surface the original probe-enriched error.
      throw withEgressContext(error, description);
    }
    try {
      const cradle = await startAgentdSupervisor(base());
      return { cradle, egressReapplied: true };
    } catch (retry) {
      throw withEgressContext(retry, description);
    }
  }
}
