/**
 * src/account/api.ts — the REST half of account mode (account-mode-spec §5, §7).
 *
 * A thin, typed client over the server's `/v1` surface. One deliberate behavior: a 401 is
 * retried exactly once by refreshing directly at Zitadel, rewriting `auth.json` with the new
 * pair, so a laptop that slept through a token expiry never surfaces it (§3.2). A failed
 * refresh names the fix (`pipod login`) instead of leaking an HTTP status.
 */
import * as fs from "node:fs";
import { Readable } from "node:stream";
import { PiPodError } from "../errors.js";
import { debug } from "../log.js";
import type { ConfigProvenanceEntry } from "../userconfig.js";
import { discover, refreshTokens, DEFAULT_CLIENT_ID } from "./oidc.js";
import { readAccountAuth, withAccountAuthLock, writeAccountAuth, type AccountAuth } from "./store.js";
import {
  isWorkstationHostId,
  parseWorkstationDemand,
  parseWorkstationStatus,
  WorkstationNotReadyError,
  type WorkstationStatus,
} from "./workstation.js";
import {
  parseAccountBilling,
  parseBillingAccountPlan,
  parsePlanChangeQuote,
  type AccountBilling,
  type BillingAccountPlan,
  type BillingPlanKey,
  type PlanChangeQuoteView,
} from "./billing.js";

export const REST_TIMEOUT_MS = 30_000;
/** Extra time on top of a long-poll `wait` so a just-in-time answer is not raced. */
export const LONG_POLL_SLACK_MS = 10_000;
/** A workspace clone runs a network fetch inside the sandbox; a large repository takes minutes. */
export const WORKSPACE_CLONE_TIMEOUT_MS = 15 * 60_000;
/** Streaming a multi-hundred-MiB archive and extracting it in the sandbox is slow on purpose. */
export const WORKSPACE_ARCHIVE_TIMEOUT_MS = 30 * 60_000;
/** The MIME type the archive route expects: a gzip-compressed POSIX tar stream. */
export const WORKSPACE_ARCHIVE_CONTENT_TYPE = "application/x-tar+gzip";

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Expected "not found is fine" paths return null instead of throwing. */
  allow404?: boolean;
  /** Override the default fetch timeout (30s, or wait + slack for long-polls). */
  timeoutMs?: number;
  /** Caller-owned cancellation (Ctrl-C mid-upload); combined with the timeout. */
  signal?: AbortSignal;
}

/** A request whose body is a file on disk, streamed rather than read into memory. */
export interface ApiUploadOptions {
  method: "PUT" | "POST";
  filePath: string;
  contentType: string;
  /** Sent as Content-Length so the server can refuse an oversized body before reading it. */
  contentLength: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with cumulative bytes handed to the socket; drives the client-side progress line. */
  onProgress?: (sentBytes: number) => void;
}

/** Body of `POST /pods/:id/workspace/clone`; the credential travels once and is never stored. */
export interface WorkspaceCloneBody {
  url: string;
  branch: string;
  commit: string;
  credential?: { username: string; password: string };
}

/** What the workspace seed routes answer; every field is optional because the contract is additive. */
export interface WorkspaceSeedResult {
  id?: string;
  kind?: "clone" | "archive";
  status?: WorkspaceSeedReport["status"];
  /** Present when the server measured the transfer; clients only display it. */
  bytes?: number;
  uncompressedBytes?: number;
  entries?: number;
  commit?: string;
  durationMs?: number;
  /** True when this call opened a seed gate and Pi is starting now. */
  piStarting?: boolean;
}

/**
 * The server's frozen record of a pod's workspace seed. `pending` is the seed gate: the launch
 * asked the server to hold Pi until the client fills the workdir. Safe metadata only.
 */
export interface WorkspaceSeedReport {
  status: "pending" | "seeding" | "seeded" | "failed" | "skipped";
  kind?: "clone" | "archive";
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  bytes?: number;
  entries?: number;
  host?: string;
  branch?: string;
  commit?: string;
  credentialed?: boolean;
  reason?: string;
}

/** The three secret scopes the server stores; `machine` and `project` are local files. */
export type ServerSecretScope = "org" | "user" | "template";

export interface ApiSecret {
  name: string;
  scopeType: ServerSecretScope;
  scopeId: string;
  updatedAt: string;
  createdBy?: string;
}

