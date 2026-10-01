import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ObjectStore } from "../src/archive/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { Manager } from "../src/core/manager.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import { ServiceError } from "../src/errors.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
import { Metrics } from "../src/metrics.js";
import type { CgroupTree } from "../src/runtime/cgroup.js";
import type { Runtime } from "../src/runtime/crun.js";
import type { Network } from "../src/runtime/netns.js";

const GB = 1024 ** 3;

const IMAGE: ResolvedImage = {
  ref: "ghcr.io/pi-pod/pi-pod-base:test",
  manifestDigest: "sha256:feed",
  layers: ["sha256:layer"],
  config: { env: ["PATH=/usr/bin"], entrypoint: [], cmd: [], workingDir: "/work" },
  pulledAt: new Date(0).toISOString(),
};

const NO_ARCHIVE: ObjectStore = {
  kind: "none",
  put: async () => ({ key: "", size: 0 }),
  get: async () => undefined,
  head: async () => null,
  list: async () => [],
  delete: async () => undefined,
};

function row(partial: Partial<SandboxRow> & Pick<SandboxRow, "id" | "tier">): SandboxRow {
  const now = Date.now();
  return {
    image: IMAGE.ref,
    imageDigest: IMAGE.manifestDigest,
    workdir: "/workspace",
    createdAt: now,
    lastActivityAt: now,
    stoppedAt: partial.tier === "stopped" || partial.tier === "archived" ? now : null,
    archiveAfterMinutes: 0,
    idleTimeoutMinutes: 0,
    resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 0.05 },
    ceiling: { cpu: 2, memoryGB: 4 },
    egress: { mode: "allowlist", hosts: [] },
    netIndex: 1,
    error: null,
    archiveKey: null,
    archiveSha256: null,
    archiveSize: null,
    lastCpuUsec: 0,
    labels: {},
    layers: IMAGE.layers,
    ownerKey: null,
    revision: 0,
    runtimeGeneration: 0,
    cgroupRel: null,
    hold: null,
    archiveShared: false,
    ...partial,
  };
}

describe("lifecycle and admission metrics", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;
  let metrics: Metrics;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "metrics-lifecycle-"));
    store = new Store(dir);
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "lifecycle-test-token-long",
      PI_POD_SANDBOX_STATE_DIR: dir,
      // Exactly one 4 GiB memory ceiling fits (ceiling-first admission).
      PI_POD_SANDBOX_MEMORY_BUDGET_GB: "4",
      PI_POD_SANDBOX_RESERVE_CPU: "0",
      PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
      PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.05",
    });
    fs.mkdirSync(cfg.paths.sandboxes, { recursive: true });
    metrics = new Metrics();
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const manager = (images?: ImageStore): Manager =>
    new Manager(
      cfg,
      store,
      images ?? {
        resolve: async () => IMAGE,
        pull: async () => IMAGE,
        layerDir: (digest: string) => path.join(dir, digest),
        gc: async () => [],
        list: async () => [IMAGE],
      },
      {} as Runtime,
      {} as Network,
      {} as CgroupTree,
      NO_ARCHIVE,
      createLogger("silent"),
      metrics,
    );

  it("records one admission for create and does not also count start", async () => {
    let reachedLaunch = (): void => undefined;
    const booting = new Promise<void>((resolve) => (reachedLaunch = resolve));
    let resolves = 0;
    const images: ImageStore = {
      resolve: async () => {
        resolves += 1;
        if (resolves !== 2) return null;
        return await new Promise<ResolvedImage>(() => reachedLaunch());
      },
      pull: async () => IMAGE,
      layerDir: (digest: string) => path.join(dir, digest),
      gc: async () => [],
      list: async () => [IMAGE],
    };
    const service = manager(images);
    const request = { image: IMAGE.ref, workdir: "/workspace" };

    void service.create(request).catch(() => undefined);
    await booting;

    const mid = await metrics.scrape();
    assert.match(mid, /pps_sandbox_admissions_total\{result="ok",resource="none"\} 1/);
    assert.doesNotMatch(mid, /pps_sandbox_operations_total\{op="start"/);
    assert.doesNotMatch(mid, /pps_sandbox_operations_total\{op="create"/);

    const refusal = await service.create(request).then(
      () => null,
      (err: unknown) => err as ServiceError,
    );
    assert.equal(refusal?.status, 507);

    const after = await metrics.scrape();
    assert.match(after, /pps_sandbox_admissions_total\{result="ok",resource="none"\} 1/);
    assert.match(after, /pps_sandbox_admissions_total\{result="denied",resource="memory"\} 1/);
    assert.doesNotMatch(after, /pps_sandbox_operations_total\{op="start"/);
    assert.doesNotMatch(after, /pps_sandbox_operations_total\{op="create"/);
  });

  it("counts a later start as its own admission and operation", async () => {
    store.insert(row({ id: "sb-stopped000000000001", tier: "stopped", netIndex: 1 }));
    const service = manager();
    await assert.rejects(service.start("sb-stopped000000000001", {}));

    const text = await metrics.scrape();
    assert.match(text, /pps_sandbox_admissions_total\{result="ok",resource="none"\} 1/);
    assert.match(text, /pps_sandbox_operations_total\{op="start",result="error"\} 1/);
    assert.doesNotMatch(text, /pps_sandbox_operations_total\{op="create"/);
  });

  it("marks idempotent start/stop/delete/freeze as noop without a new admission", async () => {
    store.insert(row({ id: "sb-hot0000000000000001", tier: "hot", netIndex: 1 }));
    store.insert(row({ id: "sb-stopped000000000002", tier: "stopped", netIndex: 2 }));
    const service = manager();

    await service.start("sb-hot0000000000000001", {});
    await service.stop("sb-stopped000000000002");
    await service.delete("sb-missing000000000001");
    assert.equal(await service.freeze("sb-stopped000000000002"), false);

    const text = await metrics.scrape();
    assert.match(text, /pps_sandbox_operations_total\{op="start",result="noop"\} 1/);
    assert.match(text, /pps_sandbox_operations_total\{op="stop",result="noop"\} 1/);
    assert.match(text, /pps_sandbox_operations_total\{op="delete",result="noop"\} 1/);
    assert.match(text, /pps_sandbox_operations_total\{op="freeze",result="noop"\} 1/);
    assert.doesNotMatch(text, /pps_sandbox_admissions_total\{/);
  });
});
