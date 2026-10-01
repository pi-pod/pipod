/**
 * The vendored shim (src/core/shim, uploaded by this server for gateway-held sessions) must
 * keep the pending-dialog contract: a blocking dialog pi is parked inside replays on every
 * ui_replay until its exact extension_ui_response consumes it. Guards the vendored copy
 * against a partial `sync-core.sh` — version skew is caught at hello, same-version drift
 * of this behavior is not, and a shim that stops replaying dialogs re-wedges reconnects.
 */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { disposeShimTree, spawnShimTree } from "./shim-process-tree.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { RemoteRpcClient, type FrameChannel } from "../src/core/client/rpc.js";
import { buildAgentdScript } from "../src/core/shim/agentd.js";

function channelFor(child: ChildProcessWithoutNullStreams): FrameChannel {
  return {
    write: (data) => child.stdin.write(data),
    onData: (cb) => child.stdout.on("data", cb),
    close: () => child.stdin.end(),
  };
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !predicate()) await new Promise((r) => setTimeout(r, 10));
  return predicate();
}

describe("vendored shim pending-dialog journal", () => {
  it("replays an unanswered dialog past `since` and stops once it is answered", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(shimPath, buildAgentdScript({ exitCodeFile: path.join(tmp, "exit-code") }));
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      'emit({type:"extension_ui_request", id:"approval", method:"confirm", title:"Run?", message:"ok?"}); ' +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    const seen: Array<{ id?: string }> = [];
    rpc.onEvent((event) => {
      if ((event as { type?: string }).type === "extension_ui_request") seen.push(event as { id?: string });
    });
    try {
      await rpc.waitForHello(5_000);
      assert.ok(await waitFor(() => seen.length === 1), "the dialog arrives live");
      seen.length = 0;

      rpc.requestUiReplay(99);
      assert.ok(await waitFor(() => seen.length === 1), "an unanswered dialog replays past `since`");
      assert.equal(seen[0]!.id, "approval");

      rpc.respondExtensionUi({ type: "extension_ui_response", id: "approval", confirmed: true });
      seen.length = 0;
      rpc.requestUiReplay(0);
      assert.equal(await waitFor(() => seen.length > 0, 300), false, "an answered dialog is gone");
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
