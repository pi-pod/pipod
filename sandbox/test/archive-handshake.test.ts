import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/api/server.js";
import { createObjectStore } from "../src/archive/objectstore.js";
import type { ObjectStore } from "../src/archive/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { Manager } from "../src/core/manager.js";
import { ephemeralHostSecret } from "../src/core/secrets.js";
import { Store, type SandboxRow } from "../src/db/index.js";
import { ServiceError } from "../src/errors.js";
import type { ImageStore, ResolvedImage } from "../src/images/types.js";
import { createLogger } from "../src/log.js";
import { CgroupTree } from "../src/runtime/cgroup.js";
import type { Runtime } from "../src/runtime/crun.js";
import type { Network } from "../src/runtime/netns.js";
import type { ArchiveReferenceWire, ErrorResponse, SandboxInfoWire } from "../src/wire.js";

const TOKEN = "archive-handshake-token-long-enough";

const IMAGE: ResolvedImage = {
  ref: "ghcr.io/pi-pod/pi-pod-base:test",
  manifestDigest: "sha256:feed",
  layers: ["sha256:layer"],
  config: { env: ["PATH=/usr/bin"], entrypoint: [], cmd: [], workingDir: "/work" },
  pulledAt: new Date(0).toISOString(),
};

const images = (dir: string): ImageStore => ({
  resolve: async () => IMAGE,
  pull: async () => IMAGE,
  layerDir: (digest: string) => path.join(dir, digest),
  gc: async () => [],
  list: async () => [IMAGE],
});

