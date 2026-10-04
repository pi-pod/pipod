/**
 * dev/fake-provider.mts — an in-memory provider + scripted pi shim for local end-to-end
 * work without a hosted sandbox account (account-mode-spec §10).
 *
 * Registered over the "sandbox" registry slot by dev/main-fake.mts, so the whole stack —
 * launch, clone step, init, gateway attach, the §6.1 WebSocket — runs for real; only the
 * sandbox is pretend. The PTY answers pi's JSONL RPC with canned data and streams a short
 * agent turn for every prompt.
 *
 * Workspace seeding is the exception that needs a real filesystem: clone/archive scripts
 * print JSON the server decodes, so pod paths map beneath a per-sandbox private temp root
 * (`/workspace` is its workspace directory) and `python3` / uploads run against it.
 * Everything else stays canned.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import {
  FrameDecoder,
  encodeControlFrame,
  encodeEventFrame,
} from "../src/core/client/frames.js";
import { SHIM_VERSION } from "../src/core/shim/agentd.js";
import {
  POD_EXTENSION_VERSION,
  SEED_BRIDGE_NOTIFICATION_PREFIX,
  SEED_CONTEXT_COMMAND,
  SEED_TREE_SUMMARY_COMMAND,
} from "../src/core/shim/pi-pod-ext.js";
import { registerProvider } from "../src/core/providers/registry.js";
import { RemoteUiFixture } from "./remote-ui-fixture.mjs";
import type {
  ExecOpts,
  ExecResult,
  ImageBuilder,
  ImageInfo,
  PtyOpenOpts,
  PtySession,
  Sandbox,
  SandboxInfo,
  SandboxProvider,
  SandboxSpec,
  SandboxState,
} from "../src/core/providers/types.js";

// Pi's builtin dark theme supplies the full required color set; the garish accent makes a
// pod-derived theme visually unmistakable in a manual session.
const FAKE_THEME_SOURCE = JSON.parse(
  fs.readFileSync(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { colors: Record<string, string>; vars?: Record<string, string> };
const FAKE_THEME_COLORS = { ...FAKE_THEME_SOURCE.colors, accent: "#ff00ff", borderAccent: "#ff00ff" };

// Report the real bundled pi version so a same-pin CLI passes readiness without a repair loop.
const FAKE_PI_VERSION = (
  JSON.parse(
    fs.readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

const INITIAL_STATE = {
  thinkingLevel: "off",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  sessionId: "fake-session",
  model: { provider: "fake", id: "fast", name: "Fake Fast" },
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

const CANNED: Record<string, unknown> = {
  get_messages: { messages: [] },
  get_entries: { entries: [], leafId: null },
  get_tree: { tree: [], leafId: null },
  get_available_models: {
    models: [
      { provider: "fake", id: "fast", name: "Fake Fast" },
      { provider: "fake", id: "careful", name: "Fake Careful", reasoning: true },
    ],
  },
  get_available_thinking_levels: { levels: ["off", "low", "high"] },
  get_commands: {
    commands: [SEED_CONTEXT_COMMAND, SEED_TREE_SUMMARY_COMMAND].map((name) => ({
      name,
      source: "extension",
      sourceInfo: { path: "internal", source: "auto", scope: "user", origin: "top-level" },
    })),
  },
  get_last_assistant_text: { text: "fake pi says hi" },
};

const UI_TITLES = {
  confirm: "Continue the manual test?",
  select: "Choose an environment",
  input: "Which branch should pi use?",
  editor: "Edit the release note",
} as const;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MODEL_SET_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.PI_POD_FAKE_MODEL_SET_DELAY_MS ?? "0", 10) || 0,
);

/** The whole-message shape RpcClientBase hands the gateway, which is what clients render. */
function assistantMessage(
  text: string,
  stopReason?: string,
  usage?: FakeReplyUsage,
): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(stopReason ? { stopReason } : {}),
    ...(usage ? { usage } : {}),
  };
}

/** One reply's usage in pi's `Usage` shape, priced like a mid-range model. */
interface FakeReplyUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

const FAKE_CONTEXT_WINDOW = 200_000;
/** Dollars per million tokens: input, output, cache read, cache write. */
const FAKE_PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } as const;

function replyFor(message: string): string {
  const echo = /reply with exactly ([^.\n]+)/i.exec(message);
  if (echo?.[1]) return echo[1].trim();
  return `fake pi received: ${message}`;
}

