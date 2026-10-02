#!/usr/bin/env node
// dev/manual-reconnect-verify.mts — manual fault-injection verification for the
// reconnect/attach supervisor-retirement bug. Self-contained: needs only this
// repo checkout (portable paths, no /tmp artifacts, no secrets, local loopback).
//
// Original failure modes (background: dev/manual-reconnect-verify-report.md):
//   1. attach while transport disconnected        -> get_state write throws
//      -> gateway retires the supervisor (kills Pi + in-flight tool).
//   2. reconnect while attach get_state in flight -> rebindChannel rejects the
//      pending request ("connection to the pi session was replaced") -> gateway
//      retires the supervisor. The transportRebinding guard in acceptPodTransport
//      covers only the synchronous rebind, not this async rejection handler.
//   3. outage > AGENTD_RECONNECT_GRACE_MS (12s) with a live supervisor
//      -> gateway replaces the supervisor even though the daemon would
//      reconnect on its own.
//   4. normal reconnect mid-tool                  -> tool + model turn survive.
//
// Two layers, one command:
//   Part 1 (logic, ~2s, no Pi): fake frame channels + the ACTUAL
//     GatewayService.attachClientToSession. Deterministic bug signature.
//   Part 2 (real Pi, ~SLEEP_SEC+60s): real Pi running `sleep <SLEEP_SEC>` via a
//     generated agentd + local WebSocket server + real WsPodChannel /
//     RemoteRpcClient, wrapped in a real GatewayService session and driven
//     through the ACTUAL attachClientToSession + production-faithful rebind.
//     endSession is a recording spy (no real kill) so the same Pi proves tool
//     survival; a retireSupervisor:true record means "this run would have
//     TERM/KILLed the supervisor process group, Pi and tool included"
//     (see stopAgentdSupervisor in src/server/pods/supervisor.ts).
//
// DB limitation (documented, not hidden): without postgres, a HEALTHY attach
// passes get_state and then fails at `database pool not initialized` in the
// durable-replay tail. That outcome is classified READY_OK_DB_TAIL and means
// "readiness passed, no kill". Only the failure modes under test need no DB:
// they die at get_state, before any query runs.
//
// Known gaps (accepted; see dev/manual-reconnect-verify-report.md):
// - Outage recovery drives recoverDisconnectedSupervisor, the helper used by
//   gateway.attach(), with a real registry wait and live daemon PID check.
//   Provider provisioning and the complete private attach() entry point are not driven.
// - Sessions here register no onLifecycleInvalidated listener (production wires
//   it in attach()); the readiness-catch bug under test is independent of it.
// - endSession is a spy: retireSupervisor:true is recorded, never executed.
//
// Usage (from server/):
//   node --import tsx dev/manual-reconnect-verify.mts            # full matrix, post-fix expectations
//   SCENARIO=logic node --import tsx dev/manual-reconnect-verify.mts
//   SCENARIO=real SLEEP_SEC=90 node --import tsx dev/manual-reconnect-verify.mts
//   EXPECT=pre node --import tsx dev/manual-reconnect-verify.mts    # original bug signature
//   SCENARIO=real,survival SLEEP_SEC=25 ...                          # comma filter; survival needs SLEEP_SEC > ~40
//
// Env: SCENARIO (all|logic|real[,scenario...]), EXPECT (post|pre, default post),
//   SLEEP_SEC (default 90), OUTAGE_MS (default 15000), KEEP_TMP=1 to keep tmpdirs,
//   PI_POD_TEST_DATABASE_URL (optional live postgres for full attach incl. hello+replay).
// No secrets: everything is local loopback; the Pi runs with --no-session.
//
// Honesty notes (do not overclaim):
// - endSession is a RECORDING SPY, never executed. A passing post-fix run proves
//   the gateway never *decides* to retire the supervisor (the spy would record
//   retireSupervisor:true); it does not demonstrate an actual TERM/KILL. The
//   survival checks (same daemon PID alive at the end, 90s tool + FINISHED-90)
//   prove nothing was destroyed as a side effect either.
// - The outage decision uses the production recovery helper, not a copy of its
//   policy. Its provider exec seam is replaced with an OS check of our own daemon;
//   a replacement callback records any forbidden kill decision.
//
// Exit 0 iff every executed check matches EXPECT. Prints a verdict table.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "../src/server/ids.js";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { GatewayService, SessionChangedDuringAttachError } from "../src/server/gateway/service.js";

