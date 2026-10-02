// @ts-check
/**
 * Signing in to the identity provider this server names at /v1/auth/config, as the CLI does:
 * authorization code with PKCE for the public `pipod-dashboard` client. Tokens live in
 * sessionStorage, so they belong to this tab and end with it. The server verifies every access
 * token itself; this module only obtains and refreshes them.
 */

const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "urn:zitadel:iam:user:resourceowner",
  "urn:zitadel:iam:org:projects:roles",
].join(" ");
const SESSION_KEY = "pipod.dashboard.session";
const PENDING_KEY = "pipod.dashboard.pending";
/** Refresh this long before the access token expires, so a request never carries a dying one. */
const REFRESH_MARGIN_MS = 30_000;
export const CALLBACK_PATH = "/dashboard/callback";

/**
 * @typedef {object} Provider
 * @property {string} clientId
 * @property {string} authorizationEndpoint
 * @property {string} tokenEndpoint
 * @property {string | undefined} endSessionEndpoint
 * @property {string | undefined} revocationEndpoint
 * @property {string | undefined} serverUrl the non-loopback address sign-in may return to
 */

/**
 * @typedef {object} Session
 * @property {string} accessToken
 * @property {number} expiresAt epoch milliseconds
 * @property {string | undefined} refreshToken
 * @property {string | undefined} idToken
 */

/** A sign-in that cannot proceed; the message is meant for the person signing in. */
export class SignInError extends Error {}

/** @type {Promise<Provider> | null} */
let providerPromise = null;
/** @type {Promise<string | null> | null} */
let refreshing = null;

/** @returns {Promise<Provider>} */
function provider() {
  providerPromise ??= discover().catch((e) => {
    providerPromise = null;
    throw e;
  });
  return providerPromise;
}

/** @returns {Promise<Provider>} */
async function discover() {
  const config = await fetch("/v1/auth/config").then((res) => {
    if (!res.ok) throw new SignInError(`this server did not say where to sign in (HTTP ${res.status})`);
    return res.json();
  });
  if (!config.dashboardClientId) {
    throw new SignInError(
      "this server has no dashboard sign-in configured: set ZITADEL_DASHBOARD_CLIENT_ID " +
        "(selfhost/upgrade --apply-zitadel records it)",
    );
  }
  const issuer = String(config.issuer).replace(/\/+$/, "");
  const meta = await fetch(`${issuer}/.well-known/openid-configuration`).then((res) => {
    if (!res.ok) throw new SignInError(`the identity provider at ${issuer} is unreachable (HTTP ${res.status})`);
    return res.json();
  }).catch((e) => {
    throw e instanceof SignInError ? e : new SignInError(`the identity provider at ${issuer} is unreachable`);
  });
  if (meta.issuer !== issuer) throw new SignInError("the identity provider reported a different issuer");
  return {
    clientId: config.dashboardClientId,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    endSessionEndpoint: meta.end_session_endpoint,
    revocationEndpoint: meta.revocation_endpoint,
    serverUrl: config.serverUrl,
  };
}

/**
 * Why Zitadel would refuse to send a sign-in back to this page, or null when it will. It returns
 * one only to an address registered for the app: loopback on any port, or SERVER_URL. Refused,
 * it shows its own error page and never comes back here, so the check has to happen first.
 * @param {string | undefined} serverUrl
 */
function redirectProblem(serverUrl) {
  const host = location.hostname;
  if (host === "localhost" || host === "[::1]" || /^127\./.test(host) || location.origin === serverUrl) return null;
  if (location.protocol !== "https:") {
    return `sign-in can return to this page only over HTTPS or on 127.0.0.1, and it is open at ${location.origin}. ` +
      "Open http://127.0.0.1:8080/dashboard/ (through an SSH tunnel from another machine), or serve the server over HTTPS " +
      '(self-host guide, "Going public").';
  }
  return `sign-in returns only to ${serverUrl ?? "127.0.0.1"}, and this page is open at ${location.origin}. ` +
    `On the server, set SERVER_URL=${location.origin} in selfhost/.env and run selfhost/upgrade --apply-zitadel.`;
}

/** @param {Uint8Array} bytes */
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** @param {string} jwt */
function jwtPayload(jwt) {
  const part = jwt.split(".")[1] ?? "";
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
}

