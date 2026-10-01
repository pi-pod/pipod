import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { PiPodError } from "../src/core/errors.js";
import {
  DEFAULT_ARCHIVE_MAX_DELAY_DAYS,
  SANDBOX_CAPABILITIES,
  SANDBOX_RESOURCE_MAXIMUMS,
  createSandboxProvider,
  deriveSandboxActivityToken,
  sandboxMirrorRef,
} from "../src/core/providers/sandbox.js";
import { supportsImageMirror, type SandboxSpec } from "../src/core/providers/types.js";
import { STREAM_STDERR, STREAM_STDOUT } from "../src/core/providers/sandbox/wire.js";
import { EnvSchema } from "../src/server/env.js";
import { withPlatformProviderCredential } from "../src/server/pods/providercred.js";

const TOKEN = "sandbox-test-token-that-must-not-be-baked-in";

interface RecordedRequest {
  method: string;
  url: URL;
  authorization: string | undefined;
  body: unknown;
}

class SandboxStub {
  readonly requests: RecordedRequest[] = [];
  readonly execFrames: unknown[] = [];
  readonly server = createServer((request, response) => void this.route(request, response));
  readonly websockets = new WebSocketServer({ noServer: true });
  url = "";

  constructor() {
    this.server.on("upgrade", (request, socket, head) => {
      this.websockets.handleUpgrade(request, socket, head, (websocket) => {
        this.websockets.emit("connection", websocket, request);
      });
    });
    this.websockets.on("connection", (socket, request) => this.websocket(socket, request));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("stub server did not bind TCP");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const client of this.websockets.clients) client.terminate();
    await new Promise<void>((resolve) => this.websockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  reset(): void {
    this.requests.length = 0;
    this.execFrames.length = 0;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url);
    const body = await readBody(request);
    this.requests.push({
      method: request.method ?? "GET",
      url,
      authorization: request.headers.authorization,
      body:
        body.length === 0
          ? undefined
          : request.headers["content-type"] === "application/json"
            ? JSON.parse(body.toString("utf8"))
            : body,
    });

    if (url.pathname === "/v1/healthz") {
      return json(response, 200, {
        ok: true,
        version: "0.1.0",
        uptimeSeconds: 10,
        sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0 },
        host: {
          cpus: 4,
          memoryTotalBytes: 4 * 1024 ** 3,
          memoryAvailableBytes: 3 * 1024 ** 3,
          guaranteeCapacity: { cpu: 3.5, memoryBytes: 3 * 1024 ** 3 },
        },
      });
    }
    if (url.pathname === "/v1/authz") {
      return json(response, 200, { ok: true, runtime: "crun", archiveStore: "local" });
    }
    if (url.pathname === "/v1/images/broken") {
      return json(response, 429, {
        error: { code: "rate_limited", message: "too many image lookups", hint: "retry after a minute" },
      });
    }
    if (url.pathname.startsWith("/v1/images/")) {
      const ref = decodeURIComponent(url.pathname.slice("/v1/images/".length));
      if (ref === "missing") return json(response, 404, { error: { code: "not_found", message: "missing" } });
      return json(response, 200, { ref, state: "ready", createdAt: "2026-08-21T10:00:00.000Z" });
    }
    if (request.method === "POST" && url.pathname === "/v1/images") {
      const ref = (this.requests.at(-1)?.body as { ref: string }).ref;
      if (ref.includes("private-auth")) {
        return json(response, 401, {
          error: { code: "registry_auth_required", message: "registry authentication required" },
        });
      }
      return json(response, 201, { ref, state: "active", createdAt: "2026-08-21T10:00:00.000Z" });
    }
    if (request.method === "POST" && url.pathname === "/v1/sandboxes") {
      return json(response, 201, sandboxInfo("sandbox-1", (this.requests.at(-1)?.body as SandboxSpec).labels));
    }
    if (request.method === "GET" && url.pathname === "/v1/sandboxes") {
      return json(response, 200, { sandboxes: [sandboxInfo("sandbox-1", { project: "api" })] });
    }
    if (request.method === "GET" && url.pathname === "/v1/sandboxes/sandbox-1") {
      return json(response, 200, sandboxInfo("sandbox-1", { project: "api" }));
    }
    if (request.method === "GET" && url.pathname === "/v1/sandboxes/sandbox-stale-archive") {
      return json(response, 200, {
        ...sandboxInfo("sandbox-stale-archive", {}),
        state: "archived",
        tier: "archived",
      });
    }
    if (url.pathname.startsWith("/v1/sandboxes/sandbox-stale-archive/")) {
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/v1/sandboxes/sandbox-1/files") {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from("downloaded"));
        return;
      }
      response.writeHead(204).end();
      return;
    }
    if (url.pathname.startsWith("/v1/sandboxes/sandbox-1/")) {
      if (url.pathname.endsWith("/retention")) return json(response, 200, { changed: true });
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
  }

  private websocket(socket: WebSocket, request: IncomingMessage): void {
    const path = new URL(request.url ?? "/", this.url).pathname;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = JSON.parse(data.toString()) as { type: string; sessionId?: string };
      if (path.endsWith("/exec")) {
        this.execFrames.push(frame);
        if (frame.type === "start") {
          socket.send(JSON.stringify({ type: "started" }));
          socket.send(Buffer.concat([Buffer.from([STREAM_STDOUT]), Buffer.from("out")]));
          socket.send(Buffer.concat([Buffer.from([STREAM_STDERR]), Buffer.from("err")]));
        } else if (frame.type === "stdin-eof") {
          socket.send(JSON.stringify({ type: "exit", exitCode: 7 }));
        }
        return;
      }
      if (!path.endsWith("/pty")) return;
      if (frame.type === "attach" && frame.sessionId === "missing-session") {
        socket.send(JSON.stringify({
          type: "error",
          code: "no_such_session",
          message: "PTY session does not exist",
        }));
      } else if (frame.type === "attach" || frame.type === "open") {
        socket.send(JSON.stringify({
          type: "ready",
          sessionId: frame.sessionId ?? "pty-1",
          reattached: frame.type === "attach",
        }));
      }
    });
  }
}

