/**
 * Regression tests for ./shim-process-tree.js: the shim tests spawn
 * `node agentd.cjs -- node -e <fake pi>` where the fake pi idles forever, so
 * killing only the direct child orphaned thousands of `node -e` stubs with a
 * deleted cwd. These tests pin the fix: whole-tree teardown (including a
 * reparented grandchild), group isolation (unrelated processes untouched),
 * and bounded cleanup on the startup-failure path.
 */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { disposeShimTree, spawnShimTree, waitForChildExit } from "./shim-process-tree.js";

async function waitForFile(file: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A middle process that spawns a same-group grandchild, mimicking shim -> fake pi. */
const MIDDLE_SCRIPT =
  'const { spawn } = require("node:child_process"); ' +
  'const fs = require("node:fs"); ' +
  'const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" }); ' +
  'fs.writeFileSync(process.env.GC_PID_FILE, String(gc.pid)); ' +
  "setInterval(() => {}, 1000);";

describe("shim process-tree teardown", () => {
  it("reaps the direct child and a reparented grandchild, and touches nothing else", async () => {
    if (process.platform === "win32") return; // process-group semantics are POSIX-only
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-tree-"));
    try {
      // An unrelated process that must survive teardown.
      const bystander = spawnShimTree(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
      try {
        const pidFile = path.join(tmp, "grandchild.pid");
        const child = spawnShimTree(process.execPath, ["-e", MIDDLE_SCRIPT], {
          cwd: tmp,
          env: { ...process.env, GC_PID_FILE: pidFile },
        });
        try {
          await waitForFile(pidFile);
          const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
          assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild pid recorded");
          assert.ok(alive(grandchildPid), "grandchild is running before teardown");

          // Reproduce the old teardown: kill only the supervisor first.
          child.kill("SIGKILL");
          await waitForChildExit(child, 5000);
          assert.ok(alive(grandchildPid), "grandchild survives its parent's death");
          await disposeShimTree(child);

          assert.ok(child.signalCode === "SIGKILL" || child.exitCode !== null, "direct child is gone");
          assert.equal(alive(grandchildPid), false, "reparented grandchild was reaped with its group");
          assert.ok(alive(bystander.pid!), "unrelated process outside the group survives");
        } finally {
          await disposeShimTree(child);
        }
      } finally {
        await disposeShimTree(bystander);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("waits for direct-child close before returning", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-tree-close-"));
    try {
      const child = spawnShimTree(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        cwd: tmp,
      });
      let closed = false;
      child.once("close", () => { closed = true; });
      await disposeShimTree(child);
      assert.ok(closed, "close event fired before dispose returned");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cleans up on the startup-failure path without hanging", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-tree-startup-"));
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = spawnShimTree(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        cwd: tmp,
      });
      // Mimic a fixture whose startup check (hello handshake) fails after spawn.
      throw new Error("hello timeout");
    } catch (error) {
      assert.match(String(error), /hello timeout/);
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    assert.ok(child!.exitCode !== null || child!.signalCode !== null, "spawned tree reaped after startup failure");
    assert.equal(fs.existsSync(tmp), false, "tmp dir removed after startup failure");
  });

  it("escalates when a process ignores graceful shutdown", async () => {
    if (process.platform === "win32") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-tree-stubborn-"));
    const ready = path.join(tmp, "ready");
    const child = spawnShimTree(process.execPath, ["-e",
      'process.on("SIGTERM", () => {}); ' +
      'require("node:fs").writeFileSync(process.env.READY_FILE, "ready"); ' +
      'setInterval(() => {}, 1000);',
    ], { cwd: tmp, env: { ...process.env, READY_FILE: ready } });
    try {
      await waitForFile(ready);
      await disposeShimTree(child, { graceful: true, graceMs: 50 });
      assert.equal(child.signalCode, "SIGKILL", "SIGTERM-resistant child is force-killed");
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolves bounded for failed spawns, instant exits, and nullish input", async () => {
    // Failed spawn: no pid, 'error' instead of 'exit' — must still resolve bounded.
    const broken = spawnShimTree("/nonexistent-binary-pi-pod-test", []);
    broken.once("error", () => {});
    await disposeShimTree(broken, { timeoutMs: 1000, groupGraceMs: 100 });

    // Already-exited child resolves without signalling anything.
    const quick = spawnShimTree(process.execPath, ["--version"]);
    await waitForChildExit(quick, 5000);
    assert.ok(quick.exitCode === 0, "sanity: --version exited cleanly");
    await disposeShimTree(quick);

    // Nullish input is a no-op (fixtures that never got to spawn).
    await disposeShimTree(undefined);
    await disposeShimTree(null);
  });
});
