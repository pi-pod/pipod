/**
 * src/providers/types.ts — the ONLY provider-related import allowed outside src/providers/ (§3.1, D4).
 *
 * The interface is deliberately narrow: sized to what the session lifecycle (§6) actually
 * needs, not to any provider's full API. Anything a provider offers beyond it is invisible
 * to the core; anything a provider lacks is declared as a capability gap with a defined
 * core-side fallback (§3.2).
 */

/**
 * The states a pod can be in, as the core understands them.
 *
 * Providers may have far more than six, counting transient build and resize steps, so an
 * adapter's job is to collapse its vocabulary into this one.
 * What it must not collapse is a distinction a caller would act on differently, which is why
 * `archived` and `error` are here rather than folded into `stopped`: restoring from cold
 * storage takes minutes where a stopped pod takes seconds, and an errored pod is not coming
 * back at all. `pi-pod list` prints these verbatim, so a state that lies is a listing that
 * lies.
 *
 * The rule for anything reading them: only `started` means usable right now. Everything else
 * needs a `start()` first, or cannot be started at all.
 */
export type SandboxState =
  | "starting"
  | "started"
  | "stopped"
  /** Disk moved to cold storage. Restorable by `start()`, but slowly (§9). */
  | "archived"
  /** The provider failed this pod. Its disk may survive, but starting it will not work. */
  | "error"
  | "gone";

/** Fidelity with which a provider can enforce an egress allowlist (§11.1). */
export type EgressEnforcement = "domain" | "cidr";

/** Address families a provider accepts in a CIDR allowlist (§11.1). */
export type EgressAddressFamily = "ipv4" | "dual";

export interface ProviderCapabilities {
  /**
   * Provider moves a long-stopped sandbox to cold storage by itself, without pi-pod running.
   *
   * This is the non-destructive replacement for what used to be a server-side delete: the
   * filesystem survives and `start()` brings it back, so nothing is riding on the launcher
   * ever being run again. Where it is false, a stopped sandbox keeps its full disk until a
   * human reclaims it and core says so rather than implying a bound that does not exist.
   */
  serverSideArchive: boolean;
  /**
   * Longest archive window the provider will actually honor, in days, or `null` if unbounded.
   *
   * Separate from `serverSideArchive` because exceeding it can be invisible: a provider may
   * accept a longer interval without complaint and apply a lower effective cap, so the only
   * symptom would be a sandbox archiving earlier than the config said, long
   * after anyone was watching. Core clamps to this and preflight names the gap (§3.2) rather
   * than letting the config read as authoritative.
   */
  archiveMaxDays: number | null;
  /**
   * How provider storage relates to a logical stop. `archiveMaxDays: null` cannot tell
   * status rendering whether there is no cap or no second archive timer; this field can.
   */
  archiveTransition:
    | { kind: "same-as-stop"; expiryDays: null }
    | { kind: "after-stop"; maxDelayDays: number };
  /**
   * Whether a reconnect can resume the same framed RPC process. Distinct from `ptyReattach`,
   * which may only mean a human terminal mux survives.
   */
  framedSessionReconnect: boolean;
  /**
   * Provider reports `SandboxInfo.lastActivityAt` — when *it* last saw the sandbox used.
   *
   * Load-bearing for gc (§9), not just for display. Deciding a sandbox is abandoned requires
   * knowing when it was last touched, and the launcher cannot supply that: it runs on a client
   * that sleeps and disconnects, so a host-maintained timestamp records the health of a laptop
   * rather than the state of a sandbox. Where this is false, core does not guess from creation
   * time — a long-lived sandbox in daily use is old, not abandoned — so the timed sweep is
   * declared unavailable and `pi-pod gc <id>` by name can still logically archive one.
   */
  reportsLastActivity: boolean;
  /** PTY survives client disconnect; reattach supported. */
  ptyReattach: boolean;
  /** Masked/secret-typed env vars available. */
  secretEnv: boolean;
  /**
   * Whether creation-time environment variables survive a provider stop/start cycle.
   *
   * `"persistent"` means the provider carries them with the sandbox. `"rehydrate"` means
   * core must reread the host-side value-free source recipe and call `rehydrateEnv()` before
   * starting a resumed keepalive or user/session exec/PTY. Management-only operations may
   * resume the sandbox without it when they do not launch a user/session process.
   */
  environmentPersistence: "persistent" | "rehydrate";
  /**
   * Whether the provider can stop a sandbox that has gone idle (§8).
   *
   * `"configurable"` — core sets the idle window from `config.idleTimeoutMinutes` and calls
   *                    `Sandbox.refreshActivity()` while a pi session is producing traffic.
   *                    This is what makes a detached session safe to walk away from: nothing
   *                    on the host has to stay alive for the sandbox to be reclaimed.
   * `"none"`         — the provider has no idle concept. Core reports that
   *                    `idleTimeoutMinutes` is unenforceable and the sandbox lives until the
   *                    orphan TTL or `pi-pod gc`; it is never silently treated as honored.
   */
  idleAutoStop: "none" | "configurable";
  /**
   * Maximum idle window this provider can honor, in minutes. When present, configured values
   * are clamped to this ceiling and 0 (which normally disables auto-stop) becomes this maximum
   * because the provider cannot run without a deadline. Core reports both substitutions.
   */
  idleAutoStopMaxMinutes?: number;
  /**
   * Where `config.resources` takes effect.
   *
   * `"per-sandbox"` — sizing is chosen when the sandbox is created.
   * `"per-image"`   — sizing is a property of the image, baked in when it is built; the
   *                   provider rejects per-sandbox sizing outright (snapshot-backed providers
   *                   commonly return an API error). Core routes
   *                   `resources` to `pi-pod image build` instead of to `create()`, rather
   *                   than letting an adapter drop the user's configured sizing silently.
   */
  resourceSizing: "per-sandbox" | "per-image";
  /**
   * Resource fields the provider cannot set even at the location above (for example, a disk
   * size controlled by the account plan). Core omits these from derived image tags/builds and
   * reports the limitation instead of claiming they were applied.
   */
  unsupportedResourceSizing?: readonly ("cpu" | "memoryGB" | "diskGB")[];
  /** Fidelity of allowlist enforcement (§11.1). */
  egressEnforcement: EgressEnforcement;
  /**
   * Address families the provider accepts in a CIDR allowlist. Only meaningful when
   * `egressEnforcement === "cidr"`.
   *
   * `"ipv4"` providers reject IPv6 entries outright. Core resolves allowed hostnames to
   * A records only for those, rather than handing over entries that fail.
   */
  egressAddressFamily: EgressAddressFamily;
  /**
   * Maximum number of entries the provider's allowlist accepts, or `null` for no known limit.
   *
   * A hostname allowlist routinely resolves past a small cap, so core aggregates the resolved
   * CIDRs to fit (§11.1) rather than truncating them — dropping entries would break
   * connectivity with nothing to explain it.
   */
  egressMaxEntries: number | null;
  /**
   * Whether `stop()` then `start()` keeps the configured workdir's contents.
   *
   * `start()` only means the process is up. A persist layer that snapshots `$HOME`
   * and not the workdir can hand back an empty `/workspace` under a started sandbox.
   * This flag is what core is entitled to *say* — "the clone remains intact" — and
   * what conformance verifies. There is deliberately no init-replay fallback: replay
   * cannot preserve uncommitted or untracked work.
   */
  workdirSurvivesStop: boolean;
}

