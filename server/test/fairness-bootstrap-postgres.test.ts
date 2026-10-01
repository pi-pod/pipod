/**
 * W12 — first-create-after-expiry end-to-end with a fake grant-managed host.
 *
 * Replays production 2026-09-07 on one host: the tenant's grant is expired,
 * placement admits (fresh capacity, degradedTenants 0 — the placement gate
 * never saw it), and the native create refuses with the exact 507
 * `fairness_degraded` error. Before the fix the launch then failed in ~1s
 * with `operation failed (503)` and NO wait row; now it must enqueue a
 * bounded `fairness_degraded` wait, wake the allocator into a bootstrap
 * grant, and converge the launch once the grant lands — with the grant held
 * (never revoked to null) while the wait is open.
 *
 * Own DB: `pipod_cost_capacity_test` via PI_POD_TEST_DATABASE_URL — never
 * foundation, never production.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { ownerKeyForUserId } from "../src/server/pods/owner-identity.js";
import { launchPod } from "../src/server/pods/provisioning.js";
import { ensureProviderPodStarted } from "../src/server/pods/lifecycle.js";
import type { PodServiceDeps } from "../src/server/pods/types.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";
import { onCpuAllocatorWake, runCpuAllocator } from "../src/server/workers/cpu-allocator.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
process.env["PI_POD_SANDBOX_TOKEN"] ??= "test-platform-token";

const GB = 1024 ** 3;
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("fairness first-create bootstrap (postgres + fake managed host)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const userKey = ownerKeyForUserId(userId);
  let server: http.Server;
  let wss: WebSocketServer;
  let hostUrl = "";
  /** Tenants the fake host has an active grant for (PUT /cpu-grant flips these). */
  const granted = new Map<string, { revision: number; cpuCores: number | null }>();
  const wakeSandboxes = new Map<string, { state: string; userKey: string }>();
  /** Creates attempted while the tenant was still grantless (must stay zero). */
  let createsWhileGrantless = 0;
  const grantPuts: Array<{ userKey: string; body: { revision: number; cpuCores: number | null; ttlMs: number } }> = [];

  function capacityReport(): Record<string, unknown> {
    return {
      contractVersion: 1,
      hostId: "fairboot-h",
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
      sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0, error: 0, booting: 0 },
      // The incident's host report: managed, but zero degraded tenants (the
      // expired tenant held no live sandboxes), so placement did not gate.
      fairness: {
        mode: "grants", managed: true, gateAdmissions: true,
        activeGrants: 0, expiredGrants: 1, degradedTenants: 0,
      },
      tenancy: { ownedSandboxes: 0, unownedLive: 0, unownedInitializable: 0, unownedUncertain: 0, requireOwner: false },
    };
  }

  function sandboxInfo(id: string): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
      id, labels: {}, state: wakeSandboxes.get(id)?.state ?? "started", createdAt: now, lastActivityAt: now,
      image: "ghcr.io/pi-pod/pi-pod-base:test", workdir: "/workspace", tier: "hot",
      archiveAfterMinutes: 60, idleTimeoutMinutes: 15,
      resources: { cpu: 2, memoryGB: 4, diskGB: 20 },
      ceiling: { cpu: 2, memoryGB: 4, diskGB: 20 },
      owner: { userKey }, revision: 1, runtimeGeneration: 1, stoppedAt: null,
    };
  }

  /** Exact native refusal while the tenant holds no active grant. */
  function fairnessDenied(): Record<string, unknown> {
    return {
      error: {
        code: "admission_denied",
        message: "fairness capacity exhausted",
        hint: "the CPU allocator has not issued a current grant for this tenant on this host; retry once it recovers",
        details: {
          kind: "admission",
          reason: "fairness_degraded",
          resource: "fairness",
          unit: "count",
          required: 1,
          available: 0,
          retryable: true,
          // Short for test speed; production sends 15000.
          retryAfterMs: 3000,
        },
      },
    };
  }

  before(async () => {
    initPool(databaseUrl!);
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-platform-token";
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/v1/healthz") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: true, version: "x", uptimeSeconds: 1, hostId: "fairboot-h",
            sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0 },
            host: {
              cpus: 4, memoryTotalBytes: 16 * GB, memoryAvailableBytes: 8 * GB,
              guaranteeCapacity: { cpu: 4, memoryBytes: 8 * GB },
              committed: { cpu: 0, memoryBytes: 4 * GB, diskBytes: 40 * GB },
              diskCapacityBytes: 100 * GB,
            },
            capacity: capacityReport(),
          }),
        );
        return;
      }
      const body: Buffer[] = [];
      req.on("data", (chunk: Buffer) => body.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(body).toString();
        // File uploads ride the same server with octet-stream bodies: only
        // the JSON routes parse, everything else treats the body as opaque.
        let payload: Record<string, unknown> = {};
        if (text) {
          try {
            payload = JSON.parse(text) as Record<string, unknown>;
          } catch {
            payload = {};
          }
        }
        if (url.startsWith("/v1/images/") && req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ ref: decodeURIComponent(url.slice("/v1/images/".length)), state: "active" }),
          );
          return;
        }
        const put = /^\/v1\/tenants\/([^/]+)\/cpu-grant$/.exec(url);
        if (put && req.method === "PUT") {
          const key = decodeURIComponent(put[1]!);
          const parsed = payload as unknown as { revision: number; cpuCores: number | null; ttlMs: number };
          grantPuts.push({ userKey: key, body: parsed });
          granted.set(key, { revision: parsed.revision, cpuCores: parsed.cpuCores });
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              userKey: key, applied: true,
              grant: { revision: parsed.revision, cpuCores: parsed.cpuCores, expiresInMs: parsed.ttlMs, state: "active" },
            }),
          );
          return;
        }
        const tenant = /^\/v1\/tenants\/([^/]+)$/.exec(url);
        if (tenant && req.method === "GET") {
          const key = decodeURIComponent(tenant[1]!);
          const grant = granted.get(key);
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify(
              grant
                ? {
                    userKey: key, sandboxIds: [], liveSandboxIds: [], cgroupPresent: true,
                    grant: { revision: grant.revision, cpuCores: grant.cpuCores, expiresInMs: 60_000, state: "active" },
                    effectiveCpuCores: grant.cpuCores, degraded: false,
                  }
                : {
                    userKey: key, sandboxIds: [], liveSandboxIds: [], cgroupPresent: false,
                    grant: { revision: 1, cpuCores: null, expiresInMs: 0, state: "expired" },
                    effectiveCpuCores: 3, degraded: true,
                  },
            ),
          );
          return;
        }
        if (url === "/v1/sandboxes" && req.method === "POST") {
          const owner = (payload["owner"] as { userKey?: string } | undefined)?.userKey;
          if (!owner || !granted.has(owner)) {
            createsWhileGrantless += 1;
            res.writeHead(507, { "content-type": "application/json" }).end(JSON.stringify(fairnessDenied()));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sandboxInfo("sb-fairboot-1")));
          return;
        }
        const start = /^\/v1\/sandboxes\/([^/]+)\/start$/.exec(url);
        if (start && req.method === "POST") {
          const id = decodeURIComponent(start[1]!);
          const wake = wakeSandboxes.get(id)!;
          if (!(granted.get(wake.userKey)?.cpuCores! > 0)) {
            res.writeHead(507, { "content-type": "application/json" }).end(JSON.stringify(fairnessDenied()));
            return;
          }
          wake.state = "started";
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sandboxInfo(id)));
          return;
        }
        const sandbox = /^\/v1\/sandboxes\/([^/]+)$/.exec(url);
        if (sandbox && req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sandboxInfo(decodeURIComponent(sandbox[1]!))));
          return;
        }
        if (/^\/v1\/sandboxes\/[^/]+\/files/.test(url) && req.method === "PUT") {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "no route" } }));
      });
    });
    wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (!req.url?.includes("/exec")) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(String(data)) as { type?: string };
            if (msg.type === "start") ws.send(JSON.stringify({ type: "started" }));
            else if (msg.type === "stdin-eof") ws.send(JSON.stringify({ type: "exit", exitCode: 0 }));
          } catch {
            // Unknown frame: ignore; the client fails the exec loudly.
          }
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    hostUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, "fairness bootstrap org"]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await query("DELETE FROM sandbox_hosts WHERE id = 'fairboot-h'");
    await query(`INSERT INTO sandbox_hosts (id, url, status) VALUES ('fairboot-h', $1, 'active')`, [hostUrl]);
  });

  after(async () => {
    // launchPod writes launch custody + tokens + retention + audit rows:
    // child tables first, then pods, then the org/user the audit references.
    await query("DELETE FROM pod_capacity_wait WHERE org_id = $1", [orgId]).catch(() => null);
    await query(
      `DELETE FROM pod_launch_env WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)`,
      [orgId],
    ).catch(() => null);
    await query(
      `DELETE FROM pod_tokens WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)`,
      [orgId],
    ).catch(() => null);
    await query(
      `DELETE FROM pod_retention WHERE pod_id IN (SELECT id FROM pods WHERE org_id = $1)`,
      [orgId],
    ).catch(() => null);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]).catch(() => null);
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]).catch(() => null);
    await query("DELETE FROM sandbox_hosts WHERE id = 'fairboot-h'").catch(() => null);
    await query("DELETE FROM users WHERE id = $1", [userId]).catch(() => null);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]).catch(() => null);
    await query("DELETE FROM cpu_grant_ledger").catch(() => null);
    await query("DELETE FROM grant_allocator_lease").catch(() => null);
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  const launchEnv = {
    PUBLIC_URL: "http://127.0.0.1:9",
    PI_POD_SANDBOX_URL: hostUrl,
    PI_POD_SANDBOX_IMAGE_MIRROR: "ghcr.io/pi-pod",
    PI_POD_SANDBOX_TOKEN: "test-platform-token",
    CAPACITY_WAIT_ENABLED: true,
    CAPACITY_WAIT_SECONDS: 45,
    CPU_FAIRNESS_ENABLED: "true",
    CPU_GRANT_TTL_MS: 60_000,
    CPU_ALLOCATOR_INTERVAL_MS: 15_000,
    LOG_LEVEL: "silent",
  } as unknown as ServerEnv;

  function launchDeps(): PodServiceDeps {
    return {
      env: launchEnv,
      kek: new EnvKekProvider("test-kek", randomBytes(32).toString("base64")),
      log,
      onPodCreated: async () => {},
      onPodStarted: () => {},
    };
  }

  async function pollFor<T>(what: string, timeoutMs: number, read: () => Promise<T | null>): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  it("waits on host fairness_degraded and converges once the bootstrap grant lands", async () => {
    const launched = await launchPod(launchDeps(), { orgId, userId });
    const podId = launched.pod.id;

    // The launch returns while provisioning runs in the background. The
    // incident's signature was NO wait row and a ~1s 503: now a bounded
    // fairness_degraded wait must exist while the create keeps refusing.
    const wait = await pollFor("fairness_degraded wait row", 15_000, async () => {
      const res = await query<{ status: string; reason: string | null }>(
        `SELECT status, reason FROM pod_capacity_wait WHERE pod_id = $1`,
        [podId],
      );
      const row = res.rows[0];
      return row && row.status === "waiting" ? row : null;
    });
    assert.equal(wait.reason, "fairness_degraded");

    // The allocator's bootstrap demand sees the provisioning row (no sandbox
    // id yet) and issues the FIRST grant for this tenant on this host.
    const putsBefore = grantPuts.length;
    await runCpuAllocator({
      env: {
        CPU_FAIRNESS_ENABLED: "true",
        CPU_GRANT_TTL_MS: 60_000,
        CPU_ALLOCATOR_INTERVAL_MS: 15_000,
        PI_POD_SANDBOX_TOKEN: "test-platform-token",
      },
      log,
    });
    const mine = grantPuts.slice(putsBefore).filter((put) => put.userKey === userKey);
    assert.equal(mine.length, 1, "allocator must issue one bootstrap grant");
    assert.equal(mine[0]?.body.cpuCores, 2);

    // The waiter's next re-probe (host retryAfterMs interval) now finds the
    // tenant granted and the launch converges without operator retries.
    const sandboxId = await pollFor("sandbox id on the pod row", 40_000, async () => {
      const res = await query<{ provider_sandbox_id: string | null; provider_state: string }>(
        `SELECT provider_sandbox_id, provider_state FROM pods WHERE id = $1`,
        [podId],
      );
      const row = res.rows[0];
      return row?.provider_sandbox_id ?? null;
    });
    assert.equal(sandboxId, "sb-fairboot-1");
    // Recording the sandbox id (UPDATE pods) happens in bootOn *before*
    // finishCapacityWait(..., "admitted"). A one-shot SELECT here races that
    // write (CI 34672774093: sandbox id present, status still waiting).
    const done = await pollFor("wait admitted", 15_000, async () => {
      const res = await query<{ status: string }>(
        `SELECT status FROM pod_capacity_wait WHERE pod_id = $1`,
        [podId],
      );
      const row = res.rows[0];
      return row?.status === "admitted" ? row : null;
    });
    assert.equal(done.status, "admitted");
    // Placement resolves the tenant grant BEFORE any create on a managed
    // host, so no futile grantless create ever left the server: the single
    // create below is the post-grant one the pod row recorded.
    assert.equal(createsWhileGrantless, 0);
  });

  for (const fromState of ["stopped", "archived"] as const) {
    it(`bootstraps a grantless ${fromState} wake using the real allocator`, async () => {
      const owner = uuidv7();
      const key = ownerKeyForUserId(owner);
      const podId = uuidv7();
      const sandboxId = `sb-${podId}`;
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [owner, `${owner}@example.test`]);
      await query(
        `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
         VALUES ($1, $2, $3, 'cold wake', 'sandbox', $4, 'active', $5, $6::jsonb)`,
        [podId, orgId, owner, sandboxId, fromState, JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } })],
      );
      wakeSandboxes.set(sandboxId, { state: fromState, userKey: key });
      let signalled = false;
      const unsubscribe = onCpuAllocatorWake(() => { signalled = true; });
      const pending = ensureProviderPodStarted(launchDeps(), { org_id: orgId, id: podId }, owner);
      // Always consume a rejection even if an assertion fails before awaiting it.
      void pending.catch(() => {});
      try {
        await pollFor("cold wake wait", 15_000, async () => {
          const result = await query<{ provider_state: string }>(
            `SELECT p.provider_state FROM pods p JOIN pod_capacity_wait w ON w.pod_id = p.id
             WHERE p.id = $1 AND w.kind = 'wake' AND w.status = 'waiting'`, [podId],
          );
          return result.rows[0]?.provider_state === fromState ? true : null;
        });
        assert.equal(signalled, true, "enqueue wakes the allocator immediately");
        await runCpuAllocator({ env: launchEnv, log });
        assert.equal(granted.get(key)?.cpuCores, 2, "rolled-back cold state still has bootstrap demand");
        const started = await pending;
        assert.equal(started.provider_state, "started");
        assert.equal(started.provider_sandbox_id, sandboxId);
        assert.equal(wakeSandboxes.get(sandboxId)?.state, "started");
        const wait = await query<{ status: string }>("SELECT status FROM pod_capacity_wait WHERE pod_id = $1", [podId]);
        assert.equal(wait.rows[0]?.status, "admitted");
      } finally {
        unsubscribe();
        await query("UPDATE pod_capacity_wait SET status = 'cancelled' WHERE pod_id = $1 AND status = 'waiting'", [podId]);
        await pending.catch(() => {});
        await query("DELETE FROM pod_capacity_wait WHERE pod_id = $1", [podId]);
        await query("DELETE FROM pods WHERE id = $1", [podId]);
        await query("DELETE FROM audit_log WHERE actor_id = $1", [owner]);
        await query("DELETE FROM users WHERE id = $1", [owner]);
        await query("DELETE FROM cpu_grant_ledger WHERE user_key = $1", [key]);
      }
    });
  }

  it("does not bootstrap dormant, terminal, expired, hidden, or unpinned wake rows", async () => {
    const owner = uuidv7();
    const key = ownerKeyForUserId(owner);
    const podId = uuidv7();
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [owner, `${owner}@example.test`]);
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'dormant', 'sandbox', 'sb-dormant', 'active', 'archived', $4::jsonb)`,
      [podId, orgId, owner, JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } })],
    );
    const tickWithoutGrant = async (label: string): Promise<void> => {
      await runCpuAllocator({ env: launchEnv, log });
      assert.equal(granted.has(key), false, label);
    };
    try {
      await tickWithoutGrant("dormant archived pod has no demand");
      await query(
        `INSERT INTO pod_capacity_wait (pod_id, org_id, user_id, operation_key, kind, status, deadline_at)
         VALUES ($1, $2, $3, $4, 'wake', 'cancelled', now() + interval '60 seconds')`,
        [podId, orgId, owner, `wake:${podId}`],
      );
      for (const status of ["cancelled", "expired", "admitted"]) {
        await query("UPDATE pod_capacity_wait SET status = $2 WHERE pod_id = $1", [podId, status]);
        await tickWithoutGrant(`${status} wake has no demand`);
      }
      await query("UPDATE pod_capacity_wait SET status = 'waiting', deadline_at = now() - interval '1 second' WHERE pod_id = $1", [podId]);
      await tickWithoutGrant("elapsed deadline is excluded even before sweep");
      await query("UPDATE pod_capacity_wait SET deadline_at = now() + interval '60 seconds', kind = 'create' WHERE pod_id = $1", [podId]);
      await tickWithoutGrant("create waiter cannot bootstrap an archived sandbox");
      await query("UPDATE pod_capacity_wait SET kind = 'wake' WHERE pod_id = $1", [podId]);
      await query("UPDATE pods SET state = 'archived' WHERE id = $1", [podId]);
      await tickWithoutGrant("logically hidden pod cannot bootstrap");
      await query("UPDATE pods SET state = 'active', resolved_config = '{}'::jsonb WHERE id = $1", [podId]);
      await tickWithoutGrant("missing frozen host cannot bootstrap on the default host");
    } finally {
      await query("DELETE FROM pod_capacity_wait WHERE pod_id = $1", [podId]);
      await query("DELETE FROM pods WHERE id = $1", [podId]);
      await query("DELETE FROM users WHERE id = $1", [owner]);
      await query("DELETE FROM cpu_grant_ledger WHERE user_key = $1", [key]);
    }
  });

  it("holds the waiter's grant while the wait is open (never revokes to null)", async () => {
    const user2 = uuidv7();
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [user2, `${user2}@example.test`]);
    const userKey2 = ownerKeyForUserId(user2);
    const podId = uuidv7();
    // Charged-but-demandless: stopping WITH a sandbox id still holds its
    // quota slot (AWAKE_POD_SQL) while contributing zero live/bootstrap
    // demand, so the user is ABSENT from the solve and ONLY the
    // chargedByPair guard stands between the confirmed grant and a
    // revoke-to-null. (A provisioning row would carry bootstrap demand and
    // hold via the solve without ever reaching the guard.)
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'stopping pod', 'sandbox', 'sb-waiting-1', 'active', 'stopping', $4::jsonb)`,
      [podId, orgId, user2, JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } })],
    );
    await query(
      `INSERT INTO pod_capacity_wait (pod_id, org_id, user_id, operation_key, status, reason, deadline_at)
       VALUES ($1, $2, $3, $4, 'waiting', 'fairness_degraded', now() + make_interval(secs => 60))`,
      [podId, orgId, user2, `op:${podId}`],
    );
    // A confirmed bootstrap-scale grant, as the previous test leaves behind.
    await query(
      `INSERT INTO cpu_grant_ledger (host_id, user_key, revision, cpu_cores, desired_cpu_cores,
         confirmed_cpu_cores, confirmed_revision, confirmed_at, freshness, expires_at, state)
       VALUES ('fairboot-h', $1, 7, 2, 2, 2, 7, now(), 'fresh', now() + make_interval(secs => 60), 'active')`,
      [userKey2],
    );
    const putsBefore = grantPuts.length;
    await runCpuAllocator({
      env: {
        CPU_FAIRNESS_ENABLED: "true",
        CPU_GRANT_TTL_MS: 60_000,
        CPU_ALLOCATOR_INTERVAL_MS: 15_000,
        PI_POD_SANDBOX_TOKEN: "test-platform-token",
      },
      log,
    });
    const mine = grantPuts.slice(putsBefore).filter((put) => put.userKey === userKey2);
    assert.deepEqual(
      mine.filter((put) => put.body.cpuCores === null),
      [],
      "an open fairness wait holds its finite cap: no revoke-to-null while provisioning",
    );
    const row = await query<{ desired_cpu_cores: number | null; confirmed_cpu_cores: number | null }>(
      `SELECT desired_cpu_cores, confirmed_cpu_cores FROM cpu_grant_ledger WHERE host_id = 'fairboot-h' AND user_key = $1`,
      [userKey2],
    );
    assert.equal(row.rows[0]?.confirmed_cpu_cores, 2);
    await query("DELETE FROM pod_capacity_wait WHERE pod_id = $1", [podId]);
    await query("DELETE FROM pods WHERE id = $1", [podId]);
    await query("DELETE FROM users WHERE id = $1", [user2]);
  });
});
