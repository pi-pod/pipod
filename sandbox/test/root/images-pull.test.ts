import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { OciImageStore } from "../../src/images/store.js";

const enabled = process.env.PI_POD_SANDBOX_NETWORK_TESTS === "1";

test("pulls busybox and resolves it from local state", { skip: enabled ? false : "network tests are disabled" }, async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "pi-pod-images-pull-"));
  t.after(async () => rm(stateDir, { recursive: true, force: true }));
  const store = new OciImageStore({ stateDir });

  const pulled = await store.pull("docker.io/library/busybox:latest");
  assert.ok(pulled.layers.length > 0);
  await Promise.any(pulled.layers.map((digest) => access(path.join(store.layerDir(digest), "bin", "busybox"))));
  assert.deepEqual(await store.resolve("busybox"), pulled);
});