/** Normalized egress policy handed to the adapter by core (§11.1, D5). */
export type EgressPolicy = { mode: "open" } | { mode: "allowlist"; hosts: string[] };

export interface SandboxSpec {
  /** Provider-native image reference (§12). */
  image: string;
  /** Exact configured workspace path; unlike labels, this is never sanitized or truncated. */
  workdir: string;
  /** Omitted by core when `capabilities.resourceSizing === "per-image"` (§4.1). */
  resources?: { cpu?: number; memoryGB?: number; diskGB?: number };
  /** Secrets — the adapter must never log or persist these (§7.3). */
  env: Record<string, string>;
  /** Mapped to provider-native metadata/tags. */
  labels: Record<string, string>;
  /**
   * Minutes a sandbox may sit continuously *stopped* before the provider archives it (§9).
   * Honored iff `capabilities.serverSideArchive`. 0 means "the longest window the provider
   * offers" — core never asks for "never", because a sandbox nothing ever reclaims is the
   * failure mode this field exists to prevent.
   */
  archiveAfterMinutes: number;
  /** Idle window before the provider stops the sandbox; 0 requests disabled auto-stop, but a
   *  provider with `idleAutoStopMaxMinutes` substitutes that documented maximum (§8). */
  idleTimeoutMinutes: number;
  /** Normalized by core from config (§11.1, D5). Hostnames and/or CIDRs. */
  egress: EgressPolicy;
  /**
   * Trusted immutable tenant owner (§7.2, plan workstream 5). Provisioned by the
   * control plane from the authenticated launch context — never from mutable
   * labels. Adapters that cannot convey it omit it (legacy unowned layout).
   */
  owner?: { userKey: string };
  /**
   * Stable control-plane operation key (§6.5, plan workstream 4). Sent with the
   * create so a lost response can be recovered by key instead of retried blind.
   */
  operationKey?: string;
  /**
   * Co-located placement (host provider only): which machine owner hosts this sandbox,
   * whether the workdir was provisioned fresh for it (fresh → child-owned, deleted with it;
   * shared → never deleted), and the host's own workdir as a hard delete guard. Ignored by
   * machine-backed providers.
   */
  placement?: { hostId: string; ownsWorkdir: boolean; hostWorkdir: string };
}

