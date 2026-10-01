/**
 * Direct Zitadel OIDC for the CLI public client (the `pipod-cli` app).
 * Discovery is the runtime contract; authorization/token/end-session paths are never hardcoded.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { PiPodError } from "../errors.js";

export const DEFAULT_ISSUER = "https://auth.pipod.dev";
/** Zitadel generates client ids; ship the production `pipod-cli` id here after reconcile prints it. Override with PI_POD_OIDC_CLIENT_ID. */
export const DEFAULT_CLIENT_ID = "388199922844827655";
/** Zitadel reserved scopes: assert the resource-owner organization and project role claims. */
export const RESOURCE_OWNER_SCOPE = "urn:zitadel:iam:user:resourceowner";
export const PROJECT_ROLES_SCOPE = "urn:zitadel:iam:org:projects:roles";
/** Required for Zitadel to issue a refresh token (pipod-cli enables the refresh-token grant). */
export const OFFLINE_ACCESS_SCOPE = "offline_access";
export const OIDC_NETWORK_TIMEOUT_MS = 10_000;
export const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;
export const ORGANIZATION_ALIAS_MAX_LENGTH = 128;

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
  jwks_uri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}

const metadataCache = new Map<string, OidcMetadata>();
const idTokenJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function normalizeIssuer(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function parseSecureOidcUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PiPodError(`identity provider ${name} is not a valid URL`);
  }
  if (url.username || url.password || url.hash) {
    throw new PiPodError(`identity provider ${name} must not contain credentials or a fragment`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new PiPodError(`identity provider ${name} must use HTTPS except for loopback development`);
  }
  return url;
}

export function discoveryUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
}

export async function discover(issuer: string): Promise<OidcMetadata> {
  const key = normalizeIssuer(issuer);
  const issuerUrl = parseSecureOidcUrl(key, "issuer");
  if (issuerUrl.search) {
    throw new PiPodError("identity provider issuer must not contain a query string");
  }
  const cached = metadataCache.get(key);
  if (cached) return cached;

  const res = await fetch(discoveryUrl(key), {
    redirect: "error",
    signal: AbortSignal.timeout(OIDC_NETWORK_TIMEOUT_MS),
  }).catch((e) => {
    throw new PiPodError(`cannot reach the identity provider at ${key}`, {
      hint: String(e instanceof Error ? e.message : e),
    });
  });
  if (!res.ok) {
    throw new PiPodError(`identity provider discovery failed (HTTP ${res.status})`, {
      hint: `check PI_POD_ISSUER / --issuer (${key})`,
    });
  }

  let body: Partial<OidcMetadata>;
  try {
    body = (await res.json()) as Partial<OidcMetadata>;
  } catch {
    throw new PiPodError("identity provider discovery returned invalid JSON");
  }
  if (body.issuer !== key) {
    throw new PiPodError("identity provider discovery returned a different issuer", {
      hint: `expected ${key}, received ${String(body.issuer ?? "(missing)")}`,
    });
  }
  if (!body.authorization_endpoint || !body.token_endpoint || !body.jwks_uri) {
    throw new PiPodError("identity provider discovery document is missing required endpoints");
  }

  for (const [name, value] of Object.entries({
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
    end_session_endpoint: body.end_session_endpoint,
    revocation_endpoint: body.revocation_endpoint,
  })) {
    if (!value) continue;
    const endpoint = parseSecureOidcUrl(value, name);
    if (endpoint.origin !== issuerUrl.origin) {
      throw new PiPodError(`identity provider discovery returned a cross-origin ${name}`);
    }
  }

  const meta: OidcMetadata = {
    issuer: body.issuer,
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
    ...(body.end_session_endpoint ? { end_session_endpoint: body.end_session_endpoint } : {}),
    ...(body.revocation_endpoint ? { revocation_endpoint: body.revocation_endpoint } : {}),
  };
  metadataCache.set(key, meta);
  return meta;
}

export function clearOidcCache(): void {
  metadataCache.clear();
  idTokenJwksCache.clear();
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function createState(): string {
  return randomBytes(24).toString("base64url");
}

export function createNonce(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Organization selection scope. Without an alias, Zitadel resolves the user's own
 * organization (the resource owner). With one, login is restricted to the organization
 * whose primary domain matches.
 */
export function organizationScope(alias?: string): string {
  if (alias === undefined) return "";
  if (
    alias.length === 0 ||
    alias.length > ORGANIZATION_ALIAS_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)
  ) {
    throw new PiPodError("organization alias contains invalid characters");
  }
  return `urn:zitadel:iam:org:domain:primary:${alias}`;
}

export function authorizeUrl(
  meta: OidcMetadata,
  args: {
    clientId: string;
    redirectUri: string;
    challenge: string;
    state: string;
    nonce: string;
    orgAlias?: string;
  },
): string {
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  const scopes = ["openid", "profile", "email", OFFLINE_ACCESS_SCOPE, RESOURCE_OWNER_SCOPE, PROJECT_ROLES_SCOPE];
  const orgScope = organizationScope(args.orgAlias);
  if (orgScope) scopes.push(orgScope);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", args.state);
  url.searchParams.set("nonce", args.nonce);
  return url.toString();
}

async function readTokenResponse(res: Response): Promise<TokenSet> {
  if (!res.ok) {
    throw new PiPodError("the identity provider refused the token request", {
      hint: `HTTP ${res.status} — run \`pipod login\` again`,
    });
  }
  let body: { access_token?: string; refresh_token?: string; id_token?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new PiPodError("the identity provider returned an invalid token response");
  }
  if (!body.access_token) throw new PiPodError("the identity provider returned no access token");
  return {
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(body.id_token ? { idToken: body.id_token } : {}),
  };
}

export async function exchangeCode(
  meta: OidcMetadata,
  args: { clientId: string; code: string; verifier: string; redirectUri: string; nonce: string },
): Promise<TokenSet> {
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: args.clientId,
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri,
    }),
    signal: AbortSignal.timeout(OIDC_NETWORK_TIMEOUT_MS),
  }).catch((e) => {
    throw new PiPodError("cannot reach the identity provider token endpoint", {
      hint: String(e instanceof Error ? e.message : e),
    });
  });
  const tokens = await readTokenResponse(res);
  if (!tokens.idToken) throw new PiPodError("the identity provider returned no ID token");
  await verifyIdToken(meta, tokens.idToken, args.clientId, tokens.accessToken, args.nonce);
  return tokens;
}

