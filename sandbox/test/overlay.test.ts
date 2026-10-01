import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Logger } from "../src/log.js";
import { mountOverlay } from "../src/runtime/overlay.js";

test("overlay mount failures are compact for callers and complete in operator logs", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "pi-pod-overlay-error-"));
  t.after(async () => rm(temporary, { recursive: true, force: true }));

  const records: Array<{ fields: unknown; message: string }> = [];
  const log = {
    error(fields: unknown, message: string) {
      records.push({ fields, message });
    },
  } as unknown as Pick<Logger, "error">;
  const target = path.join(temporary, "merged");
  const lowers = Array.from({ length: 64 }, (_, index) =>
    path.join(temporary, "missing-layers", `layer-${String(index).padStart(3, "0")}`),
  );

  await assert.rejects(
    mountOverlay(
      {
        merged: target,
        upper: path.join(temporary, "upper"),
        work: path.join(temporary, "work"),
        lowers,
      },
      log,
    ),
    (error: Error) => {
      assert.match(error.message, new RegExp(`overlay mount failed for ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(error.message, /64 layers/);
      assert.match(error.message, /(mount:|permission denied|not permitted|does not exist)/i);
      assert.doesNotMatch(error.message, /lowerdir=/);
      assert.doesNotMatch(error.message, /layer-000/);
      assert.ok(error.message.length < 1_000, `caller error was ${error.message.length} characters`);
      return true;
    },
  );

  assert.equal(records.length, 1);
  assert.equal(records[0]!.message, "overlay mount failed");
  const operatorRecord = JSON.stringify(records[0]!.fields);
  assert.match(operatorRecord, /lowerdir=/);
  assert.match(operatorRecord, /layer-000/);
  assert.match(operatorRecord, /layer-063/);
  assert.match(operatorRecord, /"file":"mount"/);
});
