/**
 * src/providers/util.ts — helpers shared by adapters, and nothing else.
 *
 * Core code must not import this file (D4): everything here exists so that two adapters do
 * not each carry a private copy of logic whose drift would be invisible — shell quoting that
 * has to survive hostile arguments, and the in-pod keepalive watcher, whose "is pi working?"
 * heuristics must mean the same thing on every provider. It imports no provider SDK, which
 * `npm run lint` enforces.
 */
import { PiPodError } from "../errors.js";
import { SHIM_PATH, TURN_MARKER_PATH } from "../shim/agentd.js";

/** POSIX single-quote quoting — the sandbox shell is bash (§12). */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** SDKs return Date for some timestamps and strings for others. */
export function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}

/**
 * Ceiling for one PTY-input message to the provider (§4.1). Provider transports relay PTY input
 * as discrete messages and may cap the size they accept. The PTY itself is a byte pipe with no
 * message boundaries, so splitting a large frame costs nothing beyond extra messages.
 */
export const PTY_INPUT_CHUNK_BYTES = 16 * 1024;

/** Split one write into transport-sized pieces; order is the caller's to preserve. */
export function chunkPtyInput(data: Uint8Array, chunkBytes = PTY_INPUT_CHUNK_BYTES): Uint8Array[] {
  if (data.length <= chunkBytes) return [data];
  const chunks: Uint8Array[] = [];
  for (let start = 0; start < data.length; start += chunkBytes) {
    chunks.push(data.subarray(start, Math.min(start + chunkBytes, data.length)));
  }
  return chunks;
}

export interface WatcherScriptOpts {
  sandboxId: string;
  /** The configured executable, used in addition to Linux comm="pi" for wrapper commands. */
  piCommand: string;
  /** Effective provider window; controls a cadence safely below the supported one-minute floor. */
  idleTimeoutMinutes: number;
  /**
   * Env var in the pod holding the provider's own credential (§7.3). The script reads it from
   * the environment rather than having it baked in: the script lands on the pod's disk, and
   * disk is where secrets are found.
   */
  credentialEnvName: string;
  /** Provider-specific constants plus `async function refresh()` (§8). */
  providerSource: string;
  /** Linux/manual-test seams; production callers leave these unset. */
  tickMs?: number;
  pidFile?: string;
  readyFile?: string;
  turnMarkerPath?: string;
  agentdPath?: string;
}

export interface WatcherActivitySignals {
  cpuActive: boolean;
  turnMarkerOpen: boolean;
  sessionWritePath: string | null;
}

/** Ordered so a noisy lower-priority signal cannot hide the stronger explanation in field logs. */
export function watcherActivitySignal(signals: WatcherActivitySignals): string | null {
  if (signals.cpuActive) return "cpu";
  if (signals.turnMarkerOpen) return "turn-marker";
  if (signals.sessionWritePath) return `session-write: ${signals.sessionWritePath}`;
  return null;
}

/** Only conversation JSONL is durable evidence of work; logs, caches and update state are churn. */
export function watcherSessionWritePath(relativeToPi: string): string | null {
  const normalized = relativeToPi.replace(/\\/g, "/");
  if (!/^agent\/sessions\/.+\.jsonl$/.test(normalized)) return null;
  return normalized.replace(/[\u0000-\u001f\u007f]/g, "?");
}

/**
 * The in-pod keepalive watcher (§8), generated per pod.
 *
 * A tick vouches only on evidence of work: CPU in the configured pi process tree, a conversation
 * JSONL write, or the shim's live work marker. Merely finding another resident Pi is not work:
 * detached processes can remain alive indefinitely, while actual subagent work is already part of
 * the summed CPU tree. The marker is tied to a live process so a crash cannot leave an immortal
 * lease behind. CommonJS on purpose: the upload path ends in .cjs.
 */
