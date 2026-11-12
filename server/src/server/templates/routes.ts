import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePermission, type AuthContext } from "../auth/plugin.js";
import { audit } from "../audit.js";
import { query, tx } from "../db/index.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import { limitRefusal } from "../auth/limited-sign-in.js";
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
  endTemplateShares,
  getTemplate,
  listVisibleTemplates,
  lockTemplateForChange,
  sharedWith,
  DEFAULT_TEMPLATE_NAME,
  type TemplateRow,
  type VisibleTemplate,
} from "./store.js";
import { pauseMemberJobs, shareTemplate, unshareTemplate } from "./sharing.js";

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
    // Making a personal template organization-wide cannot be undone, so the client confirms it
    // means the whole organization. pipod 0.1.28 and older send `scope: "org"` alone, and they
    // send it for `templates share <name> --with <email>` too: they ignore `--with`.
    orgWide: z.literal(true).optional(),
  })
  .strict();

/** A personal template becomes organization-wide only when the client says so in so many words. */
function orgWideUnconfirmed(name: string): HttpError {
  const message =
    `${name} was not shared: making a template organization-wide cannot be undone, and this client ` +
    "did not confirm it means the whole organization (pipod 0.1.28 and older ignore `--with`). " +
    "Update pipod (`npm install -g @pipod/cli@latest`), then run `pipod templates share <name> --with <email>` " +
    "to share it with one person, or `pipod templates share <name>` for the whole organization";
  return new HttpError(409, message, { code: "org_wide_share_unconfirmed", message });
}

const ShareParams = z.object({
  id: z.string().uuid(),
  email: z.string().trim().email().max(320),
});

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/**
 * A template as the caller sees it. `scope` is `user` (their own), `org` or `shared` (another
 * member's, shared with them: `sharedBy` names its owner). Their own templates list who they
 * are shared with in `sharedWith`.
 */
