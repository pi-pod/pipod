import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ObjectStore } from "../src/archive/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { Manager } from "../src/core/manager.js";
import { Store } from "../src/db/index.js";
import { ServiceError } from "../src/errors.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
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

describe("admission control against concurrent creates", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "admission-unit-"));
    store = new Store(dir);
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "admission-test-token-long-enough",
      PI_POD_SANDBOX_STATE_DIR: dir,
      // Room for exactly one 4 GiB memory ceiling (ceiling-first admission), and a disk
      // quota small enough that only memory can refuse anything.
      PI_POD_SANDBOX_MEMORY_BUDGET_GB: "4",
      PI_POD_SANDBOX_RESERVE_CPU: "0",
      PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
      PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.05",
    });
    fs.mkdirSync(cfg.paths.sandboxes, { recursive: true });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("holds a booting sandbox's guarantee against the next request", async () => {
    let reachedLaunch = (): void => undefined;
    const booting = new Promise<void>((resolve) => (reachedLaunch = resolve));
    let resolves = 0;
    const images: ImageStore = {
      // create() resolves first and falls through to pull(); launch() resolves again once the
      // row is inserted, so parking that call leaves the first sandbox mid-boot forever.
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
    const service = new Manager(
      cfg,
      store,
      images,
      {} as Runtime,
      {} as Network,
      {} as CgroupTree,
      NO_ARCHIVE,
      createLogger("silent"),
    );
    const request = { image: IMAGE.ref, workdir: "/workspace" };

    void service.create(request).catch(() => undefined);
    await booting;

    // The row is still STOPPED, but its full ceiling is owed from the moment it was admitted:
    // the durable reservation, not the tier, is what the next request is compared against.
    assert.equal(store.all()[0]!.tier, "stopped");
    assert.deepEqual(service.guaranteesCommitted(), { cpu: 0.25, memoryBytes: 4 * GB });
    assert.equal(service.admission.active().length, 1);
    assert.equal(service.admission.active()[0]!.kind, "create");
    const refusal = await service.create(request).then(
      () => null,
      (err: unknown) => err as ServiceError,
    );
    assert.equal(refusal?.status, 507);
    assert.match(refusal!.message, /memory capacity exhausted/);
    assert.equal(refusal?.details?.kind, "admission");
    assert.equal(refusal?.details?.kind === "admission" && refusal.details.reason, "memory_capacity");
    assert.equal(refusal?.details?.kind === "admission" && refusal.details.required, 4 * GB);
    assert.equal(refusal?.details?.kind === "admission" && refusal.details.available, 0);
    assert.equal(store.all().length, 1);
    // The refusal wrote nothing: still exactly one reservation.
    assert.equal(service.admission.active().length, 1);
  });

  it("refuses an oversized shape as unsupported instead of clamping it", async () => {
    const service = new Manager(
      cfg,
      store,
      { resolve: async () => IMAGE, pull: async () => IMAGE, layerDir: () => dir, gc: async () => [], list: async () => [IMAGE] },
      {} as Runtime,
      {} as Network,
      {} as CgroupTree,
      NO_ARCHIVE,
      createLogger("silent"),
    );
    const refusal = await service
      .create({ image: IMAGE.ref, workdir: "/workspace", resources: { memoryGB: 8 } })
      .then(() => null, (err: unknown) => err as ServiceError);
    assert.equal(refusal?.status, 400);
    assert.equal(refusal?.code, "unsupported_shape");
    assert.equal(refusal?.details?.kind === "admission" && refusal.details.reason, "unsupported_shape");
    assert.deepEqual(refusal?.details?.kind === "admission" && refusal.details.requested, { memoryGB: 8 });
    assert.deepEqual(refusal?.details?.kind === "admission" && refusal.details.maximum, { cpu: 2, memoryGB: 4, diskGB: 20 });
    assert.equal(store.all().length, 0);
    assert.equal(service.admission.active().length, 0);
  });
});
