import type { PiPodConfig } from "../../core/config.js";
import type { ImageRecipe } from "../../core/image.js";
import type { ConfigProvenanceEntry } from "../../core/userconfig.js";
import type { ServerEnv } from "../env.js";
import type { KekProvider } from "../secrets/crypto.js";
import type { PlatformCredentialSnapshot } from "./providercred.js";
import type { PiResourceOverrides } from "./pi-resources.js";
import type { Clamp } from "../settings/merge.js";

export interface PodRow {
  id: string;
  org_id: string;
  template_id: string | null;
  user_id: string;
  /** The pod that asked the server to launch this one; null for user launches. */
  parent_pod_id: string | null;
  /** Machine owner for co-located (host-provider) pods; null for machine-backed pods. */
  host_pod_id: string | null;
  /** Stable native host identity; absent only in historical fixtures/legacy rows. */
  sandbox_host_id?: string | null;
  /** Top user-launched ancestor (self for roots): quota and listing never walk the tree. */
  lineage_root_id: string;
  lineage_depth: number;
  name: string;
  provider: string;
  provider_sandbox_id: string | null;
  /** Gateway-to-pod carrier frozen at launch for dual-path rollout. */
  transport: "ws";
  project: string | null;
  state: string;
  provider_state: string;
  provider_state_changed_at: string;
  resolved_config: ResolvedConfigReport;
  gateway_id: string | null;
  gateway_heartbeat_at: string | null;
  provisioning_heartbeat_at: string | null;
  state_reason: string | null;
  last_activity_at: string | null;
  work_lease_until: string | null;
  /** Machine-readable cause of the last leave of `started` (`idle_stop`, `provider_stopped`, …). */
  last_stop_cause: string | null;
  /** Highest shim journal seq a gateway has decoded; a replacement asks the shim for events after this. */
  last_pod_seq: string | number | null;
  /** Session file last observed open in pi; a restart pins it instead of trusting `--continue`. */
  pi_session_file: string | null;
  /** Server-maintained set of account credential providers this pod may lease. */
  credential_providers: string[] | null;
  created_at: string;
  /** Provenance only: the pod whose session this one was forked from. */
  forked_from_pod_id: string | null;
}

