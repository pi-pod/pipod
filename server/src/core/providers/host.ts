/**
 * src/providers/host.ts — the co-located ("host") provider.
 *
 * A sandbox from this provider is not a machine: it is a process group and a runtime
 * directory on the machine of an already-running pod (the *host pod*). Children cost
 * nothing extra, boot in the time it takes to spawn pi, and share the host's filesystem —
 * which is the point. Every capability gap that follows from that physics is declared
 * rather than papered over: no separate archive storage, no own idle clock, egress and
 * resources inherited from the host.
 *
 * The adapter is written against a narrow {@link HostMachine} handle, not against "a host
 * pod": server wiring injects a resolver that produces the handle (core must not import
 * server code). Today the only resolver wraps a host pod's Sandbox via its provider; the
 * handle shape is what would let a registered bare machine satisfy the same contract later.
 */
import { PiPodError } from "../errors.js";
import { shellQuote } from "./util.js";
import type {
  ExecOpts,
  ExecResult,
  ImageInfo,
  ProviderCapabilities,
  PtyOpenOpts,
  PtySession,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
} from "./types.js";

export const HOST_PROVIDER_NAME = "host";

/**
 * Marker env var carried by every process a child sandbox starts. Stop and delete find the
 * child's processes by scanning /proc for it, which survives double-forks that escape the
 * original process group — the group id is a hint, the environment is the membership test.
 */
export const HOST_CHILD_ENV = "PI_POD_HOST_CHILD";

/** Child-private runtime state on the host: metadata and the stopped marker. */
export const HOST_CHILDREN_DIR = "/var/lib/pi-pod/children";

/**
 * Where child runtime state lives on the host machine. Call-time so tests on unprivileged
 * machines can redirect it (PI_POD_HOST_CHILDREN_DIR); production never sets the override.
 */
export function hostChildrenDir(): string {
  return process.env.PI_POD_HOST_CHILDREN_DIR || HOST_CHILDREN_DIR;
}

export function childRuntimeDir(childId: string): string {
  return `${hostChildrenDir()}/${childId}`;
}

/** `host:<hostId>:<childId>` — resolvable to a machine without any provider account. */
export function formatHostSandboxId(hostId: string, childId: string): string {
  return `${HOST_PROVIDER_NAME}:${hostId}:${childId}`;
}

export function parseHostSandboxId(id: string): { hostId: string; childId: string } | null {
  const match = /^host:([^:]+):([^:]+)$/.exec(id);
  if (!match) return null;
  return { hostId: match[1]!, childId: match[2]! };
}

/**
 * Everything the adapter may do to the machine a child lives on. Implementations decide what
 * "the machine" is — the v1 resolver wraps the host pod's own provider Sandbox — and own the
 * credentials involved; the adapter never sees them.
 */
export interface HostMachine {
  /** The host id this machine answers for (the host pod id in v1). */
  readonly hostId: string;
  /** The machine's own state, collapsed to the standard vocabulary. */
  state(): Promise<SandboxState>;
  /**
   * Bring the machine up if it is stopped or archived — how attaching a child wakes its
   * host. Implementations route this through their audited start path.
   */
  ensureStarted(timeoutMs: number): Promise<void>;
  exec(argv: string[], opts?: ExecOpts): Promise<ExecResult>;
  uploadFile(destPath: string, contents: Uint8Array, mode?: number): Promise<void>;
  uploadLocalFile(
    sourcePath: string,
    destPath: string,
    opts?: { mode?: number; signal?: AbortSignal },
  ): Promise<void>;
  downloadFile(sourcePath: string): Promise<Uint8Array>;
  openPty(opts: PtyOpenOpts): Promise<PtySession>;
  /** Forwarded verbatim: a busy child pushes the host's provider idle clock. */
  refreshActivity(): Promise<void>;
}

export type HostMachineResolver = (hostId: string) => Promise<HostMachine | null>;

