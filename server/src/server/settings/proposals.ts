import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePermission, type AuthContext } from "../auth/plugin.js";
import { audit } from "../audit.js";
import { query } from "../db/index.js";
import { badRequest, conflict, forbidden, notFound } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import {
  assertValidDefaultsConfig,
  MAX_INIT_SCRIPT_BYTES,
  readLayer,
  stripRetiredConfigKeys,
  writeLayer,
} from "./merge.js";

/**
 * Pods may propose organization defaults, but a pod token can never apply one. Project settings
 * are request-scoped and machine settings are client-only, so neither has a server proposal target.
 */

export interface ProposalRow {
  id: string;
  org_id: string;
  scope_type: "org_defaults";
  scope_id: string;
  config: Record<string, unknown> | null;
  init_script: string | null;
  bake_script: string | null;
  secret_names: string[];
  note: string | null;
  status: string;
  created_by: string;
  created_from_pod: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

const ProposalBody = z
  .object({
    scope: z.literal("org_defaults"),
    config: z.record(z.unknown()).optional(),
    initScript: z.string().max(MAX_INIT_SCRIPT_BYTES).optional(),
    bakeScript: z.string().max(MAX_INIT_SCRIPT_BYTES).optional(),
    secretNames: z.array(z.string().regex(ENV_NAME_RE)).max(50).default([]),
    note: z.string().max(2000).optional(),
  })
  .strict();

function toApi(row: ProposalRow) {
  return {
    id: row.id,
    scope: row.scope_type,
    scopeId: row.scope_id,
    // Pending proposals predate bundle-schema removals and still store retired keys. New
    // writes reject those keys, so the list strips them the same way settings GETs do —
    // reviewers see what applying would actually change, and `pipod` copies nothing stale.
    config: (row.config ? stripRetiredConfigKeys(row.config) : null) as Record<
      string,
      unknown
    > | null,
    initScript: row.init_script,
    bakeScript: row.bake_script,
    secretNames: row.secret_names,
    note: row.note,
    status: row.status,
    createdBy: row.created_by,
    createdFromPod: row.created_from_pod,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

async function getProposal(orgId: string, id: string): Promise<ProposalRow> {
  const rows = await query<ProposalRow>(
    "SELECT * FROM settings_proposals WHERE id = $1 AND org_id = $2",
    [id, orgId],
  );
  const row = rows.rows[0];
  if (!row) throw notFound("proposal not found");
  return row;
}

/** Applying/rejecting requires the same permission as editing organization defaults. */
function assertResolvePermission(auth: AuthContext): void {
  if (auth.podId) throw forbidden("pod tokens cannot resolve settings proposals");
  requirePermission(auth, "org:manage");
}

export function registerSettingsProposalRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/settings/proposals",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { body: ProposalBody },
    },
    async (req, reply) => {
      // A signed-in person edits the layers directly; the proposal detour exists only for
      // the agent inside a pod.
      if (!req.auth.podId) throw forbidden("settings proposals are authored by pods — edit settings directly");
      if (
        !req.body.config &&
        req.body.initScript === undefined &&
        req.body.bakeScript === undefined &&
        req.body.secretNames.length === 0
      ) {
        throw badRequest("a proposal must change something: config, initScript, bakeScript, or secretNames");
      }
      if (req.body.config) assertValidDefaultsConfig(req.body.config);
      const scopeId = req.auth.orgId;
      const id = uuidv7();
      const inserted = await query<ProposalRow>(
        `INSERT INTO settings_proposals
           (id, org_id, scope_type, scope_id, config, init_script, bake_script, secret_names, note, created_by, created_from_pod)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [
          id,
          req.auth.orgId,
          req.body.scope,
          scopeId,
          req.body.config ? JSON.stringify(req.body.config) : null,
          req.body.initScript ?? null,
          req.body.bakeScript ?? null,
          req.body.secretNames,
          req.body.note ?? null,
          req.auth.userId,
          req.auth.podId,
        ],
      );
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "settings.proposal.create",
        targetType: "settings_proposal",
        targetId: id,
        detail: { scope: req.body.scope, fromPod: req.auth.podId },
      });
      return reply.code(201).send(toApi(inserted.rows[0]!));
    },
  );

  r.get(
    "/settings/proposals",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        querystring: z.object({ status: z.enum(["pending", "applied", "rejected", "all"]).default("pending") }),
      },
    },
    async (req) => {
      const conditions = ["org_id = $1"];
      const params: unknown[] = [req.auth.orgId];
      if (req.query.status !== "all") {
        params.push(req.query.status);
        conditions.push(`status = $${params.length}`);
      }
      if (req.auth.podId) {
        // A pod sees only what it proposed itself.
        params.push(req.auth.podId);
        conditions.push(`created_from_pod = $${params.length}`);
      }
      const rows = await query<ProposalRow>(
        `SELECT * FROM settings_proposals WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
        params,
      );
      return { proposals: rows.rows.map(toApi) };
    },
  );

  r.post(
    "/settings/proposals/:id/apply",
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const row = await getProposal(req.auth.orgId, req.params.id);
      assertResolvePermission(req.auth);
      if (row.status !== "pending") throw conflict(`proposal is already ${row.status}`);
      const current = await readLayer(row.scope_type, row.scope_id, req.auth.orgId);
      // A pending proposal authored before a schema removal still stores retired keys, which
      // writes now reject. Strip them so the proposal applies its live content instead of
      // failing: stripping to `{}` is exactly what the un-stripped row already resolved to.
      // CAS (expectedVersion) and the resolve permission above are untouched.
      const version = await writeLayer({
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        orgId: req.auth.orgId,
        config: row.config
          ? (stripRetiredConfigKeys(row.config) as Record<string, unknown>)
          : current.config,
        initScript: row.init_script ?? undefined,
        bakeScript: row.bake_script ?? undefined,
        expectedVersion: current.version,
        updatedBy: req.auth.userId,
      });
      await query(
        "UPDATE settings_proposals SET status = 'applied', resolved_by = $2, resolved_at = now() WHERE id = $1",
        [row.id, req.auth.userId],
      );
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "settings.proposal.apply",
        targetType: "settings_proposal",
        targetId: row.id,
        detail: { scope: row.scope_type, fromPod: row.created_from_pod },
      });
      // secretNames go back so the app can prompt for the values the agent could not set.
      return { id: row.id, status: "applied", version, secretNames: row.secret_names };
    },
  );

  r.post(
    "/settings/proposals/:id/reject",
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const row = await getProposal(req.auth.orgId, req.params.id);
      assertResolvePermission(req.auth);
      if (row.status !== "pending") throw conflict(`proposal is already ${row.status}`);
      await query(
        "UPDATE settings_proposals SET status = 'rejected', resolved_by = $2, resolved_at = now() WHERE id = $1",
        [row.id, req.auth.userId],
      );
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "settings.proposal.reject",
        targetType: "settings_proposal",
        targetId: row.id,
        detail: { scope: row.scope_type, fromPod: row.created_from_pod },
      });
      return { id: row.id, status: "rejected" };
    },
  );
}
