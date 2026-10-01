/**
 * Attested pod extensions through the whole remote runtime (fake RPC transport): renderer
 * hooks reachable through runtimeHost.extensionRunner, pod-default command ownership
 * (every slash command crosses the wire exactly once; local execution is explicit via
 * `/pod local`), cumulative event replay in order, session-replacement lifecycle
 * pairs, and the module-identity property that makes prototype patching work — the
 * extension's import of pi/pi-tui is the launcher's own copy.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { TestRpcClient } from "../support/test-rpc-client.js";
import { SEED_COMMANDS, answerPendingSeedPrompts } from "../support/seed-bridge.js";
import { createRemoteRuntime, type RemoteRuntime } from "../../src/client/runtime/remote-runtime.js";

const record: string[] = [];
(globalThis as Record<string, unknown>)["__piPodClientExtIntTest"] = record;

const EXTENSION_SOURCE = `
export default function extension(pi) {
  const record = globalThis.__piPodClientExtIntTest;
  pi.registerCommand("client-note", {
    description: "records its argument locally",
    handler: async (args) => record.push("command:" + args),
  });
  pi.registerEntryRenderer("client-entry", () => undefined);
  pi.on("session_start", (event) => record.push("session_start:" + event.reason));
  pi.on("session_shutdown", (event) => record.push("session_shutdown:" + event.reason));
  pi.on("agent_start", () => record.push("agent_start"));
  pi.on("message_start", (event) => record.push("message_start:" + event.message.role));
  pi.on("message_update", (event) => record.push("message_update:" + event.message.content.length));
  pi.on("message_end", () => record.push("message_end"));
  pi.on("agent_end", () => record.push("agent_end"));
}
`;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Answer every still-pending outbound command so no request is left holding the loop. */
const respondedIds = new Set<string>();
async function drain(channel: TestRpcClient): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await settle();
    for (const command of channel.sentJson("command") as Array<Record<string, unknown>>) {
      const id = command["id"] as string | undefined;
      const type = command["type"] as string;
      if (!id || respondedIds.has(id) || type === "prompt") continue;
      respondedIds.add(id);
      const data =
        type === "get_state"
          ? {
              model: { provider: "anthropic", id: "opus", name: "Opus" },
              thinkingLevel: "low", isStreaming: false, isCompacting: false, steeringMode: "all",
              followUpMode: "one-at-a-time", sessionId: "s1", autoCompactionEnabled: true,
              messageCount: 0, pendingMessageCount: 0,
            }
          : type === "get_messages"
            ? { messages: [] }
            : type === "get_available_models"
              ? { models: [] }
              : type === "get_commands"
                ? { commands: [...SEED_COMMANDS, { name: "pod-remote-cmd", source: "extension", sourceInfo: { path: "pod", source: "pod", scope: "user", origin: "top-level" } }] }
                : {};
      channel.injectEvent({ type: "response", command: type, id, success: true, data });
    }
    answerPendingSeedPrompts(channel, { entries: [], leafId: null });
  }
}

async function fixture(): Promise<{ channel: TestRpcClient; runtime: RemoteRuntime; session: Record<string, unknown> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-client-ext-int-"));
  const extensionPath = path.join(dir, "client-ext.js");
  fs.writeFileSync(extensionPath, EXTENSION_SOURCE);
  const rpc = new TestRpcClient();
  const channel = rpc;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-client-ext-home-"));
  const runtime = createRemoteRuntime({
    rpc,
    cwd: scratch,
    agentDir: path.join(scratch, "agent"),
    attestedExtensionPaths: [extensionPath],
    onEnding: async () => {},
  });
  const initializing = runtime.init();
  await drain(channel);
  await initializing;
  const session = (runtime.runtimeHost as Record<string, unknown>)["session"] as Record<string, unknown>;
  return { channel, runtime, session };
}

