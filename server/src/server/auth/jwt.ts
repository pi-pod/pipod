import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { jwksUrl, type ServerEnv } from "../env.js";
import { unauthorized } from "../httperrors.js";

export const JWT_CLOCK_TOLERANCE_SECONDS = 30;
const JWKS_TIMEOUT_MS = 10_000;

  /** Zitadel reserved claims asserted with the `urn:zitadel:iam:user:resourceowner` scope. */
  export const RESOURCE_OWNER_ID_CLAIM = "urn:zitadel:iam:user:resourceowner:id";
  export const RESOURCE_OWNER_NAME_CLAIM = "urn:zitadel:iam:user:resourceowner:name";
  export const RESOURCE_OWNER_DOMAIN_CLAIM = "urn:zitadel:iam:user:resourceowner:primary_domain";
  /** Generic project-role claim asserted when the project has role assertion enabled. */
  export const PROJECT_ROLES_CLAIM = "urn:zitadel:iam:org:project:roles";

  export function projectRolesClaim(projectId: string): string {
    return `urn:zitadel:iam:org:project:${projectId}:roles`;
  }

  export interface OrganizationClaims {
    /** Organization primary domain — the human-facing handle used at login. */
    alias: string;
    id: string;
    name: string | null;
    /** Roles the token's own organization granted on the `pipod` project. Never a cross-org union. */
    permissions: string[];
  }

  export interface AccessTokenClaims {
    sub: string;
    sessionId: string | null;
    email: string | null;
    displayName: string | null;
    organization: OrganizationClaims | null;
    issuer: string;
  }

  type Verifier = (token: string) => Promise<JWTPayload>;

  let verifier: Verifier | null = null;
  let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  let cachedJwksUrl: string | null = null;

  export function setTokenVerifier(fn: Verifier | null): void {
    verifier = fn;
  }

  export function resetJwksCache(): void {
    cachedJwks = null;
    cachedJwksUrl = null;
  }


  function audienceMatches(aud: unknown, expected: string): boolean {
    if (typeof aud === "string") return aud === expected;
    if (Array.isArray(aud)) return aud.some((value) => value === expected);
    return false;
  }

  /**
   * Zitadel picks the instance from the request's host, so a JWKS URL that reaches it by an
   * internal route — `http://zitadel:8080` over a compose network, a Kubernetes service name —
   * gets "Instance not found" and every token then fails with jose's opaque "Expected 200 OK
   * from the JSON Web Key Set HTTP response". `x-forwarded-host` is one of Zitadel's default
   * instance host headers, so naming the issuer's host restores the lookup. Nothing to forward
   * when the JWKS URL is already on the issuer's host, which is the default.
   */
  function jwksOptions(env: ServerEnv, url: string): { headers?: Record<string, string> } {
    const issuerHost = new URL(env.ZITADEL_ISSUER).host;
    if (new URL(url).host === issuerHost) return {};
    return { headers: { "x-forwarded-host": issuerHost } };
  }

  function remoteJwks(env: ServerEnv): ReturnType<typeof createRemoteJWKSet> {
    const url = jwksUrl(env);
    if (!cachedJwks || cachedJwksUrl !== url) {
      cachedJwks = createRemoteJWKSet(new URL(url), {
        timeoutDuration: JWKS_TIMEOUT_MS,
        ...jwksOptions(env, url),
      });
      cachedJwksUrl = url;
    }
    return cachedJwks;
  }

  function defaultVerifier(env: ServerEnv): Verifier {
    const jwks = remoteJwks(env);
    const issuer = env.ZITADEL_ISSUER;
    const audience = env.ZITADEL_API_AUDIENCE;
    return async (token) => {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience,
        algorithms: ["RS256"],
        clockTolerance: JWT_CLOCK_TOLERANCE_SECONDS,
      });
      return payload;
    };
  }

  /**
   * Roles granted specifically by `orgId`. A Zitadel role claim maps each role key to the
   * set of organizations that granted it (`{ "<role>": { "<orgId>": "<orgDomain>" } }`);
   * only grants attributed to the token's own resource-owner organization authorize, so
   * a cross-organization role union cannot widen access.
   */
  function rolesGrantedByOrg(payload: JWTPayload, audience: string, orgId: string): string[] {
    const roles = new Set<string>();
    for (const claim of [projectRolesClaim(audience), PROJECT_ROLES_CLAIM]) {
      const container = (payload as Record<string, unknown>)[claim];
      if (!container || typeof container !== "object" || Array.isArray(container)) continue;
      for (const [role, grants] of Object.entries(container as Record<string, unknown>)) {
        if (!role || !grants || typeof grants !== "object" || Array.isArray(grants)) continue;
        if (Object.prototype.hasOwnProperty.call(grants, orgId)) roles.add(role);
      }
    }
    return [...roles];
  }

  /**
   * Parse Zitadel's reserved resource-owner claims into the single organization this
   * token acts for. Permissions come only from role grants attributed to that
   * organization; top-level `permissions` / arbitrary role claims never authorize.
   */
  export function parseOrganizationClaim(
    payload: JWTPayload,
    audience: string,
  ): { organization: OrganizationClaims | null; error?: string } {
    if (!Object.prototype.hasOwnProperty.call(payload, RESOURCE_OWNER_ID_CLAIM)) {
      return { organization: null };
    }
    const id = (payload as Record<string, unknown>)[RESOURCE_OWNER_ID_CLAIM];
    if (id == null) return { organization: null };
    if (typeof id !== "string" || !id) {
      return { organization: null, error: "organization is missing an immutable id" };
    }
    const name = (payload as Record<string, unknown>)[RESOURCE_OWNER_NAME_CLAIM];
    const domain = (payload as Record<string, unknown>)[RESOURCE_OWNER_DOMAIN_CLAIM];
    return {
      organization: {
        alias: typeof domain === "string" && domain ? domain : id,
        id,
        name: typeof name === "string" && name ? name : null,
        permissions: rolesGrantedByOrg(payload, audience, id),
      },
    };
  }

  export function parseAccessTokenClaims(payload: JWTPayload, audience: string): AccessTokenClaims {
    if (typeof payload.sub !== "string" || !payload.sub) throw unauthorized("token has no subject");
    if (!audienceMatches(payload.aud, audience)) {
      throw unauthorized("token audience is not the API");
    }
    const parsed = parseOrganizationClaim(payload, audience);
    if (parsed.error) throw unauthorized(parsed.error);
    return {
      sub: payload.sub,
      sessionId: typeof payload.sid === "string" ? payload.sid : null,
      email: typeof payload.email === "string" && payload.email ? payload.email : null,
      displayName: typeof payload.name === "string" && payload.name ? payload.name : null,
      organization: parsed.organization,
      issuer: typeof payload.iss === "string" ? payload.iss : "",
    };
  }

  export async function verifyAccessToken(
    env: ServerEnv,
    token: string,
    onFailure?: (cause: string) => void,
  ): Promise<AccessTokenClaims> {
    const verify = verifier ?? defaultVerifier(env);
    try {
      const payload = await verify(token);
      return parseAccessTokenClaims(payload, env.ZITADEL_API_AUDIENCE);
    } catch (e) {
      onFailure?.(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      throw unauthorized("invalid or expired access token");
    }
  }
