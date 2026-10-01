import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  buildWatcherScript,
  watcherActivitySignal,
  watcherSessionWritePath,
} from "../src/core/providers/util.js";

function script(): string {
  return buildWatcherScript({
    sandboxId: "sandbox-test",
    piCommand: "pi",
    idleTimeoutMinutes: 3,
    credentialEnvName: "TEST_PROVIDER_TOKEN",
    providerSource: "async function refresh() {}",
  });
}

describe("in-pod keepalive activity decisions", () => {
  it("does not vouch for resident idle Pi processes or unrelated ~/.pi churn", () => {
    const syntheticView = {
      processes: [
        { command: "pi", jiffyDelta: 0 },
        { command: "pi", jiffyDelta: 0 },
      ],
      changedFiles: ["hooks-debug.log", "cache/update-check.json", "models-store.json"],
      turnMarkerOpen: false,
    };

    const sessionWritePath = syntheticView.changedFiles
      .map(watcherSessionWritePath)
      .find((candidate): candidate is string => candidate !== null) ?? null;
    assert.equal(
      watcherActivitySignal({
        cpuActive: syntheticView.processes.some((process) => process.jiffyDelta > 0),
        turnMarkerOpen: syntheticView.turnMarkerOpen,
        sessionWritePath,
      }),
      null,
    );
    assert.doesNotMatch(script(), /extraPiLive|extra-pi/);
  });

  it("vouches for real work and reports the strongest deciding signal", () => {
    assert.equal(
      watcherActivitySignal({ cpuActive: true, turnMarkerOpen: true, sessionWritePath: "agent/sessions/pod/turn.jsonl" }),
      "cpu",
    );
    assert.equal(
      watcherActivitySignal({ cpuActive: false, turnMarkerOpen: true, sessionWritePath: "agent/sessions/pod/turn.jsonl" }),
      "turn-marker",
    );
    assert.equal(
      watcherActivitySignal({ cpuActive: false, turnMarkerOpen: false, sessionWritePath: "agent/sessions/pod/turn.jsonl" }),
      "session-write: agent/sessions/pod/turn.jsonl",
    );
  });

  it("counts only conversation JSONL and includes the signal in refresh diagnostics", () => {
    assert.equal(watcherSessionWritePath("agent/sessions/project/turn.jsonl"), "agent/sessions/project/turn.jsonl");
    assert.equal(watcherSessionWritePath("agent/sessions/project/turn.json"), null);
    assert.equal(watcherSessionWritePath("agent/hooks-debug.log"), null);
    assert.equal(watcherSessionWritePath("cache/session.jsonl"), null);
    assert.equal(watcherSessionWritePath("agent/sessions/project/bad\nname.jsonl"), null);

    const generated = script();
    assert.match(generated, /\.pi";\n  const root = piRoot \+ "\/agent\/sessions"/);
    assert.match(generated, /refreshed activity \(" \+ signal \+ "\)"/);
    assert.match(generated, /refresh failed \(" \+ signal \+ "\):/);
  });

  it("vouches for a co-located pod's marker only while its agentd pid is alive", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-glob-"));
    const agentdBase = path.join(dir, "pi-pod-agentd.cjs");
    const childShim = path.join(dir, "pi-pod-agentd.child-1.cjs");
    const markerBase = path.join(dir, "pi-pod-turn-active");
    fs.writeFileSync(childShim, "setInterval(() => {}, 1000);");
    const childAgentd = spawn(process.execPath, [childShim], { stdio: "ignore" });
    try {
      const run = async (): Promise<string> => {
        const watcher = path.join(dir, "watcher.cjs");
        fs.writeFileSync(
          watcher,
          buildWatcherScript({
            sandboxId: "sandbox-glob-test",
            piCommand: "definitely-not-running-here",
            idleTimeoutMinutes: 3,
            credentialEnvName: "TEST_PROVIDER_TOKEN",
            providerSource: "async function refresh() {}",
            tickMs: 120,
            pidFile: path.join(dir, "keepalive.pid"),
            readyFile: path.join(dir, "keepalive.ready"),
            turnMarkerPath: markerBase,
            agentdPath: agentdBase,
          }),
        );
        const proc = spawn(process.execPath, [watcher], {
          env: { ...process.env, TEST_PROVIDER_TOKEN: "x" },
        });
        let out = "";
        proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        proc.stderr.on("data", (chunk: Buffer) => { out += chunk.toString(); });
        await new Promise((resolve) => setTimeout(resolve, 800));
        proc.kill("SIGTERM");
        await new Promise((resolve) => proc.on("exit", resolve));
        return out;
      };

      // A per-child marker naming a live prefix-named agentd vouches…
      fs.writeFileSync(`${markerBase}.child-1`, String(childAgentd.pid));
      assert.match(await run(), /refreshed activity \(turn-marker\)/);

      // …and the same marker with its process dead never does (a crashed child cannot pin the host).
      childAgentd.kill("SIGKILL");
      await new Promise((resolve) => childAgentd.on("exit", resolve));
      assert.doesNotMatch(await run(), /refreshed activity \(turn-marker\)/);
    } finally {
      if (childAgentd.exitCode === null) childAgentd.kill("SIGKILL");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
