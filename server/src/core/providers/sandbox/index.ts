import { createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import WebSocket, { type RawData } from "ws";
import { PiPodError } from "../../errors.js";
import { IMAGE_NAME } from "../../image-recipe.js";
import { PROVIDER_META } from "../meta.js";
import { buildWatcherScript, chunkPtyInput, delay, describeError, rejectConfigApiKey } from "../util.js";
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
} from "../types.js";
import { SandboxApiError, SandboxClient, SandboxWsError, isNotFound } from "./client.js";
import {
  ERR_NO_SESSION,
  STREAM_STDERR,
  STREAM_STDOUT,
  type AuthzResponse,
  type CreateSandboxRequest,
  type ExecClientFrame,
  type ExecServerFrame,
  type ImageInfoWire,
  type ImagePullRequest,
  type LabelsRequest,
  type ListResponse,
  type PtyClientFrame,
  type PtyServerFrame,
  type ArchiveIfStoppedRequest,
  type ArchiveIfStoppedResponse,
  type RetentionRequest,
  type RetentionResponse,
  type SandboxInfoWire,
  type StartRequest,
  type StopRequest,
} from "./wire.js";

export const DEFAULT_ARCHIVE_MAX_DELAY_DAYS = 30;
export const DEFAULT_SANDBOX_IMAGE_MIRROR = "ghcr.io/pi-pod";
export const SANDBOX_RESOURCE_MAXIMUMS = Object.freeze({ cpu: 2, memoryGB: 4, diskGB: 20 });

export const SANDBOX_CAPABILITIES: ProviderCapabilities = {
  serverSideArchive: true,
  archiveMaxDays: null,
  archiveTransition: { kind: "after-stop", maxDelayDays: DEFAULT_ARCHIVE_MAX_DELAY_DAYS },
  framedSessionReconnect: true,
  reportsLastActivity: true,
  ptyReattach: true,
  secretEnv: true,
  environmentPersistence: "rehydrate",
  idleAutoStop: "configurable",
  resourceSizing: "per-sandbox",
  // CPU and memory use cgroups. The native service puts each writable overlay on a sparse,
  // fixed-size ext4 image, so diskGB is also a kernel-enforced per-sandbox limit.
  egressEnforcement: "cidr",
  // The service gives each sandbox an IPv4 address on a NATed bridge and no IPv6 route, so
  // an AAAA record in an allowlist would name an address the sandbox cannot reach either
  // way. Core resolves A records only rather than emitting entries that mean nothing.
  egressAddressFamily: "ipv4",
  egressMaxEntries: null,
  workdirSurvivesStop: true,
};

interface SandboxProviderConfig {
  url: string;
  imageMirror: string;
}

export function resolveSandboxServiceUrl(
  configured: unknown,
  environment: string | undefined,
): string {
  const explicit = configured !== undefined;
  const value = explicit ? configured : environment;
  if (value === undefined || (typeof value === "string" && value.trim() === "")) {
    throw new PiPodError("sandbox service URL is not configured", {
      hint:
        "set PI_POD_SANDBOX_URL in the pi-pod-server deployment to an absolute HTTP(S) URL " +
        "(Compose default: http://pi-pod-sandbox:8433)",
    });
  }
  const label = explicit ? "providers.sandbox.url" : "PI_POD_SANDBOX_URL";
  if (typeof value !== "string") {
    throw new PiPodError(`${label}: expected a non-empty string`);
  }
  const normalized = value.trim();
  let url: URL;
  try {
    url = new URL(normalized);
  } catch (e) {
    throw new PiPodError(`${label}: expected an absolute URL`, { cause: e });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PiPodError(`${label}: expected an http or https URL`);
  }
  if (url.username || url.password) {
    throw new PiPodError(`${label} must not contain credentials`, {
      hint: `set ${PROVIDER_META.sandbox.credentialEnv}=<token> separately`,
    });
  }
  return normalized.replace(/\/+$/, "");
}

