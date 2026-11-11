/**
 * The few calls this server makes to its identity provider on a person's behalf, with that
 * person's own tokens: who they are (userinfo), and renewing or ending a session the server holds
 * for a limited sign-in. Never an administrative call — the server holds no admin credential.
 */
import { jwksUrl, type ServerEnv } from "../env.js";

const TIMEOUT_MS = 10_000;

/**
 * Zitadel is reached by the same route as its signing keys, which may be an internal one
 * (`http://zitadel:8080` on a compose network). Zitadel picks its instance — and the issuer it
 * writes into tokens — from the request's host and protocol, so an internal route forwards the
 * issuer's (see jwt.ts).
 */
function providerEndpoint(env: ServerEnv, path: string): { url: URL; headers: Record<string, string> } {
  const route = new URL(jwksUrl(env));
  const issuer = new URL(env.ZITADEL_ISSUER);
  const headers: Record<string, string> =
    route.host === issuer.host
      ? {}
      : { "x-forwarded-host": issuer.host, "x-forwarded-proto": issuer.protocol.replace(/:$/, "") };
  return { url: new URL(path, route.origin), headers };
}

/** The email Zitadel's userinfo endpoint answers for this access token, or null. */
export async function userinfoEmail(env: ServerEnv, accessToken: string): Promise<string | null> {
  const { url, headers } = providerEndpoint(env, "/oidc/v1/userinfo");
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, ...headers },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { email?: unknown } | null;
  return typeof body?.email === "string" && body.email ? body.email : null;
}

export type SessionRenewal =
  | { kind: "renewed"; accessToken: string; refreshToken: string }
  /** The provider refused the refresh token: the session expired, was revoked, or its user is gone. */
  | { kind: "ended"; reason: string }
  /** No answer worth acting on (network, timeout, 5xx, 429): the session may still be good. */
  | { kind: "unavailable" };

/**
 * Renew a session the server holds, as the public client it was issued to. Zitadel rotates the
 * refresh token: the one passed in is spent once this succeeds.
 */
export async function renewSession(env: ServerEnv, clientId: string, refreshToken: string): Promise<SessionRenewal> {
  const { url, headers } = providerEndpoint(env, "/oauth/v2/token");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: "unavailable" };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) {
    const accessToken = body?.["access_token"];
    const next = body?.["refresh_token"];
    if (typeof accessToken !== "string" || !accessToken) return { kind: "unavailable" };
    // Zitadel always rotates; were it ever to answer without a new one, the old one still stands.
    return { kind: "renewed", accessToken, refreshToken: typeof next === "string" && next ? next : refreshToken };
  }
  if (res.status >= 500 || res.status === 429) return { kind: "unavailable" };
  const error = body?.["error"];
  return { kind: "ended", reason: typeof error === "string" && error ? error : `HTTP ${res.status}` };
}

/** Best effort: end a held session at the provider. Its own expiry ends it otherwise. */
export async function revokeSession(env: ServerEnv, clientId: string, refreshToken: string): Promise<void> {
  const { url, headers } = providerEndpoint(env, "/oauth/v2/revoke");
  await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ client_id: clientId, token: refreshToken, token_type_hint: "refresh_token" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
}