function row(partial: Partial<SandboxRow> & Pick<SandboxRow, "id" | "tier" | "netIndex">): SandboxRow {
  const now = Date.now();
  return {
    image: IMAGE.ref,
    imageDigest: IMAGE.manifestDigest,
    workdir: "/workspace",
    createdAt: now,
    lastActivityAt: now,
    stoppedAt: now - 60_000,
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

describe("archive manifest handshake", () => {
  let dir: string;
  let store: Store;
  let cfg: Config;
  let objects: ObjectStore;
  let app: FastifyInstance;
  let manager: Manager;
  const id = "sb-hs00000000000000001";
  let key: string;
  let sha256: string;
  let size: number;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "archive-handshake-"));
    store = new Store(path.join(dir, "db"));
    cfg = loadConfig({
      PI_POD_SANDBOX_TOKEN: TOKEN,
      PI_POD_SANDBOX_STATE_DIR: dir,
      PI_POD_SANDBOX_MEMORY_BUDGET_GB: "8",
      PI_POD_SANDBOX_RESERVE_DISK_GB: "0",
      PI_POD_SANDBOX_DEFAULT_DISK_GB: "0.05",
      PI_POD_SANDBOX_ARCHIVE_DRIVER: "local",
      PI_POD_SANDBOX_HOST_ID: "host-src",
    });
    for (const p of Object.values(cfg.paths)) fs.mkdirSync(p, { recursive: true });
    objects = createObjectStore(cfg.archive);
    // A real object in the local store, as pack() would have left it.
    const source = path.join(dir, "upper.tar.zst");
    fs.writeFileSync(source, "workspace-bytes");
    const stored = await objects.put(`${id}/upper-${"0".repeat(64)}.tar.zst`, source);
    sha256 = stored.sha256!;
    size = stored.size;
    key = `${id}/upper-${sha256}.tar.zst`;
    await objects.put(key, source, { sha256 });
    manager = new Manager(cfg, store, images(dir), {} as Runtime, {} as Network, new CgroupTree("pps", path.join(dir, "cgroup")), objects, createLogger("silent"), undefined, {
      bootId: "boot-hs",
      secret: ephemeralHostSecret(),
    });
    app = await buildServer({ cfg, manager, objects, log: createLogger("silent"), version: "test", runtimeName: "test" });
  });

  afterEach(async () => {
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${TOKEN}` };
  const failure = async <T>(p: Promise<T>): Promise<ServiceError> => {
    try {
      await p;
    } catch (err) {
      assert.ok(err instanceof ServiceError, `expected ServiceError, got ${String(err)}`);
      return err;
    }
    assert.fail("expected the call to fail");
  };

  it("exposes the source-authoritative reference and verifies the object on request", async () => {
    store.insert(row({ id, tier: "archived", netIndex: 1, archiveKey: key, archiveSha256: sha256, archiveSize: size }));
    const reference = await manager.archiveReference(id, true);
    assert.deepEqual(reference.archive, { key, sha256, size });
    assert.equal(reference.hostId, "host-src");
    assert.equal(reference.object?.matches, true);
    assert.equal(manager.info(id)!.archive?.key, key);

    // The row points at an object that is gone: the reference says so instead of guessing latest.
    store.setArchive(id, { key: `${id}/upper-${"f".repeat(64)}.tar.zst`, sha256: "f".repeat(64), size });
    const stale = await manager.archiveReference(id, true);
    assert.equal(stale.object?.present, false);
    assert.equal(stale.object?.matches, false);

    const viaHttp = await app.inject({ method: "GET", url: `/v1/sandboxes/${id}/archive?verify=1`, headers: auth });
    assert.equal(viaHttp.statusCode, 200);
    assert.equal(viaHttp.json<ArchiveReferenceWire>().object?.present, false);
    assert.equal((await app.inject({ method: "GET", url: `/v1/sandboxes/${id}/archive` })).statusCode, 401);
  });

  it("imports exactly the named object and refuses wrong, stale or absent objects", async () => {
    const target = new Manager(cfg, store, images(dir), {} as Runtime, {} as Network, new CgroupTree("pps", path.join(dir, "cgroup")), objects, createLogger("silent"), undefined, {
      bootId: "boot-target",
      secret: ephemeralHostSecret(),
    });
    const wrongName = await failure(target.importArchived({ id, image: IMAGE.ref, workdir: "/w", archive: { key: `${id}/upper-${"1".repeat(64)}.tar.zst`, sha256 } }));
    assert.equal(wrongName.status, 400);
    const absent = await failure(target.importArchived({ id, image: IMAGE.ref, workdir: "/w", archive: { key: `${id}/upper-${"1".repeat(64)}.tar.zst`, sha256: "1".repeat(64) } }));
    assert.equal(absent.code, "archive_mismatch");
    assert.equal(absent.details?.kind === "archive" && absent.details.actual.present, false);
    const wrongSize = await failure(target.importArchived({ id, image: IMAGE.ref, workdir: "/w", archive: { key, sha256, size: size + 1 } }));
    assert.equal(wrongSize.code, "archive_mismatch");
    assert.equal(store.all().length, 0, "no metadata is created for a mismatched object");

    const adopted = await target.importArchived({ id, image: IMAGE.ref, workdir: "/w", owner: { userKey: "user_hs" }, archive: { key, sha256, size } });
    assert.deepEqual(adopted.archive, { key, sha256, size });
    assert.equal(store.get(id)!.archiveShared, true, "an imported object is never this host's to delete");

    // Same id with a different object: conflict, never a silent replacement.
    const other = await failure(target.importArchived({ id, image: IMAGE.ref, workdir: "/w", owner: { userKey: "user_hs" }, archive: { key: `${id}/upper-${"0".repeat(64)}.tar.zst`, sha256: "0".repeat(64) } }));
    assert.equal(other.status, 409);
    const same = await target.importArchived({ id, image: IMAGE.ref, workdir: "/w", owner: { userKey: "user_hs" }, archive: { key, sha256, size } });
    assert.equal(same.id, id);
  });

  it("exports the full persisted configuration and an import built from it preserves every policy", async () => {
    store.insert(row({
      id,
      tier: "archived",
      netIndex: 1,
      archiveKey: key,
      archiveSha256: sha256,
      archiveSize: size,
      ownerKey: "user_cfg",
      egress: { mode: "allowlist", hosts: ["api.example.test"] },
      archiveAfterMinutes: 60,
      idleTimeoutMinutes: 15,
      labels: { "pi-pod-server/pod": "pod-1" },
      ceiling: { cpu: 1, memoryGB: 2, diskGB: 0.02 },
    }));
    const reference = await manager.archiveReference(id, false);
    assert.deepEqual(reference.config, {
      image: IMAGE.ref,
      imageDigest: IMAGE.manifestDigest,
      workdir: "/workspace",
      resources: { cpu: 1, memoryGB: 2, diskGB: 0.02 },
      egress: { mode: "allowlist", hosts: ["api.example.test"] },
      archiveAfterMinutes: 60,
      idleTimeoutMinutes: 15,
      labels: { "pi-pod-server/pod": "pod-1" },
      owner: { userKey: "user_cfg" },
    });
    assert.equal(JSON.stringify(reference).includes("PATH="), false, "env is never exported");

    // A target that copies the manifest verbatim reproduces the row; one that sends only
    // id/image/workdir would have reset the timers to never and dropped labels.
    const targetStore = new Store(path.join(dir, "target-db"));
    const target = new Manager(cfg, targetStore, images(dir), {} as Runtime, {} as Network, new CgroupTree("pps", path.join(dir, "cgroup")), objects, createLogger("silent"), undefined, {
      bootId: "boot-target",
      secret: ephemeralHostSecret(),
    });
    const adopted = await target.importArchived({
      id,
      ...reference.config,
      owner: reference.config.owner ?? undefined,
      archive: reference.archive!,
    });
    const copy = targetStore.get(id)!;
    assert.deepEqual(copy.egress, { mode: "allowlist", hosts: ["api.example.test"] });
    assert.equal(copy.archiveAfterMinutes, 60);
    assert.equal(copy.idleTimeoutMinutes, 15);
    assert.deepEqual(copy.labels, { "pi-pod-server/pod": "pod-1" });
    assert.equal(copy.ownerKey, "user_cfg");
    assert.deepEqual(copy.ceiling, { cpu: 1, memoryGB: 2, diskGB: 0.02 });
    assert.deepEqual(adopted.egress, { mode: "allowlist", hosts: ["api.example.test"] });

    const bare = new Store(path.join(dir, "bare-db"));
    const bareTarget = new Manager(cfg, bare, images(dir), {} as Runtime, {} as Network, new CgroupTree("pps", path.join(dir, "cgroup")), objects, createLogger("silent"), undefined, {
      bootId: "boot-bare",
      secret: ephemeralHostSecret(),
    });
    const legacy = await bareTarget.importArchived({ id, image: IMAGE.ref, workdir: "/workspace", archive: reference.archive! });
    assert.deepEqual(legacy.egress, { mode: "allowlist", hosts: [] }, "a bare import still closes egress rather than opening it");
    assert.equal(legacy.idleTimeoutMinutes, 0, "but it loses the idle policy: callers must send the manifest");
    targetStore.close();
    bare.close();
  });

  it("a hold fences wake, archive, resize and delete, survives reopen, and marks the object shared", async () => {
    store.insert(row({ id, tier: "archived", netIndex: 1, archiveKey: key, archiveSha256: sha256, archiveSize: size }));
    const before = store.get(id)!.revision;
    const held = await manager.hold(id, "retirement:host-src", "guarded rehome");
    assert.equal(held.hold?.holder, "retirement:host-src");
    assert.equal(held.revision, before + 1, "a hold is a guarded transition");
    assert.equal(store.get(id)!.archiveShared, true);

    const wake = await failure(manager.start(id, {}));
    assert.equal(wake.code, "sandbox_held");
    assert.equal(wake.details?.kind, "hold");
    assert.equal((await failure(manager.setResourceCeiling(id, { diskGB: 0.06 }))).code, "sandbox_held");
    assert.equal((await failure(manager.delete(id))).code, "sandbox_held");
    assert.equal((await failure(manager.archive(id))).code, "sandbox_held");
    assert.equal(store.get(id)!.tier, "archived");

    // Idempotent for the holder, refused for anyone else, released only by the holder or force.
    await manager.hold(id, "retirement:host-src");
    assert.equal((await failure(manager.hold(id, "someone-else"))).code, "sandbox_held");
    assert.equal((await failure(manager.releaseHold(id, "someone-else", false))).code, "sandbox_held");

    const reopened = new Store(path.join(dir, "db"));
    assert.equal(reopened.get(id)!.hold?.holder, "retirement:host-src", "holds survive a restart");
    reopened.close();

    const released = await manager.releaseHold(id, "retirement:host-src", false);
    assert.equal(released.hold, null);

    const viaHttp = await app.inject({ method: "PUT", url: `/v1/sandboxes/${id}/hold`, headers: auth, payload: { holder: "ops:1" } });
    assert.equal(viaHttp.statusCode, 200);
    assert.equal(viaHttp.json<SandboxInfoWire>().hold?.holder, "ops:1");
    const heldStart = await app.inject({ method: "POST", url: `/v1/sandboxes/${id}/start`, headers: auth, payload: {} });
    assert.equal(heldStart.statusCode, 409);
    assert.equal(heldStart.json<ErrorResponse>().error.code, "sandbox_held");
    const forced = await app.inject({ method: "DELETE", url: `/v1/sandboxes/${id}/hold`, headers: auth, payload: { force: true } });
    assert.equal(forced.statusCode, 200);
    assert.equal(forced.json<SandboxInfoWire>().hold, null);
  });

  it("replays only the identical import; any changed policy, digest or owner is a conflict on both paths", async () => {
    const target = new Manager(cfg, store, images(dir), {} as Runtime, {} as Network, new CgroupTree("pps", path.join(dir, "cgroup")), objects, createLogger("silent"), undefined, {
      bootId: "boot-replay",
      secret: ephemeralHostSecret(),
    });
    const base = {
      id,
      image: IMAGE.ref,
      imageDigest: IMAGE.manifestDigest,
      workdir: "/workspace",
      resources: { cpu: 1, memoryGB: 2, diskGB: 0.02 },
      egress: { mode: "allowlist" as const, hosts: ["api.example.test"] },
      archiveAfterMinutes: 60,
      idleTimeoutMinutes: 15,
      labels: { "pi-pod-server/pod": "pod-1" },
      owner: { userKey: "user_r" },
      archive: { key, sha256, size },
    };
    const first = await target.importArchived(base);
    const identical = await target.importArchived({ ...base });
    assert.equal(identical.id, first.id);
    assert.deepEqual(identical.egress, base.egress, "genuine replay returns the row unchanged");

    const variants: Array<[string, Partial<Omit<typeof base, "egress">> & { egress?: import("../src/wire.js").EgressPolicy }]> = [
      ["imageDigest", { imageDigest: "sha256:" + "1".repeat(64) }],
      ["image", { image: "ghcr.io/pi-pod/pi-pod-base:other" }],
      ["workdir", { workdir: "/elsewhere" }],
      ["resources", { resources: { cpu: 2, memoryGB: 2, diskGB: 0.02 } }],
      ["resources", { resources: { cpu: 1, memoryGB: 4, diskGB: 0.02 } }],
      ["resources", { resources: { cpu: 1, memoryGB: 2, diskGB: 0.03 } }],
      ["egress", { egress: { mode: "open" } }],
      ["egress", { egress: { mode: "allowlist", hosts: [] } }],
      ["archiveAfterMinutes", { archiveAfterMinutes: 0 }],
      ["idleTimeoutMinutes", { idleTimeoutMinutes: 0 }],
      ["labels", { labels: { "pi-pod-server/pod": "pod-2" } }],
      ["owner", { owner: { userKey: "user_other" } }],
      ["archive", { archive: { key, sha256: "0".repeat(64), size } }],
    ];
    for (const [field, change] of variants) {
      const err = await failure(target.importArchived({ ...base, ...change }));
      assert.equal(err.status, 409, field);
      assert.match(err.message, new RegExp(`different .*${field}`), `${field}: ${err.message}`);
    }
    // Dropping a policy field is a change too (the row says 15, the request says never).
    const { idleTimeoutMinutes: _drop, ...withoutIdle } = base;
    assert.match((await failure(target.importArchived(withoutIdle))).message, /idleTimeoutMinutes/);
    // A legacy retry with no object reference cannot prove it is the same request.
    const { archive: _noArchive, ...legacy } = base;
    assert.match((await failure(target.importArchived(legacy))).hint ?? "", /archive reference/);
    // The row never changed under any of this.
    const row = store.get(id)!;
    assert.deepEqual(row.egress, base.egress);
    assert.equal(row.idleTimeoutMinutes, 15);
    assert.equal(row.ownerKey, "user_r");
    assert.equal(row.imageDigest, IMAGE.manifestDigest);
  });

  it("the concurrent-import fallback applies the same full equivalence", async () => {
    const slow: ObjectStore = {
      ...objects,
      head: async (k: string) => new Promise((resolve) => setTimeout(() => resolve(objects.head(k)), 20)),
    };
    const target = new Manager(cfg, store, images(dir), {} as Runtime, {} as Network, new CgroupTree("pps", path.join(dir, "cgroup")), slow, createLogger("silent"), undefined, {
      bootId: "boot-race",
      secret: ephemeralHostSecret(),
    });
    const a = { id, image: IMAGE.ref, workdir: "/w", owner: { userKey: "user_race" }, archive: { key, sha256, size }, labels: { attempt: "a" } };
    const b = { ...a, labels: { attempt: "b" } };
    const results = await Promise.allSettled([target.importArchived(a), target.importArchived(b)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String((rejected[0]!.reason as Error).message), /different .*labels/);
    assert.equal(store.all().length, 1);

    const identical = await Promise.all([target.importArchived(a), target.importArchived(a)]).catch(() => null);
    // Whichever attempt won, an identical replay of the stored row succeeds; a differing one never does.
    const stored = store.get(id)!;
    const winner = stored.labels.attempt === "a" ? a : b;
    assert.ok(identical !== null || stored.labels.attempt === "b");
    const replay = await target.importArchived(winner);
    assert.equal(replay.id, id);
  });

  it("refuses to wake a sandbox whose image tag now resolves to a different digest, before any restore or start", async () => {
    store.insert(row({ id, tier: "archived", netIndex: 1, archiveKey: key, archiveSha256: sha256, archiveSize: size }));
    let downloads = 0;
    let starts = 0;
    const guarded: ObjectStore = { ...objects, get: async (k, dest) => { downloads += 1; return objects.get(k, dest); } };
    let resolvedDigest = "sha256:" + "b".repeat(64);
    const drifted = new Manager(
      cfg,
      store,
      { ...images(dir), resolve: async () => ({ ...IMAGE, manifestDigest: resolvedDigest }) },
      { start: async () => { starts += 1; return 1; }, kill: async () => undefined, state: async () => null, delete: async () => undefined } as unknown as Runtime,
      {} as Network,
      new CgroupTree("pps", path.join(dir, "cgroup")),
      guarded,
      createLogger("silent"),
      undefined,
      { bootId: "boot-pin", secret: ephemeralHostSecret() },
    );
    const refused = await failure(drifted.start(id, {}));
    assert.equal(refused.code, "image_mismatch");
    assert.equal(downloads, 0, "no archive download before the pin check");
    assert.equal(starts, 0, "no runtime start");
    const after = store.get(id)!;
    assert.equal(after.tier, "archived");
    assert.equal(after.archiveKey, key, "archive reference retained");
    assert.ok(await objects.head(key), "archive object retained");
    assert.equal(drifted.admission.active().length, 0, "the wake reservation was released, not leaked");

    // A stopped row is pinned the same way.
    store.setTier(id, "stopped", { stoppedAt: Date.now() });
    assert.equal((await failure(drifted.start(id, {}))).code, "image_mismatch");
    assert.equal(starts, 0);

    // Unchanged digest passes the pin and proceeds into the launch (which then fails here for
    // lack of a runtime environment, with a different error).
    store.setTier(id, "archived");
    resolvedDigest = IMAGE.manifestDigest;
    const proceeded = await drifted.start(id, {}).then(() => null, (err: unknown) => err as Error);
    assert.ok(proceeded, "no privileged runtime here, so the launch fails later for another reason");
    assert.notEqual(proceeded instanceof ServiceError ? proceeded.code : "", "image_mismatch");
    assert.equal(downloads, 1, "the restore only begins once the image is proven identical");
  });

  it("refuses an import whose image resolves to a different digest than the source recorded", async () => {
    const drifted = new Manager(cfg, store, { ...images(dir), resolve: async () => ({ ...IMAGE, manifestDigest: "sha256:0000" }) }, {} as Runtime, {} as Network, new CgroupTree("pps", path.join(dir, "cgroup")), objects, createLogger("silent"), undefined, {
      bootId: "boot-drift",
      secret: ephemeralHostSecret(),
    });
    const mismatch = await failure(drifted.importArchived({ id, image: IMAGE.ref, workdir: "/w", imageDigest: IMAGE.manifestDigest, archive: { key, sha256, size } }));
    assert.equal(mismatch.code, "image_mismatch");
    assert.equal(store.all().length, 0);
    // Without the digest the caller explicitly accepts the host's resolution.
    const accepted = await drifted.importArchived({ id, image: IMAGE.ref, workdir: "/w", archive: { key, sha256, size } });
    assert.equal(accepted.id, id);
  });

  it("retires a held source atomically with proof of the adopted object, never releasing the hold", async () => {
    store.insert(row({ id, tier: "archived", netIndex: 1, archiveKey: key, archiveSha256: sha256, archiveSize: size }));
    const notHeld = await failure(manager.retire(id, { holder: "ops:1", adoptedArchive: { key, sha256 } }));
    assert.equal(notHeld.code, "conflict");
    const held = await manager.hold(id, "ops:1");
    const wrongHolder = await failure(manager.retire(id, { holder: "ops:2", adoptedArchive: { key, sha256 } }));
    assert.equal(wrongHolder.code, "sandbox_held");
    const wrongObject = await failure(manager.retire(id, { holder: "ops:1", adoptedArchive: { key, sha256: "0".repeat(64) } }));
    assert.equal(wrongObject.code, "archive_mismatch");
    const stale = await failure(manager.retire(id, { holder: "ops:1", expectedRevision: held.revision - 1, adoptedArchive: { key, sha256 } }));
    assert.equal(stale.code, "stale_revision");
    assert.equal(store.get(id)!.hold?.holder, "ops:1", "every refusal leaves the hold in place");

    const retired = await manager.retire(id, { holder: "ops:1", expectedRevision: held.revision, adoptedArchive: { key, sha256 } });
    assert.equal(retired.retired, true);
    assert.deepEqual(retired.archive, { key, sha256, size });
    assert.equal(store.get(id), null);
    assert.ok(await objects.head(key), "the shared object stays for the adopting host");
    assert.equal((await failure(manager.retire(id, { holder: "ops:1", adoptedArchive: { key, sha256 } }))).status, 404);
  });

  it("holds only a fully archived sandbox and fences exactly the revision that was read", async () => {
    store.insert(row({ id, tier: "hot", netIndex: 1, stoppedAt: null }));
    const live = await failure(manager.hold(id, "ops:1"));
    assert.equal(live.status, 409);
    store.setTier(id, "stopped", { stoppedAt: Date.now() });
    const stopped = await failure(manager.hold(id, "ops:1"));
    assert.equal(stopped.code, "conflict", "a stopped row has local writes no object carries");
    assert.equal(store.get(id)!.hold, null);

    store.setArchive(id, { key, sha256, size });
    store.setTier(id, "archived");
    const revision = store.get(id)!.revision;
    const stale = await failure(manager.hold(id, "ops:1", undefined, revision - 1));
    assert.equal(stale.code, "stale_revision");
    assert.equal(store.get(id)!.hold, null);
    const held = await manager.hold(id, "ops:1", undefined, revision);
    assert.equal(held.hold?.holder, "ops:1");
    // Owner initialization is a mutation the target would otherwise not see: fenced too.
    assert.equal((await failure(manager.initializeOwner(id, "user_late"))).code, "sandbox_held");
  });

  it("deleting metadata never deletes a shared object, but still deletes a private one", async () => {
    store.insert(row({ id, tier: "archived", netIndex: 1, archiveKey: key, archiveSha256: sha256, archiveSize: size, archiveShared: true }));
    await manager.delete(id);
    assert.equal(store.get(id), null);
    assert.ok(await objects.head(key), "shared object retained after metadata deletion");

    const privateId = "sb-hs00000000000000002";
    const privateKey = `${privateId}/upper-${sha256}.tar.zst`;
    await objects.put(privateKey, path.join(dir, "upper.tar.zst"), { sha256 });
    store.insert(row({ id: privateId, tier: "archived", netIndex: 2, archiveKey: privateKey, archiveSha256: sha256, archiveSize: size }));
    await manager.delete(privateId);
    assert.equal(await objects.head(privateKey), null, "a never-shared local archive is cleaned up as before");
  });
});
