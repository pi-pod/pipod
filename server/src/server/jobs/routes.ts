import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requirePermission, type AuthContext } from "../auth/plugin.js";
import { audit } from "../audit.js";
import { query, tx, type Queryable } from "../db/index.js";
import { badRequest, forbidden, conflict, notFound } from "../httperrors.js";
import { uuidv7 } from "../ids.js";
import { readLayer } from "../settings/merge.js";
import { nestedPodsPolicy } from "../pods/lineage.js";
import {
  assertJobScopeChange,
  assertJobTemplateScope,
  getJob,
  nextOccurrenceAt,
  normalizeJobTrigger,
  parseModelRef,
  MAX_AT_TIMES,
  type JobRow,
  type JobRunRow,
  type JobScope,
  type JobTrigger,
  type JobStatus,
} from "./store.js";

// Strict for the same reason templates are: an agent that misspells a field must hear about
// it, not author a job it did not intend (spec §8.5).
const JobTriggerBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), cron: z.string().max(200) }).strict(),
  z.object({
    type: z.literal("at"),
    times: z.array(z.string().datetime({ offset: true })).min(1).max(MAX_AT_TIMES),
  }).strict(),
]);

const JobBody = z
  .object({
    // `pipod jobs pull` writes <name>.json and <name>.prompt.md: a name is a file name.
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/, "use letters, digits, '.', '_', '-' and spaces")
      .refine((name) => !name.includes(".."), "must not contain '..'"),
    description: z.string().max(2000).optional(),
    // Personal by default; PATCH scope="org" is the one-way share operation.
    scope: z.enum(["user", "org"]).optional(),
    trigger: JobTriggerBody,
    /** Null or absent = the built-in default template, as for pod launches. */
    templateId: z.string().uuid().nullable().optional(),
    model: z.string().min(1).max(200),
    prompt: z.string().min(1).max(64 * 1024),
  })
  .strict();

