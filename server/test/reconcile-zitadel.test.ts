import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "zitadel/scripts/reconcile-zitadel.mjs");

type JsonObject = Record<string, any>;
type DiscoveryMode = "normal" | "redirect" | "cross-origin";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

class MockZitadel {
  readonly requests: Array<{ method: string; path: string }> = [];
  readonly mutations: Array<{ method: string; path: string }> = [];
  discoveryMode: DiscoveryMode = "normal";
  origin = "";
  projects: JsonObject[] = [
    {
      id: "project-pipod",
      name: "pipod",
      projectRoleAssertion: false,
      projectRoleCheck: false,
      hasProjectCheck: false,
      unrelatedProjectField: "keep",
    },
  ];
  roles: JsonObject[] = [
    { key: "pods:launch", displayName: "pods:launch", group: "permission" },
    { key: "legacy:role", displayName: "kept for a retired client", group: "legacy" },
  ];
  apps: JsonObject[] = [
    {
      id: "app-cli",
      name: "pipod-cli",
      oidcConfig: {
        clientId: "111111@pipod",
        redirectUris: ["http://127.0.0.1:9999/callback"],
        responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
        grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
        appType: "OIDC_APP_TYPE_NATIVE",
        authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
        accessTokenType: "OIDC_TOKEN_TYPE_BEARER",
        accessTokenRoleAssertion: false,
        idTokenRoleAssertion: false,
        idTokenUserinfoAssertion: false,
        devMode: true,
        unrelatedAppField: "keep",
      },
    },
    {
      id: "app-ios",
      name: "pipod-ios",
      oidcConfig: {
        clientId: "222222@pipod",
        redirectUris: ["pipod-old://callback"],
        appType: "OIDC_APP_TYPE_NATIVE",
        untouched: "yes",
      },
    },
  ];
  private nextId = 1;
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

    if (!url.pathname.startsWith("/management/v1/")) {
      this.empty(response, 404);
      return;
    }
    const managementPath = url.pathname.slice("/management/v1".length);
    // _search endpoints are POST-shaped reads, not mutations.
    if (method !== "GET" && !managementPath.endsWith("/_search")) {
      this.mutations.push({ method, path: managementPath });
    }

    if (managementPath === "/projects/_search" && method === "POST") {
      const body = await this.jsonBody(request);
      const name = body.queries?.[0]?.nameQuery?.name;
      this.json(response, 200, {
        result: this.projects.filter((project) => !name || project.name === name),
      });
      return;
    }
    if (managementPath === "/projects" && method === "POST") {
      const body = await this.jsonBody(request);
      this.projects.push({ ...body, id: `project-created-${this.nextId++}` });
      this.json(response, 200, { id: this.projects[this.projects.length - 1]?.id });
      return;
    }
    const projectUpdate = managementPath.match(/^\/projects\/([^/]+)$/);
    if (projectUpdate && method === "PUT") {
      const id = decodeURIComponent(projectUpdate[1] ?? "");
      const index = this.projects.findIndex((project) => project.id === id);
      assert.notEqual(index, -1);
      this.projects[index] = { ...this.projects[index], ...(await this.jsonBody(request)) };
      this.json(response, 200, {});
      return;
    }

    const roleSearch = managementPath.match(/^\/projects\/([^/]+)\/roles\/_search$/);
    if (roleSearch && method === "POST") {
      this.json(response, 200, { result: this.roles });
      return;
    }
    const roleCreate = managementPath.match(/^\/projects\/([^/]+)\/roles$/);
    if (roleCreate && method === "POST") {
      const body = await this.jsonBody(request);
      this.roles.push({ key: body.roleKey, displayName: body.displayName, group: body.group });
      this.json(response, 200, {});
      return;
    }

