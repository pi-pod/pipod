/**
 * Allocator ⇄ native-semantics integration against a contract-faithful
 * in-process simulator (postgres for server rows).
 *
 * Own DB: `pipod_cost_capacity_test` — never foundation, never production.
 *
 * Why a simulator, and why it is faithful: the real native service needs
 * privileges this environment cannot grant (non-root uid; cgroup mounts,
 * netns, image unpack), and its privileged suite runs on ephemeral GitHub
 * runners. Worse, issuing even one grant PUT to a production host flips its
 * persistent global managed_mode — forbidden. So this fixture re-implements
 * the exact native rules read from pi-pod-sandbox/src/core/{tenancy,
 * manager}.ts at test time (cited inline), driven by the REAL server worker
 * (runCpuAllocator), REAL placement (placeSandboxHostForRequest), and REAL
 * client (SandboxClient) over HTTP:
 *
 * - sticky managed_mode (first grant flips it persistently; forget/never
 *   un-manages — tenancy.ts managedMode/readManaged);
 * - revision high-water per tenant (stale → 409 — tenancy.ts apply);
 * - cpuCores null-or-finite->0 validation (400 otherwise);
 * - TTL measured on a monotonic clock; lapse → bounded fallback
 *   (clamp(budget/max(1,owners), 0.5, budget)) with degraded = managed &&
 *   state !== active (tenancy.ts status/fallbackCores/expireDue);
 * - per-tenant create gating in managed mode (manager.ts
 *   assertFairnessAvailable → 507 fairness_degraded retryable);
 * - fairness mode grants|degraded|local-weights from degradedOwners.
 *
 * Proven here: bootstrap convergence (provisioning demand → grant → create
 * succeeds), sticky-mode refusal for grantless owners, refresh preventing
 * fallback, lapse → fallback + degraded + per-tenant placement split, and
 * decrease-before-increase PUT ordering.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { SandboxClient } from "../src/core/providers/sandbox/client.js";
import { uuidv7 } from "../src/server/ids.js";
import { ownerKeyForUserId } from "../src/server/pods/owner-identity.js";
import { runCpuAllocator } from "../src/server/workers/cpu-allocator.js";
import {
  listSandboxHosts,
  placeSandboxHostForRequest,
} from "../src/server/pods/sandboxfleet.js";
import { resolveShape } from "../src/server/pods/capacity.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
process.env["PI_POD_SANDBOX_TOKEN"] ??= "test-platform-token";

const GB = 1024 ** 3;
const log = { info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface SimGrant {
  revision: number;
  cpuCores: number | null;
  grantedAt: number;
  ttlMs: number;
}

/** Faithful subset of native tenancy+manager semantics (see header). */
function createSimulator() {
  const budgetCores = 4;
  let managed = false;
  const grants = new Map<string, SimGrant>();
  const liveByOwner = new Map<string, Set<string>>();
  const putLog: Array<{ userKey: string; revision: number; cpuCores: number | null; at: number }> = [];
  let sandboxSeq = 0;

  const liveState = (entry: SimGrant, now: number): "active" | "expired" =>
    now >= entry.grantedAt + entry.ttlMs ? "expired" : "active";

  const activeOwners = (): number => {
    let n = 0;
    for (const [owner, ids] of liveByOwner) if (ids.size > 0 && owner) n += 1;
    return n;
  };

  const fallbackCores = (): number => {
    const perOwner = budgetCores / Math.max(1, activeOwners());
    return Math.min(Math.max(perOwner, 0.5), budgetCores);
  };

  const effectiveOf = (userKey: string, now: number): number | null => {
    const entry = grants.get(userKey);
    if (!entry) return managed ? fallbackCores() : null;
    if (liveState(entry, now) !== "active") return fallbackCores();
    return entry.cpuCores;
  };

  const isDegraded = (userKey: string, now: number): boolean => {
    if (!managed) return false;
    const entry = grants.get(userKey);
    return entry === undefined || liveState(entry, now) !== "active";
  };

  const degradedOwners = (now: number): string[] => {
    if (!managed) return [];
    const out: string[] = [];
    for (const [owner, ids] of liveByOwner) {
      if (ids.size === 0) continue;
      if (isDegraded(owner, now)) out.push(owner);
    }
    return out;
  };

  const capacity = (): Record<string, unknown> => {
    const now = Date.now();
    const degraded = degradedOwners(now);
    let active = 0;
    let expired = 0;
    for (const entry of grants.values()) {
      if (liveState(entry, now) === "active") active += 1;
      else expired += 1;
    }
    return {
      contractVersion: 1,
      hostId: "capsim-h",
      bootId: "boot-sim",
      serviceVersion: "sim",
      generation: 1,
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
        budgetBytes: 8 * GB, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0,
        debtBytes: 0, availableBytes: 8 * GB, hostTotalBytes: 16 * GB, hostAvailableBytes: 8 * GB,
      },
      cpu: {
        hostCpus: 4, budgetCores, committedFloorCores: 0, ceilingCoresSum: 0,
        sharing: "weighted-shares", loadAvg1: 0.1, pressureAvg10: 1,
      },
      disk: {
        capacityBytes: 100 * GB, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0,
        allocatedBytes: 0, scratchBudgetBytes: 5 * GB, scratchUsedBytes: 0, availableBytes: 100 * GB,
      },
      transitions: {
        inFlight: 0, maxInFlight: 4, archivesInFlight: 0, maxConcurrentArchives: 2,
        pendingOperations: 0, quarantinedOperations: 0,
      },
      sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0, error: 0, booting: 0 },
      fairness: {
        mode: !managed ? "local-weights" : degraded.length > 0 ? "degraded" : "grants",
        managed,
        activeGrants: active,
        expiredGrants: expired,
        degradedTenants: degraded.length,
      },
      tenancy: { ownedSandboxes: 0, unownedLive: 0, unownedInitializable: 0, unownedUncertain: 0, requireOwner: false },
    };
  };

  const server = http.createServer((req, res) => {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const now = Date.now();
      if (req.url === "/v1/healthz") {
        json(200, {
          ok: true, version: "sim", uptimeSeconds: 1, hostId: "sim-native",
          sandboxes: { hot: 0, warm: 0, stopped: 0, archived: 0 },
          host: {
            cpus: 4, memoryTotalBytes: 16 * GB, memoryAvailableBytes: 8 * GB,
            guaranteeCapacity: { cpu: 4, memoryBytes: 8 * GB },
            committed: { cpu: 0, memoryBytes: 0, diskBytes: 0 },
            diskCapacityBytes: 100 * GB,
          },
          capacity: capacity(),
        });
        return;
      }
      const grantPut = req.url?.match(/^\/v1\/tenants\/([^/]+)\/cpu-grant$/);
      if (grantPut && req.method === "PUT") {
        const userKey = decodeURIComponent(grantPut[1]!);
        const body = JSON.parse(raw) as { revision: number; cpuCores: number | null; ttlMs: number };
        if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
          json(400, { error: { code: "bad_request", message: "revision must be a non-negative safe integer" } });
          return;
        }
        if (typeof body.ttlMs !== "number" || body.ttlMs < 1000 || body.ttlMs > 3_600_000) {
          json(400, { error: { code: "bad_request", message: "ttlMs out of range" } });
          return;
        }
        if (body.cpuCores !== null && (typeof body.cpuCores !== "number" || !Number.isFinite(body.cpuCores) || body.cpuCores <= 0)) {
          json(400, { error: { code: "bad_request", message: "cpuCores must be null or finite > 0" } });
          return;
        }
        const existing = grants.get(userKey);
        if (existing !== undefined && body.revision <= existing.revision) {
          json(409, { error: { code: "stale_revision", message: "stale", details: { kind: "revision", expected: existing.revision + 1, actual: body.revision } } });
          return;
        }
        grants.set(userKey, { revision: body.revision, cpuCores: body.cpuCores, grantedAt: now, ttlMs: body.ttlMs });
        managed = true;
        putLog.push({ userKey, revision: body.revision, cpuCores: body.cpuCores, at: now });
        json(200, {
          userKey,
          applied: true,
          grant: { revision: body.revision, cpuCores: body.cpuCores, expiresInMs: body.ttlMs, state: "active" },
        });
        return;
      }
      const tenant = req.url?.match(/^\/v1\/tenants\/([^/]+)$/);
      if (tenant && req.method === "GET") {
        const userKey = decodeURIComponent(tenant[1]!);
        const entry = grants.get(userKey);
        const live = [...(liveByOwner.get(userKey) ?? [])];
        const state = !entry ? "none" : liveState(entry, now);
        json(200, {
          userKey,
          sandboxIds: live,
          liveSandboxIds: live,
          cgroupPresent: live.length > 0,
          grant: !entry
            ? null
            : { revision: entry.revision, cpuCores: entry.cpuCores, expiresInMs: Math.max(0, entry.grantedAt + entry.ttlMs - now), state: state === "active" ? "active" : "expired" },
          effectiveCpuCores: effectiveOf(userKey, now),
          degraded: isDegraded(userKey, now),
        });
        return;
      }
      if (req.url === "/v1/sandboxes" && req.method === "POST") {
        const body = JSON.parse(raw) as { owner?: { userKey?: string } };
        const ownerKey = body.owner?.userKey ?? null;
        // assertFairnessAvailable: managed + owner + no active grant → 507.
        if (ownerKey && managed) {
          const entry = grants.get(ownerKey);
          if (!entry || liveState(entry, now) !== "active") {
            json(507, {
              error: {
                code: "admission_denied",
                message: "no current grant",
                details: {
                  kind: "admission", reason: "fairness_degraded", resource: "fairness",
                  unit: "count", required: 1, available: 0, retryable: true, retryAfterMs: 15_000,
                },
              },
            });
            return;
          }
        }
        sandboxSeq += 1;
        const id = `sim-sb-${sandboxSeq}`;
        if (ownerKey) {
          let set = liveByOwner.get(ownerKey);
          if (!set) {
            set = new Set();
            liveByOwner.set(ownerKey, set);
          }
          set.add(id);
        }
        const at = new Date().toISOString();
        json(200, {
          id, labels: {}, state: "started", createdAt: at, lastActivityAt: at,
          image: "sim", workdir: "/w", tier: "hot", archiveAfterMinutes: 60,
          idleTimeoutMinutes: 15, resources: {}, ceiling: {},
          owner: ownerKey ? { userKey: ownerKey } : null,
          revision: 1, runtimeGeneration: 1, stoppedAt: null,
        });
        return;
      }
      json(404, { error: { code: "not_found", message: "nope" } });
    });
  });

  return { server, putLog, isManaged: () => managed, effectiveOf, isDegraded, url: "" as string };
}