export interface ApiTemplate {
  id: string;
  name: string;
  description: string | null;
  status: "active";
  /** Older servers predate scoping and treat every template as org-wide. */
  scope?: "user" | "org";
  initScript: string | null;
  /** Older servers omit this; treat as unset rather than empty. */
  bakeScript?: string | null;
  config: Record<string, unknown>;
  /** Sanitized flat Pi files owned by this template. Legacy servers may return two scopes. */
  piSettings?: PiSettingsFilesBody | PiSettingsBundleBody;
  /** Optional on servers that expose a monotonic template revision. */
  version?: number;
  createdFromPod?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateBody {
  name: string;
  description?: string;
  initScript?: string;
  bakeScript?: string;
  scope?: "user" | "org";
  config: Record<string, unknown>;
  /** Explicit template custody. The CLI always writes the flat file map; the two-scope read shape stays accepted on responses only. */
  piSettings?: PiSettingsFilesBody;
}

export interface PiSettingsFilesBody {
  settings?: Record<string, unknown>;
  models?: Record<string, unknown>;
  mcporter?: Record<string, unknown>;
  subagents?: Record<string, unknown>;
  /** UTF-8 file contents keyed by path relative to this scope's `.pi/agents/`. */
  agents?: Record<string, string>;
}

/** The single sanitized two-scope Pi bundle used by project uploads and template custody. */
export interface PiSettingsBundleBody {
  user?: PiSettingsFilesBody;
  project?: Pick<PiSettingsFilesBody, "settings" | "mcporter" | "subagents" | "agents">;
}

/** Persistent user/org bundle returned by the settings API. */
export interface ApiSettingsBundle {
  config: Record<string, unknown>;
  version: number;
  initScript: string;
  bakeScript: string;
  piFiles: PiSettingsFilesBody;
}

/** CAS body: omitted scripts/files stay unchanged; empty values clear them. */
export interface PutSettingsBundleBody {
  config: Record<string, unknown>;
  version: number;
  initScript?: string;
  bakeScript?: string;
  piFiles?: PiSettingsFilesBody;
}

/**
 * Bounded capacity-wait view (capacity contract §1). Present only while a launch or wake
 * is queued for room; null when the pod never queued. Older servers omit the field —
 * treat a missing value exactly like null and run today's immediate-error flow.
 */
export interface CapacityWaitDetail {
  kind: "admission";
  reason: string;
  resource?: string;
  unit?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  required?: number;
  available?: number;
  budget?: number;
  committed?: number;
  requested?: { cpu?: number; memoryGB?: number; diskGB?: number };
  maximum?: { cpu: number; memoryGB: number; diskGB: number };
}

export type CapacityWaitStateName = "waiting" | "cancelled" | "expired" | "admitted";

export interface CapacityWaitState {
  state: CapacityWaitStateName;
  reason: string | null;
  detail: CapacityWaitDetail | null;
  attempts: number;
  /** Milliseconds until the final deadline; 0 once passed. */
  deadlineInMs: number;
  cancelRequested: boolean;
  /**
   * Future create/wake discriminator (capacity lead, in progress). Tolerated and
   * currently unused: cancel paths must NEVER delete or stop on a wake-kind wait —
   * only the cooperative cancel (DELETE capacity-wait) or pod deletion by explicit
   * user command ends it. Server owns the semantics.
   */
  kind?: string | null;
  /** Validated numeric display fields (additive). */
  required?: number;
  available?: number;
  unit?: string;
  /** ISO timestamp of the final deadline (additive: countdowns render off it). */
  deadlineAt?: string;
  /** Seconds waited once terminal (expired/cancelled/admitted); null while waiting. */
  waitedSeconds?: number | null;
}

export interface ApiPod {
  id: string;
  templateId: string | null;
  userId: string;
  /** The pod that launched this one; null for pods a person launched. Absent on old servers. */
  parentPodId?: string | null;
  /** Machine owner for co-located pods; null for machine-backed pods. Absent on old servers. */
  hostPodId?: string | null;
  hostPodName?: string | null;
  /** Display-oriented "where does this pod live": provider name, or `on <host>`. */
  location?: string;
  /** 0 for a pod a person launched, parent depth + 1 for a child. */
  lineageDepth?: number;
  /** The pod whose session this one was forked from. Absent on old servers. */
  forkedFromPodId?: string | null;
  name: string;
  /** Legacy project identity on pods created by older clients. */
  project: string | null;
  provider: string;
  state: string;
  /**
   * Raw provider layer (`started`|`stopped`|`archived`|…), so clients can tell a stopped
   * sandbox (local disk retained, restarts in seconds) from a provider-archived one
   * (restores on next use, minutes, size-dependent). Optional: older servers omit it.
   */
  sandboxState?: string | null;
  /**
   * Bounded capacity wait for this launch/wake, or null when it never queued.
   * Optional: servers predating the capacity contract omit it.
   */
  capacityWait?: CapacityWaitState | null;
  /** True when the sandbox can accept a session immediately; false stays provider-agnostic. */
  ready: boolean;
  /** Live gateway channel: connected, reconnecting (lease stale), or detached. Absent on old servers. */
  /** Live gateway channel: connected, reconnecting (lease stale), detached, or asleep. Absent on old servers. */
  connection?: "connected" | "reconnecting" | "detached" | "asleep";
  initializing: boolean;
  preparationPhase?: "preparing-image" | "provisioning-sandbox" | "waiting-for-capacity" | "running-init" | "ready" | "failed" | null;
  stateReason: string | null;
  /** Typed launch-failure code (capacity_wait_expired / capacity_wait_orphaned); absent on older servers. */
  stateReasonCode?: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  resolvedConfig: {
    clamps: Array<{ path: string; from: unknown; to: unknown; reason: string }>;
    secretKeys: string[];
    secretScopes: Record<string, string> | null;
    /** Layers that set the same name and lost, lowest precedence first. */
    secretShadows?: Record<string, string[]> | null;
    /** Redacted config origins frozen with the pod; older servers omit this. */
    configProvenance?: ConfigProvenanceEntry[] | null;
    initSteps: Array<{ scope: string; status: string }> | null;
    piAuthProviders: string[] | null;
    piSettings?: {
      files: string[];
      bytes: number;
      packageCount: number;
      droppedKeys: string[];
      status: "pending" | "installing" | "ready" | "degraded";
      installedPackageCount?: number;
      failedPackageCount?: number;
      /** Launch-resolved npm identities — the code channel's attested set (newer servers). */
      resolvedPackages?: Array<{ name: string; version: string; source: string }>;
    } | null;
    egress: { description: string; mode: string };
    /** Server-side provisioning phase durations in ms; null on older servers. */
    timings?: Record<string, number> | null;
    /** This launch reused a stopped pod's warm disk (§6.5). */
    reused?: boolean;
    /** Set when a reuse attempt refused the pod and returned it to stopped. */
    reuseRefused?: string | null;
    warnings: string[];
    /** Frozen sandbox workdir; absent on older servers. */
    workdir?: string;
    /** Client-driven workspace seed status; absent on servers without the seed routes. */
    workspaceSeed?: WorkspaceSeedReport | null;
    idleTimeoutMinutes?: number;
    archiveAfterMinutes?: number;
    archiveAfterDays?: number;
    archiveTransition?:
      | { kind: "same-as-stop"; expiryDays: null }
      | { kind: "after-stop"; maxDelayDays: number };
    providerExpiryDocumented?: boolean;
    image?: string;
    imagePreparation?: {
      ref: string;
      managed: boolean;
      provenance: string;
      assetDigest: string;
      status: "unknown" | "ready" | "preparing";
    } | null;
  };
}

export interface LaunchReport {
  clamps: Array<{ path: string; from: unknown; to: unknown; reason: string }>;
  /** Redacted config origins; values never travel in provenance rows. */
  configProvenance?: ConfigProvenanceEntry[] | null;
  secretKeys: string[];
  secretScopes?: Record<string, string> | null;
  /** Layers that set the same name and lost, lowest precedence first. */
  secretShadows?: Record<string, string[]> | null;
  warnings: string[];
}

/** Answer of POST /pods/resolve: the same merge launch uses, without a pod row. */
export interface ResolveReport {
  provider: string;
  /** The org template this launch would start from, if any. */
  template?: { id: string; name: string } | null;
  config: Record<string, unknown>;
  clamps: Array<{ path: string; from: unknown; to: unknown; reason: string }>;
  warnings: string[];
  credential: {
    envVar: string;
    available: boolean;
    source: "org-secret" | "platform" | null;
  };
  secretKeys: string[];
  secretScopes: Record<string, string> | null;
  /** Layers that set the same name and lost, lowest precedence first. */
  secretShadows?: Record<string, string[]> | null;
  initSteps: Array<{ scope: string }>;
  /** Present when the composed bake script would travel; older servers omit it. */
  bake?: { digest: string } | null;
  piAuthProviders: string[];
  piSettings?: ApiPod["resolvedConfig"]["piSettings"];
  workdir: string;
  image: string;
  imageStatus?: "ready" | "missing-buildable" | "missing-custom" | "unavailable";
  imageManaged?: boolean;
  imageProvenance?: string;
  imageResources?: { cpu?: number; memoryGB?: number; diskGB?: number } | null;
  egress: { mode: string };
  /** Canonical redacted config origins; older servers may expose only `provenance`. */
  configProvenance?: ConfigProvenanceEntry[] | null;
  /** Compatibility alias for servers predating `configProvenance`. */
  provenance?: ConfigProvenanceEntry[] | null;
  /** Persistent layers (plus a bootstrap-only project preview) in precedence order. */
  layerOrder?: Array<"org" | "template" | "user" | "project">;
  /** Echo confirms the server applied this request-scoped selection. */
  piOverrides?: PiLaunchOverrides | null;
  /** Dry-run provenance for a fork; older servers omit it. */
  forkFrom?: { podId: string; sessionPath?: string | null } | null;
}

export type AccountThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Structured Pi startup choices accepted per account-mode pod launch.
 *
 * Beyond the model selection, a launch may add Pi resources — extensions, skills, prompt
 * templates — to the pod's configured set for that launch only. Each array holds pod-local
 * absolute paths (files or directories) naming resources on the pod, not this machine;
 * the server appends the corresponding `--extension`/`--skill`/`--prompt-template` pairs
 * to the pod's configured `pi.args` without replacing them. An empty array appends nothing.
 */
export interface PiLaunchOverrides {
  model?: string;
  thinking?: AccountThinkingLevel;
  extensions?: string[];
  skills?: string[];
  promptTemplates?: string[];
}

export type ApiJobTrigger =
  | { type: "cron"; cron: string }
  | { type: "at"; times: string[] };

export interface ApiJob {
  id: string;
  name: string;
  /** Older servers omit scope and behave as user-scoped for the caller. */
  scope?: "user" | "org";
  description: string | null;
  status: "draft" | "active" | "paused" | "completed";
  trigger: ApiJobTrigger;
  templateId: string | null;
  model: string;
  prompt: string;
  createdFromPod: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiJobRun {
  id: string;
  podId: string | null;
  scheduledAt: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type CredentialStatus =
  | {
      providerId: string;
      type: "oauth" | "api_key";
      state: "ready";
      expiresAt?: string;
      lastRefreshAt?: string;
      revision: number;
    }
  | {
      providerId: string;
      type: "oauth" | "api_key";
      state: "reconnect_required";
      reason: "revoked" | "invalid_grant" | "missing_refresh_token" | "migration_required";
      revision: number;
    }
  | {
      providerId: string;
      type: "oauth" | "api_key";
      state: "temporarily_unavailable";
      retryAfter?: string;
      revision: number;
    };

export interface ConnectableProvider {
  id: string;
  name: string;
  oauth: { loginLabel: string } | null;
  apiKey: boolean;
  brokerSupported: boolean;
}

export interface CredentialErrorDetail {
  code: string;
  message?: string;
  provider?: string;
  requiredBy?: string;
  retryable?: boolean;
  minimumVersion?: string;
}

function sessionTokensChanged(left: AccountAuth, right: AccountAuth): boolean {
  return (
    left.accessToken !== right.accessToken ||
    left.refreshToken !== right.refreshToken ||
    left.idToken !== right.idToken ||
    left.issuer !== right.issuer ||
    left.clientId !== right.clientId
  );
}

/** Same server, identity provider, organization and user: a token rotation, not another sign-in. */
function sameAccount(left: AccountAuth, right: AccountAuth): boolean {
  return (
    left.serverUrl === right.serverUrl &&
    left.issuer === right.issuer &&
    left.clientId === right.clientId &&
    left.orgId === right.orgId &&
    left.user.id === right.user.id
  );
}

/**
 * GET /v1/version. Every field after `version` is absent on older servers, and `schema` /
 * `launchAdmission` are null when the server cannot read them.
 */
export interface ApiServerVersion {
  version: string;
  /** Source commit the server image was built from. */
  revision?: string | null;
  /** How the server's database compares with the migrations its release ships. */
  schema?: { state: "current" | "behind" | "ahead"; pending: number; unknown: number } | null;
  /** Whether the server admits new launches. */
  launchAdmission?: "open" | "held" | null;
}

export class AccountClient {
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private auth: AccountAuth,
    private readonly opts: { home?: string | undefined } = {},
  ) {}

  get serverUrl(): string {
    return this.auth.serverUrl;
  }

  get orgId(): string {
    return this.auth.orgId;
  }

  get user(): AccountAuth["user"] {
    return this.auth.user;
  }

  get userId(): string {
    return this.auth.user.id;
  }

  /** True when this client speaks as a pod (nested pods), not as a signed-in person. */
  get isPodToken(): boolean {
    return this.auth.podToken === true;
  }

  async request<T = unknown>(apiPath: string, opts: ApiRequestOptions = {}): Promise<T> {
    const attempt = () => this.rawRequest(apiPath, opts, this.auth.accessToken);
    let res: Response;
    try {
      res = await attempt();
    } catch (e) {
      throw new PiPodError(`cannot reach the pi pod server at ${this.auth.serverUrl}`, {
        hint: `check that the server is running and reachable\n(${e instanceof Error ? e.message : String(e)})`,
        transient: true,
      });
    }
    if (res.status === 401 && this.auth.refreshToken) {
      await this.refresh();
      res = await attempt();
    }
    if (res.status === 401) {
      if (this.auth.podToken) {
        throw new PiPodError("this pod's server token was revoked", {
          hint: "the pod was deleted, or its token rotated — the session it belongs to is over",
        });
      }
      throw new PiPodError("your pi pod server session has expired", {
        hint: "run `pipod login`",
        status: 401,
      });
    }
    if (opts.allow404 && res.status === 404) return null as T;
    if (!res.ok) {
      throw await responseError(res, opts.method ?? "GET", apiPath);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async rawRequest(apiPath: string, opts: ApiRequestOptions, token: string): Promise<Response> {
    const url = new URL(`/v1${apiPath}`, this.auth.serverUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    debug(`account api: ${opts.method ?? "GET"} ${url.pathname}`);
    const waitMs = typeof opts.query?.["wait"] === "number" ? Number(opts.query["wait"]) : undefined;
    const timeoutMs =
      opts.timeoutMs ??
      (waitMs !== undefined && waitMs > 0 ? waitMs + LONG_POLL_SLACK_MS : REST_TIMEOUT_MS);
    return fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: combineSignals(AbortSignal.timeout(timeoutMs), opts.signal),
    });
  }

  /**
   * Stream a file as the request body. Mirrors `request()` — same 401-refresh-once contract,
   * same error mapping — but the body is re-opened from disk for the retry, since a consumed
   * stream cannot be replayed. The caller keeps the file until this resolves.
   */
  async upload<T = unknown>(apiPath: string, opts: ApiUploadOptions): Promise<T> {
    const attempt = () => this.rawUpload(apiPath, opts, this.auth.accessToken);
    let res: Response;
    try {
      res = await attempt();
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new PiPodError(`cannot reach the pi pod server at ${this.auth.serverUrl}`, {
        hint: `check that the server is running and reachable\n(${e instanceof Error ? e.message : String(e)})`,
        transient: true,
      });
    }
    if (res.status === 401 && this.auth.refreshToken) {
      await this.refresh();
      res = await attempt();
    }
    if (res.status === 401) {
      if (this.auth.podToken) {
        throw new PiPodError("this pod's server token was revoked", {
          hint: "the pod was deleted, or its token rotated — the session it belongs to is over",
        });
      }
      throw new PiPodError("your pi pod server session has expired", {
        hint: "run `pipod login`",
        status: 401,
      });
    }
    if (!res.ok) throw await responseError(res, opts.method, apiPath);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private rawUpload(apiPath: string, opts: ApiUploadOptions, token: string): Promise<Response> {
    const url = new URL(`/v1${apiPath}`, this.auth.serverUrl);
    debug(`account api: ${opts.method} ${url.pathname} (${opts.contentLength} bytes streamed)`);
    let sent = 0;
    const file = fs.createReadStream(opts.filePath);
    if (opts.onProgress) {
      const report = opts.onProgress;
      file.on("data", (chunk: string | Buffer) => {
        sent += chunk.length;
        report(sent);
      });
    }
    return fetch(url, {
      method: opts.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": opts.contentType,
        "content-length": String(opts.contentLength),
      },
      body: Readable.toWeb(file) as ReadableStream,
      // Node's fetch refuses a streaming body without an explicit duplex mode.
      duplex: "half",
      signal: combineSignals(AbortSignal.timeout(opts.timeoutMs ?? REST_TIMEOUT_MS), opts.signal),
    } as RequestInit);
  }


  private refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  /**
   * Adopts a rotation another process wrote, but never a different account: a request
   * retried after `pipod login` elsewhere would carry its body to that account's server.
   * A session signed out elsewhere is refreshed for this request only, never written back.
   */
  private async performRefresh(): Promise<void> {
    await withAccountAuthLock(this.opts.home, async () => {
      const diskAuth = readAccountAuth(this.opts.home);
      if (diskAuth && !sameAccount(this.auth, diskAuth)) {
        throw new PiPodError("the pi pod session changed while this command was running", {
          hint: "another `pipod login` switched account or server; run the command again",
        });
      }
      if (diskAuth && sessionTokensChanged(this.auth, diskAuth)) {
        this.auth = diskAuth;
        return;
      }

      const refreshAuth = diskAuth ?? this.auth;
      if (!refreshAuth.issuer || !refreshAuth.clientId || !refreshAuth.refreshToken) {
        throw new PiPodError("your pi pod server session has expired", { hint: "run `pipod login`" });
      }
      this.auth = refreshAuth;
      try {
        const meta = await discover(refreshAuth.issuer);
        const pair = await refreshTokens(meta, {
          clientId: refreshAuth.clientId ?? DEFAULT_CLIENT_ID,
          refreshToken: refreshAuth.refreshToken,
        });
        this.auth = {
          ...refreshAuth,
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken ?? refreshAuth.refreshToken,
          ...(pair.idToken ? { idToken: pair.idToken } : {}),
        };
        if (diskAuth) writeAccountAuth(this.auth, this.opts.home);
      } catch (error) {
        // A process not using this lock (or a stale owner finishing) may still have won rotation.
        const changedAuth = readAccountAuth(this.opts.home);
        if (changedAuth && sameAccount(refreshAuth, changedAuth) && sessionTokensChanged(refreshAuth, changedAuth)) {
          this.auth = changedAuth;
          return;
        }
        throw error;
      }
    });
  }

  // --- typed surface --------------------------------------------------------

  me(): Promise<{
    user: { id: string; email?: string; displayName?: string };
    currentOrgId: string | null;
    /** Absent when the token carries no roles — callers must tolerate undefined. */
    permissions?: string[];
    organization?: { id: string; alias: string | null; name: string | null } | null;
    accountConsoleUrl?: string;
    adminConsoleUrl?: string;
    /**
     * SaaS-only workstation plan/usage block. Absent under the self-hosted static backend,
     * which has no plans, no metered hours and no spend caps — so it is deliberately untyped
     * here and validated field by field by `parseAccountBilling`.
     */
    workstation?: unknown;
  }> {
    return this.request("/me");
  }

  /** Null from a server that predates the route. */
  serverVersion(): Promise<ApiServerVersion | null> {
    return this.request("/version", { allow404: true });
  }


  /** Store an org-scoped secret (BYO provider keys live here). Needs secrets:org:write. */
  putOrgSecret(name: string, value: string): Promise<void> {
    return this.putSecret("org", this.auth.orgId, name, value);
  }

  /** Names and metadata only — the secret API never reads values back. */
  listSecrets(scope: ServerSecretScope, scopeId: string): Promise<{ secrets: ApiSecret[] }> {
    return this.request(`/secrets/${scope}/${encodeURIComponent(scopeId)}`);
  }

  putSecret(scope: ServerSecretScope, scopeId: string, name: string, value: string): Promise<void> {
    return this.request(`/secrets/${scope}/${encodeURIComponent(scopeId)}/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: { value },
    });
  }

  deleteSecret(scope: ServerSecretScope, scopeId: string, name: string): Promise<void> {
    return this.request(`/secrets/${scope}/${encodeURIComponent(scopeId)}/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  listTemplates(): Promise<{ templates: ApiTemplate[] }> {
    return this.request("/templates");
  }

  getTemplate(id: string): Promise<ApiTemplate> {
    return this.request(`/templates/${id}`);
  }

  createTemplate(body: TemplateBody): Promise<ApiTemplate> {
    return this.request("/templates", { method: "POST", body });
  }

  /** `expectedVersion` makes the write compare-and-swap on servers that expose template versions. */
  updateTemplate(id: string, body: Partial<TemplateBody> & { expectedVersion?: number }): Promise<ApiTemplate> {
    return this.request(`/templates/${id}`, { method: "PATCH", body });
  }

  activateTemplate(id: string): Promise<{ id: string; status: string }> {
    return this.request(`/templates/${id}/activate`, { method: "POST" });
  }

  deleteTemplate(id: string): Promise<void> {
    return this.request(`/templates/${id}`, { method: "DELETE" });
  }

  getUserSettings(): Promise<ApiSettingsBundle> {
    return this.request(`/users/${encodeURIComponent(this.userId)}/settings`);
  }

  putUserSettings(body: PutSettingsBundleBody): Promise<{ version: number }> {
    return this.request(`/users/${encodeURIComponent(this.userId)}/settings`, { method: "PUT", body });
  }

  getOrgSettings(): Promise<ApiSettingsBundle> {
    return this.request(`/orgs/${encodeURIComponent(this.orgId)}/settings`);
  }

  putOrgSettings(body: PutSettingsBundleBody): Promise<{ version: number }> {
    return this.request(`/orgs/${encodeURIComponent(this.orgId)}/settings`, { method: "PUT", body });
  }


  launch(body: {
    templateId?: string;
    /** The project launching it ({@link currentProjectName}); names the pod and scopes lists. */
    project?: { name: string };
    piOverrides?: PiLaunchOverrides;
    forkFrom?: { podId: string; sessionPath?: string };
    /** Co-located placement: run the new pod on an existing pod's machine. */
    placement?: { host: string };
    /**
     * Seed gate: this launch will clone or archive into the workdir right after provisioning,
     * so the server holds Pi until the seed completes, is skipped, or times out.
     */
    workspaceSeed?: boolean;
  }): Promise<{ pod: ApiPod; report: LaunchReport }> {
    return this.request("/pods", { method: "POST", body });
  }

  /** §6.5: relaunch onto a stopped pod's warm disk. 4xx means "not eligible — launch fresh". */
  reusePod(
    podId: string,
    body: {
      templateId?: string;
      project?: { name: string };
      piOverrides?: PiLaunchOverrides;
    },
  ): Promise<{ pod: ApiPod; report: LaunchReport }> {
    return this.request(`/pods/${podId}/reuse`, { method: "POST", body });
  }

  /**
   * Same merge/clamps/credential check as launch, no pod row. Returns null on older
   * servers that lack the endpoint so callers can fall back to a local approximation.
   */
  resolve(body: {
    /** Bootstrap preview only; never accompanies templateId or a launch request. */
    projectConfig?: Record<string, unknown>;
    templateId?: string;
    piOverrides?: PiLaunchOverrides;
    forkFrom?: { podId: string; sessionPath?: string };
    /** False skips the sandbox image lookup when only merged config is needed. */
    checkImage?: boolean;
  }): Promise<ResolveReport | null> {
    const { checkImage, ...payload } = body;
    const query = {
      ...(checkImage !== undefined ? { check_image: checkImage } : {}),
    };
    return this.request("/pods/resolve", {
      method: "POST",
      body: payload,
      ...(Object.keys(query).length > 0 ? { query } : {}),
      allow404: true,
    });
  }

  listPods(
    query: {
      project?: string;
      state?: string;
      mine?: boolean;
      limit?: number;
      templateId?: string;
      /** Pods less recently active than this timestamp: the cursor for the next page. */
      before?: string;
      /** Include provider_state 'gone' rows (failed launches that never acquired compute). */
      includeGone?: boolean;
    } = {},
  ): Promise<{ pods: ApiPod[] }> {
    return this.request("/pods", { query });
  }

  /** `waitMs` long-polls: a supporting server answers on the next pod change; older servers ignore it. */
  getPod(id: string, opts: { waitMs?: number; timeoutMs?: number } = {}): Promise<ApiPod> {
    const waitMs = opts.waitMs != null && opts.waitMs > 0 ? Math.floor(opts.waitMs) : undefined;
    return this.request(`/pods/${id}`, {
      ...(waitMs !== undefined ? { query: { wait: waitMs } } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  podCommand(
    id: string,
    command: "stop" | "archive" | "restore",
  ): Promise<{ id: string; state: string; message?: string; cascaded?: string[] }> {
    return this.request(`/pods/${id}/${command}`, { method: "POST" });
  }

  /**
   * Cooperatively cancel a bounded capacity wait (capacity contract §1). The waiter
   * observes it on its next heartbeat and fails the pod as cancelled; the pod row
   * itself survives. Returns null (404) when the pod never queued. Older servers
   * answer 404 for the unknown route, which reads the same way: nothing to cancel.
   */
  cancelCapacityWait(
    id: string,
  ): Promise<{ cancelled: boolean; capacityWait: CapacityWaitState | null } | null> {
    return this.request(`/pods/${id}/capacity-wait`, { method: "DELETE", allow404: true });
  }

  /** `cascade` takes the pod's whole subtree down; without it, live children answer 409. */
  deletePod(id: string, opts: { cascade?: boolean } = {}): Promise<{ id: string; state: "gone"; deleted: boolean; cascaded?: string[] }> {
    return this.request(`/pods/${id}`, {
      method: "DELETE",
      ...(opts.cascade ? { query: { cascade: true } } : {}),
    });
  }

  renamePod(id: string, name: string): Promise<{ id: string; name: string }> {
    return this.request(`/pods/${id}`, { method: "PATCH", body: { name } });
  }

  /**
   * Seed an empty pod workdir by cloning an exact commit on the server side. The optional
   * credential is used for that one clone and discarded; it never appears in pod metadata.
   */
  seedWorkspaceClone(
    podId: string,
    body: WorkspaceCloneBody,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<WorkspaceSeedResult> {
    return this.request(`/pods/${podId}/workspace/clone`, {
      method: "POST",
      body,
      timeoutMs: opts.timeoutMs ?? WORKSPACE_CLONE_TIMEOUT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /** Release a seed gate the launch armed: the client will not seed after all, so Pi may start. */
  seedWorkspaceSkip(podId: string, reason: string): Promise<WorkspaceSeedResult> {
    return this.request(`/pods/${podId}/workspace/skip`, { method: "POST", body: { reason: reason.slice(0, 512) } });
  }

  /** Seed an empty pod workdir from a gzip tar archive streamed straight from disk. */
  seedWorkspaceArchive(
    podId: string,
    archive: { filePath: string; bytes: number },
    opts: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (sentBytes: number) => void } = {},
  ): Promise<WorkspaceSeedResult> {
    return this.upload(`/pods/${podId}/workspace/archive`, {
      method: "PUT",
      filePath: archive.filePath,
      contentType: WORKSPACE_ARCHIVE_CONTENT_TYPE,
      contentLength: archive.bytes,
      timeoutMs: opts.timeoutMs ?? WORKSPACE_ARCHIVE_TIMEOUT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
  }


  wsTicket(id: string): Promise<{ ticket: string; expiresAt: string }> {
    return this.request(`/pods/${id}/ws-ticket`, { method: "POST" });
  }

  /**
   * Durable status of the caller's own workstation (SaaS edition). The path is built from a
   * validated host id, never from a `statusHref` a response chose. Null covers everything that
   * means "no status to show": an unknown id, a server without the route (the self-hosted
   * static backend has no workstations at all), or a refusal.
   */
  async getWorkstation(hostId: string): Promise<WorkstationStatus | null> {
    if (!isWorkstationHostId(hostId)) return null;
    const raw = await this.request(`/workstations/${encodeURIComponent(hostId)}`, { allow404: true });
    return parseWorkstationStatus(raw);
  }

  /**
   * Plan, active hours and spend cap for the signed-in account, or null when the server does
   * not report them. Absence is the self-hosted edition: it has no plans, no metered hours and
   * no caps, so the whole surface stays hidden rather than rendering zeroes.
   */
  async accountBilling(): Promise<AccountBilling | null> {
    try {
      const me = await this.me();
      return parseAccountBilling((me as { workstation?: unknown }).workstation);
    } catch (error) {
      debug(`account billing unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** `POST /v1/billing/checkout-session`. `trial:false` is paid subscribe. */
  createCheckoutSession(body: { plan: "standard" | "pro"; trial: boolean }): Promise<{ url: string; trial: boolean }> {
    return this.request("/billing/checkout-session", { method: "POST", body });
  }

  /** `POST /v1/billing/portal-session`. */
  createPortalSession(): Promise<{ url: string }> {
    return this.request("/billing/portal-session", { method: "POST", body: {} });
  }

  /**
   * `GET /v1/billing/account` narrowed to the plan-change surface. Null when the
   * server has no `/v1/billing` at all (the self-hosted static backend) — the
   * caller omits the change command rather than rendering a guess.
   */
  async billingAccountPlan(): Promise<BillingAccountPlan | null> {
    const raw = await this.request<unknown>("/billing/account", { allow404: true });
    if (raw === null) return null;
    const parsed = parseBillingAccountPlan(raw);
    if (!parsed) {
      throw new PiPodError("the server returned an unusable billing account", {
        hint: "run `pipod update`, then try again",
      });
    }
    return parsed;
  }

  /**
   * `POST /v1/billing/plan-change/preview`. The body carries the target plan
   * only; every amount comes back from Stripe via the server.
   */
  async previewPlanChange(plan: BillingPlanKey): Promise<PlanChangeQuoteView> {
    const raw = await this.request<unknown>("/billing/plan-change/preview", {
      method: "POST",
      body: { plan },
    });
    const quote = parsePlanChangeQuote(raw);
    if (!quote) {
      throw new PiPodError("the server returned an unusable plan-change quote", {
        hint: "run `pipod update`, then try again",
      });
    }
    return quote;
  }

  /**
   * `POST /v1/billing/plan-change/confirm`. The body carries the quote id only —
   * never a caller-selected plan. The response is `{ applied, ...quote, account }`:
   * success is `applied === true` AND the returned `account.planKey`
   * (or `pendingPlanKey` for a period-end downgrade) matching `quote.targetPlan`.
   * A missing `applied` never grants: it is `plan_change_not_applied`.
   * No hosted payment URL field (`hostedPaymentUrl|paymentUrl|checkoutUrl|url`)
   * exists on this view and none is read here.
   */
  async confirmPlanChange(quoteId: string): Promise<{ quote: PlanChangeQuoteView; account: BillingAccountPlan | null; applied: boolean }> {
    const raw = await this.request<unknown>("/billing/plan-change/confirm", {
      method: "POST",
      body: { quoteId },
    });
    const root =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const quote = root ? parsePlanChangeQuote(root) : null;
    if (!root || !quote) {
      throw new PiPodError("the server returned an unusable plan-change confirmation", {
        hint: "refresh with `pipod billing change preview` and compare before retrying",
      });
    }
    return { quote, account: parseBillingAccountPlan(root["account"]), applied: root["applied"] === true };
  }

  sessionEvents(
    sessionId: string,
    query: { afterSeq?: number; limit?: number } = {},
  ): Promise<{
    truncatedBelowSeq: number | null;
    events: Array<{ seq: number; kind: string; payload: unknown; createdAt: string }>;
  }> {
    return this.request(`/sessions/${sessionId}/events`, {
      query: { after_seq: query.afterSeq ?? 0, limit: query.limit ?? 500 },
    });
  }

  listJobs(query: { before?: string; beforeId?: string; limit?: number } = {}): Promise<{ jobs: ApiJob[] }> {
    return this.request("/jobs", {
      query: { limit: query.limit ?? 200, before: query.before, beforeId: query.beforeId },
    });
  }

  getJob(id: string): Promise<ApiJob> {
    return this.request(`/jobs/${id}`);
  }

  createJob(body: {
    name: string;
    description?: string;
    trigger: ApiJobTrigger;
    templateId?: string | null;
    model: string;
    prompt: string;
    scope?: "user" | "org";
  }): Promise<ApiJob> {
    return this.request("/jobs", { method: "POST", body });
  }

  patchJob(
    id: string,
    body: Partial<{
      name: string;
      description: string;
      trigger: ApiJobTrigger;
      templateId: string | null;
      model: string;
      prompt: string;
      scope: "org";
    }>,
  ): Promise<ApiJob> {
    return this.request(`/jobs/${id}`, { method: "PATCH", body });
  }

  jobCommand(id: string, command: "activate" | "pause" | "resume"): Promise<{ id: string; status: string }> {
    return this.request(`/jobs/${id}/${command}`, { method: "POST" });
  }

  deleteJob(id: string): Promise<void> {
    return this.request(`/jobs/${id}`, { method: "DELETE" });
  }

  jobRuns(id: string): Promise<{ runs: ApiJobRun[] }> {
    return this.request(`/jobs/${id}/runs`);
  }

  modelCredentials(): Promise<{ credentials: CredentialStatus[]; providers: ConnectableProvider[] }> {
    return this.request("/model-credentials");
  }

  createCredentialLoginTicket(
    providerId: string,
    body: { authType: "oauth" | "api_key"; podId?: string },
  ): Promise<{ ticket: string; expiresAt: string }> {
    return this.request(`/model-credentials/${encodeURIComponent(providerId)}/login-ticket`, {
      method: "POST",
      body,
    });
  }

  credentialLoginWsUrl(providerId: string, ticket: string): string {
    const url = new URL(`/v1/model-credentials/${encodeURIComponent(providerId)}/login`, this.auth.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    return url.toString();
  }

  testModelCredential(providerId: string): Promise<{ status: CredentialStatus }> {
    return this.request(`/model-credentials/${encodeURIComponent(providerId)}/test`, { method: "POST" });
  }

  deleteModelCredential(providerId: string): Promise<void> {
    return this.request(`/model-credentials/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  }


  /** The session WebSocket endpoint for a pod, ready for a ticket query (§6). */
  sessionWsUrl(podId: string, params: { ticket: string; fromSeq?: number; fromSession?: string }): string {
    const url = new URL(`/v1/pods/${podId}/session`, this.auth.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", params.ticket);
    if (params.fromSeq !== undefined) url.searchParams.set("from_seq", String(params.fromSeq));
    if (params.fromSession) url.searchParams.set("from_session", params.fromSession);
    return url.toString();
  }
}

export function credentialProtocolError(
  code: string,
  message: string | undefined,
  provider: string | undefined,
  opts: { status?: number } = {},
): PiPodError {
  const namedProvider = provider ?? "provider";
  switch (code) {
    case "credential_reconnect_required":
      return new PiPodError(message ?? `The saved ${namedProvider} credential must be reconnected.`, {
        status: opts.status,
        code,
        hint: `run \`pipod credentials connect ${namedProvider}\``,
      });
    case "credential_temporarily_unavailable":
      return new PiPodError(message ?? `The ${namedProvider} credential is temporarily unavailable.`, {
        status: opts.status,
        code,
        transient: true,
      });
    case "credential_provider_unsupported":
      return new PiPodError(message ?? `${namedProvider} cannot be connected through the account credential broker.`, {
        status: opts.status,
        code,
        hint: "if this provider accepts an API key, store it as a scoped secret with `pipod secrets set user <NAME>`",
      });
    case "client_upgrade_required":
      return new PiPodError(message ?? "this operation requires a newer pi pod client; upgrade pi pod before continuing", {
        status: opts.status,
        code,
        hint: "run `pipod update`",
      });
    default:
      return new PiPodError(message ?? `credential operation failed (${code})`, {
        status: opts.status,
        code,
      });
  }
}

async function responseError(res: Response, method: string, apiPath: string): Promise<PiPodError> {
  let body: { message?: unknown; error?: unknown; detail?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Error bodies are deliberately not copied into diagnostics: credential endpoints may
    // grow token-bearing fields, while status and the bounded message are sufficient here.
  }
  const detail = isCredentialErrorDetail(body.detail) ? body.detail : undefined;
  if (detail && [
    "credential_reconnect_required",
    "credential_temporarily_unavailable",
    "credential_provider_unsupported",
    "client_upgrade_required",
  ].includes(detail.code)) {
    const typedMessage = detail.message ?? (
      detail.code === "client_upgrade_required" && detail.minimumVersion
        ? `pi pod ${detail.minimumVersion} or newer is required; upgrade pi pod before continuing`
        : undefined
    );
    return credentialProtocolError(detail.code, typedMessage, detail.provider, { status: res.status });
  }
  const message =
    detail?.message ??
    (typeof body.message === "string" ? body.message : undefined) ??
    (typeof body.error === "string" ? body.error : undefined) ??
    `HTTP ${res.status}`;
  // Routes without a structured `detail` still name their refusal with a stable snake_case
  // `error` code (`workspace_not_empty`); surface it so callers can branch without regexes.
  const code = detail?.code ?? (typeof body.error === "string" && /^[a-z][a-z0-9_]*$/.test(body.error) ? body.error : undefined);
  // A personal-workstation refusal is its own shape (`kind: admission` + `transitions` +
  // `count`), and it carries a host id, a status link and a durable operation that the
  // capacity allowlist below would reject wholesale — dropping exactly the fields the client
  // needs to wait for the machine. Recognize it first, rebuilt from validated parts.
  const demand = parseWorkstationDemand(body.detail);
  if (demand !== null && res.status === 503) {
    // Carry the workstation's own copy rather than "the server refused POST /v1/pods": on the
    // paths that wait, the sentence is replaced by progress anyway, and on the paths that do
    // not, this is the only thing the user will see.
    debug(`account api: ${method} ${apiPath} refused — workstation ${demand.reason}`);
    return new WorkstationNotReadyError({ ...demand, ...(message ? { message: message.slice(0, 240) } : {}) });
  }
  // Preserve a safe server `detail` for capacity classification (reason/retryable hints).
  // Presenters render only validated codes/numbers from it — never raw provider text.
  const safeDetail = isSafeCapacityDetail(body.detail) ? body.detail : undefined;
  // A missing permission is the user's to resolve, not the request's: say which, and who.
  const permission = res.status === 403 ? /^requires ([a-z:_]+)$/.exec(message)?.[1] : undefined;
  if (permission) {
    debug(`account api: ${method} ${apiPath} refused — ${message}`);
    return new PiPodError(`you do not have the ${permission} permission this needs`, {
      status: res.status,
      hint: "an owner of your organization can grant it (`pipod org-admin` opens the console)",
    });
  }
  return new PiPodError(`the pi pod server refused ${method} ${apiPath}: ${message}`, {
    status: res.status,
    ...(code ? { code } : {}),
    ...(safeDetail !== undefined ? { detail: safeDetail } : {}),
  });
}

/**
 * Future typed capacity detail the cost-control workstreams may add
 * (`reason`, `retryable`, bounded numeric hints). Allowlisted keys with primitive values
 * only, so arbitrary provider text, URLs, and secrets never ride into error presentation.
 */
function isSafeCapacityDetail(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "reason", "code", "retryable", "retryAfterMs", "retryAfter", "required", "available",
    "requiredMemoryGB", "availableMemoryGB", "requiredDiskGB", "availableDiskGB", "message",
    // Billing refusal `detail` (HTTP 402, `kind: "billing"`): the reason plus the numbers and
    // dates the copy is allowed to quote back, so it never has to invent one. Every key here
    // is one the server's `workstationStartRefusal()` actually sends.
    "kind", "planKey", "activeHoursUsed", "includedActiveHours", "spendCapUsdCents",
    "projectedSpendUsdCents", "currentPeriodEnd",
    // Plan-change `plan_change_in_flight` resume pointer (409 while applying):
    // `{ quoteId, state }` — the id the client must resume, never a new preview.
    // No payment URL keys are allowlisted here by design (the API defines none).
    "quoteId", "state", "targetPlan",
  ]);
  for (const [key, entry] of Object.entries(record)) {
    if (!allowed.has(key)) return false;
    const type = typeof entry;
    if (entry !== null && type !== "string" && type !== "number" && type !== "boolean") return false;
    if (type === "string" && (entry as string).length > 240) return false;
  }
  return Object.keys(record).length > 0;
}

/** One signal that fires when either does; a missing caller signal leaves the timeout alone. */
function combineSignals(timeout: AbortSignal, caller?: AbortSignal): AbortSignal {
  if (!caller) return timeout;
  return AbortSignal.any([timeout, caller]);
}

function isCredentialErrorDetail(value: unknown): value is CredentialErrorDetail {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  return (
    typeof detail["code"] === "string" &&
    (detail["message"] === undefined || typeof detail["message"] === "string") &&
    (detail["provider"] === undefined || typeof detail["provider"] === "string") &&
    (detail["requiredBy"] === undefined || typeof detail["requiredBy"] === "string") &&
    (detail["retryable"] === undefined || typeof detail["retryable"] === "boolean") &&
    (detail["minimumVersion"] === undefined || typeof detail["minimumVersion"] === "string")
  );
}
