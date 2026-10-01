/**
 * Shim v10 pumps the agent-event journal instead of dropping frames when the
 * channel stops draining; v11 caps journaled event size and v12 adds daemon dial-out
 * without changing this PTY path. These tests drive the generated script with a fake
 * pi and the test_set_writable seam so backpressure is deterministic.
 */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { disposeShimTree, spawnShimTree } from "./shim-process-tree.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { encodeCommandFrame, encodeControlFrame } from "../src/core/client/frames.js";
import { RemoteRpcClient, type FrameChannel } from "../src/core/client/rpc.js";
import { SHIM_VERSION, buildAgentdScript } from "../src/core/shim/agentd.js";

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

function setWritable(child: ChildProcessWithoutNullStreams, bytes: number | null): void {
  child.stdin.write(encodeControlFrame(JSON.stringify({ cmd: "test_set_writable", bytes })));
}

function sendPrompt(child: ChildProcessWithoutNullStreams): void {
  child.stdin.write(encodeCommandFrame(JSON.stringify({ type: "prompt", message: "go" })));
}

describe("vendored shim journal pump", () => {
  it("reports shim generation 12", () => {
    assert.equal(SHIM_VERSION, "13");
  });

  it("elides an oversized event into a replay gap, keeping later events in order", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-elide-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        maxEventFrameBytes: 200,
        testWritableLength: true,
        pumpIntervalMs: 20,
      }),
    );
    const big = "x".repeat(1000);
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.includes('\"type\":\"prompt\"')) continue; " +
      `    emit({type:'text_delta', n: 1, pad: ${JSON.stringify(big)}}); ` +
      "    for (let i = 2; i <= 4; i++) emit({type:'text_delta', n: i}); " +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    const seen: number[] = [];
    const gaps: Array<{ fromSeq: number; toSeq: number }> = [];
    rpc.onEvent((event) => {
      const n = (event as { n?: number }).n;
      if (typeof n === "number") seen.push(n);
    });
    rpc.onControl((control) => {
      if (control.event === "event_replay_gap") gaps.push({ fromSeq: control.fromSeq, toSeq: control.toSeq });
    });
    try {
      await rpc.waitForHello(5_000);
      setWritable(child, null); // channel always drainable: delivery is journal-driven only
      sendPrompt(child);
      assert.ok(await waitFor(() => seen.length === 3 && gaps.length >= 1), "gap and later events arrive");
      assert.deepEqual(seen, [2, 3, 4], "the oversized payload never reaches the client");
      assert.ok(
        gaps.some((g) => g.fromSeq === 1 && g.toSeq === 1),
        `expected a gap for seq 1, got ${JSON.stringify(gaps)}`,
      );
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reattach replay of an elided entry emits the gap, not the payload", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-replay-gap-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        maxEventFrameBytes: 200,
        outboxCapBytes: 80,
        outboxLowWaterBytes: 40,
        testWritableLength: true,
        pumpIntervalMs: 20,
      }),
    );
    const big = "y".repeat(1000);
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.includes('\"type\":\"prompt\"')) continue; " +
      "    emit({type:'text_delta', n: 1}); " +
      `    emit({type:'text_delta', n: 2, pad: ${JSON.stringify(big)}}); ` +
      "    emit({type:'text_delta', n: 3}); " +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    const seen: number[] = [];
    const gaps: Array<{ fromSeq: number; toSeq: number }> = [];
    let replayEnded = false;
    rpc.onEvent((event) => {
      const n = (event as { n?: number }).n;
      if (typeof n === "number") seen.push(n);
    });
    rpc.onControl((control) => {
      if (control.event === "event_replay_gap") gaps.push({ fromSeq: control.fromSeq, toSeq: control.toSeq });
      if (control.event === "event_replay_end") replayEnded = true;
    });
    try {
      await rpc.waitForHello(5_000);
      setWritable(child, 10_000); // keep the pump blocked so the journal holds all three
      sendPrompt(child);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(seen.length, 0);

      rpc.requestEventReplay(0);
      assert.ok(await waitFor(() => replayEnded && seen.length === 2), "replay delivers surviving events");
      assert.deepEqual(seen, [1, 3], "the oversized entry replays as a gap, not a payload");
      assert.ok(
        gaps.some((g) => g.fromSeq === 2 && g.toSeq === 2),
        `expected a gap for seq 2, got ${JSON.stringify(gaps)}`,
      );

      setWritable(child, null);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(seen, [1, 3], "live pump does not resend after replay");
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes an oversized RPC response through verbatim", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-big-rpc-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        maxEventFrameBytes: 200,
        testWritableLength: true,
        pumpIntervalMs: 20,
      }),
    );
    const blob = "z".repeat(5000);
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.trim()) continue; " +
      "    let msg; try { msg = JSON.parse(line); } catch { continue; } " +
      `    if (msg.type === 'get_state') emit({id: msg.id, type:'response', command:'get_state', success:true, data:{isStreaming:false, blob: ${JSON.stringify(blob)}}}); ` +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    try {
      await rpc.waitForHello(5_000);
      setWritable(child, null);
      const state = (await rpc.getState()) as { blob?: string };
      assert.equal(state.blob?.length, 5000, "responses settle pending promises and are never elided");
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("elided entries cost no journal bytes, so they neither evict nor drift the cap", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-bytes-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        // The oversized event is ~1000 chars; if it were charged to the journal this cap
        // would evict every normal event behind it.
        maxEventFrameBytes: 200,
        eventJournalMaxBytes: 600,
        outboxCapBytes: 80,
        outboxLowWaterBytes: 40,
        testWritableLength: true,
        pumpIntervalMs: 20,
      }),
    );
    const big = "w".repeat(1000);
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.includes('\"type\":\"prompt\"')) continue; " +
      `    emit({type:'text_delta', n: 0, pad: ${JSON.stringify(big)}}); ` +
      "    for (let i = 1; i <= 6; i++) emit({type:'text_delta', n: i}); " +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    const seen: number[] = [];
    let replayEnded = false;
    rpc.onEvent((event) => {
      const n = (event as { n?: number }).n;
      if (typeof n === "number") seen.push(n);
    });
    rpc.onControl((control) => {
      if (control.event === "event_replay_end") replayEnded = true;
    });
    try {
      await rpc.waitForHello(5_000);
      setWritable(child, 10_000);
      sendPrompt(child);
      await new Promise((r) => setTimeout(r, 150));
      rpc.requestEventReplay(0);
      assert.ok(await waitFor(() => replayEnded && seen.length === 6));
      assert.deepEqual(seen, [1, 2, 3, 4, 5, 6], "journal stays dense and keeps every normal event");
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("delivers backlogged events in order, exactly once, after drain", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-pump-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        outboxCapBytes: 80,
        outboxLowWaterBytes: 40,
        testWritableLength: true,
        pumpIntervalMs: 20,
      }),
    );
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "let n = 0; " +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.includes('\"type\":\"prompt\"')) continue; " +
      "    for (let i = 0; i < 8; i++) emit({type:'text_delta', n: ++n}); " +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    const seen: number[] = [];
    rpc.onEvent((event) => {
      const n = (event as { n?: number }).n;
      if (typeof n === "number") seen.push(n);
    });
    try {
      const hello = await rpc.waitForHello(5_000);
      assert.equal(hello.shimVersion, "13");
      assert.equal(hello.eventSeq, 0);

      setWritable(child, 10_000);
      child.stdin.write(encodeControlFrame(JSON.stringify({ cmd: "hello" })));
      await waitFor(() => rpc.helloInfo?.eventSeq === 0);

      // A prompt command is forwarded to fake pi, which emits 8 events while the
      // outbox is forced over cap — they stay in the journal.
      sendPrompt(child);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(seen.length, 0, "events stay journaled while the channel is over cap");

      setWritable(child, null);
      assert.ok(await waitFor(() => seen.length === 8), `expected 8 events, got ${seen.length}`);
      assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits event_replay_gap when journal eviction overtakes the send cursor", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-gap-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        outboxCapBytes: 80,
        outboxLowWaterBytes: 40,
        eventJournalMaxEvents: 3,
        testWritableLength: true,
        pumpIntervalMs: 20,
      }),
    );
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.includes('\"type\":\"prompt\"')) continue; " +
      "    for (let i = 1; i <= 6; i++) emit({type:'text_delta', n: i}); " +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    const seen: number[] = [];
    const gaps: Array<{ fromSeq: number; toSeq: number }> = [];
    rpc.onEvent((event) => {
      const n = (event as { n?: number }).n;
      if (typeof n === "number") seen.push(n);
    });
    rpc.onControl((control) => {
      if (control.event === "event_replay_gap") gaps.push({ fromSeq: control.fromSeq, toSeq: control.toSeq });
    });
    try {
      await rpc.waitForHello(5_000);
      setWritable(child, 10_000);
      sendPrompt(child);
      await new Promise((r) => setTimeout(r, 150));
      setWritable(child, null);
      assert.ok(await waitFor(() => seen.length >= 3 && gaps.length >= 1), "gap and surviving events arrive");
      assert.deepEqual(seen, [4, 5, 6]);
      const covered = new Set<number>();
      for (const gap of gaps) {
        for (let seq = gap.fromSeq; seq <= gap.toSeq; seq++) covered.add(seq);
      }
      assert.deepEqual([...covered].sort((a, b) => a - b), [1, 2, 3]);
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handshake event_replay after backlog does not double-send", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-replay-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        outboxCapBytes: 80,
        outboxLowWaterBytes: 40,
        testWritableLength: true,
        pumpIntervalMs: 20,
      }),
    );
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.includes('\"type\":\"prompt\"')) continue; " +
      "    for (let i = 1; i <= 5; i++) emit({type:'text_delta', n: i}); " +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    const seen: number[] = [];
    let replayEnded = false;
    rpc.onEvent((event) => {
      const n = (event as { n?: number }).n;
      if (typeof n === "number") seen.push(n);
    });
    rpc.onControl((control) => {
      if (control.event === "event_replay_end") replayEnded = true;
    });
    try {
      await rpc.waitForHello(5_000);
      setWritable(child, 10_000);
      sendPrompt(child);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(seen.length, 0);

      rpc.requestEventReplay(0);
      assert.ok(await waitFor(() => replayEnded && seen.length === 5), "replay delivers the journal");
      assert.deepEqual(seen, [1, 2, 3, 4, 5]);

      setWritable(child, null);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(seen, [1, 2, 3, 4, 5], "pump does not resend after replay");
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes an RPC response immediately while events are backlogged", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-rpc-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        outboxCapBytes: 80,
        outboxLowWaterBytes: 40,
        testWritableLength: true,
        pumpIntervalMs: 20,
      }),
    );
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.trim()) continue; " +
      "    let msg; try { msg = JSON.parse(line); } catch { continue; } " +
      "    if (msg.type === 'prompt') { for (let i = 1; i <= 6; i++) emit({type:'text_delta', n: i}); } " +
      "    if (msg.type === 'get_state') emit({id: msg.id, type:'response', command:'get_state', success:true, data:{isStreaming:false}}); " +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    const seen: number[] = [];
    rpc.onEvent((event) => {
      const n = (event as { n?: number }).n;
      if (typeof n === "number") seen.push(n);
    });
    try {
      await rpc.waitForHello(5_000);
      setWritable(child, 10_000);
      sendPrompt(child);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(seen.length, 0, "events are backlogged");

      const state = await rpc.getState();
      assert.equal((state as { isStreaming?: boolean }).isStreaming, false);
      assert.equal(seen.length, 0, "RPC response is not gated on the event pump");

      setWritable(child, null);
      assert.ok(await waitFor(() => seen.length === 6), "events drain after the response");
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits earlier bash updates before the bash RPC response", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-bash-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        outboxCapBytes: 80,
        outboxLowWaterBytes: 40,
        testWritableLength: true,
        pumpIntervalMs: 20,
      }),
    );
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.trim()) continue; " +
      "    let msg; try { msg = JSON.parse(line); } catch { continue; } " +
      "    if (msg.type === 'bash') { " +
      "      emit({type:'bash_execution_update', id: msg.id, delta:'one\\n'}); " +
      "      emit({type:'bash_execution_update', id: msg.id, delta:'two\\n'}); " +
      "      emit({id: msg.id, type:'response', command:'bash', success:true, data:{output:'one\\ntwo\\n', exitCode:0}}); " +
      "    } " +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    const seen: string[] = [];
    rpc.onEvent((event) => {
      const e = event as { type?: string; delta?: string };
      if (e.type === "bash_execution_update" && e.delta) seen.push(e.delta);
    });
    try {
      await rpc.waitForHello(5_000);
      setWritable(child, 10_000);
      const result = await rpc.request({ type: "bash", command: "printf", id: "bash-1" });
      assert.equal((result as { success?: boolean }).success, true);
      assert.deepEqual(seen, ["one\n", "two\n"]);
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lets an oversized rpc response ride through and names it in the shim log", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-server-shim-warn-"));
    const shimPath = path.join(tmp, "agentd.cjs");
    const logFile = path.join(tmp, "agentd.log");
    fs.writeFileSync(
      shimPath,
      buildAgentdScript({
        exitCodeFile: path.join(tmp, "exit-code"),
        responseSizeWarnBytes: 500,
        logFile,
        testWritableLength: true,
      }),
    );
    const piScript =
      'const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n"); ' +
      "process.stdin.on('data', (chunk) => { " +
      "  for (const line of chunk.toString().split('\\n')) { " +
      "    if (!line.trim()) continue; " +
      "    let msg; try { msg = JSON.parse(line); } catch { continue; } " +
      "    if (msg.type === 'get_messages') { " +
      "      emit({id: msg.id, type:'response', command:'get_messages', success:true, data:{messages:['m'.repeat(2000)]}}); " +
      "    } " +
      "  } " +
      "}); " +
      "setInterval(() => {}, 1000);";
    const child = spawnShimTree(process.execPath, [shimPath, "--", process.execPath, "-e", piScript], {
      cwd: tmp,
      env: process.env,
    });
    child.stderr.resume();
    const rpc = new RemoteRpcClient({ channel: channelFor(child) });
    try {
      await rpc.waitForHello(5_000);
      const result = await rpc.request({ type: "get_messages", id: "gm-1" });
      assert.equal((result as { success?: boolean }).success, true, "the oversized response still rides through");
      assert.ok(
        await waitFor(() => fs.existsSync(logFile) && /oversized rpc response riding through: \d+ bytes \(get_messages\)/.test(fs.readFileSync(logFile, "utf8"))),
        "shim log names the oversized response and its command",
      );
    } finally {
      await disposeShimTree(child);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