export interface ImageInfo {
  /** The reference as the provider knows it. */
  ref: string;
  /** Provider-reported state, when available (e.g. "active"). */
  state?: string;
  createdAt?: string;
}

export interface ExecOpts {
  cwd?: string;
  /** Extra env for this exec only; merged over the sandbox environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
}

export interface ExecResult {
  exitCode: number;
  /** Combined captured output, when the adapter can provide it. */
  output?: string;
}

export interface SandboxInfo {
  id: string;
  labels: Record<string, string>;
  state: SandboxState;
  createdAt?: string;
  /**
   * When the provider last saw activity on this sandbox — what `pi-pod list` orders by (§9).
   *
   * Deliberately the provider's own clock rather than something the launcher records. A
   * launcher-written timestamp would only ever advance while a client was attached, and the
   * client is a laptop: it sleeps, loses network, and gets closed. Ordering by it would mean
   * ordering by a value whose freshness depends on a machine that is not the source of truth
   * about the sandbox. Where a provider tracks this itself, it is correct without anything on
   * the host running and may use the same field for idle auto-stop.
   *
   * Optional because not every provider will have it. Core falls back to `createdAt`, which
   * answers a different question ("which is newest") but at least answers it honestly.
   */
  lastActivityAt?: string;
}

export interface PtySession {
  /**
   * Provider-native session id, stable across client disconnects.
   *
   * Recorded as a sandbox label so a *later launcher process* can find its way back to the
   * still-running pi — `PtySession.reattach()` only helps within one process, and the case
   * that matters (closed laptop, `pi-pod attach` tomorrow) crosses processes.
   */
  readonly id: string;
  /** Raw keystrokes. */
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: Uint8Array) => void): void;
  /** `null` when the channel ended without a native status — pi's exit arrives in-band
   *  from the shim on every provider (§7), so this is diagnostic, not load-bearing. */
  onExit(cb: (code: number | null) => void): void;
  /** Present iff capabilities.ptyReattach. */
  reattach?(): Promise<void>;
  /** Detach without killing the remote process. */
  close(): void;
}

