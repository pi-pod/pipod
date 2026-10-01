import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
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

const IMAGE: ResolvedImage = {
  ref: "ghcr.io/pi-pod/pi-pod-base:test",
  manifestDigest: "sha256:feed",
  layers: ["sha256:layer"],
  config: { env: ["PATH=/usr/bin"], entrypoint: [], cmd: [], workingDir: "/work" },
  pulledAt: new Date(0).toISOString(),
};

function row(partial: Partial<SandboxRow> & Pick<SandboxRow, "id" | "tier" | "netIndex">): SandboxRow {
  const now = Date.now();
  return {
    image: IMAGE.ref,
    imageDigest: IMAGE.manifestDigest,
    workdir: "/workspace",
    createdAt: now,
    lastActivityAt: now,
    stoppedAt: partial.tier === "hot" ? null : now - 60_000,
    archiveAfterMinutes: 60,
    idleTimeoutMinutes: 0,
    resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 0.05 },
    ceiling: { cpu: 2, memoryGB: 4, diskGB: 0.05 },
    egress: { mode: "allowlist", hosts: [] },
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

/**
 * Regression for the control-plane poll suppression: the server treats `starting` as a fresh
 * provider transition and stops polling for its start grace window. A stop or archive that
 * reported `starting` for two seconds therefore poisoned the pod for fifteen minutes.
 */
describe("transition state reporting", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "transition-state-"));
    store = new Store(path.join(dir, "db"));
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "transition-state-token-long-enough",
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_MEMORY_BUDGET_GB: "8",
      PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
      PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.05",
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
    });
    for (const p of Object.values(cfg.paths)) fs.mkdirSync(p, { recursive: true });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const manager = (runtime: Partial<Runtime>, images: Partial<ImageStore> = {}): Manager =>
    new Manager(
      cfg,
      store,
      {
        resolve: async () => IMAGE,
        pull: async () => IMAGE,
        layerDir: (digest: string) => path.join(dir, digest),
        gc: async () => [],
        list: async () => [IMAGE],
        ...images,
      },
      runtime as Runtime,
      { destroy: async () => undefined } as unknown as Network,
      new CgroupTree("pps", path.join(dir, "cgroup")),
      createObjectStore(cfg.archive),
      createLogger("silent"),
      undefined,
      { bootId: "boot-ts", secret: ephemeralHostSecret() },
    );

  it("reports a stopping sandbox as started with transition=stop, never as starting", async () => {
    store.insert(row({ id: "sb-stop000000000000001", tier: "hot", netIndex: 1 }));
    let releaseKill: () => void = () => undefined;
    const killBlocked = new Promise<void>((resolve) => (releaseKill = resolve));
    let reachedKill: () => void = () => undefined;
    const killStarted = new Promise<void>((resolve) => (reachedKill = resolve));
    const service = manager({
      kill: async () => {
        reachedKill();
        await killBlocked;
      },
      state: async () => null,
      delete: async () => undefined,
    });

    const stopping = service.stop("sb-stop000000000000001");
    await killStarted;
    const mid = service.info("sb-stop000000000000001")!;
    assert.equal(mid.state, "started", "a stop in flight is not a boot");
    assert.equal(mid.transition, "stop");
    assert.equal(service.usageSnapshot({ cursor: null, limit: 10 }).samples[0]!.state, "started");
    assert.equal(service.isTransitioning("sb-stop000000000000001"), true);

    releaseKill();
    const done = await stopping;
    assert.equal(done.state, "stopped");
    assert.equal(done.transition, null);
  });

  it("reports a launch or restore as starting with transition=start", async () => {
    store.insert(row({ id: "sb-boot000000000000001", tier: "stopped", netIndex: 1 }));
    let reachedLaunch: () => void = () => undefined;
    const launching = new Promise<void>((resolve) => (reachedLaunch = resolve));
    let resolves = 0;
    const service = manager(
      { kill: async () => undefined, state: async () => null, delete: async () => undefined },
      // The first resolve is the image pin check before anything is in flight; launch()
      // resolves again once the transition is registered. Park that one forever.
      {
        resolve: async () => {
          resolves += 1;
          if (resolves === 1) return IMAGE;
          return await new Promise<ResolvedImage>(() => reachedLaunch());
        },
      },
    );
    void service.start("sb-boot000000000000001", {}).catch(() => undefined);
    await launching;
    const mid = service.info("sb-boot000000000000001")!;
    assert.equal(mid.state, "starting");
    assert.equal(mid.transition, "start");
  });

  it("replays a persisted operation result recorded before the field existed", async () => {
    // An operation succeeded on the previous binary: its stored SandboxInfoWire JSON has no
    // `transition`. A same-key retry must replay it unchanged, not reject or rewrite it.
    const service = manager({ kill: async () => undefined, state: async () => null, delete: async () => undefined });
    const key = "pod-legacy:create:1";
    const legacyResult = {
      id: "sb-legacy00000000000001",
      labels: {},
      state: "started",
      createdAt: new Date(0).toISOString(),
      lastActivityAt: new Date(0).toISOString(),
      image: IMAGE.ref,
      workdir: "/workspace",
      tier: "hot",
      archiveAfterMinutes: 60,
      idleTimeoutMinutes: 15,
      resources: { cpu: 0.25, memoryGB: 0.5, diskGB: 0.05 },
      ceiling: { cpu: 2, memoryGB: 4, diskGB: 0.05 },
      owner: null,
      revision: 3,
      runtimeGeneration: 1,
      stoppedAt: null,
    };
    const request = { image: IMAGE.ref, workdir: "/workspace", operationKey: key };
    const { operationKey: _omit, ...fingerprinted } = request;
    const fingerprint = `v1:${service["secret"].keyId}:${service.operations.fingerprint(fingerprinted)}`;
    assert.equal(service.operations.begin(key, fingerprint).outcome, "started");
    service.operations.succeed(key, legacyResult.id, legacyResult as never);

    const replayed = await service.create(request);
    assert.equal(replayed.id, legacyResult.id);
    assert.equal("transition" in replayed, false, "stored results are replayed verbatim");
    assert.equal(replayed.transition, undefined);
    const status = service.operationStatus(key);
    assert.equal(status.status, "succeeded");
    assert.equal(status.result?.transition, undefined);
  });

  it("reports an archive in flight as stopped with transition=archive", async () => {
    store.insert(row({ id: "sb-arch000000000000001", tier: "stopped", netIndex: 1 }));
    // The pack's first step is mounting the quota image, which needs root and fails here;
    // the transition is registered before it, and that is the window the server observes.
    const service = manager({ kill: async () => undefined, state: async () => null, delete: async () => undefined });
    const seen: Array<{ state: string; transition: string | null | undefined }> = [];
    const original = service.isTransitioning.bind(service);
    service.isTransitioning = (id: string): boolean => {
      const info = service.info(id);
      if (info) seen.push({ state: info.state, transition: info.transition });
      return original(id);
    };
    await service.archiveIfStopped("sb-arch000000000000001").catch(() => undefined);
    const final = service.info("sb-arch000000000000001")!;
    assert.equal(final.tier, "stopped");
    assert.equal(final.transition, null);
    assert.ok(seen.every((s) => s.state !== "starting"), `archive must never read as starting: ${JSON.stringify(seen)}`);
  });
});