function toApi(row: VisibleTemplate, shares: readonly string[] = []) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: "active" as const,
    scope: row.access === "own" ? ("user" as const) : row.access,
    ...(row.access === "shared" ? { sharedBy: row.shared_by } : {}),
    ...(row.access === "own" ? { sharedWith: [...shares] } : {}),
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
      config: { allowPodToken: true, allowLimitedSignIn: true },
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
          before: z.string().datetime({ offset: true }).optional(),
        }),
      },
    },
    async (req) => {
      const delegation = await podDelegation(req.auth);
      const rows = await listVisibleTemplates({
        orgId: req.auth.orgId,
        userId: req.auth.userId,
        limit: req.query.limit,
        before: req.query.before ?? null,
        // A limited sign-in sees its own template and no other.
        templateId: req.auth.limitedTo?.templateId ?? null,
      });
      const listed = rows.filter((row) => delegatesTemplate(row, delegation));
      const shares = await sharedWith(listed.filter((row) => row.access === "own").map((row) => row.id));
      return { templates: listed.map((row) => toApi(row, shares.get(row.id))) };
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
      const created: VisibleTemplate = { ...row, access: owner ? "own" : "org", shared_by: null };
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
      return reply.code(201).send(toApi(created));
    },
  );

  r.get(
    "/templates/:id",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true, allowLimitedSignIn: true },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const limit = req.auth.limitedTo;
      if (limit && req.params.id.toLowerCase() !== limit.templateId) {
        throw limitRefusal(limit, "it can read only its own template");
      }
      const template = await getTemplate(req.auth.orgId, req.params.id, req.auth.userId);
      if (!delegatesTemplate(template, await podDelegation(req.auth))) throw notFound("template not found");
      const shares = template.access === "own" ? await sharedWith([template.id]) : new Map<string, string[]>();
      return toApi(template, shares.get(template.id));
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
    const { row, sharesEnded } = await tx(async (client) => {
      // Check the locked row so a concurrent update cannot race past the ownership gate.
      const existing = await lockTemplateForChange(client, {
        orgId: req.auth.orgId,
        templateId: req.params.id,
        userId: req.auth.userId,
      });
      const shareWithOrg = assertScopeChange(existing, req.body.scope);
      assertTemplateWrite(req.auth, existing, shareWithOrg);
      if (shareWithOrg && req.body.orgWide !== true) throw orgWideUnconfirmed(existing.name);
      if (req.body.expectedVersion !== undefined && existing.version !== req.body.expectedVersion) {
        throw conflict("version conflict: template changed since you read it");
      }
      // Shared with everyone now: the named shares would only restate it.
      const sharesEnded = shareWithOrg ? await endTemplateShares(client, existing.id) : 0;
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
      return { row: rows.rows[0]!, sharesEnded };
    });
    await audit({
      orgId: req.auth.orgId,
      actorId: req.auth.userId,
      action: "template.update",
      targetType: "template",
      targetId: row.id,
      detail: {
        ...(req.body.scope === "org" ? { sharedWithOrg: true } : {}),
        ...(sharesEnded > 0 ? { sharesEnded } : {}),
        ...(piSettings !== null ? { piSettingsChanged: true } : {}),
        ...(req.body.agentInstructions !== undefined ? { agentInstructionsChanged: true } : {}),
        ...(req.auth.podId ? { fromPod: req.auth.podId } : {}),
      },
    });
    const updated: VisibleTemplate = { ...row, access: row.owner_user_id === null ? "org" : "own", shared_by: null };
    const shares = updated.access === "own" ? await sharedWith([row.id]) : new Map<string, string[]>();
    return toApi(updated, shares.get(row.id));
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
      const { sharesEnded, jobsPaused } = await tx(async (client) => {
        const existing = await lockTemplateForChange(client, {
          orgId: req.auth.orgId,
          templateId: req.params.id,
          userId: req.auth.userId,
          what: "delete it",
        });
        assertTemplateWrite(req.auth, existing);
        // Jobs of the people it was shared with cannot launch from it once it is gone, and must
        // not keep its owner from deleting it: they are paused. The owner's own active jobs
        // still block the delete, as before.
        const jobsPaused = await pauseMemberJobs(client, existing);
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
        // Deleting a template ends its shares: nobody it was shared with launches it again.
        return { sharesEnded: await endTemplateShares(client, existing.id), jobsPaused };
      });
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "template.archive",
        targetType: "template",
        targetId: req.params.id,
        detail: {
          ...(sharesEnded > 0 ? { sharesEnded } : {}),
          ...(jobsPaused > 0 ? { jobsPaused } : {}),
          ...(req.auth.podId ? { fromPod: req.auth.podId } : {}),
        },
      });
      return reply.code(204).send();
    },
  );

  // Sharing a personal template with one named member, and ending it. Only the owner does either:
  // a person's own token, never a pod's or a limited sign-in's (neither route opts in). Sharing
  // needs `templates:write`, the permission to manage your own templates; ending a share needs
  // only ownership, so an owner can always take access back. See sharing.ts.
  r.put(
    "/templates/:id/shares/:email",
    { preHandler: [app.authenticate], schema: { params: ShareParams } },
    async (req) => {
      const owner = { orgId: req.auth.orgId, userId: req.auth.userId };
      try {
        requirePermission(req.auth, "templates:write");
        const { template, member, created } = await shareTemplate(owner, req.params.id, req.params.email);
        await audit({
          orgId: req.auth.orgId,
          actorId: req.auth.userId,
          action: "template.share",
          targetType: "template",
          targetId: template.id,
          detail: {
            name: template.name,
            owner: req.auth.userId,
            member: member.userId,
            memberEmail: member.email,
            outcome: created ? "shared" : "unchanged",
          },
        });
        return { templateId: template.id, name: template.name, sharedWith: member.email, created };
      } catch (error) {
        await auditRefusal(req.auth, "template.share", req.params, error);
        throw error;
      }
    },
  );

  r.delete(
    "/templates/:id/shares/:email",
    { preHandler: [app.authenticate], schema: { params: ShareParams } },
    async (req) => {
      const owner = { orgId: req.auth.orgId, userId: req.auth.userId };
      try {
        const { template, removed, memberUserId, pods, jobsPaused } = await unshareTemplate(
          owner,
          req.params.id,
          req.params.email,
        );
        await audit({
          orgId: req.auth.orgId,
          actorId: req.auth.userId,
          action: "template.unshare",
          targetType: "template",
          targetId: template.id,
          detail: {
            name: template.name,
            owner: req.auth.userId,
            ...(memberUserId ? { member: memberUserId } : {}),
            memberEmail: req.params.email,
            outcome: removed ? "removed" : "absent",
            podsRemaining: pods.total,
            podsRunning: pods.running,
            ...(jobsPaused > 0 ? { jobsPaused } : {}),
          },
        });
        return { templateId: template.id, name: template.name, member: req.params.email, removed, pods, jobsPaused };
      } catch (error) {
        await auditRefusal(req.auth, "template.unshare", req.params, error);
        throw error;
      }
    },
  );
}

/** A refused share or unshare is audited too: who tried, on which template, and why not. */
async function auditRefusal(
  auth: AuthContext,
  action: "template.share" | "template.unshare",
  params: { id: string; email: string },
  error: unknown,
): Promise<void> {
  if (!(error instanceof HttpError)) return;
  await audit({
    orgId: auth.orgId,
    actorId: auth.userId,
    action,
    targetType: "template",
    targetId: params.id,
    detail: { memberEmail: params.email, outcome: "refused", reason: error.message },
  }).catch(() => {});
}
