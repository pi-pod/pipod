import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePermission, type AuthContext } from "../auth/plugin.js";
import { audit } from "../audit.js";
import { query, tx } from "../db/index.js";
import { badRequest, conflict, forbidden, notFound } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import { stripRetiredConfigKeys } from "../settings/merge.js";
import { delegatesTemplate, parentDelegation, type ParentDelegation } from "../pods/lineage.js";
import {
  TemplatePiSettingsInputSchema,
  canonicalizePiSettingsForStorage,
  flattenTemplatePiSettings,
} from "../settings/pi-settings.js";
import {
  assertScopeChange,
  assertValidTemplateConfig,
  getTemplate,
  DEFAULT_TEMPLATE_NAME,
  type TemplateRow,
} from "./store.js";

// Strict: an agent that misspells a field would otherwise have it silently dropped and
// believe it authored a template it did not (spec §8.5).
const TemplateBody = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    initScript: z.string().max(256 * 1024).optional(),
    bakeScript: z.string().max(256 * 1024).optional(),
    // Added to the system prompt of every session in a pod launched from the template, so it
    // is bounded like a prompt rather than a script. An empty string removes it.
    agentInstructions: z.string().max(8000).optional(),
    // Personal by default; "org" must be asked for. On PATCH, "org" hands a personal
    // template to the org (one-way — see the scope-change check).
    scope: z.enum(["user", "org"]).optional(),
    config: z.record(z.unknown()).default({}),
    piSettings: TemplatePiSettingsInputSchema.optional(),
  })
  .strict();

const TemplateUpdateBody = TemplateBody.partial()
  .extend({
    expectedVersion: z.number().int().optional(),
  })
  .strict();

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