describe("allocator x native semantics (simulator + postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userA = uuidv7();
  const userB = uuidv7();
  const keyA = ownerKeyForUserId(userA);
  const keyB = ownerKeyForUserId(userB);
  const sim = createSimulator();
  let hostUrl = "";

  const env = { CPU_FAIRNESS_ENABLED: "true", CPU_GRANT_TTL_MS: 2_000, CPU_ALLOCATOR_INTERVAL_MS: 15_000, PI_POD_SANDBOX_TOKEN: "test-platform-token" };

  before(async () => {
    initPool(databaseUrl!);
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-platform-token";
    await new Promise<void>((resolve) => sim.server.listen(0, "127.0.0.1", resolve));
    const address = sim.server.address();
    assert.ok(address && typeof address === "object");
    hostUrl = `http://127.0.0.1:${address.port}`;
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'sim org')", [orgId]);
    for (const id of [userA, userB]) {
      await query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    }
    await query("DELETE FROM sandbox_hosts WHERE id = 'capsim-h'");
    await query(`INSERT INTO sandbox_hosts (id, url, status) VALUES ('capsim-h', $1, 'active')`, [hostUrl]);
  });

  after(async () => {
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM sandbox_hosts WHERE id = 'capsim-h'");
    for (const id of [userA, userB]) await query("DELETE FROM users WHERE id = $1", [id]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    await query("DELETE FROM cpu_grant_ledger");
    await query("DELETE FROM grant_allocator_lease");
    sim.server.close();
    await closePool();
  });

  async function seedPod(userId: string, providerState: string, sandboxId: string | null): Promise<string> {
    const podId = uuidv7();
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, $4, 'sandbox', $5, 'active', $6, $7::jsonb)`,
      [podId, orgId, userId, `sim ${sandboxId ?? "pending"}`, sandboxId, providerState, JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } })],
    );
    return podId;
  }

  async function simCreate(ownerKey: string): Promise<{ status: number; id?: string; reason?: string }> {
    const client = new SandboxClient(hostUrl, "test-platform-token");
    try {
      const created = await client.createWithOperation<{ id: string }>("/v1/sandboxes", {
        image: "sim", workdir: "/w", owner: { userKey: ownerKey }, operationKey: `sim-op-${ownerKey.slice(0, 8)}-${Date.now()}`,
      }, `sim-op-${ownerKey.slice(0, 8)}-${Date.now()}`);
      return { status: 200, id: created.id };
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      const details = (error as { details?: { reason?: string } }).details;
      return { status, reason: details?.reason };
    }
  }

  it("bootstraps: provisioning demand earns the first grant, then create succeeds", async () => {
    assert.equal(sim.isManaged(), false);
    // Brand-new owner, provisioning pod, no sandbox yet. B gets a live sim
    // sandbox while the world is still unmanaged (weights-only era).
    await seedPod(userA, "provisioning", null);
    const preManaged = await simCreate(keyB);
    assert.equal(preManaged.status, 200, "unmanaged world admits grantless creates");
    // Tick 1: A has NO live sandbox anywhere — yet the provisioning demand
    // alone must earn it a grant (otherwise its first create could never
    // succeed once managed). This PUT is the bootstrap.
    sim.putLog.length = 0;
    await runCpuAllocator({ env, log });
    const bootstrapPut = sim.putLog.find((put) => put.userKey === keyA);
    if (!bootstrapPut) {
      const ledgerRows = await query(`SELECT host_id, user_key, revision, desired_cpu_cores FROM cpu_grant_ledger`);
      const leaseRows = await query(`SELECT holder, expires_at > now() AS live FROM grant_allocator_lease`);
      const hostRows = await query(`SELECT id, url, status FROM sandbox_hosts`);
      assert.fail(
        `no bootstrap PUT (ledger=${JSON.stringify(ledgerRows.rows)} ` +
          `lease=${JSON.stringify(leaseRows.rows)} hosts=${JSON.stringify(hostRows.rows)})`,
      );
    }
    assert.equal(bootstrapPut.cpuCores, 2);
    assert.equal(sim.isManaged(), true, "first grant flips sticky managed mode");
    // A grantless owner is now refused (native assertFairnessAvailable).
    const keyC = "u_brand_new_owner";
    const refused = await simCreate(keyC);
    assert.equal(refused.status, 507);
    assert.equal(refused.reason, "fairness_degraded");
    // ...while the bootstrapped owner creates fine. B runs three live pods
    // (demand 6) so later tests have a real increase to schedule.
    await seedPod(userB, "started", "sim-ext-1");
    await seedPod(userB, "started", "sim-ext-2");
    await seedPod(userB, "started", "sim-ext-3");
    await runCpuAllocator({ env, log });
    const admitted = await simCreate(keyA);
    assert.equal(admitted.status, 200, "bootstrap grant must precede the first create");
    assert.ok(admitted.id);
  });

  it("refresh keeps effective == confirmed (no silent fallback while held)", async () => {
    // Tick repeatedly inside the 2s TTL: tenant must stay active throughout.
    for (let i = 0; i < 4; i++) {
      await runCpuAllocator({ env, log });
      await sleep(600);
    }
    assert.equal(sim.isDegraded(keyA, Date.now()), false);
    assert.equal(sim.effectiveOf(keyA, Date.now()), 2);
  });

  it("TTL lapse falls back, degrades, and placement splits per-tenant", async () => {
    await sleep(2_400);
    assert.equal(sim.isDegraded(keyA, Date.now()), true, "lapsed grant must degrade");
    // Fallback math: budget 4 / 2 sim-live owners (A lapsed + grantless B),
    // clamped [0.5, 4] → 2.
    assert.equal(sim.effectiveOf(keyA, Date.now()), 2);
    // Placement: only this host registered besides others; exclude others and
    // prove the split WHILE degraded — grantless owner out first...
    const others = new Set(
      (await listSandboxHosts("active")).map((host) => host.id).filter((id) => id !== "capsim-h"),
    );
    try {
      await placeSandboxHostForRequest({
        shape: resolveShape({}),
        exclude: others,
        placementMode: "fleet",
        freshnessMs: 30_000,
        ownerKey: "u_no_grant_yet",
        // W12: the per-tenant split needs the platform token (without it
        // the check conservatively reports false — same exclusion, but
        // for the wrong reason). The sim ignores auth; production never
        // omits it on this path.
        platformToken: "test-platform-token",
      });
      assert.fail("grantless owner must be excluded while degraded");
    } catch (error) {
      assert.equal((error as { statusCode?: number }).statusCode, 503);
    }
    // ...then re-grant A and prove a granted owner is admitted on the same
    // degraded host (per-tenant gating, not mode-level exclusion).
    await runCpuAllocator({ env, log });
    const placed = await placeSandboxHostForRequest({
      shape: resolveShape({}),
      exclude: others,
      placementMode: "fleet",
      freshnessMs: 30_000,
      ownerKey: keyA,
      platformToken: "test-platform-token",
    });
    assert.ok(placed && placed.host.id === "capsim-h");
  });

  it("applies decreases before increases (PUT order proves it)", async () => {
    // A revoked (demand gone → null) while B grows 2 → 4: the null PUT for A
    // must precede the increase PUT for B, and B must never exceed the
    // budget freed by A's confirmed decrease.
    sim.putLog.length = 0;
    await query("DELETE FROM pods WHERE user_id = $1", [userA]);
    await runCpuAllocator({ env, log });
    const order = sim.putLog.map((put) => `${put.userKey}:${put.cpuCores === null ? "null" : put.cpuCores}`);
    const revokeIdx = order.findIndex((entry) => entry.startsWith(`${keyA}:null`));
    const increaseIdx = order.findIndex((entry) => entry.startsWith(`${keyB}:4`));
    assert.ok(revokeIdx >= 0, `expected a revoke PUT for A, got ${JSON.stringify(order)}`);
    assert.ok(increaseIdx >= 0, `expected an increase PUT for B, got ${JSON.stringify(order)}`);
    assert.ok(revokeIdx < increaseIdx, `decrease must precede increase: ${JSON.stringify(order)}`);
  });
});
