import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { ServerEnv } from "../env.js";
import { requirePermission } from "../auth/plugin.js";
import { adminConsoleUrl } from "../auth/consoles.js";
import { query } from "../db/index.js";
import { forbidden } from "../httperrors.js";
import { IdentityId } from "../ids.js";

export function registerOrgRoutes(app: FastifyInstance, env: ServerEnv): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/orgs", { preHandler: [app.authenticate] }, async (req) => {
    const organization = req.auth.orgId
      ? {
          id: req.auth.orgId,
          alias: req.auth.orgAlias ?? null,
          name: req.auth.orgName ?? null,
        }
      : null;
    return {
      organizations: organization ? [organization] : [],
      adminConsoleUrl: adminConsoleUrl(env),
    };
  });

  r.get(
    "/orgs/:id",
    { preHandler: [app.authenticate], schema: { params: z.object({ id: IdentityId }) } },
    async (req) => {
      if (req.params.id !== req.auth.orgId) throw forbidden("org mismatch");
      return {
        id: req.auth.orgId,
        alias: req.auth.orgAlias ?? null,
        name: req.auth.orgName ?? null,
        adminConsoleUrl: adminConsoleUrl(env),
      };
    },
  );

  r.get(
    "/orgs/:id/audit",
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: IdentityId }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.string().optional(),
        }),
      },
    },
    async (req) => {
      if (req.params.id !== req.auth.orgId) throw forbidden("org mismatch");
      requirePermission(req.auth, "audit:read");
      const rows = await query(
        `SELECT id, actor_id, action, target_type, target_id, detail, created_at
         FROM audit_log WHERE org_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
         ORDER BY created_at DESC LIMIT $3`,
        [req.params.id, req.query.before ?? null, req.query.limit],
      );
      return { entries: rows.rows };
    },
  );
}