export interface PtyOpenOpts {
  argv: string[];
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface Sandbox {
  readonly id: string;
  state(): Promise<SandboxState>;
  waitUntilStarted(timeoutMs: number): Promise<void>;
  /**
   * Bring a stopped sandbox back up, preserving its filesystem (§8). Running processes do
   * not survive a stop, so callers must expect to start pi again. Before core starts a resumed
   * session or keepalive, providers declaring `environmentPersistence: "rehydrate"` receive
   * current values through `rehydrateEnv()`. Management-only operations may start/inspect the
   * sandbox without rehydration when they do not launch a user/session process.
   */
  start(timeoutMs: number): Promise<void>;
  /**
   * Set the in-memory base environment merged under all future exec/PTY process overrides.
   * Values must never be persisted to pod disk, labels, metadata, or logs.
   */
  rehydrateEnv(env: Record<string, string>): void;
  /** Streamed stdout/stderr via ExecOpts callbacks. */
  exec(argv: string[], opts?: ExecOpts): Promise<ExecResult>;
  /** Upload generated data already held in memory. */
  uploadFile(destPath: string, contents: Uint8Array, mode?: number): Promise<void>;
  /** Stream a host file into the sandbox without buffering the whole file in core. */
  uploadLocalFile(
    sourcePath: string,
    destPath: string,
    opts?: { mode?: number; signal?: AbortSignal },
  ): Promise<void>;
  /** Read one regular sandbox file without text decoding. */
  downloadFile(sourcePath: string): Promise<Uint8Array>;
  openPty(opts: PtyOpenOpts): Promise<PtySession>;
  /**
   * Rejoin a PTY session started by an earlier launcher process, by its `PtySession.id`.
   * `null` when that session no longer exists — the caller then starts a fresh pi in the same
   * workspace, which is a degraded but correct outcome (§3.2).
   *
   * Optional: providers without it always land on the fresh-pi path.
   */
  reconnectPty?(sessionId: string, opts: { cols: number; rows: number }): Promise<PtySession | null>;
  /** TTL heartbeat (§9). */
  setLabels(labels: Record<string, string>): Promise<void>;
  /** Strict provider idle-clock extension used by deployment safety preflights. */
  protectFromAutoStop?(): Promise<void>;
  /**
   * Replace a running sandbox's provider-enforced egress policy.
   *
   * Optional because not every provider can mutate networking after creation. The gateway uses
   * this to migrate pre-WebSocket pods whose frozen allowlist omitted the server callback host;
   * it must never silently broaden the policy beyond the explicitly supplied replacement.
   */
  updateEgress?(egress: EgressPolicy): Promise<void>;
  /**
   * Shut the sandbox down while keeping its disk (§8, §9) — the end state of every normal
   * session. Running processes do not survive; the clone and uncommitted work do. Environment
   * survives natively only when `environmentPersistence` is `"persistent"`; otherwise core
   * rehydrates it before resumed processes start. Already-stopped is success, not an error:
   * teardown races the provider's own idle timer and must be idempotent under it.
   */
  stop(timeoutMs: number): Promise<void>;
  /**
   * Bring an already-created sandbox's retention settings in line with config (§9).
   *
   * Retention is chosen at `create()`, so a sandbox created before the config changed keeps
   * whatever it was born with — including, for sandboxes predating the switch from deletion to
   * archival, a server-side delete timer that the new config has no way to reach. Without
   * this, "pi-pod never destroys a sandbox" would be true only of sandboxes made after the
   * change, which is not what anyone reads it as.
   *
   * Returns whether anything actually changed, so callers can stay quiet when it did not.
   */
  applyRetention(opts: { archiveAfterMinutes: number }): Promise<boolean>;
  /**
   * Move a stopped sandbox's filesystem to cold storage (§9).
   *
   * Reversible by `start()`, at the cost of a slower restore. Implementations must stop the
   * sandbox first if the provider requires it — callers ask for the end state, not the steps.
   */
  archive(timeoutMs: number): Promise<void>;
  /**
   * Conditional archive-if-still-stopped (additive, sandbox provider only). Resolves with
   * the host outcome; rejects with `archive_unsupported` when the host predates the route
   * so callers can take the safe re-read fallback instead of force-archiving.
   */
  archiveIfStopped?(opts: {
    timeoutMs: number;
    expectedRevision?: number;
    expectedStoppedAt?: string;
  }): Promise<{ archived: boolean; outcome: string }>;
  /**
   * Push the provider's idle clock forward — "a human is still using this" (§8).
   *
   * Called while attached whenever the pi session produced traffic since the last tick. The
   * moment nothing calls it, the idle window starts running down, which is exactly the
   * behavior a detached or disconnected session needs. No-op when the provider has no idle
   * concept.
   */
  refreshActivity(): Promise<void>;
  /**
   * Destroy the sandbox and its disk, irreversibly.
   *
   * Nothing on the automatic path calls this any more (§9): sessions end in `stop()` and the
   * provider archives from there. It survives for the two cases where destruction is the
   * point — a sandbox a human named to `pi-pod gc --delete`, and `doctor --deep`'s throwaway
   * probe, which exists for the length of one `pi --version`.
   */
  delete(): Promise<void>;
}

export interface SandboxProvider {
  /** e.g. "sandbox" */
  readonly name: string;
  /** Static and honest (§3.2). */
  readonly capabilities: ProviderCapabilities;

  /**
   * Dynamic upper bounds imposed by this provider deployment or account. Core clamps larger
   * requests before image selection and provisioning so dry-run describes what will run.
   * Omitted fields have no known provider maximum; this is capacity, not currently-free quota.
   *
   * Optional deployment env (boot snapshot on server paths): adapters whose
   * maximums depend on deployment flags (e.g. the sandbox 8-GiB gate) read
   * them here instead of ambient process.env, so ServerEnv stays the single
   * source of truth. Omitted (CLI/tests): ambient fallback.
   */
  resourceMaximums?(env?: { POD_ALLOW_8GIB_MEMORY?: unknown }): Promise<Partial<{ cpu: number; memoryGB: number; diskGB: number }>>;

  /** Throws with login instructions (preflight/doctor). */
  checkAuth(): Promise<void>;
  /** `null` = missing → fail fast (§12). */
  resolveImage(ref: string): Promise<ImageInfo | null>;
  create(spec: SandboxSpec): Promise<Sandbox>;
  /** Used by gc (§9). */
  list(labels: Record<string, string>): Promise<SandboxInfo[]>;

