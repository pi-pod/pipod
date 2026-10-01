/**
 * Legacy owner initialization sweep (native rev3) against Postgres + a fake host.
 *
 * Own DB: `pipod_cost_capacity_test` — never foundation, never production.
 * Proves §7.2 completion: the control plane maps the authoritative pod owner
 * (never labels) and CAS-initializes stopped/archived/error sandboxes exactly
 * once; live sandboxes grandfather (never moved); foreign owners park in
 * conflict + audit and are never overwritten.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { SandboxClient } from "../src/core/providers/sandbox/client.js";
import { uuidv7 } from "../src/server/ids.js";
import { buildCreateOwner, ownerKeyForUserId } from "../src/server/pods/owner-identity.js";
import {
  discoverOwnerInitCandidates,
  initializePodOwner,
  isOwnerInitBookkeepingFailure,
  platformOwnerInitUrls,
  runOwnerInitSweep,
  type OwnerInitCandidate,
} from "../src/server/workers/owner-init.js";
import { sanitizeFailureMessage } from "../src/server/safe-errors.js";
import type { WaitStore } from "../src/server/pods/capacity-wait.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
process.env["PI_POD_SANDBOX_TOKEN"] ??= "test-platform-token";

const store: WaitStore = {
  query: (text: string, params?: unknown[]) => query(text, params ?? []),
};

function sandboxInfo(id: string, owner: { userKey: string } | null, state = "stopped"): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    labels: { "pi-pod-server/pod": "irrelevant-labels-never-consulted" },
    state,
    createdAt: now,
    lastActivityAt: now,
    image: "fixture-image",
    workdir: "/workspace",
    tier: state === "started" ? "hot" : "stopped",
    archiveAfterMinutes: 60,
    idleTimeoutMinutes: 15,
    resources: {},
    ceiling: {},
    owner,
    revision: 1,
    runtimeGeneration: 1,
    stoppedAt: now,
  };
}

describe("owner-init sweep (postgres + HTTP fixture)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const expectedKey = ownerKeyForUserId(userId);
  let server: http.Server;
  let hostUrl = "";
  const puts: Array<{ id: string; body: string }> = [];
  // Per-sandbox script: owner reported by GET; put409 forces a 409 on PUT;
  // getState overrides the reported sandbox state (live grandfathering).
  const scripts = new Map<string, { owner: { userKey: string } | null; put409: boolean; getState?: string }>();

  before(async () => {
    initPool(databaseUrl!);
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-platform-token";
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const get = req.url?.match(/^\/v1\/sandboxes\/([^/]+)$/);
        const put = req.url?.match(/^\/v1\/sandboxes\/([^/]+)\/owner$/);
        if (req.method === "GET" && get) {
          const script = scripts.get(decodeURIComponent(get[1]!));
          if (!script) {
            res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "gone" } }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sandboxInfo(get[1]!, script.owner, script.getState ?? "stopped")));
          return;
        }
        if (req.method === "PUT" && put) {
          const id = decodeURIComponent(put[1]!);
          const script = scripts.get(id);
          puts.push({ id, body });
          if (!script) {
            res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "gone" } }));
            return;
          }
          if (script.put409) {
            res.writeHead(409, { "content-type": "application/json" }).end(
              JSON.stringify({ error: { code: "owner_conflict", message: "live" } }),
            );
            return;
          }
          const parsed = JSON.parse(body) as { owner: { userKey: string } };
          script.owner = parsed.owner;
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ changed: true, sandbox: sandboxInfo(id, script.owner) }),
          );
          return;
        }
        res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    hostUrl = `http://127.0.0.1:${address.port}`;

    await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, "owner init org"]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await query("DELETE FROM sandbox_hosts WHERE id = 'capown-h'");
    await query(`INSERT INTO sandbox_hosts (id, url, status) VALUES ('capown-h', $1, 'active')`, [hostUrl]);
  });

  after(async () => {
    try {
      // Audit first: conflict rows reference the user as actor (FK).
      await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
      await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
      await query("DELETE FROM sandbox_hosts WHERE id = 'capown-h'");
      await query("DELETE FROM users WHERE id = $1", [userId]);
      await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    } finally {
      server.close();
      await closePool();
    }
  });

  async function seedPod(sandboxId: string, providerState: string): Promise<string> {
    return seedPodAs(sandboxId, providerState, orgId, userId);
  }

  async function seedPodAs(sandboxId: string, providerState: string, org: string, user: string): Promise<string> {
    const podId = uuidv7();
    const resolved = {
      config: { providers: { sandbox: { url: hostUrl } }, workdir: "/workspace" },
      image: { ref: "fixture-image" },
      workdir: "/workspace",
    };
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, $4, 'sandbox', $5, 'active', $6, $7::jsonb)`,
      [podId, org, user, `own ${sandboxId}`, sandboxId, providerState, JSON.stringify(resolved)],
    );
    return podId;
  }

  async function initStatus(podId: string): Promise<string | null> {
    const res = await query<{ status: string }>(`SELECT status FROM pod_owner_init WHERE pod_id = $1`, [podId]);
    return res.rows[0]?.status ?? null;
  }

  it("initializes a stopped legacy sandbox once, from the pod owner (never labels)", async () => {
    const podId = await seedPod("sb-legacy-1", "stopped");
    scripts.set("sb-legacy-1", { owner: null, put409: false });
    puts.length = 0;
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    await runOwnerInitSweep({ log });
    assert.equal(await initStatus(podId), "done");
    assert.equal(puts.length, 1);
    const sent = JSON.parse(puts[0]!.body) as { owner: { userKey: string } };
    // Canonical key from the trusted pod owner — buildCreateOwner agrees, and
    // the misleading label on the sandbox was never consulted.
    assert.equal(sent.owner.userKey, expectedKey);
    assert.equal(sent.owner.userKey, buildCreateOwner({ userId }).userKey);
    // Second sweep: done rows are not re-driven (exactly-once).
    await runOwnerInitSweep({ log });
    assert.equal(puts.length, 1);
    assert.equal(await initStatus(podId), "done");
  });

  it("parks foreign-owned sandboxes in conflict without overwriting", async () => {
    const podId = await seedPod("sb-foreign-1", "archived");
    scripts.set("sb-foreign-1", { owner: { userKey: "u_somebody_else" }, put409: false });
    const before = puts.length;
    await runOwnerInitSweep({ log: { info: () => {}, warn: () => {}, error: () => {} } });
    assert.equal(await initStatus(podId), "conflict");
    assert.equal(puts.length, before, "conflict must never PUT (ownership is immutable)");
    const auditRes = await query(
      `SELECT action FROM audit_log WHERE target_id = $1 AND action = 'pod.owner_conflict'`,
      [podId],
    );
    assert.equal(auditRes.rows.length, 1);
  });

  it("grandfathers live sandboxes (409 → live_skipped, never moved)", async () => {
    const podId = await seedPod("sb-live-1", "stopped");
    // Host truthfully live (hot tier) though the DB row says stopped: the
    // CAS is refused and must never move a live cgroup.
    scripts.set("sb-live-1", { owner: null, put409: true, getState: "started" });
    const client = new SandboxClient(hostUrl, "test-platform-token");
    const urls = await platformOwnerInitUrls();
    const candidates = await discoverOwnerInitCandidates(store, urls, 25);
    const candidate = candidates.find((entry) => entry.pod_id === podId) as OwnerInitCandidate;
    assert.ok(candidate);
    assert.equal(await initializePodOwner(client, candidate), "live_skipped");
    assert.equal(await initStatus(podId), "live_skipped");
  });

  it("parks held stopped sandboxes in conflict (holds fence owner-init)", async () => {
    const podId = await seedPod("sb-held-1", "stopped");
    // Stopped and unowned, yet the CAS is refused (e.g. a quiescence hold):
    // not live, so not grandfathered — park for an operator, never overwrite.
    scripts.set("sb-held-1", { owner: null, put409: true, getState: "stopped" });
    const client = new SandboxClient(hostUrl, "test-platform-token");
    const urls = await platformOwnerInitUrls();
    const candidates = await discoverOwnerInitCandidates(store, urls, 25);
    const candidate = candidates.find((entry) => entry.pod_id === podId) as OwnerInitCandidate;
    assert.ok(candidate);
    assert.equal(await initializePodOwner(client, candidate), "conflict");
    assert.equal(await initStatus(podId), "conflict");
  });

  // Zitadel production identity: opaque numeric strings, not UUIDs (045
  // retyped pods.user_id/org_id to text; 056 declared its copies uuid, so
  // every sweep died in the bookkeeping upsert with `invalid input syntax
  // for type uuid` while pod_owner_init stayed empty).
  const zitOrgId = "388200106354016263";
  const zitUserId = "388200106354016264";
  const zitKey = ownerKeyForUserId(zitUserId);

  async function seedZitPod(sandboxId: string, providerState: string): Promise<string> {
    await query("INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
      zitOrgId,
      "zitadel org",
    ]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
      zitUserId,
      `${zitUserId}@example.test`,
    ]);
    return seedPodAs(sandboxId, providerState, zitOrgId, zitUserId);
  }

  async function cleanupZitPod(podId: string): Promise<void> {
    await query("DELETE FROM audit_log WHERE target_id = $1", [podId]);
    await query("DELETE FROM pods WHERE id = $1", [podId]);
  }

  after(async () => {
    await query("DELETE FROM users WHERE id = $1", [zitUserId]).catch(() => {});
    await query("DELETE FROM organizations WHERE id = $1", [zitOrgId]).catch(() => {});
  });

  it("records done for Zitadel text user ids when the native reports the same owner key", async () => {
    const podId = await seedZitPod("sb-zit-1", "archived");
    try {
      scripts.set("sb-zit-1", { owner: { userKey: zitKey }, put409: false });
      const errors: string[] = [];
      await runOwnerInitSweep({ log: { info: () => {}, warn: () => {}, error: (m: string) => errors.push(m) } });
      assert.equal(await initStatus(podId), "done");
      assert.deepEqual(
        errors.filter((m) => m.includes("bookkeeping")),
        [],
        "bookkeeping must succeed for text user ids",
      );
      const row = await query<{ user_id: string; org_id: string }>(
        `SELECT user_id, org_id FROM pod_owner_init WHERE pod_id = $1`,
        [podId],
      );
      assert.equal(row.rows[0]?.user_id, zitUserId);
      assert.equal(row.rows[0]?.org_id, zitOrgId);
    } finally {
      await cleanupZitPod(podId);
    }
  });

  it("records conflict for Zitadel text user ids when the native reports a different key", async () => {
    const podId = await seedZitPod("sb-zit-2", "stopped");
    try {
      scripts.set("sb-zit-2", { owner: { userKey: "u_somebody_else" }, put409: false });
      await runOwnerInitSweep({ log: { info: () => {}, warn: () => {}, error: () => {} } });
      assert.equal(await initStatus(podId), "conflict");
      const auditRes = await query(
        `SELECT action FROM audit_log WHERE target_id = $1 AND action = 'pod.owner_conflict'`,
        [podId],
      );
      assert.equal(auditRes.rows.length, 1);
    } finally {
      await cleanupZitPod(podId);
    }
  });

  it("marks bookkeeping failures so the sweep log names the upsert step without leaking SQL", async () => {
    const podId = await seedZitPod("sb-zit-3", "stopped");
    try {
      scripts.set("sb-zit-3", { owner: null, put409: false });
      const client = new SandboxClient(hostUrl, "test-platform-token");
      const urls = await platformOwnerInitUrls();
      const candidates = await discoverOwnerInitCandidates(store, urls, 25);
      const candidate = candidates.find((entry) => entry.pod_id === podId) as OwnerInitCandidate;
      assert.ok(candidate);
      const sqlLeak = "super_secret_sql_text SELECT * FROM pod_owner_init";
      const failingStore: WaitStore = {
        query: () => Promise.reject(new Error(sqlLeak)),
      };
      const thrown = await initializePodOwner(client, candidate, failingStore).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(thrown, "upsert failure must propagate");
      assert.equal(isOwnerInitBookkeepingFailure(thrown), true);
      assert.equal(isOwnerInitBookkeepingFailure(new Error("provider boom")), false);
      const message = sanitizeFailureMessage(thrown, {
        prefix: `owner init bookkeeping failed for pod ${candidate.pod_id} (upsert)`,
      });
      assert.ok(message.includes("(upsert)"), "log names the failing step");
      assert.ok(!message.includes("super_secret_sql_text"), "SQL text must never leak");
      assert.ok(!message.includes("SELECT"), "SQL text must never leak");
    } finally {
      await cleanupZitPod(podId);
    }
  });

  it("treats idempotent replays (changed:false path) as done", async () => {
    const podId = await seedPod("sb-owned-1", "error");
    // Host already carries exactly our key (e.g. a crashed tick initialized it).
    scripts.set("sb-owned-1", { owner: { userKey: expectedKey }, put409: false });
    const client = new SandboxClient(hostUrl, "test-platform-token");
    const urls = await platformOwnerInitUrls();
    const candidates = await discoverOwnerInitCandidates(store, urls, 25);
    const candidate = candidates.find((entry) => entry.pod_id === podId) as OwnerInitCandidate;
    assert.ok(candidate);
    const before = puts.length;
    assert.equal(await initializePodOwner(client, candidate), "done");
    assert.equal(puts.length, before, "no PUT needed when the owner already matches");
  });
});