export function resolveSandboxImageMirror(
  environment: string | undefined = process.env["PI_POD_SANDBOX_IMAGE_MIRROR"],
): string {
  const value = (environment ?? DEFAULT_SANDBOX_IMAGE_MIRROR).trim().replace(/^\/+|\/+$/g, "");
  if (
    value === "" ||
    value.includes("://") ||
    value.includes("@") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new PiPodError(
      "PI_POD_SANDBOX_IMAGE_MIRROR must be an OCI registry namespace without a scheme or credentials",
      { hint: "for the standard pi-pod namespace, set PI_POD_SANDBOX_IMAGE_MIRROR=ghcr.io/pi-pod" },
    );
  }
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) {
    throw new PiPodError("PI_POD_SANDBOX_IMAGE_MIRROR must include a registry and namespace", {
      hint: "for example: ghcr.io/pi-pod",
    });
  }
  try {
    const parsed = new URL(`https://${value}`);
    if (!parsed.hostname || parsed.pathname.split("/").filter(Boolean).length === 0) throw new Error();
  } catch (error) {
    throw new PiPodError("PI_POD_SANDBOX_IMAGE_MIRROR is not a valid OCI registry namespace", {
      cause: error,
    });
  }
  return value;
}

/**
 * Mirror of the sandbox service's `deriveActivityToken` — the credential a pod carries for
 * keepalive. The service accepts it only on that sandbox's own activity route, so the pod
 * never holds the host-wide master token.
 */
export function deriveSandboxActivityToken(masterToken: string, sandboxId: string): string {
  return createHmac("sha256", masterToken)
    .update(`pi-pod-sandbox:activity:${sandboxId}`)
    .digest("hex");
}

const MANAGED_MIRROR_REF = new RegExp(
  `^${IMAGE_NAME}:([A-Za-z0-9_][A-Za-z0-9._-]{0,127})$`,
);

export function sandboxMirrorRef(
  ref: string,
  mirror = resolveSandboxImageMirror(),
): string {
  if (!MANAGED_MIRROR_REF.test(ref)) {
    throw new PiPodError(`sandbox image mirror refuses non-managed ref "${ref}"`, {
      hint: `only exact ${IMAGE_NAME}:<tag> managed runtime refs may be mapped to the platform mirror`,
    });
  }
  return `${resolveSandboxImageMirror(mirror)}/${ref}`;
}

function isSandboxMirrorRef(ref: string): boolean {
  return MANAGED_MIRROR_REF.test(ref);
}

function readProviderConfig(raw: Record<string, unknown>): SandboxProviderConfig {
  rejectConfigApiKey(raw, "sandbox", PROVIDER_META.sandbox.credentialEnv);
  return {
    url: resolveSandboxServiceUrl(raw["url"], process.env["PI_POD_SANDBOX_URL"]),
    imageMirror: resolveSandboxImageMirror(),
  };
}

/**
 * Provider activity to report for a listed sandbox, or `undefined` when the host's
 * `lastActivityAt` is not evidence of use.
 *
 * A native host that ADOPTS an archived workspace (`POST /v1/sandboxes/import`, fleet
 * rehome) initialises its row with `createdAt = lastActivityAt = stoppedAt = now()` and
 * `runtimeGeneration = 0` (pi-pod-sandbox `importArchived`): the timestamps describe the
 * metadata import, not anything a user did. Reporting them as activity would let the next
 * reconcile advance the pod's `last_activity_at` on a move alone, fabricating user history.
 *
 * Only that exact signature is treated as "fresh archived initialisation, never started
 * here": state archived, generation 0 (or absent on hosts predating the field), and all
 * three timestamps identical. Generation 0 ALONE is not proof — rows created before
 * generation tracking are also 0 but carry distinct timestamps from real use, and those
 * keep reporting activity exactly as before. Any started/stopped state, any generation
 * > 0, or any differing timestamp reports activity unchanged.
 */
export function providerActivityOf(
  info: Pick<SandboxInfoWire, "state" | "createdAt" | "lastActivityAt" | "stoppedAt" | "runtimeGeneration">,
): string | undefined {
  const freshArchivedImport =
    info.state === "archived" &&
    (info.runtimeGeneration ?? 0) === 0 &&
    typeof info.stoppedAt === "string" &&
    info.lastActivityAt === info.createdAt &&
    info.lastActivityAt === info.stoppedAt;
  return freshArchivedImport ? undefined : info.lastActivityAt;
}

function mapInfo(info: SandboxInfoWire): SandboxInfo {
  const lastActivityAt = providerActivityOf(info);
  return {
    id: info.id,
    labels: { ...info.labels },
    state: info.state,
    createdAt: info.createdAt,
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
  };
}

