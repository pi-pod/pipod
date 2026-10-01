import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { disposeShimTree, spawnShimTree } from "./shim-process-tree.js";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { buildAgentdScript } from "../src/core/shim/agentd.js";

async function waitFor<T>(read: () => T | undefined | false, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for daemon state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixture(tmp: string, overrides: Partial<Parameters<typeof buildAgentdScript>[0]> = {}) {
  const shimPath = path.join(tmp, "agentd.cjs");
  const piPath = path.join(tmp, "fake-pi.cjs");
  const pidFile = path.join(tmp, "agentd.pid");
  const readyFile = path.join(tmp, "agentd.ready");
  const exitCodeFile = path.join(tmp, "pi.exit");
  const logFile = path.join(tmp, "agentd.log");
  fs.writeFileSync(
    piPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.84.0"); process.exit(0); }
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  for (;;) {
    const at = pending.indexOf("\\n");
    if (at < 0) break;
    const line = pending.slice(0, at); pending = pending.slice(at + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    if (message.type === "prompt") process.stdout.write(JSON.stringify({ type: "daemon_event", text: message.message }) + "\\n");
    if (message.type === "exit_test") process.exit(7);
  }
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    shimPath,
    buildAgentdScript({
      exitCodeFile,
      logFile,
      pidFile,
      readyFile,
      daemonReconnectInitialMs: 20,
      daemonReconnectMaxMs: 40,
      daemonPingIntervalMs: 30,
      pumpIntervalMs: 10,
      ...overrides,
    }),
  );
  return { shimPath, piPath, pidFile, readyFile, exitCodeFile, logFile };
}

function startDaemon(
  files: ReturnType<typeof fixture>,
  url: string,
  token = "secret-token",
): ChildProcessWithoutNullStreams {
  return spawnShimTree(process.execPath, [files.shimPath, "--daemon", "--", files.piPath], {
    cwd: path.dirname(files.shimPath),
    env: { ...process.env, PI_POD_SERVER_URL: `${url}///`, PI_POD_SERVER_TOKEN: token },
  });
}

function commandFrame(command: unknown): string {
  return `C ${Buffer.from(JSON.stringify(command), "utf8").toString("base64")}`;
}

function controlFrame(command: unknown): string {
  return `S ${JSON.stringify(command)}`;
}

function eventFromFrame(frame: string): unknown {
  assert.ok(frame.startsWith("E "));
  return JSON.parse(Buffer.from(frame.slice(2), "base64").toString("utf8"));
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  // Graceful first so the daemon unlinks its pid/ready files and SIGTERMs its
  // supervised pi; dispose escalates to SIGKILL and throws on survivors.
  await disposeShimTree(child, { graceful: true, timeoutMs: 2000 });
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("agentd daemon dial-out transport", () => {
  it("authenticates in headers, preserves one-message framing, pings, and stays observable after pi exits", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-agentd-daemon-"));
    const files = fixture(tmp);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const messages: string[] = [];
    let request: http.IncomingMessage | undefined;
    let peer: WebSocket | undefined;
    server.on("connection", (socket, req) => {
      request = req;
      peer = socket;
      socket.on("message", (data, isBinary) => {
        assert.equal(isBinary, false);
        messages.push(data.toString());
      });
    });
    const child = startDaemon(files, `http://127.0.0.1:${address!.port}`);
    let daemonStdout = "";
    child.stdout.on("data", (chunk) => (daemonStdout += chunk.toString()));
    child.stderr.resume();
    try {
      await waitFor(() => messages.find((message) => message.includes('"event":"hello"')));
      assert.equal(request?.url, "/v1/pod-transport");
      assert.equal(request?.headers.authorization, "Bearer secret-token");
      assert.ok(!request?.url?.includes("secret-token"));
      assert.equal(fs.readFileSync(files.pidFile, "utf8"), String(child.pid));
      assert.equal(fs.readFileSync(files.readyFile, "utf8"), String(child.pid));

      peer!.send(commandFrame({ type: "prompt", message: "hello" }));
      const eventFrame = await waitFor(() => messages.find((message) => message.startsWith("E ")));
      assert.deepEqual(eventFromFrame(eventFrame), { type: "daemon_event", text: "hello" });
      await waitFor(() => messages.find((message) => message === 'S {"event":"ping"}'));
      assert.ok(messages.every((message) => !message.endsWith("\n")), "WebSocket frames omit PTY delimiters");
      assert.equal(daemonStdout, "", "daemon mode never uses PTY stdout");

      peer!.send(commandFrame({ type: "exit_test" }));
      await waitFor(() => messages.find((message) => message.includes('"event":"pi_exit"')));
      assert.equal(await waitFor(() => (fs.existsSync(files.exitCodeFile) ? fs.readFileSync(files.exitCodeFile, "utf8") : false)), "7");
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(child.exitCode, null, "supervisor outlives pi");
      assert.ok(fs.existsSync(files.pidFile));
      assert.ok(fs.existsSync(files.readyFile));
    } finally {
      await stop(child);
      await closeServer(server);
      assert.equal(fs.existsSync(files.pidFile), false);
      assert.equal(fs.existsSync(files.readyFile), false);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reconnects with bounded exponential backoff and resets after open", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-agentd-backoff-"));
    const files = fixture(tmp);
    const server = http.createServer();
    const upgraded = new WebSocketServer({ noServer: true });
    const attempts: number[] = [];
    let failures = 0;
    server.on("upgrade", (request, socket, head) => {
      attempts.push(Date.now());
      if (failures++ < 3) socket.destroy();
      else upgraded.handleUpgrade(request, socket, head, (ws) => upgraded.emit("connection", ws, request));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const child = startDaemon(files, `http://127.0.0.1:${address.port}`);
    child.stdout.resume();
    child.stderr.resume();
    try {
      await new Promise<void>((resolve) => upgraded.once("connection", () => resolve()));
      assert.ok(attempts.length >= 4);
      const gaps = attempts.slice(1, 4).map((time, index) => time - attempts[index]!);
      assert.ok(gaps.every((gap) => gap >= 10), `a retry was not delayed: ${gaps}`);
      // Attempt-to-attempt gaps include the platform WebSocket's own failure latency.
      // Once the configured 40ms cap is reached that latency can make an earlier total
      // slightly larger than a later one, so assert the delay range rather than ordering.
      assert.ok(gaps.some((gap) => gap >= 30), `retry never reached the backoff range: ${gaps}`);
      assert.ok(gaps.every((gap) => gap <= 100), `retry exceeded bounded maximum: ${gaps}`);
      const log = fs.readFileSync(files.logFile, "utf8");
      assert.doesNotMatch(log, /Connection was closed before it was established/);

      const firstOpen = attempts.at(-1)!;
      upgraded.clients.values().next().value!.close();
      await waitFor(() => attempts.length >= 5);
      const resetGap = attempts[4]! - firstOpen;
      assert.ok(resetGap < gaps[1]! + 30, `successful open did not reset backoff: ${resetGap} vs ${gaps}`);
    } finally {
      await stop(child);
      for (const socket of upgraded.clients) socket.terminate();
      upgraded.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("re-dials a silent transport once the gateway has answered pings, and never before", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-agentd-silent-"));
    const files = fixture(tmp, { daemonPingIntervalMs: 30, daemonReadDeadlineMs: 120 });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const connections: WebSocket[] = [];
    let answerPings = false;
    let pongsSent = 0;
    server.on("connection", (socket) => {
      connections.push(socket);
      socket.on("message", (data) => {
        if (answerPings && data.toString() === 'S {"event":"ping"}') {
          pongsSent += 1;
          socket.send(controlFrame({ cmd: "pong" }));
        }
      });
    });
    const child = startDaemon(files, `http://127.0.0.1:${address.port}`);
    child.stdout.resume();
    child.stderr.resume();
    try {
      await waitFor(() => connections.length >= 1);
      // An old gateway never answers pings; silence must not trip the read deadline then.
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(connections.length, 1, "daemon re-dialed a gateway that never pongs");

      answerPings = true;
      await waitFor(() => pongsSent >= 2);
      answerPings = false; // The socket stays open but nothing answers: a half-open link.
      await waitFor(() => connections.length >= 2);
      const log = fs.readFileSync(files.logFile, "utf8");
      assert.match(log, /transport silent/);
    } finally {
      await stop(child);
      await closeServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exits instead of reconnecting when the transport is permanently rejected", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-agentd-permanent-"));
    const files = fixture(tmp);
    const server = http.createServer();
    const upgraded = new WebSocketServer({ noServer: true });
    const attempts: number[] = [];
    server.on("upgrade", (request, socket, head) => {
      attempts.push(Date.now());
      upgraded.handleUpgrade(request, socket, head, (ws) => {
        ws.close(4410, "pod_archived");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const child = startDaemon(files, `http://127.0.0.1:${address.port}`);
    child.stdout.resume();
    child.stderr.resume();
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })));
      assert.equal(exit.code, 0);
      assert.equal(attempts.length, 1, `daemon retried a permanent rejection: ${attempts.length}`);
      const log = fs.readFileSync(files.logFile, "utf8");
      assert.match(log, /permanently rejected/);
      assert.equal(fs.existsSync(files.pidFile), false);
      assert.equal(fs.existsSync(files.readyFile), false);
    } finally {
      await stop(child);
      for (const socket of upgraded.clients) socket.terminate();
      upgraded.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("replays the authoritative event journal when the server requests it after reconnect", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-agentd-replay-"));
    const files = fixture(tmp);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const connections: Array<{ socket: WebSocket; messages: string[] }> = [];
    server.on("connection", (socket) => {
      const connection = { socket, messages: [] as string[] };
      connections.push(connection);
      socket.on("message", (data) => connection.messages.push(data.toString()));
    });
    const child = startDaemon(files, `http://127.0.0.1:${address!.port}`);
    child.stdout.resume();
    child.stderr.resume();
    try {
      const first = await waitFor(() => connections[0]);
      await waitFor(() => first.messages.find((message) => message.includes('"event":"hello"')));
      first.socket.send(commandFrame({ type: "prompt", message: "journalled" }));
      const original = await waitFor(() => first.messages.find((message) => message.startsWith("E ")));
      first.socket.close();

      const second = await waitFor(() => connections[1]);
      await waitFor(() => second.messages.find((message) => message.includes('"event":"hello"')));
      second.socket.send(controlFrame({ cmd: "event_replay", since: 0 }));
      const replay = await waitFor(() => second.messages.find((message) => message.startsWith("E ")));
      assert.equal(replay, original, "base64 event framing survives replay");
      await waitFor(() => second.messages.find((message) => message.includes('"event":"event_replay_end"')));
    } finally {
      await stop(child);
      await closeServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("clears transport readiness while a live daemon is disconnected", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-agentd-readiness-"));
    const files = fixture(tmp, { daemonReconnectInitialMs: 500, daemonReconnectMaxMs: 500 });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => { peer = socket; });
    const child = startDaemon(files, `http://127.0.0.1:${address!.port}`);
    child.stdout.resume();
    child.stderr.resume();
    try {
      await waitFor(() => fs.existsSync(files.readyFile));
      peer!.terminate();
      await waitFor(() => (fs.existsSync(files.readyFile) ? false : true));
      assert.equal(fs.existsSync(files.pidFile), true, "the supervisor remains alive for reconnect");
    } finally {
      await stop(child);
      await closeServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("releases its markers when a redundant SIGTERM lands mid-shutdown", async () => {
    // Teardown signals the process group and the direct child, so under scheduling
    // delay the redundant SIGTERM can land after the first was consumed. The daemon
    // must stay alive through the redundant delivery and still exit via its handler
    // with its pid/ready markers released — never die by SIGTERM with markers leaked.
    // Each attempt replays the twin kill with a different microsecond gap to cover the
    // handler window across machines; the whole generated daemon runs every attempt.
    const gapsUs = [25, 50, 100, 200, 400, 800];
    for (let attempt = 0; attempt < gapsUs.length * 4; attempt++) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-agentd-redundant-"));
      const files = fixture(tmp);
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const child = startDaemon(files, `http://127.0.0.1:${address!.port}`);
      child.stdout.resume();
      child.stderr.resume();
      try {
        await waitFor(() => fs.existsSync(files.readyFile));
        try { process.kill(-child.pid!, "SIGTERM"); } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
        }
        const spinUntil = process.hrtime.bigint() + BigInt(gapsUs[attempt % gapsUs.length]! * 1000);
        while (process.hrtime.bigint() < spinUntil) { /* hold the gap open mid-handler */ }
        try { child.kill("SIGTERM"); } catch { /* already exited; asserts below decide */ }
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, 10_000);
        assert.equal(child.signalCode, null, `attempt ${attempt}: daemon died by ${child.signalCode}`);
        assert.equal(child.exitCode, 143, `attempt ${attempt}: handler did not run to exit`);
        assert.equal(fs.existsSync(files.pidFile), false, `attempt ${attempt}: pid marker leaked`);
        assert.equal(fs.existsSync(files.readyFile), false, `attempt ${attempt}: ready marker leaked`);
      } finally {
        await disposeShimTree(child, { graceful: true, timeoutMs: 2000 });
        await closeServer(server);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("refuses a duplicate live supervisor and supersedes stale marker files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-agentd-owner-"));
    const files = fixture(tmp);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let connections = 0;
    server.on("connection", () => connections++);
    const first = startDaemon(files, `http://127.0.0.1:${address!.port}`);
    first.stdout.resume();
    first.stderr.resume();
    let replacement: ChildProcessWithoutNullStreams | undefined;
    try {
      await waitFor(() => fs.existsSync(files.readyFile));
      const duplicate = startDaemon(files, `http://127.0.0.1:${address!.port}`);
      duplicate.stdout.resume();
      duplicate.stderr.resume();
      const duplicateCode = await new Promise<number | null>((resolve) => duplicate.once("exit", resolve));
      assert.equal(duplicateCode, 73);
      assert.equal(fs.readFileSync(files.pidFile, "utf8"), String(first.pid));
      assert.equal(connections, 1);

      await stop(first);
      assert.equal(fs.existsSync(files.pidFile), false);
      assert.equal(fs.existsSync(files.readyFile), false);
      fs.writeFileSync(files.pidFile, "99999999");
      fs.writeFileSync(files.readyFile, "99999999");
      replacement = startDaemon(files, `http://127.0.0.1:${address!.port}`);
      replacement.stdout.resume();
      replacement.stderr.resume();
      await waitFor(() => {
        // The replacement unlinks the stale ready marker between these two reads;
        // a lost race must retry, not fail the wait.
        try {
          return fs.existsSync(files.readyFile) && fs.readFileSync(files.readyFile, "utf8") === String(replacement!.pid);
        } catch {
          return false;
        }
      });
      assert.equal(fs.readFileSync(files.pidFile, "utf8"), String(replacement.pid));
    } finally {
      await stop(first);
      if (replacement) await stop(replacement);
      await closeServer(server);
      assert.equal(fs.existsSync(files.pidFile), false);
      assert.equal(fs.existsSync(files.readyFile), false);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
