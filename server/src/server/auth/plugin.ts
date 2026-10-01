import type { FastifyReply, FastifyRequest } from "fastify";
import { hashPodToken, POD_TOKEN_PREFIX } from "../pods/podtoken.js";
import { query } from "../db/index.js";
import type { ServerEnv } from "../env.js";
import { IdentityId } from "../ids.js";
import { badRequest, forbidden, unauthorized } from "../httperrors.js";
import { accountConsoleUrl, adminConsoleUrl } from "./consoles.js";
import { verifyAccessToken } from "./jwt.js";
import { hasPermission, type Permission } from "./rbac.js";
import { materializeIdentity } from "./snapshots.js";

export interface AuthContext {
  userId: string;
  email: string;
  displayName?: string | null;
  /** Zitadel organization id from the verified token; empty when the token has none. */
  orgId: string;
  orgAlias?: string;
  orgName?: string | null;
  /**
   * Permission slugs from role grants the token's organization made on the `pipod` project.
   * Pod tokens carry none — routes that accept them opt in via `allowPodToken`.
   */
  permissions: string[];
  /** Set when authenticated with a pod-bound token (§8.5). */
  podId?: string;
  accountConsoleUrl?: string;
  adminConsoleUrl?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyContextConfig {
    /** Route opt-in for pod-bound tokens (spec §8.5); absent = user JWTs only. */
    allowPodToken?: boolean;
    /** `/me` and similar: a verified human token with no organization is allowed. */
    allowNoOrganization?: boolean;
  }
}

function routeConfig(req: FastifyRequest): { allowPodToken?: boolean; allowNoOrganization?: boolean } {
  return (req.routeOptions.config as { allowPodToken?: boolean; allowNoOrganization?: boolean } | undefined) ?? {};
}

/**
 * Bearer auth. Human identity, tenant, and roles come only from the verified token.
 * Local rows are snapshots for foreign keys and display — never grants.
 */
export function makeAuthHook(env: ServerEnv, log?: { warn: (msg: string) => void }) {
  return async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw unauthorized("missing bearer token");
    const bearer = header.slice("Bearer ".length);
    const config = routeConfig(req);

    if (bearer.startsWith(POD_TOKEN_PREFIX)) {
      if (!config.allowPodToken) {
        throw forbidden("pod tokens cannot access this route");
      }
      const rows = await query<{ pod_id: string; org_id: string; user_id: string; email: string }>(
        `SELECT t.pod_id, t.org_id, t.user_id, u.email FROM pod_tokens t
         JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
        [hashPodToken(bearer)],
      );
      const row = rows.rows[0];
      if (!row) {
        log?.warn(`auth: unknown or revoked pod token on ${req.routeOptions.url}`);
        throw unauthorized("unknown or revoked pod token");
      }
      req.auth = {
        userId: row.user_id,
        email: row.email,
        orgId: row.org_id,
        permissions: [],
        podId: row.pod_id,
      };
      return;
    }

    const claims = await verifyAccessToken(env, bearer, (cause) => log?.warn(`auth: token rejected: ${cause}`));
    // Zitadel ids are opaque numeric strings; legacy rows keyed by UUID remain valid.
    if (claims.organization && !IdentityId.safeParse(claims.organization.id).success) {
      throw badRequest("organization id in access token is not a valid identifier", {
        code: "invalid_organization_id",
      });
    }
    try {
      await materializeIdentity(claims);
    } catch (e) {
      // Snapshot failure must not become an authentication or authorization decision.
      log?.warn(`auth: identity snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!claims.organization && !config.allowNoOrganization) {
      throw forbidden("no organization in access token");
    }

    req.auth = {
      userId: claims.sub,
      email: claims.email ?? "",
      displayName: claims.displayName,
      orgId: claims.organization?.id ?? "",
      orgAlias: claims.organization?.alias,
      orgName: claims.organization?.name,
      permissions: claims.organization?.permissions ?? [],
      accountConsoleUrl: accountConsoleUrl(env),
      adminConsoleUrl: adminConsoleUrl(env),
    };
  };
}

export function requirePermission(auth: AuthContext, permission: Permission): void {
  if (!hasPermission(auth.permissions, permission)) {
    throw forbidden(`requires ${permission}`);
  }
}

export function requireOrganization(auth: AuthContext): void {
  if (!auth.orgId) throw forbidden("no organization in access token");
}