describe("attested pod extensions over the remote runtime (fake transport)", () => {
  it("loads, serves renderers, leaves commands pod-authoritative, and replays events in order", async () => {
    record.length = 0;
    const { channel, runtime, session } = await fixture();

    // session_start waits for the first UI bind, matching in-process pi (InteractiveMode
    // starts its UI before initializing extensions so handlers can use dialogs).
    assert.deepEqual(record, []);
    await (session["bindExtensions"] as (o: unknown) => Promise<void>)({
      uiContext: { notify: () => {} },
      shutdownHandler: () => {},
    });
    await settle();
    assert.deepEqual(record, ["session_start:startup"]);

    // Renderer lookup reaches the local runner through the extensionRunner surface.
    const extensionRunner = session["extensionRunner"] as {
      getEntryRenderer(t: string): unknown;
      getCommand(name: string): { name: string } | undefined;
      getRegisteredCommands(): Array<{ name: string }>;
    };
    assert.equal(typeof extensionRunner.getEntryRenderer("client-entry"), "function");
    assert.equal(extensionRunner.getEntryRenderer("nope"), undefined);

    // The command list carries /pod and the pod's commands only: the pod owns every
    // slash command by default, even when the same attested extension also registered
    // the name locally for rendering hooks. No shadowing, no duplicate execution.
    const names = extensionRunner.getRegisteredCommands().map((c) => c.name);
    assert.deepEqual(names, ["pod", "pod-remote-cmd"]);
    assert.equal(extensionRunner.getCommand("client-note"), undefined);

    // A bare slash command crosses the wire exactly once for the pod copy to run —
    // the local handler never intercepts it.
    const promptsBefore = channel.commandsOf("prompt").length;
    const localPrompt = (session["prompt"] as (text: string) => Promise<void>)("/client-note hello");
    await drain(channel);
    await localPrompt;
    assert.equal(channel.commandsOf("prompt").length, promptsBefore + 1);
    assert.ok(!record.some((entry) => entry === "command:hello"), "the local handler never ran");

    // The explicit local namespace runs the launcher-side copy exactly once with the
    // real TUI context, and the pod copy never runs.
    record.length = 0;
    const promptsBeforeLocal = channel.commandsOf("prompt").length;
    await (session["prompt"] as (text: string) => Promise<void>)("/pod local client-note hello");
    await drain(channel);
    assert.equal(channel.commandsOf("prompt").length, promptsBeforeLocal, "no wire traffic for /pod local");
    assert.ok(record.some((entry) => entry === "command:hello"), "the local handler ran once");

    // An ordinary prompt still crosses the wire untouched.
    const remotePrompt = (session["prompt"] as (text: string) => Promise<void>)("just chatting");
    await drain(channel);
    await remotePrompt;
    const wire = channel.commandsOf("prompt").at(-1) as { message: string };
    assert.equal(wire.message, "just chatting");
    await drain(channel);

    // Event replay: handlers observe the cumulative RPC event shapes, in stream order.
    record.length = 0;
    channel.injectEvent({ type: "agent_start" });
    channel.injectEvent({ type: "message_start", message: { role: "assistant", content: [] } });
    channel.injectEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
    channel.injectEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
    channel.injectEvent({ type: "agent_end", messages: [] });
    await drain(channel);
    assert.deepEqual(record, [
      "agent_start",
      "message_start:assistant",
      "message_update:1",
      "message_end",
      "agent_end",
    ]);

    // Session replacement emits a shutdown/start pair with reason "resume".
    record.length = 0;
    const replacing = runtime.refreshAfterReplacement();
    await drain(channel);
    await replacing;
    assert.deepEqual(record, ["session_shutdown:resume", "session_start:resume"]);

    // Dispose: extensions hear session_shutdown(quit) before the transport goes down.
    record.length = 0;
    const disposing = (runtime.runtimeHost as { dispose(): Promise<void> }).dispose();
    await settle();
    channel.injectControl({ event: "pi_exit", code: 0 });
    await disposing;
    await drain(channel);
    assert.deepEqual(record, ["session_shutdown:quit"]);
  });

  it("module identity: an extension's pi/pi-tui prototype patches land on the launcher's own classes", () => {
    // Run under plain node, the way the shipped launcher runs: the test runner's tsx hooks
    // transform jiti's module loads and would hand the extension a second copy of pi,
    // which is exactly the failure mode this test exists to catch in production form.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-module-identity-"));
    const extensionPath = path.join(dir, "patcher.mjs");
    fs.writeFileSync(
      extensionPath,
      [
        'import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";',
        'import { Text } from "@earendil-works/pi-tui";',
        'export default function (pi) {',
        '  ToolExecutionComponent.prototype.__piPodClientPatch = "patched";',
        '  Text.prototype.__piPodClientTuiPatch = "patched";',
        "}",
      ].join("\n"),
    );
    // The pi-tui that matters is the copy pi itself loads (npm may nest one under pi's own
    // node_modules): patches must land on the classes the launcher's InteractiveMode
    // instantiates, not on whatever copy the top-level project resolves.
    const script = [
      'import { createRequire } from "node:module";',
      'import { pathToFileURL } from "node:url";',
      'import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";',
      'const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");',
      'const piRequire = createRequire(new URL(piEntry));',
      'const tui = await import(pathToFileURL(piRequire.resolve("@earendil-works/pi-tui")).href);',
      'const loader = await import(new URL("core/extensions/loader.js", piEntry).href);',
      `const result = await loader.loadExtensions([${JSON.stringify(extensionPath)}], ${JSON.stringify(dir)});`,
      'if (result.errors.length > 0) throw new Error(JSON.stringify(result.errors));',
      'if (ToolExecutionComponent.prototype.__piPodClientPatch !== "patched") throw new Error("pi patch not visible");',
      'if (tui.Text.prototype.__piPodClientTuiPatch !== "patched") throw new Error("pi-tui patch not visible");',
      'console.log("module identity ok");',
    ].join("\n");
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."),
      encoding: "utf8",
    });
    assert.match(output, /module identity ok/);
  });
});