class FakePty implements PtySession {
  readonly id = `pty-${randomBytes(4).toString("hex")}`;
  private readonly decoder = new FrameDecoder();
  private dataCbs: Array<(data: Uint8Array) => void> = [];
  private exitCbs: Array<(code: number | null) => void> = [];
  private exited = false;
  private activeTurn: { aborted: boolean } | null = null;
  private turnTail: Promise<void> = Promise.resolve();
  private pendingUiResolve: (() => void) | null = null;
  private readonly state = {
    ...INITIAL_STATE,
    model: { ...INITIAL_STATE.model },
  };
  private readonly remoteUi = new RemoteUiFixture((event) => this.emitEvent(event));
  /** What get_session_stats reports, grown by every reply the way pi's session log grows. */
  private readonly totals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    userMessages: 0, assistantMessages: 0, toolCalls: 0, contextTokens: 0,
  };

  constructor() {
    setImmediate(() => this.emitHello());
  }

  write(data: Uint8Array): void {
    for (const frame of this.decoder.push(data)) {
      if (frame.kind === "control") {
        const msg = JSON.parse(frame.json) as { cmd?: string; knownDigest?: string };
        if (msg.cmd === "hello") this.emitHello();
        else if (msg.cmd === "shutdown") this.exitPi(0);
        else if (msg.cmd === "tui_manifest") this.emitTuiManifest(msg.knownDigest);
        continue;
      }
      if (frame.kind !== "command") continue;
      const command = JSON.parse(frame.json) as {
        type: string;
        id?: string;
        message?: string;
        provider?: string;
        modelId?: string;
        level?: string;
      };
      if (command.type === "extension_ui_response") {
        // Remote-UI surfaces own their own responses; a blocking dialog owns the rest.
        if (this.remoteUi.handleResponse(command as { id?: string; value?: unknown })) continue;
        this.pendingUiResolve?.();
        this.pendingUiResolve = null;
        continue;
      }
      if (command.type === "abort") {
        if (this.activeTurn) this.activeTurn.aborted = true;
        continue;
      }
      if (
        (command.type === "set_model" && command.provider && command.modelId)
        || (command.type === "set_thinking_level" && command.level)
      ) {
        const apply = () => {
          if (command.type === "set_model" && command.provider && command.modelId) {
            this.state.model = {
              provider: command.provider,
              id: command.modelId,
              name: command.modelId === "careful" ? "Fake Careful" : "Fake Fast",
            };
          }
          if (command.type === "set_thinking_level" && command.level) {
            this.state.thinkingLevel = command.level;
          }
          this.emitEvent({
            type: "response",
            command: command.type,
            ...(command.id !== undefined ? { id: command.id } : {}),
            success: true,
          });
        };
        if (MODEL_SET_DELAY_MS > 0) setTimeout(apply, MODEL_SET_DELAY_MS);
        else apply();
        continue;
      }
      const data = command.type === "get_state"
        ? this.state
        : command.type === "get_session_stats"
          ? this.sessionStats()
          : CANNED[command.type];
      this.emitEvent({
        type: "response",
        command: command.type,
        ...(command.id !== undefined ? { id: command.id } : {}),
        success: true,
        ...(data !== undefined ? { data } : {}),
      });
      if (command.type === "prompt") {
        if (!this.handleSeedPrompt(command.message ?? "")) {
          const message = command.message ?? "";
          this.turnTail = this.turnTail.then(() => this.runTurn(message));
        }
      }
    }
  }

  private handleSeedPrompt(message: string): boolean {
    const match = /^\/(pod:_get-(?:context|tree-summary)-v1)\s+(\S+)/.exec(message);
    if (!match) return false;
    try {
      const request = JSON.parse(Buffer.from(match[2]!, "base64url").toString("utf8")) as {
        id: string;
        op: "get-context" | "get-tree-summary";
      };
      const rootEntry = {
        id: "fake-root",
        parentId: null,
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Fake session root" },
      };
      const data = request.op === "get-context"
        ? { entries: [rootEntry], leafId: rootEntry.id, compactionCount: 0 }
        : {
            leafId: rootEntry.id,
            nodes: [{
              id: rootEntry.id,
              parentId: null,
              type: "message",
              timestamp: rootEntry.timestamp,
              preview: "Fake session root",
              role: "user",
            }],
          };
      const encoded = Buffer.from(JSON.stringify({
        v: 1,
        id: request.id,
        op: request.op,
        ok: true,
        data,
      }), "utf8").toString("base64url");
      this.emitEvent({
        type: "extension_ui_request",
        method: "notify",
        message: SEED_BRIDGE_NOTIFICATION_PREFIX + encoded,
      });
    } catch {
      return false;
    }
    return true;
  }

  /**
   * A scripted agent turn in Pi 0.84's shapes, because the events a client renders are
   * `message_start` / `message_update` / `message_end` carrying a whole assistant message —
   * not the raw wire deltas, which RpcClientBase reduces away before any client sees them.
   * Emitting the delta shape here made the fake stream render as nothing at all.
   *
   * Keywords in the prompt pick a scenario so local UI testing is deterministic:
   *   TOOL     — a tool card that runs and then succeeds
   *   HEAVY    — a reply that fills a large share of the context (usage readouts)
   *   SLOW     — a long turn, so interrupt has something to stop
   *   CONFIRM | SELECT | INPUT | EDITOR — a blocking approval of that method
   *   REMOTEUI | REMOTEUICLOSE — open or tear down the remote extension UI fixture
   */
  private async runTurn(message: string): Promise<void> {
    const turn = { aborted: false };
    this.activeTurn = turn;
    const want = (word: string) => new RegExp(`\\b${word}\\b`, "i").test(message);
    // Mirror real pi: get_state.isStreaming is true for the whole agent run, tool calls and
    // blocking dialogs included — a mid-turn attach seeds its working indicator from this.
    this.state.isStreaming = true;
    this.emitEvent({ type: "agent_start" });

    if (want("REMOTEUICLOSE")) this.remoteUi.stop();
    else if (want("REMOTEUI")) this.remoteUi.start();

    for (const method of ["confirm", "select", "input", "editor"] as const) {
      if (!want(method)) continue;
      await this.askUi(method);
      break;
    }

    this.totals.userMessages += 1;
    if (want("TOOL")) {
      this.totals.toolCalls += 1;
      const toolCallId = `call-${randomBytes(3).toString("hex")}`;
      this.emitEvent({
        type: "tool_execution_start",
        toolCallId,
        toolName: "bash",
        args: { command: "printf TOOL-CARD-OK" },
      });
      await delay(600);
      this.emitEvent({
        type: "tool_execution_end",
        toolCallId,
        toolName: "bash",
        args: { command: "printf TOOL-CARD-OK" },
        isError: false,
        result: { content: [{ type: "text", text: "TOOL-CARD-OK" }] },
      });
    }

    const reply = replyFor(message);
    this.emitEvent({ type: "message_start", message: assistantMessage("") });
    let shown = "";
    for (const chunk of reply.match(/\S+\s*/g) ?? [reply]) {
      if (turn.aborted) break;
      shown += chunk;
      this.emitEvent({ type: "message_update", message: assistantMessage(shown) });
      await delay(want("SLOW") ? 1200 : 90);
    }

    const usage = this.recordReply(message, turn.aborted ? shown : reply, want("HEAVY"));
    if (turn.aborted) {
      this.emitEvent({
        type: "message_end",
        message: assistantMessage(shown + "\n\n[interrupted]", "aborted", usage),
      });
    } else {
      this.emitEvent({ type: "message_end", message: assistantMessage(reply, undefined, usage) });
    }
    this.emitEvent({ type: "agent_end" });
    this.emitEvent({ type: "agent_settled" });
    this.state.isStreaming = false;
    if (this.activeTurn === turn) this.activeTurn = null;
  }

  /**
   * Prices one reply and adds it to the session totals. The context re-reads everything
   * said so far, so cache reads grow turn over turn; HEAVY in the prompt adds a large file's
   * worth of context, so a few of them walk the context gauge past pi's 70% and 90% marks.
   */
  private recordReply(prompt: string, reply: string, heavy: boolean): FakeReplyUsage {
    const input = 400 + prompt.length * 4 + (heavy ? 60_000 : 0);
    const output = 40 + reply.length;
    const cacheRead = this.totals.contextTokens;
    const cacheWrite = input;
    const cost = {
      input: (input * FAKE_PRICES.input) / 1e6,
      output: (output * FAKE_PRICES.output) / 1e6,
      cacheRead: (cacheRead * FAKE_PRICES.cacheRead) / 1e6,
      cacheWrite: (cacheWrite * FAKE_PRICES.cacheWrite) / 1e6,
      total: 0,
    };
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    this.totals.input += input;
    this.totals.output += output;
    this.totals.cacheRead += cacheRead;
    this.totals.cacheWrite += cacheWrite;
    this.totals.cost += cost.total;
    this.totals.assistantMessages += 1;
    this.totals.contextTokens = Math.min(FAKE_CONTEXT_WINDOW, cacheRead + input + output);
    return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost };
  }

  /** pi's get_session_stats shape over the totals above. */
  private sessionStats(): Record<string, unknown> {
    const t = this.totals;
    return {
      sessionId: this.state.sessionId,
      userMessages: t.userMessages,
      assistantMessages: t.assistantMessages,
      toolCalls: t.toolCalls,
      toolResults: t.toolCalls,
      totalMessages: t.userMessages + t.assistantMessages + t.toolCalls,
      tokens: {
        input: t.input,
        output: t.output,
        cacheRead: t.cacheRead,
        cacheWrite: t.cacheWrite,
        total: t.input + t.output + t.cacheRead + t.cacheWrite,
      },
      cost: t.cost,
      contextUsage: {
        tokens: t.contextTokens,
        contextWindow: FAKE_CONTEXT_WINDOW,
        percent: (t.contextTokens / FAKE_CONTEXT_WINDOW) * 100,
      },
    };
  }

  /** Emit a blocking extension UI request and wait for the response the app sends back. */
  private async askUi(method: "confirm" | "select" | "input" | "editor"): Promise<void> {
    const request: Record<string, unknown> = {
      type: "extension_ui_request",
      id: `fake-${method}-${randomBytes(3).toString("hex")}`,
      method,
      title: UI_TITLES[method],
    };
    if (method === "select") request["options"] = ["Staging", "Production"];
    if (method === "confirm") request["message"] = "Confirm only after reviewing the complete request.";
    if (method === "input") request["placeholder"] = "feature/manual-test";
    if (method === "editor") request["placeholder"] = "Summary for testers";
    this.emitEvent(request);
    await new Promise<void>((resolve) => {
      this.pendingUiResolve = resolve;
      setTimeout(resolve, 120_000).unref?.();
    });
  }

  resize(): void {}
  onData(cb: (data: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
  }
  async reattach(): Promise<void> {}
  close(): void {
    this.remoteUi.stop();
    this.dataCbs = [];
  }

  private emitHello(): void {
    this.emit(
      encodeControlFrame(
        JSON.stringify({
          event: "hello",
          proto: 1,
          piVersion: FAKE_PI_VERSION,
          shimVersion: process.env["FAKE_SHIM_VERSION"] || SHIM_VERSION,
          extensionVersion: POD_EXTENSION_VERSION,
          piRunning: !this.exited,
        }),
      ),
    );
  }

  /**
   * Shim v13's tui_manifest, canned: a garish theme and recognizable display settings so a
   * manual session can see pod-derived config land. Knobs:
   *   FAKE_MANIFEST=off        → never answer (client times out → unsupported path)
   *   FAKE_MANIFEST_DRIFT=1    → bootDigest ≠ digest (drift notice path)
   */
  private emitTuiManifest(knownDigest?: string): void {
    if (process.env["FAKE_MANIFEST"] === "off") return;
    const digest = "fakefakefakefake";
    if (knownDigest === digest) {
      this.emit(
        encodeControlFrame(JSON.stringify({ event: "tui_manifest", v: 1, digest, unchanged: true })),
      );
      return;
    }
    const manifest = {
      fidelity: "disk",
      bootDigest: process.env["FAKE_MANIFEST_DRIFT"] ? "driftdriftdrift1" : digest,
      launchArgv: ["pi", "--mode", "rpc"],
      uiSettings: { theme: "pod-fake", hideThinkingBlock: true, editorPaddingX: 4 },
      themes: [
        {
          name: "pod-fake",
          theme: {
            name: "pod-fake",
            ...(FAKE_THEME_SOURCE.vars ? { vars: FAKE_THEME_SOURCE.vars } : {}),
            colors: FAKE_THEME_COLORS,
          },
        },
      ],
      extensions: [{ name: "@fake/pod-extension", version: "1.2.3", origin: "npm" }],
      diagnostics: [],
    };
    this.emit(encodeControlFrame(JSON.stringify({ event: "tui_manifest", v: 1, digest, manifest })));
  }

  private exitPi(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.remoteUi.stop();
    this.emit(encodeControlFrame(JSON.stringify({ event: "pi_exit", code })));
    setImmediate(() => {
      for (const cb of this.exitCbs) cb(code);
    });
  }

  private emitEvent(event: unknown): void {
    this.emit(encodeEventFrame(JSON.stringify(event)));
  }

  private emit(frame: Uint8Array): void {
    for (const cb of this.dataCbs) cb(frame);
  }
}