    const appSearch = managementPath.match(/^\/projects\/([^/]+)\/apps\/_search$/);
    if (appSearch && method === "POST") {
      this.json(response, 200, { result: this.apps });
      return;
    }
    const appCreate = managementPath.match(/^\/projects\/([^/]+)\/apps\/oidc$/);
    if (appCreate && method === "POST") {
      const { name, ...oidc } = await this.jsonBody(request);
      const id = `app-created-${this.nextId++}`;
      this.apps.push({ id, name, oidcConfig: { ...oidc, clientId: `${this.nextId}00000@pipod` } });
      this.json(response, 200, { appId: id });
      return;
    }
    const appConfigUpdate = managementPath.match(/^\/projects\/([^/]+)\/apps\/([^/]+)\/oidc_config$/);
    if (appConfigUpdate && method === "PUT") {
      const appId = decodeURIComponent(appConfigUpdate[2] ?? "");
      const index = this.apps.findIndex((app) => app.id === appId);
      assert.notEqual(index, -1);
      const incoming = await this.jsonBody(request);
      this.apps[index] = {
        ...this.apps[index],
        oidcConfig: { ...this.apps[index]?.oidcConfig, ...incoming },
      };
      this.json(response, 200, {});
      return;
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

function runReconciler(mock: MockZitadel, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ZITADEL_EXPECTED_ISSUER: mock.origin,
        ZITADEL_PROJECT: "pipod",
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

function app(mock: MockZitadel, name: string): JsonObject {
  const result = mock.apps.find((candidate) => candidate.name === name);
  assert.ok(result, `missing mock app ${name}`);
  return result;
}

describe("production-safe Zitadel project reconciler", () => {
  const mock = new MockZitadel();
  let legacySnapshot = "";

  before(async () => {
    await mock.start();
    legacySnapshot = JSON.stringify(app(mock, "pipod-ios"));
  });

  after(async () => {
    await mock.stop();
  });

  it("rejects redirecting and cross-origin discovery before authentication", async () => {
    for (const mode of ["redirect", "cross-origin"] as const) {
      mock.discoveryMode = mode;
      const beforeMutations = mock.mutations.length;
      const result = await runReconciler(mock, ["--check"]);
      assert.equal(result.code, 1);
      assert.equal(mock.mutations.length, beforeMutations);
      assert.match(result.stderr, mode === "redirect" ? /redirects are forbidden/ : /cross-origin/);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /test-pat/);
    }
    mock.discoveryMode = "normal";
  });

  it("checks drift without mutation, applies it, and makes a second apply a no-op", async () => {
    const initialMutationCount = mock.mutations.length;
    const check = await runReconciler(mock, []);
    assert.equal(check.code, 2);
    assert.match(check.stderr, /project drift/);
    assert.equal(mock.mutations.length, initialMutationCount, "default mode must be read-only");

    const apply = await runReconciler(mock, ["--apply"]);
    assert.equal(apply.code, 0, apply.stderr);
    assert.match(apply.stdout, /auth contract is reconciled \(apply\)/);
    assert.match(apply.stdout, /project id \(API audience\): project-pipod/);
    assert.ok(mock.mutations.length > initialMutationCount);

    const project = mock.projects.find((row) => row.name === "pipod");
    assert.equal(project?.projectRoleAssertion, true);
    assert.equal(project?.unrelatedProjectField, "keep", "unmanaged project fields must survive");
    assert.equal(JSON.stringify(app(mock, "pipod-ios")), legacySnapshot, "legacy app must be untouched");
    assert.ok(mock.roles.some((role) => role.key === "legacy:role"), "unmanaged roles must survive");

    const contract = JSON.parse(
      fs.readFileSync(path.join(root, "zitadel/project/pipod-project.json"), "utf8"),
    ) as { roles: Array<{ key: string }>; apps: Array<{ name: string; accessTokenType: string }> };
    const roleKeys = new Set(mock.roles.map((role) => role.key));
    for (const role of contract.roles) assert.ok(roleKeys.has(role.key), `missing role ${role.key}`);
    for (const desired of contract.apps) {
      const created = app(mock, desired.name);
      assert.equal(created.oidcConfig.accessTokenType, "OIDC_TOKEN_TYPE_JWT", desired.name);
      assert.equal(created.oidcConfig.accessTokenRoleAssertion, true, desired.name);
    }
    const cli = app(mock, "pipod-cli");
    assert.equal(cli.oidcConfig.unrelatedAppField, "keep", "unmanaged app config must survive");
    assert.equal(cli.oidcConfig.devMode, false);
    assert.equal(cli.oidcConfig.redirectUris.length, 10);

    const afterFirstApply = mock.mutations.length;
    const secondApply = await runReconciler(mock, ["--apply"]);
    assert.equal(secondApply.code, 0, secondApply.stderr);
    assert.equal(mock.mutations.length, afterFirstApply, "second apply must produce no mutations");
    assert.doesNotMatch(
      `${apply.stdout}${apply.stderr}${secondApply.stdout}${secondApply.stderr}`,
      /test-pat/,
    );
    assert.equal(mock.requests.some((request) => request.method === "DELETE"), false);
  });

  it("contains no removal operation and labels destructive bootstrap usage", () => {
    const source = fs.readFileSync(script, "utf8");
    const bootstrap = fs.readFileSync(path.join(root, "zitadel/scripts/bootstrap-zitadel.mjs"), "utf8");
    assert.doesNotMatch(source, /["']DELETE["']/);
    assert.match(source, /--check/);
    assert.match(source, /--apply/);
    assert.match(source, /ZITADEL_EXPECTED_ISSUER/);
    assert.match(bootstrap, /DESTRUCTIVE FRESH-PROJECT \/ DISASTER-RECOVERY TOOL ONLY/);
    assert.match(bootstrap, /NEVER run it against production/);
    assert.match(bootstrap, /reconcile-zitadel\.mjs --apply/);
  });
});
