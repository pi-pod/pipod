#!/usr/bin/env node
/**
 * M6 load test: density, freeze/thaw latency, and archive/restore budgets.
 *
 * Reports the numbers that decide how many sandboxes a host can carry and whether the
 * WARM tier is worth its complexity on that host. Run against a service on a machine you
 * do not mind saturating.
 *
 *   PPS_URL=http://localhost:8433 node scripts/loadtest.mjs [--count 8] [--payload-mb 50]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { requireOwnerKey, withLoadtestOwner } from "./loadtest/lib.mjs";

const BASE = process.env.PPS_URL ?? "http://localhost:8433";
const TOKEN = process.env.PI_POD_SANDBOX_TOKEN ?? "dev-token-0123456789abcdef";
let OWNER_KEY;
try {
  OWNER_KEY = requireOwnerKey(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const auth = { authorization: `Bearer ${TOKEN}` };

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const COUNT = arg("count", 8);
const PAYLOAD_MB = arg("payload-mb", 50);
const IMAGE = process.env.PPS_IMAGE ?? "busybox:latest";
const MEM_GB = arg("mem-gb", 0.25);
const CPU = arg("cpu", 0.1);

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

const ms = async (fn) => {
  const t = process.hrtime.bigint();
  const value = await fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, value };
};

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (xs) =>
  `min=${Math.min(...xs).toFixed(0)}ms p50=${pct(xs, 50).toFixed(0)}ms p95=${pct(xs, 95).toFixed(0)}ms max=${Math.max(...xs).toFixed(0)}ms`;

const hostMemUsedMB = () => {
  const info = fs.readFileSync("/proc/meminfo", "utf8");
  const kb = (k) => Number(/^\w+:\s+(\d+)/.exec(info.split("\n").find((l) => l.startsWith(k)))[1]);
  return (kb("MemTotal") - kb("MemAvailable")) / 1024;
};

const exec = (id, argv) =>
  new Promise((resolve, reject) => {
    import("ws").then(({ WebSocket }) => {
      const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/v1/sandboxes/${id}/exec`, { headers: auth });
      ws.on("open", () => ws.send(JSON.stringify({ type: "start", argv })));
      ws.on("message", (d, bin) => {
        if (bin) return;
        const f = JSON.parse(d.toString());
        if (f.type === "exit") resolve(f.exitCode);
        if (f.type === "error") reject(new Error(f.message));
      });
      ws.on("error", reject);
    });
  });

console.log(`host: ${os.cpus().length} vCPU, ${(os.totalmem() / 1024 ** 3).toFixed(1)}GB RAM`);
console.log(`plan: ${COUNT} sandboxes of ${IMAGE}, ${PAYLOAD_MB}MB payload, ${MEM_GB}GB/${CPU}cpu guarantees\n`);

const baselineMB = hostMemUsedMB();
const ids = [];
const createMs = [];

for (let i = 0; i < COUNT; i++) {
  try {
    const r = await ms(() =>
      api("POST", "/v1/sandboxes", withLoadtestOwner({
        image: IMAGE,
        workdir: "/workspace",
        resources: { cpu: CPU, memoryGB: MEM_GB },
        labels: { loadtest: "1" },
      }, OWNER_KEY)),
    );
    ids.push(r.value.id);
    createMs.push(r.ms);
  } catch (err) {
    console.log(`admission stopped at ${ids.length} sandboxes: ${String(err).split("\n")[0].slice(0, 120)}`);
    break;
  }
}
const afterCreateMB = hostMemUsedMB();
console.log(`created ${ids.length}: ${fmt(createMs)}`);
console.log(
  `host memory: +${(afterCreateMB - baselineMB).toFixed(0)}MB total, ${((afterCreateMB - baselineMB) / Math.max(1, ids.length)).toFixed(1)}MB per idle sandbox\n`,
);

// Make each sandbox hold real memory and real files, so freeze/reclaim and archive have
// something to work on rather than measuring an empty boat.
for (const id of ids) {
  await exec(id, ["/bin/sh", "-c", `dd if=/dev/zero of=/workspace/payload bs=1M count=${PAYLOAD_MB} 2>/dev/null`]);
}
const afterPayloadMB = hostMemUsedMB();
console.log(`after ${PAYLOAD_MB}MB written per sandbox: host memory +${(afterPayloadMB - baselineMB).toFixed(0)}MB\n`);

const execMs = [];
for (const id of ids) execMs.push((await ms(() => exec(id, ["/bin/true"]))).ms);
console.log(`exec round trip (hot): ${fmt(execMs)}`);

// The service freezes on its own timer, so the honest way to measure the warm path is to
// go quiet and let the reaper do it.
console.log(`\nwaiting for the warm-tier timer to freeze the fleet...`);
const warmDeadline = Date.now() + 90_000;
let warm = 0;
while (Date.now() < warmDeadline) {
  const list = await api("GET", "/v1/sandboxes?label.loadtest=1");
  warm = list.sandboxes.filter((s) => s.tier === "warm").length;
  if (warm === ids.length) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const afterFreezeMB = hostMemUsedMB();
console.log(`frozen ${warm}/${ids.length}; host memory now +${(afterFreezeMB - baselineMB).toFixed(0)}MB (reclaim needs swap to return much)`);

const thawMs = [];
for (const id of ids) thawMs.push((await ms(() => exec(id, ["/bin/true"]))).ms);
console.log(`thaw + exec (warm → hot): ${fmt(thawMs)}`);

console.log(`\narchiving ${ids.length} sandboxes (${PAYLOAD_MB}MB each)...`);
const archiveMs = [];
for (const id of ids) archiveMs.push((await ms(() => api("POST", `/v1/sandboxes/${id}/archive`, {}))).ms);
console.log(`archive: ${fmt(archiveMs)}`);

const restoreMs = [];
for (const id of ids) restoreMs.push((await ms(() => api("POST", `/v1/sandboxes/${id}/start`, {}))).ms);
console.log(`restore from archive: ${fmt(restoreMs)}`);

for (const id of ids) await api("DELETE", `/v1/sandboxes/${id}`);
console.log(`\ncleaned up ${ids.length} sandboxes`);
