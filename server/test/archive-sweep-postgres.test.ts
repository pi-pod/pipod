/**
 * Archive sweep race safety (plan §3.3, parent corrections A + E): host-issued
 * conditional guards, skip (never force-archive) on pre-conditional hosts, host stop-age
 * revalidation, and gone convergence instead of infinite stopped retries.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import type { PodServiceDeps } from "../src/server/pods/types.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { runArchiveSweep } from "../src/server/workers/reaper.js";
import type { WorkerDeps } from "../src/server/workers/index.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

interface FakeHost {
  url: string;
  close(): Promise<void>;
  /** Per-sandbox script: info to serve on GET; "gone" serves 404. */
  info: Map<string, { state: string; revision?: number; stoppedAt?: string | null }>;
  conditionalPosts: Array<{ id: string; body: unknown }>;
  archivePosts: string[];
  /** When set, the conditional route answers with this outcome instead of archiving. */
  conditionalOutcome: string | null;
}

async function startFakeHost(): Promise<FakeHost> {
  const info = new Map<string, { state: string; revision?: number; stoppedAt?: string | null }>();
  const conditionalPosts: Array<{ id: string; body: unknown }> = [];
  const archivePosts: string[] = [];
  const state = { conditionalOutcome: null as string | null };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    const condMatch = url.match(/^\/v1\/sandboxes\/([^/]+)\/archive-if-stopped$/);
    const archMatch = url.match(/^\/v1\/sandboxes\/([^/]+)\/archive$/);
    const infoMatch = url.match(/^\/v1\/sandboxes\/([^/]+)$/);
    const send = (code: number, body: unknown) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && infoMatch) {
      const id = decodeURIComponent(infoMatch[1]!);
      const row = info.get(id);
      if (!row) return send(404, { error: { code: "not_found", message: "gone" } });
      const { state: st, revision, stoppedAt } = row;
      return send(200, {
        id,
        labels: {},
        state: st,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        image: "img",
        workdir: "/workspace",
        tier: st === "started" ? "hot" : "stopped",
        archiveAfterMinutes: 10080,
        idleTimeoutMinutes: 15,
        resources: {},
        ceiling: {},
        ...(revision === undefined ? {} : { revision }),
        runtimeGeneration: 1,
        ...(stoppedAt === undefined ? {} : { stoppedAt }),
      });
    }
    if (req.method === "POST" && condMatch) {
      const id = decodeURIComponent(condMatch[1]!);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        conditionalPosts.push({ id, body: JSON.parse(Buffer.concat(chunks).toString()) });
        if (state.conditionalOutcome && state.conditionalOutcome !== "archived") {
          return send(200, {
            archived: false,
            outcome: state.conditionalOutcome,
            sandbox: { id, state: "stopped" },
          });
        }
        const row = info.get(id);
        if (row) row.state = "archived";
        send(200, { archived: true, outcome: "archived", sandbox: { id, state: "archived" } });
      });
      return;
    }
    if (req.method === "POST" && archMatch) {
      archivePosts.push(decodeURIComponent(archMatch[1]!));
      return send(200, {});
    }
    return send(404, { error: { code: "not_found", message: "nope" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    info,
    conditionalPosts,
    archivePosts,
    get conditionalOutcome() {
      return state.conditionalOutcome;
    },
    set conditionalOutcome(v: string | null) {
      state.conditionalOutcome = v;
    },
  };
}

describe("archive sweep conditional safety (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  let host: FakeHost;
  const previousToken = process.env["PI_POD_SANDBOX_TOKEN"];

  function deps(): WorkerDeps {
    return {
      env: {
        PI_POD_SANDBOX_TOKEN: "test-token",
        POD_MAX_CONCURRENT_PER_USER: 20,
      } as unknown as ServerEnv,
      kek: kek as unknown as WorkerDeps["kek"],
      gateway: null,
      log,
    };
  }

  async function makeStoppedPod(sandboxId: string, stoppedHoursAgo: number): Promise<string> {
    const id = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state,
                         provider_state_changed_at, resolved_config)
       VALUES ($1, $2, $3, 'sweep fixture', 'sandbox', $4, 'active', 'stopped', $5, $6::jsonb)`,
      [
        id,
        orgId,
        userId,
        sandboxId,
        new Date(Date.now() - stoppedHoursAgo * 3600_000).toISOString(),
        JSON.stringify({
          config: {
            archiveAfterMinutes: 60,
            providers: { sandbox: { url: host.url } },
          },
          workdir: "/workspace",
          retention: {
            idleTimeoutMinutes: 15,
            archiveTransition: { kind: "after-stop", maxDelayDays: 30 },
            effectiveArchiveAfterMinutes: 60,
            providerExpiryDocumented: true,
          },
        }),
      ],
    );
    await query(
      `INSERT INTO pod_retention (pod_id, desired_archive_after_minutes, revision, status, credential_source)
       VALUES ($1, 60, 1, 'applied', 'platform')`,
      [id],
    );
    return id;
  }

  async function providerState(podId: string): Promise<string> {
    const rows = await query<{ provider_state: string }>(`SELECT provider_state FROM pods WHERE id = $1`, [
      podId,
    ]);
    return rows.rows[0]!.provider_state;
  }

  before(async () => {
    initPool(databaseUrl!);
    host = await startFakeHost();
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-token";
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'sweep test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await host.close();
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]);
    if (previousToken === undefined) delete process.env["PI_POD_SANDBOX_TOKEN"];
    else process.env["PI_POD_SANDBOX_TOKEN"] = previousToken;
    await query("DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await closePool();
  });

  beforeEach(async () => {
    await query("DELETE FROM push_queue WHERE user_id = $1", [userId]);
    await query("DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    host.info.clear();
    host.conditionalPosts.length = 0;
    host.archivePosts.length = 0;
    host.conditionalOutcome = null;
  });

  it("archives with host-issued guards and persists the row", async () => {
    const stoppedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
    host.info.set("sb-a", { state: "stopped", revision: 7, stoppedAt });
    const podId = await makeStoppedPod("sb-a", 48);
    await runArchiveSweep(deps());
    assert.equal(await providerState(podId), "archived");
    assert.equal(host.conditionalPosts.length, 1);
    const body = host.conditionalPosts[0]!.body as Record<string, unknown>;
    // Guards are host-issued: the host's revision and stoppedAt, never server ids.
    assert.equal(body["expectedRevision"], 7);
    assert.equal(body["expectedStoppedAt"], stoppedAt);
    assert.equal(host.archivePosts.length, 0, "no force-archive alongside the conditional route");
  });

  it("skips pre-conditional hosts without force-archiving", async () => {
    // Old host: no revision/stoppedAt fields at all.
    host.info.set("sb-old", { state: "stopped" });
    const podId = await makeStoppedPod("sb-old", 48);
    await runArchiveSweep(deps());
    assert.equal(await providerState(podId), "stopped", "claim restored, row stays due");
    assert.equal(host.conditionalPosts.length, 0);
    assert.equal(host.archivePosts.length, 0, "must never force-archive an old host");
  });

  it("does not archive a sandbox the host re-stopped after the DB went stale", async () => {
    // DB row stopped 48h ago (due), but the host's authoritative stop is 5 minutes old:
    // an out-of-band wake/stop the DB has not converged yet.
    host.info.set("sb-fresh", {
      state: "stopped",
      revision: 12,
      stoppedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const podId = await makeStoppedPod("sb-fresh", 48);
    await runArchiveSweep(deps());
    assert.equal(await providerState(podId), "stopped");
    assert.equal(host.conditionalPosts.length, 0);
    assert.equal(host.archivePosts.length, 0);
  });

  it("backs off on revision_mismatch instead of archiving through a race", async () => {
    host.info.set("sb-race", {
      state: "stopped",
      revision: 9,
      stoppedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
    });
    host.conditionalOutcome = "revision_mismatch";
    const podId = await makeStoppedPod("sb-race", 48);
    await runArchiveSweep(deps());
    assert.equal(await providerState(podId), "stopped");
    assert.equal(host.archivePosts.length, 0);
  });

  it("converges provider-gone rows to gone instead of retrying stopped forever", async () => {
    // No info row: host 404s the sandbox as unknown.
    const podId = await makeStoppedPod("sb-gone", 48);
    await runArchiveSweep(deps());
    assert.equal(await providerState(podId), "gone");
    // A second sweep leaves it alone (gone is terminal for the sweep's selector).
    await runArchiveSweep(deps());
    assert.equal(await providerState(podId), "gone");
  });
});
