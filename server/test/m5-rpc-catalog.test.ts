/**
 * M5 RPC/catalog regression: a model-less pod with a READY credential must still offer
 * a positive model catalog end to end.
 *
 * Production shape (pod p-92589141f8, server #295): the launch contract omitted the ready
 * `openrouter` credential (no pinned model, no selectable settings providers), so the pod's
 * auth.json never received it and pi answered `get_available_models` with `[]` and
 * `get_state` with an `unknown/unknown` current model. Every client — Android picker,
 * CLI probe — then had nothing to select, while the credential stayed READY server-side.
 *
 * These tests use the ACTUAL generated daemon (`buildAgentdScript`, never a transport
 * mock) with pi sides that speak the REAL pi JSONL RPC protocol, and assert POSITIVE
 * catalog answers — not handshake-only, not a faked `get_models`.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { buildAgentdScript } from "../src/core/shim/agentd.js";
import { disposeShimTree, spawnShimTree } from "./shim-process-tree.js";

async function waitFor<T>(read: () => T | undefined | false, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for daemon state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A faithful pi RPC peer: reads real pi JSONL commands from stdin and answers with the
 * real pi response envelope (`{id, type: "response", command, success, data}`), the same
 * shape pi 0.84.4 emits for `get_state`, `get_available_models`, and
 * `get_available_thinking_levels` (all synchronous snapshot reads). The payload mirrors
 * what a real pi with an `openrouter` auth entry reports: a positive catalog whose
 * current model is an openrouter model — the state the M5 pod never reached.
 */
