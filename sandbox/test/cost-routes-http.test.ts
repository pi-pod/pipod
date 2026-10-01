import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/api/server.js";
import { createObjectStore } from "../src/archive/objectstore.js";
import { loadConfig, type Config } from "../src/config.js";
import { Manager } from "../src/core/manager.js";
import { ephemeralHostSecret } from "../src/core/secrets.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
import { CgroupTree } from "../src/runtime/cgroup.js";
import type { Runtime } from "../src/runtime/crun.js";
import type { Network } from "../src/runtime/netns.js";
import type { CapacityReportV1, ErrorResponse, HealthResponse, OperationStatusWire, UsageSnapshotV1 } from "../src/wire.js";

const TOKEN = "cost-routes-token-long-enough-1";
const GB = 1024 ** 3;

const IMAGE: ResolvedImage = {
  ref: "ghcr.io/pi-pod/pi-pod-base:test",
  manifestDigest: "sha256:feed",
  layers: ["sha256:layer"],
  config: { env: ["PATH=/usr/bin"], entrypoint: [], cmd: [], workingDir: "/work" },
  pulledAt: new Date(0).toISOString(),
};

function stoppedRow(id: string, netIndex: number, ownerKey: string | null = null): SandboxRow {
  const now = Date.now();
  return {
    id,
    image: IMAGE.ref,
    imageDigest: IMAGE.manifestDigest,
    workdir: "/workspace",
    tier: "stopped",
    createdAt: now,
    lastActivityAt: now,
    stoppedAt: now - 60_000,
    archiveAfterMinutes: 60,
    idleTimeoutMinutes: 0,
    resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 0.05 },
    ceiling: { cpu: 2, memoryGB: 4, diskGB: 0.05 },
    egress: { mode: "allowlist", hosts: [] },
    netIndex,
    error: null,
    archiveKey: null,
    archiveSha256: null,
    archiveSize: null,
    lastCpuUsec: 0,
    labels: {},
    layers: IMAGE.layers,
    ownerKey,
    revision: 0,
    runtimeGeneration: 0,
    cgroupRel: null,
    hold: null,
    archiveShared: false,
  };
}