// Post-fix helpers; absent on unpatched trees (EXPECT=pre then reports UNTESTED).
async function loadPostFixHelpers(): Promise<{
  classify: (args: { error: unknown; rpc: unknown; generationBefore: number | null }) => string;
  RpcTransportError: new (message: string, options?: { cause?: unknown }) => Error;
  reconnectWaitMs: number;
} | null> {
  try {
    const svc = await import("../src/server/gateway/service.js") as Record<string, any>;
    const rpc = await import("../src/core/client/rpc.js") as Record<string, any>;
    if (typeof svc.classifyAttachReadinessFailure !== "function" || typeof rpc.RpcTransportError !== "function") return null;
    return {
      classify: (args) => svc.classifyAttachReadinessFailure(args),
      RpcTransportError: rpc.RpcTransportError,
      reconnectWaitMs: typeof svc.TRANSPORT_RECONNECT_WAIT_MS === "number" ? svc.TRANSPORT_RECONNECT_WAIT_MS : -1,
    };
  } catch { return null; }
}
import { RemoteRpcClient } from "../src/core/client/rpc.js";
import { WsPodChannel, PodTransportRegistry } from "../src/server/gateway/pod-transport.js";
import { AGENTD_RECONNECT_GRACE_MS } from "../src/server/pods/supervisor.js";
import { buildAgentdScript } from "../src/core/shim/agentd.js";
import { buildPiPodExtension } from "../src/core/shim/pi-pod-ext.js";

const SCENARIO_RAW = (process.env.SCENARIO ?? "all").toLowerCase();
const EXPECT = (process.env.EXPECT ?? "post").toLowerCase() as "pre" | "post";
const SLEEP_SEC = Number(process.env.SLEEP_SEC ?? 90);
const OUTAGE_MS = Number(process.env.OUTAGE_MS ?? 15000);
const KEEP_TMP = process.env.KEEP_TMP === "1";
const POD_ID = "pod-manual-verify";
// Optional live postgres: when set, attaches run the FULL durable path (client hello
// + event replay + unanswered interactions) instead of stopping at ready-db-tail.
// Fixtures use unique uuidv7 IDs; only own rows are deleted afterwards.
const DB_URL = process.env.PI_POD_TEST_DATABASE_URL || "";

if (EXPECT !== "pre" && EXPECT !== "post") throw new Error(`EXPECT must be post|pre, got ${EXPECT}`);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_BIN = path.resolve(HERE, "../node_modules/.bin/pi");
const scenarioFilter = new Set(SCENARIO_RAW.split(",").map((s) => s.trim()).filter(Boolean));
const REAL_SUBS = new Set(["attach-healthy", "attach-disconnected", "rebind-inflight", "outage-grace", "survival"]);
const want = (name: string) => {
  if (scenarioFilter.has("all") || scenarioFilter.has(name)) return true;
  if (name === "real") return [...REAL_SUBS].some((s) => scenarioFilter.has(s));
  if (REAL_SUBS.has(name)) return scenarioFilter.has("real");
  return false;
};

