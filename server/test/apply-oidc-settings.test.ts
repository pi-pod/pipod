import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "zitadel/scripts/apply-oidc-settings.mjs");
const contractPath = path.join(root, "zitadel/oidc-settings.json");
const composePath = path.join(root, "docker-compose.yml");

type JsonObject = Record<string, any>;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

class MockZitadel {
  readonly requests: Array<{ method: string; path: string }> = [];
  readonly mutations: Array<{ method: string; path: string }> = [];
  discoveryMode: "normal" | "redirect" | "cross-origin" = "normal";
  origin = "";
  oidcSettings: JsonObject | null = {
    accessTokenLifetime: "12h0m0s",
    idTokenLifetime: "12h0m0s",
    refreshTokenIdleExpiration: "720h0m0s",
    refreshTokenExpiration: "2160h0m0s",
  };
  forbidOidc = false;
  readonly server = createServer((request, response) => void this.route(request, response));

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    assert.ok(address && typeof address === "object");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", this.origin);
    this.requests.push({ method, path: url.pathname });

    if (url.pathname === "/.well-known/openid-configuration") {
      if (this.discoveryMode === "redirect") {
        response.writeHead(302, { location: `${this.origin}/redirected` }).end();
        return;
      }
      const tokenOrigin = this.discoveryMode === "cross-origin" ? "https://attacker.invalid" : this.origin;
      this.json(response, 200, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/oauth/v2/authorize`,
        token_endpoint: `${tokenOrigin}/oauth/v2/token`,
        jwks_uri: `${this.origin}/oauth/v2/keys`,
      });
      return;
    }

    if (request.headers.authorization !== "Bearer test-pat") {
      this.empty(response, 401);
      return;
    }
    if (url.pathname === "/auth/v1/users/me" && method === "GET") {
      this.json(response, 200, { user: { id: "admin-service-user" } });
      return;
    }

    if (url.pathname === "/admin/v1/settings/oidc") {
      if (this.forbidOidc) {
        this.empty(response, 403);
        return;
      }
      if (method === "GET") {
        if (!this.oidcSettings) {
          this.empty(response, 404);
          return;
        }
        this.json(response, 200, { settings: this.oidcSettings });
        return;
      }
      if (method === "POST" || method === "PUT") {
        this.mutations.push({ method, path: url.pathname });
        this.oidcSettings = await this.jsonBody(request);
        this.json(response, 200, {});
        return;
      }
    }

    this.empty(response, 404);
  }

  private body(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let value = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        value += chunk;
      });
      request.on("end", () => resolve(value));
      request.on("error", reject);
    });
  }

  private async jsonBody(request: IncomingMessage): Promise<JsonObject> {
    return JSON.parse(await this.body(request)) as JsonObject;
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const value = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(value) });
    response.end(value);
  }

  private empty(response: ServerResponse, status: number): void {
    response.writeHead(status, { "content-length": "0" });
    response.end();
  }
}

function runScript(mock: MockZitadel, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ZITADEL_EXPECTED_ISSUER: mock.origin,
        ZITADEL_PAT: "test-pat",
        ZITADEL_HTTP_TIMEOUT_MS: "2000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("instance OIDC token lifetime contract", () => {
  const mock = new MockZitadel();

  before(async () => {
    await mock.start();
  });

  after(async () => {
    await mock.stop();
  });

  it("pins 5m access/id tokens and 30d/90d refresh windows", () => {
    const contract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as Record<string, string>;
    assert.equal(contract.accessTokenLifetime, "5m");
    assert.equal(contract.idTokenLifetime, "5m");
    assert.equal(contract.refreshTokenIdleExpiration, "720h");
    assert.equal(contract.refreshTokenExpiration, "2160h");
  });

  it("keeps local Compose first-boot env aligned with the contract", () => {
    const compose = fs.readFileSync(composePath, "utf8");
    const contract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as Record<string, string>;
    assert.match(compose, new RegExp(`ZITADEL_DEFAULTINSTANCE_OIDCSETTINGS_ACCESSTOKENLIFETIME:\\s*${contract.accessTokenLifetime}`));
    assert.match(compose, new RegExp(`ZITADEL_DEFAULTINSTANCE_OIDCSETTINGS_IDTOKENLIFETIME:\\s*${contract.idTokenLifetime}`));
    assert.match(
      compose,
      new RegExp(
        `ZITADEL_DEFAULTINSTANCE_OIDCSETTINGS_REFRESHTOKENIDLEEXPIRATION:\\s*${contract.refreshTokenIdleExpiration}`,
      ),
    );
    assert.match(
      compose,
      new RegExp(`ZITADEL_DEFAULTINSTANCE_OIDCSETTINGS_REFRESHTOKENEXPIRATION:\\s*${contract.refreshTokenExpiration}`),
    );
  });

  it("rejects redirecting and cross-origin discovery before authentication", async () => {
    for (const mode of ["redirect", "cross-origin"] as const) {
      mock.discoveryMode = mode;
      const beforeMutations = mock.mutations.length;
      const result = await runScript(mock, ["--check"]);
      assert.equal(result.code, 1);
      assert.equal(mock.mutations.length, beforeMutations);
      assert.match(result.stderr, mode === "redirect" ? /redirects are forbidden/ : /cross-origin/);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /test-pat/);
    }
    mock.discoveryMode = "normal";
  });

  it("names a missing iam.write grant instead of applying", async () => {
    mock.forbidOidc = true;
    const result = await runScript(mock, ["--apply"]);
    mock.forbidOidc = false;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /IAM_OWNER/);
    assert.equal(mock.mutations.length, 0);
  });

  it("checks drift without mutation, applies it, and makes a second apply a no-op", async () => {
    const initialMutationCount = mock.mutations.length;
    const check = await runScript(mock, []);
    assert.equal(check.code, 2);
    assert.match(check.stderr, /OIDC settings drift/);
    assert.equal(mock.mutations.length, initialMutationCount, "default mode must be read-only");

    const apply = await runScript(mock, ["--apply"]);
    assert.equal(apply.code, 0, apply.stderr);
    assert.match(apply.stdout, /instance OIDC token lifetimes are reconciled \(apply\)/);
    assert.equal(mock.oidcSettings?.accessTokenLifetime, "300s");
    assert.equal(mock.oidcSettings?.idTokenLifetime, "300s");
    assert.equal(mock.oidcSettings?.refreshTokenIdleExpiration, "2592000s");
    assert.equal(mock.oidcSettings?.refreshTokenExpiration, "7776000s");
    assert.ok(mock.mutations.length > initialMutationCount);

    const afterFirstApply = mock.mutations.length;
    const secondApply = await runScript(mock, ["--apply"]);
    assert.equal(secondApply.code, 0, secondApply.stderr);
    assert.equal(mock.mutations.length, afterFirstApply, "second apply must produce no mutations");
    assert.doesNotMatch(`${apply.stdout}${apply.stderr}${secondApply.stdout}${secondApply.stderr}`, /test-pat/);
    assert.equal(mock.requests.some((request) => request.method === "DELETE"), false);
  });

  it("creates settings when the instance has none", async () => {
    mock.oidcSettings = null;
    mock.mutations.length = 0;
    const apply = await runScript(mock, ["--apply"]);
    assert.equal(apply.code, 0, apply.stderr);
    assert.match(apply.stdout, /created instance OIDC settings/);
    assert.equal(mock.mutations[0]?.method, "POST");
    const created = mock.oidcSettings as JsonObject | null;
    assert.equal(created?.accessTokenLifetime, "300s");
  });

  it("contains no removal operation", () => {
    const source = fs.readFileSync(script, "utf8");
    assert.doesNotMatch(source, /["']DELETE["']/);
    assert.match(source, /ZITADEL_EXPECTED_ISSUER/);
    assert.match(source, /IAM_OWNER/);
  });
});
