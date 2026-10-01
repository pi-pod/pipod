import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { Runtime } from "../../src/runtime/crun.js";
import { rootTestSkipReason } from "./harness.js";

const execFileAsync = promisify(execFile);

/**
 * Capture the real runtime's diagnostic for a container that does not exist and prove the
 * probe accepts exactly that as absence. Everything else the probe sees is thrown as unknown,
 * so if crun ever rewords this message the gate fails here instead of a reconcile silently
 * freeing a live reservation.
 */
test("root runtime absence evidence", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const id = `sb-absent${randomBytes(8).toString("hex")}`;
  const raw = await execFileAsync("crun", ["state", id]).then(
    (r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
    (err: { code?: number; stdout?: string; stderr?: string }) => ({ code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" }),
  );
  t.diagnostic(`crun state ${id}: exit ${raw.code}; stderr=${JSON.stringify(raw.stderr.trim())}`);
  assert.notEqual(raw.code, 0);
  assert.ok(raw.stderr.includes(id), "the diagnostic must name this container's state, or absence cannot be scoped to it");

  const runtime = new Runtime("crun");
  assert.equal(await runtime.state(id), null, "the genuine nonexistent-container diagnostic is positive absence");
  // A different, never-created id is likewise absent; the probe is id-scoped, not wording-scoped.
  assert.equal(await runtime.state(`sb-absent${randomBytes(8).toString("hex")}`), null);
});