function mapApiError(error: unknown, what: string): never {
  if (error instanceof SandboxApiError) {
    const authHint =
      error.status === 401 || error.status === 403
        ? `check ${PROVIDER_META.sandbox.credentialEnv} (see ${PROVIDER_META.sandbox.dashboardUrl})`
        : undefined;
    throw new PiPodError(`${what} failed: ${error.message}`, {
      hint: error.hint ?? authHint,
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof PiPodError) throw error;
  throw new PiPodError(`${what} failed: ${describeError(error)}`, { cause: error });
}

function mapWsError(error: unknown, what: string): never {
  if (error instanceof SandboxWsError) {
    throw new PiPodError(`${what} failed: ${error.message}`, { cause: error });
  }
  return mapApiError(error, what);
}

export class SandboxServiceProvider implements SandboxProvider {
  readonly name = "sandbox";
  readonly capabilities = SANDBOX_CAPABILITIES;
  readonly credentialEnvNames = [PROVIDER_META.sandbox.credentialEnv] as const;
  readonly keepaliveApiHost: string;

  private readonly config: SandboxProviderConfig;
  private readonly token: string | null;

  constructor(providerConfig: Record<string, unknown> = {}, private readonly hostAuth?: { runtimeToken: string; hostedToken?: string }) {
    this.token = hostAuth?.runtimeToken ?? process.env[PROVIDER_META.sandbox.credentialEnv] ?? null;
    this.config = readProviderConfig(providerConfig);
    this.keepaliveApiHost = new URL(this.config.url).hostname;
  }

  keepaliveScript(
    sandboxId: string,
    options: { piCommand: string; idleTimeoutMinutes: number },
  ): string {
    return buildSandboxKeepaliveScript(this.config.url, sandboxId, options);
  }

  private client(): SandboxClient {
    if (!this.token) {
      throw new PiPodError("no sandbox service token found", {
        hint: `export ${PROVIDER_META.sandbox.credentialEnv}=<token> in your shell`,
      });
    }
    return new SandboxClient(this.config.url, this.token, { hostedToken: this.hostAuth?.hostedToken });
  }

  async checkAuth(): Promise<void> {
    try {
      await this.client().json<AuthzResponse>("GET", "/v1/authz");
    } catch (error) {
      mapApiError(error, "sandbox service authentication");
    }
  }

  async resourceMaximums(env?: { POD_ALLOW_8GIB_MEMORY?: unknown }): Promise<Partial<{ cpu: number; memoryGB: number; diskGB: number }>> {
    // Gated 8-GiB path (§7.4): the static local maximum stays the 4-GiB standard.
    // Only an explicit POD_ALLOW_8GIB_MEMORY=true deployment advertises 8 — and
    // planning refuses >4 GiB outright while the gate is off, so no caller can
    // silently clamp an advertised 8-GiB request down to 4. The flag rides the
    // explicit env argument (boot snapshot on server paths); ambient is the
    // CLI/test fallback. (Not a credential race: this flag is never overlaid
    // by the provider credential chain — explicitness here is consistency.)
    const allow8GiB =
      env?.POD_ALLOW_8GIB_MEMORY === true ||
      env?.POD_ALLOW_8GIB_MEMORY === "true" ||
      (env === undefined && process.env["POD_ALLOW_8GIB_MEMORY"] === "true");
    // Disk has no provider-wide maximum: the deployment ceiling (POD_MAX_DISK_GB, or the
    // owned-boat ceiling) bounds the request, and each host refuses a disk above its own
    // PI_POD_SANDBOX_MAX_DISK_GB as unsupported_shape. A fixed 20 here silently undid an
    // operator's raised ceiling.
    if (allow8GiB) {
      return { cpu: 2, memoryGB: 8 };
    }
    return { cpu: SANDBOX_RESOURCE_MAXIMUMS.cpu, memoryGB: SANDBOX_RESOURCE_MAXIMUMS.memoryGB };
  }

  private imageRef(ref: string): string {
    return isSandboxMirrorRef(ref) ? sandboxMirrorRef(ref, this.config.imageMirror) : ref;
  }


  async fetchMirroredImage(ref: string, onLog?: (line: string) => void): Promise<void> {
    const mirrored = sandboxMirrorRef(ref, this.config.imageMirror);
    onLog?.(`pulling ${mirrored} into the sandbox image cache`);
    try {
      await this.client().json<ImageInfoWire>(
        "POST",
        "/v1/images",
        { ref: mirrored } satisfies ImagePullRequest,
      );
      onLog?.(`pulled ${mirrored}`);
    } catch (error) {
      const authFailure =
        (error instanceof SandboxApiError && (error.status === 401 || error.status === 403)) ||
        /(?:401|403|unauthorized|authentication required|access denied)/i.test(
          error instanceof Error ? error.message : String(error),
        );
      if (authFailure) {
        throw new PiPodError(
          `fetching mirrored sandbox image "${ref}" failed: the image mirror is private and ` +
            "this deployment must preload the tag during rollout",
          {
            hint:
              "run the deployment workflow; its short-lived packages:read token preloads the exact " +
              "ghcr.io/pi-pod/pi-pod-base:<tag> into every sandbox host",
            ...(error instanceof SandboxApiError ? { status: error.status } : {}),
            cause: error,
          },
        );
      }
      mapApiError(error, `fetching mirrored sandbox image "${ref}"`);
    }
  }

  async resolveImage(ref: string): Promise<ImageInfo | null> {
    const providerRef = this.imageRef(ref);
    try {
      const found = await this.client().json<ImageInfoWire>(
        "GET",
        `/v1/images/${encodeURIComponent(providerRef)}`,
      );
      return {
        ref,
        ...(found.state === undefined ? {} : { state: found.state }),
        ...(found.createdAt === undefined ? {} : { createdAt: found.createdAt }),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      return mapApiError(error, `looking up sandbox image "${ref}"`);
    }
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    // The master token never enters a sandbox: it is withheld from the create request, and
    // once the service has named the sandbox, the per-sandbox activity token takes its
    // place in the base env (the id does not exist before create, so this takes two calls).
    const credentialEnv = PROVIDER_META.sandbox.credentialEnv;
    const carriesCredential = spec.env?.[credentialEnv] !== undefined;
    const createEnv = carriesCredential
      ? Object.fromEntries(Object.entries(spec.env!).filter(([name]) => name !== credentialEnv))
      : spec.env;
    const request: CreateSandboxRequest = {
      image: this.imageRef(spec.image),
      workdir: spec.workdir,
      ...(spec.resources === undefined ? {} : { resources: spec.resources }),
      env: createEnv,
      labels: spec.labels,
      archiveAfterMinutes: spec.archiveAfterMinutes,
      idleTimeoutMinutes: spec.idleTimeoutMinutes,
      egress: spec.egress,
      // Immutable tenant owner (§7.2): from the trusted launch context, never
      // labels. Omitted keeps the legacy unowned flat cgroup layout.
      ...(spec.owner === undefined ? {} : { owner: spec.owner }),
      ...(spec.operationKey === undefined ? {} : { operationKey: spec.operationKey }),
    };
    try {
      // With a stable operation key the host joins identical retries and reports
      // conflicts (409) instead of duplicating sandboxes; without one (legacy
      // callers) the create is exactly as idempotent as it always was.
      const created =
        spec.operationKey === undefined
          ? await this.client().json<SandboxInfoWire>("POST", "/v1/sandboxes", request)
          : await this.client().createWithOperation<SandboxInfoWire>("/v1/sandboxes", request, spec.operationKey);
      const activityToken = deriveSandboxActivityToken(this.token!, created.id);
      if (carriesCredential) {
        await this.client().json<SandboxInfoWire>(
          "POST",
          `/v1/sandboxes/${encodeURIComponent(created.id)}/start`,
          { env: { ...spec.env, [credentialEnv]: activityToken } } satisfies StartRequest,
        );
      }
      return new SandboxServiceAdapter(created.id, this.client(), activityToken, spec.env);
    } catch (error) {
      return mapApiError(error, "creating a sandbox");
    }
  }

  async list(labels: Record<string, string>): Promise<SandboxInfo[]> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(labels)) query.append(`label.${key}`, value);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    try {
      const page = await this.client().json<ListResponse>("GET", `/v1/sandboxes${suffix}`);
      return page.sandboxes.map(mapInfo);
    } catch (error) {
      return mapApiError(error, "listing sandboxes");
    }
  }

  async get(id: string): Promise<Sandbox | null> {
    try {
      await this.client().json<SandboxInfoWire>("GET", `/v1/sandboxes/${encodeURIComponent(id)}`);
      return new SandboxServiceAdapter(id, this.client(), deriveSandboxActivityToken(this.token!, id));
    } catch (error) {
      if (isNotFound(error)) return null;
      return mapApiError(error, `looking up sandbox ${id}`);
    }
  }

  async archiveById(id: string, timeoutMs: number): Promise<void> {
    try {
      await this.client().json<void>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(id)}/archive`,
        { timeoutMs },
      );
    } catch (error) {
      mapApiError(error, `archiving sandbox ${id}`);
    }
  }

  async deleteById(id: string): Promise<void> {
    try {
      await this.client().json<void>("DELETE", `/v1/sandboxes/${encodeURIComponent(id)}`);
    } catch (error) {
      if (isNotFound(error)) return;
      mapApiError(error, `deleting sandbox ${id}`);
    }
  }
}

export class SandboxServiceAdapter implements Sandbox {
  readonly id: string;
  private baseEnv: Record<string, string>;
  private hasRehydratedEnv: boolean;

  constructor(
    id: string,
    private readonly client: SandboxClient,
    private readonly activityToken: string,
    env?: Record<string, string>,
  ) {
    this.id = id;
    this.baseEnv = { ...(env ?? {}) };
    this.hasRehydratedEnv = env !== undefined;
  }

  /**
   * Every env map that leaves for the service passes through here: the host-side recipe
   * carries the master token (preflight injects it for the keepalive), and the sandbox must
   * only ever see its derived activity token.
   */
  private scopeEnv(env: Record<string, string>): Record<string, string> {
    if (env[PROVIDER_META.sandbox.credentialEnv] === undefined) return env;
    return { ...env, [PROVIDER_META.sandbox.credentialEnv]: this.activityToken };
  }

  async state(): Promise<SandboxState> {
    try {
      const found = await this.client.json<SandboxInfoWire>(
        "GET",
        `/v1/sandboxes/${encodeURIComponent(this.id)}`,
      );
      return found.state;
    } catch (error) {
      if (isNotFound(error)) return "gone";
      return mapApiError(error, `reading sandbox ${this.id} state`);
    }
  }

  async waitUntilStarted(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    for (;;) {
      const state = await this.state();
      if (state === "started") return;
      if (state === "error" || state === "gone" || state === "archived") {
        throw new PiPodError(`sandbox ${this.id} cannot start (state: ${state})`);
      }
      if (Date.now() >= deadline) {
        throw new PiPodError(
          `sandbox ${this.id} did not reach the started state within ${timeoutMs}ms (state: ${state})`,
        );
      }
      await delay(Math.min(1_000, Math.max(1, deadline - Date.now())));
    }
  }

  async start(timeoutMs: number): Promise<void> {
    const body: StartRequest = {
      timeoutMs,
      ...(this.hasRehydratedEnv ? { env: this.scopeEnv({ ...this.baseEnv }) } : {}),
    };
    try {
      await this.client.json<void>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(this.id)}/start`,
        body,
      );
      await this.waitUntilStarted(timeoutMs);
    } catch (error) {
      if (error instanceof PiPodError && !(error.cause instanceof SandboxApiError)) throw error;
      mapApiError(error, `starting sandbox ${this.id}`);
    }
  }

  rehydrateEnv(env: Record<string, string>): void {
    this.baseEnv = { ...env };
    this.hasRehydratedEnv = true;
  }

  async exec(argv: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    let socket: WebSocket;
    try {
      socket = await this.client.websocket(`/v1/sandboxes/${encodeURIComponent(this.id)}/exec`);
    } catch (error) {
      return mapApiError(error, `running a command in sandbox ${this.id}`);
    }

    return new Promise<ExecResult>((resolve, reject) => {
      const output: Buffer[] = [];
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        socket.close();
        try {
          mapWsError(error, `running a command in sandbox ${this.id}`);
        } catch (mapped) {
          reject(mapped);
        }
      };
      socket.on("message", (data, isBinary) => {
        try {
          if (isBinary) {
            const frame = rawBuffer(data);
            const payload = frame.subarray(1);
            if (frame[0] === STREAM_STDOUT) opts.onStdout?.(payload);
            else if (frame[0] === STREAM_STDERR) opts.onStderr?.(payload);
            else throw new SandboxWsError("bad_stream", `unknown stream tag ${String(frame[0])}`);
            output.push(Buffer.from(payload));
            return;
          }
          const frame = JSON.parse(data.toString()) as ExecServerFrame;
          if (frame.type === "error") {
            fail(new SandboxWsError(frame.code, frame.message));
          } else if (frame.type === "started") {
            socket.send(JSON.stringify({ type: "stdin-eof" } satisfies ExecClientFrame));
          } else if (frame.type === "exit" && !settled) {
            settled = true;
            socket.close();
            resolve({ exitCode: frame.exitCode, output: Buffer.concat(output).toString("utf8") });
          }
        } catch (error) {
          fail(error);
        }
      });
      socket.once("error", fail);
      socket.once("close", () => {
        if (!settled) fail(new SandboxWsError("connection_closed", "exec channel closed before exit"));
      });
      const start: ExecClientFrame = {
        type: "start",
        argv,
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        env: this.scopeEnv({ ...this.baseEnv, ...(opts.env ?? {}) }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      };
      socket.send(JSON.stringify(start));
    });
  }

  async uploadFile(destPath: string, contents: Uint8Array, mode?: number): Promise<void> {
    const path = filePath(this.id, destPath, mode);
    try {
      await this.client.upload(path, contents);
    } catch (error) {
      mapApiError(error, `uploading to ${destPath}`);
    }
  }

  async uploadLocalFile(
    sourcePath: string,
    destPath: string,
    opts: { mode?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    const stream = createReadStream(sourcePath, opts.signal ? { signal: opts.signal } : {});
    try {
      await this.client.upload(
        filePath(this.id, destPath, opts.mode),
        this.client.stream(stream),
        opts.signal,
      );
    } catch (error) {
      stream.destroy();
      mapApiError(error, `uploading ${sourcePath} to ${destPath}`);
    }
  }

  async downloadFile(sourcePath: string): Promise<Uint8Array> {
    try {
      return await this.client.bytes(filePath(this.id, sourcePath));
    } catch (error) {
      return mapApiError(error, `downloading ${sourcePath}`);
    }
  }

  async openPty(opts: PtyOpenOpts): Promise<PtySession> {
    const frame: PtyClientFrame = {
      type: "open",
      argv: opts.argv,
      cols: opts.cols,
      rows: opts.rows,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      env: this.scopeEnv({ ...this.baseEnv, ...(opts.env ?? {}) }),
    };
    try {
      const connected = await connectPty(this.client, this.id, frame);
      return new SandboxPtySession(this.client, this.id, connected);
    } catch (error) {
      return mapWsError(error, `opening a PTY in sandbox ${this.id}`);
    }
  }

  async reconnectPty(
    sessionId: string,
    opts: { cols: number; rows: number },
  ): Promise<PtySession | null> {
    try {
      const connected = await connectPty(this.client, this.id, {
        type: "attach",
        sessionId,
        cols: opts.cols,
        rows: opts.rows,
      });
      return new SandboxPtySession(this.client, this.id, connected);
    } catch (error) {
      if (error instanceof SandboxWsError && error.code === ERR_NO_SESSION) return null;
      return mapWsError(error, `rejoining PTY ${sessionId}`);
    }
  }

  async setLabels(labels: Record<string, string>): Promise<void> {
    const body: LabelsRequest = { labels };
    try {
      await this.client.json<void>(
        "PUT",
        `/v1/sandboxes/${encodeURIComponent(this.id)}/labels`,
        body,
      );
    } catch (error) {
      mapApiError(error, `labelling sandbox ${this.id}`);
    }
  }

  async stop(timeoutMs: number): Promise<void> {
    const body: StopRequest = { timeoutMs };
    try {
      await this.client.json<void>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(this.id)}/stop`,
        body,
      );
    } catch (error) {
      if (isNotFound(error)) return;
      mapApiError(error, `stopping sandbox ${this.id}`);
    }
  }

  async applyRetention(opts: { archiveAfterMinutes: number }): Promise<boolean> {
    const body: RetentionRequest = { archiveAfterMinutes: opts.archiveAfterMinutes };
    try {
      const result = await this.client.json<RetentionResponse>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(this.id)}/retention`,
        body,
      );
      return result.changed;
    } catch (error) {
      return mapApiError(error, `updating retention for sandbox ${this.id}`);
    }
  }

  async archive(timeoutMs: number): Promise<void> {
    try {
      await this.client.json<void>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(this.id)}/archive`,
        { timeoutMs },
      );
    } catch (error) {
      mapApiError(error, `archiving sandbox ${this.id}`);
    }
  }

  async archiveIfStopped(opts: {
    timeoutMs: number;
    expectedRevision?: number;
    expectedStoppedAt?: string;
  }): Promise<{ archived: boolean; outcome: string }> {
    // Both guards are HOST-ISSUED (fetched via GET sandbox): expectedRevision is the host's
    // transition revision, never a server-side row id or pod_retention.revision (different
    // domains), and expectedStoppedAt is the host's authoritative stoppedAt, never the
    // server clock. A mismatch is a 200 revision_mismatch, not an error: re-read and decide.
    const body: ArchiveIfStoppedRequest = {
      ...(opts.expectedRevision === undefined ? {} : { expectedRevision: opts.expectedRevision }),
      ...(opts.expectedStoppedAt === undefined ? {} : { expectedStoppedAt: opts.expectedStoppedAt }),
    };
    try {
      const result = await this.client.json<ArchiveIfStoppedResponse>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(this.id)}/archive-if-stopped`,
        { ...body, timeoutMs: opts.timeoutMs },
      );
      return { archived: result.archived, outcome: result.outcome };
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (status === 404 || status === 405) {
        throw new PiPodError("sandbox host predates archive-if-stopped; use the safe re-read fallback", {
          hint: "archive_unsupported",
          status: 501,
        });
      }
      return mapApiError(error, `conditionally archiving sandbox ${this.id}`);
    }
  }

  /** Host-issued description: state plus conditional-archive guards where supported. */
  async fetchInfo(): Promise<SandboxInfoWire> {
    try {
      return await this.client.json<SandboxInfoWire>(
        "GET",
        `/v1/sandboxes/${encodeURIComponent(this.id)}`,
      );
    } catch (error) {
      return mapApiError(error, `reading sandbox ${this.id} info`);
    }
  }

  async refreshActivity(): Promise<void> {
    try {
      await this.client.json<void>(
        "POST",
        `/v1/sandboxes/${encodeURIComponent(this.id)}/activity`,
      );
    } catch (error) {
      mapApiError(error, `refreshing activity for sandbox ${this.id}`);
    }
  }

  async delete(): Promise<void> {
    try {
      await this.client.json<void>("DELETE", `/v1/sandboxes/${encodeURIComponent(this.id)}`);
    } catch (error) {
      if (isNotFound(error)) return;
      mapApiError(error, `deleting sandbox ${this.id}`);
    }
  }
}

