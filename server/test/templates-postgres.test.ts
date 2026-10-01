import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  LEGACY_PROJECT_LAYERS_WARNING,
  TEMPLATE_PROJECT_PREVIEW_WARNING,
  planPodLaunch,
  type PodServiceDeps,
} from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { registerSecretRoutes } from "../src/server/secrets/routes.js";
import { putSecret } from "../src/server/secrets/store.js";
import { RETIRED_POLICY_WARNING, writeLayer } from "../src/server/settings/merge.js";
import { registerTemplateRoutes } from "../src/server/templates/routes.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("template Pi settings custody (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("template-settings-kek", randomBytes(32).toString("base64"));
  let app: ReturnType<typeof Fastify>;

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'template settings test')", [
      orgId,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@example.test`,
    ]);

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      req.auth = {
        userId,
        email: `${userId}@example.test`,
        orgId,
        permissions: ["templates:write"],
      };
    });
    registerTemplateRoutes(app);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_templates WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_templates WHERE org_id = $1", [orgId]);
    await query("DELETE FROM settings WHERE org_id = $1", [orgId]);
  });

  async function createTemplate(
    name: string,
    piSettings?: Record<string, unknown>,
    settings: { config?: Record<string, unknown>; initScript?: string; bakeScript?: string; scope?: "user" | "org" } = {},
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/templates",
      payload: { name, ...settings, ...(piSettings === undefined ? {} : { piSettings }) },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { id: string; piSettings: Record<string, unknown>; version: number };
  }

  it("defaults, persists, replaces, and explicitly clears the sanitized bundle", async () => {
    const omitted = await createTemplate("omitted");
    assert.deepEqual(omitted.piSettings, {});

    const created = await createTemplate("custody", {
      settings: { theme: "template", hooks: { stop: "forbidden" }, packages: ["npm:private-source"] },
      models: { providers: { app: { apiKey: "$APP_KEY" }, safe: { apiKey: "$SAFE_KEY" } } },
    });
    assert.deepEqual(created.piSettings, {
      models: { providers: { app: { apiKey: "$APP_KEY" }, safe: { apiKey: "$SAFE_KEY" } } },
      settings: { packages: ["npm:private-source"], theme: "template" },
    });

    // Bundles are readable configuration: a literal where a $REFERENCE belongs is refused
    // with scope/path only, never the value.
    const rejected = await app.inject({
      method: "POST",
      url: "/templates",
      payload: {
        name: "leaky",
        piSettings: { models: { providers: { unsafe: { apiKey: "literal-secret" } } } },
      },
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.match(rejected.body, /literal credentials/);
    assert.match(rejected.body, /providers\.unsafe\.apiKey/);
    assert.doesNotMatch(rejected.body, /literal-secret/);

    const persisted = await query<{ pi_settings: Record<string, unknown> }>(
      "SELECT pi_settings FROM pod_templates WHERE id = $1",
      [created.id],
    );
    assert.deepEqual(persisted.rows[0]!.pi_settings, created.piSettings);

    const omittedPatch = await app.inject({
      method: "PATCH",
      url: `/templates/${created.id}`,
      payload: { description: "keep settings" },
    });
    assert.equal(omittedPatch.statusCode, 200, omittedPatch.body);
    assert.deepEqual(omittedPatch.json().piSettings, created.piSettings);

    const replacement = { settings: { theme: "replacement" } };
    const replaced = await app.inject({
      method: "PATCH",
      url: `/templates/${created.id}`,
      payload: { initScript: "echo replaced", config: { workdir: "/work" }, piSettings: replacement },
    });
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.deepEqual(replaced.json().piSettings, { settings: { theme: "replacement" } });

    const cleared = await app.inject({
      method: "PATCH",
      url: `/templates/${created.id}`,
      payload: { piSettings: {} },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(cleared.json().piSettings, {});
    assert.deepEqual(
      (await query<{ pi_settings: Record<string, unknown> }>(
        "SELECT pi_settings FROM pod_templates WHERE id = $1",
        [created.id],
      )).rows[0]!.pi_settings,
      {},
    );

    const audits = await query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM audit_log WHERE org_id = $1 ORDER BY created_at",
      [orgId],
    );
    assert.equal(JSON.stringify(audits.rows).includes("npm:private-source"), false);
    assert.equal(JSON.stringify(audits.rows).includes("literal-secret"), false);
  });

  it("accepts flat writes, rejects legacy nested writes, and flattens legacy rows at read time", async () => {
    const flat = await createTemplate("flat", {
      settings: { theme: "flat" },
      models: { providers: { custom: { apiKey: "$CUSTOM_KEY" } } },
    });
    assert.deepEqual(flat.piSettings, {
      models: { providers: { custom: { apiKey: "$CUSTOM_KEY" } } },
      settings: { theme: "flat" },
    });

    const legacyWrite = await app.inject({
      method: "POST",
      url: "/templates",
      payload: {
        name: "legacy-shape",
        piSettings: { user: { settings: { theme: "user" } } },
      },
    });
    assert.equal(legacyWrite.statusCode, 400, legacyWrite.body);
    assert.match(legacyWrite.body, /legacy \{user, project\} shape/);

    await query(
      "UPDATE pod_templates SET pi_settings = $2 WHERE id = $1",
      [flat.id, JSON.stringify({
        user: { settings: { theme: "user", packages: ["npm:user"] }, agents: { "same.md": "user" } },
        project: { settings: { theme: "project", packages: ["npm:project"] }, agents: { "same.md": "project" } },
      })],
    );
    const response = await app.inject({ method: "GET", url: `/templates/${flat.id}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().piSettings, {
      agents: { "same.md": "project" },
      settings: { theme: "project", packages: ["npm:user", "npm:project"] },
    });
    const stored = await query<{ pi_settings: Record<string, unknown> }>(
      "SELECT pi_settings FROM pod_templates WHERE id = $1",
      [flat.id],
    );
    assert.ok(Object.hasOwn(stored.rows[0]!.pi_settings, "user"));
  });

  it("serves a template row written before the schema shed keys without them", async () => {
    const template = await createTemplate("legacy-config", undefined, { config: { workdir: "/work" } });
    await query(
      "UPDATE pod_templates SET config = $2 WHERE id = $1",
      [template.id, JSON.stringify({
        repo: "github.com/example/app",
        autoStopOnExit: true,
        orphanTtlMinutes: 240,
        stopTimeoutSeconds: 300,
        envFile: "custom/env",
        template: "team-default",
        reuse: true,
        workdir: "/work",
        pi: {
          version: "latest",
          shellOnExit: true,
          detachSequence: "C-p C-q",
          detachStopSequence: "C-p C-s",
          detachArchiveSequence: "C-p C-a",
          hostConfig: { skills: ["review"], extensions: ["ext"] },
        },
      })],
    );

    // `pipod pull` writes this into a project's config.json, where a current CLI would then
    // warn about every retired key on every command it runs.
    const read = await app.inject({ method: "GET", url: `/templates/${template.id}` });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json().config, { workdir: "/work" });
    const listed = await app.inject({ method: "GET", url: "/templates" });
    assert.deepEqual(
      (listed.json().templates as Array<{ id: string; config: unknown }>)
        .find((row) => row.id === template.id)?.config,
      { workdir: "/work" },
    );
    // The row keeps what it was written with; only what leaves the server is projected.
    const stored = await query<{ config: Record<string, unknown> }>(
      "SELECT config FROM pod_templates WHERE id = $1",
      [template.id],
    );
    assert.equal(stored.rows[0]!.config["repo"], "github.com/example/app");
  });

  it("materializes the stored flat Pi bundle and ignores request Pi files", async () => {
    const created = await createTemplate(
      "launch-source",
      {
        settings: { theme: "template", packages: ["npm:template-tool"] },
        subagents: { maxConcurrent: 3 },
      },
      {
        config: { idleTimeoutMinutes: 20, pi: { model: "template-model" } },
        initScript: "echo template",
      },
    );
    const deps = {
      env: { PI_POD_SANDBOX_URL: "http://pi-pod-sandbox:8433" },
      kek,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as PodServiceDeps;
    await writeLayer({
      scopeType: "org_defaults",
      scopeId: orgId,
      orgId,
      config: {},
      piFiles: { settings: { theme: "org", packages: ["npm:org-tool"] } },
      expectedVersion: 0,
      updatedBy: userId,
    });
    await writeLayer({
      scopeType: "user_defaults",
      scopeId: userId,
      orgId,
      config: {},
      piFiles: { settings: { theme: "user", packages: ["npm:user-tool"] } },
      expectedVersion: 0,
      updatedBy: userId,
    });
    await putSecret({
      kek,
      orgId,
      scopeType: "org",
      scopeId: orgId,
      name: "PROJECT_TOKEN",
      value: "redacted-org-golden",
      createdBy: userId,
    });

    const plan = await planPodLaunch(deps, {
      orgId,
      userId,
      templateId: created.id,
      provider: "sandbox",
      project: {
        name: "project",
        config: { idleTimeoutMinutes: 40, pi: { model: "project-model" } },
        env: { PROJECT_TOKEN: "redacted-by-golden" },
        initScript: "echo project",
      },
      piSettingsRaw: {
        user: { settings: { theme: "request", packages: ["npm:request-tool"] } },
      },
    });

    assert.equal(plan.piSettings?.files.settings?.["theme"], "template");
    assert.deepEqual(plan.piSettings?.plan.packages, [
      "npm:org-tool",
      "npm:user-tool",
      "npm:template-tool",
    ]);
    assert.deepEqual(plan.piSettings?.projectUploads, []);
    assert.deepEqual(plan.piSettings?.files.subagents, { maxConcurrent: 3 });
    assert.ok(plan.report.warnings.includes(LEGACY_PROJECT_LAYERS_WARNING));

    const launchReportGolden = JSON.parse(
      readFileSync(new URL("./goldens/unified-settings-launch-report.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(
      {
        configProvenance: plan.report.configProvenance,
        layerOrder: plan.report.layerOrder,
        initSteps: plan.report.initSteps,
        secretKeys: plan.report.secretKeys,
        secretScopes: plan.report.secretScopes,
        ...(plan.report.secretShadows ? { secretShadows: plan.report.secretShadows } : {}),
        piSettings: plan.report.piSettings && {
          files: plan.report.piSettings.files,
          packageCount: plan.report.piSettings.packageCount,
          droppedKeys: plan.report.piSettings.droppedKeys,
          status: plan.report.piSettings.status,
        },
      },
      launchReportGolden,
    );
    assert.equal(JSON.stringify(plan.report).includes("redacted-by-golden"), false);
    assert.equal(JSON.stringify(plan.report).includes("redacted-org-golden"), false);
    assert.equal(JSON.stringify(launchReportGolden).includes("redacted-by-golden"), false);
    assert.equal(JSON.stringify(launchReportGolden).includes("redacted-org-golden"), false);
  });

  it("resolves config and scripts in the selected template's scope slot", async () => {
    await writeLayer({
      scopeType: "org_defaults",
      scopeId: orgId,
      orgId,
      config: { pi: { model: "org" } },
      initScript: "echo org init",
      bakeScript: "echo org bake",
      expectedVersion: 0,
      updatedBy: userId,
    });
    await writeLayer({
      scopeType: "user_defaults",
      scopeId: userId,
      orgId,
      config: { pi: { model: "user" } },
      initScript: "echo user init",
      bakeScript: "echo user bake",
      expectedVersion: 0,
      updatedBy: userId,
    });
    const personal = await createTemplate("personal-chain", undefined, {
      config: { pi: { model: "personal-template" } },
      initScript: "echo personal init",
      bakeScript: "echo personal bake",
    });
    const shared = await createTemplate("org-chain", undefined, {
      scope: "org",
      config: { pi: { model: "org-template" } },
      initScript: "echo org-template init",
      bakeScript: "echo org-template bake",
    });
    const deps = {
      env: { PI_POD_SANDBOX_URL: "http://pi-pod-sandbox:8433" },
      kek,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as PodServiceDeps;

    const personalPlan = await planPodLaunch(deps, {
      orgId,
      userId,
      templateId: personal.id,
      provider: "sandbox",
      project: {
        name: "project",
        config: { pi: { model: "project" } },
        env: {},
        initScript: "echo project init",
        bakeScript: "echo project bake",
      },
    });
    assert.deepEqual(personalPlan.report.layerOrder, ["org", "user", "template"]);
    assert.equal(personalPlan.config.pi.model, "personal-template");
    assert.deepEqual(personalPlan.initSteps.map((step) => step.scope), ["org", "user", "template"]);
    assert.ok(personalPlan.bakeScript.indexOf("echo org bake") < personalPlan.bakeScript.indexOf("echo user bake"));
    assert.ok(personalPlan.bakeScript.indexOf("echo user bake") < personalPlan.bakeScript.indexOf("echo personal bake"));
    assert.equal(personalPlan.bakeScript.includes("echo project bake"), false);
    assert.ok(personalPlan.report.warnings.includes(LEGACY_PROJECT_LAYERS_WARNING));

    const sharedPlan = await planPodLaunch(deps, {
      orgId,
      userId,
      templateId: shared.id,
      provider: "sandbox",
    });
    assert.deepEqual(sharedPlan.report.layerOrder, ["org", "template", "user"]);
    assert.equal(sharedPlan.config.pi.model, "user");
    assert.deepEqual(sharedPlan.initSteps.map((step) => step.scope), ["org", "template", "user"]);
    assert.ok(sharedPlan.bakeScript.indexOf("echo org bake") < sharedPlan.bakeScript.indexOf("echo org-template bake"));
    assert.ok(sharedPlan.bakeScript.indexOf("echo org-template bake") < sharedPlan.bakeScript.indexOf("echo user bake"));

    const previewPlan = await planPodLaunch(deps, {
      orgId,
      userId,
      templateId: personal.id,
      provider: "sandbox",
      projectConfigRaw: { pi: { model: "bootstrap-preview" } },
    });
    assert.equal(previewPlan.config.pi.model, "bootstrap-preview");
    assert.deepEqual(previewPlan.report.layerOrder, ["org", "user", "template", "project"]);
    assert.ok(previewPlan.report.warnings.includes(TEMPLATE_PROJECT_PREVIEW_WARNING));
  });

  it("strips retired stored policy keys, warns, and keeps requireTemplate", async () => {
    const created = await createTemplate("policy-source");
    const deps = {
      env: { PI_POD_SANDBOX_URL: "http://pi-pod-sandbox:8433" },
      kek: {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as PodServiceDeps;

    await query(
      `INSERT INTO settings (id, scope_type, scope_id, org_id, config, version, updated_by)
       VALUES (gen_random_uuid(), 'org_policy', $1, $1, $2, 1, $3)`,
      [orgId, JSON.stringify({ allowProjectLayer: false, requireTemplate: true }), userId],
    );
    const plan = await planPodLaunch(deps, {
      orgId,
      userId,
      templateId: created.id,
      provider: "sandbox",
      projectEnv: { PROJECT_ONLY: "ignored" },
    });
    assert.ok(plan.report.warnings.includes(RETIRED_POLICY_WARNING));
    assert.ok(plan.report.warnings.includes(LEGACY_PROJECT_LAYERS_WARNING));
    assert.equal(plan.podEnv["PROJECT_ONLY"], undefined);

    await assert.rejects(
      () => writeLayer({
        scopeType: "org_policy",
        scopeId: orgId,
        orgId,
        config: { allowProjectLayer: false },
        expectedVersion: 1,
        updatedBy: userId,
      }),
      /invalid policy/,
    );
    await assert.rejects(
      () => planPodLaunch(deps, { orgId, userId, provider: "sandbox" }),
      /requireTemplate requires a selected template/,
    );
  });

  it("starts at version 1 and bumps on every content update", async () => {
    const created = await createTemplate("versioned");
    assert.equal(created.version, 1);

    const listed = await app.inject({ method: "GET", url: "/templates" });
    assert.equal(listed.statusCode, 200, listed.body);
    const listedRow = (listed.json() as { templates: Array<{ id: string; version: number }> }).templates.find(
      (row) => row.id === created.id,
    );
    assert.equal(listedRow?.version, 1);

    const patched = await app.inject({
      method: "PATCH",
      url: `/templates/${created.id}`,
      payload: { description: "first edit" },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().version, 2);
    assert.equal(patched.json().description, "first edit");

    const put = await app.inject({
      method: "PUT",
      url: `/templates/${created.id}`,
      payload: { initScript: "echo v3" },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().version, 3);
    assert.equal(put.json().initScript, "echo v3");

    const fetched = await app.inject({ method: "GET", url: `/templates/${created.id}` });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.equal(fetched.json().version, 3);
  });

  it("CAS expectedVersion conflicts with 409; omitting it is last-write-wins", async () => {
    const created = await createTemplate("cas");
    assert.equal(created.version, 1);

    const matched = await app.inject({
      method: "PATCH",
      url: `/templates/${created.id}`,
      payload: { description: "matched", expectedVersion: 1 },
    });
    assert.equal(matched.statusCode, 200, matched.body);
    assert.equal(matched.json().version, 2);
    assert.equal(matched.json().description, "matched");

    const stale = await app.inject({
      method: "PATCH",
      url: `/templates/${created.id}`,
      payload: { description: "stale", expectedVersion: 1 },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.match(stale.body, /version conflict/i);

    const unchanged = await app.inject({ method: "GET", url: `/templates/${created.id}` });
    assert.equal(unchanged.statusCode, 200, unchanged.body);
    assert.equal(unchanged.json().version, 2);
    assert.equal(unchanged.json().description, "matched");

    const stalePut = await app.inject({
      method: "PUT",
      url: `/templates/${created.id}`,
      payload: { description: "stale-put", expectedVersion: 1 },
    });
    assert.equal(stalePut.statusCode, 409, stalePut.body);

    const lww = await app.inject({
      method: "PATCH",
      url: `/templates/${created.id}`,
      payload: { description: "last write" },
    });
    assert.equal(lww.statusCode, 200, lww.body);
    assert.equal(lww.json().version, 3);
    assert.equal(lww.json().description, "last write");
  });
});


describe("templates without drafts (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  const otherPodId = uuidv7();
  const kek = new EnvKekProvider("kek-1", randomBytes(32).toString("base64"));
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
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'template drafts test')", [
      orgId,
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `${userId}@example.test`,
    ]);

    auth = {
      userId,
      email: `${userId}@example.test`,
      orgId,
      permissions: ["templates:write"],
    };
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate("authenticate", async (req: { auth?: unknown }) => {
      req.auth = auth;
    });
    registerTemplateRoutes(app);
    registerSecretRoutes(app, kek);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_templates WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM secrets WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pod_templates WHERE org_id = $1", [orgId]);
    auth = {
      userId,
      email: `${userId}@example.test`,
      orgId,
      permissions: ["templates:write"],
    };
  });

  async function createAsPod(name: string, fromPod = podId) {
    auth = { ...auth, podId: fromPod, permissions: [] };
    const response = await app.inject({
      method: "POST",
      url: "/templates",
      payload: { name, description: "from a pod" },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as {
      id: string;
      status: string;
      createdFromPod: string | null;
    };
  }

  it("creates a pod-authored template as immediately active and launchable", async () => {
    const created = await createAsPod("from-pod");
    assert.equal(created.status, "active");
    assert.equal(created.createdFromPod, podId);

    const deps = {
      env: { PI_POD_SANDBOX_URL: "http://pi-pod-sandbox:8433" },
      kek: {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as PodServiceDeps;
    const plan = await planPodLaunch(deps, {
      orgId,
      userId,
      templateId: created.id,
      provider: "sandbox",
    });
    assert.equal(plan.template?.id, created.id);
  });

  it("lets a pod PATCH and set secrets on a template it created", async () => {
    const created = await createAsPod("pod-owned");
    const patched = await app.inject({
      method: "PATCH",
      url: `/templates/${created.id}`,
      payload: { description: "still writable" },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal((patched.json() as { description: string }).description, "still writable");

    const secret = await app.inject({
      method: "PUT",
      url: `/secrets/template/${created.id}/GH_TOKEN`,
      payload: { value: "ghp_test" },
    });
    assert.equal(secret.statusCode, 204, secret.body);

    const listed = await app.inject({
      method: "GET",
      url: `/secrets/template/${created.id}`,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      (listed.json() as { secrets: Array<{ name: string }> }).secrets.map((s) => s.name),
      ["GH_TOKEN"],
    );
  });

  it("forbids a pod from touching another pod's template", async () => {
    const created = await createAsPod("other-pod", otherPodId);
    auth = { ...auth, podId, permissions: [] };

    const patched = await app.inject({
      method: "PATCH",
      url: `/templates/${created.id}`,
      payload: { description: "nope" },
    });
    assert.equal(patched.statusCode, 403, patched.body);

    const secret = await app.inject({
      method: "PUT",
      url: `/secrets/template/${created.id}/GH_TOKEN`,
      payload: { value: "ghp_test" },
    });
    assert.equal(secret.statusCode, 403, secret.body);
  });

  it("lets only the creator pod delete its template and audits the pod actor", async () => {
    const created = await createAsPod("pod-delete-owned");
    const refused = await createAsPod("pod-delete-refused", otherPodId);
    auth = { ...auth, podId, permissions: [] };

    const denied = await app.inject({ method: "DELETE", url: `/templates/${refused.id}` });
    assert.equal(denied.statusCode, 403, denied.body);
    const stillActive = await query<{ archived_at: string | null }>(
      "SELECT archived_at FROM pod_templates WHERE id = $1",
      [refused.id],
    );
    assert.equal(stillActive.rows[0]?.archived_at, null);

    const deleted = await app.inject({ method: "DELETE", url: `/templates/${created.id}` });
    assert.equal(deleted.statusCode, 204, deleted.body);
    const archived = await query<{ archived_at: string | null }>(
      "SELECT archived_at FROM pod_templates WHERE id = $1",
      [created.id],
    );
    assert.notEqual(archived.rows[0]?.archived_at, null);
    const auditRows = await query<{ actor_id: string; detail: { fromPod?: string } }>(
      "SELECT actor_id, detail FROM audit_log WHERE action = 'template.archive' AND target_id = $1",
      [created.id],
    );
    assert.deepEqual(auditRows.rows[0], { actor_id: userId, detail: { fromPod: podId } });
  });

  it("treats POST /templates/:id/activate as an idempotent no-op", async () => {
    const created = await createAsPod("already-live");
    const first = await app.inject({ method: "POST", url: `/templates/${created.id}/activate` });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { id: created.id, status: "active" });

    const second = await app.inject({ method: "POST", url: `/templates/${created.id}/activate` });
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json(), { id: created.id, status: "active" });

    const audits = await query<{ action: string }>(
      "SELECT action FROM audit_log WHERE org_id = $1 AND action = 'template.activate'",
      [orgId],
    );
    assert.equal(audits.rowCount, 0);
  });

  it("converts leftover draft templates to active and drops the status column", async () => {
    const hasStatus = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'pod_templates' AND column_name = 'status'
       ) AS exists`,
    );
    if (!hasStatus.rows[0]?.exists) {
      await query(
        `ALTER TABLE pod_templates ADD COLUMN status text NOT NULL DEFAULT 'active'
         CHECK (status IN ('draft','active'))`,
      );
    }
    const id = uuidv7();
    await query(
      `INSERT INTO pod_templates (id, org_id, owner_user_id, name, status)
       VALUES ($1, $2, $3, 'legacy-draft', 'draft')`,
      [id, orgId, userId],
    );
    await query("UPDATE pod_templates SET status = 'active', updated_at = now() WHERE status = 'draft'");
    await query("ALTER TABLE pod_templates DROP COLUMN status");

    const converted = await query<{ name: string }>("SELECT name FROM pod_templates WHERE id = $1", [id]);
    assert.equal(converted.rows[0]?.name, "legacy-draft");
    const gone = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'pod_templates' AND column_name = 'status'
       ) AS exists`,
    );
    assert.equal(gone.rows[0]?.exists, false);
  });
});