describe("cost-control routes", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;
  let app: FastifyInstance;
  let manager: Manager;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "cost-routes-"));
    store = new Store(path.join(dir, "db"));
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: TOKEN,
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_MEMORY_BUDGET_GB: "8",
      PI_POD_SANDBOX_RESERVE_CPU: "0",
      PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
      // Small default quota so the temp filesystem, not the request, decides nothing here.
      PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.05",
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
      PI_POD_SANDBOX_HOST_ID: "host-routes",
    });
    fs.mkdirSync(cfg.paths.sandboxes, { recursive: true });
    const images: ImageStore = {
      resolve: async () => IMAGE,
      pull: async () => IMAGE,
      layerDir: (digest) => path.join(dir, digest),
      gc: async () => [],
      list: async () => [IMAGE],
    };
    const objects = createObjectStore(cfg.archive);
    manager = new Manager(
      cfg,
      store,
      images,
      {} as Runtime,
      {} as Network,
      new CgroupTree("pps", path.join(dir, "cgroup")),
      objects,
      createLogger("silent"),
      undefined,
      { bootId: "boot-routes", secret: ephemeralHostSecret(), serviceVersion: "test" },
    );
    app = await buildServer({ cfg, manager, objects, log: createLogger("silent"), version: "test", runtimeName: "test" });
  });

  afterEach(async () => {
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

  it("serves the capacity contract authenticated and embeds host aggregates in healthz", async () => {
    store.insert(stoppedRow("sb-cap000000000000000001", 1));
    const anonymous = await app.inject({ method: "GET", url: "/v1/capacity" });
    assert.equal(anonymous.statusCode, 401);
    const capacity = await app.inject({ method: "GET", url: "/v1/capacity", headers: auth });
    assert.equal(capacity.statusCode, 200);
    const report = capacity.json<CapacityReportV1>();
    assert.equal(report.contractVersion, 1);
    assert.equal(report.hostId, "host-routes");
    assert.equal(report.memory.budgetBytes, 8 * GB);
    assert.equal(report.disk.committedBytes, 0.05 * GB);

    const health = await app.inject({ method: "GET", url: "/v1/healthz" });
    assert.equal(health.statusCode, 200);
    const body = health.json<HealthResponse>();
    assert.equal(body.capacity?.contractVersion, 1);
    // Legacy fields are the same numbers admission compares, not a second computation.
    assert.equal(body.host.guaranteeCapacity.memoryBytes, 8 * GB);
    assert.equal(body.host.committed.diskBytes, 0.05 * GB);
    assert.equal(body.sandboxes.stopped, 1);
  });

  it("renders typed error details for capacity and shape refusals", async () => {
    const shape = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      headers: auth,
      payload: { image: IMAGE.ref, workdir: "/w", resources: { memoryGB: 8 } },
    });
    assert.equal(shape.statusCode, 400);
    const error = shape.json<ErrorResponse>().error;
    assert.equal(error.code, "unsupported_shape");
    assert.equal(error.details?.kind, "admission");
    assert.equal(error.details?.kind === "admission" && error.details.retryable, false);
    assert.deepEqual(error.details?.kind === "admission" && error.details.maximum, { cpu: 2, memoryGB: 4, diskGB: 20 });
    assert.doesNotMatch(JSON.stringify(error), /\/tmp\//);
  });

  it("accepts the Idempotency-Key header, rejects a disagreeing body, and exposes operation status", async () => {
    const disagree = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      headers: { ...auth, "idempotency-key": "pod-1:create:2" },
      payload: { image: IMAGE.ref, workdir: "/w", operationKey: "pod-1:create:3" },
    });
    assert.equal(disagree.statusCode, 400);

    // Launching without a runtime fails after the row exists: cleanup is uncertain, so the
    // operation is recorded as quarantined and not safe to retry on another host.
    const created = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      headers: { ...auth, "idempotency-key": "pod-1:create:2" },
      payload: { image: IMAGE.ref, workdir: "/w" },
    });
    // Without a runtime the launch fails after the row exists (the exact error depends on
    // what the host lacks first); what matters is the recorded resolution and the replay.
    assert.ok(created.statusCode >= 400, `expected a failure, got ${created.statusCode}`);
    const status = await app.inject({ method: "GET", url: "/v1/operations/pod-1:create:2", headers: auth });
    assert.equal(status.statusCode, 200);
    const op = status.json<OperationStatusWire>();
    assert.equal(op.status, "failed");
    assert.equal(op.resolution, "quarantined");
    assert.equal(op.crossHostRetrySafe, false);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      headers: { ...auth, "idempotency-key": "pod-1:create:2" },
      payload: { image: IMAGE.ref, workdir: "/w" },
    });
    assert.equal(replay.statusCode, created.statusCode, "same key replays the recorded failure instead of launching again");
    assert.equal(replay.json<ErrorResponse>().error.code, created.json<ErrorResponse>().error.code);
    assert.equal(store.all().length, 0);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/sandboxes",
      headers: { ...auth, "idempotency-key": "pod-1:create:2" },
      payload: { image: IMAGE.ref, workdir: "/other" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json<ErrorResponse>().error.code, "idempotency_conflict");

    const cleaned = await app.inject({ method: "DELETE", url: "/v1/operations/pod-1:create:2", headers: auth });
    assert.equal(cleaned.statusCode, 200);
    assert.equal(cleaned.json<OperationStatusWire>().resolution, "cleaned");
    assert.equal(cleaned.json<OperationStatusWire>().crossHostRetrySafe, true);

    const missing = await app.inject({ method: "GET", url: "/v1/operations/pod-none:create:9", headers: auth });
    assert.equal(missing.statusCode, 404);
  });

  it("guards archive-if-stopped input and returns outcomes, never errors, for guard misses", async () => {
    store.insert(stoppedRow("sb-arc000000000000000001", 1));
    const bad = await app.inject({
      method: "POST",
      url: "/v1/sandboxes/sb-arc000000000000000001/archive-if-stopped",
      headers: auth,
      payload: { expectedRevision: 1.5 },
    });
    assert.equal(bad.statusCode, 400);
    const stale = await app.inject({
      method: "POST",
      url: "/v1/sandboxes/sb-arc000000000000000001/archive-if-stopped",
      headers: auth,
      payload: { expectedRevision: 7 },
    });
    assert.equal(stale.statusCode, 200);
    assert.deepEqual(
      [stale.json().archived, stale.json().outcome, stale.json().sandbox.revision],
      [false, "revision_mismatch", 0],
    );
  });

  it("initializes a legacy owner once with the master token only", async () => {
    store.insert(stoppedRow("sb-own000000000000000001", 1));
    const anonymous = await app.inject({ method: "PUT", url: "/v1/sandboxes/sb-own000000000000000001/owner", payload: { owner: { userKey: "user_a" } } });
    assert.equal(anonymous.statusCode, 401);
    const missing = await app.inject({ method: "PUT", url: "/v1/sandboxes/sb-own000000000000000001/owner", headers: auth, payload: {} });
    assert.equal(missing.statusCode, 400);
    const set = await app.inject({ method: "PUT", url: "/v1/sandboxes/sb-own000000000000000001/owner", headers: auth, payload: { owner: { userKey: "user_a" } } });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().changed, true);
    assert.deepEqual(set.json().sandbox.owner, { userKey: "user_a" });
    const replay = await app.inject({ method: "PUT", url: "/v1/sandboxes/sb-own000000000000000001/owner", headers: auth, payload: { owner: { userKey: "user_a" } } });
    assert.equal(replay.json().changed, false);
    const other = await app.inject({ method: "PUT", url: "/v1/sandboxes/sb-own000000000000000001/owner", headers: auth, payload: { owner: { userKey: "user_b" } } });
    assert.equal(other.statusCode, 409);
    assert.equal(other.json<ErrorResponse>().error.code, "owner_conflict");
    const capacity = (await app.inject({ method: "GET", url: "/v1/capacity", headers: auth })).json<CapacityReportV1>();
    assert.deepEqual(capacity.tenancy, { ownedSandboxes: 1, unownedLive: 0, unownedInitializable: 0, unownedUncertain: 0, requireOwner: false });
  });

  it("validates tenant CPU grants and reports tenant status", async () => {
    const invalid = await app.inject({
      method: "PUT",
      url: "/v1/tenants/user_a/cpu-grant",
      headers: auth,
      payload: { revision: 1, cpuCores: 1, ttlMs: 10 },
    });
    assert.equal(invalid.statusCode, 400);
    const badKey = await app.inject({
      method: "PUT",
      url: "/v1/tenants/not%20a%20key/cpu-grant",
      headers: auth,
      payload: { revision: 1, cpuCores: 1, ttlMs: 10_000 },
    });
    assert.equal(badKey.statusCode, 400);
    const granted = await app.inject({
      method: "PUT",
      url: "/v1/tenants/user_a/cpu-grant",
      headers: auth,
      payload: { revision: 1, cpuCores: 1, ttlMs: 10_000 },
    });
    assert.equal(granted.statusCode, 200);
    assert.equal(granted.json().applied, false);
    assert.equal(granted.json().grant.state, "active");
    const stale = await app.inject({
      method: "PUT",
      url: "/v1/tenants/user_a/cpu-grant",
      headers: auth,
      payload: { revision: 1, cpuCores: 2, ttlMs: 10_000 },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json<ErrorResponse>().error.code, "stale_revision");
    const status = await app.inject({ method: "GET", url: "/v1/tenants/user_a", headers: auth });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().grant.revision, 1);
    assert.equal(status.json().cgroupPresent, false);
    assert.equal(status.json().degraded, false);
  });

  it("serves usage snapshots and the acknowledged event outbox only to the master token", async () => {
    store.insert(stoppedRow("sb-use000000000000000001", 1, "user_u"));
    store.insert(stoppedRow("sb-use000000000000000002", 2, "user_u"));
    assert.equal((await app.inject({ method: "GET", url: "/v1/usage" })).statusCode, 401);
    const page = await app.inject({ method: "GET", url: "/v1/usage?limit=1", headers: auth });
    assert.equal(page.statusCode, 200);
    const snapshot = page.json<UsageSnapshotV1>();
    assert.equal(snapshot.samples.length, 1);
    assert.equal(snapshot.nextCursor, "sb-use000000000000000001");
    assert.equal(snapshot.samples[0]!.ownerKey, "user_u");
    const rest = await app.inject({ method: "GET", url: `/v1/usage?limit=1&cursor=${snapshot.nextCursor}`, headers: auth });
    assert.equal(rest.json<UsageSnapshotV1>().nextCursor, null);

    manager.usage.record({ kind: "stopped", sandboxId: "sb-use000000000000000001", ownerKey: "user_u", runtimeGeneration: 1 });
    const events = await app.inject({ method: "GET", url: "/v1/usage/events?after=0&limit=10", headers: auth });
    assert.equal(events.statusCode, 200);
    assert.equal(events.json().events.length, 1);
    const ack = await app.inject({ method: "POST", url: "/v1/usage/events/ack", headers: auth, payload: { upTo: events.json().nextAfter } });
    assert.equal(ack.statusCode, 200);
    assert.equal(ack.json().retained, 0);
    const badAck = await app.inject({ method: "POST", url: "/v1/usage/events/ack", headers: auth, payload: {} });
    assert.equal(badAck.statusCode, 400);
  });
});
