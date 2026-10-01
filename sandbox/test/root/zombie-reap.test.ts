import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { RootHarness, rootTestSkipReason } from "./harness.js";

/**
 * Zombie-reap regression (plan §5.2.2).
 *
 * The service container accumulates two zombies (`crun`, `.pps-init`) per sandbox
 * lifecycle because its PID 1 (Node) never reaps reparented children; the fix is
 * `init: true` on the service (docker-init/tini becomes PID 1). A Node subreaper via
 * `prctl(PR_SET_CHILD_SUBREAPER)` was considered and rejected (not exposed to Node).
 *
 * Gate: when ZOMBIE_REAP_EXPECT_FIXED is unset, the test records the zombie count
 * and passes with a warning (expected to observe the leak on the current image).
 * When ZOMBIE_REAP_EXPECT_FIXED=1, it asserts the delta is 0 (run after `init: true`
 * lands, on a disposable privileged worker via `npm run test:root`).
 */

/** Count processes in state Z in THIS PID namespace (the service's, under test:root). */
function countZombies(): number {
  let zombies = 0;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // exited between readdir and read
    }
    // comm may contain spaces/parens; state is the field after the last ')'.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trimStart();
    if (afterComm[0] === "Z") zombies++;
  }
  return zombies;
}

test("zombie reap: 100 create/stop/delete cycles leave no new zombies", async (t) => {
  const skip = await rootTestSkipReason();
  if (skip) {
    t.skip(`zombie-reap requires a privileged root worker: ${skip}`);
    return;
  }

  const harness = await RootHarness.create({ server: false });
  t.after(async () => harness.cleanup());
  await harness.pullBusybox();

  const CYCLES = 100;
  const before = countZombies();
  for (let i = 0; i < CYCLES; i++) {
    // Drive the manager directly: create → stop → delete exercises the full
    // runtime lifecycle (crun run -d, stop, destroy) whose reparented children
    // PID 1 must reap. No HTTP layer is involved, so this file stays free of
    // the repo-wide Response lib-typing noise.
    const sandbox = await harness.manager.create({ image: "busybox:latest", workdir: "/workspace" });
    assert.equal(sandbox.state, "started");
    await harness.manager.stop(sandbox.id);
    await harness.manager.delete(sandbox.id);
  }
  const after = countZombies();
  const delta = after - before;
  console.log(JSON.stringify({ zombieReap: { cycles: CYCLES, before, after, delta } }));

  if (process.env.ZOMBIE_REAP_EXPECT_FIXED !== "1") {
    t.diagnostic(
      `ZOMBIE_REAP_EXPECT_FIXED is unset: recording zombie delta=${delta} (leak present until infra sets init: true); not asserting.`,
    );
    return;
  }
  assert.equal(delta, 0, `expected no new zombies after ${CYCLES} cycles (before=${before}, after=${after})`);
});
