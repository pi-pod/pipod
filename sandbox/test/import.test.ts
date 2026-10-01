import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ListedObject, ObjectStore } from "../src/archive/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { Manager } from "../src/core/manager.js";
import { Store } from "../src/db/index.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
import type { CgroupTree } from "../src/runtime/cgroup.js";
import type { Runtime } from "../src/runtime/crun.js";
import type { Network } from "../src/runtime/netns.js";

const IMAGE: ResolvedImage = {
  ref: "ghcr.io/pi-pod/pi-pod-base:test",
  manifestDigest: "sha256:feed",
  layers: ["sha256:layer"],
  config: { env: ["PATH=/usr/bin"], entrypoint: [], cmd: [], workingDir: "/work" },
  pulledAt: new Date(0).toISOString(),
};

const sha = (fill: string): string => fill.repeat(64).slice(0, 64);

describe("importing an archived sandbox from another host", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;
  let objects: ObjectStore;
  let listed: ListedObject[];
  let pulls: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "import-unit-"));
    store = new Store(dir);
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: "import-test-token-long-enough",
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "s3",
      PI_POD_SANDBOX_S3_BUCKET: "bucket",
      PI_POD_SANDBOX_S3_ACCESS_KEY: "key",
      PI_POD_SANDBOX_S3_SECRET_KEY: "secret",
    });
    listed = [];
    pulls = [];
    objects = {
      kind: "s3",
      put: async () => ({ key: "", size: 0 }),
      get: async () => undefined,
      head: async () => null,
      list: async (prefix: string) => listed.filter((object) => object.key.startsWith(prefix)),
      delete: async () => undefined,
    };
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const manager = (): Manager => {
    const images: ImageStore = {
      resolve: async () => null,
      pull: async (ref: string) => {
        pulls.push(ref);
        return IMAGE;
      },
      layerDir: (digest: string) => path.join(dir, digest),
      gc: async () => [],
      list: async () => [IMAGE],
    };
    return new Manager(
      cfg,
      store,
      images,
      {} as Runtime,
      {} as Network,
      {} as CgroupTree,
      objects,
      createLogger("silent"),
    );
  };

  const request = {
    id: "sb-1234567890abcdef1234",
    image: "ghcr.io/pi-pod/pi-pod-base:test",
    workdir: "/workspace",
  };

  it("adopts the newest archive as an archived sandbox without downloading it", async () => {
    listed = [
      { key: `${request.id}/upper-${sha("a")}.tar.zst`, size: 10, lastModified: 1_000 },
      { key: `${request.id}/upper-${sha("b")}.tar.zst`, size: 20, lastModified: 9_000 },
    ];

    const info = await manager().importArchived(request);

    assert.equal(info.id, request.id);
    assert.equal(info.state, "archived");
    const row = store.get(request.id)!;
    assert.equal(row.archiveKey, `${request.id}/upper-${sha("b")}.tar.zst`);
    assert.equal(row.archiveSha256, sha("b"));
    assert.equal(row.archiveSize, 20);
    assert.equal(row.workdir, "/workspace");
    assert.deepEqual(row.layers, IMAGE.layers);
    assert.deepEqual(pulls, [request.image]);
    // A request that says nothing about the network must not restore onto open Internet.
    assert.deepEqual(row.egress, { mode: "allowlist", hosts: [] });
  });

  it("keeps an explicitly requested open policy", async () => {
    listed = [{ key: `${request.id}/upper-${sha("a")}.tar.zst`, size: 1, lastModified: 1 }];

    await manager().importArchived({ ...request, egress: { mode: "open" } });

    assert.deepEqual(store.get(request.id)!.egress, { mode: "open" });
  });

  it("refuses an id that is not in the issued form", async () => {
    listed = [{ key: `../escape/upper-${sha("a")}.tar.zst`, size: 1, lastModified: 1 }];
    await assert.rejects(
      manager().importArchived({ ...request, id: "../escape" }),
      /is not a sandbox id/,
    );
    assert.equal(store.all().length, 0);
  });

  it("refuses to shadow a sandbox this host already runs", async () => {
    listed = [{ key: `${request.id}/upper-${sha("a")}.tar.zst`, size: 1, lastModified: 1 }];
    const service = manager();
    await service.importArchived(request);
    await assert.rejects(service.importArchived(request), /already exists on this host/);
  });

  it("reports a missing archive rather than creating an unrestorable sandbox", async () => {
    listed = [{ key: `${request.id}/notes.txt`, size: 1, lastModified: 1 }];
    await assert.rejects(manager().importArchived(request), /no archived workspace/);
    assert.equal(store.all().length, 0);
  });

  it("refuses to import when the host has no archive storage", async () => {
    objects = { ...objects, kind: "none" };
    await assert.rejects(manager().importArchived(request), /archive storage is not configured/);
  });
});
