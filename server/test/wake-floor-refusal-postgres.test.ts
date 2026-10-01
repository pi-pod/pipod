/**
 * Cold pinned wake/restore on floor-mode hosts (postgres + fake host).
 *
 * Own org scope on the shared disposable test DB — never foundation, never
 * production. Parent directive: refusing unsafe admission loses nothing
 * authoritative, while warning-then-admitting can overbook RAM against live
 * workloads (§6 ceiling accounting). Proves:
 *
 * - a cold wake on a floor-mode host is REFUSED with a typed
 *   `unsupported_admission` error (non-retryable, never queued, never
 *   migrated cross-host), with ZERO native start calls;
 * - the pod mapping and data references are intact afterwards (same frozen
 *   host URL, same sandbox id, still stopped — retry after reconfig works);
 * - the same wake on a ceiling-mode host admits normally.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { closePool, initPool, query } from "../src/server/db/index.js";
import type { ServerEnv } from "../src/server/env.js";
import { uuidv7 } from "../src/server/ids.js";
import { ensureProviderPodStartedWithResult } from "../src/server/pods/lifecycle.js";
import type { PodServiceDeps } from "../src/server/pods/service.js";
import { EnvKekProvider } from "../src/server/secrets/crypto.js";

const databaseUrl = process.env["PI_POD_TEST_DATABASE_URL"];
const log = { info: () => {}, warn: () => {}, error: () => {} };
const GB = 1024 ** 3;

describe("cold wake on floor-mode hosts (postgres)", { skip: databaseUrl ? false : "set PI_POD_TEST_DATABASE_URL" }, () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const kek = new EnvKekProvider("test-kek", randomBytes(32).toString("base64"));
  const env = {
    GATEWAY_ID: "gateway-wake-floor",
    POD_MAX_CONCURRENT_PER_USER: 20,
    PI_POD_SANDBOX_TOKEN: "test-provider-token",
    // Fleet platform deployment: pinned evidence gate active.
    SANDBOX_PLACEMENT_MODE: "fleet",
  } as unknown as ServerEnv;
  const deps: PodServiceDeps = { env, kek, log };
  const previousToken = process.env["PI_POD_SANDBOX_TOKEN"];

  let server: http.Server;
  let hostUrl = "";
  let admissionMode: "ceiling" | "floor" = "floor";
  /** Pinned-evidence scenarios: ok-shape variants of the capacity object. */
  let probeMode: "ok" | "missing" | "malformed" | "mismatch" | "stale" | "http500" = "ok";
  let healthzHits = 0;
  const starts: string[] = [];
  const hostState = new Map<string, string>();

  function capacity(): Record<string, unknown> {
    return {
      contractVersion: 1,
      hostId: "wakefloor-h",
      bootId: "boot-1",
      serviceVersion: "t",
      generation: 1,
      sampledAt: new Date().toISOString(),
      capabilities: {
        maxShape: { cpu: 2, memoryGB: 4, diskGB: 20 },
        standardShape: { cpu: 2, memoryGB: 4, diskGB: 20 },
        resize: { memoryGrowOnline: false, memoryShrink: false, diskGrowOnline: false, diskShrink: false },
        memoryAdmission: admissionMode,
        ownerIdentity: true,
        tenantCgroups: true,
        cpuGrants: false,
        idempotentCreate: true,
        archiveIfStopped: true,
        usageFeed: false,
      },
      memory: {
        budgetBytes: 8 * GB, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0,
        debtBytes: 0, availableBytes: 8 * GB, hostTotalBytes: 16 * GB, hostAvailableBytes: 8 * GB,
      },
      cpu: {
        hostCpus: 4, budgetCores: 3, committedFloorCores: 0, ceilingCoresSum: 0,
        sharing: "weighted-shares", loadAvg1: 0, pressureAvg10: 0,
      },
      disk: {
        capacityBytes: 100 * GB, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0,
        allocatedBytes: 0, scratchBudgetBytes: 5 * GB, scratchUsedBytes: 0, availableBytes: 100 * GB,
      },
      transitions: {
        inFlight: 0, maxInFlight: 4, archivesInFlight: 0, maxConcurrentArchives: 2,
        pendingOperations: 0, quarantinedOperations: 0,
      },
      sandboxes: { hot: 0, warm: 0, stopped: 1, archived: 0, error: 0, booting: 0 },
      fairness: { mode: "local-weights", managed: false, activeGrants: 0, expiredGrants: 0, degradedTenants: 0 },
      tenancy: { ownedSandboxes: 0, unownedLive: 0, unownedInitializable: 0, unownedUncertain: 0, requireOwner: false },
    };
  }

  before(async () => {
    initPool(databaseUrl!);
    process.env["PI_POD_SANDBOX_TOKEN"] = "test-provider-token";
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/v1/healthz") {
          healthzHits += 1;
          if (probeMode === "http500") {
            res.writeHead(500).end("unreadable");
            return;
          }
          const base = capacity();
          let servedCapacity: unknown;
          if (probeMode === "missing") {
            servedCapacity = undefined;
          } else if (probeMode === "malformed") {
            servedCapacity = { contractVersion: 999, hostId: "wakefloor-h", memory: { availableBytes: -1 } };
          } else if (probeMode === "mismatch") {
            servedCapacity = { ...base, hostId: "someone-else" };
          } else if (probeMode === "stale") {
            servedCapacity = { ...base, sampledAt: new Date(Date.now() - 600_000).toISOString() };
          } else {
            servedCapacity = base;
          }
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              ok: true,
              version: "t",
              uptimeSeconds: 1,
              hostId: "wakefloor-h",
              sandboxes: { hot: 0, warm: 0, stopped: 1, archived: 0 },
              host: {
                cpus: 4,
                memoryTotalBytes: 16 * GB,
                memoryAvailableBytes: 8 * GB,
                guaranteeCapacity: { cpu: 3, memoryBytes: 8 * GB },
                committed: { cpu: 0, memoryBytes: 0, diskBytes: 0 },
                diskCapacityBytes: 100 * GB,
              },
              ...(servedCapacity === undefined ? {} : { capacity: servedCapacity }),
            }),
          );
          return;
        }
        const start = req.url?.match(/^\/v1\/sandboxes\/([^/]+)\/start$/);
        if (start && req.method === "POST") {
          const id = decodeURIComponent(start[1]!);
          starts.push(id);
          hostState.set(id, "started");
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
          return;
        }
        const get = req.url?.match(/^\/v1\/sandboxes\/([^/]+)$/);
        if (get && req.method === "GET") {
          const id = decodeURIComponent(get[1]!);
          const state = hostState.get(id) ?? "stopped";
          const now = new Date().toISOString();
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              id,
              labels: {},
              state,
              createdAt: now,
              lastActivityAt: now,
              image: "fixture-image",
              workdir: "/w",
              tier: state === "started" ? "hot" : "stopped",
              archiveAfterMinutes: 60,
              idleTimeoutMinutes: 15,
              resources: {},
              ceiling: {},
              owner: null,
              revision: 1,
              runtimeGeneration: 1,
              stoppedAt: state === "started" ? null : now,
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
    await query("INSERT INTO organizations (id, name) VALUES ($1, 'wake floor org')", [orgId]);
    await query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    // Registered platform host: the pinned evidence gate binds report.hostId
    // to this id. Without registration (BYOK/single-default) the gate stays
    // off deliberately and the host's own admission is final.
    await query("DELETE FROM sandbox_hosts WHERE id = 'wakefloor-h'");
    await query(`INSERT INTO sandbox_hosts (id, url, status) VALUES ('wakefloor-h', $1, 'active')`, [hostUrl]);
  });

  after(async () => {
    await query("DELETE FROM audit_log WHERE org_id = $1", [orgId]);
    await query("DELETE FROM pods WHERE org_id = $1", [orgId]);
    await query("DELETE FROM sandbox_hosts WHERE id = 'wakefloor-h'");
    await query("DELETE FROM users WHERE id = $1", [userId]);
    await query("DELETE FROM organizations WHERE id = $1", [orgId]);
    server.close();
    await closePool();
    if (previousToken === undefined) delete process.env["PI_POD_SANDBOX_TOKEN"];
    else process.env["PI_POD_SANDBOX_TOKEN"] = previousToken;
  });

  async function seedStoppedPod(sandboxId: string): Promise<string> {
    const podId = uuidv7();
    probeMode = "ok";
    healthzHits = 0;
    hostState.set(sandboxId, "stopped");
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'wake floor pod', 'sandbox', $4, 'active', 'stopped', $5::jsonb)`,
      [podId, orgId, userId, sandboxId, JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } })],
    );
    return podId;
  }

  it("refuses a cold wake on a floor-mode host with zero native start calls", async () => {
    admissionMode = "floor";
    starts.length = 0;
    const podId = await seedStoppedPod(`sb-floor-${uuidv7().replace(/-/g, "").slice(0, 12)}`);
    const failed = await ensureProviderPodStartedWithResult(deps, { org_id: orgId, id: podId }, null).then(
      () => null,
      (error: unknown) => error as { statusCode?: number; message?: string; detail?: unknown },
    );
    assert.ok(failed, "wake must fail on floor admission");
    assert.equal(failed.statusCode, 503);
    assert.match(failed.message ?? "", /floor accounting/);
    const detail = failed.detail as { reason?: unknown; retryable?: unknown } | undefined;
    assert.equal(detail?.reason, "unsupported_admission");
    assert.equal(detail?.retryable, false);
    assert.deepEqual(starts, [], "no native start may fly on a floor refusal");
    // Mapping and data intact: same frozen host, same sandbox, still stopped.
    const row = (
      await query<{ provider_state: string; provider_sandbox_id: string; resolved_config: unknown }>(
        `SELECT provider_state, provider_sandbox_id, resolved_config FROM pods WHERE id = $1`,
        [podId],
      )
    ).rows[0]!;
    assert.equal(row.provider_state, "stopped");
    assert.ok(row.provider_sandbox_id?.startsWith("sb-floor-"));
    const frozenUrl = (row.resolved_config as { config: { providers: { sandbox: { url: string } } } }).config.providers
      .sandbox.url;
    assert.equal(frozenUrl, hostUrl);
  });

  it("admits the same wake on a ceiling-mode host", async () => {
    admissionMode = "ceiling";
    starts.length = 0;
    const podId = await seedStoppedPod(`sb-ceil-${uuidv7().replace(/-/g, "").slice(0, 12)}`);
    const { pod, restarted } = await ensureProviderPodStartedWithResult(deps, { org_id: orgId, id: podId }, null);
    assert.equal(restarted, true);
    assert.equal(pod.provider_state, "started");
    assert.equal(starts.length, 1);
  });

  for (const mode of ["missing", "malformed", "mismatch", "stale", "http500"] as const) {
    it(`refuses cold wakes on ${mode} pinned evidence, mapping intact, zero starts`, async () => {
      admissionMode = "ceiling";
      starts.length = 0;
      const podId = await seedStoppedPod(`sb-ev-${uuidv7().replace(/-/g, "").slice(0, 12)}`);
      // Set AFTER seeding: the seeder resets the probe to ok.
      probeMode = mode;
      const failed = await ensureProviderPodStartedWithResult(deps, { org_id: orgId, id: podId }, null).then(
        () => null,
        (error: unknown) => error as { statusCode?: number; message?: string; detail?: unknown },
      );
      assert.ok(failed, `wake must fail on ${mode} evidence`);
      assert.equal(failed.statusCode, 503);
      const detail = failed.detail as { reason?: unknown; retryable?: unknown } | undefined;
      assert.equal(detail?.retryable, false);
      assert.deepEqual(starts, [], `no native start may fly on ${mode} evidence`);
      const row = (
        await query<{ provider_state: string; provider_sandbox_id: string; resolved_config: unknown }>(
          `SELECT provider_state, provider_sandbox_id, resolved_config FROM pods WHERE id = $1`,
          [podId],
        )
      ).rows[0]!;
      assert.equal(row.provider_state, "stopped");
      assert.ok(row.provider_sandbox_id?.startsWith("sb-ev-"));
      const frozenUrl = (row.resolved_config as { config: { providers: { sandbox: { url: string } } } }).config
        .providers.sandbox.url;
      assert.equal(frozenUrl, hostUrl);
    });
  }

  it("never probes evidence for already-running pods (running jobs untouched)", async () => {
    // A started pod returns before any evidence check: no healthz reads, no
    // state changes, whatever the host reports. Started with floor evidence
    // to prove the gate cannot touch live work.
    admissionMode = "floor";
    probeMode = "malformed";
    healthzHits = 0;
    const podId = uuidv7();
    hostState.set(`sb-live-${podId.slice(0, 8)}`, "started");
    await query(
      `INSERT INTO pods (id, org_id, user_id, name, provider, provider_sandbox_id, state, provider_state, resolved_config)
       VALUES ($1, $2, $3, 'live pod', 'sandbox', $4, 'active', 'started', $5::jsonb)`,
      [
        podId,
        orgId,
        userId,
        `sb-live-${podId.slice(0, 8)}`,
        JSON.stringify({ config: { providers: { sandbox: { url: hostUrl } } } }),
      ],
    );
    const { pod, restarted } = await ensureProviderPodStartedWithResult(deps, { org_id: orgId, id: podId }, null);
    assert.equal(restarted, false);
    assert.equal(pod.provider_state, "started");
    assert.equal(healthzHits, 0, "already-running pods take no evidence probe");
  });
});
