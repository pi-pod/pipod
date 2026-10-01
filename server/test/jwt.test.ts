import assert from "node:assert/strict";
import * as http from "node:http";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { HttpError } from "../src/server/httperrors.js";
import {
  resetJwksCache,
  verifyAccessToken,
} from "../src/server/auth/jwt.js";
import type { ServerEnv } from "../src/server/env.js";

const audience = "pipod-api";
describe("verifyAccessToken", () => {
  const env = {
    ZITADEL_ISSUER: "http://127.0.0.1:8081",
    ZITADEL_API_AUDIENCE: audience,
  } as ServerEnv;

  it("names the issuer's host when the JWKS URL reaches Zitadel by another route", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "route-key", alg: "RS256", use: "sig" };
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers["x-forwarded-host"] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const sign = (issuer: string) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "route-key" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("subject-1")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const envFor = (issuer: string) =>
      ({
        ZITADEL_ISSUER: issuer,
        ZITADEL_API_AUDIENCE: audience,
        ZITADEL_JWKS_URL: `http://127.0.0.1:${address.port}/jwks`,
      }) as ServerEnv;
    try {
      // Zitadel picks the instance from the request host: an internal route must say whose
      // instance it is asking about.
      const internal = envFor("http://zitadel.example:8081");
      assert.equal((await verifyAccessToken(internal, await sign(internal.ZITADEL_ISSUER))).sub, "subject-1");
      assert.deepEqual(seen, ["zitadel.example:8081"]);
      resetJwksCache();
      const direct = envFor(`http://127.0.0.1:${address.port}`);
      assert.equal((await verifyAccessToken(direct, await sign(direct.ZITADEL_ISSUER))).sub, "subject-1");
      assert.deepEqual(seen, ["zitadel.example:8081", undefined]);
    } finally {
      resetJwksCache();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("accepts expiration within the 30-second clock tolerance and rejects beyond it", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "clock-key", alg: "RS256", use: "sig" };
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const clockEnv = {
      ZITADEL_ISSUER: "https://auth.example",
      ZITADEL_API_AUDIENCE: audience,
      ZITADEL_JWKS_URL: `http://127.0.0.1:${address.port}/jwks`,
    } as ServerEnv;
    const sign = (expiredSecondsAgo: number) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "clock-key" })
        .setIssuer(clockEnv.ZITADEL_ISSUER)
        .setAudience(audience)
        .setSubject("subject-1")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
        .setExpirationTime(Math.floor(Date.now() / 1000) - expiredSecondsAgo)
        .sign(privateKey);
    try {
      assert.equal((await verifyAccessToken(clockEnv, await sign(15))).sub, "subject-1");
      const tooOld = await sign(45);
      await assert.rejects(() => verifyAccessToken(clockEnv, tooOld), HttpError);
    } finally {
      resetJwksCache();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
