/**
 * test/support/fake-account-server.ts — a minimal pi pod server for account-mode tests
 * (account-mode-spec §10): the REST slices the CLI touches plus a gateway WebSocket that
 * speaks the §6.1 protocol, backed by a scriptable in-memory pi.
 *
 * Mirrors the FakeProvider pattern: real `main()` in, recorded calls out.
 */
import * as http from "node:http";
import { createHash } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { bundledPiVersion } from "../../src/client/piversion.js";
import { FRAME_PROTO_VERSION } from "../../src/client/protocol.js";
import { SHIM_VERSION } from "../../src/shim/agentd.js";
import { POD_EXTENSION_VERSION } from "../../src/shim/pi-pod-ext.js";
import type {
  ApiSettingsBundle,
  ConnectableProvider,
  CredentialStatus,
  PiLaunchOverrides,
} from "../../src/account/api.js";
import { resourceArgsFor } from "../../src/account/launch-resources.js";

export interface FakeAccountPod {
  id: string;
  templateId: string | null;
  userId: string;
  /** Nested pods: the pod that launched this one, and its depth in that tree. */
  parentPodId: string | null;
  lineageDepth: number;
  name: string;
  project: string | null;
  provider: string;
  state: string;
  ready: boolean;
  connection?: "connected" | "reconnecting" | "detached";
  initializing: boolean;
  stateReason: string | null;
  /** Server-reported provisioning stage; absent on servers predating preparationPhase. */
  preparationPhase?: "preparing-image" | "provisioning-sandbox" | "waiting-for-capacity" | "running-init" | "ready" | "failed" | null;
  lastActivityAt: string | null;
  createdAt: string;
  resolvedConfig: {
    clamps: unknown[];
    secretKeys: string[];
    secretScopes: Record<string, string> | null;
    secretShadows?: Record<string, string[]> | null;
    configProvenance?: Array<{ path: string; winner: string; over: string[] }> | null;
    initSteps: Array<{ scope: string; status: string }> | null;
    piAuthProviders: string[] | null;
    egress: { description: string; mode: string };
    warnings: string[];
    workdir?: string;
    /** Seed gate record, mirroring the server's frozen report. */
    workspaceSeed?: {
      status: "pending" | "seeding" | "seeded" | "failed" | "skipped";
      kind?: "clone" | "archive";
      requestedAt: string;
      reason?: string;
    } | null;
    image?: string;
    idleTimeoutMinutes?: number;
    archiveAfterMinutes?: number;
    archiveTransition?:
      | { kind: "same-as-stop"; expiryDays: null }
      | { kind: "after-stop"; maxDelayDays: number };
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  /** Raw query string, "" when there was none — what a filter flag actually asked the server. */
  search: string;
  body: unknown;
}

export function fakePod(overrides: Partial<FakeAccountPod> = {}): FakeAccountPod {
  return {
    id: "0198f5a0-0000-7000-8000-000000000001",
    templateId: null,
    userId: "user-1",
    parentPodId: null,
    lineageDepth: 0,
    name: "repo",
    project: "repo",
    provider: "sandbox",
    state: "active",
    ready: true,
    connection: "detached",
    initializing: false,
    stateReason: null,
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    resolvedConfig: {
      clamps: [],
      secretKeys: [],
      secretScopes: null,
      initSteps: null,
      piAuthProviders: null,
      egress: { description: "open", mode: "open" },
      warnings: [],
      workdir: "/workspace",
    },
    ...overrides,
  };
}

/** Collapse repeats within the request only; configured tokens belong to Pi's parser. */
function dedupedResourceArgs(overrides?: PiLaunchOverrides): string[] {
  if (!overrides) return [];
  const seen = new Set<string>();
  const fresh: string[] = [];
  const requested = resourceArgsFor(overrides);
  for (let i = 0; i < requested.length; i += 2) {
    const flag = requested[i]!;
    const path = requested[i + 1]!;
    if (seen.has(`${flag} ${path}`)) continue;
    seen.add(`${flag} ${path}`);
    fresh.push(flag, path);
  }
  return fresh;
}

export interface FakeAccountServerOptions {
  pods?: FakeAccountPod[];
  /** Answer a multiplexed rpc command; default answers get_state minimally. */
  onRpc?: (command: Record<string, unknown>) => unknown;
  /** How many launches to leave "provisioning" before flipping to started (polling test). */
  provisionPolls?: number;
  /** Whether POST /pods/resolve reports a provider credential (default true). */
  credentialAvailable?: boolean;
  /** False models a server whose strict resolve schema predates request-scoped Pi settings. */
  supportsPiSettings?: boolean;
  /** False explicitly rejects piOverrides as an unknown resolve field. */
  supportsPiOverrides?: boolean;
  /** False models template exclusivity before the unified settings contract. */
  supportsUnifiedSettingsContract?: boolean;
  /** False lets resolve enforce org policy against a query-declared project layer. */
  allowProjectLayer?: boolean;
  /** False models a server whose strict launch schema predates session forking. */
  supportsForkFrom?: boolean;
  /** False models a server whose strict template schema predates template-owned Pi settings. */
  supportsTemplatePiSettings?: boolean;
  /** Omitted from /me when unset, matching a token with no roles. */
  permissions?: string[];
  /** Whether the current org is personal; shared orgs get the stricter consent path. */
  personalOrg?: boolean;
  /** Shim generation reported by the gateway hello; defaults to the current launcher. */
  shimVersion?: string;
  /** Shim protocol version reported by the gateway hello. */
  protocolVersion?: number;
  /** Pi reported by every pod unless piVersions overrides it. */
  piVersion?: string;
  /** Per-pod Pi versions, mutable through a successful hidden install command. */
  piVersions?: Record<string, string>;
  /** Gateway pi pin advertised on hello. `null` omits the field (older servers). */
  serverPiVersion?: string | null;
  /** Answer a prompt with one line and settle, so a headless one-shot actually finishes. */
  answerPrompts?: boolean;
  /** Account credential-center fixtures. */
  credentials?: CredentialStatus[];
  connectableProviders?: ConnectableProvider[];
  /** Frames sent in order; prompts wait for a response before the script continues. */
  credentialLoginFrames?: Array<Record<string, unknown>>;
  /** Same, per provider, for runs that connect several providers differently. */
  credentialLoginFramesByProvider?: Record<string, Array<Record<string, unknown>>>;
  /** False models a server that predates the workspace clone/archive routes (404 on both). */
  supportsWorkspaceSeed?: boolean;
  /** Entries returned by GET /pods/:id/files in receive tests. */
  receiveEntries?: Array<{
    relPath: string;
    kind: "file" | "dir" | "symlink";
    mode: number;
    size?: number;
    target?: string;
    contents?: string;
  }>;
}
export class FakeAccountServer {
  readonly calls: RecordedCall[] = [];
  pods: FakeAccountPod[];
  credentials: CredentialStatus[];
  connectableProviders: ConnectableProvider[];
  credentialLoginFrames: Array<Record<string, unknown>>;
  credentialLoginFramesByProvider: Record<string, Array<Record<string, unknown>>>;
  readonly credentialLoginResponses: Array<{ id: string; value: string }> = [];
  readonly credentialLoginUrls: string[] = [];
  readonly credentialLoginSockets: WebSocket[] = [];
  credentialLoginCancels = 0;
  readonly credentialTestErrors: Record<string, { status: number; code: string; message: string }> = {};
  /** When set, listing model credentials fails with this status. */
  modelCredentialsError: { status: number; error: string } | null = null;
  /** Org secrets written through PUT /v1/secrets/org/:org/:name. */
  readonly orgSecrets: Record<string, string> = {};
  /** The persistent user/org bundles the settings API serves; empty unless a test sets them. */
  userSettings: ApiSettingsBundle = { config: {}, version: 0, initScript: "", bakeScript: "", piFiles: {} };
  orgSettings: ApiSettingsBundle = { config: {}, version: 0, initScript: "", bakeScript: "", piFiles: {} };
  /** Every scope's secrets, keyed `${scope}/${scopeId}`. */
  readonly secrets: Record<string, Record<string, string>> = {};
  templates: Array<{
    id: string;
    name: string;
    description: string | null;
    status: "active";
    scope?: "user" | "org";
    initScript: string | null;
    bakeScript?: string | null;
    config: Record<string, unknown>;
    piSettings?: { user?: Record<string, unknown>; project?: Record<string, unknown> };
    /** Present on servers with template revisions; PATCH is compare-and-swap when the client sends one. */
    version?: number;
    createdAt: string;
    updatedAt: string;
  }> = [];
  /** Sockets currently attached to the fake gateway, newest last. */
  readonly sockets: WebSocket[] = [];
  /** Semantic frames received from gateway clients, including get_models probes. */
  readonly gatewayMessages: Array<Record<string, unknown>> = [];
  /** When set, answer get_models with this frame; null models an older server that ignores it. */
  modelsResponse: Record<string, unknown> | null = null;
  /** Transient ticket/pre-hello failures used to model a gateway deployment gap. */
  wsTicketFailures = 0;
  wsAttachFailures = 0;
  /** Permanent pre-hello failure for the next attach (code/message/close). */
  wsAttachPermanentError: { code: string; message: string; closeCode?: number } | null = null;
  wsAttachStalls = 0;
  wsTicketRequests = 0;
  restoreRequests = 0;
  stopRequests = 0;
  restoreFailures = 0;
  fileUploadFailures = 0;
  /** Fail the next N workspace clone / archive requests with a 500. */
  workspaceCloneFailures = 0;
  workspaceArchiveFailures = 0;
  /** Pods whose workdir is "already populated": both workspace routes answer 409. */
  readonly workspaceNotEmptyPods = new Set<string>();
  /** Every archive body received, as the raw gzip bytes, keyed by pod id (last wins). */
  readonly workspaceArchives = new Map<string, Buffer>();
  bashInstallFailures = 0;
  readonly bashCommands: string[] = [];
  readonly piVersions: Record<string, string>;
  /** After hello, ignore inbound frames (no pong) for this many sockets — a half-open TCP. */
  wsBlackholeRemaining = 0;
  /** Fail attach for these pod ids (retryable pod_unavailable). */
  readonly wsFailPodIds = new Set<string>();
  /** Never answer these REST paths (hung TCP). */
  hangRest = false;
  /** After attach, stop answering pings/RPCs on live sockets (half-open). */
  ignoreWsMessages = false;
  /** Durable events for from_seq replay and REST backfill. */
  readonly sessionEvents: Array<{ seq: number; kind: string; payload: unknown; createdAt: string }> = [];
  readonly sessionUrls: string[] = [];
  maxSocketReplay = 500;

