import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { getPod, listPods } from "../src/server/pods/service.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("pod listing filters (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const otherOrgId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  const webTemplate = uuidv7();
  const dataTemplate = uuidv7();
  const pods = {
    web: uuidv7(),
    webTheirs: uuidv7(),
    webArchived: uuidv7(),
    data: uuidv7(),
    plain: uuidv7(),
    otherOrg: uuidv7(),
  };

  async function makeOrg(id: string, label: string): Promise<void> {
    await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [
      id,
      label,
    ]);
  }

  async function makeUser(id: string): Promise<void> {
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      id,
      `${id}@example.test`,
    ]);
  }

  async function makeTemplate(id: string, org: string, name: string): Promise<void> {
    await query("INSERT INTO pod_templates (id, org_id, name) VALUES ($1, $2, $3)", [id, org, name]);
  }

  async function makePod(args: {
    id: string;
    org: string;
    user: string;
    name: string;
    templateId?: string | null;
    project?: string | null;
    provider?: string;
    state?: string;
    providerState?: string;
    lastActivityAt?: string;
  }): Promise<void> {
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config,
                         template_id, project, last_activity_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9, $10)`,
      [
        args.id,
        args.org,
        args.user,
        args.name,
        args.provider ?? "sandbox",
        args.state ?? "active",
        args.providerState ?? "stopped",
        args.templateId ?? null,
        args.project ?? null,
        args.lastActivityAt ?? "2026-08-12T12:00:00Z",
      ],
    );
  }

  before(async () => {
    initPool(databaseUrl!);
    await makeOrg(orgId, "pod list test");
    await makeOrg(otherOrgId, "pod list test (other org)");
    await makeUser(userId);
    await makeUser(otherUserId);
    await makeTemplate(webTemplate, orgId, `web-${webTemplate.slice(0, 8)}`);
    await makeTemplate(dataTemplate, orgId, `data-${dataTemplate.slice(0, 8)}`);
    await makePod({
      id: pods.web,
      org: orgId,
      user: userId,
      name: "web",
      templateId: webTemplate,
      project: "acme",
      lastActivityAt: "2026-08-12T12:00:00Z",
    });
    await makePod({
      id: pods.webTheirs,
      org: orgId,
      user: otherUserId,
      name: "web-theirs",
      templateId: webTemplate,
      lastActivityAt: "2026-08-12T11:00:00Z",
    });
    await makePod({
      id: pods.webArchived,
      org: orgId,
      user: userId,
      name: "web-archived",
      templateId: webTemplate,
      state: "archived",
      lastActivityAt: "2026-08-12T10:00:00Z",
    });
    await makePod({ id: pods.data, org: orgId, user: userId, name: "data", templateId: dataTemplate });
    await makePod({
      id: pods.plain,
      org: orgId,
      user: userId,
      name: "plain",
      provider: "boat",
      state: "archived",
      providerState: "gone",
    });
    // Same template id is impossible across orgs, but org scoping has to hold anyway.
    await makePod({ id: pods.otherOrg, org: otherOrgId, user: userId, name: "elsewhere" });
  });

  after(async () => {
    await query("DELETE FROM pods WHERE org_id = ANY($1)", [[orgId, otherOrgId]]);
    await query("DELETE FROM pod_templates WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = ANY($1)", [[userId, otherUserId]]);
    await query("DELETE FROM organizations WHERE id = ANY($1)", [[orgId, otherOrgId]]);
    await closePool();
  });

  const names = (rows: Array<{ name: string }>): string[] => rows.map((row) => row.name);

  it("lists every pod in the org when no filter narrows it", async () => {
    const rows = await listPods({ orgId, limit: 100 });
    assert.deepEqual(names(rows).sort(), ["data", "web", "web-archived", "web-theirs"]);
  });

  it("preserves retired Boat attribution on historical rows", async () => {
    const historical = await getPod(orgId, pods.plain);
    assert.equal(historical.provider, "boat");
    assert.equal(historical.provider_state, "gone");
    assert.deepEqual(historical.resolved_config, {});
  });

  it("keeps only the pods launched from one template", async () => {
    const rows = await listPods({ orgId, limit: 100, templateId: webTemplate });
    assert.deepEqual(names(rows), ["web", "web-theirs", "web-archived"], "newest activity first");

    const other = await listPods({ orgId, limit: 100, templateId: dataTemplate });
    assert.deepEqual(names(other), ["data"]);
  });

  it("never reaches past the org, and answers empty for a template with no pods", async () => {
    const unused = uuidv7();
    await makeTemplate(unused, orgId, `unused-${unused.slice(0, 8)}`);
    assert.deepEqual(await listPods({ orgId, limit: 100, templateId: unused }), []);
    assert.deepEqual(await listPods({ orgId: otherOrgId, limit: 100, templateId: webTemplate }), []);
  });

  it("composes with the other filters rather than replacing them", async () => {
    assert.deepEqual(
      names(await listPods({ orgId, limit: 100, templateId: webTemplate, userId })),
      ["web", "web-archived"],
      "mine",
    );
    assert.deepEqual(
      names(await listPods({ orgId, limit: 100, templateId: webTemplate, state: "active" })),
      ["web", "web-theirs"],
      "state",
    );
    assert.deepEqual(
      names(await listPods({ orgId, limit: 100, templateId: webTemplate, project: "acme" })),
      ["web"],
      "project",
    );
    assert.deepEqual(
      names(await listPods({ orgId, limit: 100, templateId: webTemplate, before: "2026-08-12T11:30:00Z" })),
      ["web-theirs", "web-archived"],
      "cursor",
    );
    assert.deepEqual(
      names(await listPods({ orgId, limit: 1, templateId: webTemplate })),
      ["web"],
      "limit",
    );
  });
});