function toApi(row: JobRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    scope: row.scope,
    trigger: row.trigger,
    templateId: row.template_id,
    model: row.model,
    prompt: row.prompt,
    createdFromPod: row.created_from_pod,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Job mutations are account-only. The local file is the editing surface; a pod that wants
 * to change a job it created recreates it or tells the user. `row` is accepted so callers
 * keep the locked-row authorization shape.
 */
/**
 * A job runs as its creator, with the creator's model credentials, so changing what someone
 * else's org job runs is an org-management act. Its template is held to the same bar.
 */
function assertJobWrite(auth: AuthContext, row: Pick<JobRow, "scope" | "user_id">): void {
  if (auth.podId) {
    throw forbidden("pod tokens cannot modify jobs");
  }
  requirePermission(auth, "jobs:write");
  if (row.scope === "org" && row.user_id !== auth.userId) requirePermission(auth, "org:manage");
}

type JobCommand = "activate" | "pause" | "resume";

/** Job transitions are account-only. `activate` stays as an alias of `resume` so older
 * CLIs and the iOS app keep working. `row` and `command` stay on the signature so the
 * locked-row authorization shape does not change.
 */
export function assertJobTransition(
  auth: AuthContext,
  row: Pick<JobRow, "status" | "created_from_pod" | "scope" | "user_id">,
  _command: JobCommand,
): void {
  if (auth.podId) throw forbidden("pod tokens cannot change job status");
  assertJobWrite(auth, row);
}

/** Hold a share lock through the job write so template archival cannot race the write,
 * and validate the job/template scope pairing while both definitions are stable. */
async function lockTemplateForJob(
  client: Queryable,
  args: {
    orgId: string;
    templateId: string;
    userId: string;
    jobScope: JobScope;
    activeDefinition: boolean;
  },
): Promise<void> {
  const rows = await client.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id FROM pod_templates
     WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
       AND (owner_user_id IS NULL OR owner_user_id = $3)
     FOR SHARE`,
    [args.templateId, args.orgId, args.userId],
  );
  const template = rows.rows[0];
  if (!template) {
    if (args.activeDefinition) {
      throw conflict("template is archived — pick another before creating or resuming the job");
    }
    throw notFound("template not found");
  }
  assertJobTemplateScope(args.jobScope, template.owner_user_id === null ? "org" : "user");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

async function databaseNow(client: Queryable): Promise<Date> {
  const result = await client.query<{ now: string | Date }>("SELECT now() AS now");
  return new Date(result.rows[0]!.now);
}

function requireFutureOccurrence(trigger: JobTrigger, now: Date): Date {
  const next = nextOccurrenceAt(trigger, now);
  if (!next) throw badRequest("this schedule has no future occurrences");
  return next;
}

export function registerJobRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/jobs",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
          before: z.string().datetime({ offset: true }).optional(),
          beforeId: z.string().uuid().optional(),
        }),
      },
    },
    async (req) => {
      const rows = await query<JobRow>(
        `SELECT * FROM jobs WHERE org_id = $1 AND archived_at IS NULL
           AND (scope = 'org' OR user_id = $2)
           AND ($3::timestamptz IS NULL
             OR ($4::uuid IS NULL AND created_at < $3)
             OR ($4::uuid IS NOT NULL AND (created_at, id) < ($3, $4)))
         ORDER BY created_at DESC, id DESC LIMIT $5`,
        [
          req.auth.orgId,
          req.auth.userId,
          req.query.before ?? null,
          req.query.beforeId ?? null,
          req.query.limit,
        ],
      );
      return { jobs: rows.rows.map(toApi) };
    },
  );

  r.post(
    "/jobs",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { body: JobBody },
    },
    async (req, reply) => {
      if (!req.auth.podId) requirePermission(req.auth, "jobs:write");
      else {
        if (req.body.scope === "org") throw forbidden("pod tokens may only create personal jobs");
        // A pod's job launches pods later on its behalf: the same policy as launching them now.
        const policy = await readLayer("org_policy", req.auth.orgId, req.auth.orgId);
        if (!nestedPodsPolicy(policy.config ?? {}).enabled) {
          throw forbidden("org policy nestedPods.enabled is false: pods may not schedule jobs");
        }
      }
      const trigger = normalizeJobTrigger(req.body.trigger);
      parseModelRef(req.body.model);
      // Creation always lands active with a validated future occurrence, for user tokens
      // and pod tokens alike. A referenced template must already be active.
      const status = "active";
      const scope = req.body.scope ?? "user";
      const id = uuidv7();
      const conflictTarget = scope === "user"
        ? "(org_id, user_id, name) WHERE archived_at IS NULL AND scope = 'user'"
        : "(org_id, name) WHERE archived_at IS NULL AND scope = 'org'";
      const inserted = await tx(async (client) => {
        if (req.body.templateId) {
          await lockTemplateForJob(client, {
            orgId: req.auth.orgId,
            templateId: req.body.templateId,
            userId: req.auth.userId,
            jobScope: scope,
            activeDefinition: true,
          });
        }
        const nextRunAt = requireFutureOccurrence(trigger, await databaseNow(client));
        return client.query<JobRow>(
          `INSERT INTO jobs (id, org_id, user_id, name, description, status, trigger, template_id, model, prompt, created_from_pod, next_run_at, scope)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT ${conflictTarget} DO NOTHING
           RETURNING *`,
          [
            id,
            req.auth.orgId,
            req.auth.userId,
            req.body.name.trim(),
            req.body.description ?? null,
            status,
            JSON.stringify(trigger),
            req.body.templateId ?? null,
            req.body.model,
            req.body.prompt,
            req.auth.podId ?? null,
            nextRunAt,
            scope,
          ],
        );
      });
      const row = inserted.rows[0];
      if (!row) {
        throw conflict(
          scope === "user"
            ? "you already have a job with this name"
            : "a job with this name already exists in the org",
        );
      }
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "job.create",
        targetType: "job",
        targetId: id,
        detail: { name: row.name, status, scope, ...(req.auth.podId ? { createdFromPod: req.auth.podId } : {}) },
      });
      return reply.code(201).send(toApi(row));
    },
  );

  r.get(
    "/jobs/:id",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => toApi(await getJob(req.auth.orgId, req.auth.userId, req.params.id)),
  );

  r.get(
    "/jobs/:id/runs",
    {
      preHandler: [app.authenticate],
      config: { allowPodToken: true },
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
    },
    async (req) => {
      const job = await getJob(req.auth.orgId, req.auth.userId, req.params.id);
      const rows = await query<JobRunRow>(
        "SELECT * FROM job_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT $2",
        [job.id, req.query.limit],
      );
      return {
        runs: rows.rows.map((run) => ({
          id: run.id,
          podId: run.pod_id,
          scheduledAt: run.scheduled_at,
          status: run.status,
          error: run.error,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
        })),
      };
    },
  );

  r.patch(
    "/jobs/:id",
    {
      preHandler: [app.authenticate],
      schema: { params: z.object({ id: z.string().uuid() }), body: JobBody.partial() },
    },
    async (req) => {
      const trigger = req.body.trigger ? normalizeJobTrigger(req.body.trigger) : undefined;
      if (req.body.model) parseModelRef(req.body.model);
      let sharedWithOrg = false;
      const row = await tx(async (client) => {
        const locked = await client.query<JobRow>(
          `SELECT * FROM jobs
           WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
             AND (scope = 'org' OR user_id = $3)
           FOR UPDATE`,
          [req.params.id, req.auth.orgId, req.auth.userId],
        );
        const existing = locked.rows[0];
        if (!existing) throw notFound("job not found");
        assertJobWrite(req.auth, existing);
        sharedWithOrg = assertJobScopeChange(existing, req.body.scope);
        const resultingScope: JobScope = sharedWithOrg ? "org" : existing.scope;
        const resultingTemplateId = req.body.templateId !== undefined
          ? req.body.templateId
          : existing.template_id;
        if (resultingTemplateId && (req.body.templateId !== undefined || req.body.scope !== undefined)) {
          await lockTemplateForJob(client, {
            orgId: req.auth.orgId,
            templateId: resultingTemplateId,
            userId: req.auth.userId,
            jobScope: resultingScope,
            activeDefinition: existing.status === "active",
          });
        }
        const nextRunAt = trigger && existing.status === "active"
          ? requireFutureOccurrence(trigger, await databaseNow(client))
          : null;
        const updated = await client.query<JobRow>(
          `UPDATE jobs SET
             name = COALESCE($3, name),
             description = COALESCE($4, description),
             trigger = COALESCE($5, trigger),
             template_id = CASE WHEN $6 THEN $7 ELSE template_id END,
             model = COALESCE($8, model),
             prompt = COALESCE($9, prompt),
             next_run_at = CASE WHEN status = 'active' AND $10 THEN $11::timestamptz ELSE next_run_at END,
             scope = CASE WHEN $12 THEN 'org' ELSE scope END,
             updated_at = now()
           WHERE id = $1 AND org_id = $2 RETURNING *`,
          [
            req.params.id,
            req.auth.orgId,
            req.body.name?.trim() ?? null,
            req.body.description ?? null,
            trigger ? JSON.stringify(trigger) : null,
            req.body.templateId !== undefined,
            req.body.templateId ?? null,
            req.body.model ?? null,
            req.body.prompt ?? null,
            trigger !== undefined,
            nextRunAt,
            sharedWithOrg,
          ],
        ).catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw conflict(
              sharedWithOrg
                ? "a job with this name already exists in the org — rename yours before sharing it"
                : "a job with this name already exists",
            );
          }
          throw error;
        });
        return updated.rows[0]!;
      });
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "job.update",
        targetType: "job",
        targetId: row.id,
        detail: {
          ...(sharedWithOrg ? { sharedWithOrg: true } : {}),
          ...(req.auth.podId ? { fromPod: req.auth.podId } : {}),
        },
      });
      return toApi(row);
    },
  );

  // `activate` is an alias of `resume` so older CLIs and the iOS app keep working.
  // Transitions are account-only.
  for (const [command, from] of [
    ["activate", ["paused", "completed"]],
    ["pause", ["active"]],
    ["resume", ["paused", "completed"]],
  ] as const) {
    r.post(
      `/jobs/:id/${command}`,
      {
        preHandler: [app.authenticate],
        schema: { params: z.object({ id: z.string().uuid() }) },
      },
      async (req) => {
        const transition = await tx(async (client) => {
          const locked = await client.query<JobRow>(
            `SELECT * FROM jobs
             WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
               AND (scope = 'org' OR user_id = $3)
             FOR UPDATE`,
            [req.params.id, req.auth.orgId, req.auth.userId],
          );
          const existing = locked.rows[0];
          if (!existing) throw notFound("job not found");
          assertJobTransition(req.auth, existing, command);
          if (command === "activate" && existing.status === "active") {
            return { job: existing, status: existing.status, changed: false };
          }
          if (!(from as readonly string[]).includes(existing.status)) {
            throw badRequest(`cannot ${command} a ${existing.status} job`);
          }

          let status: JobStatus;
          let nextRunAt: Date | null;
          if (command === "pause") {
            status = "paused";
            nextRunAt = null;
          } else {
            nextRunAt = nextOccurrenceAt(existing.trigger, await databaseNow(client));
            if (!nextRunAt) {
              throw badRequest("this schedule has no future occurrences");
            }
            if (nextRunAt && existing.template_id) {
              await lockTemplateForJob(client, {
                orgId: req.auth.orgId,
                templateId: existing.template_id,
                userId: existing.user_id,
                jobScope: existing.scope,
                activeDefinition: true,
              });
            }
            status = nextRunAt ? "active" : "completed";
          }
          await client.query(
            "UPDATE jobs SET status = $2, next_run_at = $3, updated_at = now() WHERE id = $1",
            [existing.id, status, nextRunAt],
          );
          return { job: existing, status, changed: true };
        });
        if (transition.changed) {
          await audit({
            orgId: req.auth.orgId,
            actorId: req.auth.userId,
            action: `job.${command}`,
            targetType: "job",
            targetId: transition.job.id,
            detail: {},
          });
        }
        return { id: transition.job.id, status: transition.status };
      },
    );
  }

  r.delete(
    "/jobs/:id",
    { preHandler: [app.authenticate], schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const rows = await tx(async (client) => {
        const locked = await client.query<JobRow>(
          `SELECT * FROM jobs
           WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
             AND (scope = 'org' OR user_id = $3)
           FOR UPDATE`,
          [req.params.id, req.auth.orgId, req.auth.userId],
        );
        const existing = locked.rows[0];
        if (!existing) throw notFound("job not found");
        assertJobWrite(req.auth, existing);
        return client.query("UPDATE jobs SET archived_at = now(), updated_at = now() WHERE id = $1", [existing.id]);
      });
      if ((rows.rowCount ?? 0) === 0) throw notFound("job not found");
      await audit({
        orgId: req.auth.orgId,
        actorId: req.auth.userId,
        action: "job.archive",
        targetType: "job",
        targetId: req.params.id,
      });
      return reply.code(204).send();
    },
  );
}
