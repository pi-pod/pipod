import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { registerJobRoutes } from "../src/server/jobs/routes.js";
import { jobIncludesUserBundle, normalizeJobTrigger, type JobTrigger } from "../src/server/jobs/store.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { putSecret, resolveSecrets } from "../src/server/secrets/store.js";
import { resolveSettings, writeLayer } from "../src/server/settings/merge.js";
import { claimDueRuns } from "../src/server/workers/jobs.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
describe("finite job claiming (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'finite jobs test')", [
      orgId,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@example.test`,
    ]);
  });

  after(async () => {
    await query("DELETE FROM job_runs WHERE org_id = $1", [orgId]);
    await query("DELETE FROM jobs WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM job_runs WHERE org_id = $1", [orgId]);
    await query("DELETE FROM jobs WHERE org_id = $1", [orgId]);
  });

  async function makeDueJob(trigger: JobTrigger, scheduledAt: Date): Promise<string> {
    const id = uuidv7();
    await query(
      `INSERT INTO jobs (id, org_id, user_id, name, status, trigger, model, prompt, next_run_at)
       VALUES ($1, $2, $3, $4, 'active', $5, 'anthropic/test', 'test prompt', $6)`,
      [id, orgId, userId, `job-${id}`, JSON.stringify(trigger), scheduledAt],
    );
    return id;
  }

  it("atomically records the final occurrence and completes the job", async () => {
    const scheduledAt = new Date(Date.now() - 60_000);
    const trigger = normalizeJobTrigger({ type: "at", times: [scheduledAt.toISOString()] });
    const jobId = await makeDueJob(trigger, scheduledAt);

    const claims = await claimDueRuns(1);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.job.id, jobId);

    const job = await query<{ status: string; next_run_at: string | null }>(
      "SELECT status, next_run_at FROM jobs WHERE id = $1",
      [jobId],
    );
    assert.deepEqual(job.rows[0], { status: "completed", next_run_at: null });
    const runs = await query<{ id: string }>("SELECT id FROM job_runs WHERE job_id = $1", [jobId]);
    assert.equal(runs.rowCount, 1);

    // Execution outcome is history, not scheduling: even a failed final run must not revive
    // potentially non-idempotent work.
    await query(
      "UPDATE job_runs SET status = 'failed', error = 'manual failure', finished_at = now() WHERE id = $1",
      [runs.rows[0]!.id],
    );
    assert.equal((await query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [jobId])).rows[0]?.status, "completed");
  });

  it("skips an overdue backlog and advances to the next future absolute time", async () => {
    const first = new Date(Date.now() - 20 * 60_000);
    const missed = new Date(Date.now() - 10 * 60_000);
    const future = new Date(Date.now() + 10 * 60_000);
    const trigger = normalizeJobTrigger({
      type: "at",
      times: [first.toISOString(), missed.toISOString(), future.toISOString()],
    });
    const jobId = await makeDueJob(trigger, first);

    await claimDueRuns(1);
    const job = await query<{ status: string; next_run_at: Date }>(
      "SELECT status, next_run_at FROM jobs WHERE id = $1",
      [jobId],
    );
    assert.equal(job.rows[0]?.status, "active");
    assert.equal(new Date(job.rows[0]!.next_run_at).toISOString(), future.toISOString());
    const runs = await query("SELECT scheduled_at FROM job_runs WHERE job_id = $1", [jobId]);
    assert.equal(runs.rowCount, 1);
  });

  it("allows only one scheduler to claim the final occurrence", async () => {
    const scheduledAt = new Date(Date.now() - 60_000);
    const trigger = normalizeJobTrigger({ type: "at", times: [scheduledAt.toISOString()] });
    const jobId = await makeDueJob(trigger, scheduledAt);

    const attempts = await Promise.all([claimDueRuns(1), claimDueRuns(1), claimDueRuns(1), claimDueRuns(1)]);
    assert.equal(attempts.flat().filter((claim) => claim.job.id === jobId).length, 1);
    const runs = await query("SELECT id FROM job_runs WHERE job_id = $1", [jobId]);
    assert.equal(runs.rowCount, 1);
  });
});

describe("job routes without drafts (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  const podId = uuidv7();
  const kek = new EnvKekProvider("job-scope-kek", randomBytes(32).toString("base64"));
  let app: ReturnType<typeof Fastify>;
  let auth: {
    userId: string;
    email: string;
    orgId: string;
    permissions: string[];
    podId?: string;
  };

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'job routes test')", [
      orgId,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)", [
      userId,
      `${userId}@example.test`,
      otherUserId,
      `${otherUserId}@example.test`,
    ]);

    auth = {
      userId,
      email: `${userId}@example.test`,
      orgId,
      permissions: ["jobs:write"],
    };
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      req.auth = auth;
    });
    registerJobRoutes(app);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM job_runs WHERE org_id = $1", [orgId]);
    await query("DELETE FROM jobs WHERE org_id = $1", [orgId]);
    await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_templates WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = ANY($1::text[])", [[userId, otherUserId]]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM job_runs WHERE org_id = $1", [orgId]);
    await query("DELETE FROM jobs WHERE org_id = $1", [orgId]);
    await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_templates WHERE org_id = $1", [orgId]);
    auth = {
      userId,
      email: `${userId}@example.test`,
      orgId,
      permissions: ["jobs:write"],
    };
  });

  const jobBody = {
    name: "nightly-triage",
    description: "Triage new issues",
    trigger: { type: "cron" as const, cron: "0 6 * * *" },
    model: "anthropic/claude-opus-4-7",
    prompt: "Triage the new issues.",
  };

  it("defaults new jobs to user scope and exposes org jobs to other members", async () => {
    const personal = await app.inject({ method: "POST", url: "/jobs", payload: jobBody });
    assert.equal(personal.statusCode, 201, personal.body);
    const personalBody = personal.json() as { id: string; scope: string };
    assert.equal(personalBody.scope, "user");

    auth = {
      userId: otherUserId,
      email: `${otherUserId}@example.test`,
      orgId,
      permissions: ["jobs:write"],
    };
    const hiddenList = await app.inject({ method: "GET", url: "/jobs" });
    assert.equal(hiddenList.statusCode, 200, hiddenList.body);
    assert.deepEqual((hiddenList.json() as { jobs: unknown[] }).jobs, []);
    assert.equal((await app.inject({ method: "GET", url: `/jobs/${personalBody.id}` })).statusCode, 404);

    auth = {
      userId,
      email: `${userId}@example.test`,
      orgId,
      permissions: ["jobs:write"],
    };
    const shared = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { ...jobBody, name: "org-triage", scope: "org" },
    });
    assert.equal(shared.statusCode, 201, shared.body);
    const sharedBody = shared.json() as { id: string; scope: string };
    assert.equal(sharedBody.scope, "org");

    auth = {
      userId: otherUserId,
      email: `${otherUserId}@example.test`,
      orgId,
      permissions: ["jobs:write"],
    };
    const visibleList = await app.inject({ method: "GET", url: "/jobs" });
    assert.deepEqual(
      (visibleList.json() as { jobs: Array<{ id: string; scope: string }> }).jobs.map((job) => ({ id: job.id, scope: job.scope })),
      [{ id: sharedBody.id, scope: "org" }],
    );
    const visibleGet = await app.inject({ method: "GET", url: `/jobs/${sharedBody.id}` });
    assert.equal(visibleGet.statusCode, 200, visibleGet.body);
    assert.equal((visibleGet.json() as { scope: string }).scope, "org");
  });

  it("promotes a user job to org scope once and rejects demotion", async () => {
    const created = await app.inject({ method: "POST", url: "/jobs", payload: jobBody });
    const id = (created.json() as { id: string }).id;
    const promoted = await app.inject({ method: "PATCH", url: `/jobs/${id}`, payload: { scope: "org" } });
    assert.equal(promoted.statusCode, 200, promoted.body);
    assert.equal((promoted.json() as { scope: string }).scope, "org");

    const demoted = await app.inject({ method: "PATCH", url: `/jobs/${id}`, payload: { scope: "user" } });
    assert.equal(demoted.statusCode, 400, demoted.body);
    assert.match(demoted.body, /org job cannot be made personal/);
  });

  it("rejects org-job and user-template pairings on create, update, and promotion", async () => {
    const userTemplateId = uuidv7();
    const orgTemplateId = uuidv7();
    const otherUserTemplateId = uuidv7();
    await query(
      `INSERT INTO pod_templates (id, org_id, owner_user_id, name, created_by)
       VALUES ($1, $4, $5, 'personal-job-template', $5),
              ($2, $4, NULL, 'shared-job-template', $5),
              ($3, $4, $6, 'other-personal-job-template', $6)`,
      [userTemplateId, orgTemplateId, otherUserTemplateId, orgId, userId, otherUserId],
    );

    const invalidCreate = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { ...jobBody, name: "invalid-shared", scope: "org", templateId: userTemplateId },
    });
    assert.equal(invalidCreate.statusCode, 400, invalidCreate.body);
    assert.match(invalidCreate.body, /org-scoped job cannot reference a user-scoped template/);

    const personal = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { ...jobBody, name: "personal-template-job", templateId: userTemplateId },
    });
    assert.equal(personal.statusCode, 201, personal.body);
    const promotion = await app.inject({
      method: "PATCH",
      url: `/jobs/${(personal.json() as { id: string }).id}`,
      payload: { scope: "org" },
    });
    assert.equal(promotion.statusCode, 400, promotion.body);
    assert.match(promotion.body, /promote the template to org scope/);

    const shared = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { ...jobBody, name: "shared-template-job", scope: "org", templateId: orgTemplateId },
    });
    assert.equal(shared.statusCode, 201, shared.body);
    const invalidUpdate = await app.inject({
      method: "PATCH",
      url: `/jobs/${(shared.json() as { id: string }).id}`,
      payload: { templateId: userTemplateId },
    });
    assert.equal(invalidUpdate.statusCode, 400, invalidUpdate.body);
    assert.match(invalidUpdate.body, /org-scoped job cannot reference a user-scoped template/);

    auth = {
      userId: otherUserId,
      email: `${otherUserId}@example.test`,
      orgId,
      permissions: ["jobs:write"],
    };
    const invalidOtherMemberUpdate = await app.inject({
      method: "PATCH",
      url: `/jobs/${(shared.json() as { id: string }).id}`,
      payload: { templateId: otherUserTemplateId },
    });
    assert.equal(invalidOtherMemberUpdate.statusCode, 400, invalidOtherMemberUpdate.body);
    assert.match(invalidOtherMemberUpdate.body, /org-scoped job cannot reference a user-scoped template/);
  });

  it("uses the owning user's settings and secrets only when a user-scoped job fires", async () => {
    await writeLayer({
      scopeType: "org_defaults",
      scopeId: orgId,
      orgId,
      config: { idleTimeoutMinutes: 20 },
      initScript: "echo org-init",
      bakeScript: "echo org-bake",
      expectedVersion: 0,
      updatedBy: userId,
    });
    await writeLayer({
      scopeType: "user_defaults",
      scopeId: userId,
      orgId,
      config: { idleTimeoutMinutes: 7 },
      initScript: "echo user-init",
      bakeScript: "echo user-bake",
      expectedVersion: 0,
      updatedBy: userId,
    });
    await putSecret({ kek, orgId, scopeType: "org", scopeId: orgId, name: "ORG_VALUE", value: "org", createdBy: userId });
    await putSecret({ kek, orgId, scopeType: "user", scopeId: userId, name: "USER_VALUE", value: "user", createdBy: userId });

    const resolveFor = async (scope: "user" | "org") => {
      const includeUserLayer = jobIncludesUserBundle({ scope });
      return Promise.all([
        resolveSettings({ orgId, userId, includeUserLayer, templateScope: null }),
        resolveSecrets({ kek, orgId, userId, includeUserLayer, templateId: null }),
      ]);
    };

    const [personalSettings, personalSecrets] = await resolveFor("user");
    assert.equal(personalSettings.config.idleTimeoutMinutes, 7);
    assert.deepEqual(personalSettings.layerOrder, ["org", "user"]);
    assert.equal(personalSettings.initScripts.user, "echo user-init");
    assert.equal(personalSettings.bakeScripts.user, "echo user-bake");
    assert.deepEqual(personalSecrets.env, { ORG_VALUE: "org", USER_VALUE: "user" });

    const [sharedSettings, sharedSecrets] = await resolveFor("org");
    assert.equal(sharedSettings.config.idleTimeoutMinutes, 20);
    assert.deepEqual(sharedSettings.layerOrder, ["org"]);
    assert.equal(sharedSettings.initScripts.user, "");
    assert.equal(sharedSettings.bakeScripts.user, "");
    assert.deepEqual(sharedSecrets.env, { ORG_VALUE: "org" });
  });

  it("creates pod-authored jobs as active with a next run", async () => {
    auth = { ...auth, podId, permissions: [] };
    const response = await app.inject({ method: "POST", url: "/jobs", payload: { ...jobBody, name: "from-pod" } });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json() as { status: string; nextRunAt: string | null; createdFromPod: string | null };
    assert.equal(body.status, "active");
    assert.ok(body.nextRunAt);
    assert.equal(body.createdFromPod, podId);
  });

  it("forbids a pod token from PATCHing a job it created", async () => {
    auth = { ...auth, podId, permissions: [] };
    const created = await app.inject({ method: "POST", url: "/jobs", payload: { ...jobBody, name: "pod-owned" } });
    assert.equal(created.statusCode, 201, created.body);
    const id = (created.json() as { id: string }).id;
    const patched = await app.inject({
      method: "PATCH",
      url: `/jobs/${id}`,
      payload: { prompt: "changed" },
    });
    assert.equal(patched.statusCode, 403, patched.body);
  });

  it("treats activate as a resume alias for paused and completed jobs", async () => {
    const created = await app.inject({ method: "POST", url: "/jobs", payload: jobBody });
    assert.equal(created.statusCode, 201, created.body);
    const id = (created.json() as { id: string }).id;

    const paused = await app.inject({ method: "POST", url: `/jobs/${id}/pause` });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal((paused.json() as { status: string }).status, "paused");

    const activated = await app.inject({ method: "POST", url: `/jobs/${id}/activate` });
    assert.equal(activated.statusCode, 200, activated.body);
    assert.equal((activated.json() as { status: string }).status, "active");

    await query("UPDATE jobs SET status = 'completed', next_run_at = NULL WHERE id = $1", [id]);
    const resumed = await app.inject({ method: "POST", url: `/jobs/${id}/resume` });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal((resumed.json() as { status: string }).status, "active");
  });

  it("converts leftover draft rows to paused, then rejects draft as a status", async () => {
    await query("ALTER TABLE jobs DROP CONSTRAINT jobs_status_check");
    const id = uuidv7();
    await query(
      `INSERT INTO jobs (id, org_id, user_id, name, status, trigger, model, prompt)
       VALUES ($1, $2, $3, 'legacy-draft', 'draft', $4, 'anthropic/test', 'prompt')`,
      [id, orgId, userId, JSON.stringify({ type: "cron", cron: "0 6 * * *" })],
    );
    await query("UPDATE jobs SET status = 'paused', updated_at = now() WHERE status = 'draft'");
    await query(
      `ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
       CHECK (status IN ('active', 'paused', 'completed'))`,
    );
    const converted = await query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [id]);
    assert.equal(converted.rows[0]?.status, "paused");
    await assert.rejects(
      () =>
        query(
          `INSERT INTO jobs (id, org_id, user_id, name, status, trigger, model, prompt)
           VALUES ($1, $2, $3, 'still-draft', 'draft', $4, 'anthropic/test', 'prompt')`,
          [uuidv7(), orgId, userId, JSON.stringify({ type: "cron", cron: "0 6 * * *" })],
        ),
      /jobs_status_check/,
    );
  });
});

