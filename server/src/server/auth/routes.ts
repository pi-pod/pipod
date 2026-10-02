import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { ServerEnv } from "../env.js";
import { query } from "../db/index.js";
import { audit } from "../audit.js";
import { badRequest } from "../httperrors.js";
import { accountConsoleUrl, adminConsoleUrl } from "./consoles.js";
import { edition } from "../edition.js";
import { userEmail } from "./snapshots.js";

/** Loopback PKCE: the CLI's redirect must land on this machine. */
export function isLoopbackRedirect(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function registerAuthRoutes(app: FastifyInstance, env: ServerEnv): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Public: where a signed-out client signs in. Nothing here is secret — the issuer and a
  // public PKCE client id are both visible in every authorization URL.
  r.get("/auth/config", async () => ({
    issuer: env.ZITADEL_ISSUER,
    ...(env.ZITADEL_CLI_CLIENT_ID ? { cliClientId: env.ZITADEL_CLI_CLIENT_ID } : {}),
    ...(env.ZITADEL_MOBILE_CLIENT_ID ? { mobileClientId: env.ZITADEL_MOBILE_CLIENT_ID } : {}),
    ...(env.ZITADEL_DASHBOARD_CLIENT_ID ? { dashboardClientId: env.ZITADEL_DASHBOARD_CLIENT_ID } : {}),
    ...(env.SERVER_URL ? { serverUrl: env.SERVER_URL } : {}),
  }));

  r.get(
    "/me",
    { preHandler: [app.authenticate], config: { allowNoOrganization: true } },
    async (req) => {
      const organization = req.auth.orgId
        ? {
            id: req.auth.orgId,
            alias: req.auth.orgAlias ?? null,
            name: req.auth.orgName ?? null,
          }
        : null;
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const email = req.auth.email || (bearer ? await userEmail(env, req.auth.userId, bearer) : null);
      // The hosted edition adds its `workstation` block here. A self-hosted server adds
      // nothing: it has no plan, no meter and no cap to report, and clients key their
      // whole billing UI off the presence of that object.
      return {
        ...(await edition().accountSummary(env, req.auth.userId)),
        user: {
          id: req.auth.userId,
          ...(email ? { email } : {}),
          ...(req.auth.displayName ? { displayName: req.auth.displayName } : {}),
        },
        currentOrgId: req.auth.orgId || null,
        permissions: req.auth.permissions,
        organization,
        accountConsoleUrl: req.auth.accountConsoleUrl ?? accountConsoleUrl(env),
        adminConsoleUrl: req.auth.adminConsoleUrl ?? adminConsoleUrl(env),
      };
    },
  );

  r.post(
    "/devices",
    {
      preHandler: [app.authenticate],
      schema: {
        body: z.object({
          apnsToken: z.string().min(1).optional(),
          token: z.string().min(1).optional(),
          tokenKind: z.enum(["apns", "fcm"]).default("apns"),
          platform: z.string().default("ios"),
          environment: z.enum(["sandbox", "production"]),
        }),
      },
    },
    async (req, reply) => {
      const { apnsToken, token, tokenKind, platform, environment } = req.body;
      const resolvedToken = token ?? apnsToken;
      if (!resolvedToken) throw badRequest("token or apnsToken is required");
      await query(
        `INSERT INTO devices (id, user_id, platform, apns_token, token_kind, environment, last_seen_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())
         ON CONFLICT (apns_token)
         DO UPDATE SET user_id = EXCLUDED.user_id, token_kind = EXCLUDED.token_kind,
           platform = EXCLUDED.platform, environment = EXCLUDED.environment, last_seen_at = now()`,
        [req.auth.userId, platform, resolvedToken, tokenKind, environment],
      );
      await audit({ orgId: req.auth.orgId, actorId: req.auth.userId, action: "device.register" });
      return reply.code(204).send();
    },
  );

  r.delete(
    "/devices/:token",
    { preHandler: [app.authenticate], schema: { params: z.object({ token: z.string() }) } },
    async (req, reply) => {
      await query("DELETE FROM devices WHERE apns_token = $1 AND user_id = $2", [
        req.params.token,
        req.auth.userId,
      ]);
      return reply.code(204).send();
    },
  );
}
