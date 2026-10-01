import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { audit } from "../audit.js";
import { query } from "../db/index.js";
import { resolveInteraction, type GatewayService } from "../gateway/service.js";
import { HttpError, notFound } from "../httperrors.js";

/**
 * Approvals as first-class rows (spec §9.3): the push deep-links here, and resolving works
 * over plain REST even if the WebSocket never comes up — including on an api-only role,
 * where the persisted resolution is forwarded by whichever gateway holds the pod.
 */
export function registerInteractionRoutes(app: FastifyInstance, gateway: GatewayService | null): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/interactions",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: z.object({
          pending: z.coerce.boolean().default(true),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          before: z.string().datetime({ offset: true }).optional(),
        }),
      },
    },
    async (req) => {
      // "Pending" means the agent has not received an answer yet (delivered_at), so a
      // resolution stranded by a gateway crash resurfaces instead of vanishing.
      const rows = await query<{ seq: string } & Record<string, unknown>>(
        `SELECT pi.id, pi.session_id, s.pod_id, p.name AS pod_name, pi.seq, pi.kind, pi.payload,
                pi.created_at, pi.resolved_at, pi.delivered_at
         FROM pending_interactions pi
         JOIN sessions s ON s.id = pi.session_id
         JOIN pods p ON p.id = s.pod_id
         WHERE p.org_id = $1 AND ($2 = false OR pi.delivered_at IS NULL)
           AND ($3::timestamptz IS NULL OR pi.created_at < $3)
         ORDER BY pi.created_at DESC LIMIT $4`,
        [req.auth.orgId, req.query.pending, req.query.before ?? null, req.query.limit],
      );
      return {
        interactions: rows.rows.map((row) => ({ ...row, seq: Number(row.seq) })),
      };
    },
  );

  r.post(
    "/interactions/:id/resolve",
    {
      preHandler: [app.authenticate],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ response: z.unknown() }),
      },
    },
    async (req) => {
      const scoped = await query(
        `SELECT 1 FROM pending_interactions pi
         JOIN sessions s ON s.id = pi.session_id JOIN pods p ON p.id = s.pod_id
         WHERE pi.id = $1 AND p.org_id = $2`,
        [req.params.id, req.auth.orgId],
      );
      if ((scoped.rowCount ?? 0) === 0) throw notFound("interaction not found");
      const outcome = await resolveInteraction(gateway, {
        interactionId: req.params.id,
        response: req.body.response,
        resolvedBy: req.auth.userId,
      });
      switch (outcome.status) {
        case "not_found":
          throw notFound("interaction not found");
        case "already_resolved":
          // Resolving twice is a double-tap, not an error.
          return { resolved: true, alreadyResolved: true };
        case "undeliverable":
          throw new HttpError(
            409,
            "no live session can receive this approval — start the pod (or wait for it to reattach) and try again",
            { code: "pod_not_attached" },
          );
        case "delivered":
        case "pending_delivery": {
          await audit({
            orgId: req.auth.orgId,
            actorId: req.auth.userId,
            action: "interaction.resolve",
            targetType: "interaction",
            targetId: req.params.id,
          });
          return { resolved: true, delivery: outcome.status === "delivered" ? "delivered" : "pending" };
        }
      }
    },
  );
}
