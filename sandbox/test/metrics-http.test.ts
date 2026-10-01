import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildServer } from "../src/api/server.js";
import type { ObjectStore } from "../src/archive/types.js";
import { loadConfig } from "../src/config.js";
import type { Manager } from "../src/core/manager.js";
import { createLogger } from "../src/log.js";
import { EMPTY_SNAPSHOT, Metrics, METRICS_PATH, UNMATCHED_ROUTE, type MetricsSnapshot } from "../src/metrics.js";

const TOKEN = "metrics-http-token-long-enough";

function stubManager(): Manager {
  return {
    storeRef: {
      countByTier: () => ({ hot: 1, warm: 0, stopped: 2, archived: 0, error: 0 }),
    },
    guaranteesCommitted: () => ({ cpu: 0.25, memoryBytes: 512 * 1024 * 1024 }),
    diskCapacity: () => ({ committedBytes: 0, capacityBytes: 64 * 1024 ** 3 }),
    capacityReport: () => ({
      contractVersion: 1,
      hostId: "stub",
      bootId: "boot",
      serviceVersion: "test",
      generation: 1,
      sampledAt: new Date(0).toISOString(),
      capabilities: {},
      memory: { budgetBytes: 8 * 1024 ** 3, committedBytes: 4 * 1024 ** 3, inFlightBytes: 0, quarantinedBytes: 0, debtBytes: 0, availableBytes: 4 * 1024 ** 3 },
      cpu: { budgetCores: 4, committedFloorCores: 0.25 },
      disk: { capacityBytes: 64 * 1024 ** 3, committedBytes: 0, inFlightBytes: 0, quarantinedBytes: 0 },
      transitions: {},
      sandboxes: { hot: 1, warm: 0, stopped: 2, archived: 0, error: 0, booting: 0 },
      fairness: {},
    }),
    metricsSnapshot: () => ({
      sandboxesByTier: { hot: 1, warm: 0, stopped: 2, archived: 0, error: 0 },
      committed: { cpu: 0.25, memoryBytes: 512 * 1024 * 1024 },
      disk: { committedBytes: 0, capacityBytes: 64 * 1024 ** 3 },
      ptysActive: 0,
      booting: 0,
    }),
    ptys: { aliveCount: () => 0, listFor: () => [] },
    bootingCount: () => 0,
    list: () => [],
    info: () => null,
    imagesRef: {
      list: async () => [],
      resolve: async () => null,
      pull: async () => {
        throw new Error("unused");
      },
    },
  } as unknown as Manager;
}

async function appFor(
  env: NodeJS.ProcessEnv = {},
  metrics = new Metrics({ version: "test" }),
  snapshot?: () => MetricsSnapshot,
) {
  const cfg = loadConfig({
    PI_POD_SANDBOX_TOKEN: TOKEN,
    PI_POD_SANDBOX_STATE_DIR: "/tmp/pps-metrics-http",
    PI_POD_SANDBOX_ARCHIVE_DRIVER: "none",
    ...env,
  });
  const manager = stubManager();
  metrics.bind({
    snapshot:
      snapshot ??
      (() => ({
        ...EMPTY_SNAPSHOT,
        sandboxesByTier: { hot: 1, warm: 0, stopped: 2, archived: 0, error: 0 },
        committed: { cpu: 0.25, memoryBytes: 512 * 1024 * 1024 },
        disk: { committedBytes: 0, capacityBytes: 64 * 1024 ** 3 },
      })),
  });
  const app = await buildServer({
    cfg,
    manager,
    objects: { kind: "none" } as ObjectStore,
    log: createLogger("silent"),
    version: "test",
    runtimeName: "test",
    metrics,
  });
  return { app, metrics, cfg };
}

