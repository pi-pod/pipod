import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createObjectStore } from "../src/archive/objectstore.js";
import { loadConfig } from "../src/config.js";
import { Manager } from "../src/core/manager.js";
import { ephemeralHostSecret } from "../src/core/secrets.js";
import { Store } from "../src/db/index.js";
import { createLogger } from "../src/log.js";
import { CgroupTree } from "../src/runtime/cgroup.js";
import type { Runtime } from "../src/runtime/crun.js";
import type { Network } from "../src/runtime/netns.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";

const IMAGE: ResolvedImage = {
  ref: "ghcr.io/pi-pod/pi-pod-base:test",
  manifestDigest: "sha256:feed",
  layers: ["sha256:layer"],
  config: { env: ["PATH=/usr/bin"], entrypoint: [], cmd: [], workingDir: "/work" },
  pulledAt: new Date(0).toISOString(),
};

describe("forced DR snapshot", () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dr-snap-"));
    store = new Store(dir);
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("uploads even when drIntervalMinutes is 0 (Box config) and refuses kind=none", async () => {
    const cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "dr-snapshot-token-long",
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
      PI_POD_SANDBOX_DR_INTERVAL_MINUTES: "0",
      PI_POD_SANDBOX_HOST_ID: "box-drhost",
    });
    fs.mkdirSync(cfg.paths.sandboxes, { recursive: true });
    const images: ImageStore = {
      resolve: async () => IMAGE, pull: async () => IMAGE,
      layerDir: (digest) => path.join(dir, digest), gc: async () => [], list: async () => [IMAGE],
    };
    const manager = new Manager(
      cfg, store, images, {} as Runtime, {} as Network,
      new CgroupTree("pps", path.join(dir, "cgroup")),
      createObjectStore(cfg.archive), createLogger("silent"), undefined,
      { bootId: "boot-dr", secret: ephemeralHostSecret(), serviceVersion: "test" },
    );
    const shot = await manager.forceDisasterRecoverySnapshot();
    assert.match(shot.key, /^_dr\/box-drhost\/sandbox-.+\.sqlite$/);
    assert.ok(shot.size > 0);
    const noneCfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "dr-snapshot-token-long",
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "none",
      PI_POD_SANDBOX_HOST_ID: "box-drhost",
    });
    const none = new Manager(
      noneCfg, store, images, {} as Runtime, {} as Network,
      new CgroupTree("pps", path.join(dir, "cgroup-none")),
      createObjectStore(noneCfg.archive), createLogger("silent"), undefined,
      { bootId: "boot-none", secret: ephemeralHostSecret(), serviceVersion: "test" },
    );
    await assert.rejects(none.forceDisasterRecoverySnapshot(), /not configured/);
  });
});