type Verdict = { name: string; expected: string; actual: string; pass: boolean | null; detail?: string };
const verdicts: Verdict[] = [];
// pass=null means UNTESTED: reported, excluded from totals, never faked.
function check(name: string, expected: string, actual: string, pass: boolean | null, detail = "") {
  verdicts.push({ name, expected, actual, pass, detail });
  const tag = pass === null ? "SKIP" : pass ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}\n      expected: ${expected}\n      actual:   ${actual}${detail ? `\n      detail:   ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Shared gateway double: real GatewayService, recording endSession spy.
// ---------------------------------------------------------------------------
function makeGateway() {
  const warns: string[] = [];
  const infos: string[] = [];
  const kills: Array<{ reason: string; retireSupervisor: boolean }> = [];
  const gateway = new GatewayService({
    env: { GATEWAY_ID: "manual-verify" } as never,
    kek: {} as never,
    log: {
      info: (s: string) => { infos.push(String(s)); },
      warn: (s: string) => { warns.push(String(s)); },
      error: (s: string) => { warns.push(`ERROR: ${String(s)}`); },
    } as never,
  });
  // Recording spy: marks the session closed (faithful invalidation) but never
  // touches a real supervisor — survival observation needs Pi kept alive.
  (gateway as any).endSession = async (session: any, reason: string, options: any) => {
    kills.push({ reason, retireSupervisor: options?.retireSupervisor === true });
    session.closed = true;
  };
  return { gateway, warns, infos, kills };
}

function fakeSession(sessionId: string, rpc: RemoteRpcClient, podId = POD_ID) {
  return {
    persistQueue: Promise.resolve(),
    closed: false,
    transportRebinding: false,
    seq: 0,
    clients: new Set(),
    rpc,
    readyProbe: null,
    sessionId,
    pod: { id: podId, provider: "manual" },
    startupCrash: null,
    // Success-tail surface (only reached when get_state passes):
    remoteUiControls: new Map(),
    remoteUiSurfaces: new Map(),
    streamingUpdate: null,
    toolExecutionUpdates: new Map(),
    bashSnapshots: new Map(),
  };
}

function freshSink() {
  return { sent: [] as unknown[], send(this: { sent: unknown[] }, m: unknown) { this.sent.push(m); }, close() {} };
}

// ---- optional live-postgres fixtures (DB_URL set) ---------------------------
// Mirrors test/*-postgres.test.ts patterns: unique uuidv7 IDs, delete-only-own-rows.
type DbCtx = { orgId: string; userId: string; podUuid: string; sessionIds: string[] };
async function setupDb(): Promise<DbCtx> {
  const { initPool, query } = await import("../src/server/db/index.js");
  initPool(DB_URL);
  const ctx: DbCtx = { orgId: uuidv7(), userId: uuidv7(), podUuid: uuidv7(), sessionIds: [] };
  await query("INSERT INTO organizations (id, name) VALUES ($1, 'manual-reconnect-verify')", [ctx.orgId]);
  await query("INSERT INTO users (id, email) VALUES ($1, $2)", [ctx.userId, `${ctx.userId}@example.test`]);
  await query(
    `INSERT INTO pods (id, org_id, user_id, name, provider, state, provider_state, resolved_config,
                       lineage_root_id, lineage_depth)
     VALUES ($1, $2, $3, 'manual-reconnect-verify', 'sandbox', 'active', 'started', '{}'::jsonb, $1, 0)`,
    [ctx.podUuid, ctx.orgId, ctx.userId],
  );
  return ctx;
}
async function teardownDb(ctx: DbCtx): Promise<void> {
  const { query, closePool } = await import("../src/server/db/index.js");
  try {
    if (ctx.sessionIds.length) {
      await query("DELETE FROM session_events WHERE session_id = ANY($1)", [ctx.sessionIds]).catch(() => {});
      await query("DELETE FROM pending_interactions WHERE session_id = ANY($1)", [ctx.sessionIds]).catch(() => {});
      await query("DELETE FROM sessions WHERE id = ANY($1)", [ctx.sessionIds]).catch(() => {});
    }
    await query("DELETE FROM pods WHERE id = $1", [ctx.podUuid]).catch(() => {});
    await query("DELETE FROM users WHERE id = $1", [ctx.userId]).catch(() => {});
    await query("DELETE FROM organizations WHERE id = $1", [ctx.orgId]).catch(() => {});
  } finally {
    await closePool().catch(() => {});
  }
}
async function seedReplayEvents(sessionId: string): Promise<void> {
  const { query } = await import("../src/server/db/index.js");
  await query(
    `INSERT INTO session_events (session_id, seq, kind, payload)
     VALUES ($1, 1, 'message_end', $2), ($1, 2, 'tool_execution_start', $3)`,
    [sessionId, JSON.stringify({ text: "a prior turn" }), JSON.stringify({ tool: "bash", id: "call-1" })],
  );
  await query(
    `INSERT INTO pending_interactions (id, session_id, seq, kind, payload, resolution, delivered_at)
     VALUES ($1, $2, 1, 'confirm', $3, NULL, NULL)`,
    [uuidv7(), sessionId, JSON.stringify({ type: "extension_ui_request", id: "dlg-1", method: "confirm", title: "Proceed?" })],
  );
}

type AttachClass =
  | "killed-retire" | "killed-plain" | "ready-db-tail" | "success" | "session-changed-no-kill" | string;

async function classifyAttach(gateway: GatewayService, kills: unknown[], session: any, opts: { fromSeq?: number | null } = {}): Promise<{ cls: AttachClass; note: string; sent: unknown[] }> {
  const killsBefore = kills.length;
  const sink = freshSink();
  (gateway as any).sessions.set(session.pod.id, session);
  try {
    await (gateway as any).attachClientToSession(
      { orgId: "org-manual", podId: session.pod.id, fromSeq: opts.fromSeq ?? null, fromSessionId: null, sink },
      session,
    );
    const hello = (sink.sent as any[]).find((m) => m?.type === "hello");
    return { cls: "success", note: hello ? "client hello sent" : "returned without hello", sent: sink.sent };
  } catch (e: any) {
    const freshKills = (kills as Array<{ reason: string; retireSupervisor: boolean }>).slice(killsBefore);
    const retired = freshKills.some((k) => k.retireSupervisor);
    const killed = freshKills.length > 0;
    if (/database pool not initialized/i.test(e?.message ?? "")) {
      // get_state SUCCEEDED (it runs before any query); only the durable tail needs postgres.
      return { cls: retired || killed ? "killed-before-db-tail" : "ready-db-tail", note: `get_state ok; tail: ${e.message}`, sent: sink.sent };
    }
    if (e instanceof SessionChangedDuringAttachError || e?.name === "SessionChangedDuringAttachError") {
      if (retired) return { cls: "killed-retire", sent: sink.sent, note: `endSession retireSupervisor:true; attach threw SessionChanged (${freshKills.map((k) => k.reason).join(",")})` };
      if (killed) return { cls: "ended-without-retire", sent: sink.sent, note: `endSession WITHOUT retire (${freshKills.map((k) => k.reason).join(",")}); attach threw SessionChanged` };
      return { cls: "session-changed-no-kill", sent: sink.sent, note: `no endSession; attach threw SessionChanged (${e?.message ?? ""})` };
    }
    return { cls: `other-error:${e?.name ?? "?"}:${String(e?.message ?? e).slice(0, 120)}`, note: `kills=${JSON.stringify(freshKills)}`, sent: sink.sent };
  }
}

// ---------------------------------------------------------------------------
// Part 1: deterministic logic check, fake channels, actual attach path.
// ---------------------------------------------------------------------------
async function partLogic() {
  console.log("\n=== Part 1: gateway attach logic (fake channels, actual attachClientToSession) ===");
  for (const mode of ["disconnected", "rebind"] as const) {
    const { gateway, warns, kills } = makeGateway();
    let releaseWrite!: () => void;
    const writeSeen = new Promise<void>((r) => { releaseWrite = r; });
    const channel: any = {
      onData() {}, close() {},
      write() {
        releaseWrite();
        if (mode === "disconnected") throw new Error("pod transport is not connected");
      },
    };
    const rpc = new RemoteRpcClient({ channel });
    const session = fakeSession(`logic-${mode}`, rpc, "test-pod");
    (gateway as any).sessions.set("test-pod", session);
    const attaching = (gateway as any)
      .attachClientToSession({ sink: freshSink(), podId: "test-pod" }, session)
      .then(() => "returned", (e: Error) => e?.name ?? String(e));
    await writeSeen;
    // Mirror acceptPodTransport: the guard covers only the synchronous swap.
    if (mode === "rebind") {
      session.transportRebinding = true;
      try { rpc.rebindChannel({ onData() {}, close() {}, write() {} } as any); }
      finally { session.transportRebinding = false; }
    }
    const outcome = await attaching;
    const retired = kills.some((k) => k.retireSupervisor);
    const replacedSupervisor = warns.some((w) => w.includes("replacing its supervisor"));
    rpc.close();
    const actual = `outcome=${outcome} kills=${JSON.stringify(kills)} replacingItsSupervisorWarn=${replacedSupervisor}`;
    if (EXPECT === "pre") {
      check(`logic/attach-${mode}`, "endSession retireSupervisor:true (bug signature)", actual,
        retired && /SessionChanged/.test(outcome),
        warns.slice(-2).join(" | ").slice(0, 300));
    } else {
      check(`logic/attach-${mode}`, "no supervisor retirement; transport wait, not a kill", actual,
        !retired && /SessionChanged/.test(outcome),
        warns.slice(-2).join(" | ").slice(0, 300));
    }
  }
  // The actual extracted classifier (post-fix): structural, never string-matched.
  const helpers = await loadPostFixHelpers();
  if (!helpers) {
    check("logic/classifier-write-refused", "post-fix helper present", "UNTESTED: unpatched tree", null);
    check("logic/classifier-rebind-mid-probe", "post-fix helper present", "UNTESTED: unpatched tree", null);
    check("logic/classifier-live-transport-timeout", "post-fix helper present", "UNTESTED: unpatched tree", null);
  } else {
    if (helpers.reconnectWaitMs > 0) {
      console.log(`[harness] TRANSPORT_RECONNECT_WAIT_MS=${helpers.reconnectWaitMs}ms (actual patched constant)`);
    }
    const c1 = helpers.classify({
      error: new helpers.RpcTransportError("cannot send get_state: pod transport is not connected"),
      rpc: { transportGeneration: 3, transportUsable: false }, generationBefore: 3,
    });
    check("logic/classifier-write-refused", '"transport" (tagged RpcTransportError)', c1, c1 === "transport");
    const c2 = helpers.classify({
      error: new helpers.RpcTransportError("connection to the pi session was replaced"),
      rpc: { transportGeneration: 4, transportUsable: true }, generationBefore: 3,
    });
    check("logic/classifier-rebind-mid-probe", '"transport" (generation moved under the probe)', c2, c2 === "transport");
    const c3 = helpers.classify({
      error: new Error("Pi did not answer get_state within 90s"),
      rpc: { transportGeneration: 5, transportUsable: true }, generationBefore: 5,
    });
    // Negative control: a genuinely wedged Pi on a live transport must STILL read "pi"
    // (the retirement path is preserved for real unresponsiveness — verified live by
    // test/gateway-reconnect.test.ts "still retires when Pi fails on a live transport").
    check("logic/classifier-live-transport-timeout", '"pi" (wedged-Pi retirement preserved)', c3, c3 === "pi");
  }
}

// ---------------------------------------------------------------------------
// Part 2: real Pi + agentd + actual attach/rebind lifecycle.
// ---------------------------------------------------------------------------
async function partReal() {
  console.log(`\n=== Part 2: real Pi (sleep ${SLEEP_SEC}) + actual GatewayService attach/rebind ===`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manual-reconnect-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const shimPath = path.join(tmp, "agentd.cjs");
  const extPath = path.join(tmp, "pi-pod-ext.js");
  fs.writeFileSync(extPath, buildPiPodExtension({ mode: "rpc" }));
  const pidFile = path.join(tmp, "agentd.pid");
  fs.writeFileSync(shimPath, buildAgentdScript({
    exitCodeFile: path.join(tmp, "pi.exit"),
    logFile: path.join(tmp, "agentd.log"),
    pidFile,
    readyFile: path.join(tmp, "agentd.ready"),
    daemonReconnectInitialMs: 50, daemonReconnectMaxMs: 100,
    daemonPingIntervalMs: 500, pumpIntervalMs: 10,
  }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  const baseUrl = `ws://127.0.0.1:${port}`;
  console.log(`[harness] tmp=${tmp} gateway ws=${baseUrl}`);

  const registry = new PodTransportRegistry();
  const { gateway, warns, kills } = makeGateway();
  const db: DbCtx | null = DB_URL ? await setupDb() : null;
  console.log(`[harness] db=${db ? `postgres fixtures under pod ${db.podUuid}` : "none (readiness-only, ready-db-tail expected)"}`);
  let holding = false; // when true: refuse reconnects (transport stays down)
  let conns = 0;
  let currentSocket: WebSocket | null = null;
  let currentChannel: WsPodChannel | null = null;
  let rpc: RemoteRpcClient | null = null;
  let rebinds = 0;
  const rebindPendingSamples: number[] = []; // pendingCount sampled BEFORE each rebind
  const seen: string[] = [];
  let toolStartAt = 0, toolEndAt = 0, agentEndAt = 0;

  server.on("connection", (socket: any) => {
    conns++;
    if (holding) { try { socket.close(1012, "harness-hold"); } catch {} return; }
    const ch = new WsPodChannel(socket, POD_ID);
    registry.bind(ch);
    currentSocket = socket as WebSocket;
    currentChannel = ch;
    if (!rpc) {
      rpc = new RemoteRpcClient({ channel: ch });
      rpc.onEvent((ev: any) => {
        const t = (ev as any)?.type;
        seen.push(t);
        if (t === "tool_execution_start" && !toolStartAt) { toolStartAt = Date.now(); console.log("[rpc] tool_execution_start"); }
        else if (t === "tool_execution_end") { toolEndAt = Date.now(); console.log("[rpc] tool_execution_end"); }
        else if (t === "agent_end") { agentEndAt = Date.now(); console.log("[rpc] agent_end"); }
      });
    } else {
      // Production-faithful rebind: the transportRebinding flag covers only the
      // synchronous swap, exactly like acceptPodTransport — the async get_state
      // rejection handler in attachClientToSession is NOT covered (the bug).
      const session = (gateway as any).sessions.get(POD_ID);
      // Sample first: proves the rebind actually struck in-flight requests
      // (guards against a false pass where get_state resolved pre-rebind).
      rebindPendingSamples.push((rpc as RemoteRpcClient).pendingCount);
      if (session) {
        session.transportRebinding = true;
        try { session.channel = ch; (rpc as RemoteRpcClient).rebindChannel(ch); }
        finally { session.transportRebinding = false; }
      } else {
        (rpc as RemoteRpcClient).rebindChannel(ch);
      }
      rebinds++;
      console.log(`[gateway] hot-rebind #${rebinds} (conn #${conns})`);
      // Production-faithful catch-up (cf. finishPodTransportRebind): re-emit anything
      // journaled while detached so a tool that finished mid-outage is still observed.
      try { (rpc as RemoteRpcClient).requestEventReplay(0); } catch {}
      try { (rpc as RemoteRpcClient).requestUiReplay(0); } catch {}
      void (rpc as RemoteRpcClient).ensureHello(10_000, { discardCached: true }).catch((e) =>
        console.log(`[gateway] rebind hello failed: ${(e as Error).message}`));
    }
    socket.on("close", () => { if (currentSocket === socket) currentSocket = null; });
  });

  async function waitFor(fn: () => boolean, ms: number, label: string) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timeout waiting for ${label}; events=${seen.slice(-8).join(",")}`);
  }
  async function waitChannelDown() {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (!currentChannel?.isOpen) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("channel did not report closed after terminate");
  }

  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [shimPath, "--daemon", "--", PI_BIN, "--mode", "rpc", "--approve", "--no-session", "-e", extPath],
    { cwd: tmp, env: { ...process.env, HOME: home, PI_POD_SERVER_URL: `${baseUrl}///`, PI_POD_SERVER_TOKEN: "secret", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const piLog = path.join(tmp, "pi.log");
  child.stdout.on("data", (c) => { try { fs.appendFileSync(piLog, c); } catch {} });
  child.stderr.on("data", (c) => { try { fs.appendFileSync(piLog, c); } catch {} });

  const t0 = Date.now();
  const cleanup = async () => {
    if (db) await teardownDb(db);
    try { child.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    try { (child as any).kill("SIGKILL"); } catch {}
    for (const c of (server as any).clients) try { c.terminate(); } catch {}
    await new Promise<void>((r) => server.close(() => r()));
    registry.shutdown();
    console.log(`[harness] tmp ${KEEP_TMP ? "kept" : "removed"}: ${tmp}`);
    if (!KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    await waitFor(() => conns >= 1, 10000, "initial transport");
    await waitFor(() => ((rpc as unknown as RemoteRpcClient | null)?.helloInfo != null), 20000, "hello")
      .catch(async () => { await (rpc as unknown as RemoteRpcClient).ensureHello(15000); });
    console.log(`[harness] hello ok; sending sleep-${SLEEP_SEC} prompt`);
    const marker = `SLEEP-${SLEEP_SEC}-DONE-MARKER`;
    const pp = (rpc as unknown as RemoteRpcClient).prompt(
      `Run via your bash tool exactly: sleep ${SLEEP_SEC} && echo ${marker}. Then reply with the single word FINISHED-${SLEEP_SEC}.`);
    pp.catch(() => {});
    await pp;
    await waitFor(() => toolStartAt > 0, 60000, "tool_execution_start");
    const daemonPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(daemonPid) || daemonPid <= 0) throw new Error(`unreadable daemon pidfile: ${pidFile}`);
    console.log(`[harness] tool in flight; agentd supervisor pid=${daemonPid}; starting attach scenarios`);
    const daemonAlive = () => { try { process.kill(daemonPid, 0); return true; } catch { return false; } };

    // DB mode: every attach gets its own uuid sessions row under our pod fixture,
    // so the durable tail (replay + unanswered + truncation) runs for real.
    const newSession = async (tag: string, opts: { seq?: number } = {}) => {
      const s = fakeSession(`manual-${tag}-${Date.now()}`, rpc as unknown as RemoteRpcClient);
      (s as any).channel = currentChannel;
      if (db) {
        const sid = uuidv7();
        s.sessionId = sid;
        s.seq = opts.seq ?? 0;
        s.pod.id = db.podUuid;
        const { query } = await import("../src/server/db/index.js");
        await query("INSERT INTO sessions (id, pod_id, user_id, started_at) VALUES ($1, $2, $3, now())", [
          sid, db.podUuid, db.userId,
        ]);
        db.sessionIds.push(sid);
      }
      (gateway as any).sessions.set(s.pod.id, s);
      return s;
    };

    // A. healthy attach: readiness must pass, no kill. With DB this is a FULL
    // attach: client hello + durable replay + unanswered interaction delivery.
    // readyOk means "readiness passed without retiring" in either db mode.
    const readyOk = (cls: string) => (db ? cls === "success" : cls === "ready-db-tail" || cls === "success");
    if (want("attach-healthy")) {
      if (db) {
        const s = await newSession("healthy", { seq: 2 });
        await seedReplayEvents(s.sessionId);
        const r = await classifyAttach(gateway, kills, s, { fromSeq: 0 });
        const sent = r.sent as any[];
        const hello = sent.find((m) => m?.type === "hello");
        const eventSeqs = sent.filter((m) => m?.type === "event").map((m) => m.seq);
        const dlg = sent.find((m) => m?.type === "ephemeral" && m?.payload?.id === "dlg-1");
        const ok = r.cls === "success" && hello?.sessionId === s.sessionId
          && JSON.stringify(eventSeqs) === "[1,2]" && !!dlg;
        check("real/attach-healthy", "full success: client hello + replay [1,2] + unanswered dlg-1, no kill",
          `${r.cls} hello=${hello ? "yes" : "no"} replay=${JSON.stringify(eventSeqs)} dlg1=${dlg ? "yes" : "no"}: ${r.note}`, ok);
      } else {
        const r = await classifyAttach(gateway, kills, await newSession("healthy"));
        check("real/attach-healthy", EXPECT === "pre"
          ? "readiness OK (ready-db-tail), no kill"
          : db ? "readiness OK (full hello), no kill" : "readiness OK then full attach success, no kill",
          `${r.cls}: ${r.note}`, readyOk(r.cls));
      }
    }

    // B. attach while disconnected, then retry after the reconnect lands.
    if (want("attach-disconnected")) {
      holding = true;
      (currentSocket as any)?.terminate();
      await waitChannelDown();
      const killsBeforeB = kills.length;
      if (EXPECT === "pre") {
        const r = await classifyAttach(gateway, kills, await newSession("disconnected"));
        check("real/attach-disconnected", "killed-retire (bug: write-throw misread as Pi unresponsive)",
          `${r.cls}: ${r.note}`, r.cls === "killed-retire");
      } else {
        // Post-fix the first attach parks in waitForSessionTransport (real private
        // path) while held; releasing mid-wait lets the reconnect land, the
        // attach throws SessionChanged with NO endSession, and the retry
        // re-probes get_state healthy over the new channel.
        const first = classifyAttach(gateway, kills, await newSession("disconnected"));
        await new Promise((r2) => setTimeout(r2, 3000)); // still held: attach must be waiting, not dead
        const killedWhileHeld = kills.length - killsBeforeB;
        // Capture BEFORE releasing: the reconnect itself is the next increment.
        // (Reading it after `await first` would miss it — the transport is
        // stable then and nothing else connects.)
        const cBefore = conns;
        holding = false;
        const r1 = await first;
        await waitFor(() => conns > cBefore, 10000, "reconnect after B");
        await new Promise((r2) => setTimeout(r2, 1500)); // let hello settle
        const r2 = await classifyAttach(gateway, kills, await newSession("disconnected-retry"));
        const freshKills = kills.slice(killsBeforeB);
        const retired = freshKills.some((k) => k.retireSupervisor);
        check("real/attach-disconnected", "first=session-changed-no-kill (waited, nothing killed while held)",
          `first=${r1.cls} killedWhileHeld=${killedWhileHeld} (${r1.note})`,
          r1.cls === "session-changed-no-kill" && killedWhileHeld === 0 && !retired);
        check("real/attach-disconnected-retry", `retry after reconnect: readiness OK (${db ? "full hello" : "ready-db-tail"}), never retired`,
          `${r2.cls}: ${r2.note}`, readyOk(r2.cls) && !retired);
      }
      if (EXPECT === "pre") {
        holding = false;
        const cBefore = conns;
        await waitFor(() => conns > cBefore, 10000, "reconnect after B");
        await new Promise((r2) => setTimeout(r2, 1500)); // let hello settle
      }
      // Same supervisor process throughout: nothing was terminated as a side effect.
      check("real/attach-disconnected/supervisor-pid", `agentd supervisor pid ${daemonPid} still alive`,
        `alive=${daemonAlive()} toolEndAt=${toolEndAt}`, daemonAlive() && toolEndAt === 0);
    }

    // C. rebind while attach get_state in flight.
    if (want("rebind-inflight")) {
      const session = await newSession("inflight");
      const pendingBefore = (rpc as unknown as RemoteRpcClient).pendingCount;
      const attaching = classifyAttach(gateway, kills, session);
      // Deterministic race: wait until the attach's get_state is actually
      // pending, then drop the transport; the daemon reconnect triggers the
      // guarded rebind, which rejects the in-flight get_state with
      // "connection ... was replaced".
      const tR = Date.now();
      while ((rpc as unknown as RemoteRpcClient).pendingCount <= pendingBefore && Date.now() - tR < 10000) {
        await new Promise((r2) => setImmediate(r2));
      }
      if ((rpc as unknown as RemoteRpcClient).pendingCount <= pendingBefore) {
        throw new Error("attach get_state never went pending");
      }
      const rebindBefore = rebinds;
      const samplesBefore = rebindPendingSamples.length;
      (currentSocket as any)?.terminate();
      const tW = Date.now();
      while (rebinds <= rebindBefore && Date.now() - tW < 15000) {
        await new Promise((r2) => setTimeout(r2, 100));
      }
      const r = await attaching;
      const rebound = rebinds > rebindBefore;
      const struckPending = rebindPendingSamples.slice(samplesBefore).some((n) => n > 0);
      if (EXPECT === "pre") {
        check("real/rebind-inflight", `rebound=true struckPending=true + killed-retire (bug: replacement misread as Pi unresponsive)`,
          `rebound=${rebound} struckPending=${struckPending} ${r.cls}: ${r.note}`, rebound && struckPending && r.cls === "killed-retire");
      } else {
        check("real/rebind-inflight", `rebound=true struckPending=true + session-changed-no-kill (no endSession at all)`,
          `rebound=${rebound} struckPending=${struckPending} ${r.cls}: ${r.note}`,
          rebound && struckPending && r.cls === "session-changed-no-kill");
        const retry = await classifyAttach(gateway, kills, await newSession("inflight-retry"));
        check("real/rebind-inflight-retry", `retry after rebind: readiness OK (${db ? "full hello" : "ready-db-tail"})`,
          `${retry.cls}: ${retry.note}`, readyOk(retry.cls));
      }
      await new Promise((r2) => setTimeout(r2, 1500));
    }

    // D. Run both actual recovery decisions during a >grace outage: readiness
    // failure on an existing session, and adoption of a disconnected live daemon.
    if (want("outage-grace")) {
      holding = true;
      (currentSocket as any)?.terminate();
      await waitChannelDown();
      const gapStart = Date.now();
      let replacementCalls = 0;
      const recovery = EXPECT === "post"
        ? import("../src/server/gateway/service.js").then(({ recoverDisconnectedSupervisor }) =>
          recoverDisconnectedSupervisor({
            podId: POD_ID,
            log: { warn: (message) => console.log(`[recovery] ${message}`) },
            isRunning: async () => daemonAlive(),
            waitForReconnect: () => registry.waitFor(POD_ID, AGENTD_RECONNECT_GRACE_MS).catch(() => null),
            replace: async () => { replacementCalls++; },
          }).then(() => "unexpected-success", (error: Error) => error.message))
        : null;
      const killsBeforeD = kills.length;
      // Park an attach through the outage: post-fix it waits TRANSPORT_RECONNECT_WAIT_MS
      // in waitForSessionTransport (real private path), then ends WITHOUT retiring.
      let parkedMs = -1;
      const parked = classifyAttach(gateway, kills, await newSession("outage-parked")).then((r) => {
        parkedMs = Date.now() - gapStart;
        return r;
      });
      const elapsed = () => Date.now() - gapStart;
      if (OUTAGE_MS > elapsed()) {
        console.log(`[harness] holding outage to ${OUTAGE_MS}ms...`);
        await new Promise((r2) => setTimeout(r2, OUTAGE_MS - elapsed()));
      }
      const r = await parked;
      if (recovery) {
        const outcome = await recovery;
        check("real/outage-supervisor-recovery", "retryable live-but-disconnected; zero replacements",
          `${outcome}; replacementCalls=${replacementCalls}`,
          outcome.includes("alive but disconnected") && replacementCalls === 0 && daemonAlive());
      }
      const gap = elapsed();
      const freshKills = kills.slice(killsBeforeD);
      const retired = freshKills.some((k) => k.retireSupervisor);
      if (EXPECT === "pre") {
        check("real/outage-parked-attach", "killed-retire immediately (bug: no wait, supervisor retired)",
          `attachResolvedAt=${parkedMs}ms ${r.cls}: ${r.note}`, r.cls === "killed-retire" && parkedMs < 10_000);
      } else {
        check("real/outage-parked-attach", `ended-without-retire after ~12s wait, never retired (resolved at ${parkedMs}ms)`,
          `attachResolvedAt=${parkedMs}ms ${r.cls}: ${r.note}`,
          r.cls === "ended-without-retire" && !retired && parkedMs >= 10_000);
      }
      holding = false;
      const cBefore = conns;
      await waitFor(() => conns > cBefore, 10000, "reconnect after D");
      await new Promise((r2) => setTimeout(r2, 1500));
      const adopted = await classifyAttach(gateway, kills, await newSession("outage-adopted"));
      check("real/outage-adopted", "next attach after reconnect re-probes the live session healthy",
        `${adopted.cls}: ${adopted.note}`,
        readyOk(adopted.cls));
      // The tool rode out the entire >grace outage in the same supervisor process.
      check("real/outage-pi-alive", `tool still running after ${gap}ms outage + reconnect, supervisor pid ${daemonPid} alive`,
        `toolEndAt=${toolEndAt} alive=${daemonAlive()}`, toolEndAt === 0 && daemonAlive());
    }

    // Survival: the in-flight tool + model turn complete despite all faults.
    if (want("survival")) {
      const remaining = Math.max(30_000, (SLEEP_SEC * 1000 - (Date.now() - toolStartAt)) + 120_000);
      await waitFor(() => toolEndAt > 0, remaining, "tool_execution_end");
      console.log(`[harness] tool done after ~${Math.round((toolEndAt - toolStartAt) / 1000)}s (expect ~${SLEEP_SEC}s)`);
      await waitFor(() => agentEndAt > 0, 120000, "agent_end");
      let lastText = "";
      try { lastText = String(await ((rpc as unknown as any).getLastAssistantText?.() ?? "")).slice(0, 300); }
      catch (e) { lastText = `getLastAssistantText failed: ${(e as Error).message}`; }
      const okTool = toolEndAt - toolStartAt >= (SLEEP_SEC - 5) * 1000;
      const okModel = lastText.includes(`FINISHED-${SLEEP_SEC}`);
      check("real/survival", `tool wall ~${SLEEP_SEC}s + model continuation FINISHED-${SLEEP_SEC}`,
        `toolOk=${okTool} modelOk=${okModel} text=${JSON.stringify(lastText).slice(0, 160)}`, okTool && okModel);
      // Same supervisor process from first hello to agent_end: the spy recorded
      // every endSession decision, and the OS confirms the daemon was never
      // reaped (a retirement would have TERM/KILLed this exact PID).
      check("real/survival/supervisor-pid", `agentd supervisor pid ${daemonPid} alive from hello to agent_end`,
        `alive=${daemonAlive()}`, daemonAlive());
    }
    console.log(`[harness] total wall ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
(async () => {
  console.log(`manual-reconnect-verify: SCENARIO=${SCENARIO_RAW} EXPECT=${EXPECT} SLEEP_SEC=${SLEEP_SEC} OUTAGE_MS=${OUTAGE_MS} DB=${DB_URL ? "postgres(full hello+replay)" : "none(readiness-only)"}`);
  console.log(`grace=${AGENTD_RECONNECT_GRACE_MS}ms (src/server/pods/supervisor.ts)`);
  if (want("logic")) await partLogic();
  if (want("real")) await partReal();
  const decided = verdicts.filter((v) => v.pass !== null);
  const skipped = verdicts.filter((v) => v.pass === null);
  const failed = decided.filter((v) => !v.pass);
  console.log(`\n===== verdicts: ${decided.length - failed.length}/${decided.length} match EXPECT=${EXPECT} (${skipped.length} UNTESTED) =====`);
  for (const v of verdicts) console.log(`${v.pass === null ? "SKIP" : v.pass ? "PASS" : "FAIL"}  ${v.name}`);
  if (failed.length) {
    console.log(`\nRESULT: ${EXPECT === "pre" ? "bug signature NOT fully reproduced" : "fix NOT verified"} (${failed.length} mismatch)`);
    process.exitCode = 1;
  } else {
    console.log(`\nRESULT: ${EXPECT === "pre" ? "bug signature reproduced" : "fix verified"} across ${decided.length} checks (${skipped.length} UNTESTED)`);
  }
})();