export const HOST_CAPABILITIES: ProviderCapabilities = {
  // A child has no separate disk to cold-store; archive is stop.
  serverSideArchive: false,
  archiveMaxDays: null,
  archiveTransition: { kind: "same-as-stop", expiryDays: null },
  framedSessionReconnect: true,
  reportsLastActivity: false,
  ptyReattach: false,
  secretEnv: false,
  // Base env lives only in this process; core rehydrates it before resumed work, as for any
  // rehydrating provider.
  environmentPersistence: "rehydrate",
  // No own idle clock: the host's clocks govern the machine, and the server-side reaper
  // deliberately skips children (their resolved idleTimeoutMinutes is 0).
  idleAutoStop: "none",
  // Inherited from the host by physics; the launch path refuses conflicting config.
  resourceSizing: "per-sandbox",
  egressEnforcement: "domain",
  egressAddressFamily: "dual",
  egressMaxEntries: null,
  workdirSurvivesStop: true,
};

interface ChildMeta {
  childId: string;
  hostId: string;
  workdir: string;
  /** The host's own workdir at launch — a directory delete must never touch, ever. */
  hostWorkdir: string;
  /** The workdir was provisioned fresh for this child; delete removes it. Shared never is. */
  ownsWorkdir: boolean;
  labels: Record<string, string>;
  createdAt: string;
}

const META_FILE = "meta.json";
const STOPPED_MARKER = "stopped";

/**
 * Find and terminate every process carrying the child marker, TERM first, KILL after a
 * bounded wait. Runs *without* the marker in its own environment so it cannot kill itself,
 * and never `exit`s early so callers can append follow-up commands.
 */
function killScript(childId: string): string {
  return [
    "set -u",
    `CID=${shellQuote(childId)}`,
    "find_pids() {",
    "  for d in /proc/[0-9]*; do",
    '    p="${d#/proc/}"',
    '    [ "$p" = "$$" ] && continue',
    `    grep -zqs "${HOST_CHILD_ENV}=$CID" "$d/environ" 2>/dev/null && echo "$p"`,
    "  done",
    "}",
    "signal_all() {",
    "  sig=$1",
    "  for p in $(find_pids); do",
    '    pgid=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d " ")',
    '    if [ -n "$pgid" ] && [ "$pgid" != "$$" ]; then kill "-$sig" "-$pgid" 2>/dev/null || true; fi',
    '    kill "-$sig" "$p" 2>/dev/null || true',
    "  done",
    "}",
    "signal_all TERM",
    "for _ in 1 2 3 4 5 6 7 8 9 10; do",
    '  [ -z "$(find_pids)" ] && break',
    "  sleep 0.5",
    "done",
    '[ -n "$(find_pids)" ] && signal_all KILL',
    "true",
  ].join("\n");
}

class HostChildSandbox implements Sandbox {
  readonly id: string;
  private baseEnv: Record<string, string>;

  constructor(
    private readonly machine: HostMachine,
    private readonly childId: string,
    private readonly workdir: string,
    baseEnv: Record<string, string> = {},
  ) {
    this.id = formatHostSandboxId(machine.hostId, childId);
    this.baseEnv = { ...baseEnv };
  }

  private get runtimeDir(): string {
    return childRuntimeDir(this.childId);
  }

  private childEnv(extra?: Record<string, string>): Record<string, string> {
    return { ...this.baseEnv, ...extra, [HOST_CHILD_ENV]: this.childId };
  }

  /** Adapter-internal control op: no child marker, so kill/probe scripts never match themselves. */
  private controlExec(script: string, timeoutMs = 30_000): Promise<ExecResult> {
    return this.machine.exec(["bash", "-c", script], { timeoutMs });
  }

  async state(): Promise<SandboxState> {
    const hostState = await this.machine.state();
    if (hostState !== "started") {
      // The machine is the child's substrate: a stopped/archived host is a stopped/archived
      // child, and a gone host takes its children with it.
      return hostState === "starting" ? "starting" : hostState;
    }
    const probe = await this.controlExec(
      `if [ ! -f ${shellQuote(`${this.runtimeDir}/${META_FILE}`)} ]; then echo gone; ` +
        `elif [ -f ${shellQuote(`${this.runtimeDir}/${STOPPED_MARKER}`)} ]; then echo stopped; ` +
        "else echo started; fi",
    );
    const answer = (probe.output ?? "").trim().split("\n").pop();
    if (answer === "gone" || answer === "stopped" || answer === "started") return answer;
    throw new PiPodError(`could not probe co-located pod state (exit ${probe.exitCode})`);
  }

