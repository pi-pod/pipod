/**
 * Fleet failover over real HTTP fixtures (postgres for host rows + in-process
 * fake native hosts).
 *
 * Own DB: `pipod_cost_capacity_test` — never foundation, never production.
 * Drives: capacity refusal (507 with typed details) → failover to a fitting
 * host; unsupported_shape → fast 400 (never queued); stale snapshots →
 * conservative exclusion; transport loss on create → operation lookup
 * (pending → succeeded → adopt, no duplicate); cancel by key.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import http from "node:http";
import { closePool, initPool, query } from "../src/server/db/index.js";
import { SandboxClient } from "../src/core/providers/sandbox/client.js";
import { HttpError } from "../src/server/httperrors.js";
import {
  listSandboxHosts,
  placeSandboxHostForRequest,
} from "../src/server/pods/sandboxfleet.js";
import {
  cancelHostOperation,
  isTransportAmbiguity,
  lookupOriginalOperation,
  classifyOperationStatus,
  recoverAmbiguousCreate,
} from "../src/server/pods/operations.js";
import { resolveShape } from "../src/server/pods/capacity.js";
import { typedRefusalDetail } from "../src/server/pods/sandboxfleet.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
process.env["PI_POD_SANDBOX_TOKEN"] ??= "test-platform-token";

const GB = 1024 ** 3;

function capacityReport(hostId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    hostId,
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
      cpuGrants: false,
      idempotentCreate: true,
      archiveIfStopped: true,
      usageFeed: false,
    },
    memory: {
      budgetBytes: 8 * GB,
      committedBytes: 4 * GB,
      inFlightBytes: 0,
      quarantinedBytes: 0,
      debtBytes: 0,
      availableBytes: 4 * GB,
      hostTotalBytes: 16 * GB,
      hostAvailableBytes: 8 * GB,
    },
    cpu: {
      hostCpus: 4,
      budgetCores: 3,
      committedFloorCores: 1,
      ceilingCoresSum: 4,
      sharing: "weighted-shares",
      loadAvg1: 0.5,
      pressureAvg10: 2,
    },
    disk: {
      capacityBytes: 100 * GB,
      committedBytes: 40 * GB,
      inFlightBytes: 0,
      quarantinedBytes: 0,
      allocatedBytes: 10 * GB,
      scratchBudgetBytes: 5 * GB,
      scratchUsedBytes: 0,
      availableBytes: 60 * GB,
    },
    transitions: {
      inFlight: 0,
      maxInFlight: 4,
      archivesInFlight: 0,
      maxConcurrentArchives: 2,
      pendingOperations: 0,
      quarantinedOperations: 0,
    },
    sandboxes: { hot: 1, warm: 0, stopped: 0, archived: 0, error: 0, booting: 0 },
    fairness: { mode: "local-weights", managed: false, activeGrants: 0, expiredGrants: 0, degradedTenants: 0 },
    ...overrides,
  };
}

function healthzWith(capacity: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    version: "0.1.0-test",
    uptimeSeconds: 10,
    hostId: "fixture",
    sandboxes: { hot: 1, warm: 0, stopped: 0, archived: 0 },
    host: {
      cpus: 4,
      memoryTotalBytes: 16 * GB,
      memoryAvailableBytes: 8 * GB,
      guaranteeCapacity: { cpu: 3, memoryBytes: 8 * GB },
      committed: { cpu: 1, memoryBytes: 4 * GB, diskBytes: 40 * GB },
      diskCapacityBytes: 100 * GB,
    },
    capacity,
  };
}

function sandboxInfo(id: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    labels: {},
    state: "started",
    createdAt: now,
    lastActivityAt: now,
    image: "fixture-image",
    workdir: "/workspace",
    tier: "hot",
    archiveAfterMinutes: 60,
    idleTimeoutMinutes: 15,
    resources: { cpu: 2, memoryGB: 4, diskGB: 20 },
    ceiling: { cpu: 2, memoryGB: 4, diskGB: 20 },
    owner: { userKey: "u_abc" },
    revision: 1,
    runtimeGeneration: 1,
    stoppedAt: null,
  };
}

interface Fixture {
  name: string;
  server: http.Server;
  url: string;
}

async function startFixture(
  name: string,
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<Fixture> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        handler(req, res, body);
      } catch {
        res.writeHead(500).end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { name, server, url: `http://127.0.0.1:${address.port}` };
}

describe("fleet failover over HTTP fixtures", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  let full: Fixture;
  let ok: Fixture;
  let flaky: Fixture;
  let stale: Fixture;
  let degraded: Fixture;
  let malformed: Fixture;
  let floor: Fixture;
  let mismatch: Fixture;
  let legacy: Fixture;
  let flakyOpFirstRead = true;
  const flakyOpBorn = Date.now();

  before(async () => {
    initPool(databaseUrl!);
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-platform-token";

    full = await startFixture("full", (req, res) => {
      if (req.url === "/v1/healthz") {
        const memTemplate = capacityReport("capfx-full")["memory"] as Record<string, unknown>;
        const capacity = capacityReport("capfx-full", {
          memory: { ...memTemplate, availableBytes: 0 },
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(healthzWith(capacity)));
        return;
      }
      if (req.url === "/v1/sandboxes" && req.method === "POST") {
        res.writeHead(507, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              code: "admission_denied",
              message: "host memory budget exhausted (detailed numbers in details)",
              details: {
                kind: "admission",
                reason: "memory_capacity",
                resource: "memory",
                unit: "bytes",
                required: 4 * GB,
                available: 0,
                retryable: true,
                retryAfterMs: 5000,
              },
            },
          }),
        );
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });

    ok = await startFixture("ok", (req, res) => {
      if (req.url === "/v1/healthz") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(healthzWith(capacityReport("capfx-ok"))));
        return;
      }
      if (req.url === "/v1/sandboxes" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sandboxInfo("sb-ok-1")));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });

    flaky = await startFixture("flaky", (req, res) => {
      if (req.url === "/v1/healthz") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(healthzWith(capacityReport("capfx-flaky"))));
        return;
      }
      if (req.url === "/v1/sandboxes" && req.method === "POST") {
        // Transport loss: response never arrives (socket destroyed mid-create).
        res.socket?.destroy();
        return;
      }
      const op = req.url?.match(/^\/v1\/operations\/(.+)$/);
      if (op && req.method === "GET") {
        // First read: still running. After ~800ms: succeeded with a sandbox.
        const succeeded = Date.now() - flakyOpBorn > 800 || !flakyOpFirstRead;
        flakyOpFirstRead = false;
        const now = new Date().toISOString();
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify(
            succeeded
              ? {
                  key: op[1],
                  kind: "create",
                  status: "succeeded",
                  sandboxId: "sb-adopted-1",
                  createdAt: now,
                  finishedAt: now,
                  expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
                  cancelRequested: false,
                  resolution: null,
                  crossHostRetrySafe: false,
                  result: sandboxInfo("sb-adopted-1"),
                }
              : {
                  key: op[1],
                  kind: "create",
                  status: "pending",
                  sandboxId: null,
                  createdAt: now,
                  finishedAt: null,
                  expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
                  cancelRequested: false,
                  resolution: null,
                  crossHostRetrySafe: false,
                },
          ),
        );
        return;
      }
      if (op && req.method === "DELETE") {
        const now = new Date().toISOString();
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            key: op[1],
            kind: "create",
            status: "cancelled",
            sandboxId: null,
            createdAt: now,
            finishedAt: now,
            expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
            cancelRequested: true,
            resolution: "cleaned",
            crossHostRetrySafe: true,
          }),
        );
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });

    stale = await startFixture("stale", (req, res) => {
      if (req.url === "/v1/healthz") {
        const capacity = capacityReport("capfx-stale", {
          sampledAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(healthzWith(capacity)));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });

    // Fairness-degraded host (managed, one tenant on fallback): per-tenant
    // gating still admits owners WITH an active grant (checked live here).
    degraded = await startFixture("degraded", (req, res) => {
      if (req.url === "/v1/healthz") {
        const capacity = capacityReport("capfx-degraded", {
          fairness: { mode: "degraded", managed: true, activeGrants: 1, expiredGrants: 1, degradedTenants: 1 },
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(healthzWith(capacity)));
        return;
      }
      const tenant = req.url?.match(/^\/v1\/tenants\/([^/]+)$/);
      if (tenant && req.method === "GET") {
        const userKey = decodeURIComponent(tenant[1]!);
        const granted = userKey === "u_granted";
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            userKey,
            sandboxIds: [],
            liveSandboxIds: [],
            cgroupPresent: false,
            grant: granted
              ? { revision: 9, cpuCores: 2, expiresInMs: 50_000, state: "active" }
              : null,
            effectiveCpuCores: granted ? 2 : 1,
            degraded: !granted,
          }),
        );
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });

    // Malformed contract: reachable legacy-style health, but the capacity
    // object fails validation (wrong version + negative numbers). Must never
    // become legacy eligibility — malformed evidence is not absent evidence.
    malformed = await startFixture("malformed", (req, res) => {
      if (req.url === "/v1/healthz") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify(
            healthzWith({
              contractVersion: 999,
              hostId: "fx-malformed",
              memory: { availableBytes: -5 },
            }),
          ),
        );
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });

    // Floor-mode worker: valid contract, fitting numbers, but floor
    // accounting cannot uphold full-ceiling platform admission.
    floor = await startFixture("floor", (req, res) => {
      if (req.url === "/v1/healthz") {
        const capacity = capacityReport("fx-floor", {
          capabilities: {
            ...(capacityReport("fx-floor")["capabilities"] as Record<string, unknown>),
            memoryAdmission: "floor",
          },
        });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(healthzWith(capacity)));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });

    // Identity mismatch: a VALID report naming a different host. Accepting it
    // would let one host's numbers place work onto another (confused deputy).
    mismatch = await startFixture("mismatch", (req, res) => {
      if (req.url === "/v1/healthz") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(healthzWith(capacityReport("someone-else"))));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });

    // Genuine legacy: reachable pre-contract health with NO capacity object
    // at all. Fleet mode requires explicit compat; single mode preserves it.
    legacy = await startFixture("legacy", (req, res) => {
      if (req.url === "/v1/healthz") {
        const { capacity, ...healthWithoutCapacity } = healthzWith(
          capacityReport("fx-legacy"),
        ) as Record<string, unknown>;
        void capacity;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(healthWithoutCapacity));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });

    await query("DELETE FROM sandbox_hosts WHERE id LIKE 'capfx-%'");
    await query("DELETE FROM sandbox_hosts WHERE id LIKE 'fx-%'");
    for (const [id, url] of [
      ["capfx-full", full.url],
      ["capfx-ok", ok.url],
      ["capfx-flaky", flaky.url],
      ["capfx-stale", stale.url],
      ["capfx-degraded", degraded.url],
      ["fx-malformed", malformed.url],
      ["fx-floor", floor.url],
      ["fx-mismatch", mismatch.url],
      ["fx-legacy", legacy.url],
    ] as const) {
      await query(`INSERT INTO sandbox_hosts (id, url, status) VALUES ($1, $2, 'active')`, [id, url]);
    }
  });

  after(async () => {
    await query("DELETE FROM sandbox_hosts WHERE id LIKE 'capfx-%'");
    await query("DELETE FROM sandbox_hosts WHERE id LIKE 'fx-%'");
    for (const fixture of [full, ok, flaky, stale, degraded, malformed, floor, mismatch, legacy]) fixture.server.close();
    await closePool();
  });

  it("filters refused and stale hosts and picks the fitting one", async () => {
    const hosts = await listSandboxHosts("active");
    assert.ok(hosts.some((host) => host.id === "capfx-ok"));
    const placed = await placeSandboxHostForRequest({
      shape: resolveShape({}),
      exclude: new Set(
        (await listSandboxHosts("active")).map((host) => host.id).filter((id) => !id.startsWith("capfx-")),
      ),
      placementMode: "fleet",
      freshnessMs: 30_000,
    });
    // full refuses (memory), stale is excluded (old sample), flaky+ok fit;
    // deterministic ranking picks one of the fitting hosts — never full/stale.
    assert.ok(placed && (placed.host.id === "capfx-ok" || placed.host.id === "capfx-flaky"), placed?.host.id);
    assert.ok(placed?.capacity);
  });

  it("fails fast with 400 when every known host refuses the shape itself", async () => {
    const excludeOthers = new Set(
      (await listSandboxHosts("active"))
        .map((host) => host.id)
        // Stale and degraded hosts answer 503 (unknown/unganted), never 400:
        // exclude them to isolate the shape-only verdict.
        .filter((id) => !id.startsWith("capfx-") || id === "capfx-stale" || id === "capfx-degraded"),
    );
    try {
      await placeSandboxHostForRequest({
        shape: resolveShape({ memoryGB: 8, diskGB: 20 }),
        exclude: excludeOthers,
        placementMode: "fleet",
      });
      assert.fail("should have thrown unsupported_shape");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 400);
    }
  });

  it("answers 503 (not 400) when a stale host might still support the shape", async () => {
    // capfx-stale's old sample says nothing about its maxShape: claiming
    // unsupported_shape would be dishonest, so the answer stays retryable and
    // the next probe (fresh sample) settles it.
    const excludeOthers = new Set(
      (await listSandboxHosts("active")).map((host) => host.id).filter((id) => !id.startsWith("capfx-")),
    );
    try {
      await placeSandboxHostForRequest({
        shape: resolveShape({ memoryGB: 8, diskGB: 20 }),
        exclude: excludeOthers,
        placementMode: "fleet",
      });
      assert.fail("should have thrown");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
    }
  });

  it("admits an owner WITH an active grant on a degraded host (per-tenant gating)", async () => {
    // Only the degraded host is eligible: proves the tenant-status check
    // overrides mode-level exclusion for a granted owner (bootstrap path).
    const excludeAll = new Set(
      (await listSandboxHosts("active")).map((host) => host.id).filter((id) => id !== "capfx-degraded"),
    );
    const placed = await placeSandboxHostForRequest({
      shape: resolveShape({}),
      exclude: excludeAll,
      placementMode: "fleet",
      freshnessMs: 30_000,
      ownerKey: "u_granted",
      platformToken: "test-platform-token",
    });
    assert.ok(placed && placed.host.id === "capfx-degraded", placed?.host.id);
  });

  it("excludes grantless owners from degraded hosts (allocator must issue first)", async () => {
    const excludeAll = new Set(
      (await listSandboxHosts("active")).map((host) => host.id).filter((id) => id !== "capfx-degraded"),
    );
    try {
      await placeSandboxHostForRequest({
        shape: resolveShape({}),
        exclude: excludeAll,
        placementMode: "fleet",
        freshnessMs: 30_000,
        ownerKey: "u_brand_new",
        platformToken: "test-platform-token",
      });
      assert.fail("should have thrown fairness_degraded");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
    }
    // Unknown owner without a key behaves the same (conservative).
    try {
      await placeSandboxHostForRequest({
        shape: resolveShape({}),
        exclude: excludeAll,
        placementMode: "fleet",
        freshnessMs: 30_000,
      });
      assert.fail("should have thrown fairness_degraded");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
    }
  });

  it("never trusts malformed evidence, even as the only candidate", async () => {
    // A present-but-invalid contract is NOT an absent one: it must refuse,
    // never degrade into legacy ranked-last trust.
    const onlyMalformed = new Set(
      (await listSandboxHosts("active")).map((host) => host.id).filter((id) => id !== "fx-malformed"),
    );
    try {
      await placeSandboxHostForRequest({
        shape: resolveShape({}),
        exclude: onlyMalformed,
        placementMode: "fleet",
        freshnessMs: 30_000,
      });
      assert.fail("malformed evidence must never place");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
    }
    // …and it never poisons a healthy fleet either.
    const placed = await placeSandboxHostForRequest({
      shape: resolveShape({}),
      exclude: new Set([
        ...[...(await listSandboxHosts("active"))].map((host) => host.id).filter((id) => !id.startsWith("capfx-")),
        "fx-malformed",
      ]),
      placementMode: "fleet",
      freshnessMs: 30_000,
    });
    assert.ok(placed && placed.host.id !== "fx-malformed");
  });

  it("fleet mode excludes legacy hosts by default; explicit compat admits them last", async () => {
    const onlyLegacy = new Set(
      (await listSandboxHosts("active")).map((host) => host.id).filter((id) => id !== "fx-legacy"),
    );
    try {
      await placeSandboxHostForRequest({
        shape: resolveShape({}),
        exclude: onlyLegacy,
        placementMode: "fleet",
        freshnessMs: 30_000,
      });
      assert.fail("legacy hosts must not place in fleet mode by default");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
      assert.match(String((error as { message?: unknown }).message ?? ""), /predate the capacity contract/);
    }
    // Explicit rolling-upgrade compat: admitted when explicitly allowed.
    // (Ranking-last order against contract hosts is covered by unit tests;
    // here the compat host is the only candidate.)
    const compat = await placeSandboxHostForRequest({
      shape: resolveShape({}),
      exclude: onlyLegacy,
      placementMode: "fleet",
      freshnessMs: 30_000,
      allowLegacyHosts: true,
    });
    assert.ok(compat && compat.host.id === "fx-legacy");
    // Single mode preserves the legacy path deliberately (dev/BYOK).
    const single = await placeSandboxHostForRequest({
      shape: resolveShape({}),
      exclude: onlyLegacy,
      placementMode: "single",
      freshnessMs: 30_000,
    });
    assert.ok(single && single.host.id === "fx-legacy");
  });

  it("floor-mode workers refuse as unsupported_admission (never shape, never silent)", async () => {
    const onlyFloor = new Set(
      (await listSandboxHosts("active")).map((host) => host.id).filter((id) => id !== "fx-floor"),
    );
    try {
      await placeSandboxHostForRequest({
        shape: resolveShape({}),
        exclude: onlyFloor,
        placementMode: "fleet",
        freshnessMs: 30_000,
      });
      assert.fail("floor admission must refuse platform placement");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      // A deployment condition (503), NOT a 400 shape refusal: the request
      // may be perfectly placeable once the host admits by ceiling.
      assert.equal(error.statusCode, 503);
      assert.match(String((error as { message?: unknown }).message ?? ""), /floor accounting/);
    }
  });

  it("mismatched hostId is never eligible (confused deputy)", async () => {
    const onlyMismatch = new Set(
      (await listSandboxHosts("active")).map((host) => host.id).filter((id) => id !== "fx-mismatch"),
    );
    try {
      await placeSandboxHostForRequest({
        shape: resolveShape({}),
        exclude: onlyMismatch,
        placementMode: "fleet",
        freshnessMs: 30_000,
      });
      assert.fail("a report for another host must never place here");
    } catch (error) {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
    }
  });

  it("reads typed detail from a live 507 (never host prose)", async () => {
    const client = new SandboxClient(full.url, "test-platform-token");
    const failed = await client
      .json<unknown>("POST", "/v1/sandboxes", { image: "x", workdir: "/w" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    const detail = typedRefusalDetail(failed);
    assert.equal(detail?.["reason"], "memory_capacity");
    assert.equal(detail?.["available"], 0);
    assert.equal(detail?.["retryable"], true);
  });

  it("treats a destroyed create response as ambiguous, then adopts (no duplicate)", async () => {
    const client = new SandboxClient(flaky.url, "test-platform-token");
    const failed = await client
      .json<unknown>("POST", "/v1/sandboxes", { image: "x", workdir: "/w" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(failed, "expected the destroyed socket to fail the create");
    assert.equal(isTransportAmbiguity(failed), true);

    const { status, fetchError } = await lookupOriginalOperation(client, "op-fixture-1");
    assert.equal(fetchError, null);
    assert.ok(status);
    // First read is pending → join, never another host.
    const first = classifyOperationStatus(status!.status === "pending" ? status : status, null);
    assert.ok(first.outcome === "join" || first.outcome === "replay-succeeded");

    // Full recovery: poll through pending into succeeded and adopt.
    flakyOpFirstRead = true;
    const action = await recoverAmbiguousCreate({
      originalClient: client,
      operationKey: "op-fixture-1",
      sandboxExists: async () => true,
      pollIntervalMs: 100,
      pollTimeoutMs: 10_000,
    });
    assert.deepEqual(action, { action: "adopt", sandboxId: "sb-adopted-1" });
  });

  it("cancels a host operation by key", async () => {
    const client = new SandboxClient(flaky.url, "test-platform-token");
    const cancelled = await cancelHostOperation(client, "op-fixture-cancel");
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.crossHostRetrySafe, true);
  });
});