export function buildWatcherScript(opts: WatcherScriptOpts): string {
  const configuredTick =
    opts.tickMs ??
    Math.min(15_000, Math.max(5_000, Math.floor((opts.idleTimeoutMinutes > 0 ? opts.idleTimeoutMinutes : 1) * 15_000)));
  const cpuThreshold = Math.max(5, Math.ceil((25 * configuredTick) / 60_000));
  return `#!/usr/bin/env node
// pi-pod keepalive — generated; vouches for running pi work so the idle clock reflects it.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const SANDBOX = ${JSON.stringify(opts.sandboxId)};
const KEY = process.env[${JSON.stringify(opts.credentialEnvName)}];
const PI_COMMAND = ${JSON.stringify(opts.piCommand)};
const TICK_MS = ${configuredTick};
const CPU_JIFFY_THRESHOLD = ${cpuThreshold};
const WATCHER_VERSION = 3;
const PIDFILE = ${JSON.stringify(opts.pidFile ?? "/tmp/pi-pod-keepalive.pid")};
const READY_FILE = ${JSON.stringify(opts.readyFile ?? "/tmp/pi-pod-keepalive.ready")};
const TURN_MARKER = ${JSON.stringify(opts.turnMarkerPath ?? TURN_MARKER_PATH)};
const AGENTD_PATH = ${JSON.stringify(opts.agentdPath ?? SHIM_PATH)};
const SCRIPT_PATH = __filename;

if (!KEY) {
  console.error("no ${opts.credentialEnvName} in the pod environment — keepalive cannot vouch; exiting");
  process.exit(1);
}

function readProcess(pid) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const rest = stat.slice(close + 2).split(" ");
    const argv = fs.readFileSync("/proc/" + pid + "/cmdline").toString("utf8").split("\\0").filter(Boolean);
    return {
      comm,
      ppid: Number(rest[1]),
      jiffies: Number(rest[11]) + Number(rest[12]),
      startTime: String(rest[19]),
      argv,
    };
  } catch {
    return null;
  }
}

function watcherProcess(pid, expectedStartTime) {
  const found = readProcess(pid);
  if (!found || !found.argv.includes(SCRIPT_PATH)) return null;
  if (expectedStartTime && found.startTime !== String(expectedStartTime)) return null;
  return found;
}

function parseOwner(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Number.isInteger(parsed.pid) && parsed.pid > 0) return parsed;
  } catch {}
  const legacyPid = Number(raw.trim());
  return Number.isInteger(legacyPid) && legacyPid > 0 ? { pid: legacyPid, version: 1 } : null;
}

function ready(status) {
  fs.writeFileSync(READY_FILE, JSON.stringify({ version: WATCHER_VERSION, pid: process.pid, status }));
}

// Replace every verified watcher so attaches pick up rotated keys, pi.command, and policy.
// Never signal a merely reused/unrelated pid.
let claimed = false;
let ownerText = "";
for (let attempt = 0; attempt < 20 && !claimed; attempt += 1) {
  try {
    const startTime = readProcess(process.pid).startTime;
    ownerText = JSON.stringify({ pid: process.pid, startTime, scriptPath: SCRIPT_PATH, version: WATCHER_VERSION });
    fs.writeFileSync(PIDFILE, ownerText, { flag: "wx" });
    claimed = true;
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
    let raw = "";
    try { raw = fs.readFileSync(PIDFILE, "utf8"); } catch { continue; }
    const owner = parseOwner(raw);
    const live = owner ? watcherProcess(owner.pid, owner.startTime) : null;
    if (live) {
      try { process.kill(owner.pid, "SIGTERM"); } catch {}
      // Do not overlap provider refreshes while the verified owner handles SIGTERM.
      for (let wait = 0; wait < 80 && watcherProcess(owner.pid, owner.startTime); wait += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      if (watcherProcess(owner.pid, owner.startTime)) {
        throw new Error("verified previous keepalive did not stop");
      }
    }
    try {
      if (fs.readFileSync(PIDFILE, "utf8") === raw) fs.unlinkSync(PIDFILE);
    } catch {}
  }
}
if (!claimed) throw new Error("could not claim keepalive pid file");

function cleanup() {
  try {
    if (fs.readFileSync(PIDFILE, "utf8") === ownerText) fs.unlinkSync(PIDFILE);
  } catch {}
  try { fs.unlinkSync(READY_FILE); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

function processTable() {
  const table = new Map();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const found = readProcess(Number(entry));
    if (found) table.set(Number(entry), found);
  }
  return table;
}

function commandMatches(p) {
  if (p.comm === "pi") return true;
  const wanted = path.basename(PI_COMMAND);
  if (!wanted) return false;
  return p.argv.slice(0, 2).some((arg) => arg === PI_COMMAND || path.basename(arg) === wanted);
}

/** Total CPU of configured pi roots and everything underneath them. */
function piTree(table) {
  const children = new Map();
  for (const [pid, p] of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(pid);
  }
  const stack = [];
  for (const [pid, p] of table) {
    if (pid !== process.pid && !p.argv.includes(SCRIPT_PATH) && commandMatches(p)) stack.push(pid);
  }
  const seen = new Set(stack);
  let jiffies = 0;
  while (stack.length > 0) {
    const pid = stack.pop();
    const current = table.get(pid);
    if (!current) continue;
    jiffies += current.jiffies;
    for (const child of children.get(pid) ?? []) {
      if (!seen.has(child)) { seen.add(child); stack.push(child); }
    }
  }
  return { jiffies, running: seen.size > 0, pids: seen };
}

const sessionWritePath = ${watcherSessionWritePath.toString()};

/** Did pi persist conversation state since the previous scan? Bounded walk of session JSONL only. */
function recentSessionWrite(sinceMs) {
  const piRoot = (process.env["HOME"] || "/root") + "/.pi";
  const root = piRoot + "/agent/sessions";
  const dirs = [root];
  let visited = 0;
  while (dirs.length > 0 && visited < 5000) {
    const dir = dirs.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      const file = dir + "/" + entry.name;
      try {
        if (entry.isDirectory()) { dirs.push(file); continue; }
        const diagnostic = sessionWritePath(path.relative(piRoot, file));
        if (diagnostic && fs.statSync(file).mtimeMs >= sinceMs) return diagnostic;
      } catch {}
    }
  }
  return null;
}

/**
 * A marker counts only while live agentd or remote-TUI Pi owns the work. Co-located pods
 * write per-instance markers next to the shared one (\`<marker>.<podId>\`) and run shims
 * named \`<agentd>.<podId>.cjs\`, so the scan globs the marker basename and matches agentd
 * argv by prefix — and a dead marker pid never vouches, so a crashed child cannot pin the
 * host forever.
 */
const AGENTD_PREFIX = AGENTD_PATH.replace(/\\.cjs$/, "");
function markerFiles() {
  const dir = path.dirname(TURN_MARKER);
  const base = path.basename(TURN_MARKER);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n === base || n.startsWith(base + ".")).map((n) => dir + "/" + n);
}
function workOpen(table, tree) {
  const isAgentd = (p) =>
    p && p.argv.some((a) => a === AGENTD_PATH || (a.startsWith(AGENTD_PREFIX) && a.endsWith(".cjs")));
  for (const file of markerFiles()) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8").trim(); } catch { continue; }
    const markerPid = Number(raw);
    if (Number.isInteger(markerPid) && markerPid > 0) {
      if (isAgentd(table.get(markerPid)) || tree.pids.has(markerPid)) return true;
      continue;
    }
    // Compatibility with timestamp markers written by older agentd shims.
    for (const p of table.values()) if (isAgentd(p)) return true;
  }
  return false;
}


${opts.providerSource}

const activitySignal = ${watcherActivitySignal.toString()};

let lastJiffies = null;
let previousScanAt = Date.now() - TICK_MS;
async function tick() {
  const scanAt = Date.now();
  const table = processTable();
  const tree = piTree(table);
  const cpuActive = lastJiffies !== null && tree.jiffies - lastJiffies >= CPU_JIFFY_THRESHOLD;
  lastJiffies = tree.jiffies;
  const signal = activitySignal({
    cpuActive,
    turnMarkerOpen: workOpen(table, tree),
    sessionWritePath: recentSessionWrite(previousScanAt),
  });
  previousScanAt = scanAt;
  if (!signal) return;
  try {
    await refresh();
    console.log(new Date().toISOString() + " refreshed activity (" + signal + ")");
  } catch (e) {
    console.error(new Date().toISOString() + " refresh failed (" + signal + "): " + (e && e.message ? e.message : e));
  }
}

let timer = null;
async function loop() {
  await tick();
  timer = setTimeout(loop, TICK_MS);
}
process.on("exit", () => { if (timer) clearTimeout(timer); });
ready("watching");
console.log(new Date().toISOString() + " keepalive watching sandbox " + SANDBOX);
void loop();
`;
}

/**
 * Rejected loudly rather than ignored: silently falling back to the environment would leave
 * a real key sitting in a committed file while everything appeared to work.
 */
export function rejectConfigApiKey(
  raw: Record<string, unknown>,
  providerName: string,
  credentialEnv: string,
): void {
  if (raw["apiKey"] !== undefined) {
    throw new PiPodError(`providers.${providerName}.apiKey is not supported`, {
      hint:
        ".pi-pod/config.json is committed to the repo, so it must never hold a secret.\n" +
        "Export the key in your shell instead:\n\n" +
        `    export ${credentialEnv}=<key>\n\n` +
        "The shell value is what pi-pod injects into the pod for the keepalive; a\n" +
        "committed file must never hold it.",
    });
  }
}

/** Shared 404/message check used by adapters whose SDKs do not expose a typed not-found. */
export function httpNotFound(e: unknown): boolean {
  const message = describeError(e).toLowerCase();
  const status =
    (e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status;
  return status === 404 || message.includes("not found") || message.includes("404");
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