  /**
   * Re-acquire a handle on an existing sandbox by id — what `pi-pod attach` reconnects
   * through (§8). `null` when it no longer exists.
   *
   * `workdir` is a durable core-side hint for providers whose mount setup cannot fit in
   * native metadata. Adapters that do not need it ignore it.
   */
  get(id: string, hints?: { workdir?: string }): Promise<Sandbox | null>;

  /**
   * Withdraw a published managed image so the next launch rebuilds it — the recovery path
   * for an image that turned out broken only at runtime (pods forked from it crash-loop).
   * Returns whether anything was actually withdrawn. Optional: registry-backed providers
   * have no publish-by-name state to withdraw.
   */
  unpublishImage?(ref: string): Promise<boolean>;

  /**
   * gc (§9) works from `list()` results, which are info records rather than handles — hence
   * the by-id forms. Both are optional so that an adapter which genuinely cannot do one fails
   * loudly at gc time instead of quietly leaking orphans; the conformance suite (§14) requires
   * `archiveById`, since that is the path a bare `pi-pod gc` takes.
   */
  archiveById?(id: string, timeoutMs: number): Promise<void>;
  deleteById?(id: string): Promise<void>;

  /**
   * Host environment variables holding this provider's *own* credentials.
   *
   * Injected into every pod (§7.3): the in-pod keepalive authenticates its activity refresh
   * with them, which is what lets a detached pod live exactly as long as its work does. The
   * cost is stated in §15 — a pod holding this credential can reach every pod in the org.
   * The core stays provider-blind: each adapter names its own.
   */
  readonly credentialEnvNames?: readonly string[];

  /**
   * Hostname of the provider's control-plane API, for the egress builtins (§11.1).
   *
   * The in-pod keepalive dials this from inside the pod, so an allowlist that omits it turns
   * the keepalive into a silent no-op and every detached pod back into a 15-minute casualty.
   */
  readonly keepaliveApiHost?: string;

  /**
   * The in-pod keepalive watcher (§8): script source the launcher uploads and starts inside
   * the pod, where it vouches for *running pi work* against the provider's idle clock — the
   * clock only counts authenticated API traffic, so without this a detached pod doing an
   * hour of work is "idle" and is stopped mid-task. Reads its credential from the pod
   * environment ({@link credentialEnvNames}); never bakes it into the file.
   *
   * The options are activity policy, never credentials: adapters may embed them in the
   * generated file while the provider key continues to arrive only through process env.
   *
   * Optional: providers without one rely on the client-side heartbeat alone, and only while
   * a client is attached.
   */
  keepaliveScript?(
    sandboxId: string,
    options: { piCommand: string; idleTimeoutMinutes: number },
  ): string;
}

/**
 * Optional: adapters that can publish the canonical OCI artifact (§12) implement this so
 * `pi-pod image build` works. Absence is not a capability lie — it is reported as
 * "this provider cannot build images" and the user builds/pushes out of band.
 */
export interface ImageBuilder {
  buildImage(opts: {
    dockerfilePath: string;
    contextDir: string;
    ref: string;
    /**
     * Sizing to bake into the image. Only meaningful when
     * `capabilities.resourceSizing === "per-image"`; ignored otherwise.
     */
    resources?: { cpu?: number; memoryGB?: number; diskGB?: number };
    onLog?: (line: string) => void;
    /**
     * Rebuild even when a published artifact already exists under `ref`.
     * Adapters that can replace do so; adapters that cannot fail loudly.
     * Concurrent races without this flag remain a benign no-op.
     */
    force?: boolean;
  }): Promise<void>;
}

export function supportsImageBuild(p: SandboxProvider): p is SandboxProvider & ImageBuilder {
  return typeof (p as Partial<ImageBuilder>).buildImage === "function";
}

/**
 * Optional: adapters backed by a runtime cache can materialize a canonical managed image
 * from an operator-owned OCI mirror. Whether a private artifact exists is deliberately not part
 * of the contract: providers resolve their local cache, while deployment owns authenticated
 * preloading and public mirrors may be fetched best-effort by the rollout worker.
 */
export interface ImageMirror {
  fetchMirroredImage(ref: string, onLog?: (line: string) => void): Promise<void>;
}

export function supportsImageMirror(p: SandboxProvider): p is SandboxProvider & ImageMirror {
  return typeof (p as Partial<ImageMirror>).fetchMirroredImage === "function";
}

/** A provider adapter factory. `providerConfig` is the `providers.<name>` config block (§4.1). */
export type ProviderFactory = (providerConfig: Record<string, unknown>) => SandboxProvider;
