import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { ArchiveReferenceWire, ErrorResponse, SandboxInfoWire, UsageEventsResponse } from "../../src/wire.js";
import { RootHarness, rootTestSkipReason } from "./harness.js";

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * The guarded-rehome handshake end to end on two real services sharing one archive store:
 * hold the source, read its authoritative reference, import exactly that object on the
 * target, prove the target adopted the same object, prove the source cannot wake while
 * held, restore on the target byte-for-byte, and retire the source metadata without
 * touching the shared object.
 */
test("root archive manifest handshake", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const source = await RootHarness.create({ env: { PI_POD_SANDBOX_HOST_ID: "host-src" } });
  t.after(async () => source.cleanup());
  const shared = path.join(source.stateDir, "archives");
  fs.mkdirSync(shared, { recursive: true });
  const target = await RootHarness.create({ env: { PI_POD_SANDBOX_HOST_ID: "host-dst" } });
  t.after(async () => target.cleanup());
  fs.symlinkSync(shared, path.join(target.stateDir, "archives"));
  await source.pullBusybox();
  await target.pullBusybox();

  const created = await source.createSandbox({
    workdir: "/workspace",
    owner: { userKey: "user_hs" },
    resources: { diskGB: 0.01 },
    egress: { mode: "allowlist", hosts: ["api.example.test"] },
    idleTimeoutMinutes: 15,
    archiveAfterMinutes: 60,
    labels: { "pi-pod-server/pod": "pod-hs" },
  });
  const marker = `handshake-${created.id}`;
  const write = await source.exec(created.id, { argv: ["/bin/sh", "-c", `echo ${marker} > /workspace/marker`] });
  assert.equal(write.exitCode, 0, write.stderr.toString("utf8"));

  const archived = await source.json(`/v1/sandboxes/${created.id}/archive`, "POST", {});
  assert.equal(archived.status, 200, await archived.clone().text());
  const archivedInfo = await responseJson<SandboxInfoWire>(archived);
  assert.ok(archivedInfo.archive, "the archived row exposes its object reference");

  await t.test("one archived event per archive, carrying verification detail", async () => {
    const events = await responseJson<UsageEventsResponse>(await source.request("/v1/usage/events?after=0&limit=100"));
    const archivedEvents = events.events.filter((e) => e.sandboxId === created.id && e.kind === "archived");
    assert.equal(archivedEvents.length, 1);
    assert.equal(archivedEvents[0]!.detail?.uploadedBytes, archivedInfo.archive!.size);
    assert.equal(archivedEvents[0]!.detail?.verify, "backend", "the local driver vouches for the checksum");
  });

  await t.test("hold fences the source and the reference verifies", async () => {
    const held = await source.json(`/v1/sandboxes/${created.id}/hold`, "PUT", { holder: "retirement:test", reason: "rehome" });
    assert.equal(held.status, 200, await held.clone().text());
    const reference = await responseJson<ArchiveReferenceWire>(await source.request(`/v1/sandboxes/${created.id}/archive?verify=1`));
    assert.equal(reference.tier, "archived");
    assert.equal(reference.hold?.holder, "retirement:test");
    assert.equal(reference.object?.matches, true);
    assert.deepEqual(reference.archive, archivedInfo.archive);

    const wake = await source.json(`/v1/sandboxes/${created.id}/start`, "POST", {});
    assert.equal(wake.status, 409);
    assert.equal((await responseJson<ErrorResponse>(wake)).error.code, "sandbox_held");
    assert.equal(source.manager.info(created.id)!.state, "archived");
  });

  await t.test("the target adopts exactly the named object and proves it", async () => {
    const reference = await responseJson<ArchiveReferenceWire>(await source.request(`/v1/sandboxes/${created.id}/archive`));
    const wrong = await target.json("/v1/sandboxes/import", "POST", {
      id: created.id,
      image: "busybox:latest",
      workdir: "/workspace",
      owner: { userKey: "user_hs" },
      archive: { key: `${created.id}/upper-${"a".repeat(64)}.tar.zst`, sha256: "a".repeat(64) },
    });
    assert.equal(wrong.status, 409);
    assert.equal((await responseJson<ErrorResponse>(wrong)).error.code, "archive_mismatch");

    // The manifest is copied verbatim so no policy is silently reset on the target.
    const imported = await target.json("/v1/sandboxes/import", "POST", {
      id: created.id,
      ...reference.config,
      archive: reference.archive,
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    const adopted = await responseJson<SandboxInfoWire>(await target.request(`/v1/sandboxes/${created.id}`));
    assert.equal(adopted.state, "archived");
    assert.deepEqual(adopted.archive, reference.archive, "same object on both sides");
    assert.deepEqual(adopted.owner, { userKey: "user_hs" });
    assert.deepEqual(adopted.egress, { mode: "allowlist", hosts: ["api.example.test"] });
    assert.equal(adopted.idleTimeoutMinutes, 15);
    assert.equal(adopted.archiveAfterMinutes, 60);
    assert.deepEqual(adopted.labels, { "pi-pod-server/pod": "pod-hs" });
    assert.deepEqual(adopted.ceiling, created.ceiling);

    // Re-read the source: still held, same revision, same object (the belt-and-braces check).
    const again = await responseJson<ArchiveReferenceWire>(await source.request(`/v1/sandboxes/${created.id}/archive`));
    assert.equal(again.revision, reference.revision);
    assert.deepEqual(again.archive, reference.archive);
    assert.equal(again.hold?.holder, "retirement:test");
  });

  await t.test("a drifted image tag refuses the wake before any restore; the pinned digest still wakes", async () => {
    const originalResolve = target.images.resolve.bind(target.images);
    target.images.resolve = async (ref) => {
      const image = await originalResolve(ref);
      return image ? { ...image, manifestDigest: "sha256:" + "d".repeat(64) } : null;
    };
    try {
      const refused = await target.json(`/v1/sandboxes/${created.id}/start`, "POST", {});
      assert.equal(refused.status, 409, await refused.clone().text());
      assert.equal((await responseJson<ErrorResponse>(refused)).error.code, "image_mismatch");
    } finally {
      target.images.resolve = originalResolve;
    }
    const still = await responseJson<SandboxInfoWire>(await target.request(`/v1/sandboxes/${created.id}`));
    assert.equal(still.state, "archived", "no restore happened");
    assert.deepEqual(still.archive, archivedInfo.archive, "archive reference retained");
    assert.equal(fs.existsSync(path.join(target.cfg.paths.sandboxes, created.id, "writable.ext4")), false, "no local disk was created");
    assert.equal((await target.request("/v1/capacity")).status, 200);
  });

  await t.test("the target restores byte-for-byte and the retired source leaves the shared object alone", async () => {
    const started = await target.json(`/v1/sandboxes/${created.id}/start`, "POST", {});
    assert.equal(started.status, 200, await started.clone().text());
    const read = await target.exec(created.id, { argv: ["cat", "/workspace/marker"] });
    assert.equal(read.stdout.toString("utf8").trim(), marker);

    // Source metadata is retired under the hold's protection: the object stays for the target.
    // Retire while still held, with proof of the adopted object: there is no instant at
    // which the source could wake, and the object stays for the target.
    const stillHeld = await source.request(`/v1/sandboxes/${created.id}`, { method: "DELETE" });
    assert.equal(stillHeld.status, 409);
    const wrongProof = await source.json(`/v1/sandboxes/${created.id}/retire`, "POST", {
      holder: "retirement:test",
      adoptedArchive: { key: archivedInfo.archive!.key, sha256: "0".repeat(64) },
    });
    assert.equal(wrongProof.status, 409);
    const retired = await source.json(`/v1/sandboxes/${created.id}/retire`, "POST", {
      holder: "retirement:test",
      adoptedArchive: { key: archivedInfo.archive!.key, sha256: archivedInfo.archive!.sha256 },
    });
    assert.equal(retired.status, 200, await retired.clone().text());
    assert.equal((await source.request(`/v1/sandboxes/${created.id}`)).status, 404);
    assert.ok(await target.objects.head(archivedInfo.archive!.key), "shared object survives source retirement");

    // The target can still archive and restore from its own copy of the row.
    const stopped = await target.json(`/v1/sandboxes/${created.id}/stop`, "POST", {});
    assert.equal(stopped.status, 200);
    const rearchived = await target.json(`/v1/sandboxes/${created.id}/archive`, "POST", {});
    assert.equal(rearchived.status, 200, await rearchived.clone().text());
    await target.manager.delete(created.id);
  });
});
