/**
 * Owner-init sweep discovers logically archived (hidden) pods (postgres).
 *
 * Production evidence (2026-09-07): the allocator stalled with
 * `12 unowned sandbox(es) pending owner init` while the hidden pods sat at
 * `pods.state = 'archived'` (logical hide only — the physical sandboxes
 * still exist on the host). `discoverOwnerInitCandidates` required
 * `p.state = 'active'`, so hidden rows never initialized.
 *
 * Own DB: `pipod_cost_capacity_test` — never foundation, never production.
 * A `state = 'archived'` pod with an initializable unowned sandbox is
 * discovered and initializes to `done`; a terminal (`gone`, no sandbox id)
 * row and a live (`started`) row are not discovered.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { SandboxClient } from "../src/core/providers/sandbox/client.js";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import {
  discoverOwnerInitCandidates,
  initializePodOwner,
  LIVE_REQUEUE_MS,
  type OwnerInitCandidate,
} from "../src/server/workers/owner-init.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];

const store = {
  query: (text: string, params?: unknown[]) => query(text, params ?? []),
};

describe("owner-init discovers hidden (archived) pods (postgres)", {
  skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL",
}, () => {
  const orgId = uuidv7();
  const userId = uuidv7();

  let server: http.Server;
  let hostUrl = "";
  const puts: Array<{ id: string; body: string }> = [];

  before(async () => {
    initPool(databaseUrl!);
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const get = req.url?.match(/^\/v1\/sandboxes\/([^/]+)$/);
        if (get && req.method === "GET") {
          // Legacy unowned sandbox: v5 omits `owner` exactly like null.
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ id: decodeURIComponent(get[1]!), state: "stopped" }),
          );
          return;
        }
        const put = req.url?.match(/^\/v1\/sandboxes\/([^/]+)\/owner$/);
        if (put && req.method === "PUT") {
          puts.push({ id: decodeURIComponent(put[1]!), body });
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ changed: true, sandbox: { id: decodeURIComponent(put[1]!) } }),
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
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'hidden owner init test')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
  });

  after(async () => {
    await query("DELETE FROM pod_owner_init WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    server.close();
    await closePool();
  });

  async function insertPod(opts: {
    id: string;
    sandboxId: string | null;
    state: string;
    providerState: string;
  }): Promise<void> {
    await query(
      `INSERT INTO pods
         (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, $4, 'sandbox', $5, $6, $7, $8::jsonb)`,
      [
        opts.id,
        orgId,
        userId,
        `hidden-${opts.id.slice(0, 8)}`,
        opts.sandboxId,
        opts.state,
        opts.providerState,
        JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } }),
      ],
    );
  }

  it("discovers archived pods with initializable sandboxes, skips terminal and live rows", async () => {
    const hiddenId = uuidv7();
    const activeId = uuidv7();
    const terminalId = uuidv7();
    const liveId = uuidv7();
    await insertPod({ id: hiddenId, sandboxId: "sb-hidden-1", state: "archived", providerState: "stopped" });
    await insertPod({ id: activeId, sandboxId: "sb-active-1", state: "active", providerState: "archived" });
    // Terminal: gone NULLs the sandbox id (lifecycle) — nothing physical left.
    await insertPod({ id: terminalId, sandboxId: null, state: "archived", providerState: "gone" });
    // Live: started is not an initializable provider state (grandfathered).
    await insertPod({ id: liveId, sandboxId: "sb-live-1", state: "active", providerState: "started" });

    const urls = new Map([[hostUrl, "host-hidden-1"]]);
    const candidates = await discoverOwnerInitCandidates(store, urls, 25);
    const mine = candidates.filter((c) => [hiddenId, activeId, terminalId, liveId].includes(c.pod_id));
    const found = new Set(mine.map((c) => c.pod_id));
    assert.ok(found.has(hiddenId), "archived pod with unowned sandbox must be discovered");
    assert.ok(found.has(activeId), "active pod with unowned sandbox must still be discovered");
    assert.ok(!found.has(terminalId), "terminal (gone, no sandbox) row must not be discovered");
    assert.ok(!found.has(liveId), "live (started) row must not be discovered");
    const hidden = mine.find((c) => c.pod_id === hiddenId)!;
    assert.equal(hidden.sandbox_id, "sb-hidden-1");
    assert.equal(hidden.host_id, "host-hidden-1");
  });

  it("initializes a hidden pod's owner to done", async () => {
    const urls = new Map([[hostUrl, "host-hidden-1"]]);
    const candidates = await discoverOwnerInitCandidates(store, urls, 25);
    const hidden = candidates.find((c) => c.sandbox_id === "sb-hidden-1");
    assert.ok(hidden, "hidden candidate must be present for init");
    const client = new SandboxClient(hostUrl, "test-token");
    const status = await initializePodOwner(client, hidden as OwnerInitCandidate);
    assert.equal(status, "done");
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.id, "sb-hidden-1");
    const row = await query<{ status: string }>("SELECT status FROM pod_owner_init WHERE pod_id = $1", [
      hidden!.pod_id,
    ]);
    assert.equal(row.rows[0]!.status, "done");
    // Finished rows leave the queue: no longer discovered.
    const again = await discoverOwnerInitCandidates(store, urls, 25);
    assert.ok(
      !again.some((c) => c.pod_id === hidden!.pod_id),
      "done rows must not be rediscovered",
    );
    assert.ok(LIVE_REQUEUE_MS > 0, "requeue constant intact");
  });
});