interface ConnectedPty {
  socket: WebSocket;
  sessionId: string;
  pending: Uint8Array[];
  cols: number;
  rows: number;
}

async function connectPty(
  client: SandboxClient,
  sandboxId: string,
  request: Extract<PtyClientFrame, { type: "open" | "attach" }>,
): Promise<ConnectedPty> {
  const socket = await client.websocket(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/pty`);
  return new Promise<ConnectedPty>((resolve, reject) => {
    const pending: Uint8Array[] = [];
    let settled = false;
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close();
      reject(error);
    };
    const onMessage = (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary) {
          // A PTY is one stream in each direction, so its frames carry no stream tag.
          pending.push(Buffer.from(rawBuffer(data)));
          return;
        }
        const frame = JSON.parse(data.toString()) as PtyServerFrame;
        if (frame.type === "error") {
          fail(new SandboxWsError(frame.code, frame.message));
        } else if (frame.type === "ready" && !settled) {
          settled = true;
          cleanup();
          resolve({
            socket,
            sessionId: frame.sessionId,
            pending,
            cols: request.cols,
            rows: request.rows,
          });
        } else if (frame.type === "exit") {
          fail(new SandboxWsError("session_exited", `PTY exited before attach (${frame.exitCode ?? "unknown"})`));
        }
      } catch (error) {
        fail(error);
      }
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new SandboxWsError("connection_closed", "PTY channel closed before ready"));
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.send(JSON.stringify(request));
  });
}

class SandboxPtySession implements PtySession {
  readonly id: string;
  private socket: WebSocket;
  private readonly dataCallbacks: Array<(data: Uint8Array) => void> = [];
  private pendingData: Uint8Array[];
  private readonly exitCallbacks: Array<(code: number | null) => void> = [];
  private exitCode: number | null | undefined;
  private closed = false;
  private cols: number;
  private rows: number;

  constructor(
    private readonly client: SandboxClient,
    private readonly sandboxId: string,
    connected: ConnectedPty,
  ) {
    this.id = connected.sessionId;
    this.socket = connected.socket;
    this.pendingData = connected.pending;
    this.cols = connected.cols;
    this.rows = connected.rows;
    this.bind(connected.socket);
  }

  write(data: Uint8Array): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    // Untagged, like the output direction: a PTY is one stream, and a stream byte here would
    // arrive at the terminal as a keystroke.
    for (const chunk of chunkPtyInput(data)) this.socket.send(Buffer.from(chunk));
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "resize", cols, rows } satisfies PtyClientFrame));
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCallbacks.push(cb);
    if (this.pendingData.length > 0) {
      const pending = this.pendingData;
      this.pendingData = [];
      for (const chunk of pending) cb(chunk);
    }
  }

  onExit(cb: (code: number | null) => void): void {
    this.exitCallbacks.push(cb);
    if (this.exitCode !== undefined) cb(this.exitCode);
  }

  async reattach(): Promise<void> {
    const connected = await connectPty(this.client, this.sandboxId, {
      type: "attach",
      sessionId: this.id,
      cols: this.cols,
      rows: this.rows,
    });
    const previous = this.socket;
    this.socket = connected.socket;
    this.pendingData.push(...connected.pending);
    this.exitCode = undefined;
    this.closed = false;
    this.bind(connected.socket);
    previous.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "detach" } satisfies PtyClientFrame));
    }
    this.socket.close();
  }

  private bind(socket: WebSocket): void {
    socket.on("message", (data, isBinary) => {
      if (this.socket !== socket) return;
      try {
        if (isBinary) {
          this.emitData(Buffer.from(rawBuffer(data)));
          return;
        }
        const frame = JSON.parse(data.toString()) as PtyServerFrame;
        if (frame.type === "exit") this.emitExit(frame.exitCode);
        else if (frame.type === "error") this.emitExit(null);
      } catch {
        this.emitExit(null);
      }
    });
    socket.on("error", () => {
      if (this.socket === socket && !this.closed) this.emitExit(null);
    });
    socket.on("close", () => {
      if (this.socket === socket && !this.closed) this.emitExit(null);
    });
  }

  private emitData(data: Uint8Array): void {
    if (this.closed) return;
    if (this.dataCallbacks.length === 0) {
      this.pendingData.push(data);
      return;
    }
    for (const cb of this.dataCallbacks) cb(data);
  }

  private emitExit(code: number | null): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    for (const cb of this.exitCallbacks) cb(code);
  }
}

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function filePath(sandboxId: string, path: string, mode?: number): string {
  const query = new URLSearchParams({ path });
  if (mode !== undefined) query.set("mode", mode.toString(8));
  return `/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?${query.toString()}`;
}

export function buildSandboxKeepaliveScript(
  apiUrl: string,
  sandboxId: string,
  options: { piCommand: string; idleTimeoutMinutes: number },
): string {
  if (new URL(apiUrl).searchParams.has("_token")) {
    throw new PiPodError("hosted sandbox keepalive requires a separate internal runtime URL", {
      code: "sandbox_internal_url_required",
    });
  }
  return buildWatcherScript({
    sandboxId,
    ...options,
    credentialEnvName: PROVIDER_META.sandbox.credentialEnv,
    providerSource: `const API = ${JSON.stringify(apiUrl.replace(/\/+$/, ""))};

async function refresh() {
  const res = await fetch(API + "/v1/sandboxes/" + encodeURIComponent(SANDBOX) + "/activity", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
}`,
  });
}

export const createSandboxProvider = (
  providerConfig: Record<string, unknown> = {},
): SandboxProvider => new SandboxServiceProvider(providerConfig);
