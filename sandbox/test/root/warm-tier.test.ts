import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Reaper } from "../../src/core/reaper.js";
import { RootHarness, rootTestSkipReason } from "./harness.js";

const MINUTE = 60_000;

test("root warm tier and reaper integration", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }

  const harness = await RootHarness.create({
    server: false,
    env: {
      PI_POD_SANDBOX_WARM_AFTER_MINUTES: "0.001",
      PI_POD_SANDBOX_CPU_VETO_MS: "2",
      PI_POD_SANDBOX_PRESSURE_THRESHOLD: "1000000",
      PI_POD_SANDBOX_REAPER_INTERVAL_MS: "25",
    },
  });
  t.after(async () => harness.cleanup());
  await harness.pullBusybox();

  const reaper = new Reaper(
    harness.cfg,
    harness.store,
    harness.manager,
    harness.cgroups,
    harness.objects,
    harness.log,
  );

  await t.test("warm remains started and exec transparently thaws", async () => {
    const sandbox = await harness.createSandbox();
    try {
      await harness.manager.freeze(sandbox.id);
      const freezeFile = `${harness.cgroups.sandbox(sandbox.id).dir}/cgroup.freeze`;
      assert.equal(fs.readFileSync(freezeFile, "utf8").trim(), "1");
      assert.equal(harness.manager.info(sandbox.id)?.state, "started");
      assert.equal(harness.manager.info(sandbox.id)?.tier, "warm");

      const result = await harness.manager.execCollect(sandbox.id, { argv: ["sh", "-c", "printf thawed"] });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "thawed");
      assert.equal(fs.readFileSync(freezeFile, "utf8").trim(), "0");
      assert.equal(harness.manager.info(sandbox.id)?.tier, "hot");
    } finally {
      await harness.manager.delete(sandbox.id);
    }
  });

  await t.test("CPU veto preserves busy work while idle work stops", async () => {
    const idleTimeoutMinutes = 0.015;
    const idle = await harness.createSandbox({ idleTimeoutMinutes });
    const busy = await harness.createSandbox({ idleTimeoutMinutes });
    try {
      await harness.manager.touch(idle.id);
      await harness.manager.touch(busy.id);
      await reaper.tick(Date.now());

      const background = await harness.manager.execCollect(busy.id, {
        argv: ["sh", "-c", "while :; do :; done >/dev/null 2>&1 &"],
      });
      assert.equal(background.exitCode, 0);
      await delay(idleTimeoutMinutes * MINUTE + 250);
      const now = Date.now();
      await reaper.tick(now);

      assert.ok(now - harness.store.get(busy.id)!.lastActivityAt > idleTimeoutMinutes * MINUTE);
      assert.equal(harness.manager.info(busy.id)?.state, "started");
      assert.equal(harness.manager.info(idle.id)?.state, "stopped");
    } finally {
      await harness.manager.delete(busy.id);
      await harness.manager.delete(idle.id);
    }
  });
});