  private server: http.Server;
  private wss: WebSocketServer;
  private pendingPolls: Map<string, number> = new Map();
  private credentialLoginTickets = new Map<string, { providerId: string; authType: "oauth" | "api_key" }>();
  url = "";

  constructor(private readonly opts: FakeAccountServerOptions = {}) {
    this.pods = opts.pods ?? [];
    this.credentials = [...(opts.credentials ?? [])];
    this.connectableProviders = [...(opts.connectableProviders ?? [{
      id: "anthropic",
      name: "Anthropic (Claude Pro/Max)",
      oauth: { loginLabel: "Sign in with Anthropic" },
      apiKey: true,
      brokerSupported: true,
    }])];
    this.credentialLoginFrames = [...(opts.credentialLoginFrames ?? [])];
    this.credentialLoginFramesByProvider = { ...(opts.credentialLoginFramesByProvider ?? {}) };
    this.piVersions = { ...(opts.piVersions ?? {}) };
    for (const pod of this.pods) this.piVersions[pod.id] ??= opts.piVersion ?? bundledPiVersion();
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.handleWs(req.url ?? "", ws));
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (typeof address === "object" && address) this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const ws of [...this.sockets, ...this.credentialLoginSockets]) ws.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.hangRest) return; // Never answer — models a hung TCP connection.
    const url = new URL(req.url ?? "/", this.url);
    const raw = await readRawBody(req);
    const contentType = req.headers["content-type"] ?? "";
    // A streamed archive is recorded by shape, not content: the bytes live in workspaceArchives.
    const body = contentType.startsWith("application/x-tar")
      ? {
          contentType,
          contentLength: req.headers["content-length"] ?? null,
          bytes: raw.length,
          gzip: raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b,
        }
      : decodeBody(raw);
    this.calls.push({ method: req.method ?? "GET", path: url.pathname, search: url.search, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (!req.headers.authorization?.startsWith("Bearer ")) return send(401, { error: "unauthorized" });
    const p = url.pathname;
    // A `ppt_<podId>` bearer models the scoped pod token the server injects into a pod: the
    // caller is that pod, and every pod route answers only for its own subtree.
    const callerPodId = /^Bearer ppt_(.+)$/.exec(req.headers.authorization)?.[1] ?? null;
    const isDescendant = (podId: string, ancestorId: string): boolean => {
      let cursor = this.pods.find((x) => x.id === podId)?.parentPodId ?? null;
      while (cursor) {
        if (cursor === ancestorId) return true;
        cursor = this.pods.find((x) => x.id === cursor)?.parentPodId ?? null;
      }
      return false;
    };

    if (p === "/v1/version") {
      return send(200, { version: "test-server" });
    }
    if (p === "/v1/me") {
      return send(200, {
        user: { id: "user-1", email: "dev@example.com" },
        currentOrgId: "org-1",
        // Omitted unless a test opts in: a roleless token really does come back without the
        // key, and that is the shape that used to crash whoami.
        ...(this.opts.permissions ? { permissions: this.opts.permissions } : {}),
        organization: { id: "org-1", alias: "dev", name: "Dev Org" },
        accountConsoleUrl: "http://127.0.0.1:8081/ui/console/users/me",
        adminConsoleUrl: "http://127.0.0.1:8081/ui/console",
      });
    }
    if (
      p === "/v1/pi-auth" ||
      p === "/v1/pi-auth/content" ||
      p === "/v1/pi-auth/fresh" ||
      /^\/v1\/pods\/[^/]+\/save-pi-auth$/.test(p)
    ) {
      return send(410, {
        error: "client_upgrade_required",
        detail: {
          code: "client_upgrade_required",
          message: "model credentials require pi pod 0.2.0 or newer",
          minimumVersion: "0.2.0",
        },
      });
    }

    if (p === "/v1/model-credentials" && req.method === "GET") {
      if (callerPodId) return send(403, { error: "pod tokens cannot access account credentials" });
      if (this.modelCredentialsError) {
        return send(this.modelCredentialsError.status, { error: this.modelCredentialsError.error });
      }
      return send(200, {
        credentials: [...this.credentials].sort((a, b) => a.providerId.localeCompare(b.providerId)),
        providers: this.connectableProviders,
      });
    }
    const credentialMatch = /^\/v1\/model-credentials\/([^/]+)(?:\/(login-ticket|test))?$/.exec(p);
    if (credentialMatch) {
      if (callerPodId) return send(403, { error: "pod tokens cannot access account credentials" });
      const providerId = decodeURIComponent(credentialMatch[1]!);
      const action = credentialMatch[2];
      const provider = this.connectableProviders.find((candidate) => candidate.id === providerId);
      if (action === "login-ticket" && req.method === "POST") {
        const authType = (body as { authType?: unknown })?.authType;
        const supported = provider?.brokerSupported === true &&
          (authType === "oauth" ? provider.oauth !== null : authType === "api_key" && provider.apiKey);
        if (!supported) {
          return send(400, {
            error: "credential_provider_unsupported",
            detail: {
              code: "credential_provider_unsupported",
              message: `${providerId} cannot be connected by the account broker; use a scoped API-key secret if available`,
              provider: providerId,
            },
          });
        }
        const ticket = `mclt_${this.credentialLoginTickets.size + 1}_${providerId}`;
        this.credentialLoginTickets.set(ticket, { providerId, authType: authType as "oauth" | "api_key" });
        return send(201, { ticket, expiresAt: new Date(Date.now() + 300_000).toISOString() });
      }
      if (action === "test" && req.method === "POST") {
        const failure = this.credentialTestErrors[providerId];
        if (failure) {
          return send(failure.status, {
            error: failure.code,
            detail: { code: failure.code, message: failure.message, provider: providerId, retryable: failure.status >= 500 },
          });
        }
        const status = this.credentials.find((credential) => credential.providerId === providerId);
        return status ? send(200, { status }) : send(404, { error: "credential not found" });
      }
      if (!action && req.method === "DELETE") {
        const before = this.credentials.length;
        this.credentials = this.credentials.filter((credential) => credential.providerId !== providerId);
        if (this.credentials.length === before) return send(404, { error: "credential not found" });
        res.writeHead(204);
        res.end();
        return;
      }
    }
    if (p === "/v1/pods" && req.method === "GET") {
      const project = url.searchParams.get("project");
      const templateId = url.searchParams.get("templateId");
      let pods = project ? this.pods.filter((pod) => pod.project === project) : this.pods;
      if (templateId) pods = pods.filter((pod) => pod.templateId === templateId);
      if (callerPodId) {
        pods = pods.filter((pod) => pod.id === callerPodId || isDescendant(pod.id, callerPodId));
      }
      return send(200, { pods });
    }
    if (p === "/v1/pods" && req.method === "POST") {
      const launch = body as {
        templateId?: string;
        project?: { name: string; config: Record<string, unknown>; env: Record<string, string>; initScript: string };
        piOverrides?: PiLaunchOverrides;
        forkFrom?: { podId: string; sessionPath?: string };
        placement?: { host: string };
        workspaceSeed?: boolean;
      };
      if ("forkFrom" in launch && this.opts.supportsForkFrom === false) {
        return send(400, { error: "unrecognized key forkFrom" });
      }
      // A strict launch schema on a server without the seed routes rejects the gate flag.
      if ("workspaceSeed" in launch && this.opts.supportsWorkspaceSeed === false) {
        return send(400, { error: "unrecognized key workspaceSeed" });
      }
      if (launch.workspaceSeed && launch.placement) {
        return send(400, { error: "co-located pods share their host's machine and are not seeded" });
      }
      if (launch.workspaceSeed && launch.forkFrom) {
        return send(400, { error: "a forked pod inherits its workspace and cannot be seeded" });
      }
      const project = launch.project;
      const parent = callerPodId ? this.pods.find((x) => x.id === callerPodId) : undefined;
      const pod = fakePod({
        id: `0198f5a0-0000-7000-8000-${String(this.pods.length + 2).padStart(12, "0")}`,
        state: "active",
        ready: false,
        initializing: true,
        parentPodId: parent?.id ?? null,
        lineageDepth: parent ? parent.lineageDepth + 1 : 0,
        templateId: launch.templateId ?? null,
        project: project?.name ?? null,
        name: project?.name ?? "default",
      });
      if (launch.workspaceSeed) {
        pod.resolvedConfig.workspaceSeed = { status: "pending", requestedAt: new Date().toISOString() };
      }
      this.pods.push(pod);
      this.pendingPolls.set(pod.id, this.opts.provisionPolls ?? 0);
      return send(201, { pod, report: { clamps: [], secretKeys: [], warnings: [] } });
    }

    if (p.startsWith("/v1/secrets/")) {
      const [, , , scope, scopeId, name] = p.split("/");
      const bucket = (this.secrets[`${scope}/${scopeId}`] ??= {});
      if (req.method === "GET") {
        return send(200, {
          secrets: Object.keys(bucket).map((n) => ({
            name: n,
            scopeType: scope,
            scopeId,
            updatedAt: "2026-01-01T00:00:00.000Z",
          })),
        });
      }
      if (req.method === "PUT" && name) {
        bucket[name] = (body as { value: string }).value;
        if (scope === "org") this.orgSecrets[name] = bucket[name]!;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "DELETE" && name) {
        if (!(name in bucket)) return send(404, { error: "secret not found" });
        delete bucket[name];
        delete this.orgSecrets[name];
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (/^\/v1\/(users|orgs)\/[^/]+\/settings$/.test(p) && req.method === "GET") {
      return send(200, p.startsWith("/v1/users/") ? this.userSettings : this.orgSettings);
    }

    if (p === "/v1/templates" && req.method === "GET") {
      return send(200, { templates: this.templates });
    }
    if (p === "/v1/templates" && req.method === "POST") {
      const b = body as {
        name: string;
        config?: Record<string, unknown>;
        description?: string;
        scope?: "user" | "org";
        initScript?: string;
        bakeScript?: string;
        piSettings?: { user?: Record<string, unknown>; project?: Record<string, unknown> };
      };
      if ("piSettings" in b && this.opts.supportsTemplatePiSettings === false) {
        return send(400, { error: "unrecognized key piSettings" });
      }
      const scope = b.scope ?? "user";
      // Like the real server, names are unique per scope: yours among yours, org among org.
      if (this.templates.some((t) => t.name === b.name && (t.scope ?? "org") === scope)) {
        return send(409, { error: "a template with this name already exists" });
      }
      const created = {
        id: `tpl-${this.templates.length + 1}`,
        name: b.name,
        description: b.description ?? null,
        status: "active" as const,
        scope,
        initScript: b.initScript ?? null,
        bakeScript: b.bakeScript ?? null,
        config: b.config ?? {},
        piSettings: b.piSettings ?? {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      this.templates.push(created);
      return send(201, created);
    }
    if (p.startsWith("/v1/templates/")) {
      const id = p.split("/")[3]!;
      const found = this.templates.find((t) => t.id === id);
      if (!found) return send(404, { error: "template not found" });
      if (p.endsWith("/activate")) {
        found.status = "active";
        return send(200, { id: found.id, status: "active" });
      }
      if (req.method === "GET") return send(200, found);
      if (req.method === "PATCH") {
        const { expectedVersion, ...patch } = body as Record<string, unknown> & { expectedVersion?: number };
        if ("piSettings" in patch && this.opts.supportsTemplatePiSettings === false) {
          return send(400, { error: "unrecognized key piSettings" });
        }
        if (expectedVersion !== undefined && found.version !== expectedVersion) {
          return send(409, { error: "version conflict: template changed since you read it" });
        }
        Object.assign(found, patch);
        if (found.version !== undefined) found.version += 1;
        return send(200, found);
      }
      if (req.method === "DELETE") {
        this.templates = this.templates.filter((t) => t.id !== id);
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (p === "/v1/pods/resolve" && req.method === "POST") {
      const b = body as {
        projectConfig?: Record<string, unknown>;
        projectEnv?: Record<string, string>;
        provider?: string;
        templateId?: string;
        projectBakeScript?: string;
        piSettings?: { user?: Record<string, unknown>; project?: Record<string, unknown> };
        piOverrides?: PiLaunchOverrides;
        forkFrom?: { podId: string; sessionPath?: string };
      };
      if (b.piSettings && this.opts.supportsPiSettings === false) {
        return send(400, { error: "unrecognized key piSettings" });
      }
      if (b.piOverrides && this.opts.supportsPiOverrides === false) {
        return send(400, { error: "unknown field piOverrides" });
      }
      if ("forkFrom" in b && this.opts.supportsForkFrom === false) {
        return send(400, { error: "unrecognized key forkFrom" });
      }
      if (url.searchParams.get("project_layer") === "true" && this.opts.allowProjectLayer === false) {
        return send(400, { error: "org policy allowProjectLayer forbids project launch settings" });
      }
      const template = b.templateId ? this.templates.find((entry) => entry.id === b.templateId) : undefined;
      const unifiedSettings = this.opts.supportsUnifiedSettingsContract !== false;
      const projectConfig = b.projectConfig ?? {};
      const projectEnv = b.projectEnv ?? {};
      const piSettings = template && !unifiedSettings ? template.piSettings : (b.piSettings ?? template?.piSettings);
      const projectBakeScript = b.projectBakeScript;
      const merged = template && !unifiedSettings
        ? { ...template.config }
        : { ...(template?.config ?? {}), ...projectConfig };
      const provider = "sandbox";
      const mergedPi =
        merged["pi"] !== null && typeof merged["pi"] === "object"
          ? (merged["pi"] as Record<string, unknown>)
          : {};
      const configuredArgs = Array.isArray(mergedPi["args"]) ? (mergedPi["args"] as string[]) : [];
      // Resource options precede opaque configured args, including any separator
      // or extension-defined flags. Existing model/thinking projection is unchanged.
      const resourceArgs = dedupedResourceArgs(b.piOverrides);
      const overrideArgs = [
        ...(b.piOverrides?.model ? ["--model", b.piOverrides.model] : []),
        ...(b.piOverrides?.thinking ? ["--thinking", b.piOverrides.thinking] : []),
      ];
      // Single-provider build: the merged bundle carries no provider selection key —
      // the top-level `provider` field below names the backend informatively.
      const resolvedConfig =
        resourceArgs.length + overrideArgs.length > 0
          ? { ...merged, pi: { ...mergedPi, args: [...resourceArgs, ...configuredArgs, ...overrideArgs] } }
          : { ...merged };
      const providerCreds = new Set(["PI_POD_SANDBOX_TOKEN"]);
      const secretScopes: Record<string, string> = {};
      for (const k of Object.keys(projectEnv)) {
        if (!providerCreds.has(k)) secretScopes[k] = "project";
      }
      return send(200, {
        provider,
        template: template ? { id: template.id, name: template.name } : null,
        config: resolvedConfig,
        piOverrides: b.piOverrides ?? null,
        ...(unifiedSettings ? { settingsContract: "org-template-project-v1" } : {}),
        clamps: [],
        warnings: [],
        credential: {
          envVar: "PI_POD_SANDBOX_TOKEN",
          available: this.opts.credentialAvailable !== false,
          source: this.opts.credentialAvailable === false ? null : "platform",
        },
        secretKeys: Object.keys(secretScopes).sort(),
        secretScopes: Object.keys(secretScopes).length > 0 ? secretScopes : null,
        initSteps: [],
        piAuthProviders: [],
        ...(piSettings
          ? {
              piSettings: {
                files: ["settings.json"],
                bytes: JSON.stringify(piSettings).length,
                packageCount: 0,
                droppedKeys: [],
                status: "pending",
              },
            }
          : {}),
        workdir: "/home/user",
        image: typeof merged["image"] === "string" ? (merged["image"] as string) : "pi-pod-base",
        bake: projectBakeScript || template?.bakeScript
          ? { digest: createHash("sha256").update(`${template?.bakeScript ?? ""}\n${projectBakeScript ?? ""}`).digest("hex").slice(0, 12) }
          : null,
        egress: { mode: "open" },
        forkFrom: b.forkFrom
          ? { podId: b.forkFrom.podId, sessionPath: b.forkFrom.sessionPath ?? null }
          : null,
      });
    }

    const podMatch = /^\/v1\/pods\/([^/]+)(?:\/(.+))?$/.exec(p);
    if (podMatch) {
      const pod = this.pods.find((x) => x.id === podMatch[1]);
      if (!pod) return send(404, { error: "pod not found" });
      const sub = podMatch[2];
      // A pod token acts on its descendants; inspecting itself is the one exception.
      if (callerPodId && !isDescendant(pod.id, callerPodId) && !(pod.id === callerPodId && !sub && req.method === "GET")) {
        return send(403, { error: "a pod token may only act on pods it launched" });
      }
      if (!sub && req.method === "GET") {
        const remaining = this.pendingPolls.get(pod.id) ?? 0;
        if (pod.initializing) {
          if (remaining <= 0) {
            pod.initializing = false;
            pod.ready = true;
          } else this.pendingPolls.set(pod.id, remaining - 1);
        }
        return send(200, pod);
      }
      if (!sub && req.method === "PATCH") {
        pod.name = (body as { name: string }).name;
        return send(200, { id: pod.id, name: pod.name });
      }
      if (!sub && req.method === "DELETE") {
        const cascade = url.searchParams.get("cascade") === "true";
        const live = this.pods.filter((x) => x.parentPodId === pod.id && x.state !== "archived");
        if (live.length > 0 && !cascade) {
          return send(409, {
            error: `pod ${pod.id} has ${live.length} live child pod(s); pass ?cascade=true to delete them too`,
          });
        }
        const doomed = new Set([pod.id]);
        if (cascade) for (const x of this.pods) if (isDescendant(x.id, pod.id)) doomed.add(x.id);
        this.pods = this.pods.filter((candidate) => !doomed.has(candidate.id));
        return send(200, {
          id: pod.id,
          state: "gone",
          deleted: true,
          cascaded: [...doomed].filter((id) => id !== pod.id),
        });
      }
      if (sub === "stop") {
        this.stopRequests += 1;
        pod.ready = false;
        return send(200, { id: pod.id, state: "stopped" });
      }
      if (sub === "archive" || sub === "restore") {
        if (sub === "restore") {
          this.restoreRequests += 1;
          if (this.restoreFailures > 0) {
            this.restoreFailures -= 1;
            return send(500, { error: "restore failed" });
          }
        }
        pod.state = sub === "archive" ? "archived" : "active";
        return send(200, { id: pod.id, state: pod.state });
      }
      if (sub === "ws-ticket") {
        this.wsTicketRequests += 1;
        if (pod.state === "archived") {
          return send(409, { error: "restore the pod before opening a session" });
        }
        if (this.wsTicketFailures > 0) {
          this.wsTicketFailures -= 1;
          return send(503, { error: "gateway replacement is not ready" });
        }
        return send(201, { ticket: `ticket-${pod.id}`, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      // Reuse claims a stopped pod's warm disk: same id, provisioning again.
      if (sub === "reuse" && req.method === "POST") {
        pod.ready = false;
        pod.initializing = true;
        this.pendingPolls.set(pod.id, this.opts.provisionPolls ?? 0);
        return send(200, { pod, report: { clamps: [], secretKeys: [], warnings: [] } });
      }
      if (sub === "patch") return send(200, { id: pod.id, applied: true });
      if (sub === "files" && req.method === "POST") {
        if (this.fileUploadFailures > 0) {
          this.fileUploadFailures -= 1;
          return send(500, { error: "file upload failed" });
        }
        return send(200, { id: pod.id, received: (body as { entries: unknown[] }).entries.length });
      }
      if (sub === "files" && req.method === "GET") {
        return send(200, {
          id: pod.id,
          source: url.searchParams.get("path"),
          entries: this.opts.receiveEntries ?? [],
        });
      }
      // Workspace seeding routes: an exact-commit clone, a streamed tar archive, and the gate
      // release. Mirrors the server: a seed records `seeded` and opens the gate; a failure on a
      // gated pod leaves the gate armed so the client can fall back or skip.
      const seedRecord = pod.resolvedConfig.workspaceSeed;
      const gated = seedRecord?.status === "pending";
      const settle = (status: "seeded" | "failed" | "skipped", kind?: "clone" | "archive", reason?: string): void => {
        pod.resolvedConfig.workspaceSeed = {
          requestedAt: seedRecord?.requestedAt ?? new Date().toISOString(),
          ...(kind ? { kind } : {}),
          status,
          ...(reason ? { reason } : {}),
        };
      };
      if (sub === "workspace/clone" && req.method === "POST") {
        if (this.opts.supportsWorkspaceSeed === false) return send(404, { message: `Route POST:${p} not found` });
        if (this.workspaceNotEmptyPods.has(pod.id)) {
          if (!gated) settle("failed", "clone", "workspace_not_empty");
          return send(409, { error: "workspace_not_empty" });
        }
        if (this.workspaceCloneFailures > 0) {
          this.workspaceCloneFailures -= 1;
          if (!gated) settle("failed", "clone", "clone failed");
          return send(500, { error: "clone failed: could not resolve host" });
        }
        const clone = body as { url?: unknown; branch?: unknown; commit?: unknown; credential?: unknown };
        if (typeof clone.url !== "string" || typeof clone.branch !== "string" || !/^[0-9a-f]{40}$/.test(String(clone.commit))) {
          return send(400, { error: "invalid clone request" });
        }
        settle("seeded", "clone");
        return send(200, { id: pod.id, kind: "clone", status: "seeded", commit: clone.commit, entries: 3, durationMs: 1200, piStarting: gated });
      }
      if (sub === "workspace/archive" && req.method === "PUT") {
        if (this.opts.supportsWorkspaceSeed === false) return send(404, { message: `Route PUT:${p} not found` });
        if (this.workspaceNotEmptyPods.has(pod.id)) return send(409, { error: "workspace_not_empty" });
        if (this.workspaceArchiveFailures > 0) {
          this.workspaceArchiveFailures -= 1;
          if (!gated) settle("failed", "archive", "archive extraction failed");
          return send(500, { error: "archive extraction failed" });
        }
        if (!contentType.startsWith("application/x-tar+gzip")) return send(415, { error: "unsupported media type" });
        this.workspaceArchives.set(pod.id, raw);
        settle("seeded", "archive");
        return send(200, { id: pod.id, kind: "archive", status: "seeded", bytes: raw.length, entries: 3, durationMs: 800, piStarting: gated });
      }
      if (sub === "workspace/skip" && req.method === "POST") {
        if (this.opts.supportsWorkspaceSeed === false) return send(404, { message: `Route POST:${p} not found` });
        if (!gated) return send(200, { id: pod.id, status: seedRecord?.status ?? "skipped", piStarting: false });
        settle("skipped", seedRecord?.kind, (body as { reason?: string } | undefined)?.reason ?? "client skipped workspace seeding");
        return send(200, { id: pod.id, status: "skipped", piStarting: true });
      }
    }
    const sessionMatch = /^\/v1\/sessions\/([^/]+)\/events$/.exec(p);
    if (sessionMatch && req.method === "GET") {
      const after = Number(url.searchParams.get("after_seq") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 500);
      const events = this.sessionEvents.filter((event) => event.seq > after).slice(0, limit);
      return send(200, { truncatedBelowSeq: null, events });
    }
    return send(404, { error: `unhandled ${req.method} ${p}` });
  }

  private handleWs(rawUrl: string, ws: WebSocket): void {
    const parsedUrl = new URL(rawUrl, this.url);
    if (/^\/v1\/model-credentials\/[^/]+\/login$/.test(parsedUrl.pathname)) {
      this.handleCredentialLoginWs(parsedUrl, ws);
      return;
    }
    this.sockets.push(ws);
    if (this.wsAttachStalls > 0) {
      this.wsAttachStalls -= 1;
      return; // Leave the socket open without hello until the client cancels it.
    }
    if (this.wsAttachPermanentError) {
      const permanent = this.wsAttachPermanentError;
      this.wsAttachPermanentError = null;
      ws.send(JSON.stringify({
        type: "error", code: permanent.code, message: permanent.message,
      }));
      ws.close(permanent.closeCode ?? 4404, permanent.code);
      return;
    }
    if (this.wsAttachFailures > 0) {
      this.wsAttachFailures -= 1;
      ws.send(JSON.stringify({
        type: "error", code: "pod_unavailable", message: "gateway is shutting down",
      }));
      ws.close(4409, "pod_unavailable");
      return;
    }
    const url = parsedUrl;
    this.sessionUrls.push(rawUrl);
    const podId = /\/v1\/pods\/([^/]+)\/session/.exec(url.pathname)?.[1] ?? "";
    if (this.wsFailPodIds.has(podId)) {
      ws.send(JSON.stringify({
        type: "error", code: "pod_unavailable", message: "target gateway is down",
      }));
      ws.close(4409, "pod_unavailable");
      return;
    }
    const fromSeqRaw = url.searchParams.get("from_seq");
    const fromSeq = fromSeqRaw != null ? Number(fromSeqRaw) : null;
    const replayable = fromSeq != null ? this.sessionEvents.filter((event) => event.seq > fromSeq) : [];
    const tail = replayable.slice(-this.maxSocketReplay);
    const firstReplayedSeq = tail[0]?.seq ?? null;
    const latestSeq = this.sessionEvents.at(-1)?.seq ?? 0;
    ws.send(
      JSON.stringify({
        type: "hello",
        sessionId: "sess-1",
        podId,
        latestSeq,
        firstReplayedSeq,
        state: null,
        shim: {
          event: "hello",
          proto: this.opts.protocolVersion ?? FRAME_PROTO_VERSION,
          shimVersion: this.opts.shimVersion ?? SHIM_VERSION,
          extensionVersion: POD_EXTENSION_VERSION,
          piVersion: this.piVersions[podId] ?? this.opts.piVersion ?? bundledPiVersion(),
          piRunning: true,
        },
        ...(this.opts.serverPiVersion === null
          ? {}
          : { serverPiVersion: this.opts.serverPiVersion ?? bundledPiVersion() }),
      }),
    );
    if (fromSeq != null && firstReplayedSeq != null && firstReplayedSeq > fromSeq + 1) {
      ws.send(JSON.stringify({ type: "replay_gap", fromSeq: fromSeq + 1, toSeq: firstReplayedSeq - 1 }));
    }
    for (const event of tail) {
      ws.send(JSON.stringify({ type: "event", seq: event.seq, kind: event.kind, payload: event.payload, ts: event.createdAt }));
    }
    const blackhole = this.wsBlackholeRemaining > 0;
    if (blackhole) this.wsBlackholeRemaining -= 1;
    ws.on("message", (raw) => {
      if (blackhole || this.ignoreWsMessages) return;
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      this.gatewayMessages.push(message);
      if (message["type"] === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (message["type"] === "get_models") {
        if (this.modelsResponse) ws.send(JSON.stringify(this.modelsResponse));
      } else if (message["type"] === "rpc") {
        const command = message["command"] as Record<string, unknown>;
        let success = true;
        let error: string | undefined;
        if (command["type"] === "bash" && typeof command["command"] === "string") {
          const bash = command["command"];
          this.bashCommands.push(bash);
          const install = /^# pi-pod-install-version: (.+)$/m.exec(bash);
          if (install && this.bashInstallFailures > 0) {
            this.bashInstallFailures -= 1;
            success = false;
            error = "install failed";
          } else if (install) {
            this.piVersions[podId] = install[1]!;
          }
        }
        const data = this.opts.onRpc
          ? this.opts.onRpc(command)
          : command["type"] === "get_state"
            ? { isStreaming: false, isCompacting: false, model: null }
            : command["type"] === "bash"
              ? { output: "", exitCode: 0, cancelled: false, truncated: false }
              : {};
        ws.send(
          JSON.stringify({
            type: "rpc_result",
            id: message["id"],
            response: success
              ? { type: "response", id: message["id"], success: true, data }
              : { type: "response", id: message["id"], success: false, error },
          }),
        );
        if (command["type"] === "prompt" && this.opts.answerPrompts) {
          const reply = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done\n" } };
          ws.send(JSON.stringify({ type: "event", kind: "stream", payload: reply }));
          ws.send(JSON.stringify({ type: "event", kind: "stream", payload: { type: "agent_settled" } }));
        }
      }
    });
  }


  private handleCredentialLoginWs(url: URL, ws: WebSocket): void {
    this.credentialLoginSockets.push(ws);
    this.credentialLoginUrls.push(url.toString());
    const providerId = decodeURIComponent(/^\/v1\/model-credentials\/([^/]+)\/login$/.exec(url.pathname)?.[1] ?? "");
    const ticket = url.searchParams.get("ticket") ?? "";
    const ticketData = this.credentialLoginTickets.get(ticket);
    if (!ticketData || ticketData.providerId !== providerId) {
      ws.close(4001, "invalid credential login ticket");
      return;
    }
    this.credentialLoginTickets.delete(ticket);
    const scripted = this.credentialLoginFramesByProvider[providerId] ?? this.credentialLoginFrames;
    const frames = scripted.length > 0
      ? scripted.map((frame) => structuredClone(frame))
      : [{
          type: "done",
          ok: true,
          status: { providerId, type: ticketData.authType, state: "ready", revision: 1 },
        }];
    let index = 0;
    let finished = false;
    const pump = (): void => {
      while (index < frames.length && ws.readyState === 1) {
        const frame = frames[index++]!;
        if (frame["type"] === "done" && frame["ok"] === true) {
          const status = frame["status"] as CredentialStatus;
          this.credentials = [
            ...this.credentials.filter((credential) => credential.providerId !== status.providerId),
            status,
          ];
        }
        ws.send(JSON.stringify(frame));
        if (frame["type"] === "prompt") return;
        if (frame["type"] === "done") {
          finished = true;
          ws.close(1000);
          return;
        }
      }
    };
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message["type"] === "response" && typeof message["id"] === "string" && typeof message["value"] === "string") {
        this.credentialLoginResponses.push({ id: message["id"], value: message["value"] });
        pump();
      } else if (message["type"] === "cancel" && !finished) {
        finished = true;
        this.credentialLoginCancels += 1;
        ws.send(JSON.stringify({ type: "done", ok: false, error: { code: "cancelled", message: "Login cancelled" } }));
        ws.close(1000);
      }
    });
    ws.on("close", () => {
      if (finished) return;
      finished = true;
      this.credentialLoginCancels += 1;
    });
    pump();
  }

  /** Push a live agent event to every attached socket, like the gateway's fan-out. */
  emitEvent(seq: number, kind: string, payload: unknown): void {
    const createdAt = new Date().toISOString();
    this.sessionEvents.push({ seq, kind, payload, createdAt });
    for (const ws of this.sockets) {
      if (ws.readyState !== 1) continue;
      ws.send(JSON.stringify({ type: "event", seq, kind, payload, ts: createdAt }));
    }
  }

  emitControl(payload: unknown): void {
    for (const ws of this.sockets) ws.send(JSON.stringify({ type: "control", payload }));
  }

  /** End attached sessions with the same intentional close contract as the hosted gateway. */
  endSessions(reason: string, code = 1000): void {
    for (const ws of this.sockets) {
      if (ws.readyState !== 1) continue;
      ws.send(JSON.stringify({ type: "pod_state", state: "detached", reason }));
      ws.close(code, reason);
    }
  }
}

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function decodeBody(raw: Buffer): unknown {
  const text = raw.toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
