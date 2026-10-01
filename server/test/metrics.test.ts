import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { buildOpsApp } from "../src/server/app.js";
import type { ServerEnv } from "../src/server/env.js";
import { EnvSchema } from "../src/server/env.js";
import {
  authorizeMetricsScrape,
  httpRouteLabel,
  isHttpMetricsExcluded,
  observeGatewayAttach,
  observeJobRun,
  observePodLaunch,
  observePushMessage,
  publishesClusterInventory,
  registerMetrics,
  renderMetrics,
  resetMetrics,
  setMetricsSources,
  workerLabel,
} from "../src/server/metrics.js";

const b64 = randomBytes(32).toString("base64");
const scrapeToken = "scrape-secret-ok"; // 16 chars, the configured minimum

function parseEnv(overrides: Record<string, string> = {}) {
  return EnvSchema.parse({
    DATABASE_URL: "postgres://test",
    ZITADEL_ISSUER: "https://auth.example.test",
    SECRETS_KEK: b64,
    ...overrides,
  });
}

describe("metrics", { concurrency: false }, () => {
  beforeEach(() => {
    resetMetrics();
  });

describe("cluster inventory ownership", () => {
  it("omits cluster gauges from an api scrape and includes them on worker", async () => {
    setMetricsSources({ role: "api" });
    const api = await renderMetrics();
    assert.doesNotMatch(api, /pipod_jobs_due/);
    assert.doesNotMatch(api, /pipod_push_queue_pending/);
    assert.doesNotMatch(api, /# TYPE pipod_pods /);

    setMetricsSources({ role: "worker" });
    const worker = await renderMetrics();
    assert.match(worker, /pipod_jobs_due/);
    assert.match(worker, /pipod_push_queue_pending/);
    assert.match(worker, /pipod_push_queue_due/);
    assert.doesNotMatch(worker, /pipod_push_queue\{/);
  });
});

describe("metrics endpoint", () => {
  it("exposes Prometheus text with process series and skips counting the scrape", async () => {
    const app = Fastify({ logger: false });
    registerMetrics(app, { role: "api" });
    app.get("/v1/pods/:podId", async () => ({ ok: true }));
    await app.ready();
    try {
      const pod = await app.inject({
        method: "GET",
        url: "/v1/pods/018f0000-0000-7000-8000-000000000001",
      });
      assert.equal(pod.statusCode, 200);

      const scrape = await app.inject({ method: "GET", url: "/metrics" });
      assert.equal(scrape.statusCode, 200);
      assert.match(scrape.headers["content-type"] as string, /text\/plain/);
      assert.equal(scrape.headers["cache-control"], "no-store");
      const body = scrape.body;
      assert.match(body, /pipod_http_requests_total\{method="GET",route="\/v1\/pods\/:podId",status="200"\}/);
      assert.match(body, /pipod_http_request_duration_seconds_bucket\{[^}]*route="\/v1\/pods\/:podId"/);
      assert.doesNotMatch(body, /018f0000-0000-7000-8000-000000000001/);
      assert.doesNotMatch(body, /pipod_http_requests_total\{[^}]*route="\/metrics"/);
      assert.match(body, /process_cpu_user_seconds_total/);
      assert.match(body, /pipod_info\{/);
      assert.doesNotMatch(body, /pipod_jobs_due/);
      assert.match(body, /^pipod_db_pool_connections /m);
      assert.match(body, /^pipod_db_pool_idle_connections /m);
      assert.match(body, /^pipod_db_pool_busy_connections /m);
      assert.match(body, /^pipod_db_pool_waiting_clients /m);
      assert.doesNotMatch(body, /pipod_db_pool_connections\{/);
    } finally {
      await app.close();
    }
  });

  it("does not record WebSocket upgrade routes in the HTTP histogram", async () => {
    const app = Fastify({ logger: false });
    registerMetrics(app, { role: "api" });
    app.get("/v1/pods/:podId/session", { config: { websocket: true } }, async () => ({ ok: true }));
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/pods/018f0000-0000-7000-8000-000000000001/session",
        headers: { upgrade: "websocket", connection: "upgrade" },
      });
      assert.ok(response.statusCode === 200 || response.statusCode >= 400);
      const scrape = await app.inject({ method: "GET", url: "/metrics" });
      assert.doesNotMatch(scrape.body, /pipod_http_requests_total\{[^}]*session/);
      assert.doesNotMatch(scrape.body, /pipod_http_request_duration_seconds_bucket\{[^}]*session/);
    } finally {
      await app.close();
    }
  });

  it("requires a bearer token when METRICS_TOKEN is configured", async () => {
    const app = Fastify({ logger: false });
    registerMetrics(app, { token: scrapeToken, role: "worker" });
    await app.ready();
    try {
      const denied = await app.inject({ method: "GET", url: "/metrics" });
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.headers["www-authenticate"], "Bearer");

      const allowed = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: `Bearer ${scrapeToken}` },
      });
      assert.equal(allowed.statusCode, 200);
      assert.match(allowed.body, /process_cpu_user_seconds_total/);
    } finally {
      await app.close();
    }
  });

  it("serves health and metrics on a worker without product routes or OpenAPI", async () => {
    const env = {
      ROLE: "worker",
      LOG_LEVEL: "silent",
      WEB_ORIGINS: [],
      METRICS_TOKEN: undefined,
    } as unknown as ServerEnv;
    const app = await buildOpsApp({ env, roles: { api: false, gateway: false } });
    await app.ready();
    try {
      assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      assert.equal(metrics.statusCode, 200);
      assert.match(metrics.body, /pipod_info\{role="worker"/);
      assert.equal((await app.inject({ method: "GET", url: "/v1/openapi.json" })).statusCode, 404);
      assert.equal((await app.inject({ method: "GET", url: "/v1/pods" })).statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

describe("domain metrics", () => {
  it("coerces unknown providers and kinds onto other rather than taking caller strings", async () => {
    observePodLaunch("sandbox", "accepted");
    observePodLaunch("host", "started");
    observePodLaunch("user-018f0000-0000-7000-8000-000000000001", "accepted");
    observeJobRun("failed");
    observeJobRun("completed");
    observeJobRun("failed", 0);
    observePushMessage("turn_completed", "enqueued");
    observePushMessage("secret-kind", "enqueued");
    observePodLaunch("e2b", "accepted");
    observePodLaunch("daytona", "accepted");
    observeGatewayAttach("host", "error");
    observeGatewayAttach("e2b", "error");
    const body = await renderMetrics();
    assert.match(body, /pipod_pod_launches_total\{provider="sandbox",result="accepted"\}/);
    assert.match(body, /pipod_pod_launches_total\{provider="host",result="started"\}/);
    assert.match(body, /pipod_pod_launches_total\{provider="other",result="accepted"\}/);
    assert.match(body, /pipod_job_runs_total\{result="failed"\}/);
    assert.match(body, /pipod_job_runs_total\{result="completed"\}/);
    assert.doesNotMatch(body, /pipod_job_runs_total\{result="claimed"\}/);
    assert.doesNotMatch(body, /pipod_job_runs_total\{result="abandoned"\}/);
    assert.match(body, /pipod_push_messages_total\{kind="turn_completed",result="enqueued"\}/);
    assert.match(body, /pipod_push_messages_total\{kind="other",result="enqueued"\}/);
    assert.match(body, /pipod_gateway_attaches_total\{provider="host",result="error"\}/);
    assert.match(body, /pipod_gateway_attaches_total\{provider="other",result="error"\}/);
    assert.match(body, /pipod_pod_launches_total\{provider="other",result="accepted"\}/);
    assert.doesNotMatch(body, /provider="e2b"/);
    assert.doesNotMatch(body, /provider="daytona"/);
    assert.doesNotMatch(body, /018f0000-0000-7000-8000-000000000001/);
    assert.doesNotMatch(body, /secret-kind/);
  });
});
});
