import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { PiPodConfig } from "../src/core/config.js";
import type { ExecOpts, Sandbox } from "../src/core/providers/types.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { runPodInitSteps } from "../src/server/pods/initialization.js";
import type { ResolvedConfigReport } from "../src/server/pods/types.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

describe("persisted init failure output (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const podId = uuidv7();
  const secret = "init-test-secret-value";
  const report = {
    config: { initTimeoutSeconds: 60, initOnFailure: "abort" },
    image: { ref: "test", managed: false, provenance: "custom", assetDigest: "test", status: "ready" },
    clamps: [],
    secretKeys: ["TOKEN"],
    initSteps: [{ scope: "project", status: "pending" }],
    egress: { description: "open", mode: "open" },
    workdir: "/workspace",
    warnings: [],
    notificationsRedacted: false,
  } as unknown as ResolvedConfigReport;
  const sandbox = {
    id: "init-output-sandbox",
    uploadFile: async () => {},
    exec: async (_argv: string[], opts: ExecOpts = {}) => {
      opts.onStdout?.(Buffer.from("cloning dependency\n"));
      opts.onStderr?.(Buffer.from(`fatal: could not authenticate with ${secret}\n`));
      return { exitCode: 128 };
    },
  } as unknown as Sandbox;

  before(async () => {
    initPool(databaseUrl!);
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'init output test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'init output', 'sandbox', 'active', 'starting', $4::jsonb)`,
      [podId, orgId, userId, JSON.stringify(report)],
    );
  });

  after(async () => {
    await query("DELETE FROM pods WHERE id = $1", [podId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  it("persists a bounded redacted tail and keeps it in the user-facing failure reason", async () => {
    let message = "";
    await assert.rejects(
      runPodInitSteps({
        podId,
        sandbox,
        initSteps: [{ scope: "project", script: "git clone https://example.invalid/private.git" }],
        config: report.config as PiPodConfig,
        report,
        execEnv: { TOKEN: secret },
        egressRestricted: false,
        timings: {},
      }),
      (error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
        assert.match(message, /project init script failed/);
        assert.match(message, /fatal: could not authenticate with \[redacted\]/);
        assert.doesNotMatch(message, new RegExp(secret));
        return true;
      },
    );

    const row = await query<{ resolved_config: ResolvedConfigReport }>(
      "SELECT resolved_config FROM pods WHERE id = $1",
      [podId],
    );
    const step = row.rows[0]?.resolved_config.initSteps?.[0];
    assert.equal(step?.status, "failed");
    assert.equal(
      step?.outputTail,
      "cloning dependency\nfatal: could not authenticate with [redacted]\n",
    );
    assert.doesNotMatch(JSON.stringify(row.rows[0]?.resolved_config), new RegExp(secret));
    assert.match(message.slice(0, 500), /fatal: could not authenticate/);
  });
});