async function verifyIdToken(
  meta: OidcMetadata,
  token: string,
  clientId: string,
  accessToken: string,
  expectedNonce?: string,
): Promise<void> {
  let jwks = idTokenJwksCache.get(meta.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(meta.jwks_uri), { timeoutDuration: OIDC_NETWORK_TIMEOUT_MS });
    idTokenJwksCache.set(meta.jwks_uri, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: meta.issuer,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "iat", "exp"],
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new Error("missing subject");
    if (
      typeof payload.iat !== "number" ||
      payload.iat > Math.floor(Date.now() / 1000) + ID_TOKEN_CLOCK_TOLERANCE_SECONDS
    ) {
      throw new Error("invalid issued-at time");
    }
    if (
      expectedNonce !== undefined &&
      (typeof payload.nonce !== "string" || !timingSafeEqualString(payload.nonce, expectedNonce))
    ) {
      throw new Error("nonce mismatch");
    }
    if (payload.at_hash !== undefined) {
      if (typeof payload.at_hash !== "string") throw new Error("invalid access-token hash");
      const expectedAtHash = createHash("sha256").update(accessToken).digest().subarray(0, 16).toString("base64url");
      if (!timingSafeEqualString(payload.at_hash, expectedAtHash)) throw new Error("access-token hash mismatch");
    }
  } catch {
    throw new PiPodError("the identity provider returned an invalid ID token", {
      hint: "run `pipod login` again",
    });
  }
}

export async function refreshTokens(
  meta: OidcMetadata,
  args: { clientId: string; refreshToken: string },
): Promise<TokenSet> {
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: args.clientId,
      refresh_token: args.refreshToken,
    }),
    signal: AbortSignal.timeout(OIDC_NETWORK_TIMEOUT_MS),
  }).catch(() => null);
  if (!res) throw new PiPodError("your pi pod server session has expired", { hint: "run `pipod login`" });
  try {
    const tokens = await readTokenResponse(res);
    if (tokens.idToken) {
      await verifyIdToken(meta, tokens.idToken, args.clientId, tokens.accessToken);
    }
    return tokens;
  } catch {
    throw new PiPodError("your pi pod server session has expired", { hint: "run `pipod login`" });
  }
}

export async function revokeToken(
  meta: OidcMetadata,
  args: { clientId: string; token: string; tokenTypeHint?: string },
): Promise<void> {
  if (!meta.revocation_endpoint) return;
  await fetch(meta.revocation_endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: args.clientId,
      token: args.token,
      ...(args.tokenTypeHint ? { token_type_hint: args.tokenTypeHint } : {}),
    }),
    signal: AbortSignal.timeout(OIDC_NETWORK_TIMEOUT_MS),
  }).catch(() => {});
}

export function endSessionUrl(
  meta: OidcMetadata,
  args: { idToken?: string; postLogoutRedirectUri?: string; clientId: string },
): string | null {
  if (!meta.end_session_endpoint) return null;
  const url = new URL(meta.end_session_endpoint);
  if (args.idToken) url.searchParams.set("id_token_hint", args.idToken);
  url.searchParams.set("client_id", args.clientId);
  if (args.postLogoutRedirectUri) url.searchParams.set("post_logout_redirect_uri", args.postLogoutRedirectUri);
  return url.toString();
}

export function accountConsoleUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}/ui/console/users/me`;
}

export function adminConsoleUrl(issuer: string): string {
  return `${normalizeIssuer(issuer)}/ui/console`;
}

export function timingSafeEqualString(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function organizationFromAccessToken(token: string): {
  id: string;
  alias: string;
  name: string | null;
  permissions: string[];
} | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const id = payload["urn:zitadel:iam:user:resourceowner:id"];
  if (typeof id !== "string" || !id) return null;
  const domain = payload["urn:zitadel:iam:user:resourceowner:primary_domain"];
  const name = payload["urn:zitadel:iam:user:resourceowner:name"];
  // Only role grants attributed to the token's own organization count as permissions.
  const permissions = new Set<string>();
  for (const [claim, container] of Object.entries(payload)) {
    const isRolesClaim =
      claim === "urn:zitadel:iam:org:project:roles" ||
      /^urn:zitadel:iam:org:project:[^:]+:roles$/.test(claim);
    if (!isRolesClaim || !container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const [role, grants] of Object.entries(container as Record<string, unknown>)) {
      if (!role || !grants || typeof grants !== "object" || Array.isArray(grants)) continue;
      if (Object.prototype.hasOwnProperty.call(grants, id)) permissions.add(role);
    }
  }
  return {
    id,
    alias: typeof domain === "string" && domain ? domain : id,
    name: typeof name === "string" && name ? name : null,
    permissions: [...permissions],
  };
}