class FakeWsSupervisor {
  private readonly rpc = new FakePty();
  private socket: WebSocket | null = null;
  private pending: string[] = [];
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    this.rpc.onData((data) => {
      const messages = Buffer.from(data).toString("utf8").split("\n").filter(Boolean);
      for (const message of messages) {
        // A pod whose transport has gone (idle reap, shutdown) still has a pty that can
        // emit — reading OPEN off the null socket crashed the whole dev server.
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
        else if (!this.stopped) this.pending.push(message);
      }
    });
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.socket) return;
    const socket = new WebSocket(`${this.url.replace(/\/+$/, "")}/v1/pod-transport`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    this.socket = socket;
    socket.on("open", () => {
      for (const message of this.pending.splice(0)) socket.send(message);
    });
    socket.on("message", (raw) => {
      this.rpc.write(new TextEncoder().encode(`${raw.toString()}\n`));
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.stopped) setTimeout(() => this.connect(), 250).unref?.();
    });
  }

  close(): void {
    this.stopped = true;
    this.rpc.close();
    this.socket?.close();
    this.socket = null;
  }
}

export class FakeSandbox implements Sandbox {
  state_: SandboxState = "starting";
  labels: Record<string, string>;
  readonly ptys = new Map<string, FakePty>();
  private wsSupervisor: FakeWsSupervisor | null = null;
  private readonly baseEnv: Record<string, string>;
  lastActivityAt = new Date().toISOString();
  readonly createdAt = new Date().toISOString();
  /** Private host directory that stands in for the entire sandbox filesystem. */
  readonly hostRoot: string;