function sandboxInfo(id: string, labels: Record<string, string>) {
  return {
    id,
    labels,
    state: "started",
    createdAt: "2026-08-21T10:00:00.000Z",
    lastActivityAt: "2026-08-21T11:00:00.000Z",
    image: "registry.example/pi:latest",
    workdir: "/workspace",
    tier: "hot",
    archiveAfterMinutes: 1_440,
    idleTimeoutMinutes: 15,
    resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 20 },
    ceiling: { cpu: 2, memoryGB: 4 },
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("self-hosted sandbox provider", () => {
  const stub = new SandboxStub();
  const originalToken = process.env.PI_POD_SANDBOX_TOKEN;
  const originalUrl = process.env.PI_POD_SANDBOX_URL;
  const originalMirror = process.env.PI_POD_SANDBOX_IMAGE_MIRROR;

  before(async () => {
    process.env.PI_POD_SANDBOX_TOKEN = TOKEN;
    process.env.PI_POD_SANDBOX_IMAGE_MIRROR = "ghcr.io/pi-pod";
    await stub.start();
  });

  beforeEach(() => stub.reset());

  after(async () => {
    if (originalToken === undefined) delete process.env.PI_POD_SANDBOX_TOKEN;
    else process.env.PI_POD_SANDBOX_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.PI_POD_SANDBOX_URL;
    else process.env.PI_POD_SANDBOX_URL = originalUrl;
    if (originalMirror === undefined) delete process.env.PI_POD_SANDBOX_IMAGE_MIRROR;
    else process.env.PI_POD_SANDBOX_IMAGE_MIRROR = originalMirror;
    await stub.stop();
  });

  it("defaults and validates the sandbox deployment settings in the startup snapshot", () => {
    const parsed = EnvSchema.parse({
      DATABASE_URL: "postgres://example.invalid/pipod",
      ZITADEL_ISSUER: "http://127.0.0.1:8081",
      SECRETS_KEK: randomBytes(32).toString("base64"),
      PI_POD_SANDBOX_TOKEN: TOKEN,
    });
    assert.equal(parsed.PI_POD_SANDBOX_TOKEN, TOKEN);
    assert.equal(parsed.PI_POD_SANDBOX_URL, "http://pi-pod-sandbox:8433");
    assert.equal(parsed.PI_POD_SANDBOX_IMAGE_MIRROR, "ghcr.io/pi-pod");
    assert.equal(
      EnvSchema.safeParse({
        DATABASE_URL: "postgres://example.invalid/pipod",
        ZITADEL_ISSUER: "http://127.0.0.1:8081",
        SECRETS_KEK: randomBytes(32).toString("base64"),
        PI_POD_SANDBOX_URL: "https://user:password@sandbox.example",
      }).success,
      false,
    );
    assert.equal(
      EnvSchema.safeParse({
        DATABASE_URL: "postgres://example.invalid/pipod",
        ZITADEL_ISSUER: "http://127.0.0.1:8081",
        SECRETS_KEK: randomBytes(32).toString("base64"),
        PI_POD_SANDBOX_IMAGE_MIRROR: "ghcr.io",
      }).success,
      false,
    );
  });

  it("uses the deployment URL by default and lets explicit provider config override it", () => {
    process.env.PI_POD_SANDBOX_URL = "https://deployment.example/service/";
    try {
      assert.equal(createSandboxProvider().keepaliveApiHost, "deployment.example");
      assert.equal(
        createSandboxProvider({ url: "https://override.example/api/" }).keepaliveApiHost,
        "override.example",
      );
    } finally {
      if (originalUrl === undefined) delete process.env.PI_POD_SANDBOX_URL;
      else process.env.PI_POD_SANDBOX_URL = originalUrl;
    }
  });

  it("gives an operator-directed error when neither URL source is present", () => {
    delete process.env.PI_POD_SANDBOX_URL;
    try {
      assert.throws(
        () => createSandboxProvider(),
        (error: unknown) =>
          error instanceof PiPodError &&
          error.message === "sandbox service URL is not configured" &&
          /set PI_POD_SANDBOX_URL/.test(error.hint ?? "") &&
          !/user config/.test(error.hint ?? ""),
      );
    } finally {
      if (originalUrl !== undefined) process.env.PI_POD_SANDBOX_URL = originalUrl;
    }
  });

  it("maps only managed base tags into the deployment mirror and materializes without auth", async () => {
    assert.equal(
      sandboxMirrorRef("pi-pod-base:r1-pi0.84.0-imgc730fa3798aa"),
      "ghcr.io/pi-pod/pi-pod-base:r1-pi0.84.0-imgc730fa3798aa",
    );
    assert.throws(
      () => sandboxMirrorRef("example.com/custom:latest"),
      /refuses non-managed ref/,
    );

    const provider = createSandboxProvider({ url: stub.url });
    assert.ok(supportsImageMirror(provider));
    const ref = "pi-pod-base:r1-test";
    assert.deepEqual(await provider.resolveImage(ref), {
      ref,
      state: "ready",
      createdAt: "2026-08-21T10:00:00.000Z",
    });
    const logs: string[] = [];
    await provider.fetchMirroredImage(ref, (line) => logs.push(line));
    await provider.create({
      image: ref,
      workdir: "/workspace",
      env: {},
      labels: {},
      archiveAfterMinutes: 60,
      idleTimeoutMinutes: 15,
      egress: { mode: "open" },
    });

    const mirrored = `ghcr.io/pi-pod/${ref}`;
    assert.equal(decodeURIComponent(stub.requests[0]!.url.pathname), `/v1/images/${mirrored}`);
    assert.deepEqual(stub.requests[1]?.body, { ref: mirrored });
    assert.equal(Object.hasOwn(stub.requests[1]!.body as object, "auth"), false);
    assert.equal((stub.requests[2]?.body as { image: string }).image, mirrored);
    assert.deepEqual(logs, [
      `pulling ${mirrored} into the sandbox image cache`,
      `pulled ${mirrored}`,
    ]);
  });

  it("explains that private mirror auth is supplied by deployment preloading", async () => {
    const provider = createSandboxProvider({ url: stub.url });
    assert.ok(supportsImageMirror(provider));
    await assert.rejects(
      provider.fetchMirroredImage("pi-pod-base:r1-private-auth"),
      (error: unknown) =>
        error instanceof PiPodError &&
        /mirror is private/.test(error.message) &&
        /deployment must preload/.test(error.message) &&
        /short-lived packages:read token/.test(error.hint ?? ""),
    );
  });

  it("captures the deployment URL independently from the credential swap", async () => {
    process.env.PI_POD_SANDBOX_URL = stub.url;
    try {
      await withPlatformProviderCredential({
        provider: "sandbox",
        credential: TOKEN,
        fn: async (provider) => {
          process.env.PI_POD_SANDBOX_URL = "https://changed-after-construction.invalid";
          await provider.checkAuth();
        },
      });
      assert.equal(stub.requests[0]?.url.origin, stub.url);
      assert.equal(stub.requests[0]?.authorization, `Bearer ${TOKEN}`);
    } finally {
      if (originalUrl === undefined) delete process.env.PI_POD_SANDBOX_URL;
      else process.env.PI_POD_SANDBOX_URL = originalUrl;
    }
  });

  it("reports the fixed native resource maximums without contacting the service", async () => {
    const provider = createSandboxProvider({ url: stub.url });
    assert.deepEqual(SANDBOX_RESOURCE_MAXIMUMS, { cpu: 2, memoryGB: 4, diskGB: 20 });
    assert.deepEqual(await provider.resourceMaximums?.(), { cpu: 2, memoryGB: 4, diskGB: 20 });
    assert.deepEqual(stub.requests, []);
  });

  it("declares the design's capability truth table", () => {
    assert.equal(DEFAULT_ARCHIVE_MAX_DELAY_DAYS, 30);
    assert.deepEqual(SANDBOX_CAPABILITIES, {
      serverSideArchive: true,
      archiveMaxDays: null,
      archiveTransition: { kind: "after-stop", maxDelayDays: 30 },
      framedSessionReconnect: true,
      reportsLastActivity: true,
      ptyReattach: true,
      secretEnv: true,
      environmentPersistence: "rehydrate",
      idleAutoStop: "configurable",
      resourceSizing: "per-sandbox",
      egressEnforcement: "cidr",
      egressAddressFamily: "ipv4",
      egressMaxEntries: null,
      workdirSurvivesStop: true,
    });
  });

  it("maps configured URLs, labels, and sandbox specs onto the wire API", async () => {
    const provider = createSandboxProvider({ url: `${stub.url}/` });
    assert.equal(provider.keepaliveApiHost, "127.0.0.1");
    assert.deepEqual(provider.credentialEnvNames, ["PI_POD_SANDBOX_TOKEN"]);

    const spec: SandboxSpec = {
      image: "registry.example/pi:latest",
      workdir: "/workspace/project",
      resources: { cpu: 2, memoryGB: 4, diskGB: 20 },
      env: { SECRET: "only-over-the-wire" },
      labels: { "pi-pod/managed-by": "pi-pod", project: "api" },
      archiveAfterMinutes: 1_440,
      idleTimeoutMinutes: 15,
      egress: { mode: "allowlist", hosts: ["192.0.2.0/24", "2001:db8::/32"] },
    };
    const sandbox = await provider.create(spec);
    await sandbox.setLabels({ project: "worker", ttl: "next" });
    const listed = await provider.list({ "pi-pod/managed-by": "pi-pod", project: "api" });

    assert.deepEqual(stub.requests[0], {
      method: "POST",
      url: new URL("/v1/sandboxes", stub.url),
      authorization: `Bearer ${TOKEN}`,
      body: spec,
    });
    assert.deepEqual(stub.requests[1]?.body, { labels: { project: "worker", ttl: "next" } });
    assert.equal(stub.requests[1]?.method, "PUT");
    assert.equal(stub.requests[1]?.url.pathname, "/v1/sandboxes/sandbox-1/labels");
    assert.deepEqual(
      Array.from(stub.requests[2]!.url.searchParams.entries()),
      [["label.pi-pod/managed-by", "pi-pod"], ["label.project", "api"]],
    );
    assert.deepEqual(listed, [{
      id: "sandbox-1",
      labels: { project: "api" },
      state: "started",
      createdAt: "2026-08-21T10:00:00.000Z",
      lastActivityAt: "2026-08-21T11:00:00.000Z",
    }]);
  });

  it("withholds the master token from the sandbox and swaps in a derived activity token", async () => {
    const provider = createSandboxProvider({ url: stub.url });
    const scoped = deriveSandboxActivityToken(TOKEN, "sandbox-1");
    assert.match(scoped, /^[0-9a-f]{64}$/);
    assert.notEqual(scoped, TOKEN);

    const sandbox = await provider.create({
      image: "registry.example/pi:latest",
      workdir: "/workspace",
      env: { SECRET: "s", PI_POD_SANDBOX_TOKEN: TOKEN },
      labels: {},
      archiveAfterMinutes: 60,
      idleTimeoutMinutes: 15,
      egress: { mode: "open" },
    });

    // The create request carries no credential at all; the follow-up start swaps in the
    // sandbox-scoped token once the id exists.
    assert.deepEqual((stub.requests[0]?.body as { env: object }).env, { SECRET: "s" });
    assert.equal(stub.requests[1]?.method, "POST");
    assert.equal(stub.requests[1]?.url.pathname, "/v1/sandboxes/sandbox-1/start");
    assert.deepEqual(stub.requests[1]?.body, {
      env: { SECRET: "s", PI_POD_SANDBOX_TOKEN: scoped },
    });

    // Exec env carrying the master (the keepalive restart path) is substituted too.
    await sandbox.exec(["true"], { env: { PI_POD_SANDBOX_TOKEN: TOKEN } });
    const frame = stub.execFrames[0] as { env: Record<string, string> };
    assert.equal(frame.env.PI_POD_SANDBOX_TOKEN, scoped);
    assert.equal(frame.env.SECRET, "s");

    // And so is a rehydrate + start on a re-fetched sandbox (reattach path).
    stub.reset();
    const refetched = await provider.get("sandbox-1");
    assert.ok(refetched);
    refetched.rehydrateEnv({ BASE: "x", PI_POD_SANDBOX_TOKEN: TOKEN });
    await refetched.start(1_000);
    assert.deepEqual(stub.requests[1]?.body, {
      timeoutMs: 1_000,
      env: { BASE: "x", PI_POD_SANDBOX_TOKEN: scoped },
    });
  });

  it("sends rehydrated env only in process/start memory paths and streams exec frames", async () => {
    const provider = createSandboxProvider({ url: stub.url });
    const sandbox = await provider.get("sandbox-1");
    assert.ok(sandbox);
    sandbox.rehydrateEnv({ BASE: "current", OVERRIDE: "base" });
    await sandbox.start(12_345);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await sandbox.exec(["pi", "--version"], {
      cwd: "/workspace",
      env: { OVERRIDE: "exec" },
      timeoutMs: 9_000,
      onStdout: (chunk) => stdout.push(Buffer.from(chunk).toString()),
      onStderr: (chunk) => stderr.push(Buffer.from(chunk).toString()),
    });

    assert.deepEqual(stub.requests[1]?.body, {
      timeoutMs: 12_345,
      env: { BASE: "current", OVERRIDE: "base" },
    });
    assert.deepEqual(stub.execFrames, [
      {
        type: "start",
        argv: ["pi", "--version"],
        cwd: "/workspace",
        env: { BASE: "current", OVERRIDE: "exec" },
        timeoutMs: 9_000,
      },
      { type: "stdin-eof" },
    ]);
    assert.deepEqual(stdout, ["out"]);
    assert.deepEqual(stderr, ["err"]);
    assert.deepEqual(result, { exitCode: 7, output: "outerr" });
  });

  it("fails fast when start leaves the sandbox archived", async () => {
    const provider = createSandboxProvider({ url: stub.url });
    const sandbox = await provider.get("sandbox-stale-archive");
    assert.ok(sandbox);
    const started = Date.now();
    await assert.rejects(
      sandbox.start(30_000),
      (error: unknown) => {
        assert.ok(error instanceof PiPodError);
        assert.match(error.message, /cannot start \(state: archived\)/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5_000, "must not wait out the start timeout on archived");
  });

  it("does not erase service-held env on a management start before rehydration", async () => {
    const provider = createSandboxProvider({ url: stub.url });
    const sandbox = await provider.get("sandbox-1");
    assert.ok(sandbox);
    await sandbox.start(30_000);
    assert.deepEqual(stub.requests[1]?.body, { timeoutMs: 30_000 });
  });

  it("streams file bytes and formats upload modes as octal", async () => {
    const provider = createSandboxProvider({ url: stub.url });
    const sandbox = await provider.get("sandbox-1");
    assert.ok(sandbox);
    await sandbox.uploadFile("/workspace/a b.txt", Buffer.from("payload"), 0o640);
    const upload = stub.requests[1];
    assert.equal(upload?.method, "PUT");
    assert.equal(upload?.url.pathname, "/v1/sandboxes/sandbox-1/files");
    assert.equal(upload?.url.searchParams.get("path"), "/workspace/a b.txt");
    assert.equal(upload?.url.searchParams.get("mode"), "640");
    assert.deepEqual(upload?.body, Buffer.from("payload"));
  });

  it("maps ErrorResponse status, message, and hint onto PiPodError", async () => {
    const provider = createSandboxProvider({ url: stub.url });
    await assert.rejects(
      provider.resolveImage("broken"),
      (error: unknown) => {
        assert.ok(error instanceof PiPodError);
        assert.equal(error.message, "looking up sandbox image \"broken\" failed: too many image lookups");
        assert.equal(error.status, 429);
        assert.equal(error.hint, "retry after a minute");
        return true;
      },
    );
    assert.equal(await provider.resolveImage("missing"), null);
  });

  it("returns null when PTY reattachment reports no_such_session", async () => {
    const provider = createSandboxProvider({ url: stub.url });
    const sandbox = await provider.get("sandbox-1");
    assert.ok(sandbox?.reconnectPty);
    assert.equal(
      await sandbox.reconnectPty("missing-session", { cols: 120, rows: 40 }),
      null,
    );
  });

  it("keeps the bearer value out of the generated keepalive file", () => {
    const provider = createSandboxProvider({ url: stub.url });
    const script = provider.keepaliveScript?.("sandbox-1", {
      piCommand: "pi",
      idleTimeoutMinutes: 15,
    });
    assert.ok(script);
    assert.match(script, /PI_POD_SANDBOX_TOKEN/);
    assert.match(script, /\/v1\/sandboxes\/.*\/activity/);
    assert.doesNotMatch(script, new RegExp(TOKEN));
  });
});