function writeFaithfulPi(piPath: string): void {
  fs.writeFileSync(
    piPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.84.4"); process.exit(0); }
const MODELS = [
  { id: "moonshotai/kimi-k2.6", name: "MoonshotAI: Kimi K2.6", api: "openai-completions", provider: "openrouter", reasoning: true },
  { id: "anthropic/claude-3.5-sonnet", name: "OpenRouter Claude 3.5 Sonnet", api: "openai-completions", provider: "openrouter", reasoning: false },
];
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk.toString("utf8");
  for (;;) {
    const at = pending.indexOf("\\n");
    if (at < 0) break;
    const line = pending.slice(0, at); pending = pending.slice(at + 1);
    if (!line.trim()) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    const id = message.id;
    const answer = (command, data) =>
      process.stdout.write(JSON.stringify({ id, type: "response", command, success: true, data }) + "\\n");
    if (message.type === "get_state") {
      answer("get_state", { model: MODELS[0], thinkingLevel: \"medium\", isStreaming: false, sessionFile: \"/tmp/session.jsonl\", sessionId: \"s1\" });
    } else if (message.type === "get_available_models") {
      answer("get_available_models", { models: MODELS });
    } else if (message.type === "get_available_thinking_levels") {
      answer("get_available_thinking_levels", { levels: [\"off\", \"minimal\", \"low\", \"medium\", \"high\"] });
    }
  }
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
}

function fixture(tmp: string) {
  const shimPath = path.join(tmp, "agentd.cjs");
  const piPath = path.join(tmp, "faithful-pi.cjs");
  const pidFile = path.join(tmp, "agentd.pid");
  const readyFile = path.join(tmp, "agentd.ready");
  const exitCodeFile = path.join(tmp, "pi.exit");
  const logFile = path.join(tmp, "agentd.log");
  writeFaithfulPi(piPath);
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
    }),
  );
  return { shimPath, piPath, pidFile, readyFile, exitCodeFile, logFile };
}

function commandFrame(command: unknown): string {
  return `C ${Buffer.from(JSON.stringify(command), "utf8").toString("base64")}`;
}

describe("M5 catalog through the generated daemon", () => {
  it("delivers positive get_state/get_available_models/get_available_thinking_levels answers", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-m5-catalog-"));
    const files = fixture(tmp);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const frames: string[] = [];
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (data, isBinary) => {
        assert.equal(isBinary, false);
        frames.push(data.toString());
      });
    });
    const child = spawnShimTree(process.execPath, [files.shimPath, "--daemon", "--", files.piPath], {
      cwd: path.dirname(files.shimPath),
      env: {
        ...process.env,
        PI_POD_SERVER_URL: `http://127.0.0.1:${address!.port}///`,
        PI_POD_SERVER_TOKEN: "secret-token",
      },
    });
    child.stdout.resume();
    child.stderr.resume();
    try {
      // The generated daemon's own hello — transport is up, pi is spawned behind it.
      await waitFor(() => frames.find((message) => message.includes('"event":"hello"')));
      assert.ok(peer);

      // The gateway `get_models` fan-out, one leg at a time with correlated ids.
      peer!.send(commandFrame({ id: "leg-state", type: "get_state" }));
      peer!.send(commandFrame({ id: "leg-models", type: "get_available_models" }));
      peer!.send(commandFrame({ id: "leg-thinking", type: "get_available_thinking_levels" }));

      const responses = new Map<string, { command: string; success: boolean; data: unknown }>();
      await waitFor(() => {
        for (const frame of frames) {
          if (!frame.startsWith("E ")) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(Buffer.from(frame.slice(2), "base64").toString("utf8"));
          } catch {
            continue;
          }
          const msg = payload as { id?: string; type?: string };
          if (msg.type === "response" && typeof msg.id === "string") {
            responses.set(msg.id, msg as { command: string; success: boolean; data: unknown });
          }
        }
        return responses.size >= 3 ? true : false;
      });

      const state = responses.get("leg-state");
      assert.ok(state?.success, "get_state through the daemon must succeed");
      const model = (state!.data as { model?: { provider?: string; id?: string } }).model;
      assert.equal(model?.provider, "openrouter");
      assert.ok(model?.id, "current model must be a real model, never unknown");

      const catalog = responses.get("leg-models");
      assert.ok(catalog?.success, "get_available_models through the daemon must succeed");
      const models = (catalog!.data as { models?: Array<{ provider?: string; id?: string }> }).models;
      assert.ok(Array.isArray(models) && models.length > 0, "catalog must be positive, never []");
      assert.ok(
        models.every((entry) => entry.provider === "openrouter"),
        "every catalog entry carries its provider",
      );

      const thinking = responses.get("leg-thinking");
      assert.ok(thinking?.success, "get_available_thinking_levels through the daemon must succeed");
      const levels = (thinking!.data as { levels?: string[] }).levels;
      assert.ok(Array.isArray(levels) && levels.length > 1, "thinking levels must be offered");
    } finally {
      await disposeShimTree(child, { graceful: true, timeoutMs: 2000 });
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function bundledPiCli(): string | null {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const root = path.join(path.dirname(entry), "..");
  const cli = path.join(root, "dist", "cli.js");
  return fs.existsSync(cli) ? cli : null;
}

type PiRpcResponse = { success: boolean; data: unknown; command: string };

/** Silence bound: the peer must answer every commanded id within this, then it is reaped. */
const OWNED_PI_RESPONSE_TIMEOUT_MS = 90_000;
/** Bound for one owned child to die after SIGTERM before SIGKILL escalation. */
const OWNED_CHILD_KILL_TIMEOUT_MS = 5_000;
/** Bounded stderr tail kept for failure diagnostics (dummy keys only, never real secrets). */
const STDERR_TAIL_CHARS = 4_096;

/**
 * Minimal hermetic environment for a real pi peer: nothing is inherited from the host
 * process, so host provider keys, extension config, and agent-dir overrides cannot leak
 * in. HOME and PI_CODING_AGENT_DIR both point at the fixture (the latter wins inside
 * pi per getAgentDir); PI_OFFLINE=1 disables startup network operations; the spawn cwd
 * (the fixture home) keeps project-local extensions out and --no-session keeps session
 * state out. TMPDIR passes through only when the platform sets it.
 */
function isolatedPiEnv(home: string, agentDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };
  if (process.env["TMPDIR"]) env["TMPDIR"] = process.env["TMPDIR"]!;
  return env;
}

/**
 * Bounded termination of exactly the owned child — stdin-end, SIGTERM, then SIGKILL —
 * and never anything else: no process-group kill, no global pkill, only this handle.
 * Already-exited children (exitCode/signalCode set, or ESRCH on kill) return promptly.
 */
async function terminateOwnedChild(
  child: ChildProcessWithoutNullStreams,
  killTimeoutMs = OWNED_CHILD_KILL_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin.end();
  } catch {
    // Peer already gone; fall through to the exit check below.
  }
  await new Promise<void>((resolve) => {
    const timers: NodeJS.Timeout[] = [];
    const finish = (): void => {
      for (const timer of timers) clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    const timer = setTimeout(() => {
      let escalated = false;
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          escalated = true;
        }
      } catch {
        // Reaped between the check and the kill.
      }
      if (!escalated) {
        finish();
        return;
      }
      // SIGKILL is uncatchable, but still wait (bounded) for the exit event so the
      // child's signalCode/exitCode is observable instead of racing the assertion.
      const reap = setTimeout(finish, 2_000);
      reap.unref?.();
      timers.push(reap);
    }, killTimeoutMs);
    timer.unref?.();
    timers.push(timer);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}

/**
 * Drive a pi-protocol RPC child that this helper fully owns: spawn, write, collect
 * id-correlated responses, and — on success, timeout, early exit, spawn failure, or any
 * later caller assertion failure — ALWAYS reap exactly this child in `finally` before
 * resolving. Callers receive only the answers, so cleanup cannot be forgotten and no
 * timeout/reject path can leak the peer. Offline-safe: no prompt is ever sent, so pi
 * performs no model call; only local snapshot reads are exercised.
 */
async function runOwnedRealPi(
  home: string,
  commands: Array<{ id: string; type: string }>,
  opts: {
    peer?: { module: string; args: string[] } | undefined;
    timeoutMs?: number | undefined;
    killTimeoutMs?: number | undefined;
    onSpawnPid?: ((pid: number) => void) | undefined;
  } = {},
): Promise<Map<string, PiRpcResponse>> {
  const cli = bundledPiCli();
  assert.ok(cli, "bundled pi CLI must be installed");
  const agentDir = path.join(home, ".pi", "agent");
  const peer = opts.peer ?? { module: cli, args: ["--mode", "rpc", "--no-session"] };
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [peer.module, ...peer.args], {
    cwd: home,
    env: isolatedPiEnv(home, agentDir),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid !== undefined) opts.onSpawnPid?.(child.pid);
  // Drained, never ignored: an undrained stderr pipe can stall the peer once full, and
  // the bounded tail is what timeout/early-exit errors report instead of bare silence.
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });
  // EPIPE on stdin (peer exited early) surfaces via the exit path below, not as an
  // unhandled error.
  child.stdin.on("error", () => {});
  const tail = (): string => (stderrTail.trim() ? ` pi stderr tail: ${stderrTail.trim()}` : "");
  try {
    const wanted = new Set(commands.map((command) => command.id));
    const byId = new Map<string, PiRpcResponse>();
    let buffer = "";
    for (const command of commands) {
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        throw new Error(
          `real pi stdin refused ${command.type} (${error instanceof Error ? error.message : error}).${tail()}`,
        );
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? OWNED_PI_RESPONSE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        reject(new Error(`real pi catalog timed out after ${timeoutMs}ms.${tail()}`));
      }, timeoutMs);
      timer.unref?.();
      const done = (): boolean => byId.size >= wanted.size;
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const at = buffer.indexOf("\n");
          if (at < 0) break;
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as { id?: string; type?: string };
            if (msg.type === "response" && typeof msg.id === "string" && wanted.has(msg.id)) {
              byId.set(msg.id, msg as PiRpcResponse);
              if (done()) {
                clearTimeout(timer);
                resolve();
              }
            }
          } catch {
            // pi stdout noise is not a catalog answer; keep waiting.
          }
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`real pi spawn failed (${error.message}).${tail()}`));
      });
      child.once("exit", (code, signal) => {
        if (done()) return;
        clearTimeout(timer);
        reject(
          new Error(
            `real pi exited early (code ${String(code)}, signal ${String(signal)}) with ${byId.size}/${wanted.size} answers.${tail()}`,
          ),
        );
      });
    });
    return byId;
  } finally {
    await terminateOwnedChild(child, opts.killTimeoutMs);
  }
}

