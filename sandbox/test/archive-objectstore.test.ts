import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createObjectStore } from "../src/archive/objectstore.js";

test("local object store put/get/head/delete round trip", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archive-store-"));
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  const source = path.join(temporary, "source.bin");
  const destination = path.join(temporary, "downloads", "destination.bin");
  const contents = Buffer.from([0, 1, 2, 3, 0xff, 0x00, 0x7f]);
  await writeFile(source, contents);
  const store = createObjectStore({ driver: "local", dir: path.join(temporary, "objects") });

  // The local driver owns the bytes, so it vouches for their checksum on put and head.
  const sha256 = createHash("sha256").update(contents).digest("hex");
  assert.deepEqual(await store.put("nested/archive.tar.zst", source, { sha256 }), {
    key: "nested/archive.tar.zst",
    size: contents.length,
    sha256,
  });
  assert.deepEqual(await store.head("nested/archive.tar.zst"), {
    key: "nested/archive.tar.zst",
    size: contents.length,
    sha256,
  });
  await assert.rejects(
    store.put("nested/bad.tar.zst", source, { sha256: "0".repeat(64) }),
    /checksum mismatch/,
  );
  assert.equal(await store.head("nested/bad.tar.zst"), null);

  await store.get("nested/archive.tar.zst", destination);
  assert.deepEqual(await readFile(destination), contents);

  await store.delete("nested/archive.tar.zst");
  await store.delete("nested/archive.tar.zst");
  assert.equal(await store.head("nested/archive.tar.zst"), null);
});

test("local object store lists keys under a prefix with sizes and mtimes", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archive-list-"));
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  const source = path.join(temporary, "source.bin");
  await writeFile(source, Buffer.alloc(11, 7));
  const store = createObjectStore({ driver: "local", dir: path.join(temporary, "objects") });
  await store.put("sb-aaaa/upper-1.tar.zst", source);
  await store.put("sb-aaaa/upper-2.tar.zst", source);
  await store.put("sb-bbbb/upper-3.tar.zst", source);
  await store.put("_dr/host-a/sandbox.sqlite", source);

  const listed = await store.list("sb-aaaa/");
  assert.deepEqual(
    listed.map((object) => object.key),
    ["sb-aaaa/upper-1.tar.zst", "sb-aaaa/upper-2.tar.zst"],
  );
  assert.deepEqual(listed.map((object) => object.size), [11, 11]);
  assert.ok(listed.every((object) => object.lastModified > 0));

  assert.deepEqual(await store.list("sb-missing/"), []);
  assert.deepEqual((await store.list("_dr/")).map((object) => object.key), [
    "_dr/host-a/sandbox.sqlite",
  ]);
});