  async waitUntilStarted(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.state();
      if (state === "started") return;
      if (state === "gone" || state === "error") {
        throw new PiPodError(`co-located pod is ${state}`);
      }
      if (Date.now() >= deadline) {
        throw new PiPodError(`co-located pod did not start within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async start(timeoutMs: number): Promise<void> {
    await this.machine.ensureStarted(timeoutMs);
    const cleared = await this.controlExec(
      `[ -f ${shellQuote(`${this.runtimeDir}/${META_FILE}`)} ] || exit 44; ` +
        `rm -f ${shellQuote(`${this.runtimeDir}/${STOPPED_MARKER}`)}`,
    );
    if (cleared.exitCode === 44) {
      throw new PiPodError("the host no longer holds this co-located pod's runtime directory");
    }
    if (cleared.exitCode !== 0) {
      throw new PiPodError(`could not start co-located pod (exit ${cleared.exitCode})`);
    }
  }

  rehydrateEnv(env: Record<string, string>): void {
    this.baseEnv = { ...env };
  }

  async exec(argv: string[], opts?: ExecOpts): Promise<ExecResult> {
    return this.machine.exec(argv, {
      ...opts,
      cwd: opts?.cwd ?? this.workdir,
      env: this.childEnv(opts?.env),
    });
  }

  uploadFile(destPath: string, contents: Uint8Array, mode?: number): Promise<void> {
    return this.machine.uploadFile(destPath, contents, mode);
  }

  uploadLocalFile(
    sourcePath: string,
    destPath: string,
    opts?: { mode?: number; signal?: AbortSignal },
  ): Promise<void> {
    return this.machine.uploadLocalFile(sourcePath, destPath, opts);
  }

  downloadFile(sourcePath: string): Promise<Uint8Array> {
    return this.machine.downloadFile(sourcePath);
  }

  openPty(opts: PtyOpenOpts): Promise<PtySession> {
    return this.machine.openPty({
      ...opts,
      cwd: opts.cwd ?? this.workdir,
      env: this.childEnv(opts.env),
    });
  }

  async setLabels(labels: Record<string, string>): Promise<void> {
    // Best-effort by design: labels are a TTL courtesy, and a stopped host cannot take them.
    if ((await this.machine.state()) !== "started") return;
    await this.controlExec(
      `f=${shellQuote(`${this.runtimeDir}/${META_FILE}`)}; [ -f "$f" ] || exit 0; ` +
        `node -e 'const fs=require("node:fs");const f=process.argv[1];` +
        `const m=JSON.parse(fs.readFileSync(f,"utf8"));` +
        `m.labels={...m.labels,...JSON.parse(process.argv[2])};` +
        `fs.writeFileSync(f,JSON.stringify(m))' "$f" ${shellQuote(JSON.stringify(labels))}`,
    ).catch(() => {});
  }

  async stop(_timeoutMs: number): Promise<void> {
    // A host at rest already took the processes with it; stop is then a met postcondition.
    if ((await this.machine.state()) !== "started") return;
    const stopped = await this.controlExec(
      `${killScript(this.childId)}\n` +
        `mkdir -p ${shellQuote(this.runtimeDir)} && touch ${shellQuote(`${this.runtimeDir}/${STOPPED_MARKER}`)}`,
      60_000,
    );
    if (stopped.exitCode !== 0) {
      throw new PiPodError(`could not stop co-located pod (exit ${stopped.exitCode})`);
    }
  }

  async applyRetention(_opts: { archiveAfterMinutes: number }): Promise<boolean> {
    return false;
  }

  /** No separate disk to cold-store: archive is stop, as the capabilities declare. */
  archive(timeoutMs: number): Promise<void> {
    return this.stop(timeoutMs);
  }

  refreshActivity(): Promise<void> {
    return this.machine.refreshActivity();
  }

  async delete(): Promise<void> {
    // A stopped host cannot be reached to clean the runtime directory. The row still goes
    // gone; the orphaned directory is bounded litter on the user's own disk.
    if ((await this.machine.state()) !== "started") return;
    let meta: ChildMeta | null = null;
    try {
      const raw = await this.machine.downloadFile(`${this.runtimeDir}/${META_FILE}`);
      meta = JSON.parse(new TextDecoder().decode(raw)) as ChildMeta;
    } catch {
      meta = null;
    }
    const removals = [`rm -rf ${shellQuote(this.runtimeDir)}`];
    // Only a workdir provisioned fresh for this child is child-owned. The guard is belt and
    // braces on purpose: the recorded ownership decision AND agreement with the handle's
    // workdir AND inequality with the host's own workdir. Deleting a directory the child did
    // not create is the one unrecoverable mistake this provider can make.
    if (
      meta?.ownsWorkdir &&
      meta.workdir === this.workdir &&
      meta.workdir !== meta.hostWorkdir
    ) {
      removals.push(`rm -rf ${shellQuote(meta.workdir)}`);
    }
    const deleted = await this.controlExec(`${killScript(this.childId)}\n${removals.join(" && ")}`, 60_000);
    if (deleted.exitCode !== 0) {
      throw new PiPodError(`could not delete co-located pod (exit ${deleted.exitCode})`);
    }
  }
}

class HostProvider implements SandboxProvider {
  readonly name = HOST_PROVIDER_NAME;
  readonly capabilities = HOST_CAPABILITIES;