function redirectUri() {
  return `${location.origin}${CALLBACK_PATH}`;
}

/** @returns {Session | null} */
function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
  } catch {
    return null;
  }
}

/**
 * @param {Provider} p
 * @param {Record<string, string>} params
 * @param {Session | null} previous
 * @returns {Promise<Session>}
 */
async function requestTokens(p, params, previous) {
  const res = await fetch(p.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: p.clientId, ...params }),
  });
  if (!res.ok) throw new SignInError(`the identity provider refused the sign-in (HTTP ${res.status})`);
  const body = await res.json();
  if (!body.access_token) throw new SignInError("the identity provider returned no access token");
  const session = {
    accessToken: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in ?? 300) * 1000,
    // Zitadel rotates refresh tokens; keep the previous one only when no new one came back.
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    idToken: body.id_token ?? previous?.idToken,
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function signedIn() {
  return readSession() !== null;
}

/** Leaves for the identity provider; the page comes back at the callback with a code. */
export async function signIn() {
  const p = await provider();
  const problem = redirectProblem(p.serverUrl);
  if (problem) throw new SignInError(problem);
  const verifier = randomToken();
  const pending = { verifier, state: randomToken(), nonce: randomToken(), returnTo: location.hash };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const url = new URL(p.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: pending.state,
    nonce: pending.nonce,
  }).toString();
  location.assign(url.toString());
}

/**
 * Finishes a sign-in when this page is the callback, then moves the page back to where the
 * sign-in started. The code is single-use and bound to this tab's verifier and state.
 */
export async function completeSignIn() {
  if (location.pathname !== CALLBACK_PATH) return;
  const params = new URLSearchParams(location.search);
  /** @type {{verifier: string, state: string, nonce: string, returnTo: string} | null} */
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null");
  sessionStorage.removeItem(PENDING_KEY);
  history.replaceState(null, "", `/dashboard/${pending?.returnTo ?? ""}`);
  const error = params.get("error");
  if (error) throw new SignInError(`sign-in failed: ${params.get("error_description") ?? error}`);
  const code = params.get("code");
  if (!code || !pending || params.get("state") !== pending.state) {
    throw new SignInError("this sign-in did not start in this tab; sign in again");
  }
  const p = await provider();
  const session = await requestTokens(
    p,
    { grant_type: "authorization_code", code, code_verifier: pending.verifier, redirect_uri: redirectUri() },
    null,
  );
  // The ID token came straight from the token endpoint, so its nonce is what binds it here.
  if (!session.idToken || jwtPayload(session.idToken).nonce !== pending.nonce) {
    sessionStorage.removeItem(SESSION_KEY);
    throw new SignInError("the identity provider returned an ID token for another sign-in");
  }
}

/**
 * A fresh access token, or null once the session cannot be renewed. One refresh runs at a
 * time: a rotated refresh token is spent by the first request that uses it.
 */
export function refreshedAccessToken() {
  refreshing ??= (async () => {
    const session = readSession();
    if (!session?.refreshToken) return endSession();
    try {
      const p = await provider();
      const next = await requestTokens(p, { grant_type: "refresh_token", refresh_token: session.refreshToken }, session);
      return next.accessToken;
    } catch {
      return endSession();
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** The current access token, renewed first when it is about to expire; null when signed out. */
export async function accessToken() {
  const session = readSession();
  if (!session) return null;
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken;
  return refreshedAccessToken();
}

/** @returns {null} */
function endSession() {
  sessionStorage.removeItem(SESSION_KEY);
  return null;
}

/** Revokes the refresh token, forgets the session, and signs out at the identity provider. */
export async function signOut() {
  const session = readSession();
  endSession();
  const p = await provider().catch(() => null);
  if (!p) return location.assign("/dashboard/");
  if (session?.refreshToken && p.revocationEndpoint) {
    await fetch(p.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: p.clientId, token: session.refreshToken, token_type_hint: "refresh_token" }),
    }).catch(() => undefined);
  }
  if (!p.endSessionEndpoint) return location.assign("/dashboard/");
  const url = new URL(p.endSessionEndpoint);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    post_logout_redirect_uri: `${location.origin}/dashboard/`,
    ...(session?.idToken ? { id_token_hint: session.idToken } : {}),
  }).toString();
  location.assign(url.toString());
}