/** Frozen at launch (spec §6): "what policy did this pod actually run under" is always answerable. */
export interface ResolvedConfigReport {
  config: PiPodConfig;
  image: {
    ref: string;
    managed: boolean;
    provenance: ImageRecipe["provenance"];
    assetDigest: string;
    status: "unknown" | "ready" | "preparing" | "failed";
  };
  clamps: Clamp[];
  /** Explicit org/template/user winners; resolve previews and historical rows may name project. */
  configProvenance: ConfigProvenanceEntry[];
  /** Participating config bundles in effective precedence order. */
  layerOrder: Array<"org" | "template" | "user" | "project">;
  /** Names of every secret key that traveled (spec §7); values never appear. */
  secretKeys: string[];
  /** Which stored bundle supplied each key; historical rows may name project. */
  secretScopes?: Record<string, string>;
  /** Layers that set the same key and were outranked, lowest precedence first. */
  secretShadows?: Record<string, string[]>;
  /** Init scripts in scope-positioned run order; historical rows may include project. */
  initSteps?: Array<{ scope: InitScope; status: string; outputTail?: string }>;
  /**
   * The composed bake path follows layerOrder. "baked" means the pod booted an
   * image that already contains them; "live" means they ran in the pod as a pre-init step
   * because that image is not built yet (or the image is a custom pin).
   */
  bake?: { digest: string; mode: "baked" | "live"; status: string; outputTail?: string };
  /** Provider ids the materialized pi sign-in covers (§7); names only, never values. */
  piAuthProviders?: string[];
  /** Non-secret progress for the selected Pi settings bundle materialized at launch. */
  piSettings?: {
    files: string[];
    bytes: number;
    packageCount: number;
    droppedKeys: string[];
    status: "pending" | "installing" | "ready" | "degraded";
    installedPackageCount?: number;
    failedPackageCount?: number;
    /**
     * Install-resolved npm package identities — the code channel's attested set. Launch-time
     * truth: the client executes extension rendering code only for entries recorded here.
     */
    resolvedPackages?: Array<{ name: string; version: string; source: string }>;
  };
  egress: { description: string; mode: "open" | "allowlist" };
  /** Wall-clock milliseconds per provisioning phase, recorded as each one completes. */
  timings?: Record<string, number>;
  /** Shim uploaded during provisioning; the gateway skips its own upload while this matches. */
  shim?: { version: string; launcher: string; sessionNaming: string };
  /** This pod was reused for a later launch: its warm disk was refreshed, not re-created. */
  reused?: boolean;
  /** A reuse attempt refused this pod (dirty/diverged clone) and returned it to stopped. */
  reuseRefused?: string;
  /**
   * Client-driven workspace seeding (clone or archive). `pending` means the launch asked the
   * server to hold Pi until the client has filled the workdir; the gate opens when the seed
   * finishes, is skipped, or times out. Only safe metadata: never a URL with userinfo, never a
   * credential.
   */
  workspaceSeed?: WorkspaceSeedReport;
  /**
   * Pi resource paths this launch explicitly asked for (extensions, skills, prompt templates).
   * The argv that loads them lives in `config.pi.args`; this is the requirement itself, which
   * every start — including a gateway cold start years later — checks before running Pi.
   */
  piResources?: PiResourceOverrides;
  /**
   * Retired: the marker a withdrawn co-located worker protocol wrote here. Only ever read to
   * refuse a pod whose recorded launch this server can no longer reproduce (§ retired-launch-
   * state). Nothing writes it.
   */
  subagentRuntime?: unknown;
  workdir: string;
  warnings: string[];
  notificationsRedacted: boolean;
  retention?: {
    idleTimeoutMinutes: number;
    /** Provider-native crash fallback; may exceed the server-enforced idle policy above. */
    providerIdleTimeoutMinutes?: number;
    providerIdleTimeoutMinimumApplied?: boolean;
    archiveTransition: { kind: "same-as-stop"; expiryDays: null } | { kind: "after-stop"; maxDelayDays: number };
    effectiveArchiveAfterMinutes: number | null;
    providerExpiryDocumented: boolean;
  };
}

export interface WorkspaceSeedReport {
  status: "pending" | "seeding" | "seeded" | "failed" | "skipped";
  kind?: "clone" | "archive";
  /** When the gate was armed (launch) or, for an unflagged launch, when the first seed began. */
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Archive: compressed bytes received. Clone: absent. */
  bytes?: number;
  /** Archive: members extracted. Clone: top-level entries placed. */
  entries?: number;
  host?: string;
  branch?: string;
  commit?: string;
  credentialed?: boolean;
  /** Failure or skip reason, already redacted. */
  reason?: string;
}

export interface PodLaunchResult {
  pod: PodRow;
  /** Complete redacted launch report; secret values and Pi contents never enter this object. */
  report: ResolvedConfigReport;
}

export interface PodServiceDeps {
  env: ServerEnv;
  kek: KekProvider;
  /**
   * Boot snapshot of the platform provider credentials (see providercred
   * `snapshotPlatformCredentials`). Captured in `main()` before any overlay;
   * callers resolve it via `platformCredentialsOf(deps)`. Optional so existing
   * constructions keep compiling — the fallback derives from immutable `env`.
   */
  platformCredentials?: PlatformCredentialSnapshot;
  /** Awaited immediately after the durable pod row exists, before provisioning starts. */
  onPodCreated?: (podId: string) => Promise<void>;
  /** In-process gateway hook (ROLE=all); split deployments rely on the gateway sweep. */
  onPodStarted?: (podId: string) => void;
  /** Explicit test seam; production defaults to the durable launch-control table. */
  launchAdmissionCheck?: () => Promise<void>;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}
export type InitScope = "org" | "template" | "user" | "project";