  constructor(private readonly resolver: HostMachineResolver) {}

  async checkAuth(): Promise<void> {
    // No account, no credential: placement validation decides whether a host is reachable.
  }

  async resolveImage(ref: string): Promise<ImageInfo | null> {
    // No image is ever materialized; the child boots the host's filesystem as it stands.
    return { ref };
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    const placement = spec.placement;
    if (!placement) {
      throw new PiPodError("the host provider requires launch placement (which pod hosts this one)");
    }
    if (placement.ownsWorkdir && spec.workdir === placement.hostWorkdir) {
      throw new PiPodError("a child cannot own its host's workdir");
    }
    const machine = await this.resolver(placement.hostId);
    if (!machine) {
      throw new PiPodError(`host ${placement.hostId} is not available to place a pod on`);
    }
    const childId = spec.labels["pi-pod-server/pod"] ?? crypto.randomUUID();
    const runtimeDir = childRuntimeDir(childId);
    const meta: ChildMeta = {
      childId,
      hostId: machine.hostId,
      workdir: spec.workdir,
      hostWorkdir: placement.hostWorkdir,
      ownsWorkdir: placement.ownsWorkdir,
      labels: spec.labels,
      createdAt: new Date().toISOString(),
    };
    const prepared = await machine.exec(
      ["bash", "-c", `mkdir -p ${shellQuote(runtimeDir)} ${shellQuote(spec.workdir)}`],
      { timeoutMs: 30_000 },
    );
    if (prepared.exitCode !== 0) {
      throw new PiPodError(`could not prepare the co-located pod runtime (exit ${prepared.exitCode})`);
    }
    await machine.uploadFile(
      `${runtimeDir}/${META_FILE}`,
      new TextEncoder().encode(JSON.stringify(meta)),
      0o600,
    );
    return new HostChildSandbox(machine, childId, spec.workdir, spec.env);
  }

  /**
   * gc works from provider listings, which this provider cannot give: children are recorded
   * in pod rows, not in any account the adapter could enumerate. Declared gap — the
   * reconciler and gc deliberately skip the host provider and rely on row state plus the
   * state() overlay.
   */
  async list(_labels: Record<string, string>): Promise<SandboxInfo[]> {
    return [];
  }

  async get(id: string, hints?: { workdir?: string }): Promise<Sandbox | null> {
    const parsed = parseHostSandboxId(id);
    if (!parsed) throw new PiPodError(`not a host sandbox id: ${id}`);
    const machine = await this.resolver(parsed.hostId);
    if (!machine) return null;
    return new HostChildSandbox(machine, parsed.childId, hints?.workdir ?? "/workspace");
  }
}

export function createHostProvider(resolver: HostMachineResolver): SandboxProvider {
  return new HostProvider(resolver);
}

/**
 * Registry factory. Reachable only through launch placement: without a server-injected
 * resolver there is no machine to place anything on, and saying so beats a missing-credential
 * error that names an env var which does not exist.
 */
export const createUnresolvedHostProvider = (_config: Record<string, unknown>): SandboxProvider => {
  throw new PiPodError('the "host" provider is selected by launch placement, not by provider config', {
    hint: "launch with `pi-pod launch --on <pod>` (or placement.host in the API) to co-locate a pod on an existing one",
  });
};
