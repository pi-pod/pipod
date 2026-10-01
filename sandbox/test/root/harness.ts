import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import WebSocket, { type RawData } from "ws";
import { buildServer } from "../../src/api/server.js";
import { createObjectStore } from "../../src/archive/objectstore.js";
import type { ObjectStore } from "../../src/archive/types.js";
import { loadConfig, type Config } from "../../src/config.js";
import { Manager, type ExecSpec } from "../../src/core/manager.js";
import { Store } from "../../src/db/index.js";
import { OciImageStore } from "../../src/images/store.js";
import { createLogger, type Logger } from "../../src/log.js";
import {
  Metrics,
  instrumentImageStore,
  instrumentObjectStore,
  instrumentRuntime,
} from "../../src/metrics.js";
import { CgroupTree } from "../../src/runtime/cgroup.js";
import { Runtime, findInitBinary } from "../../src/runtime/crun.js";
import { Network } from "../../src/runtime/netns.js";
import type { CreateSandboxRequest, ExecServerFrame, PtyServerFrame, SandboxInfoWire } from "../../src/wire.js";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");

export async function rootTestSkipReason(): Promise<string | null> {
  if (process.getuid?.() !== 0) return "root privileges are required";
  try {
    await execFileAsync("crun", ["--version"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "crun is not installed";
    throw error;
  }
  if (process.env.PI_POD_SANDBOX_NETWORK_TESTS !== "1") {
    return "PI_POD_SANDBOX_NETWORK_TESTS=1 is required";
  }
  return null;
}

async function ensureInitBinary(): Promise<void> {
  if (findInitBinary()) return;
  await execFileAsync(path.join(ROOT, "scripts", "build-init.sh"), { cwd: ROOT });
  if (!findInitBinary()) throw new Error("scripts/build-init.sh did not produce bin/pps-init");
}

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export interface ExecResult {
  exitCode?: number;
  stdout: Buffer;
  stderr: Buffer;
  streamTags: number[];
  controls: ExecServerFrame[];
  error?: Extract<ExecServerFrame, { type: "error" }>;
}

export class PtyChannel {
  readonly controls: PtyServerFrame[] = [];
  readonly chunks: Buffer[] = [];
  private version = 0;
  private readonly waiters = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      if (isBinary) this.chunks.push(rawBuffer(data));
      else this.controls.push(JSON.parse(rawBuffer(data).toString("utf8")) as PtyServerFrame);
      this.version += 1;
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    });
  }

  static async connect(url: string, token: string): Promise<PtyChannel> {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const channel = new PtyChannel(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return channel;
  }

  get output(): Buffer {
    return Buffer.concat(this.chunks);
  }

  sendControl(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  sendRaw(data: string | Buffer): void {
    this.socket.send(Buffer.isBuffer(data) ? data : Buffer.from(data), { binary: true });
  }

  async waitFor(predicate: (channel: PtyChannel) => boolean, description: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      const observed = this.version;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${description}; output=${JSON.stringify(this.output.toString("utf8"))}`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error(`timed out waiting for ${description}; output=${JSON.stringify(this.output.toString("utf8"))}`));
        }, remaining);
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.add(wake);
        if (this.version !== observed) {
          this.waiters.delete(wake);
          wake();
        }
      });
    }
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.close();
    await closed;
  }
}

export interface HarnessOptions {
  server?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class RootHarness {
  readonly token: string;
  readonly cfg: Config;
  readonly store: Store;
  readonly images: OciImageStore;
  readonly runtime: Runtime;
  readonly network: Network;
  readonly cgroups: CgroupTree;
  readonly objects: ObjectStore;
  readonly manager: Manager;
  readonly log: Logger;
  readonly metrics: Metrics;
  app?: FastifyInstance;
  baseUrl?: string;
  private cleaned = false;

  private constructor(
    readonly stateDir: string,
    readonly bridgeName: string,
    readonly cgroupScope: string,
    networkPrefix: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.token = randomBytes(24).toString("hex");
    this.cfg = loadConfig({
      ...process.env,
      PI_POD_SANDBOX_TOKEN: this.token,
      PI_POD_SANDBOX_STATE_DIR: stateDir,
      PI_POD_SANDBOX_HOST: "127.0.0.1",
      PI_POD_SANDBOX_BRIDGE_NAME: bridgeName,
      PI_POD_SANDBOX_BRIDGE_CIDR: env.PI_POD_SANDBOX_BRIDGE_CIDR,
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
      PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.01",
      PI_POD_SANDBOX_RESERVE_MEMORY_GB: "0",
      // Admission is ceiling-first (4 GiB per sandbox); busybox test sandboxes use a few MiB, so
      // the budget is a policy number here, not physical RAM. Suites that test admission set
      // their own smaller budget.
      PI_POD_SANDBOX_MEMORY_BUDGET_GB: "64",
      PI_POD_SANDBOX_RESERVE_CPU: "0",
      PI_POD_SANDBOX_DR_INTERVAL_MINUTES: "0",
      LOG_LEVEL: "fatal",
      ...env,
    });
    this.log = createLogger(this.cfg.logLevel);
    this.metrics = new Metrics({ version: "root-test" });
    this.store = new Store(this.cfg.paths.db);
    this.images = new OciImageStore({
      stateDir: this.cfg.stateDir,
      auth: this.cfg.registryAuth,
      log: (message) => this.log.debug({ images: message }, "image store"),
    });
    this.runtime = instrumentRuntime(new Runtime(this.cfg.runtime), this.metrics);
    this.network = new Network(this.cfg.bridge.name, this.cfg.bridge.cidr, this.cfg.dns, networkPrefix);
    this.cgroups = new CgroupTree(cgroupScope);
    this.objects = instrumentObjectStore(createObjectStore(this.cfg.archive), this.metrics);
    this.manager = new Manager(
      this.cfg,
      this.store,
      instrumentImageStore(this.images, this.metrics),
      this.runtime,
      this.network,
      this.cgroups,
      this.objects,
      this.log,
      this.metrics,
    );
  }

  static async create(options: HarnessOptions = {}): Promise<RootHarness> {
    await ensureInitBinary();
    const suffix = randomBytes(3).toString("hex");
    const second = 100 + (randomBytes(1)[0]! % 100);
    const third = 1 + (randomBytes(1)[0]! % 253);
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-pod-sandbox-root-"));
    const env = {
      PI_POD_SANDBOX_BRIDGE_CIDR: `10.${second}.${third}.0/24`,
      ...options.env,
    };
    const harness = new RootHarness(stateDir, `pt${suffix}`, `ppst${suffix}`, `t${suffix}`, env);
    try {
      await harness.manager.init();
      harness.metrics.bind({
        snapshot: () => ({
          ...harness.manager.metricsSnapshot(),
          hostPressure: harness.cgroups.hostPressure(),
          hostMemoryAvailableBytes: os.freemem(),
          hostMemoryTotalBytes: os.totalmem(),
        }),
      });
      if (options.server !== false) {
        harness.app = await buildServer({
          cfg: harness.cfg,
          manager: harness.manager,
          objects: harness.objects,
          log: harness.log,
          version: "root-test",
          runtimeName: await harness.runtime.version(),
          metrics: harness.metrics,
        });
        harness.baseUrl = await harness.app.listen({ host: "127.0.0.1", port: 0 });
      }
      return harness;
    } catch (error) {
      await harness.cleanup().catch(() => undefined);
      throw error;
    }
  }

  async pullBusybox(): Promise<void> {
    await this.images.pull("busybox:latest");
  }

  async createSandbox(overrides: Partial<CreateSandboxRequest> = {}): Promise<SandboxInfoWire> {
    return await this.manager.create({ image: "busybox:latest", workdir: "/workspace", ...overrides });
  }

  async request(pathname: string, init: RequestInit = {}, bearer: string | null = this.token): Promise<Response> {
    if (!this.baseUrl) throw new Error("harness has no HTTP server");
    const headers = new Headers(init.headers);
    if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
    return await fetch(`${this.baseUrl}${pathname}`, { ...init, headers });
  }

  async json(pathname: string, method: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return await this.request(pathname, init);
  }

  async exec(id: string, spec: ExecSpec): Promise<ExecResult> {
    if (!this.baseUrl) throw new Error("harness has no HTTP server");
    const url = `${this.baseUrl.replace(/^http/, "ws")}/v1/sandboxes/${id}/exec`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const streamTags: number[] = [];
    const controls: ExecServerFrame[] = [];

    return await new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`exec timed out: ${JSON.stringify(spec)}`)), 20_000);
      const finish = (error?: Error, result?: ExecResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      socket.once("open", () => socket.send(JSON.stringify({ type: "start", ...spec })));
      socket.on("message", (data, isBinary) => {
        const buffer = rawBuffer(data);
        if (isBinary) {
          const tag = buffer[0];
          if (tag === undefined) return;
          streamTags.push(tag);
          if (tag === 1) stdout.push(buffer.subarray(1));
          else if (tag === 2) stderr.push(buffer.subarray(1));
          return;
        }
        const frame = JSON.parse(buffer.toString("utf8")) as ExecServerFrame;
        controls.push(frame);
        if (frame.type === "exit") {
          finish(undefined, {
            exitCode: frame.exitCode,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            streamTags,
            controls,
          });
        } else if (frame.type === "error") {
          finish(undefined, {
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            streamTags,
            controls,
            error: frame,
          });
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", () => {
        if (!settled) finish(new Error("exec socket closed without an exit or error frame"));
      });
    });
  }

  async pty(id: string): Promise<PtyChannel> {
    if (!this.baseUrl) throw new Error("harness has no HTTP server");
    return await PtyChannel.connect(
      `${this.baseUrl.replace(/^http/, "ws")}/v1/sandboxes/${id}/pty`,
      this.token,
    );
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    const errors: unknown[] = [];
    for (const sandbox of this.manager.list({})) {
      try {
        await this.manager.delete(sandbox.id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.app) {
      try {
        await this.app.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.store.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.network.destroyServiceNetwork();
    } catch (error) {
      errors.push(error);
    }
    try {
      fs.rmdirSync(this.cgroups.scopeDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
    }
    try {
      await rm(this.stateDir, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "root harness cleanup failed");
  }
}