function assertPositiveOpenRouterCatalog(byId: Map<string, PiRpcResponse>): void {
  const state = byId.get("s1");
  assert.ok(state?.success, "real pi get_state must succeed");
  const model = (state!.data as { model?: { provider?: string; id?: string } }).model;
  assert.equal(model?.provider, "openrouter");
  assert.notEqual(model?.id, "unknown");
  const catalog = byId.get("m1");
  assert.ok(catalog?.success, "real pi get_available_models must succeed");
  const models = (catalog!.data as { models?: Array<{ provider?: string }> }).models;
  assert.ok(models && models.length > 0, "real pi catalog must be positive");
  assert.ok(models.some((entry) => entry.provider === "openrouter"));
}

describe("bundled pi catalog with an auth.json openrouter entry", () => {
  it("answers a positive openrouter catalog offline (no network, dummy key)", async () => {
    if (!bundledPiCli()) {
      console.log("skipping: bundled pi CLI not installed");
      return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-m5-pireal-"));
    try {
      const agentDir = path.join(home, ".pi", "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      // Dummy key only: proves auth.json shape resolution, never a real credential.
      fs.writeFileSync(
        path.join(agentDir, "auth.json"),
        JSON.stringify({ openrouter: { type: "api_key", key: "test-only-dummy-key" } }),
        { mode: 0o600 },
      );
      const byId = await runOwnedRealPi(home, [
        { id: "s1", type: "get_state" },
        { id: "m1", type: "get_available_models" },
      ]);
      assertPositiveOpenRouterCatalog(byId);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("chains lease -> materializer -> real pi: the written auth.json unlocks the catalog", async () => {
    if (!bundledPiCli()) {
      console.log("skipping: bundled pi CLI not installed");
      return;
    }
    const { materializeCredentialLease } = await import(
      "../src/server/model-credentials/materializer.js"
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-m5-chain-"));
    // Filesystem-backed pod: the real materializer's cat/upload/mv sequence runs
    // against real files; only the pod paths are remapped into tmp.
    const podAuthPath = path.join(tmp, "pod", ".pi", "agent", "auth.json");
    const podTmpPath = path.join(tmp, "pod", "tmp", "pi-pod-auth.json");
    const pathMap = new Map<string, string>([
      ["/root/.pi/agent/auth.json", podAuthPath],
      ["/tmp/pi-pod-auth.json", podTmpPath],
    ]);
    const local = (podPath: string): string => {
      const mapped = pathMap.get(podPath);
      assert.ok(mapped, `unexpected pod path ${podPath}`);
      return mapped;
    };
    const sandbox = {
      uploadFile: async (podPath: string, contents: Uint8Array, mode?: number) => {
        fs.mkdirSync(path.dirname(local(podPath)), { recursive: true });
        fs.writeFileSync(local(podPath), contents, { mode });
      },
      exec: async (argv: string[]) => {
        if (argv[0] === "cat" && argv[1]) {
          try {
            return { exitCode: 0, output: fs.readFileSync(local(argv[1]), "utf8") };
          } catch {
            return { exitCode: 1, output: "" };
          }
        }
        if (argv[0] === "bash" && argv[1] === "-c" && typeof argv[2] === "string") {
          const mv = /mv\s+(\S+)\s+(\S+)/.exec(argv[2]);
          assert.ok(mv, `unexpected pod script ${argv[2]}`);
          fs.mkdirSync(path.dirname(local(mv[2]!)), { recursive: true });
          fs.renameSync(local(mv[1]!), local(mv[2]!));
          return { exitCode: 0, output: "" };
        }
        throw new Error(`unexpected pod exec ${JSON.stringify(argv)}`);
      },
    };
    try {
      // Lease shaped exactly as acquireLease emits (sanitized entry + revision); the
      // DB-backed acquireLease link itself is covered by the postgres suite in CI.
      // Dummy key only — assertions below inspect key NAMES, never values.
      await materializeCredentialLease(sandbox as never, {
        revision: "rev-test",
        providers: {
          openrouter: {
            entry: { type: "api_key", key: "test-only-dummy-key" },
            providerRevision: 1,
          },
        },
      });
      const written = JSON.parse(fs.readFileSync(podAuthPath, "utf8")) as Record<string, unknown>;
      assert.deepEqual(Object.keys(written).sort(), ["openrouter"]);
      // The materializer's own output becomes a real pi HOME: no hand-written fixture.
      const home = path.join(tmp, "pihome");
      const agentDir = path.join(home, ".pi", "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.copyFileSync(podAuthPath, path.join(agentDir, "auth.json"));
      const byId = await runOwnedRealPi(home, [
        { id: "s1", type: "get_state" },
        { id: "m1", type: "get_available_models" },
      ]);
      assertPositiveOpenRouterCatalog(byId);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("owned pi peer lifetime", () => {
  /** Exact-owned-child check: no process-group or global kill is ever used in this file. */
  function assertPidDead(pid: number): void {
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "ESRCH",
    );
  }

  it("reaps a silent peer on timeout and leaves no survivor", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-m5-silent-"));
    let peerPid = -1;
    try {
      await assert.rejects(
        runOwnedRealPi(
          home,
          [{ id: "s1", type: "get_state" }],
          {
            // Black-hole peer: drains stdin, never answers. Exercises the timeout
            // path that previously had no cleanup owner.
            peer: {
              module: "-e",
              args: ["process.stdin.resume();setInterval(()=>{},1000);"],
            },
            timeoutMs: 3_000,
            killTimeoutMs: 2_000,
            onSpawnPid: (pid) => {
              peerPid = pid;
            },
          },
        ),
        /timed out after 3000ms/,
      );
      assert.ok(peerPid > 0, "expected to observe the peer pid");
      assertPidDead(peerPid);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("escalates to SIGKILL when a peer ignores SIGTERM, bounded", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);"],
      {
        env: {},
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    assert.ok(child.pid !== undefined);
    const pid = child.pid!;
    // Readiness gate: SIGTERM must land after the script installed its ignore
    // handler, never during interpreter boot (default disposition would win the race).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sleeper never became ready")), 10_000);
      timer.unref?.();
      child.stdout?.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("sleeper exited before readiness")));
    });
    const startedAt = Date.now();
    await terminateOwnedChild(child as unknown as ChildProcessWithoutNullStreams, 1_000);
    assert.ok(Date.now() - startedAt < 10_000, "escalation must stay bounded");
    assert.equal(child.signalCode, "SIGKILL");
    assertPidDead(pid);
  });

  it("returns promptly for an already-exited child", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(3);"], {
      env: {},
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const startedAt = Date.now();
    await terminateOwnedChild(child as unknown as ChildProcessWithoutNullStreams, 1_000);
    assert.ok(Date.now() - startedAt < 5_000, "already-exited kill must not wait out the bound");
    assert.equal(child.exitCode, 3);
  });
});