describe("GET /metrics", () => {
  it("is open without the master token, like /v1/healthz", async () => {
    const { app } = await appFor();
    try {
      const health = await app.inject({ method: "GET", url: "/v1/healthz" });
      assert.equal(health.statusCode, 200);

      const scrape = await app.inject({ method: "GET", url: METRICS_PATH });
      assert.equal(scrape.statusCode, 200);
      assert.match(scrape.headers["content-type"] ?? "", /text\/plain/);
      assert.equal(scrape.headers["cache-control"], "no-store");
      assert.match(scrape.body, /pps_http_requests_total\{method="GET",route="\/v1\/healthz",status="200"\}/);
      assert.match(scrape.body, /pps_sandboxes\{tier="hot"\} 1/);
      assert.match(scrape.body, /pps_build_info\{version="test"\} 1/);
    } finally {
      await app.close();
    }
  });

  it("does not accept the master API token as a substitute when a scrape token is set", async () => {
    const scrapeToken = "metrics-scrape-token-1";
    const { app } = await appFor({ PI_POD_SANDBOX_METRICS_TOKEN: scrapeToken });
    try {
      const missing = await app.inject({ method: "GET", url: METRICS_PATH });
      assert.equal(missing.statusCode, 401);

      const master = await app.inject({
        method: "GET",
        url: METRICS_PATH,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(master.statusCode, 401);

      const ok = await app.inject({
        method: "GET",
        url: METRICS_PATH,
        headers: { authorization: `Bearer ${scrapeToken}` },
      });
      assert.equal(ok.statusCode, 200);
      assert.match(ok.body, /pps_build_info/);
    } finally {
      await app.close();
    }
  });

  it("still requires the master token for the control plane", async () => {
    const { app } = await appFor();
    try {
      const authz = await app.inject({ method: "GET", url: "/v1/authz" });
      assert.equal(authz.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  it("records parameterized routes and never emits sandbox ids", async () => {
    const { app } = await appFor();
    try {
      const missing = await app.inject({
        method: "GET",
        url: "/v1/sandboxes/sb-secrettestid123456",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(missing.statusCode, 404);

      const scrape = await app.inject({ method: "GET", url: METRICS_PATH });
      assert.equal(scrape.statusCode, 200);
      assert.match(
        scrape.body,
        /pps_http_requests_total\{method="GET",route="\/v1\/sandboxes\/:id",status="404"\} 1/,
      );
      assert.doesNotMatch(scrape.body, /sb-secrettestid123456/);
      assert.doesNotMatch(scrape.body, new RegExp(TOKEN));
    } finally {
      await app.close();
    }
  });

  it("collapses every unknown path onto one unmatched route label", async () => {
    const { app } = await appFor();
    try {
      const unknowns = ["/nope", "/v1/does-not-exist", "/totally/sb-secrettestid123456/random"];
      for (const url of unknowns) {
        const res = await app.inject({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.statusCode, 404);
      }

      const scrape = await app.inject({ method: "GET", url: METRICS_PATH });
      assert.equal(scrape.statusCode, 200);
      assert.match(
        scrape.body,
        new RegExp(
          `pps_http_requests_total\\{method="GET",route="${UNMATCHED_ROUTE}",status="404"\\} 3`,
        ),
      );
      assert.doesNotMatch(scrape.body, /route="\/nope"/);
      assert.doesNotMatch(scrape.body, /does-not-exist/);
      assert.doesNotMatch(scrape.body, /sb-secrettestid123456/);
    } finally {
      await app.close();
    }
  });

  it("keeps /metrics 200 when a snapshot collector throws", async () => {
    const { app } = await appFor({}, new Metrics({ version: "test" }), () => {
      throw new Error("statfs failed");
    });
    try {
      const scrape = await app.inject({ method: "GET", url: METRICS_PATH });
      assert.equal(scrape.statusCode, 200);
      assert.match(scrape.body, /pps_sandboxes\{tier="hot"\} 0/);
      assert.doesNotMatch(scrape.body, /statfs failed/);
    } finally {
      await app.close();
    }
  });
});
