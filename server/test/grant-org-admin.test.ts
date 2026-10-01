import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "zitadel/scripts/grant-org-admin.mjs");

const ORG_ID = "org-tenant";
const OTHER_ORG_ID = "org-instance";
const USER_ID = "user-1";
const PROJECT_ID = "project-1";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Only the endpoints grant-org-admin.mjs reaches, in the shapes zitadel-admin.mjs reads. */
class MockZitadel {
  readonly mutations: Array<{ method: string; path: string }> = [];
  /** Organization the searched user belongs to — the token's resource owner. */
  userHomeOrg: string | null = ORG_ID;
  userFound = true;
  origin = "";
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
    if (request.headers.authorization !== "Bearer test-pat") {
      this.json(response, 401, {});
      return;
    }
    if (url.pathname === "/v2/organizations/_search") {
      this.json(response, 200, { result: [{ id: ORG_ID, name: "my-org" }] });
      return;
    }
    if (url.pathname === "/v2/users") {
      if (!this.userFound) {
        this.json(response, 200, { result: [] });
        return;
      }
      const details = this.userHomeOrg ? { details: { resourceOwner: this.userHomeOrg } } : {};
      this.json(response, 200, { result: [{ userId: USER_ID, ...details }] });
      return;
    }
    if (url.pathname === "/management/v1/projects/_search") {
      this.json(response, 200, { result: [{ id: PROJECT_ID, name: "pipod" }] });
      return;
    }
    if (url.pathname === "/management/v1/users/grants/_search") {
      this.json(response, 200, { result: [] });
      return;
    }
    if (method === "POST") {
      this.mutations.push({ method, path: url.pathname });
      this.json(response, 200, {});
      return;
    }
    this.json(response, 404, {});
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const value = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(value) });
    response.end(value);
  }
}

function runScript(mock: MockZitadel, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ZITADEL_URL: mock.origin,
        ZITADEL_PAT: "test-pat",
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

describe("grant-org-admin", () => {
  const mock = new MockZitadel();

  before(async () => {
    await mock.start();
  });

  after(async () => {
    await mock.stop();
  });

  beforeEach(() => {
    mock.mutations.length = 0;
    mock.userHomeOrg = ORG_ID;
    mock.userFound = true;
  });

  it("grants ORG_OWNER and the owner bundle to a user of that organization", async () => {
    const result = await runScript(mock, ["owner@my-org.example", "my-org"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ORG_OWNER on my-org \(org-tenant\)/);
    assert.match(result.stdout, /granted pipod roles: owner, /);
    assert.deepEqual(
      mock.mutations.map((m) => m.path),
      ["/management/v1/orgs/me/members", `/management/v1/users/${USER_ID}/grants`],
    );
  });

  it("refuses a user whose home organization is a different one, and grants nothing", async () => {
    mock.userHomeOrg = OTHER_ORG_ID;
    const result = await runScript(mock, ["admin@example.com", "my-org"]);
    assert.equal(result.code, 1);
    assert.equal(mock.mutations.length, 0);
    assert.match(result.stderr, /belongs to organization org-instance, not my-org \(org-tenant\)/);
    assert.match(result.stderr, /create the user inside my-org instead/);
  });

  it("reports a usage error without arguments", async () => {
    const result = await runScript(mock, []);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /usage: node grant-org-admin\.mjs/);
  });

  it("grants when the directory reports no home organization at all", async () => {
    mock.userHomeOrg = null;
    const result = await runScript(mock, ["owner@my-org.example", "my-org"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(mock.mutations.length, 2);
  });

  it("reports an unknown organization", async () => {
    const result = await runScript(mock, ["owner@my-org.example", "absent-org"]);
    assert.equal(result.code, 1);
    assert.equal(mock.mutations.length, 0);
    assert.match(result.stderr, /organization not found: absent-org/);
  });

  it("reports an unknown user", async () => {
    mock.userFound = false;
    const result = await runScript(mock, ["nobody@my-org.example", "my-org"]);
    assert.equal(result.code, 1);
    assert.equal(mock.mutations.length, 0);
    assert.match(result.stderr, /user not found: nobody@my-org\.example/);
  });
});
