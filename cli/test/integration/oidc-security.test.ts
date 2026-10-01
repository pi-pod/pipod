import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { AccountClient } from "../../src/account/api.js";
import {
  clearOidcCache,
  discover,
  exchangeCode,
  ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
  OIDC_NETWORK_TIMEOUT_MS,
  organizationScope,
  refreshTokens,
  type OidcMetadata,
} from "../../src/account/oidc.js";
import { readAccountAuth, writeAccountAuth, type AccountAuth } from "../../src/account/store.js";
import { isolateHome } from "../support/repo-fixture.js";

const clientId = "pipod-cli";

function metadata(issuer: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/v2/authorize`,
    token_endpoint: `${issuer}/oauth/v2/token`,
    jwks_uri: `${issuer}/oauth/v2/keys`,
    end_session_endpoint: `${issuer}/oidc/v1/end_session`,
    revocation_endpoint: `${issuer}/oauth/v2/revoke`,
    ...overrides,
  };
}

describe("ID token verification and refresh rotation", () => {
  const HOME = isolateHome();
  let server: http.Server;
  let origin = "";
  let issuer = "";
  let privateKey: KeyLike;
  let invalidPrivateKey: KeyLike;
  let jwk: Record<string, unknown>;
  let tokenResponder: (params: URLSearchParams) => Promise<Record<string, unknown>>;
  let refreshCalls = 0;
  let failureReplacement: AccountAuth | null = null;

  const auth = (overrides: Partial<AccountAuth> = {}): AccountAuth => ({
    serverUrl: origin,
    accessToken: "access-old",
    refreshToken: "refresh-old",
    idToken: "id-old",
    issuer,
    clientId,
    user: { id: "subject-1", email: "dev@example.com" },
    orgId: "org-1",
    ...overrides,
  });

  async function idToken(args: {
    nonce?: string;
    accessToken?: string;
    key?: KeyLike;
    atHash?: string;
    omitSubject?: boolean;
  } = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {};
    if (args.nonce !== undefined) claims.nonce = args.nonce;
    if (args.atHash !== undefined) claims.at_hash = args.atHash;
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 120);
    if (!args.omitSubject) jwt = jwt.setSubject("subject-1");
    return jwt.sign(args.key ?? privateKey);
  }

  function oidcMeta(): OidcMetadata {
    return metadata(issuer) as unknown as OidcMetadata;
  }

  before(async () => {
    const valid = await generateKeyPair("RS256");
    const invalid = await generateKeyPair("RS256");
    privateKey = valid.privateKey;
    invalidPrivateKey = invalid.privateKey;
    jwk = { ...(await exportJWK(valid.publicKey)), kid: "test-key", use: "sig", alg: "RS256" };

    server = http.createServer(async (req, res) => {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/.well-known/openid-configuration") {
        return json(res, 200, metadata(issuer));
      }
      if (requestUrl.pathname === "/oauth/v2/keys") {
        return json(res, 200, { keys: [jwk] });
      }
      if (requestUrl.pathname === "/oauth/v2/token") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (params.get("grant_type") === "refresh_token") refreshCalls += 1;
        if (failureReplacement) {
          writeAccountAuth(failureReplacement, HOME.home);
          failureReplacement = null;
          return json(res, 400, { error: "invalid_grant" });
        }
        return json(res, 200, await tokenResponder(params));
      }
      if (requestUrl.pathname === "/v1/probe") {
        const bearer = req.headers.authorization?.replace(/^Bearer /, "");
        return bearer === "access-new"
          ? json(res, 200, { ok: true })
          : json(res, 401, { error: "expired" });
      }
      return json(res, 404, { error: "not found" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    origin = `http://127.0.0.1:${address.port}`;
    issuer = `${origin}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    HOME.restore();
  });

  afterEach(() => {
    refreshCalls = 0;
    failureReplacement = null;
    clearOidcCache();
    fs.rmSync(path.join(HOME.home, ".pi-pod"), { recursive: true, force: true });
  });

  it("requires a valid signed code-exchange ID token and matching nonce", async () => {
    const run = (nonce: string) => exchangeCode(oidcMeta(), {
      clientId,
      code: "code",
      verifier: "verifier",
      redirectUri: "http://127.0.0.1/callback",
      nonce,
    });

    tokenResponder = async () => ({ access_token: "access-new" });
    await assert.rejects(run("nonce"), /no ID token/);

    tokenResponder = async () => ({ access_token: "access-new", id_token: await idToken({ nonce: "nonce", key: invalidPrivateKey }) });
    await assert.rejects(run("nonce"), /invalid ID token/);

    tokenResponder = async () => ({ access_token: "access-new", id_token: await idToken({ nonce: "wrong" }) });
    await assert.rejects(run("nonce"), /invalid ID token/);

    tokenResponder = async () => ({ access_token: "access-new", id_token: await idToken({ nonce: "nonce" }) });
    assert.equal((await run("nonce")).accessToken, "access-new");
  });

  it("accepts an omitted refresh ID token and verifies every returned one", async () => {
    tokenResponder = async () => ({ access_token: "access-new" });
    assert.equal(
      (await refreshTokens(oidcMeta(), { clientId, refreshToken: "refresh-old" })).idToken,
      undefined,
    );

    tokenResponder = async () => ({ access_token: "access-new", id_token: await idToken({ omitSubject: true }) });
    await assert.rejects(refreshTokens(oidcMeta(), { clientId, refreshToken: "refresh-old" }), /session has expired/);

    tokenResponder = async () => ({ access_token: "access-new", id_token: await idToken({ atHash: "wrong" }) });
    await assert.rejects(refreshTokens(oidcMeta(), { clientId, refreshToken: "refresh-old" }), /session has expired/);

    tokenResponder = async () => ({
      access_token: "access-new",
      refresh_token: "refresh-new",
      id_token: await idToken(),
    });
    assert.equal((await refreshTokens(oidcMeta(), { clientId, refreshToken: "refresh-old" })).refreshToken, "refresh-new");
  });

  it("serializes concurrent AccountClient instances and adopts the rotated disk session", async () => {
    const initial = auth();
    writeAccountAuth(initial, HOME.home);
    tokenResponder = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        access_token: "access-new",
        refresh_token: "refresh-new",
        id_token: await idToken(),
      };
    };
    const first = new AccountClient(initial, { home: HOME.home });
    const second = new AccountClient(initial, { home: HOME.home });

    assert.deepEqual(await Promise.all([first.request("/probe"), second.request("/probe")]), [{ ok: true }, { ok: true }]);
    assert.equal(refreshCalls, 1, "the old rotating refresh token is used exactly once");
    assert.equal(readAccountAuth(HOME.home)?.refreshToken, "refresh-new");
    assert.equal(fs.existsSync(`${path.join(HOME.home, ".pi-pod", "auth.json")}.lock`), false);
  });

  it("re-reads once after refresh failure and adopts a concurrently changed session", async () => {
    const initial = auth();
    writeAccountAuth(initial, HOME.home);
    failureReplacement = auth({ accessToken: "access-new", refreshToken: "refresh-new", idToken: await idToken() });
    tokenResponder = async () => ({ error: "unused" });

    assert.deepEqual(await new AccountClient(initial, { home: HOME.home }).request("/probe"), { ok: true });
    assert.equal(refreshCalls, 1);
    assert.equal(readAccountAuth(HOME.home)?.refreshToken, "refresh-new");
  });
});

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