  constructor(
    readonly id: string,
    spec: SandboxSpec,
  ) {
    this.labels = { ...spec.labels };
    this.baseEnv = { ...spec.env };
    this.hostRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `pi-pod-fake-${id}-`)),
    );
    fs.mkdirSync(path.join(this.hostRoot, "workspace"), { recursive: true });
    setTimeout(() => {
      if (this.state_ === "starting") this.state_ = "started";
    }, 200);
  }

  /** Maps every pod path into this sandbox's private host directory. */
  hostPath(podPath: string): string {
    const normalized = path.posix.normalize(
      podPath.startsWith("/") ? podPath : path.posix.join("/workspace", podPath),
    );
    const mapped = path.resolve(this.hostRoot, normalized.replace(/^\/+/, ""));
    if (!this.isSafeHostPath(mapped)) {
      throw new Error("fake sandbox path escapes its private root");
    }
    return mapped;
  }

  private isSafeHostPath(host: string): boolean {
    const root = fs.realpathSync(this.hostRoot);
    const resolved = path.resolve(host);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return false;

    // Check the nearest existing path with realpath so a symlink inside the
    // sandbox cannot redirect a later upload, download, mkdir, or removal out.
    let existing = resolved;
    while (true) {
      try {
        fs.lstatSync(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) return false;
        existing = parent;
      }
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(existing);
    } catch {
      return false;
    }
    return canonical === root || canonical.startsWith(`${root}${path.sep}`);
  }

  private runHost(argv: string[], opts?: ExecOpts): ExecResult {
    const mapped = argv.map((arg) => (arg.startsWith("/") ? this.hostPath(arg) : arg));
    const binary = mapped[0];
    if (!binary) return { exitCode: 1, output: "empty exec" };
    if ((binary === "rm" || binary === "mkdir") && mapped.slice(1).some((arg) => arg.startsWith("/") && !this.isSafeHostPath(arg))) {
      return { exitCode: 1, output: "refusing to mutate a path outside the fake sandbox" };
    }
    const result = spawnSync(binary, mapped.slice(1), {
      encoding: "utf8",
      cwd: this.hostRoot,
      env: { ...process.env, ...this.baseEnv, ...(opts?.env ?? {}) },
      timeout: opts?.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (output) opts?.onStdout?.(new TextEncoder().encode(output));
    const exitCode = typeof result.status === "number" ? result.status : 1;
    return { exitCode, output };
  }

  private dropHostRoot(): void {
    fs.rmSync(this.hostRoot, { recursive: true, force: true });
  }

  async state(): Promise<SandboxState> {
    return this.state_;
  }
  async waitUntilStarted(): Promise<void> {
    while (this.state_ === "starting") await new Promise((r) => setTimeout(r, 50));
    if (this.state_ !== "started") throw new Error(`sandbox is ${this.state_}`);
  }
  async start(): Promise<void> {
    this.state_ = "started";
  }
  rehydrateEnv(env: Record<string, string>): void {
    Object.assign(this.baseEnv, env);
  }
  async exec(argv: string[], opts?: ExecOpts): Promise<ExecResult> {
    const command = argv.join(" ");
    // Workspace-seed (and the files placer) need real python/mkdir/rm against the mapped tree.
    if (
      argv[0] === "python3" ||
      argv[0] === "mkdir" ||
      (argv[0] === "rm" && argv.includes("-rf"))
    ) {
      return this.runHost(argv, opts);
    }
    const line = `[fake exec] ${command.slice(0, 120)}\n`;
    opts?.onStdout?.(new TextEncoder().encode(line));
    if (argv[0] === "printenv" && argv[1] === "HOME") {
      return { exitCode: 0, output: "/root\n" };
    }
    if (command.includes("npm ls")) {
      // FAKE_NPM_LS_JSON drives the code channel's attestation in manual sessions.
      return { exitCode: 0, output: process.env["FAKE_NPM_LS_JSON"] || "{}" };
    }
    if (argv[0] === "node" && argv[1] === "-e" && command.includes("agent/sessions")) {
      return {
        exitCode: 0,
        output: JSON.stringify([{ path: "fake-session.jsonl", mtimeMs: Date.now(), size: 49 }]),
      };
    }
    if (argv[0] === "base64" && command.includes("agent/sessions/fake-session.jsonl")) {
      const session = `${JSON.stringify({ type: "session", id: "fake-session" })}\n`;
      return { exitCode: 0, output: Buffer.from(session, "utf8").toString("base64") };
    }
    if (command.includes("pi-pod-agentd.pid") && command.includes("kill -0")) {
      console.log(`[dev] fake supervisor probe ${this.id}: ${this.wsSupervisor ? "running" : "missing"}`);
      return { exitCode: this.wsSupervisor ? 0 : 1, output: "" };
    }
    if (command.includes("pi-pod-agentd.cjs") && command.includes("--daemon")) {
      console.log(`[dev] fake supervisor start ${this.id}`);
      if (!this.wsSupervisor) {
        const env = { ...this.baseEnv, ...(opts?.env ?? {}) };
        if (!env.PI_POD_SERVER_URL || !env.PI_POD_SERVER_TOKEN) {
          return { exitCode: 1, output: "missing fake pod transport env" };
        }
        this.wsSupervisor = new FakeWsSupervisor(env.PI_POD_SERVER_URL, env.PI_POD_SERVER_TOKEN);
      }
    }
    return { exitCode: 0, output: "" };
  }
  async uploadFile(destPath: string, contents: Uint8Array, mode?: number): Promise<void> {
    const host = this.hostPath(destPath);
    fs.mkdirSync(path.dirname(host), { recursive: true });
    fs.writeFileSync(host, contents, { mode: mode ?? 0o644 });
  }
  async uploadLocalFile(
    sourcePath: string,
    destPath: string,
    opts?: { mode?: number; signal?: AbortSignal },
  ): Promise<void> {
    const host = this.hostPath(destPath);
    fs.mkdirSync(path.dirname(host), { recursive: true });
    fs.copyFileSync(sourcePath, host);
    if (opts?.mode !== undefined) fs.chmodSync(host, opts.mode);
  }
  async downloadFile(sourcePath: string): Promise<Uint8Array> {
    return new Uint8Array(fs.readFileSync(this.hostPath(sourcePath)));
  }
  async openPty(_opts: PtyOpenOpts): Promise<PtySession> {
    const pty = new FakePty();
    this.ptys.set(pty.id, pty);
    return pty;
  }
  async reconnectPty(sessionId: string): Promise<PtySession | null> {
    return this.ptys.get(sessionId) ?? null;
  }
  async setLabels(labels: Record<string, string>): Promise<void> {
    this.labels = { ...this.labels, ...labels };
  }
  async refreshActivity(): Promise<void> {
    this.lastActivityAt = new Date().toISOString();
  }
  async stop(): Promise<void> {
    this.state_ = "stopped";
    this.ptys.clear();
    this.wsSupervisor?.close();
    this.wsSupervisor = null;
  }
  async applyRetention(_opts: { archiveAfterMinutes: number }): Promise<boolean> {
    return false;
  }
  async archive(): Promise<void> {
    this.state_ = "archived";
    this.ptys.clear();
    this.wsSupervisor?.close();
    this.wsSupervisor = null;
    this.dropHostRoot();
  }
  async delete(): Promise<void> {
    this.state_ = "gone";
    this.ptys.clear();
    this.wsSupervisor?.close();
    this.wsSupervisor = null;
    this.dropHostRoot();
  }
}

export function createFakeSandboxForTests(id = "fake-test"): FakeSandbox {
  return new FakeSandbox(id, {
    image: "fake",
    workdir: "/workspace",
    env: {},
    labels: {},
    archiveAfterMinutes: 60,
    idleTimeoutMinutes: 0,
    egress: { mode: "open" },
  });
}

export function registerFakeProvider(slot = "sandbox"): void {
  const sandboxes = new Map<string, FakeSandbox>();
  let counter = 0;
  const images = new Set(
    (process.env.PI_POD_FAKE_IMAGES ?? "").split(",").map((ref) => ref.trim()).filter(Boolean),
  );
  const buildDelayMs = Number.parseInt(process.env.PI_POD_FAKE_BUILD_DELAY_MS ?? "0", 10) || 0;
  let buildFailures = Number.parseInt(process.env.PI_POD_FAKE_BUILD_FAILS ?? "0", 10) || 0;
  let buildCount = 0;

  const provider: SandboxProvider & ImageBuilder = {
    name: slot,
    capabilities: {
      serverSideArchive: true,
      archiveMaxDays: null,
      archiveTransition: { kind: "same-as-stop", expiryDays: null },
      framedSessionReconnect: true,
      reportsLastActivity: true,
      ptyReattach: true,
      secretEnv: true,
      idleAutoStop: "configurable",
      resourceSizing: "per-image",
      unsupportedResourceSizing: ["diskGB"],
      egressEnforcement: "domain",
      egressAddressFamily: "ipv4",
      egressMaxEntries: null,
      environmentPersistence: "rehydrate",
      workdirSurvivesStop: true,
    },
    async checkAuth() {},
    async resolveImage(ref): Promise<ImageInfo | null> {
      return images.has(ref) ? { ref, state: "active" } : null;
    },
    async buildImage(opts: Parameters<ImageBuilder["buildImage"]>[0]): Promise<void> {
      buildCount += 1;
      console.log(`[dev] fake image build #${buildCount}: ${opts.ref}`);
      opts.onLog?.(`fake build #${buildCount} started`);
      if (buildDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, buildDelayMs));
      if (buildFailures > 0) {
        buildFailures -= 1;
        throw new Error(`scripted fake image build failure (${buildFailures} remaining)`);
      }
      images.add(opts.ref);
      opts.onLog?.(`fake build #${buildCount} published`);
    },
    async create(spec: SandboxSpec): Promise<Sandbox> {
      const sandbox = new FakeSandbox(`fake-${++counter}-${randomBytes(3).toString("hex")}`, spec);
      sandboxes.set(sandbox.id, sandbox);
      return sandbox;
    },
    async get(id: string): Promise<Sandbox | null> {
      const sandbox = sandboxes.get(id);
      return sandbox && sandbox.state_ !== "gone" ? sandbox : null;
    },
    async list(labels: Record<string, string>): Promise<SandboxInfo[]> {
      return [...sandboxes.values()]
        .filter((s) => s.state_ !== "gone")
        .filter((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v))
        .map((s) => ({
          id: s.id,
          labels: s.labels,
          state: s.state_,
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt,
        }));
    },
    async archiveById(id: string): Promise<void> {
      await sandboxes.get(id)?.archive();
    },
    async deleteById(id: string): Promise<void> {
      await sandboxes.get(id)?.delete();
    },
    credentialEnvNames: ["PI_POD_SANDBOX_TOKEN"],
  };

  registerProvider(slot, async () => () => provider);
  console.log(
    `[dev] fake provider registered on "${slot}" (images=${images.size}, buildDelayMs=${buildDelayMs}, buildFailures=${buildFailures})`,
  );
}
