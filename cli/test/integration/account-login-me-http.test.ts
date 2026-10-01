/**
 * A real `/v1/me` server: the status the account client attaches to a rejected
 * token or a server failure is a server's, not a simulated one.
 */
import { strict as assert } from "node:assert";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { runLogin } from "../../src/account/login.js";
import { readAccountAuth } from "../../src/account/store.js";
import { PiPodError } from "../../src/errors.js";
import { isolateHome } from "../support/repo-fixture.js";

describe("account login server failures", () => {
  const HOME = isolateHome("pi-pod-login-");
  const SAVED_ENV = ["PI_POD_ISSUER", "PI_POD_ACCOUNT_URL", "PI_POD_OIDC_CLIENT_ID"].map(
    (key) => [key, process.env[key]] as const,
  );

  before(() => {
    for (const [key] of SAVED_ENV) delete process.env[key];
  });

  after(() => {
    for (const [key, value] of SAVED_ENV) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    HOME.restore();
  });

  const ME_BODY = {
    user: { id: "user-1", email: "dev@example.com" },
    currentOrgId: "org-1",
    permissions: ["member"],
    organization: { id: "org-1", alias: "dev", name: "Dev Org" },
  };

  async function startMeServer(status: number): Promise<{ url: string; stop(): Promise<void> }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? ME_BODY : { error: "unauthorized" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("reports a server that rejects the freshly issued token instead of an expired session", async () => {
    const server = await startMeServer(401);
    try {
      await assert.rejects(
        runLogin({
          server: server.url,
          issuer: "https://auth.example.com",
          token: "tok",
          home: HOME.home,
        }),
        (e: unknown) => {
          assert.ok(e instanceof PiPodError);
          assert.equal(e.message, `${server.url} rejected the token issued by https://auth.example.com`);
          assert.doesNotMatch(e.message, /session has expired/);
          assert.match(e.hint ?? "", /check --issuer against the server's ZITADEL_ISSUER/);
          assert.match(e.hint ?? "", /ZITADEL_API_AUDIENCE on the server/);
          // Login keys on the status the account client now attaches to its 401.
          assert.equal((e.cause as PiPodError).status, 401);
          return true;
        },
      );
      assert.equal(readAccountAuth(HOME.home), null, "a rejected token stores nothing");
    } finally {
      await server.stop();
    }
  });

  it("passes other server failures through untouched", async () => {
    const server = await startMeServer(500);
    try {
      await assert.rejects(
        runLogin({
          server: server.url,
          issuer: "https://auth.example.com",
          token: "tok",
          home: HOME.home,
        }),
        (e: unknown) => {
          assert.ok(e instanceof PiPodError);
          assert.equal(e.status, 500);
          assert.doesNotMatch(e.message, /rejected the token/);
          return true;
        },
      );
    } finally {
      await server.stop();
    }
  });
});