function toApi(row: TemplateRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: "active" as const,
    scope: row.owner_user_id ? ("user" as const) : ("org" as const),
    initScript: row.init_script,
    bakeScript: row.bake_script,
    agentInstructions: row.agent_instructions ?? "",
    // A template written before a schema removal still stores the retired key; `pipod pull`
    // would otherwise copy it into a fresh project's config.json for the CLI to warn about.
    config: stripRetiredConfigKeys(row.config),
    piSettings: flattenTemplatePiSettings(row.pi_settings),
    version: row.version,
    createdBy: row.created_by,
    createdFromPod: row.created_from_pod,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * An org template is code every member's launch runs (scripts, Pi packages loaded on their
 * workstations, init steps inside org jobs that carry their creators' model credentials),
 * so publishing or changing one is an org-management act, never a pod's.
 */
export function assertTemplateWrite(
  auth: AuthContext,
  row: Pick<TemplateRow, "created_from_pod" | "owner_user_id">,
  sharing = false,
): void {
  const org = row.owner_user_id === null || sharing;
  if (auth.podId) {
    if (org) throw forbidden("pod tokens may only manage personal templates");
    if (row.created_from_pod !== auth.podId) {
      throw forbidden("pod tokens may only modify templates they created");
    }
    return;
  }
  requirePermission(auth, "templates:write");
  if (org) requirePermission(auth, "org:manage");
}

/** For a pod token, what its own launch was given; null for a person. */
async function podDelegation(auth: AuthContext): Promise<ParentDelegation | null> {
  return auth.podId ? parentDelegation({ query }, { orgId: auth.orgId, parentPodId: auth.podId }) : null;
}

export function registerTemplateRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/templates",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
          before: z.string().datetime({ offset: true }).optional(),
        }),
      },
    },
    async (req) => {
      const delegation = await podDelegation(req.auth);
      const rows = await query<TemplateRow>(
        `SELECT * FROM pod_templates WHERE org_id = $1 AND archived_at IS NULL
           AND (owner_user_id IS NULL OR owner_user_id = $2)
           AND ($3::timestamptz IS NULL OR created_at < $3)
         ORDER BY created_at DESC LIMIT $4`,
        [req.auth.orgId, req.auth.userId, req.query.before ?? null, req.query.limit],
      );
      return { templates: rows.rows.filter((row) => delegatesTemplate(row, delegation)).map(toApi) };
    },
  );

  r.post(
    "/templates",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { body: TemplateBody },
    },
    async (req, reply) => {
      assertTemplateWrite(req.auth, { created_from_pod: req.auth.podId ?? null, owner_user_id: req.body.scope === "org" ? null : req.auth.userId });
      if (req.body.name.trim().toLowerCase() === DEFAULT_TEMPLATE_NAME) {
        throw badRequest(`"${DEFAULT_TEMPLATE_NAME}" is the built-in template and cannot be redefined`);
      }
      assertValidTemplateConfig(req.body.config);
      const piSettings = canonicalizePiSettingsForStorage(req.body.piSettings ?? {});
      const scope = req.body.scope ?? "user";
      const owner = scope === "user" ? req.auth.userId : null;
      const id = uuidv7();
      // The conflict target must name the partial unique index the row can actually hit:
      // personal templates collide per owner, org templates per org.
      const conflictTarget = owner
        ? "(org_id, owner_user_id, name) WHERE archived_at IS NULL AND owner_user_id IS NOT NULL"
        : "(org_id, name) WHERE archived_at IS NULL AND owner_user_id IS NULL";
      const inserted = await query<TemplateRow>(
        `INSERT INTO pod_templates (id, org_id, owner_user_id, name, description, init_script, bake_script, config, pi_settings, created_by, created_from_pod, agent_instructions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT ${conflictTarget} DO NOTHING
         RETURNING *`,
        [
          id,
          req.auth.orgId,
          owner,
          req.body.name.trim(),
          req.body.description ?? null,
          req.body.initScript ?? null,
          req.body.bakeScript ?? null,
          JSON.stringify(req.body.config),
          JSON.stringify(piSettings),
          req.auth.userId,
          req.auth.podId ?? null,
          req.body.agentInstructions ?? null,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        throw conflict(
          owner
            ? "you already have a template with this name"
            : "a template with this name already exists in the org",
        );
      }
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "template.create",
        targetType: "template",
        targetId: id,
        detail: {
          name: row.name,
          scope,
          piSettingsPresent: Object.keys(piSettings).length > 0,
          agentInstructionsPresent: Boolean(req.body.agentInstructions?.trim()),
          ...(req.auth.podId ? { fromPod: req.auth.podId } : {}),
        },
      });
      return reply.code(201).send(toApi(row));
    },
  );

  r.get(
    "/templates/:id",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const template = await getTemplate(req.auth.orgId, req.params.id, req.auth.userId);
      if (!delegatesTemplate(template, await podDelegation(req.auth))) throw notFound("template not found");
      return toApi(template);
    },
  );

  const updateOpts = {
    preHandler: [app.authenticate],
    config: { allowPodToken: true },
    schema: { params: z.object({ id: z.string().uuid() }), body: TemplateUpdateBody },
  };
  const updateTemplate = async (req: {
    auth: AuthContext;
    params: { id: string };
    body: z.infer<typeof TemplateUpdateBody>;
  }) => {
    if (req.body.name && req.body.name.trim().toLowerCase() === DEFAULT_TEMPLATE_NAME) {
      throw badRequest(`"${DEFAULT_TEMPLATE_NAME}" is the built-in template and cannot be redefined`);
    }
    if (req.body.config) assertValidTemplateConfig(req.body.config);
    const piSettings =
      req.body.piSettings === undefined
        ? null
        : canonicalizePiSettingsForStorage(req.body.piSettings);
    const row = await tx(async (client) => {
      const locked = await client.query<TemplateRow>(
        `SELECT * FROM pod_templates
         WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
           AND (owner_user_id IS NULL OR owner_user_id = $3)
         FOR UPDATE`,
        [req.params.id, req.auth.orgId, req.auth.userId],
      );
      const existing = locked.rows[0];
      if (!existing) throw notFound("template not found");
      const shareWithOrg = assertScopeChange(existing, req.body.scope);
      // Check the locked row so a concurrent update cannot race past the ownership gate.
      assertTemplateWrite(req.auth, existing, shareWithOrg);
      if (req.body.expectedVersion !== undefined && existing.version !== req.body.expectedVersion) {
        throw conflict("version conflict: template changed since you read it");
      }
      const rows = await client
        .query<TemplateRow>(
          `UPDATE pod_templates SET
             name = COALESCE($3, name),
             description = COALESCE($4, description),
             init_script = COALESCE($5, init_script),
             bake_script = COALESCE($6, bake_script),
             config = COALESCE($7, config),
             pi_settings = COALESCE($8, pi_settings),
             owner_user_id = CASE WHEN $9 THEN NULL ELSE owner_user_id END,
             agent_instructions = COALESCE($10, agent_instructions),
             version = version + 1,
             updated_at = now()
           WHERE id = $1 AND org_id = $2 RETURNING *`,
          [
            req.params.id,
            req.auth.orgId,
            req.body.name?.trim() ?? null,
            req.body.description ?? null,
            req.body.initScript ?? null,
            req.body.bakeScript ?? null,
            req.body.config ? JSON.stringify(req.body.config) : null,
            piSettings === null ? null : JSON.stringify(piSettings),
            shareWithOrg,
            req.body.agentInstructions ?? null,
          ],
        )
        .catch((e: unknown) => {
          if (isUniqueViolation(e)) {
            throw conflict(
              shareWithOrg
                ? "a template with this name already exists in the org — rename yours before sharing it"
                : "a template with this name already exists",
            );
          }
          throw e;
        });
      return rows.rows[0]!;
    });
    await audit({
      orgId: req.auth.orgId,
      actorId: req.auth.userId,
      action: "template.update",
      targetType: "template",
      targetId: row.id,
      detail: {
        ...(req.body.scope === "org" ? { sharedWithOrg: true } : {}),
        ...(piSettings !== null ? { piSettingsChanged: true } : {}),
        ...(req.body.agentInstructions !== undefined ? { agentInstructionsChanged: true } : {}),
        ...(req.auth.podId ? { fromPod: req.auth.podId } : {}),
      },
    });
    return toApi(row);
  };
  r.patch("/templates/:id", updateOpts, updateTemplate);
  r.put("/templates/:id", updateOpts, updateTemplate);

  // Kept as an idempotent no-op so older CLIs that still POST /activate do not 404.
  r.post(
    "/templates/:id/activate",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const existing = await getTemplate(req.auth.orgId, req.params.id, req.auth.userId);
      return { id: existing.id, status: "active" as const };
    },
  );

  r.delete(
    "/templates/:id",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      await tx(async (client) => {
        const template = await client.query<Pick<TemplateRow, "id" | "created_from_pod" | "owner_user_id">>(
          `SELECT id, created_from_pod, owner_user_id FROM pod_templates
           WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
             AND (owner_user_id IS NULL OR owner_user_id = $3)
           FOR UPDATE`,
          [req.params.id, req.auth.orgId, req.auth.userId],
        );
        const existing = template.rows[0];
        if (!existing) throw notFound("template not found");
        assertTemplateWrite(req.auth, existing);
        const jobs = await client.query(
          `SELECT 1 FROM jobs
           WHERE template_id = $1 AND status = 'active' AND archived_at IS NULL LIMIT 1`,
          [req.params.id],
        );
        if ((jobs.rowCount ?? 0) > 0) {
          throw conflict("template is used by an active job — pause or remove the job first");
        }
        await client.query(
          "UPDATE pod_templates SET archived_at = now(), updated_at = now() WHERE id = $1",
          [req.params.id],
        );
      });
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "template.archive",
        targetType: "template",
        targetId: req.params.id,
        detail: req.auth.podId ? { fromPod: req.auth.podId } : {},
      });
      return reply.code(204).send();
    },
  );
}
