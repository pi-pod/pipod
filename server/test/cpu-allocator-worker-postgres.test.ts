/**
 * CPU allocator worker end-to-end against Postgres + a fake host.
 *
 * Own DB: `pipod_cost_capacity_test` — never foundation, never production.
 * Drives runCpuAllocator with CPU_FAIRNESS_ENABLED=true:
 * issue → host-confirm → hold (no redundant RPC) → revoke-to-null on idle →
 * tenancy-debt skip. Lease held by the worker across ticks.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { uuidv7 } from "../src/server/ids.js";
import { ownerKeyForUserId } from "../src/server/pods/owner-identity.js";
import { runCpuAllocator } from "../src/server/workers/cpu-allocator.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
process.env["PI_POD_SANDBOX_TOKEN"] ??= "test-platform-token";

const GB = 1024 ** 3;
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("cpu allocator worker (postgres + HTTP fixture)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const userKey = ownerKeyForUserId(userId);
  let server: http.Server;
  let hostUrl = "";
  let debt = 0;
  let uncertainDebt = 0;
  const grantPuts: Array<{ userKey: string; body: { revision: number; cpuCores: number | null; ttlMs: number } }> = [];
  const seenAuth: string[] = [];

  function capacityReport(): Record<string, unknown> {
    return {
      contractVersion: 1,
      hostId: "capalloc-h",
      bootId: "boot-1",
      serviceVersion: "0.1.0-test",
      generation: 3,
      sampledAt: new Date().toISOString(),
      capabilities: {
        maxShape: { cpu: 2, memoryGB: 4, diskGB: 20 },
        standardShape: { cpu: 2, memoryGB: 4, diskGB: 20 },
        resize: { memoryGrowOnline: false, memoryShrink: false, diskGrowOnline: false, diskShrink: false },
        memoryAdmission: "ceiling",
        ownerIdentity: true,
        tenantCgroups: true,
        cpuGrants: true,
        idempotentCreate: true,
        archiveIfStopped: true,
        usageFeed: false,
      },
      memory: {
        budgetBytes: 8 * GB, committedBytes: 4 * GB, inFlightBytes: 0, quarantinedBytes: 0,
        debtBytes: 0, availableBytes: 4 * GB, hostTotalBytes: 16 * GB, hostAvailableBytes: 8 * GB,
      },
      cpu: {
        hostCpus: 4, budgetCores: 4, committedFloorCores: 0, ceilingCoresSum: 2,
        sharing: "weighted-shares", loadAvg1: 0.5, pressureAvg10: 2,
      },
      disk: {
        capacityBytes: 100 * GB, committedBytes: 40 * GB, inFlightBytes: 0, quarantinedBytes: 0,
        allocatedBytes: 10 * GB, scratchBudgetBytes: 5 * GB, scratchUsedBytes: 0, availableBytes: 60 * GB,
      },
      transitions: {
        inFlight: 0, maxInFlight: 4, archivesInFlight: 0, maxConcurrentArchives: 2,
        pendingOperations: 0, quarantinedOperations: 0,
      },
      sandboxes: { hot: 1, warm: 0, stopped: 0, archived: 0, error: 0, booting: 0 },
      fairness: { mode: "local-weights", managed: false, activeGrants: 0, expiredGrants: 0, degradedTenants: 0 },
      tenancy: { ownedSandboxes: 1, unownedLive: 0, unownedInitializable: debt, unownedUncertain: uncertainDebt, requireOwner: false },
    };
  }

  before(async () => {
    initPool(databaseUrl!);
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-platform-token";
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        // Adversarial record: every authed call's bearer (healthz is public).
        if (req.url !== "/v1/healthz") seenAuth.push(String(req.headers["authorization"] ?? ""));
        if (req.url === "/v1/healthz") {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              ok: true, version: "x", uptimeSeconds: 1, hostId: "capalloc-h",
              sandboxes: { hot: 1, warm: 0, stopped: 0, archived: 0 },
              host: {
                cpus: 4, memoryTotalBytes: 16 * GB, memoryAvailableBytes: 8 * GB,
                guaranteeCapacity: { cpu: 3, memoryBytes: 8 * GB },
                committed: { cpu: 1, memoryBytes: 4 * GB, diskBytes: 40 * GB },
                diskCapacityBytes: 100 * GB,
              },
              capacity: capacityReport(),
            }),
          );
          return;
        }
        const put = req.url?.match(/^\/v1\/tenants\/([^/]+)\/cpu-grant$/);
        if (put && req.method === "PUT") {
          const key = decodeURIComponent(put[1]!);
          const parsed = JSON.parse(body) as { revision: number; cpuCores: number | null; ttlMs: number };
          grantPuts.push({ userKey: key, body: parsed });
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              userKey: key,
              applied: true,
              grant: { revision: parsed.revision, cpuCores: parsed.cpuCores, expiresInMs: parsed.ttlMs, state: "active" },
            }),
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

    await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, "alloc org"]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await query("DELETE FROM sandbox_hosts WHERE id = 'capalloc-h'");
    await query(`INSERT INTO sandbox_hosts (id, url, status) VALUES ('capalloc-h', $1, 'active')`, [hostUrl]);
    const podId = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'alloc pod', 'sandbox', 'sb-alloc-1', 'active', 'started', $4::jsonb)`,
      [podId, orgId, userId, JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } })],
    );
  });

  after(async () => {
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM sandbox_hosts WHERE id = 'capalloc-h'");
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await query("DELETE FROM cpu_grant_ledger");
    await query("DELETE FROM grant_allocator_lease");
    server.close();
    await closePool();
  });

  const env = {
    CPU_FAIRNESS_ENABLED: "true",
    CPU_GRANT_TTL_MS: 60_000,
    CPU_ALLOCATOR_INTERVAL_MS: 15_000,
    // Boot snapshot token (explicit, never ambient): the worker under test
    // must not depend on process.env.
    PI_POD_SANDBOX_TOKEN: "test-platform-token",
  };

  async function ledger(): Promise<{ revision: number; desired: number | null; confirmed: number | null }> {
    const res = await query<{ revision: string; desired_cpu_cores: number | null; confirmed_cpu_cores: number | null }>(
      `SELECT revision, desired_cpu_cores, confirmed_cpu_cores FROM cpu_grant_ledger WHERE host_id = 'capalloc-h' AND user_key = $1`,
      [userKey],
    );
    const row = res.rows[0]!;
    return { revision: Number(row.revision), desired: row.desired_cpu_cores, confirmed: row.confirmed_cpu_cores };
  }

  it("issues a grant and confirms it on host-200", async () => {
    grantPuts.length = 0;
    await runCpuAllocator({ env, log });
    assert.equal(grantPuts.length, 1);
    assert.equal(grantPuts[0]?.userKey, userKey);
    // One live sandbox × 2-core proxy, budget 4: full demand granted.
    assert.equal(grantPuts[0]?.body.cpuCores, 2);
    assert.ok((grantPuts[0]?.body.revision ?? 0) >= 1);
    const row = await ledger();
    assert.equal(row.desired, 2);
    assert.equal(row.confirmed, 2);
    assert.equal(row.revision, grantPuts[0]?.body.revision);
  });

  it("holds without redundant RPC on the next tick (same revision stands)", async () => {
    const putsBefore = grantPuts.length;
    await runCpuAllocator({ env, log });
    assert.equal(grantPuts.length, putsBefore, "hold must not re-PUT");
  });

  it("revokes to weights-only when demand disappears", async () => {
    await query("UPDATE pods SET provider_state = 'stopped' WHERE org_id = $1", [orgId]);
    const putsBefore = grantPuts.length;
    await runCpuAllocator({ env, log });
    assert.equal(grantPuts.length, putsBefore + 1);
    assert.equal(grantPuts[grantPuts.length - 1]?.body.cpuCores, null);
    const row = await ledger();
    assert.equal(row.desired, null);
    assert.equal(row.confirmed, null);
    // Back to live for later tests.
    await query("UPDATE pods SET provider_state = 'started' WHERE org_id = $1", [orgId]);
  });

  it("skips debted hosts instead of granting around unknown tenants", async () => {
    debt = 1;
    const putsBefore = grantPuts.length;
    await runCpuAllocator({ env, log });
    assert.equal(grantPuts.length, putsBefore, "no grants while tenancy debt is nonzero");
    debt = 0;
  });

  it("skips hosts with uncertain error ownership debt (never measured zero)", async () => {
    uncertainDebt = 2;
    const putsBefore = grantPuts.length;
    await runCpuAllocator({ env, log });
    assert.equal(grantPuts.length, putsBefore, "no grants while ownership debt is uncertain");
    uncertainDebt = 0;
  });

  it("ignores ambient credential/flag overlays mid-tick (boot snapshot only)", async () => {
    // ROLE=all hardening: a BYO provider call in flight installs another
    // org's key under PI_POD_SANDBOX_TOKEN. The tick must resolve the token
    // (and all flags) from its startup env, never from ambient mid-overlay.
    const BOOT_TOKEN = "boot-snapshot-token-adversarial";
    const OVERLAY_TOKEN = "byo-overlay-token-evil";
    const previous = process.env["PI_POD_SANDBOX_TOKEN"];
    const previousFlag = process.env["POD_ALLOW_8GIB_MEMORY"];
    // Force a fresh grant (age the confirmation past half TTL).
    await query(
      `UPDATE cpu_grant_ledger SET confirmed_at = now() - make_interval(secs => 45)
        WHERE host_id = 'capalloc-h' AND user_key = $1`,
      [userKey],
    );
    seenAuth.length = 0;
    process.env["PI_POD_SANDBOX_TOKEN"] = OVERLAY_TOKEN;
    process.env["POD_ALLOW_8GIB_MEMORY"] = "true";
    try {
      await runCpuAllocator({
        env: { ...env, PI_POD_SANDBOX_TOKEN: BOOT_TOKEN, CPU_FAIRNESS_ENABLED: "true" },
        log,
      });
    } finally {
      if (previous === undefined) delete process.env["PI_POD_SANDBOX_TOKEN"];
      else process.env["PI_POD_SANDBOX_TOKEN"] = previous;
      if (previousFlag === undefined) delete process.env["POD_ALLOW_8GIB_MEMORY"];
      else process.env["POD_ALLOW_8GIB_MEMORY"] = previousFlag;
    }
    assert.ok(seenAuth.length > 0, "expected authed host calls");
    assert.ok(
      seenAuth.every((header) => header === `Bearer ${BOOT_TOKEN}`),
      `only startup values may be used: ${JSON.stringify(seenAuth)}`,
    );
  });

  it("keeps stopping/error workloads charged (never revokes possibly-live work)", async () => {
    // Re-issue first (pod started again after the revoke test): confirmed 2.
    await query("UPDATE pods SET provider_state = 'started' WHERE org_id = $1", [orgId]);
    await runCpuAllocator({ env, log });
    assert.equal((await ledger()).confirmed, 2);
    // Now the pod stops mid-flight: still quota-holding (stopping) with a
    // sandbox id — the finite cap must hold, never revoke to uncapped null.
    await query("UPDATE pods SET provider_state = 'stopping' WHERE org_id = $1", [orgId]);
    const putsBefore = grantPuts.length;
    await runCpuAllocator({ env, log });
    const mine = grantPuts.slice(putsBefore).filter((put) => put.userKey === userKey);
    assert.deepEqual(mine, [], "stopping workloads hold their cap (no revoke, no resize)");
    const row = await ledger();
    assert.equal(row.confirmed, 2);
    await query("UPDATE pods SET provider_state = 'started' WHERE org_id = $1", [orgId]);
  });

  it("bootstraps a grant for provisioning pods before their first create", async () => {
    const user2 = uuidv7();
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [user2, `${user2}@example.test`]);
    const userKey2 = ownerKeyForUserId(user2);
    // Accepted, authoritatively assigned to the host, no sandbox id yet:
    // without a grant the managed-mode create would refuse (deadlock).
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'bootstrap pod', 'sandbox', NULL, 'active', 'provisioning', $4::jsonb)`,
      [uuidv7(), orgId, user2, JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } })],
    );
    const putsBefore = grantPuts.length;
    await runCpuAllocator({ env, log });
    const mine = grantPuts.slice(putsBefore).filter((put) => put.userKey === userKey2);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.body.cpuCores, 2);
    const res = await query<{ confirmed_cpu_cores: number }>(
      `SELECT confirmed_cpu_cores FROM cpu_grant_ledger WHERE host_id = 'capalloc-h' AND user_key = $1`,
      [userKey2],
    );
    assert.equal(res.rows[0]?.confirmed_cpu_cores, 2);
    await query("DELETE FROM pods WHERE user_id = $1", [user2]);
    await query("DELETE FROM users WHERE id = $1", [user2]);
  });

  it("refreshes held grants before TTL lapse (hold still re-pushes)", async () => {
    // Age the confirmation past half TTL: the next tick must re-PUT the same
    // cores with a higher revision, or the host would fall back while the
    // ledger still claimed the old cap.
    await query(
      `UPDATE cpu_grant_ledger SET confirmed_at = now() - make_interval(secs => 45)
        WHERE host_id = 'capalloc-h' AND user_key = $1`,
      [userKey],
    );
    const before = await ledger();
    const putsBefore = grantPuts.length;
    await runCpuAllocator({ env, log });
    const mine = grantPuts.slice(putsBefore).filter((put) => put.userKey === userKey);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.body.cpuCores, 2);
    assert.ok((mine[0]?.body.revision ?? 0) > before.revision);
    const after = await ledger();
    assert.equal(after.confirmed, 2);
  });
});
